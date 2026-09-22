#!/usr/bin/env python
"""
Write the API's OpenAPI document to `data-layer/openapi.json`.

    data-layer/.venv/bin/python scripts/export_openapi.py

The document is the one source for the dashboard's request types: `npm run
api:types` in `dashboard/` runs `openapi-typescript` over this file, so a path,
a query parameter or a request body that changes in a FastAPI handler becomes a
type error in the UI rather than a 422 somebody finds in a browser (ADR-0005).

The file is committed, and `tests/test_openapi_export.py` asserts it still
matches `app.openapi()`, so a route added without re-running this script fails
the data layer's own suite instead of drifting silently.

Nothing is started: importing `app.main` builds the FastAPI object but does not
run its lifespan, so no Redis, no manifest load and no collector are needed -
the same way `tests/test_main.py` reaches the app.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
# The manifest is only read inside the lifespan, but point at the committed one
# anyway so an environment that has ODL_MANIFEST set elsewhere cannot change
# what this script writes.
os.environ.setdefault("ODL_MANIFEST", os.path.join(ROOT, "config", "ocp-api-manifest.yaml"))

DEFAULT_OUTPUT = os.path.join(ROOT, "openapi.json")


def document() -> dict:
    """The served OpenAPI document, without starting anything."""
    from app.main import app  # noqa: PLC0415 - imported here, after sys.path is set
    return app.openapi()


def render(doc: dict) -> str:
    """The document as it is committed: sorted keys and a trailing newline, so
    an unrelated dict ordering change in FastAPI cannot show up as a diff."""
    return json.dumps(doc, indent=2, sort_keys=True) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("-o", "--output", default=DEFAULT_OUTPUT,
                    help=f"where to write the document (default: {DEFAULT_OUTPUT})")
    ap.add_argument("--check", action="store_true",
                    help="exit 1 if the file on disk is not what would be written")
    args = ap.parse_args()

    text = render(document())
    if args.check:
        current = open(args.output, encoding="utf-8").read() if os.path.exists(args.output) else ""
        if current == text:
            return 0
        print(f"{args.output} is out of date: re-run {os.path.relpath(__file__, ROOT)}",
              file=sys.stderr)
        return 1

    with open(args.output, "w", encoding="utf-8") as fh:
        fh.write(text)
    print(f"wrote {args.output} ({len(text)} bytes, {len(document()['paths'])} paths)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
