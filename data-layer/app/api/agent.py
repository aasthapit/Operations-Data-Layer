"""
The dashboard-building agent, over server-sent events.

Two endpoints, and the interesting one answers with a stream:

  GET  /api/agent      can a run start, with which model, under which limits
  POST /api/agent/run  an AG-UI RunAgentInput; an AG-UI event stream back

Everything that can be a status code is one, and it happens *before* the first
byte of the stream: no credentials is a 503, a body that is not a run input (or
a thread that does not end with a user message) is a 422. After that the
response is committed, so every later failure is a `RUN_ERROR` event with a
code - a stream that just stops is indistinguishable from a crashed pod.

The loop is synchronous (so is the Anthropic SDK), so it runs in a worker
thread and hands its events to the event loop through a queue. That is the
whole reason for the plumbing below: a `for` loop over the generator here would
block the process for the length of a model turn and stall every other request
the worker is serving.

Buffering is the other thing SSE gets wrong by default: `Cache-Control: no-cache`
and `X-Accel-Buffering: no` tell a proxy not to hold the events back, and
`dashboard/nginx.conf` turns off `proxy_buffering` for this path for the same
reason.
"""
import asyncio
import logging
import threading

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from ..agent.config import agent_config
from ..agent.events import sse
from ..agent.messages import RunAgentInput
from ..agent.model import availability
from ..agent.run import AgentRun
from ..query.dashboards import DashboardInvalid
from ..store import Store
from .deps import get_store_dep

router = APIRouter(prefix="/api/agent", tags=["agent"])

log = logging.getLogger("odl.api.agent")

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    # nginx buffers a proxied response by default, which would hold every
    # event until the run ended - the one thing this endpoint must not do.
    "X-Accel-Buffering": "no",
}

# Sentinel that tells the reader the worker thread is done.
_DONE = object()


@router.get("")
def get_agent():
    """Whether a dashboard can be generated right now, and what bounds a run."""
    available, reason = availability()
    return {"available": available, "model": agent_config.model, "reason": reason,
            "limits": agent_config.as_limits()}


@router.post("/run")
async def post_run(body: RunAgentInput, request: Request,
                   store: Store = Depends(get_store_dep)):
    """Build or refine a dashboard, streaming every step as an AG-UI event."""
    available, reason = availability()
    if not available:
        raise HTTPException(503, reason)
    if not body.ends_with_a_user_message():
        raise HTTPException(422, "the last message must be a user message: a run answers "
                                 "something the user just asked")
    try:
        run = AgentRun(body, store, is_cancelled=None)
    except DashboardInvalid as e:
        raise HTTPException(422, e.errors) from e

    return StreamingResponse(_events(run, request), media_type="text/event-stream",
                             headers=SSE_HEADERS)


async def _events(run: AgentRun, request: Request):
    """Drive the synchronous loop from a worker thread, frame by frame.

    The cancel flag is set when the browser goes away, and the loop reads it
    before each model call and each tool - so a closed tab stops a run that is
    costing money rather than leaving it to finish into a socket nobody holds.
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    cancelled = threading.Event()
    run.is_cancelled = cancelled.is_set

    def pump():
        try:
            for event in run.events():
                loop.call_soon_threadsafe(queue.put_nowait, event)
        except Exception:  # noqa: BLE001 - events() maps its own failures; this is a last resort
            log.exception("agent run %s died outside its own error handling", run.payload.run_id)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, _DONE)

    worker = threading.Thread(target=pump, name="odl-agent-run", daemon=True)
    worker.start()
    try:
        while True:
            event = await queue.get()
            if event is _DONE:
                return
            yield sse(event)
            if await request.is_disconnected():
                log.info("agent run %s: the client disconnected", run.payload.run_id)
                return
    finally:
        cancelled.set()
