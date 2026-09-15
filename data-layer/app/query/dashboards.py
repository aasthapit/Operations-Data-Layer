"""
Dashboards: several guarded queries about one moment, defined as data.

A dashboard is a JSON document - variables and panels - and nothing else. No
panel type registry, no server-side rendering, no chart library on this side of
the wire: a panel is a title, a SQL query, a size on a 12-column grid and an
opaque `chart` object the front end interprets. The backend's whole job is to
decide what a panel is allowed to be, resolve the variables, and run every
panel of one dashboard against one snapshot build.

Why definitions live on the server: a dashboard that lives in a browser's local
storage is one person's dashboard. The point of "the clusters of this hub, the
apps on them, what changed today" is that the next person on the rota opens the
same thing, so definitions are stored in Redis (`store.dashboard_*`) and the
four here are shipped as YAML in `config/dashboards/`.

Two rules are worth stating because they shape the format:

  * **Every `{{name}}` must be a declared variable.** A panel that references
    an undeclared variable can never run, so it is refused when the dashboard
    is saved, with the field path of the panel that did it.
  * **Variable option queries take no variables.** Options and panels are
    resolved in one batch against one snapshot, so an option list cannot depend
    on another variable's value; a chained selector would need a second round
    trip and a second snapshot. Refusing it is honest, and the alternative
    (silently resolving nothing) is not.

An unset variable is not an error. The UI has to draw the selector before the
user can pick a hub, so `run()` returns the options for every variable and
reports the panels that need the missing value as errors of their own.
"""
from __future__ import annotations

import glob
import logging
import os
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from ..store import Store
from .config import query_config
from .params import NAME_PATTERN, ParamError, placeholders, substitute
from .service import BatchQuery, run_batch
from .snapshot import manager

log = logging.getLogger("odl.query.dashboards")

# Ids are slugs: lowercase, digits, '-' and '_'. They appear in URLs and are
# HASH fields in Redis, so they are kept boring on purpose.
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
NAME_RE = re.compile(rf"^{NAME_PATTERN}$")

MAX_PANELS = 40
GRID_COLUMNS = 12
MAX_PANEL_HEIGHT = 6
DEFAULT_CHART: dict = {"type": "auto"}

# Built-in definitions, shipped with the data layer. Loaded once at startup so
# a broken file is a startup error naming it, not a 500 at the first request.
BUILTIN_DIR = os.environ.get(
    "ODL_DASHBOARDS_DIR",
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                 "config", "dashboards"))


# --------------------------------------------------------------------------- #
# the definition
# --------------------------------------------------------------------------- #
class DashboardInvalid(Exception):
    """A definition the models refused. `errors` is [{field, error}, ...]."""

    def __init__(self, errors: list[dict]):
        super().__init__("; ".join(f"{e['field']}: {e['error']}" for e in errors) or "invalid")
        self.errors = errors


class Variable(BaseModel):
    """One input of a dashboard: what the user picks before the panels run."""
    model_config = ConfigDict(extra="forbid")

    name: str = Field(description="Placeholder name; `{{name}}` in a panel's SQL or title.")
    label: str | None = Field(default=None, description="What the selector is called in the UI.")
    type: Literal["select", "text", "number"] = "select"
    sql: str | None = Field(
        default=None,
        description="For a select: a query returning a `value` column and an optional `label`.")
    multi: bool = Field(default=False, description="True makes the value a list, for IN (...).")
    required: bool = False
    default: Any = None

    @field_validator("name")
    @classmethod
    def _name_is_a_placeholder_name(cls, value: str) -> str:
        if not NAME_RE.match(value or ""):
            raise ValueError(f"a variable name must match {NAME_PATTERN}")
        return value

    @model_validator(mode="after")
    def _options_query_matches_the_type(self) -> Variable:
        if self.type == "select" and not (self.sql or "").strip():
            raise ValueError("a select variable needs a sql query for its options")
        if self.type != "select" and (self.sql or "").strip():
            raise ValueError(f"a {self.type} variable has no options query")
        return self


