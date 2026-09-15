"""
What the model is allowed to do, and the validation it cannot get around.

Generative UI here does not mean the model writes HTML. It means it composes
from the vocabulary the dashboards feature already has - a panel is a query
plus a chart choice plus a size on a 12-column grid, a variable is a named
input - by calling six tools. Five of them change the state; one only looks.

Every one of them obeys the same three rules:

  1. **Arguments are validated, never trusted.** Each tool has a pydantic model
     with `extra="forbid"`, and the Anthropic tool schema is generated from it,
     so the thing the model is told about and the thing we accept cannot drift.
     A bad argument is a tool *result* saying so, never an exception: the model
     reads it and fixes its own call, which is the whole point of a loop.
  2. **SQL is dry-run before it becomes a panel.** Variables are substituted
     (as SQL literals), the guard validates the statement, and it is executed
     against the snapshot. A failure returns the error and the SQL that
     produced it and changes nothing - the model gets to fix it, and the user
     never sees a panel that cannot run.
  3. **A mutation is the whole definition re-validated.** The operations are
     applied to a copy, `parse_dashboard` judges the result, and only then does
     it become the state. So an agent-built dashboard is, at every instant, a
     dashboard `PUT /api/dashboards/{id}` would accept.

The tool names are part of the contract with the front end, which labels the
activity it shows by them.
"""
from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..query.dashboards import (
    GRID_COLUMNS,
    MAX_PANEL_HEIGHT,
    SLUG_RE,
    DashboardInvalid,
    Panel,
    Variable,
    effective_params,
)
from ..query.dashboards import _options as options_of
from ..query.errors import QueryExecutionError, QueryRejected
from ..query.params import ParamError, placeholders, substitute
from ..query.service import QueryResult, run_sql
from ..store import Store
from .config import agent_config
from .state import apply_ops, definition, revalidate

log = logging.getLogger("odl.agent.tools")

# How much of a result the model is shown. It needs the shape of the answer
# (what the columns are called, whether there are rows at all), not the answer:
# the user gets that from the panel, and every cell we quote is context the
# next turn pays for.
PREVIEW_ROWS = 10
SAMPLE_ROWS = 5
CELL_CHARS = 120
MAX_OPTIONS = 20


class ToolError(Exception):
    """A tool refused. It becomes the tool's result, so the model can react."""

    def __init__(self, message: str, sql: str | None = None):
        super().__init__(message)
        self.message = message
        self.sql = sql

    def as_result(self) -> dict:
        result: dict = {"error": self.message}
        if self.sql is not None:
            result["sql"] = self.sql
        return result


@dataclass
class ToolContext:
    """The run's server-side state, and what a tool needs to change it."""

    state: dict
    store: Store | None = None
    max_panels: int = field(default_factory=lambda: agent_config.max_panels)


@dataclass
class ToolOutcome:
    """What a tool answered, and how the state moved because of it."""

    result: dict
    ops: list[dict] = field(default_factory=list)

    @property
    def failed(self) -> bool:
        return "error" in self.result


# --------------------------------------------------------------------------- #
# arguments
# --------------------------------------------------------------------------- #
ChartType = Literal["auto", "line", "bars", "none"]


class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PreviewSqlArgs(_Args):
    sql: str = Field(min_length=1, description="A single DuckDB SELECT over the snapshot tables.")
    limit: int | None = Field(default=None, ge=1, description="Row cap for the preview.")


class SetDashboardArgs(_Args):
    title: str = Field(min_length=1, description="The dashboard's title, in plain English.")
    description: str | None = Field(default=None,
                                    description="One sentence saying what the dashboard shows.")


class PanelFields(_Args):
    """The fields a panel is made of, shared by add_panel and update_panel."""

    title: str | None = Field(default=None, min_length=1,
                              description="The panel heading. May use {{variable}}.")
    sql: str | None = Field(default=None, min_length=1,
                            description="The panel's SELECT. May use {{variable}}.")
    chart: ChartType | None = Field(
        default=None,
        description="auto lets the front end choose, line is a time series, bars is categories, "
                    "none forces a table.")
    x: str | None = Field(default=None, description="Column for the x axis (the time bucket "
                                                    "for a line chart).")
    y: list[str] | None = Field(default=None, description="Numeric columns to plot.")
    series: str | None = Field(default=None, description="Column that splits the data into series.")
    w: int | None = Field(default=None, ge=1, le=GRID_COLUMNS,
                          description=f"Width in grid columns, 1-{GRID_COLUMNS}.")
    h: int | None = Field(default=None, ge=1, le=MAX_PANEL_HEIGHT,
                          description=f"Height in grid rows, 1-{MAX_PANEL_HEIGHT}.")
    description: str | None = Field(default=None, description="Optional note under the title.")
    limit: int | None = Field(default=None, ge=1, description="Row cap for this panel.")


