# ADR-0004: Generative dashboards from natural language (AG-UI experiment)

- Status: experimental (September 2026), on branch `feat/generative-ui`
- Related: [ADR-0002](0002-natural-language-queries.md) (question to SQL), the dashboards feature in [docs/nl-query.md](../nl-query.md)

## Context

The query plane can already answer one question with one SQL statement (`POST /api/query/ask`), and a saved dashboard can run many statements against one snapshot (`POST /api/dashboards/{id}/run`).
What it cannot do is go from a question to a *view*: "what are the apps, namespaces and clusters under hub X, and how healthy are they" is three or four panels, each a table or a chart, laid out together, and today a person has to write each panel by hand.

The ask is a mechanism that turns a question written in English into a dashboard, tables and visualizations, built on the fly, and that lets the person refine it in the same conversation.
This is what the industry now calls generative UI, and AG-UI (the Agent-User Interaction protocol) is the open event protocol most front-end agent frameworks speak for it.

## Options considered

| Option | What it is | Why not, or why |
|---|---|---|
| A. One-shot plan | The model returns a whole dashboard definition as structured output; the API validates it, runs it, returns it | Cheapest. No feedback loop: a panel whose SQL fails stays broken, a refinement regenerates everything, and nothing renders until the whole plan is back (20-40 s on a six-panel plan). |
| B. AG-UI agent run (chosen) | A server-side tool-using loop builds the dashboard one validated panel at a time in shared state; every change streams to the browser as an AG-UI event and renders as it lands; follow-ups edit the same state | Progressive, self-correcting, refinable, protocol-standard. More moving parts: a stream, a loop, tool schemas, run limits. |
| C. CopilotKit end to end | CopilotKit React provider and runtime speaking AG-UI to our agent | Brings a large dependency and a second runtime for a chat widget we do not need; our value is the state protocol, not the chat surface. Kept open as a consumer of the same stream. |
| D. Vercel AI SDK generative UI | React Server Components streaming UI from the model | Needs Next.js and RSC; the dashboard is a Vite app. |
| E. MCP Apps / MCP-UI | Tools return UI resources that a chat host (Claude, ChatGPT) renders | Solves a different product: our data inside someone else's chat. Interesting for the MCP server later, not for the in-product dashboard. |

## Decision

Build option B, as an experiment on its own branch, with these rules.

1. **The shared state is a dashboard definition.**
   The agent's state is `{"dashboard": <the same definition shape /api/dashboards saves>, "params": {...}}`.
   Generative UI here means composing from the fixed vocabulary the dashboards feature already has (a panel is a query plus a chart choice plus a size on a 12-column grid; a variable is a named input), never free-form HTML or code from the model.
   The result is therefore saveable with the existing `PUT /api/dashboards/{id}`, reproducible, and reviewable as plain data.
2. **Every mutation is validated before it becomes state.**
   The model only changes the dashboard through tools (`set_dashboard`, `add_panel`, `update_panel`, `remove_panel`, `add_variable`, and a read-only `preview_sql`).
   A panel's SQL goes through the same guard as every other query and is dry-run against the snapshot; a failure is returned to the model as the tool result and the state does not change.
   This is the safety boundary: the model never reaches Redis, DuckDB or the file system, and the worst outcome of a bad answer is an empty panel.
3. **The wire protocol is AG-UI.**
   `POST /api/agent/run` takes an AG-UI `RunAgentInput` (thread id, run id, messages, state) and answers with a server-sent event stream of AG-UI events: `RUN_STARTED`, `STATE_SNAPSHOT`, `TEXT_MESSAGE_*` for the model's narration, `TOOL_CALL_*` for each tool invocation with its arguments streamed, `STATE_DELTA` (RFC 6902 JSON Patch) after each accepted mutation, `TOOL_CALL_RESULT`, `MESSAGES_SNAPSHOT` at the end so the client can continue the thread, and `RUN_FINISHED` or `RUN_ERROR`.
   The browser keeps the thread (messages plus state) and sends it back on every follow-up; the API holds no session, so it scales like every other endpoint and survives restarts.
   The events are emitted by a small module of our own (eleven event types, field names as the AG-UI specification writes them) rather than the `ag-ui-protocol` package, because that package pins `pydantic>=2.11` and the service pins 2.10; swapping it in later is a one-file change.
4. **The dashboard renders the state it already knows how to render.**
   A new Generate view holds the conversation on one side and the live dashboard on the other.
   Panels appear as their `STATE_DELTA` arrives and run through the existing batch runtime, so a generated dashboard and a saved one are the same components, the same charts, the same tables, the same variable bar.
   Without credentials, or on an API build without the endpoint, the view says so; it never breaks the rest of the application.
5. **Runs are bounded.**
   At most 12 model turns, at most the dashboard panel cap, a 150-second wall clock, the existing per-query timeout, and the stream stops when the browser disconnects.
   The model and effort are separate settings from the single-question path (`ODL_AGENT_MODEL`, `ODL_AGENT_EFFORT`), because a composing agent wants a faster model than a one-shot SQL writer may.

## Consequences

- A question becomes a dashboard in one conversation, and the person can say "make the second one a bar chart" or "add pending pods per namespace" without starting over.
- The same stream can drive any AG-UI client (CopilotKit, a chat host, a terminal), so the dashboard is not the only consumer.
- A generation costs one model turn per tool call plus one per narration, roughly 6-12 calls for a five-panel dashboard; the eval should record turns, tokens and wall clock per generation so the model choice can be made on numbers.
- The dashboards contract (definition shape, guard, batch runtime) becomes load-bearing for two features; any change to it must keep both working, which the shared tests enforce.
- Nothing in the existing product changes: the endpoint and the view are additive, and the branch is an experiment until the numbers say it should merge.

## Implementation

- Data layer: `data-layer/app/agent/` (config, events, state, tools, messages, prompt, model, run) and `data-layer/app/api/agent.py` (`GET /api/agent`, `POST /api/agent/run`); `scripts/eval_generate.py` for the numbers; 86 tests under `tests/test_agent_*.py` and `tests/test_llm_credentials.py`.
- Dashboard: `dashboard/src/agent/` (client, hook, fixture) and `dashboard/src/views/Generate.jsx` at `/generate`, with entry points from the Dashboards list and the Query page.
- The container's nginx streams `/api/agent/` unbuffered; settings are documented in `.env.example` and `docs/nl-query.md`.
- The rendered page of this record is `docs/adr/html/adr-0004.html`.

## How to judge the experiment

1. The five golden questions in `docs/nl-query.md` each produce a dashboard with the expected panels, with no panel in error, on the local fleet.
2. A follow-up edits the existing dashboard rather than rebuilding it (panel ids survive).
3. Median wall clock and cost per generation, per model (`claude-opus-5` against `claude-sonnet-5`), recorded in this document.
4. The generated dashboards save and re-run unchanged from the Dashboards tab.