class Panel(BaseModel):
    """One query on the grid. `chart` is opaque here: the front end owns it."""
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str = Field(min_length=1)
    sql: str = Field(min_length=1)
    description: str | None = None
    chart: dict = Field(default_factory=lambda: dict(DEFAULT_CHART))
    w: int = Field(default=6, ge=1, le=GRID_COLUMNS, description="Width in grid columns (1-12).")
    h: int = Field(default=2, ge=1, le=MAX_PANEL_HEIGHT, description="Height in grid rows (1-6).")
    limit: int | None = Field(default=None, ge=1, description="Row cap, up to ODL_QUERY_MAX_ROWS.")

    @field_validator("id")
    @classmethod
    def _id_is_a_slug(cls, value: str) -> str:
        if not SLUG_RE.match(value or ""):
            raise ValueError("a panel id must be a slug: lowercase letters, digits, '-' or '_'")
        return value

    @field_validator("sql", "title")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not (value or "").strip():
            raise ValueError("this field may not be blank")
        return value

    @field_validator("limit")
    @classmethod
    def _limit_is_within_the_row_cap(cls, value: int | None) -> int | None:
        # Read at validation time, not at import time: ODL_QUERY_MAX_ROWS is a
        # deployment knob and a test may move it.
        if value is not None and value > query_config.max_rows:
            raise ValueError(f"limit must be at most {query_config.max_rows}")
        return value


class Dashboard(BaseModel):
    """A dashboard definition - exactly what the front end reads and writes."""
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str = Field(min_length=1)
    description: str | None = None
    builtin: bool = False
    variables: list[Variable] = Field(default_factory=list)
    panels: list[Panel] = Field(default_factory=list, max_length=MAX_PANELS)
    updated_at: str | None = None
    updated_by: str | None = None

    @field_validator("id")
    @classmethod
    def _id_is_a_slug(cls, value: str) -> str:
        if not SLUG_RE.match(value or ""):
            raise ValueError("a dashboard id must be a slug: lowercase letters, digits, '-' or '_'")
        return value

    def variable(self, name: str) -> Variable | None:
        return next((v for v in self.variables if v.name == name), None)

    def as_dict(self) -> dict:
        return self.model_dump(mode="json")

    def summary(self) -> dict:
        """The row the list endpoint serves: enough to draw the picker."""
        return {
            "id": self.id, "title": self.title, "description": self.description,
            "builtin": self.builtin, "panels": len(self.panels),
            "variables": [v.name for v in self.variables], "updated_at": self.updated_at,
        }


def _field_path(loc) -> str:
    """A pydantic error location as the dotted path the front end shows."""
    return ".".join(str(part) for part in loc) or "body"


def _cross_field_errors(dashboard: Dashboard) -> list[dict]:
    """Everything a single field cannot know on its own, with its field path."""
    errors: list[dict] = []
    seen: set[str] = set()
    for index, panel in enumerate(dashboard.panels):
        if panel.id in seen:
            errors.append({"field": f"panels.{index}.id",
                           "error": f"duplicate panel id '{panel.id}'"})
        seen.add(panel.id)

    names = set()
    for index, variable in enumerate(dashboard.variables):
        if variable.name in names:
            errors.append({"field": f"variables.{index}.name",
                           "error": f"duplicate variable '{variable.name}'"})
        names.add(variable.name)
        if not variable.sql:
            continue
        try:
            used = placeholders(variable.sql)
        except ParamError as e:
            errors.append({"field": f"variables.{index}.sql", "error": str(e)})
            continue
        if used:
            errors.append({
                "field": f"variables.{index}.sql",
                "error": "an options query may not use variables: options and panels are "
                         f"resolved in one batch (found {{{{{used[0]}}}}})"})

    for index, panel in enumerate(dashboard.panels):
        for field, text in (("sql", panel.sql), ("title", panel.title)):
            try:
                used = placeholders(text)
            except ParamError as e:
                errors.append({"field": f"panels.{index}.{field}", "error": str(e)})
                continue
            for name in used:
                if name not in names:
                    errors.append({
                        "field": f"panels.{index}.{field}",
                        "error": f"'{{{{{name}}}}}' is not a declared variable"
                                 + (f" (declared: {', '.join(sorted(names))})" if names else "")})
    return errors


def parse_dashboard(data: Mapping | None, dashboard_id: str | None = None,
                    builtin: bool = False) -> Dashboard:
    """A definition document as a validated `Dashboard`, or `DashboardInvalid`.

    `dashboard_id` wins over any id in the body - the URL is the identity, so a
    copy-pasted definition saved under a new id becomes that dashboard rather
    than silently overwriting the one it came from.
    """
    if not isinstance(data, Mapping):
        raise DashboardInvalid([{"field": "body", "error": "a dashboard must be an object"}])
    document = dict(data)
    if dashboard_id is not None:
        document["id"] = dashboard_id
    document["builtin"] = builtin
    try:
        dashboard = Dashboard.model_validate(document)
    except ValidationError as e:
        raise DashboardInvalid([{"field": _field_path(err["loc"]), "error": err["msg"]}
                                for err in e.errors()]) from e
    errors = _cross_field_errors(dashboard)
    if errors:
        raise DashboardInvalid(errors)
    return dashboard