class AddPanelArgs(PanelFields):
    title: str = Field(min_length=1, description="The panel heading. May use {{variable}}.")
    sql: str = Field(min_length=1, description="The panel's SELECT. May use {{variable}}.")


class UpdatePanelArgs(PanelFields):
    id: str = Field(min_length=1, description="The id of the panel to change.")


class RemovePanelArgs(_Args):
    id: str = Field(min_length=1, description="The id of the panel to remove.")


class AddVariableArgs(_Args):
    name: str = Field(min_length=1,
                      description="Placeholder name; panels then use {{name}}.")
    label: str | None = Field(default=None, description="What the selector is called in the UI.")
    type: Literal["select", "text", "number"] = Field(
        default="select", description="select needs an options query; text and number are typed in.")
    sql: str | None = Field(
        default=None,
        description="For a select: a SELECT returning a `value` column and an optional `label`. "
                    "It may not itself use variables.")
    default: Any = Field(default=None,
                         description="The value the dashboard opens with. Give one whenever the "
                                     "question named a value.")
    multi: bool = Field(default=False, description="True makes the value a list, for IN (...).")
    required: bool = Field(default=False, description="True when no panel can run without it.")


def _json_schema(model: type[BaseModel]) -> dict:
    """A tool's input schema, from its model, without pydantic's titles."""
    schema = model.model_json_schema()
    schema.pop("title", None)
    for prop in schema.get("properties", {}).values():
        prop.pop("title", None)
    return schema


# --------------------------------------------------------------------------- #
# running SQL on the model's behalf
# --------------------------------------------------------------------------- #
def _cap(value):
    """One cell, short enough to quote back to the model."""
    if isinstance(value, str) and len(value) > CELL_CHARS:
        return value[:CELL_CHARS - 3] + "..."
    return value


def _rows(result: QueryResult, count: int) -> list[list]:
    return [[_cap(cell) for cell in row] for row in result.rows[:count]]


def _values(context: ToolContext) -> dict:
    """The dashboard's variables with their current values: params, then defaults."""
    dashboard = revalidate(context.state)
    return effective_params(dashboard, context.state.get("params") or {})


def _resolve(sql: str, context: ToolContext) -> str:
    """`sql` with its variables filled in, or a ToolError saying what is missing.

    An unset variable is not something to paper over: a panel whose value is
    missing cannot be dry-run, and quietly substituting nothing would hide the
    decision the model has to make - give the variable a default, or ask.
    """
    try:
        used = placeholders(sql)
    except ParamError as e:
        raise ToolError(str(e)) from e
    values = _values(context)
    for name in used:
        if name not in values:
            declared = ", ".join(sorted(values)) or "none"
            raise ToolError(f"'{{{{{name}}}}}' is not a variable of this dashboard "
                            f"(declared: {declared}). Add it with add_variable first.")
        if values[name] is None:
            raise ToolError(f"variable '{name}' has no value, so this SQL cannot be checked. "
                            f"Give it a default with add_variable, or ask the user which "
                            f"value to use.")
    try:
        return substitute(sql, values)
    except ParamError as e:
        raise ToolError(str(e)) from e


def _run(sql: str, limit: int | None, context: ToolContext) -> QueryResult:
    """Substitute, guard, execute. Every failure names the SQL that failed."""
    resolved = _resolve(sql, context)
    try:
        return run_sql(resolved, limit, context.store)
    except QueryRejected as e:
        raise ToolError(e.reason, sql=resolved) from e
    except QueryExecutionError as e:          # QueryTimeout is one of these
        raise ToolError(str(e), sql=resolved) from e


def _commit(context: ToolContext, ops: list[dict]) -> None:
    """Apply the operations to a copy, validate it, and make it the state.

    The values in the operations come from the `Panel` and `Variable` models,
    so the patched document already is what the format normalises to. Checking
    that is cheap and worth it: if it were ever false, our state and the
    browser's - which only sees the operations - would drift apart in silence.
    """
    candidate = apply_ops(context.state, ops)
    try:
        dashboard = revalidate(candidate)
    except DashboardInvalid as e:
        raise ToolError(str(e)) from e
    if definition(dashboard) != candidate["dashboard"]:
        raise ToolError("the change did not round-trip through the dashboard format")
    context.state = candidate


# --------------------------------------------------------------------------- #
# panels
# --------------------------------------------------------------------------- #
def _slug(title: str, taken: set[str]) -> str:
    """A panel id from its title: a slug, made unique with -2, -3, ...

    The id is what a refinement addresses ("make the second one a bar chart"
    becomes update_panel), so it has to be stable and guessable from the title.
    """
    base = re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-_")[:48].strip("-_")
    if not SLUG_RE.match(base):
        base = "panel"
    candidate = base
    suffix = 2
    while candidate in taken:
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate


