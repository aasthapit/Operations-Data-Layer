#!/usr/bin/env python
"""
Eval harness for the natural-language query feature.

Every golden question in tests/golden_questions.yaml is sent to a live
/api/query/ask, and the answer is compared with the reference SQL run through
/api/query/sql on the same snapshot. Two signals come back:

  * expectations - the `expect` block of the golden entry, evaluated against
    the rows the model's query returned. This is pass or fail.
  * coverage     - whether the reference rows' values are all present in the
    generated answer. Extra columns are fine (they usually help); missing
    facts are not. This is the "did it actually answer" signal.

Run it after changing the prompt, the schema descriptions or the model:

    data-layer/.venv/bin/python scripts/eval_ask.py --base-url http://localhost:18000

It needs a running data layer with data in it, and credentials for the model
(ANTHROPIC_API_KEY, or an `ant auth login` profile - the data layer's own, not
this script's). Exit status is 1 if any question fails, so it can gate a change.
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
GOLDEN = os.path.join(os.path.dirname(HERE), "tests", "golden_questions.yaml")


# --------------------------------------------------------------------------- #
# http
# --------------------------------------------------------------------------- #
class ApiError(Exception):
    def __init__(self, status: int, detail):
        super().__init__(f"HTTP {status}: {detail}")
        self.status = status
        self.detail = detail


def post_json(base_url: str, path: str, body: dict, timeout: float) -> dict:
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}{path}", method="POST",
        data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            return json.loads(response.read())
    except urllib.error.HTTPError as e:
        payload = e.read().decode("utf-8", "replace")
        try:
            payload = json.loads(payload).get("detail", payload)
        except ValueError:
            pass
        raise ApiError(e.code, payload) from None
    except urllib.error.URLError as e:
        raise ApiError(0, f"cannot reach {base_url}: {e.reason}") from None


# --------------------------------------------------------------------------- #
# comparison
# --------------------------------------------------------------------------- #
def _cells(row) -> set[str]:
    return {json.dumps(v, default=str, sort_keys=True) for v in row}


def coverage(reference_rows: list[list], answer_rows: list[list]) -> str:
    """How much of the reference answer the generated answer contains."""
    if not reference_rows and not answer_rows:
        return "exact"
    answers = [_cells(r) for r in answer_rows]
    covered = all(any(cells <= candidate for candidate in answers)
                  for cells in (_cells(r) for r in reference_rows))
    if not covered:
        return "differs"
    if len(answer_rows) == len(reference_rows):
        return "exact"
    return "extra rows" if len(answer_rows) > len(reference_rows) else "missing rows"


def _matches(row: dict, wanted: dict) -> bool:
    for column, value in wanted.items():
        actual = row.get(column)
        if isinstance(value, float) or isinstance(actual, float):
            try:
                if actual is None or abs(float(actual) - float(value)) > 1e-6:
                    return False
            except (TypeError, ValueError):
                return False
        elif actual != value:
            return False
    return True


def check_expectations(expect: dict, columns: list[str], rows: list[list]) -> list[str]:
    """The golden entry's expectations, judged on the generated answer.

    Column names are matched loosely: the model may call a column `ns` where
    the reference calls it `namespace`, so a wanted column is looked up by
    suffix as well as by exact name.
    """
    dict_rows = [dict(zip(columns, row, strict=False)) for row in rows]
    problems = []
    if "row_count" in expect and len(rows) != expect["row_count"]:
        problems.append(f"expected {expect['row_count']} rows, got {len(rows)}")
    if "min_rows" in expect and len(rows) < expect["min_rows"]:
        problems.append(f"expected at least {expect['min_rows']} rows, got {len(rows)}")
    wanted = expect.get("contains")
    for want in ([] if wanted is None else (wanted if isinstance(wanted, list) else [wanted])):
        resolved = [{_resolve(column, columns): value for column, value in want.items()}]
        if not any(_matches(row, resolved[0]) for row in dict_rows):
            problems.append(f"no row matches {want}")
    return problems


def _resolve(column: str, columns: list[str]) -> str:
    if column in columns:
        return column
    candidates = [c for c in columns if c.endswith(f"_{column}") or c == column.split("_")[-1]]
    return candidates[0] if len(candidates) == 1 else column


# --------------------------------------------------------------------------- #
# credentials
# --------------------------------------------------------------------------- #
def credential_hint() -> str:
    """What the data layer will use to reach the model, as far as we can tell."""
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "ANTHROPIC_API_KEY is set in this shell"
    if os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return "ANTHROPIC_AUTH_TOKEN is set in this shell"
    import shutil
    import subprocess
    if shutil.which("ant"):
        try:
            out = subprocess.run(["ant", "auth", "status"], capture_output=True,
                                 text=True, timeout=20)
            if out.returncode == 0:
                return "`ant auth status`: " + (out.stdout.strip().splitlines() or [""])[0]
        except (OSError, subprocess.SubprocessError):
            pass
    return ("no Anthropic credentials found in this shell; the data layer needs "
            "ANTHROPIC_API_KEY or an `ant auth login` profile of its own")


# --------------------------------------------------------------------------- #
# the run
# --------------------------------------------------------------------------- #
def run(base_url: str, entries: list[dict], timeout: float, limit: int) -> int:
    results = []
    for entry in entries:
        started = time.time()
        row = {"id": entry["id"], "status": "pass", "notes": [], "sql": None,
               "attempts": None, "confidence": None, "coverage": "-"}
        try:
            reference = post_json(base_url, "/api/query/sql",
                                  {"sql": entry["sql"], "limit": limit}, timeout)
        except ApiError as e:
            row.update(status="ERROR", notes=[f"reference SQL failed: {e}"])
            results.append(row)
            continue
        try:
            answer = post_json(base_url, "/api/query/ask",
                               {"question": entry["question"], "limit": limit}, timeout)
        except ApiError as e:
            row.update(status="FAIL", notes=[f"ask failed: {e}"])
            results.append(row)
            continue

        result = answer.get("result") or {}
        row["sql"] = answer.get("sql")
        row["attempts"] = answer.get("attempts")
        row["confidence"] = answer.get("confidence")
        row["coverage"] = coverage(reference.get("rows", []), result.get("rows", []))
        problems = check_expectations(entry.get("expect") or {},
                                      result.get("columns", []), result.get("rows", []))
        if row["coverage"] == "differs":
            problems.append("the reference rows are not in the answer")
        if problems:
            row.update(status="FAIL", notes=problems)
        row["seconds"] = round(time.time() - started, 1)
        results.append(row)

    _report(results)
    return 0 if all(r["status"] == "pass" for r in results) else 1


def _report(results: list[dict]) -> None:
    width = max(len(r["id"]) for r in results) if results else 10
    print()
    print(f"{'question':<{width}}  {'status':<6} {'try':<4} {'conf':<5} {'rows':<12} time")
    print("-" * (width + 40))
    for r in results:
        conf = f"{r['confidence']:.2f}" if isinstance(r["confidence"], int | float) else "-"
        print(f"{r['id']:<{width}}  {r['status']:<6} {str(r['attempts'] or '-'):<4} "
              f"{conf:<5} {r['coverage']:<12} {r.get('seconds', '-')}s")
    passed = sum(1 for r in results if r["status"] == "pass")
    print("-" * (width + 40))
    print(f"score: {passed}/{len(results)}")
    for r in results:
        if r["status"] == "pass":
            continue
        print(f"\n--- {r['id']}: {'; '.join(r['notes'])}")
        if r["sql"]:
            print(r["sql"])


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--base-url", default=os.environ.get("ODL_API", "http://localhost:18000"),
                        help="data layer base URL (default: %(default)s)")
    parser.add_argument("--golden", default=GOLDEN, help="golden questions file")
    parser.add_argument("--id", action="append", dest="ids",
                        help="only run these question ids (repeatable)")
    parser.add_argument("--limit", type=int, default=200, help="row cap per query")
    parser.add_argument("--timeout", type=float, default=180.0,
                        help="seconds to wait for one answer")
    args = parser.parse_args(argv)

    with open(args.golden) as f:
        entries = yaml.safe_load(f)
    if args.ids:
        entries = [e for e in entries if e["id"] in set(args.ids)]
    if not entries:
        print("no questions selected", file=sys.stderr)
        return 2

    print(f"data layer: {args.base_url}")
    print(f"credentials: {credential_hint()}")
    print(f"questions:  {len(entries)}")
    return run(args.base_url, entries, args.timeout, args.limit)


if __name__ == "__main__":
    raise SystemExit(main())
