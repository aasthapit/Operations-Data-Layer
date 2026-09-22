import { describe, expect, it, vi } from "vitest";
import { applyPatch, newId, runAgent } from "./client";

// --------------------------------------------------------------------------- //
// the stream
// --------------------------------------------------------------------------- //
// A body that hands out exactly the chunks it was given, so a test can decide
// where a frame is cut in half.
function bodyOf(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    getReader: () => ({
      read: async () => (i < chunks.length
        ? { value: encoder.encode(chunks[i++]), done: false }
        : { value: undefined, done: true }),
    }),
  };
}

function streaming(chunks) {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, body: bodyOf(chunks) }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;

async function collect(chunks) {
  const events = [];
  await runAgent({ messages: [], state: {}, threadId: "t", runId: "r",
    onEvent: (e) => events.push(e) });
  return events;
}

describe("runAgent", () => {
  it("posts the whole thread, because the API holds no session", async () => {
    const fetchMock = streaming([frame({ type: "RUN_FINISHED" })]);
    await runAgent({
      messages: [{ id: "m1", role: "user", content: "Review production" }],
      state: { dashboard: { id: "generated" } },
      threadId: "thread_1",
      runId: "run_1",
      onEvent: () => {},
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/agent/run");
    expect(init.method).toBe("POST");
    expect(init.headers.accept).toBe("text/event-stream");
    const body = JSON.parse(init.body);
    expect(body.threadId).toBe("thread_1");
    expect(body.messages[0].content).toBe("Review production");
    expect(body.state.dashboard.id).toBe("generated");
    expect(body.parentRunId).toBeNull();
  });

  it("hands every event to the caller in arrival order", async () => {
    streaming([
      frame({ type: "RUN_STARTED" }),
      frame({ type: "TEXT_MESSAGE_START", messageId: "m1" }),
      frame({ type: "RUN_FINISHED", result: { turns: 2 } }),
    ]);
    const events = await collect();
    expect(events.map((e) => e.type))
      .toEqual(["RUN_STARTED", "TEXT_MESSAGE_START", "RUN_FINISHED"]);
    expect(events[2].result).toEqual({ turns: 2 });
  });

  it("reassembles a frame that was cut in half between two chunks", async () => {
    const whole = frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Writing a panel" });
    streaming([whole.slice(0, 20), whole.slice(20)]);
    const events = await collect();
    expect(events).toEqual([
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Writing a panel" },
    ]);
  });

  it("reads several frames that arrived in one chunk", async () => {
    streaming([frame({ type: "A" }) + frame({ type: "B" }) + frame({ type: "C" })]);
    expect((await collect()).map((e) => e.type)).toEqual(["A", "B", "C"]);
  });

  it("accepts CRLF terminators as well as bare newlines", async () => {
    streaming([`data: ${JSON.stringify({ type: "A" })}\r\n\r\ndata: ${JSON.stringify({ type: "B" })}\r\n\r\n`]);
    expect((await collect()).map((e) => e.type)).toEqual(["A", "B"]);
  });

  it("joins a frame's several data lines with newlines before parsing it", async () => {
    streaming(['data: {"type":"TEXT_MESSAGE_CONTENT",\ndata: "delta":"two lines"}\n\n']);
    expect(await collect()).toEqual([{ type: "TEXT_MESSAGE_CONTENT", delta: "two lines" }]);
  });

  it("takes the type from an SSE event field when the payload does not carry one", async () => {
    streaming(['event: RUN_ERROR\ndata: {"message":"no credentials"}\n\n']);
    expect(await collect()).toEqual([{ message: "no credentials", type: "RUN_ERROR" }]);
  });

  it("ignores comments, ids and retry directives", async () => {
    streaming([`: keep-alive\n\nid: 7\nretry: 2000\n${frame({ type: "A" })}`]);
    expect((await collect()).map((e) => e.type)).toEqual(["A"]);
  });

  it("delivers a last frame that arrived without its terminating blank line", async () => {
    streaming([`data: ${JSON.stringify({ type: "RUN_FINISHED" })}\n`]);
    expect((await collect()).map((e) => e.type)).toEqual(["RUN_FINISHED"]);
  });

  it("carries on past a frame it cannot parse rather than dropping the run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    streaming([`data: {not json\n\n${frame({ type: "RUN_FINISHED" })}`]);
    expect((await collect()).map((e) => e.type)).toEqual(["RUN_FINISHED"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("ignores a frame whose payload is not an object", async () => {
    streaming(["data: 42\n\n", "data: null\n\n"]);
    expect(await collect()).toEqual([]);
  });

  it("raises the API's own reason, with its status, when the run is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 503, statusText: "Service Unavailable",
      text: async () => JSON.stringify({ detail: "no model credentials are configured" }),
    })));
    const error = await runAgent({ messages: [], state: {}, threadId: "t", runId: "r",
      onEvent: () => {} }).then(() => null, (e) => e);
    expect(error.status).toBe(503);
    expect(error.message).toBe("no model credentials are configured");
  });

  it("falls back to the status line when the refusal carries no readable body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 404, statusText: "Not Found", text: async () => "",
    })));
    const error = await runAgent({ messages: [], state: {}, threadId: "t", runId: "r",
      onEvent: () => {} }).then(() => null, (e) => e);
    expect(error.message).toBe("404 Not Found");
  });

  it("says so when the endpoint answered without a stream at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, body: null })));
    await expect(runAgent({ messages: [], state: {}, threadId: "t", runId: "r",
      onEvent: () => {} })).rejects.toThrow("the agent answered without a stream body");
  });

  it("plays the scripted run instead of the wire when the fixture is asked for", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const events = [];
    const run = runAgent({
      messages: [{ id: "m1", role: "user", content: "Review hub-east" }],
      state: {}, threadId: "t", runId: "r", fixture: true, signal: controller.signal,
      onEvent: (e) => { events.push(e); if (events.length === 2) controller.abort(); },
    });
    await run;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events[0].type).toBe("RUN_STARTED");
  });
});

