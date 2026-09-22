"""
Request-supplied values, as something safe to put in a log line.

A cluster name from a URL path, a dashboard id from a request body or a
question typed into the Query page all end up in log lines, and a value that
carries a newline can forge a second line that reads like a different event.
Rendering it through here makes every such value one line, and marks in the
code which values came from outside.
"""
from __future__ import annotations

_CONTROL = {ord(ch): " " for ch in "\r\n\x1b\x00"}


def logsafe(value, limit: int = 200) -> str:
    """`value` as one line of at most `limit` characters."""
    return str(value).translate(_CONTROL)[:limit]
