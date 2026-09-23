import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import useAgentRun from "./useAgentRun";
import type { ActivityItem, TranscriptItem } from "./useAgentRun";
import type { AgentEvent } from "./client";

// The wire is scripted; everything else - the patch, the ids, the transcript,
// the persistence - is the real thing.
vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal()),
  runAgent: vi.fn(),
}));

const { runAgent } = await import("./client");
const runAgentMock = vi.mocked(runAgent);

// The transcript is a discriminated union, and these two are how a test says
// which arm it is looking at. They narrow rather than assert: a `find` whose
// predicate is `i.kind === "activity"` still answers the whole union, which is
// how a test ends up quietly reading `.status` off a note and passing.

/** The first entry of a kind, as that kind. */
function firstOfKind<K extends TranscriptItem["kind"]>(
  transcript: readonly TranscriptItem[], kind: K,
): Extract<TranscriptItem, { kind: K }> | undefined {
  return transcript.find((i): i is Extract<TranscriptItem, { kind: K }> => i.kind === kind);
}

/** The entry at `index`, when it is an activity. Throws when it is not, which
 * is a clearer failure than reading `undefined.status`. */
function activityAt(transcript: readonly TranscriptItem[], index: number): ActivityItem {
  const item = transcript[index];
  if (!item || item.kind !== "activity") {
    throw new Error(`transcript[${index}] is ${item ? item.kind : "missing"}, not an activity`);
  }
  return item;
}

/** What a tool call answered with, as the record the agent sends. */
const resultOf = (item: ActivityItem) => item.result as Record<string, unknown>;

// Play a list of events as one run, then resolve the way a finished stream does.
function script(events: AgentEvent[],
  { fail = null, hang = false }: { fail?: Error | null; hang?: boolean } = {}) {
  runAgentMock.mockImplementation(async ({ onEvent, signal }) => {
    for (const event of events) {
      if (signal?.aborted) return;
      onEvent(event);
    }
    if (hang) await new Promise((resolve) => { signal?.addEventListener("abort", resolve); });
    if (fail) throw fail;
  });
}

const PANEL = { id: "clusters-on-hub", title: "Clusters on {{hub}}", sql: "SELECT 1", w: 6, h: 2 };

const SNAPSHOT = {
  type: "STATE_SNAPSHOT",
  snapshot: { dashboard: { id: "generated", title: "", description: "", variables: [], panels: [] },
    params: {} },
};

const ADD_PANEL = [
  { type: "TOOL_CALL_START", toolCallId: "tc1", toolCallName: "add_panel" },
  { type: "TOOL_CALL_ARGS", toolCallId: "tc1", delta: '{"title":"Clusters on ' },
  { type: "TOOL_CALL_ARGS", toolCallId: "tc1", delta: '{{hub}}","w":6}' },
  { type: "TOOL_CALL_END", toolCallId: "tc1" },
  { type: "STATE_DELTA", delta: [{ op: "add", path: "/dashboard/panels/-", value: PANEL }] },
  { type: "TOOL_CALL_RESULT", toolCallId: "tc1",
    content: JSON.stringify({ row_count: 4, columns: ["name", "overall_status"] }) },
];

beforeEach(() => { runAgentMock.mockReset(); });

const run = (options?: { fixture?: boolean }) => renderHook(() => useAgentRun(options));

