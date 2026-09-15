"""
The shared state, and the patch applier that keeps two copies of it equal.

The state is `{"dashboard": <a dashboard definition>, "params": {name: value}}`
and nothing else. That it is *exactly* the definition `/api/dashboards`
validates is the whole design: what the agent builds is saveable, re-runnable
and reviewable as plain data, and the front end renders it with the components
it already has.

The browser holds its own copy and updates it from the `STATE_DELTA` events, so
the two copies agree only if the server applies the very same operations to its
own copy - which is why there is an applier here rather than a "trust the
patch" assumption. It implements the three RFC 6902 operations the tools emit
(add, replace, remove), against the six paths they use, and refuses anything
else: a patch language wider than the tools need is surface nobody asked for.

`apply_ops` works on a deep copy, so a patch that fails half way leaves the
state exactly as it was. After every accepted mutation the caller re-validates
the dashboard with `parse_dashboard`, so what streams out of this API is always
a definition the dashboards API would accept.
"""
from __future__ import annotations

import copy
from collections.abc import Mapping, Sequence

from ..query.dashboards import Dashboard, DashboardInvalid, parse_dashboard

# What a run starts from when the client sends no state. `generated` is a valid
# dashboard id, so this document is savable the moment a panel lands in it.
EMPTY_DASHBOARD: dict = {
    "id": "generated",
    "title": "Untitled dashboard",
    "description": None,
    "builtin": False,
    "variables": [],
    "panels": [],
}

# Stamped by `save_dashboard` when a definition is stored, and meaningless for
# one being composed in memory - carrying them would put two nulls in every
# state snapshot and a stale timestamp in every refinement.
_STORED_ONLY_FIELDS = ("updated_at", "updated_by")

OPERATIONS = ("add", "replace", "remove")


class PatchError(Exception):
    """A patch operation could not be applied. The message names the path."""


# --------------------------------------------------------------------------- #
# normalising
# --------------------------------------------------------------------------- #
def definition(dashboard: Dashboard) -> dict:
    """A validated dashboard as the state carries it."""
    document = dashboard.as_dict()
    for field in _STORED_ONLY_FIELDS:
        document.pop(field, None)
    return document


def empty_state() -> dict:
    return {"dashboard": copy.deepcopy(EMPTY_DASHBOARD), "params": {}}


def normalise_state(raw: Mapping | None) -> dict:
    """Whatever the client sent as `state`, as the state this run works on.

    Null, empty or missing means "start a new dashboard". Anything else must
    be a definition the dashboards API would accept, because every later
    mutation is validated against it - a run that started from a broken
    document could never produce a good one. Unknown top-level keys are
    dropped rather than carried: the state is a contract, not a bag.

    Raises `DashboardInvalid`, which the endpoint turns into a 422.
    """
    if not isinstance(raw, Mapping):
        return empty_state()
    document = raw.get("dashboard")
    if not isinstance(document, Mapping) or not document:
        document = EMPTY_DASHBOARD
    else:
        # A draft the page holds before anything was generated has no title
        # yet, and a person may clear the title field mid-conversation. Neither
        # is a broken document: it is the empty dashboard's title until the
        # model or the person sets one.
        document = dict(document)
        if not str(document.get("title") or "").strip():
            document["title"] = EMPTY_DASHBOARD["title"]
        if not str(document.get("id") or "").strip():
            document["id"] = EMPTY_DASHBOARD["id"]
    dashboard = parse_dashboard(document)
    params = raw.get("params")
    values = {str(k): v for k, v in params.items()} if isinstance(params, Mapping) else {}
    return {"dashboard": definition(dashboard), "params": values}


def revalidate(state: Mapping) -> Dashboard:
    """The state's dashboard, parsed. Raises `DashboardInvalid` when it is not one."""
    return parse_dashboard(state.get("dashboard"))


def is_valid(state: Mapping) -> bool:
    try:
        revalidate(state)
    except DashboardInvalid:
        return False
    return True


# --------------------------------------------------------------------------- #
# RFC 6902, the three operations we use
# --------------------------------------------------------------------------- #
def _tokens(path: str) -> list[str]:
    """A JSON Pointer as its unescaped tokens ('~1' is '/', '~0' is '~')."""
    if not isinstance(path, str) or (path and not path.startswith("/")):
        raise PatchError(f"{path!r} is not a JSON Pointer")
    if not path:
        raise PatchError("the whole document may not be replaced")
    return [token.replace("~1", "/").replace("~0", "~") for token in path.split("/")[1:]]


def _index(node: list, token: str, path: str, *, bound: int) -> int:
    """An array index token, as an int inside the array."""
    if not token.lstrip("-").isdigit() or token.startswith("-"):
        raise PatchError(f"{path}: '{token}' is not an array index")
    position = int(token)
    if position > bound:
        raise PatchError(f"{path}: index {position} is past the end of a "
                         f"{bound if bound else 0}-element array")
    return position


def _parent(document, tokens: list[str], path: str):
    """The container the last token addresses, walking the pointer."""
    node = document
    for token in tokens[:-1]:
        if isinstance(node, list):
            node = node[_index(node, token, path, bound=len(node) - 1)]
        elif isinstance(node, Mapping):
            if token not in node:
                raise PatchError(f"{path}: '{token}' does not exist")
            node = node[token]
        else:
            raise PatchError(f"{path}: '{token}' does not address a container")
    return node


def apply_op(document: dict, op: Mapping) -> dict:
    """One operation, applied in place. `document` is ours to mutate."""
    operation = op.get("op")
    if operation not in OPERATIONS:
        raise PatchError(f"unsupported operation {operation!r}; one of {', '.join(OPERATIONS)}")
    path = op.get("path")
    tokens = _tokens(path)
    parent = _parent(document, tokens, path)
    token = tokens[-1]
    has_value = "value" in op
    if operation != "remove" and not has_value:
        raise PatchError(f"{path}: {operation} needs a value")
    value = op.get("value")

    if isinstance(parent, list):
        if operation == "add":
            position = len(parent) if token == "-" else _index(parent, token, path,
                                                               bound=len(parent))
            parent.insert(position, value)
        elif operation == "replace":
            parent[_index(parent, token, path, bound=len(parent) - 1)] = value
        else:
            del parent[_index(parent, token, path, bound=len(parent) - 1)]
    elif isinstance(parent, dict):
        if operation == "remove":
            if token not in parent:
                raise PatchError(f"{path}: '{token}' does not exist")
            del parent[token]
        elif operation == "replace" and token not in parent:
            raise PatchError(f"{path}: '{token}' does not exist; use add")
        else:
            parent[token] = value
    else:
        raise PatchError(f"{path}: the parent is not an object or an array")
    return document


def apply_ops(document: Mapping, ops: Sequence[Mapping]) -> dict:
    """A patch, applied to a copy. All of it lands, or none of it does."""
    patched = copy.deepcopy(dict(document))
    for op in ops:
        apply_op(patched, op)
    return patched
