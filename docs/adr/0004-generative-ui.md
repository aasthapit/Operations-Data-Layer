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
- The model behind both the agent and the query plane is chosen by `ODL_LLM_PROVIDER` in `data-layer/app/llm/` (`config`, `provider`, `anthropic`, `ollama`), so the loop, the tools, the events and the endpoints are provider-agnostic; `tests/test_llm_ollama.py` proves the translation without a daemon.
- Dashboard: `dashboard/src/agent/` (client, hook, fixture) and `dashboard/src/views/Generate.jsx` at `/generate`, with entry points from the Dashboards list and the Query page.
- The container's nginx streams `/api/agent/` unbuffered; settings are documented in `.env.example` and `docs/nl-query.md`.
- The rendered page of this record is `docs/adr/html/adr-0004.html`.

## How to judge the experiment

1. The five golden questions in `docs/nl-query.md` each produce a dashboard with the expected panels, with no panel in error, on the local fleet.
2. A follow-up edits the existing dashboard rather than rebuilding it (panel ids survive).
3. Median wall clock and cost per generation, per model (`claude-opus-5` against `claude-sonnet-5`), recorded in this document.
4. The generated dashboards save and re-run unchanged from the Dashboards tab.

### Measured: local models (Ollama)

The Anthropic rows are still pending (this machine has no key), but the second provider can be measured today, and it answers the question the experiment was really about: how much of this depends on a frontier model?
`scripts/eval_generate.py` ran the same six questions (the first five golden ones plus "apps, namespaces and clusters under hub hub-east") against the 5-cluster kind fleet on an M1 Max with 64 GB, once per model, with `ODL_LLM_PROVIDER=ollama` and the run limits unchanged (12 turns, 12 panels, 600 s).

| Model (Ollama, M1 Max 64 GB) | Turns | Tool calls | Panels | Panels in error | Wall clock per question | Tokens in / out |
|---|---|---|---|---|---|---|
| `gpt-oss:20b` | 27 (median 3) | 21 | 10 | 0 | 11-109 s (median 25 s) | 297k / 9.4k |
| `qwen3:4b` | 14 (median 2) | 12 | 7 | 0 | 71-196 s (median 137 s) | 162k / 33.6k |
| `llama3.2:3b` | 26 (one run hit the 12-turn cap) | 22+ | 2 | 0 | 7-81 s (median 10 s) | 151k / 1.9k |

Read the panel column, not the error column.
No model produced a panel that failed to re-run, because nothing reaches the state without passing the guard and a dry run: the safety property holds on a 3B model as well as on a hosted one.
What the local models lose is composition.
`gpt-oss:20b` builds real dashboards but small ones (one to two panels where the prompt asks for three to six, five on the hub question), narrates the answer as a markdown table instead of leaving it to the panels, and invented a tool name once (`add_dashboard`) before correcting itself from the tool error.
`qwen3:4b` writes correct SQL and is three to eight times slower, and spends its output budget on thinking: on the first question it hit the 4096-token output cap inside its own reasoning and finished the turn with no tool call and nothing to show.
`llama3.2:3b` is not usable for this: it answers in prose and calls `preview_sql` instead of `add_panel`, gets argument names wrong (`panel_id` for `id`), and left four of six dashboards empty and one against the turn limit.
Nothing was raised to make these numbers better; a `qwen3:4b` worth rerunning would need `ODL_AGENT_MAX_TOKENS` above 4096 so its thinking does not consume the turn.

On the single-question path the picture is better.
`scripts/eval_ask.py` on the first five golden questions scores 0/5 for every model, but that number is unusable here: each `expect` block describes the two-cluster unit fixture (`ocp-west-1`, `nginx:1.19`, `api-tls`) and the kind fleet has neither those clusters nor that image, so no model can satisfy them on this data.
The usable column is coverage, which compares the generated rows with the reference SQL's rows on the same snapshot: `gpt-oss:20b` (6-19 s) and `qwen3:4b` (24-80 s) each came back `exact` on three of five and `differs` on two only by leaving a column out of the SELECT, while `llama3.2:3b` (2-14 s) failed the blast-radius question outright, writing SQL that would not bind on either attempt.
The eval script needs a fleet-independent `expect`, or a data layer serving the fixture, before its pass/fail means anything against a live fleet.
