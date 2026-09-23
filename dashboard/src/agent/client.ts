// The wire: POST /api/agent/run, an AG-UI event stream, and the JSON Patch that
// stream carries.
//
// Three things live here and nothing else, because everything above this file
// should be able to think in events rather than in bytes:
//
//   runAgent    one run - send the thread, read the stream, hand each event to
//               the caller as it lands
//   applyPatch  RFC 6902 add/replace/remove against the shared state
//   newId       the ids the client mints (a thread, a run, a user message)
//
// The API holds no session: the browser owns the thread and sends the whole of
// it every time, so a reload or a second tab is not a special case.
import { BASE } from "../api";
import type { ApiError } from "../api";
import { fixtureRun } from "./fixture";

// --------------------------------------------------------------------------- //
// the protocol
// --------------------------------------------------------------------------- //

/** One AG-UI event. The type is the discriminator and the rest of the fields
 * depend on it (docs/nl-query.md, "The event stream"), so this stays an open
 * record: `useAgentRun` is the one place that reads the per-type fields, and it
 * is written to survive a field that is not there. */
export interface AgentEvent {
  type: string;
  [field: string]: unknown;
}

/** One message of the thread, as AG-UI writes it (camelCase on the wire). */
export interface AgentMessage {
  id: string;
  role: string;
  content?: string | null;
  toolCallId?: string | null;
  [field: string]: unknown;
}

/** `{dashboard, params}` - the shared state the deltas apply to. The dashboard
 * inside it is the same definition shape the dashboards API stores. */
export interface AgentState {
  dashboard: Record<string, unknown>;
  params: Record<string, unknown>;
}

/** One RFC 6902 operation, of the three the agent emits. */
export interface PatchOp {
  op: string;
  path: string;
  value?: unknown;
}

/** The AG-UI RunAgentInput that goes on the wire (docs/nl-query.md). The API
 * holds no session, so the whole thread goes on every turn. */
export interface RunAgentBody {
  threadId: string;
  runId: string;
  parentRunId: string | null;
  state: AgentState | Record<string, unknown>;
  messages: AgentMessage[];
  tools: unknown[];
  context: unknown[];
  forwardedProps: Record<string, unknown>;
}

/** What `runAgent` is called with: the body's fields, plus how to reach the
 * caller and how to stop. */
export interface RunAgentInput {
  messages: AgentMessage[];
  /** Posted back verbatim; nothing here reads inside it. `AgentState` is the
   * shape the Generate view holds, and a caller with only part of one (a test,
   * a first turn) is not this file's problem. */
  state: AgentState | Record<string, unknown>;
  threadId: string;
  runId: string;
  parentRunId?: string | null;
  signal?: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  /** Run the scripted conversation instead of the API. */
  fixture?: boolean;
}

// --------------------------------------------------------------------------- //
// ids
// --------------------------------------------------------------------------- //
let seq = 0;

// Unique within this tab, which is all an id on this thread has to be: the
// server echoes ours back and mints its own for the messages it makes.
export function newId(prefix = "id"): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

// --------------------------------------------------------------------------- //
// JSON Patch (RFC 6902, the three operations the agent emits)
// --------------------------------------------------------------------------- //
const unescape = (token: string) => token.replace(/~1/g, "/").replace(/~0/g, "~");

function parsePointer(path: unknown): string[] {
  if (path === "" || path == null) return [];
  const text = String(path);
  if (!text.startsWith("/")) throw new Error(`"${text}" is not a JSON pointer`);
  return text.slice(1).split("/").map(unescape);
}

// Applied to a copy along the path only: every node that did not change keeps
// its identity, so React re-renders the panel that moved and not the grid.
// why: a patch walks an arbitrary JSON document, so the node under the pointer
// is an array, an object or a leaf, and which one is exactly what the branches
// below decide. `never` is the return of `bad`, which always throws.
function applyOp(node: any, tokens: string[], op: string, value: unknown, path: string): any {
  const bad = (why: string): never => { throw new Error(`cannot ${op} "${path}": ${why}`); };
  const [token, ...rest] = tokens;

  if (Array.isArray(node)) {
    // "-" is the end of the array: /dashboard/panels/- is "append a panel".
    const append = token === "-";
    const index = append ? node.length : Number(token);
    if (!append && !/^\d+$/.test(token)) bad(`"${token}" is not an array index`);
    if (rest.length) {
      if (index >= node.length) bad(`there is no item ${index}`);
      const next = [...node];
      next[index] = applyOp(node[index], rest, op, value, path);
      return next;
    }
    const next = [...node];
    if (op === "add") {
      if (index > node.length) bad(`there is no item ${index}`);
      next.splice(index, 0, value);
    } else if (index >= node.length) {
      bad(`there is no item ${index}`);
    } else if (op === "remove") {
      next.splice(index, 1);
    } else {
      next[index] = value;
    }
    return next;
  }

  if (node && typeof node === "object") {
    if (rest.length) {
      if (!(token in node)) bad(`there is no "${token}" to descend into`);
      return { ...node, [token]: applyOp(node[token], rest, op, value, path) };
    }
    if (op === "remove") {
      if (!(token in node)) bad(`there is no "${token}"`);
      const next = { ...node };
      delete next[token];
      return next;
    }
    // A replace onto a key that is not there yet is taken as an add. The
    // difference is a fact about the sender's bookkeeping, not about what the
    // user asked for, and losing a panel over it would be the worse answer.
    return { ...node, [token]: value };
  }

  return bad("the path runs through a value, not a container");
}