# --------------------------------------------------------------------------- #
# built-ins
# --------------------------------------------------------------------------- #
_builtins: dict[str, Dashboard] | None = None


def builtin_dashboards(reload: bool = False) -> dict[str, Dashboard]:
    """The YAML dashboards in `config/dashboards`, id -> definition.

    Read once and cached: they are part of the image, not of the fleet. A file
    that does not validate raises, and `main.py` calls this at startup so that
    happens there rather than at somebody's first request.
    """
    global _builtins
    if _builtins is not None and not reload:
        return _builtins
    loaded: dict[str, Dashboard] = {}
    for path in sorted(glob.glob(os.path.join(BUILTIN_DIR, "*.yaml"))
                       + glob.glob(os.path.join(BUILTIN_DIR, "*.yml"))):
        try:
            with open(path) as handle:
                document = yaml.safe_load(handle)
        except (OSError, yaml.YAMLError) as e:
            raise RuntimeError(f"built-in dashboard {path} could not be read: {e}") from e
        try:
            dashboard = parse_dashboard(document, builtin=True)
        except DashboardInvalid as e:
            raise RuntimeError(f"built-in dashboard {path} is invalid: {e}") from e
        if dashboard.id in loaded:
            raise RuntimeError(f"built-in dashboard {path} repeats the id '{dashboard.id}'")
        loaded[dashboard.id] = dashboard
    log.info("built-in dashboards: %s", ", ".join(loaded) or "none")
    _builtins = loaded
    return _builtins


def is_builtin(dashboard_id: str) -> bool:
    return dashboard_id in builtin_dashboards()


def saved_dashboards(store: Store) -> dict[str, Dashboard]:
    """The stored definitions, skipping any that no longer validate.

    A definition written by an older version of the format must not take the
    list endpoint down with it; it is logged and left out, and the owner sees
    it is gone rather than seeing a 500.
    """
    out: dict[str, Dashboard] = {}
    for document in store.dashboards():
        try:
            dashboard = parse_dashboard(document, builtin=False)
        except DashboardInvalid as e:
            log.warning("stored dashboard %r is invalid and is not listed: %s",
                        (document or {}).get("id"), e)
            continue
        out[dashboard.id] = dashboard
    return out


def list_dashboards(store: Store) -> list[dict]:
    """Summary rows: built-ins first, then saved ones, each sorted by title."""
    builtins = sorted(builtin_dashboards().values(), key=lambda d: (d.title.lower(), d.id))
    saved = sorted((d for d in saved_dashboards(store).values() if d.id not in builtin_dashboards()),
                   key=lambda d: (d.title.lower(), d.id))
    return [d.summary() for d in builtins] + [d.summary() for d in saved]


def get_dashboard(store: Store, dashboard_id: str) -> Dashboard | None:
    """One definition. A built-in id always resolves to the built-in."""
    builtin = builtin_dashboards().get(dashboard_id)
    if builtin is not None:
        return builtin
    document = store.dashboard_get(dashboard_id)
    if not document:
        return None
    try:
        return parse_dashboard(document, dashboard_id=dashboard_id, builtin=False)
    except DashboardInvalid:
        log.warning("stored dashboard %r no longer validates", dashboard_id)
        raise


def save_dashboard(store: Store, dashboard_id: str, data: Mapping) -> Dashboard:
    """Validate and store a definition, stamping `updated_at`."""
    dashboard = parse_dashboard(data, dashboard_id=dashboard_id, builtin=False)
    dashboard.updated_at = datetime.now(UTC).isoformat()
    store.dashboard_set(dashboard_id, dashboard.as_dict())
    return dashboard


# --------------------------------------------------------------------------- #
# running one
# --------------------------------------------------------------------------- #
# Option queries share the batch with the panels, so their ids have to live in
# the same namespace without colliding with a panel id. A panel id is a slug,
# and a slug cannot contain ':', so this prefix is safe by construction.
_VARIABLE_PREFIX = "var:"


