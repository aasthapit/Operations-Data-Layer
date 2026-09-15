#!/usr/bin/env python
"""
Eval harness for generated dashboards.

`scripts/eval_ask.py` answers "does the model still write SQL that answers this
question?". This one answers the question a *dashboard* raises: how much does a
generation cost, and is what came out actually runnable?

For each question it opens `POST /api/agent/run`, consumes the AG-UI event
stream to the end, rebuilds the dashboard the way the browser does (the
STATE_SNAPSHOT plus every STATE_DELTA, through the server's own patch applier),
and then re-runs every panel of that definition through `POST /api/query/batch`.
A panel that errors on the second run is a panel the user would have seen
empty, which is the only pass/fail signal here - everything else (turns, tool
calls, wall clock, tokens) is a number to compare models and prompts with.

    data-layer/.venv/bin/python scripts/eval_generate.py --api http://localhost:18003

The model is the data layer's own setting (`ODL_AGENT_MODEL`): there is no way
to override it per request, and there should not be - the run limits and the
model are deployment facts, not client input. The model in use is printed from
`GET /api/agent` so a result table always says what produced it.

Exit status is 1 if any panel errors or any run fails, so it can gate a change.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GOLDEN = os.path.join(ROOT, "tests", "golden_questions.yaml")
sys.path.insert(0, ROOT)

from app.agent.state import apply_ops  # noqa: E402 - after sys.path

# The questions that are dashboards rather than single answers. The first five
# golden questions are the shared regression set (so a prompt change shows up
# in both evals), and the last one is the shape this feature exists for: a
# question about one hub that is three or four panels and a variable.
GOLDEN_SAMPLE = 5
HUB_QUESTION = "apps, namespaces and clusters under hub {hub}"
HUBS_SQL = ("SELECT DISTINCT hub_name AS hub FROM clusters "
            "WHERE hub_name IS NOT NULL ORDER BY 1")


class ApiError(Exception):
    def __init__(self, status: int, detail):
        super().__init__(f"HTTP {status}: {detail}")
        self.status = status
        self.detail = detail


def _request(api: str, path: str, body: dict | None, timeout: float, stream: bool = False):
    request = urllib.request.Request(
        f"{api.rstrip('/')}{path}",
        method="POST" if body is not None else "GET",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json",
                 "accept": "text/event-stream" if stream else "application/json"})
    try:
        return urllib.request.urlopen(request, timeout=timeout)  # noqa: S310
    except urllib.error.HTTPError as e:
        payload = e.read().decode("utf-8", "replace")
        try:
            payload = json.loads(payload).get("detail", payload)
        except ValueError:
            pass
        raise ApiError(e.code, payload) from None
    except urllib.error.URLError as e:
        raise ApiError(0, f"cannot reach {api}: {e.reason}") from None


def call(api: str, path: str, body: dict | None = None, timeout: float = 60.0) -> dict:
    with _request(api, path, body, timeout) as response:
        return json.loads(response.read())


def events(api: str, body: dict, timeout: float):
    """Every AG-UI event of one run, as it arrives."""
    with _request(api, "/api/agent/run", body, timeout, stream=True) as response:
        for raw in response:
            line = raw.decode("utf-8", "replace").strip()
            if line.startswith("data:"):
                yield json.loads(line[len("data:"):].strip())


# --------------------------------------------------------------------------- #
# one run
# --------------------------------------------------------------------------- #
def generate(api: str, question: str, timeout: float) -> dict:
    """Run one question to the end and rebuild what the browser would hold."""
    body = {"threadId": f"eval-{int(time.time())}", "runId": "r-1", "state": None,
            "messages": [{"id": "m1", "role": "user", "content": question}],
            "tools": [], "context": [], "forwardedProps": {}}
    started = time.time()
    state: dict = {"dashboard": {}, "params": {}}
    outcome: dict = {"question": question, "state": state, "error": None, "result": {}}
    for event in events(api, body, timeout):
        kind = event.get("type")
        if kind == "STATE_SNAPSHOT":
            state = event["snapshot"]
        elif kind == "STATE_DELTA":
            state = apply_ops(state, event["delta"])
        elif kind == "RUN_ERROR":
            outcome["error"] = f"{event.get('code')}: {event.get('message')}"
        elif kind == "RUN_FINISHED":
            outcome["result"] = event.get("result") or {}
    outcome["state"] = state
    outcome["result"].setdefault("elapsed_ms", int((time.time() - started) * 1000))
    return outcome


def effective_params(state: dict) -> dict:
    """What the panels would run with: the params, then the variables' defaults."""
    values = dict(state.get("params") or {})
    for variable in state.get("dashboard", {}).get("variables") or []:
        if values.get(variable["name"]) is None and variable.get("default") is not None:
            values[variable["name"]] = variable["default"]
    return values


def rerun(api: str, state: dict, timeout: float) -> dict:
    """Every panel of the finished definition, through the ordinary batch endpoint.

    This is the check that matters: the agent said the SQL ran when it added
    the panel, and this proves the definition it left behind still runs, as
    data, through the path the dashboards page uses.
    """
    panels = state.get("dashboard", {}).get("panels") or []
    if not panels:
        return {}
    queries = [{"id": p["id"], "sql": p["sql"], **({"limit": p["limit"]} if p.get("limit") else {})}
               for p in panels]
    try:
        answer = call(api, "/api/query/batch",
                      {"queries": queries, "params": effective_params(state)}, timeout)
    except ApiError as e:
        return {p["id"]: {"error": str(e)} for p in panels}
    return answer.get("results") or {}


