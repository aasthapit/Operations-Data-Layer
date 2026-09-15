// One conversation with the dashboard agent: what has been said, what the
// agent did about it, and the state those actions built.
//
// The hook owns four things and hands them out together:
//
//   messages    the AG-UI thread, replaced wholesale by MESSAGES_SNAPSHOT - the
//               server keeps no session, so this is the conversation
//   state       {dashboard, params}, the snapshot with every STATE_DELTA applied
//   transcript  the render model: what to draw, in the order it happened
//   result      what the last run cost (turns, tool calls, wall clock)
//
// `messages` and `transcript` are deliberately not the same list. One is the
// protocol's record of the conversation and goes back on the wire; the other is
// what a person reads, where a tool call is "Adding panel ..." with a spinner on
// it rather than a function call with a JSON string in it.
//
// The whole lot is written to sessionStorage after every change, so a reload or
// a trip to another tab and back comes back to the same conversation.
import { useCallback, useEffect, useRef, useState } from "react";
import { hasValue } from "../dashboards/model";
import { applyPatch, newId, runAgent } from "./client";

const PREFIX = "odl.generate.";
const LAST = `${PREFIX}last`;

// --------------------------------------------------------------------------- //
// labels
// --------------------------------------------------------------------------- //
// A tool call's arguments arrive as partial JSON that cannot be parsed until it
// ends. The title is written early, though, and it is the one thing worth
// showing while the rest arrives - it is what the placeholder card on the grid
// is called. So it is read out of the fragment with a regex, which is honest
// about what it is: a peek, not a parse.
const PARTIAL_TITLE = /"title"\s*:\s*"((?:[^"\\]|\\.)*)/;
const PARTIAL_NAME = /"name"\s*:\s*"((?:[^"\\]|\\.)*)/;

function peek(text, re) {
  const m = re.exec(text || "");
  if (!m) return "";
  try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
}

function labelFor(name, title, varName) {
  switch (name) {
    case "add_panel": return title ? `Adding panel "${title}"` : "Adding panel";
    case "update_panel": return title ? `Updating panel "${title}"` : "Updating panel";
    case "remove_panel": return "Removing panel";
    case "add_variable": return varName ? `Adding variable "${varName}"` : "Adding variable";
    case "preview_sql": return "Previewing a query";
    case "set_dashboard": return "Setting the title";
    default: return name || "Working";
  }
}

// An activity item carries both the raw fragment and whatever could be made of
// it, so the view never has to know how far the arguments have got.
function describe(item) {
  const title = item.args?.title || peek(item.argsText, PARTIAL_TITLE);
  const varName = item.args?.name || peek(item.argsText, PARTIAL_NAME);
  return { ...item, title, label: labelFor(item.name, title, varName) };
}

// --------------------------------------------------------------------------- //
// the transcript
// --------------------------------------------------------------------------- //
const emptyState = () => ({
  dashboard: { id: "generated", title: "", description: "", variables: [], panels: [] },
  params: {},
});

const fresh = (fixture) => ({
  threadId: newId("thread"),
  fixture: !!fixture,
  messages: [],
  state: emptyState(),
  transcript: [],
});

const withItem = (session, item) => ({ ...session, transcript: [...session.transcript, item] });

const note = (session, text, tone = "error") =>
  withItem(session, { kind: "note", id: newId("note"), tone, text });

// Replace one transcript entry, found by its id, with fn(entry).
function amend(session, id, fn) {
  let touched = false;
  const transcript = session.transcript.map((item) => {
    if (item.id !== id) return item;
    touched = true;
    return fn(item);
  });
  return touched ? { ...session, transcript } : session;
}