def _coerce(variable: Variable, value):
    """One incoming parameter, in the shape the variable promised.

    The front end sends what an HTML control produces - a string from a text
    box, one value from a single select, a list from a multi select - and the
    SQL was written for one shape. Meeting it here means a panel's `= {{hub}}`
    never accidentally receives a list, and `INTERVAL ({{days}}) DAY` never
    receives the string '7'.
    """
    if value is None or (isinstance(value, str) and not value.strip()):
        return None                         # an empty box is an unset variable
    if variable.multi:
        values = list(value) if isinstance(value, list | tuple) else [value]
        values = [v for v in values if v is not None]
        return values or None
    if isinstance(value, list | tuple):
        value = value[0] if value else None
        if value is None:
            return None
    if variable.type == "number" and not isinstance(value, bool | int | float):
        try:
            text = str(value).strip()
            return int(text) if re.fullmatch(r"[+-]?\d+", text) else float(text)
        except (TypeError, ValueError) as e:
            raise ParamError(f"variable '{variable.name}' must be a number, got {value!r}") from e
    return value


def effective_params(dashboard: Dashboard, params: Mapping | None) -> dict:
    """The declared variables' values: what was sent, else the default.

    Only declared variables come back. A dashboard's parameters are its
    variables; anything else in the request is not a variable of this
    dashboard and has no business reaching its SQL.
    """
    given = params or {}
    out: dict = {}
    for variable in dashboard.variables:
        value = _coerce(variable, given.get(variable.name))
        if value is None:
            value = _coerce(variable, variable.default)
        out[variable.name] = value
    return out


def _unset(values: Mapping) -> set[str]:
    return {name for name, value in values.items() if value is None}


def _panel_queries(dashboard: Dashboard, values: Mapping) -> tuple[list[BatchQuery], dict[str, dict]]:
    """Panels split into the ones that can run and the ones that cannot (yet)."""
    queries: list[BatchQuery] = []
    blocked: dict[str, dict] = {}
    missing = _unset(values)
    for panel in dashboard.panels:
        used = placeholders(panel.sql) + placeholders(panel.title)
        unset = next((name for name in used if name in missing), None)
        if unset is not None:
            # Not an error the user made: the selector has not been used yet.
            blocked[panel.id] = {"error": f"variable {unset} is not set"}
            continue
        queries.append(BatchQuery(id=panel.id, sql=substitute(panel.sql, values),
                                  limit=panel.limit))
    return queries, blocked


def _options(result: dict | None) -> dict:
    """An options query's rows as [{value, label}], or the reason there are none."""
    if result is None:
        return {"options": []}
    if "error" in result:
        return {"options": [], "error": result["error"]}
    columns = result.get("columns") or []
    if "value" not in columns:
        return {"options": [],
                "error": "the options query must return a column named 'value'"}
    value_at = columns.index("value")
    label_at = columns.index("label") if "label" in columns else value_at
    options, seen = [], set()
    for row in result.get("rows") or []:
        value = row[value_at]
        # A JSON column could hand back a list; keying on its text keeps the
        # de-duplication total without assuming the column is scalar.
        key = value if isinstance(value, str | int | float | bool) else str(value)
        if value is None or key in seen:
            continue
        seen.add(key)
        options.append({"value": value, "label": row[label_at]})
    return {"options": options}


def run(dashboard: Dashboard, params: Mapping | None = None,
        store: Store | None = None) -> dict:
    """Resolve the variables and run every panel, all against one snapshot.

    The option queries go into the same batch as the panels, so the selector a
    user sees and the numbers beside it describe the same moment. A panel whose
    variable has no value yet is reported as such and costs nothing to run.
    """
    values = effective_params(dashboard, params)
    queries: list[BatchQuery] = [
        BatchQuery(id=f"{_VARIABLE_PREFIX}{v.name}", sql=v.sql, limit=query_config.max_rows)
        for v in dashboard.variables if v.sql
    ]
    panel_queries, blocked = _panel_queries(dashboard, values)
    queries += panel_queries

    run_result = run_batch(queries, store=store)
    results = {panel.id: run_result.results.get(panel.id) or blocked.get(panel.id)
               for panel in dashboard.panels}
    variables = {v.name: _options(run_result.results.get(f"{_VARIABLE_PREFIX}{v.name}")
                                 if v.sql else None)
                 for v in dashboard.variables}
    return {
        "dashboard": dashboard.as_dict(),
        "params": values,
        "variables": variables,
        "results": results,
        "generation": run_result.generation,
        "snapshot": manager.info().as_dict(),
    }
