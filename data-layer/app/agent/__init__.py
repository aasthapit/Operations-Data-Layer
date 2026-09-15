"""
The dashboard-building agent: a question in, a dashboard definition out.

The query plane answers one question with one SELECT. This package answers a
question with a *view*: a tool-using loop that composes a dashboard definition
- the same document `/api/dashboards` stores and the front end renders - one
validated panel at a time, and streams every step to the browser as AG-UI
events so the page fills in as the answer is built.

The pieces, each testable on its own:

  * `config.py`   - the run limits (turns, panels, wall clock, model).
  * `events.py`   - the AG-UI wire events, as small typed builders.
  * `state.py`    - the shared state (`{dashboard, params}`) and the RFC 6902
                    patch applier that keeps our copy and the browser's equal.
  * `tools.py`    - what the model may do: preview SQL, and five mutations
                    that are validated before they ever become state.
  * `messages.py` - AG-UI messages <-> Anthropic messages, both ways, so a
                    thread survives a round trip through the browser.
  * `prompt.py`   - the cached system prompt and the volatile live values.
  * `model.py`    - the model adapter behind an injectable seam.
  * `run.py`      - the loop that ties them together.

The safety story is the same as the query plane's: the model never reaches
Redis, DuckDB or the file system. It emits tool calls; every SQL string it
writes goes through `app.query.guard` and is dry-run before the panel holding
it is allowed into the state, so the worst outcome of a bad answer is a panel
that is not there.
"""