// Every event, in one place. It only ever returns a new session - what a run
// costs and whether it failed are the caller's business, not the transcript's.
function reduce(session, event) {
  switch (event.type) {
    case "STATE_SNAPSHOT":
      return { ...session, state: event.snapshot || emptyState() };

    case "STATE_DELTA":
      try {
        return { ...session, state: applyPatch(session.state, event.delta) };
      } catch (e) {
        // A patch that does not fit the state is the server's bug, but the
        // conversation is still worth keeping: say so and carry on.
        return note(session, `A change could not be applied: ${e.message}`);
      }

    case "TEXT_MESSAGE_START":
      return withItem(session, { kind: "text", id: event.messageId, text: "" });

    case "TEXT_MESSAGE_CONTENT":
      return amend(session, event.messageId, (item) => ({ ...item, text: item.text + (event.delta || "") }));

    case "TOOL_CALL_START":
      return withItem(session, describe({
        kind: "activity",
        id: event.toolCallId,
        toolCallId: event.toolCallId,
        name: event.toolCallName,
        argsText: "",
        args: null,
        status: "streaming",
        result: null,
      }));

    case "TOOL_CALL_ARGS":
      return amend(session, event.toolCallId,
        (item) => describe({ ...item, argsText: item.argsText + (event.delta || "") }));

    case "TOOL_CALL_END":
      return amend(session, event.toolCallId, (item) => {
        // Partial JSON is only JSON once it is whole, and a model that stopped
        // mid-argument is a thing that happens: the call still shows, with
        // whatever the fragment said its title was.
        let args = null;
        try { args = JSON.parse(item.argsText); } catch { /* keep the fragment */ }
        return describe({ ...item, args, status: "running" });
      });

    case "TOOL_CALL_RESULT": {
      let content = null;
      try { content = JSON.parse(event.content); } catch { content = { text: String(event.content ?? "") }; }
      const failed = !!(content && typeof content === "object" && content.error);
      return amend(session, event.toolCallId,
        (item) => describe({ ...item, status: failed ? "error" : "done", result: content }));
    }

    case "MESSAGES_SNAPSHOT":
      return { ...session, messages: Array.isArray(event.messages) ? event.messages : session.messages };

    case "RUN_ERROR":
      return note(session, event.message || "The run failed.");

    default:
      // RUN_STARTED, RUN_FINISHED and the STEP_* pair say when things happened
      // rather than what changed, and the view shows that from `running`.
      return session;
  }
}

// A run that ended with tool calls still open (stopped, or a stream that broke)
// must not leave a spinner turning for ever.
function finalize(session, reason) {
  const transcript = session.transcript.map((item) => {
    if (item.kind !== "activity" || (item.status !== "streaming" && item.status !== "running")) return item;
    return { ...item, status: "error", result: { error: "The run stopped before this finished." } };
  });
  const next = { ...session, transcript };
  return reason === "stopped" ? note(next, "Stopped.", "muted") : next;
}

// --------------------------------------------------------------------------- //
// where it is kept between renders of the page
// --------------------------------------------------------------------------- //
// sessionStorage, not localStorage: a conversation belongs to the tab it is
// happening in, and it should not outlive the window. Every access is guarded -
// a browser with storage turned off loses the history, not the page.
function restore(fixture) {
  try {
    const id = sessionStorage.getItem(LAST);
    if (!id) return null;
    const saved = JSON.parse(sessionStorage.getItem(PREFIX + id) || "null");
    if (!saved || saved.threadId !== id) return null;
    // A scripted conversation restored onto the live page (or the other way
    // round) would be a lie about where those panels came from.
    if (!!saved.fixture !== !!fixture) return null;
    // A reload during a run kills the stream with the page: what was in flight
    // when it went is not in flight now, and must not come back spinning.
    return finalize({ ...fresh(fixture), ...saved }, "");
  } catch {
    return null;
  }
}

function persist(session) {
  try {
    sessionStorage.setItem(PREFIX + session.threadId, JSON.stringify(session));
    sessionStorage.setItem(LAST, session.threadId);
    // Only the conversation that is on screen is ever restored, so the ones
    // before it are dead weight - and a tab that is reloaded a hundred times
    // should not fill its storage quota with them.
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(PREFIX) && key !== LAST && key !== PREFIX + session.threadId) {
        sessionStorage.removeItem(key);
      }
    }
  } catch { /* full, private mode, or storage disabled: the page still works */ }
}