// --------------------------------------------------------------------------- //
// JSON Patch
// --------------------------------------------------------------------------- //
describe("applyPatch", () => {
  const state = () => ({
    dashboard: { id: "generated", title: "", panels: [{ id: "p1", title: "One" }] },
    params: { hub: "hub-east" },
  });

  it("returns the state untouched when there is nothing to apply", () => {
    const before = state();
    expect(applyPatch(before, [])).toBe(before);
    expect(applyPatch(before, null)).toBe(before);
  });

  it("never mutates what it was given", () => {
    const before = state();
    const after = applyPatch(before, [{ op: "replace", path: "/dashboard/title", value: "Prod" }]);
    expect(before.dashboard.title).toBe("");
    expect(after.dashboard.title).toBe("Prod");
  });

  it("keeps the identity of every node the patch did not touch", () => {
    const before = state();
    const after = applyPatch(before, [{ op: "replace", path: "/params/hub", value: "hub-west" }]);
    expect(after.dashboard).toBe(before.dashboard);
    expect(after.params).not.toBe(before.params);
  });

  it("adds a key that was not there, and so does a replace onto a missing key", () => {
    const after = applyPatch(state(), [
      { op: "add", path: "/dashboard/description", value: "Production review" },
      { op: "replace", path: "/dashboard/variables", value: [] },
    ]);
    expect(after.dashboard.description).toBe("Production review");
    expect(after.dashboard.variables).toEqual([]);
  });

  it("removes a key and refuses to remove one that is not there", () => {
    expect(applyPatch(state(), [{ op: "remove", path: "/params/hub" }]).params).toEqual({});
    expect(() => applyPatch(state(), [{ op: "remove", path: "/params/region" }]))
      .toThrow('cannot remove "/params/region": there is no "region"');
  });

  it("appends to an array with the - token, which is how a panel arrives", () => {
    const after = applyPatch(state(),
      [{ op: "add", path: "/dashboard/panels/-", value: { id: "p2", title: "Two" } }]);
    expect(after.dashboard.panels.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("inserts at an index, replaces at an index and removes an index", () => {
    const base = { panels: ["a", "b", "c"] };
    expect(applyPatch(base, [{ op: "add", path: "/panels/1", value: "x" }]).panels)
      .toEqual(["a", "x", "b", "c"]);
    expect(applyPatch(base, [{ op: "replace", path: "/panels/1", value: "x" }]).panels)
      .toEqual(["a", "x", "c"]);
    expect(applyPatch(base, [{ op: "remove", path: "/panels/1" }]).panels).toEqual(["a", "c"]);
  });

  it("descends into an array element on the way to a field", () => {
    const after = applyPatch(state(),
      [{ op: "replace", path: "/dashboard/panels/0/title", value: "Renamed" }]);
    expect(after.dashboard.panels[0].title).toBe("Renamed");
  });

  it("refuses an array index that is not a number or does not exist", () => {
    expect(() => applyPatch(state(), [{ op: "replace", path: "/dashboard/panels/first", value: 1 }]))
      .toThrow('"first" is not an array index');
    expect(() => applyPatch(state(), [{ op: "replace", path: "/dashboard/panels/9", value: 1 }]))
      .toThrow("there is no item 9");
    expect(() => applyPatch(state(), [{ op: "add", path: "/dashboard/panels/9", value: 1 }]))
      .toThrow("there is no item 9");
    expect(() => applyPatch(state(), [{ op: "replace", path: "/dashboard/panels/9/title", value: 1 }]))
      .toThrow("there is no item 9");
  });

  it("refuses to descend into a key that is not there", () => {
    expect(() => applyPatch(state(), [{ op: "replace", path: "/layout/rows", value: 2 }]))
      .toThrow('there is no "layout" to descend into');
  });

  it("refuses a path that runs through a value rather than a container", () => {
    expect(() => applyPatch(state(), [{ op: "replace", path: "/params/hub/region", value: "x" }]))
      .toThrow("the path runs through a value, not a container");
  });

  it("unescapes ~1 as a slash and ~0 as a tilde, so an odd key is still reachable", () => {
    const before = { labels: { "app.kubernetes.io/part-of": "checkout", "a~b": 1 } };
    const after = applyPatch(before, [
      { op: "replace", path: "/labels/app.kubernetes.io~1part-of", value: "payments" },
      { op: "replace", path: "/labels/a~0b", value: 2 },
    ]);
    expect(after.labels["app.kubernetes.io/part-of"]).toBe("payments");
    expect(after.labels["a~b"]).toBe(2);
  });

  it("replaces the whole document for an empty pointer, and refuses to remove it", () => {
    expect(applyPatch(state(), [{ op: "replace", path: "", value: { fresh: true } }]))
      .toEqual({ fresh: true });
    expect(() => applyPatch(state(), [{ op: "remove", path: "" }]))
      .toThrow("cannot remove the whole state");
  });

  it("refuses a pointer that is not one, and an op it does not implement", () => {
    expect(() => applyPatch(state(), [{ op: "replace", path: "dashboard", value: 1 }]))
      .toThrow('"dashboard" is not a JSON pointer');
    expect(() => applyPatch(state(), [{ op: "move", path: "/a", from: "/b" }]))
      .toThrow('unsupported patch op "move"');
    expect(() => applyPatch(state(), ["not an op"]))
      .toThrow("a patch op must be an object");
  });

  it("applies several ops in order, each onto the result of the last", () => {
    const after = applyPatch(state(), [
      { op: "add", path: "/dashboard/panels/-", value: { id: "p2", title: "Two" } },
      { op: "replace", path: "/dashboard/panels/1/title", value: "Second" },
      { op: "remove", path: "/dashboard/panels/0" },
    ]);
    expect(after.dashboard.panels).toEqual([{ id: "p2", title: "Second" }]);
  });
});

describe("newId", () => {
  it("mints an id that is unique within the tab and carries its prefix", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newId("panel")));
    expect(ids.size).toBe(50);
    expect([...ids][0]).toMatch(/^panel_/);
    expect(newId()).toMatch(/^id_/);
  });
});
