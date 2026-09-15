"""
Dashboards: definitions in, one snapshot's worth of answers out.

Five endpoints over `app/query/dashboards.py`, which owns the format and the
running of it:

  GET    /api/dashboards           the picker: built-ins first, then saved
  GET    /api/dashboards/{id}      the full definition, to render or to edit
  PUT    /api/dashboards/{id}      save one (built-in ids are refused)
  DELETE /api/dashboards/{id}      remove one (same)
  POST   /api/dashboards/{id}/run  resolve the variables, run every panel

Definitions are stored server-side, so a dashboard is something a team has
rather than something a browser remembers. The built-ins are read-only by
design: they ship with the image and are replaced by an upgrade, so a change
saved over one would be lost the next time - cloning under a new id is the
honest operation, and that is what the 409 says.

Validation failures are 400s that name the field: `panels.2.sql` is a message
an editor can put next to the box that is wrong, which "invalid dashboard" is
not.
"""
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..query.dashboards import DashboardInvalid, get_dashboard, is_builtin, list_dashboards, save_dashboard
from ..query.dashboards import run as run_dashboard
from ..query.errors import QueryRejected
from ..query.params import ParamError
from ..store import Store
from .deps import get_store_dep

router = APIRouter(prefix="/api/dashboards", tags=["dashboards"])

_BUILTIN_IS_READ_ONLY = "'{id}' is a built-in dashboard; clone it under another id"


class RunRequest(BaseModel):
    params: dict[str, Any] = Field(
        default_factory=dict,
        description="Values for the dashboard's variables; missing ones fall back to the default.")


def _load(store: Store, dashboard_id: str):
    """One dashboard, or the right error: 404 missing, 400 no longer valid."""
    try:
        dashboard = get_dashboard(store, dashboard_id)
    except DashboardInvalid as e:
        # Stored by an older format, or edited outside the API. Say what is
        # wrong with it rather than 500ing: the editor can still fix it.
        raise HTTPException(400, e.errors) from e
    if dashboard is None:
        raise HTTPException(404, f"no dashboard '{dashboard_id}'")
    return dashboard


@router.get("")
def get_dashboards(store: Store = Depends(get_store_dep)):
    """Every dashboard, as summary rows. Built-ins first, then saved ones."""
    return {"dashboards": list_dashboards(store)}


@router.get("/{dashboard_id}")
def get_one(dashboard_id: str, store: Store = Depends(get_store_dep)):
    """The full definition: variables, panels, SQL and all."""
    return _load(store, dashboard_id).as_dict()


@router.put("/{dashboard_id}")
def put_one(dashboard_id: str, body: dict, store: Store = Depends(get_store_dep)):
    """Create or replace a saved dashboard. The id in the path is the identity."""
    if is_builtin(dashboard_id):
        raise HTTPException(409, _BUILTIN_IS_READ_ONLY.format(id=dashboard_id))
    try:
        return save_dashboard(store, dashboard_id, body).as_dict()
    except DashboardInvalid as e:
        raise HTTPException(400, e.errors) from e


@router.delete("/{dashboard_id}")
def delete_one(dashboard_id: str, store: Store = Depends(get_store_dep)):
    """Remove a saved dashboard."""
    if is_builtin(dashboard_id):
        raise HTTPException(409, _BUILTIN_IS_READ_ONLY.format(id=dashboard_id))
    if not store.dashboard_delete(dashboard_id):
        raise HTTPException(404, f"no dashboard '{dashboard_id}'")
    return {"deleted": dashboard_id}


@router.post("/{dashboard_id}/run")
def post_run(dashboard_id: str, body: RunRequest | None = None,
             store: Store = Depends(get_store_dep)):
    """Run the whole dashboard against one snapshot build.

    The variables' option queries run in the same batch as the panels, so the
    selector and the numbers beside it describe the same moment. A variable
    with no value yet is not an error - its options come back so the UI can
    draw the selector, and the panels that need it say they are waiting for it.
    """
    dashboard = _load(store, dashboard_id)
    try:
        return run_dashboard(dashboard, (body.params if body else None), store)
    except ParamError as e:
        raise HTTPException(400, str(e)) from e
    except QueryRejected as e:      # a built-in whose SQL the guard refuses
        raise HTTPException(400, e.reason) from e