function forget(threadId) {
  try {
    sessionStorage.removeItem(PREFIX + threadId);
    sessionStorage.removeItem(LAST);
  } catch { /* nothing to do */ }
}

// --------------------------------------------------------------------------- //
// the hook
// --------------------------------------------------------------------------- //
export default function useAgentRun({ fixture = false } = {}) {
  const [session, setSession] = useState(() => restore(fixture) || fresh(fixture));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  // Events arrive faster than React re-renders, and a run reads the session it
  // is about to send: both need the live value, not the rendered one.
  const ref = useRef(session);
  ref.current = session;
  const abort = useRef(null);
  const busy = useRef(false);

  useEffect(() => { persist(session); }, [session]);
  useEffect(() => () => abort.current?.abort(), []);

  const update = useCallback((fn) => {
    ref.current = fn(ref.current);
    setSession(ref.current);
  }, []);

  const start = useCallback((from) => {
    const controller = new AbortController();
    abort.current = controller;
    busy.current = true;
    setRunning(true);
    setError(null);
    setResult(null);

    const done = (reason) => {
      if (abort.current !== controller) return;   // a newer run already owns the view
      abort.current = null;
      busy.current = false;
      setRunning(false);
      update((s) => finalize(s, reason));
    };

    runAgent({
      threadId: from.threadId,
      runId: newId("run"),
      messages: from.messages,
      state: from.state,
      signal: controller.signal,
      fixture,
      onEvent: (event) => {
        if (event.type === "RUN_ERROR") {
          const e = new Error(event.message || "The run failed.");
          e.code = event.code;
          setError(e);
        }
        if (event.type === "RUN_FINISHED") setResult(event.result || null);
        update((s) => reduce(s, event));
      },
    }).then(
      // A stream that was aborted can end either way: the real one rejects
      // with an AbortError, the fixture simply stops yielding. The controller
      // is the thing that knows which happened.
      () => done(controller.signal.aborted ? "stopped" : ""),
      (e) => {
        if (controller.signal.aborted || e?.name === "AbortError") { done("stopped"); return; }
        setError(e);
        update((s) => note(s, String(e?.message || e)));
        done("failed");
      },
    );
  }, [fixture, update]);

  const send = useCallback((raw) => {
    const text = String(raw || "").trim();
    if (!text || busy.current) return;
    const message = { id: newId("msg"), role: "user", content: text };
    const next = {
      ...ref.current,
      messages: [...ref.current.messages, message],
      transcript: [...ref.current.transcript, { kind: "user", id: message.id, text }],
    };
    ref.current = next;
    setSession(next);
    start(next);
  }, [start]);

  const stop = useCallback(() => { abort.current?.abort(); }, []);

  const reset = useCallback(() => {
    abort.current?.abort();
    forget(ref.current.threadId);
    ref.current = fresh(fixture);
    setSession(ref.current);
    setError(null);
    setResult(null);
  }, [fixture]);

  // The two ways the person, rather than the agent, changes the state: picking a
  // variable's value and retitling the dashboard. Both go into the state that is
  // sent back on the next turn, so the agent sees what the user did.
  const setParam = useCallback((name, value) => update((s) => {
    const params = { ...s.state.params };
    if (hasValue(value)) params[name] = value;
    else delete params[name];
    return { ...s, state: { ...s.state, params } };
  }), [update]);

  const patchDashboard = useCallback((fields) => update((s) => ({
    ...s,
    state: { ...s.state, dashboard: { ...s.state.dashboard, ...fields } },
  })), [update]);

  return {
    threadId: session.threadId,
    messages: session.messages,
    state: session.state,
    transcript: session.transcript,
    running,
    error,
    result,
    send,
    stop,
    reset,
    setParam,
    patchDashboard,
  };
}