// applyPatch(state, ops) -> a new state. Never mutates what it was given, and
// throws rather than guessing when an op does not fit the shape it lands on.
// `ops` is what a STATE_DELTA carried, so it is checked rather than trusted:
// an entry that is not an operation, or an operation this build does not
// implement, throws instead of being skipped.
export function applyPatch<T>(state: T, ops: readonly unknown[] | null | undefined): T {
  // why: the running value is `T` at the top and an arbitrary JSON node one
  // pointer segment in, which is `applyOp`'s business rather than this loop's.
  // It leaves here as `T` again, because an op that did not fit threw.
  let next: any = state;
  for (const raw of ops || []) {
    if (!raw || typeof raw !== "object") throw new Error("a patch op must be an object");
    const op = raw as PatchOp;
    const kind = op.op;
    if (kind !== "add" && kind !== "replace" && kind !== "remove") {
      throw new Error(`unsupported patch op "${kind}"`);
    }
    const tokens = parsePointer(op.path);
    // An empty pointer is the whole document, so the state itself is replaced.
    if (!tokens.length) {
      if (kind === "remove") throw new Error('cannot remove the whole state');
      next = op.value;
      continue;
    }
    next = applyOp(next, tokens, kind, op.value, String(op.path));
  }
  return next;
}

// --------------------------------------------------------------------------- //
// the stream
// --------------------------------------------------------------------------- //
// Server-sent events, by the book: a frame is terminated by a blank line, a
// frame's data is its "data:" lines joined with newlines, and everything else
// (comments, event:, id:, retry:) is not ours to interpret. A frame can be split
// across chunks and a chunk can hold several frames, so the tail of the buffer
// is kept until its terminator arrives.
function parseFrame(frame: string): AgentEvent | null {
  const data: string[] = [];
  let name = "";
  for (const raw of frame.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") name = value;
  }
  if (!data.length) return null;
  try {
    const event = JSON.parse(data.join("\n")) as AgentEvent;
    if (!event || typeof event !== "object") return null;
    // The type rides in the payload; an SSE event: field naming the same thing
    // is accepted as a fallback so a stricter server is also understood.
    if (!event.type && name) event.type = name;
    return event;
  } catch {
    // A frame we cannot parse is the server's problem, not a reason to drop the
    // rest of the run: the console says which one, and the stream carries on.
    console.warn("agent: unparseable event frame", frame);
    return null;
  }
}

async function readStream(res: Response, onEvent: (event: AgentEvent) => void): Promise<void> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.search(/\r?\n\r?\n/);
    while (cut >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + (buffer[cut] === "\r" ? 4 : 2));
      const event = parseFrame(frame);
      if (event) onEvent(event);
      cut = buffer.search(/\r?\n\r?\n/);
    }
  }
  // A stream that ended without its blank line still owes us its last frame.
  buffer += decoder.decode();
  const last = parseFrame(buffer.trim());
  if (last) onEvent(last);
}

// The same error shape the rest of the app throws: the status is carried, so a
// 404 (no such endpoint in this build) can be told from a 503 (no credentials)
// without reading the message.
async function streamError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  let detail: unknown = null;
  try { detail = text ? JSON.parse(text).detail : null; } catch { /* not JSON */ }
  const message = typeof detail === "string" ? detail
    : detail ? JSON.stringify(detail)
      : text || `${res.status} ${res.statusText}`;
  const error: ApiError = new Error(message);
  error.status = res.status;
  error.detail = detail;
  return error;
}

// runAgent({...}) resolves when the stream ends and rejects on a pre-stream
// error or a broken connection. Every event goes to onEvent in arrival order -
// the caller decides what a run means; this only decides what an event is.
export async function runAgent({
  messages, state, threadId, runId, parentRunId = null, signal, onEvent, fixture = false,
}: RunAgentInput): Promise<void> {
  const body: RunAgentBody = {
    threadId,
    runId,
    parentRunId,
    state,
    messages,
    tools: [],
    context: [],
    forwardedProps: {},
  };

  // The fixture is a development aid wired exactly where the real stream is, so
  // everything above this line runs unchanged against it.
  if (fixture) {
    for await (const event of fixtureRun(body, signal)) {
      if (signal?.aborted) return;
      onEvent(event);
    }
    return;
  }

  const res = await fetch(`${BASE}/api/agent/run`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await streamError(res);
  if (!res.body) throw new Error("the agent answered without a stream body");
  await readStream(res, onEvent);
}