def _chart(*, type_: str | None, x: str | None, y: list[str] | None, series: str | None,
           stack: bool = False) -> dict:
    """The opaque chart object, in exactly the shape the front end normalises to."""
    return {"type": type_ or "auto", "x": x or "", "y": list(y or []),
            "series": series or None, "stack": bool(stack)}


def _panel_result(panel_id: str, result: QueryResult) -> dict:
    """What the model learns from a panel it just built: the shape of its answer."""
    return {"id": panel_id, "columns": result.columns, "column_types": result.column_types,
            "row_count": result.row_count, "sample_rows": _rows(result, SAMPLE_ROWS)}


def _panels(context: ToolContext) -> list[dict]:
    return context.state["dashboard"]["panels"]


def preview_sql(args: PreviewSqlArgs, context: ToolContext) -> ToolOutcome:
    result = _run(args.sql, args.limit, context)
    return ToolOutcome({
        "columns": result.columns, "column_types": result.column_types,
        "rows": _rows(result, PREVIEW_ROWS), "row_count": result.row_count,
        "truncated": result.truncated, "elapsed_ms": result.elapsed_ms,
    })


def set_dashboard(args: SetDashboardArgs, context: ToolContext) -> ToolOutcome:
    ops = [{"op": "replace", "path": "/dashboard/title", "value": args.title}]
    if "description" in args.model_fields_set:
        ops.append({"op": "replace", "path": "/dashboard/description",
                    "value": args.description})
    _commit(context, ops)
    dashboard = context.state["dashboard"]
    return ToolOutcome({"title": dashboard["title"], "description": dashboard["description"]}, ops)


def add_panel(args: AddPanelArgs, context: ToolContext) -> ToolOutcome:
    panels = _panels(context)
    if len(panels) >= context.max_panels:
        raise ToolError(f"this dashboard already has {len(panels)} panels, which is the cap. "
                        f"Change one with update_panel or drop one with remove_panel instead.")
    panel = Panel.model_validate({
        "id": _slug(args.title, {p["id"] for p in panels}),
        "title": args.title, "sql": args.sql, "description": args.description,
        "chart": _chart(type_=args.chart, x=args.x, y=args.y, series=args.series),
        **({"w": args.w} if args.w is not None else {}),
        **({"h": args.h} if args.h is not None else {}),
        "limit": args.limit,
    })
    result = _run(panel.sql, panel.limit, context)
    ops = [{"op": "add", "path": "/dashboard/panels/-", "value": panel.model_dump(mode="json")}]
    _commit(context, ops)
    return ToolOutcome(_panel_result(panel.id, result), ops)


def _panel_at(context: ToolContext, panel_id: str) -> int:
    for index, panel in enumerate(_panels(context)):
        if panel["id"] == panel_id:
            return index
    known = ", ".join(p["id"] for p in _panels(context)) or "none"
    raise ToolError(f"no panel '{panel_id}' on this dashboard (panels: {known})")


def update_panel(args: UpdatePanelArgs, context: ToolContext) -> ToolOutcome:
    index = _panel_at(context, args.id)
    current = dict(_panels(context)[index])
    given = args.model_fields_set
    chart = current.get("chart") or {}
    merged = {
        **current,
        **{name: getattr(args, name)
           for name in ("title", "sql", "description", "w", "h", "limit") if name in given},
        "chart": _chart(
            type_=args.chart if "chart" in given else chart.get("type"),
            x=args.x if "x" in given else chart.get("x"),
            y=args.y if "y" in given else chart.get("y"),
            series=args.series if "series" in given else chart.get("series"),
            stack=chart.get("stack", False)),
    }
    panel = Panel.model_validate(merged)
    # Dry-run whatever the panel will actually run, changed SQL or not: the
    # result is what tells the model the panel is good, and a panel whose
    # columns moved under it is exactly the case a refinement has to catch.
    result = _run(panel.sql, panel.limit, context)
    ops = [{"op": "replace", "path": f"/dashboard/panels/{index}",
            "value": panel.model_dump(mode="json")}]
    _commit(context, ops)
    return ToolOutcome(_panel_result(panel.id, result), ops)


def remove_panel(args: RemovePanelArgs, context: ToolContext) -> ToolOutcome:
    index = _panel_at(context, args.id)
    ops = [{"op": "remove", "path": f"/dashboard/panels/{index}"}]
    _commit(context, ops)
    return ToolOutcome({"removed": args.id}, ops)