describe("a first run", () => {
  it("starts empty, with a thread of its own and nothing said yet", () => {
    const { result } = run();
    expect(result.current.threadId).toMatch(/^thread_/);
    expect(result.current.messages).toEqual([]);
    expect(result.current.transcript).toEqual([]);
    expect(result.current.state.dashboard.id).toBe("generated");
    expect(result.current.running).toBe(false);
  });

  it("puts what the user asked into the thread and into the transcript", async () => {
    script([SNAPSHOT]);
    const { result } = run();
    await act(async () => { result.current.send("  Review production  "); });
    expect(result.current.messages).toEqual([
      { id: expect.stringMatching(/^msg_/), role: "user", content: "Review production" },
    ]);
    expect(result.current.transcript[0]).toMatchObject({ kind: "user", text: "Review production" });
    expect(runAgentMock.mock.calls[0][0].messages).toHaveLength(1);
  });

  it("ignores an empty question", async () => {
    const { result } = run();
    await act(async () => { result.current.send("   "); });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("refuses a second question while a run is still going", async () => {
    script([SNAPSHOT], { hang: true });
    const { result } = run();
    act(() => { result.current.send("first"); });
    await waitFor(() => expect(result.current.running).toBe(true));
    act(() => { result.current.send("second"); });
    expect(runAgent).toHaveBeenCalledTimes(1);
    act(() => { result.current.stop(); });
    await waitFor(() => expect(result.current.running).toBe(false));
  });
});

describe("the events", () => {
  it("replaces the state wholesale on a snapshot", async () => {
    script([{ type: "STATE_SNAPSHOT",
      snapshot: { dashboard: { id: "generated", title: "Prod", panels: [PANEL] }, params: { hub: "hub-east" } } }]);
    const { result } = run();
    await act(async () => { result.current.send("Review production"); });
    expect(result.current.state.dashboard.title).toBe("Prod");
    expect(result.current.state.params).toEqual({ hub: "hub-east" });
  });

  it("falls back to an empty dashboard when a snapshot arrives without one", async () => {
    script([{ type: "STATE_SNAPSHOT" }]);
    const { result } = run();
    await act(async () => { result.current.send("go"); });
    expect(result.current.state.dashboard.panels).toEqual([]);
  });

  it("applies a delta onto the state the snapshot set up", async () => {
    script([SNAPSHOT, ...ADD_PANEL]);
    const { result } = run();
    await act(async () => { result.current.send("Review production"); });
    expect(result.current.state.dashboard.panels).toEqual([PANEL]);
  });

  it("keeps the conversation when a delta does not fit the state it lands on", async () => {
    script([SNAPSHOT,
      { type: "STATE_DELTA", delta: [{ op: "remove", path: "/dashboard/nothing" }] }]);
    const { result } = run();
    await act(async () => { result.current.send("go"); });
    const note = firstOfKind(result.current.transcript, "note");
    expect(note?.text).toContain("A change could not be applied");
    expect(note?.tone).toBe("error");
  });

  it("assembles a streamed message from its deltas", async () => {
    script([
      { type: "TEXT_MESSAGE_START", messageId: "m1" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "I will start" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: " with the clusters." },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1" },
    ]);
    const { result } = run();
    await act(async () => { result.current.send("go"); });
    expect(result.current.transcript[1])
      .toMatchObject({ kind: "text", text: "I will start with the clusters." });
  });

  it("reads the panel's title out of the arguments before they are whole", async () => {
    script([SNAPSHOT, ...ADD_PANEL.slice(0, 2)], { hang: true });
    const { result } = run();
    act(() => { result.current.send("go"); });
    await waitFor(() => {
      const activity = firstOfKind(result.current.transcript, "activity");
      expect(activity?.label).toBe('Adding panel "Clusters on "');
      expect(activity?.status).toBe("streaming");
    });
    act(() => { result.current.stop(); });
    await waitFor(() => expect(result.current.running).toBe(false));
  });

  it("parses the arguments when the call ends and reports the rows it returned", async () => {
    script([SNAPSHOT, ...ADD_PANEL]);
    const { result } = run();
    await act(async () => { result.current.send("go"); });
    const activity = activityAt(result.current.transcript, 1);
    expect(activity.status).toBe("done");
    expect(activity.args).toEqual({ title: "Clusters on {{hub}}", w: 6 });
    expect(activity.label).toBe('Adding panel "Clusters on {{hub}}"');
    expect(resultOf(activity).row_count).toBe(4);
  });

  it("still shows a call whose arguments the model stopped writing mid-way", async () => {
    script([
      { type: "TOOL_CALL_START", toolCallId: "tc1", toolCallName: "update_panel" },
      { type: "TOOL_CALL_ARGS", toolCallId: "tc1", delta: '{"title":"Pod issues' },
      { type: "TOOL_CALL_END", toolCallId: "tc1" },
      { type: "TOOL_CALL_RESULT", toolCallId: "tc1", content: "not json either" },
    ]);
    const { result } = run();
    await act(async () => { result.current.send("go"); });
    const activity = activityAt(result.current.transcript, 1);
    expect(activity.args).toBeNull();
    expect(activity.label).toBe('Updating panel "Pod issues"');
    expect(activity.result).toEqual({ text: "not json either" });
    expect(activity.status).toBe("done");
  });

  it("marks a tool call that answered with an error as failed", async () => {
    script([
      { type: "TOOL_CALL_START", toolCallId: "tc1", toolCallName: "add_panel" },
      { type: "TOOL_CALL_END", toolCallId: "tc1" },
      { type: "TOOL_CALL_RESULT", toolCallId: "tc1",
        content: JSON.stringify({ error: "unknown table 'pods'" }) },
    ]);
    const { result } = run();
    await act(async () => { result.current.send("go"); });
    const failed = activityAt(result.current.transcript, 1);
    expect(failed.status).toBe("error");
    expect(resultOf(failed).error).toBe("unknown table 'pods'");
  });

  it("names each tool call in the words a person would use", async () => {
    script([
      { type: "TOOL_CALL_START", toolCallId: "a", toolCallName: "remove_panel" },
      { type: "TOOL_CALL_START", toolCallId: "b", toolCallName: "add_variable" },
      { type: "TOOL_CALL_ARGS", toolCallId: "b", delta: '{"name":"hub"}' },
      { type: "TOOL_CALL_START", toolCallId: "c", toolCallName: "preview_sql" },
      { type: "TOOL_CALL_START", toolCallId: "d", toolCallName: "set_dashboard" },
      { type: "TOOL_CALL_START", toolCallId: "e", toolCallName: "something_new" },
      { type: "TOOL_CALL_START", toolCallId: "f", toolCallName: "add_panel" },
    ]);
    const { result } = run();
    await act(async () => { result.current.send("go"); });
    expect(result.current.transcript.map((_, i) => (i === 0 ? null : activityAt(result.current.transcript, i).label)).slice(1)).toEqual([
      "Removing panel", 'Adding variable "hub"', "Previewing a query",
      "Setting the title", "something_new", "Adding panel",
    ]);
  });

  it("replaces the thread wholesale on a messages snapshot", async () => {
    script([{ type: "MESSAGES_SNAPSHOT",
      messages: [{ id: "m1", role: "user", content: "go" },
        { id: "m2", role: "assistant", content: "done" }] }]);
    const { result } = run();
    await act(async () => { result.current.send("go"); });
    expect(result.current.messages).toHaveLength(2);
  });

  it("keeps the thread it has when a messages snapshot carries no list", async () => {
    script([{ type: "MESSAGES_SNAPSHOT", messages: null }]);
    const { result } = run();
    await act(async () => { result.current.send("go"); });
    expect(result.current.messages).toHaveLength(1);
  });

  it("surfaces a run error as both an error and a note, and keeps the run finished", async () => {
    script([{ type: "RUN_ERROR", message: "the model refused", code: "model_error" }]);
    const { result } = run();
    await act(async () => { result.current.send("go"); });
    expect(result.current.error?.message).toBe("the model refused");
    expect(result.current.error?.code).toBe("model_error");
    expect(result.current.transcript.at(-1)).toMatchObject({ kind: "note", tone: "error" });
    expect(result.current.running).toBe(false);
  });

  it("reports what the finished run cost", async () => {
    script([{ type: "RUN_FINISHED", result: { turns: 3, tool_calls: 5, elapsed_ms: 18400 } }]);
    const { result } = run();
    await act(async () => { result.current.send("go"); });
    expect(result.current.result).toEqual({ turns: 3, tool_calls: 5, elapsed_ms: 18400 });
  });

  it("passes over the events that only say when things happened", async () => {
    script([{ type: "STEP_STARTED" }, { type: "STEP_FINISHED" }, { type: "RUN_STARTED" }]);
    const { result } = run();
    await act(async () => { result.current.send("go"); });
    expect(result.current.transcript).toHaveLength(1);
  });
});

describe("stopping and failing", () => {
  it("closes a tool call that was still open when the run was stopped", async () => {
    script([SNAPSHOT, ...ADD_PANEL.slice(0, 2)], { hang: true });
    const { result } = run();
    act(() => { result.current.send("go"); });
    await waitFor(() => expect(result.current.running).toBe(true));
    act(() => { result.current.stop(); });
    await waitFor(() => expect(result.current.running).toBe(false));
    const activity = firstOfKind(result.current.transcript, "activity");
    expect(activity?.status).toBe("error");
    expect(activity && resultOf(activity).error)
      .toBe("The run stopped before this finished.");
    expect(result.current.transcript.at(-1)).toMatchObject({ text: "Stopped.", tone: "muted" });
  });

  it("reports a broken stream as an error and a note", async () => {
    script([SNAPSHOT], { fail: new Error("network error") });
    const { result } = run();
    await act(async () => { result.current.send("go"); });
    expect(result.current.error?.message).toBe("network error");
    expect(result.current.transcript.at(-1))
      .toMatchObject({ kind: "note", text: "network error" });
  });

  it("treats a rejection named AbortError as a stop rather than a failure", async () => {
    script([SNAPSHOT], { fail: Object.assign(new Error("aborted"), { name: "AbortError" }) });
    const { result } = run();
    await act(async () => { result.current.send("go"); });
    expect(result.current.error).toBeNull();
    expect(result.current.transcript.at(-1)).toMatchObject({ text: "Stopped." });
  });
});

describe("what the person changes", () => {
  it("sets and clears a variable's value in the state the agent is sent next", async () => {
    const { result } = run();
    act(() => { result.current.setParam("hub", "hub-east"); });
    expect(result.current.state.params).toEqual({ hub: "hub-east" });
    act(() => { result.current.setParam("hub", ""); });
    expect(result.current.state.params).toEqual({});
  });

  it("retitles the dashboard without touching anything else", async () => {
    script([SNAPSHOT, ...ADD_PANEL]);
    const { result } = run();
    await act(async () => { result.current.send("go"); });
    act(() => { result.current.patchDashboard({ title: "Production review" }); });
    expect(result.current.state.dashboard.title).toBe("Production review");
    expect(result.current.state.dashboard.panels).toEqual([PANEL]);
  });
});

describe("persistence", () => {
  it("comes back to the same conversation after a reload", async () => {
    script([SNAPSHOT, ...ADD_PANEL]);
    const first = run();
    await act(async () => { first.result.current.send("Review production"); });
    const threadId = first.result.current.threadId;
    first.unmount();

    const second = run();
    expect(second.result.current.threadId).toBe(threadId);
    expect(second.result.current.state.dashboard.panels).toEqual([PANEL]);
    expect(second.result.current.messages).toHaveLength(1);
  });

  it("does not restore a scripted conversation onto the live page", async () => {
    script([SNAPSHOT]);
    const fixtureRun = run({ fixture: true });
    await act(async () => { fixtureRun.result.current.send("go"); });
    const threadId = fixtureRun.result.current.threadId;
    fixtureRun.unmount();
    expect(run().result.current.threadId).not.toBe(threadId);
  });

  it("does not bring a run that a reload killed back spinning", async () => {
    script([SNAPSHOT, ...ADD_PANEL.slice(0, 2)], { hang: true });
    const first = run();
    act(() => { first.result.current.send("go"); });
    await waitFor(() => expect(first.result.current.transcript).toHaveLength(2));
    first.unmount();

    const second = run();
    const activity = firstOfKind(second.result.current.transcript, "activity");
    expect(activity?.status).toBe("error");
    expect(second.result.current.running).toBe(false);
  });

  it("keeps only the conversation that is on screen", async () => {
    script([SNAPSHOT]);
    const first = run();
    await act(async () => { first.result.current.send("one"); });
    act(() => { first.result.current.reset(); });
    await act(async () => { first.result.current.send("two"); });
    const saved = Object.keys(window.sessionStorage).filter((k) => k.startsWith("odl.generate."));
    expect(saved).toHaveLength(2);      // the live thread plus the "last" pointer
  });

  it("reset forgets the conversation and starts a fresh thread", async () => {
    script([SNAPSHOT, ...ADD_PANEL]);
    const { result } = run();
    await act(async () => { result.current.send("go"); });
    const threadId = result.current.threadId;
    act(() => { result.current.reset(); });
    expect(result.current.threadId).not.toBe(threadId);
    expect(result.current.transcript).toEqual([]);
    expect(result.current.state.dashboard.panels).toEqual([]);
    expect(window.sessionStorage.getItem(`odl.generate.${threadId}`)).toBeNull();
  });

  it("starts fresh when what was stored is not a conversation", () => {
    window.sessionStorage.setItem("odl.generate.last", "thread_x");
    window.sessionStorage.setItem("odl.generate.thread_x", "{ not json");
    expect(run().result.current.transcript).toEqual([]);
  });

  it("starts fresh when the stored thread is not the one that was last open", () => {
    window.sessionStorage.setItem("odl.generate.last", "thread_x");
    window.sessionStorage.setItem("odl.generate.thread_x",
      JSON.stringify({ threadId: "thread_y", transcript: [{ kind: "user", id: "u", text: "hi" }] }));
    expect(run().result.current.transcript).toEqual([]);
  });
});