# --------------------------------------------------------------------------- #
# the run
# --------------------------------------------------------------------------- #
def questions(api: str, extra: list[str] | None, timeout: float) -> list[str]:
    with open(GOLDEN) as handle:
        golden = yaml.safe_load(handle)
    chosen = [entry["question"].strip() for entry in golden[:GOLDEN_SAMPLE]]
    try:
        rows = call(api, "/api/query/sql", {"sql": HUBS_SQL, "limit": 1}, timeout)["rows"]
        if rows:
            chosen.append(HUB_QUESTION.format(hub=rows[0][0]))
    except (ApiError, KeyError, IndexError) as e:
        print(f"note: no hub question ({e})", file=sys.stderr)
    return chosen + list(extra or [])


def run(api: str, asked: list[str], timeout: float) -> int:
    rows = []
    for question in asked:
        print(f"... {question[:70]}", file=sys.stderr)
        try:
            outcome = generate(api, question, timeout)
        except ApiError as e:
            rows.append({"question": question, "error": str(e), "panels": 0, "failed": 0})
            continue
        results = rerun(api, outcome["state"], timeout)
        failed = [panel_id for panel_id, result in results.items()
                  if not result or "error" in result]
        result = outcome["result"]
        usage = result.get("usage") or {}
        rows.append({
            "question": question,
            "error": outcome["error"],
            "turns": result.get("turns"),
            "tools": result.get("tool_calls"),
            "panels": len(outcome["state"].get("dashboard", {}).get("panels") or []),
            "failed": len(failed),
            "failed_ids": failed,
            "ms": result.get("elapsed_ms"),
            "input": usage.get("input_tokens"),
            "output": usage.get("output_tokens"),
            "cache": usage.get("cache_read_input_tokens"),
            "results": results,
        })
    _report(rows)
    return 0 if all(not r.get("error") and not r.get("failed") for r in rows) else 1


def _cell(value) -> str:
    return "-" if value is None else str(value)


def _report(rows: list[dict]) -> None:
    width = min(max((len(r["question"]) for r in rows), default=10), 52)
    header = (f"{'question':<{width}}  {'turns':>5} {'tools':>5} {'panels':>6} {'error':>6} "
              f"{'ms':>7} {'in':>7} {'out':>6} {'cached':>7}")
    print()
    print(header)
    print("-" * len(header))
    for row in rows:
        question = row["question"][:width]
        print(f"{question:<{width}}  {_cell(row.get('turns')):>5} {_cell(row.get('tools')):>5} "
              f"{_cell(row.get('panels')):>6} {_cell(row.get('failed')):>6} "
              f"{_cell(row.get('ms')):>7} {_cell(row.get('input')):>7} "
              f"{_cell(row.get('output')):>6} {_cell(row.get('cache')):>7}")
    print("-" * len(header))
    clean = sum(1 for r in rows if not r.get("error") and not r.get("failed"))
    total_ms = sum(r.get("ms") or 0 for r in rows)
    print(f"{clean}/{len(rows)} dashboards with every panel running, "
          f"{sum(r.get('panels') or 0 for r in rows)} panels, "
          f"{total_ms / max(len(rows), 1):.0f} ms per dashboard on average")
    for row in rows:
        if row.get("error"):
            print(f"\n--- {row['question']}: {row['error']}")
        for panel_id in row.get("failed_ids") or []:
            result = (row.get("results") or {}).get(panel_id) or {}
            print(f"\n--- {row['question']} / panel {panel_id}: "
                  f"{result.get('error', 'no result')}")
            if result.get("sql"):
                print(result["sql"])


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--api", default=os.environ.get("ODL_API", "http://localhost:18000"),
                        help="data layer base URL (default: %(default)s)")
    parser.add_argument("--question", action="append", dest="extra",
                        help="an extra question to generate a dashboard for (repeatable)")
    parser.add_argument("--only", action="append", dest="only",
                        help="run only questions containing this text (repeatable)")
    parser.add_argument("--timeout", type=float, default=300.0,
                        help="seconds to wait for one run")
    args = parser.parse_args(argv)

    try:
        capability = call(args.api, "/api/agent", None, 30.0)
    except ApiError as e:
        print(f"cannot read {args.api}/api/agent: {e}", file=sys.stderr)
        return 2
    print(f"data layer: {args.api}")
    print(f"model:      {capability.get('model')} "
          f"(limits: {json.dumps(capability.get('limits') or {})})")
    if not capability.get("available"):
        print(f"unavailable: {capability.get('reason')}", file=sys.stderr)
        return 2

    asked = questions(args.api, args.extra, args.timeout)
    if args.only:
        asked = [q for q in asked if any(needle.lower() in q.lower() for needle in args.only)]
    if not asked:
        print("no questions selected", file=sys.stderr)
        return 2
    print(f"questions:  {len(asked)}")
    return run(args.api, asked, args.timeout)


if __name__ == "__main__":
    raise SystemExit(main())