# --------------------------------------------------------------------------- #
# variables
# --------------------------------------------------------------------------- #
def add_variable(args: AddVariableArgs, context: ToolContext) -> ToolOutcome:
    state = context.state
    if any(v["name"] == args.name for v in state["dashboard"]["variables"]):
        raise ToolError(f"'{args.name}' is already a variable of this dashboard")
    try:
        variable = Variable.model_validate(args.model_dump())
    except ValidationError as e:
        raise ToolError(_validation_message(e)) from e

    options: list = []
    if variable.sql:
        # An options query runs in the same batch as the panels, so it cannot
        # depend on another variable - and it is dry-run here for the same
        # reason a panel is: a selector with no options is a dead dashboard.
        if placeholders(variable.sql):
            raise ToolError("an options query may not use variables: options and panels are "
                            "resolved in one batch against one snapshot")
        result = _run(variable.sql, None, context)
        resolved = options_of(result.as_dict())
        if resolved.get("error"):
            raise ToolError(resolved["error"], sql=result.sql)
        options = [option["value"] for option in resolved["options"]][:MAX_OPTIONS]

    ops: list[dict] = [{"op": "add", "path": "/dashboard/variables/-",
                        "value": variable.model_dump(mode="json")}]
    if variable.default is not None:
        ops.append({"op": "replace" if variable.name in state["params"] else "add",
                    "path": f"/params/{variable.name}", "value": variable.default})
    _commit(context, ops)
    return ToolOutcome({"name": variable.name, "options": options}, ops)


# --------------------------------------------------------------------------- #
# the catalogue
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    args: type[BaseModel]
    run: Any                      # (args, ToolContext) -> ToolOutcome
    mutating: bool

    def definition(self) -> dict:
        """The Anthropic tool definition, schema generated from the model."""
        return {"name": self.name, "description": self.description,
                "input_schema": _json_schema(self.args)}


TOOLS: tuple[Tool, ...] = (
    Tool("preview_sql",
         "Run a read-only SELECT against the fleet snapshot and see the first rows. Use it when "
         "you are unsure a column exists or which values a column holds - not to build a panel. "
         "It changes nothing.",
         PreviewSqlArgs, preview_sql, mutating=False),
    Tool("set_dashboard",
         "Set the dashboard's title and description. Call this first, before any panel, so the "
         "user sees what is being built.",
         SetDashboardArgs, set_dashboard, mutating=True),
    Tool("add_panel",
         "Add a panel: a title and a SELECT, with a chart choice and a size on the 12-column "
         "grid. The SQL is run before the panel is added; if it fails you get the error back and "
         "nothing changes.",
         AddPanelArgs, add_panel, mutating=True),
    Tool("update_panel",
         "Change an existing panel by id. Only the fields you pass are changed. Prefer this over "
         "removing and re-adding when refining a dashboard: the panel keeps its id and its place.",
         UpdatePanelArgs, update_panel, mutating=True),
    Tool("remove_panel",
         "Remove a panel by id.",
         RemovePanelArgs, remove_panel, mutating=True),
    Tool("add_variable",
         "Add a variable the user can change, and use it as {{name}} in panel SQL. A select needs "
         "an options query returning a `value` column; give a `default` so the panels can run "
         "straight away.",
         AddVariableArgs, add_variable, mutating=True),
)
TOOLS_BY_NAME: dict[str, Tool] = {tool.name: tool for tool in TOOLS}


def definitions() -> list[dict]:
    """The tool definitions as the Anthropic API takes them."""
    return [tool.definition() for tool in TOOLS]


def _validation_message(error: ValidationError) -> str:
    """A pydantic failure as one line the model can act on."""
    parts = []
    for item in error.errors():
        field_path = ".".join(str(p) for p in item["loc"]) or "arguments"
        parts.append(f"{field_path}: {item['msg']}")
    return "; ".join(parts) or "the arguments are not valid"


def execute(name: str, arguments: Mapping | None, context: ToolContext) -> ToolOutcome:
    """Run one tool call. Every foreseeable failure is a result, not an exception.

    That is the loop's error handling: a model that gets `{"error": ...}` back
    fixes its call and carries on, while an exception would end the run and
    lose the panels already built.
    """
    tool = TOOLS_BY_NAME.get(name)
    if tool is None:
        return ToolOutcome({"error": f"there is no tool called '{name}'. Available: "
                                     f"{', '.join(TOOLS_BY_NAME)}"})
    if not isinstance(arguments, Mapping):
        return ToolOutcome({"error": "the arguments must be a JSON object"})
    try:
        args = tool.args.model_validate(dict(arguments))
    except ValidationError as e:
        return ToolOutcome({"error": _validation_message(e)})
    try:
        return tool.run(args, context)
    except ToolError as e:
        log.info("tool %s refused: %s", name, e.message)
        return ToolOutcome(e.as_result())
    except ValidationError as e:
        # A `Panel` or `Variable` the format itself refuses - a limit above the
        # row cap, a size off the grid. The model can fix those.
        return ToolOutcome({"error": _validation_message(e)})
    except (ParamError, DashboardInvalid) as e:
        return ToolOutcome({"error": str(e)})
