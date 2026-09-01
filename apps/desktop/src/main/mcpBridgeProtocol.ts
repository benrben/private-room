/** JSON-RPC protocol and authorization rules for the room MCP bridge. */

import { timingSafeEqual } from "node:crypto";
// --------------------------------------------------------------- ToolScope

/**
 * Which tools this bridge advertises — the trust boundary between a cloud
 * client, the local engine, and a user-configured external agent. See
 * `room_mcp.rs`'s module doc (lines 15-38) for each tier's full rationale;
 * the short version:
 *
 * - `CloudAdvisor` — a CLOUD CLI *consulted* mid-turn (`claude -p` as an
 *   advisor), or the Leash's default "files" tier. Built-in file tools only;
 *   `includeMcp` additionally advertises the room's connected MCP servers
 *   when that advisor's own sub-option is on. NEVER the UI/job tools, and a
 *   consulted advisor never receives an advisor runtime, which is what closes
 *   the recursion path.
 * - `CloudEngine` (owner decision 2026-07-25) — a cloud CLI selected as the
 *   ROOM'S OWN engine. Engine parity with the local engine; the one remaining
 *   gap is the screen (never `ui_act`/`ui_snapshot`/`view_screenshot`).
 * - `LocalEngine` — the LOCAL Python agent engine, the most trusted tier.
 * - `ExternalAgent` — an external agent the user explicitly opted in per room
 *   (the Leash's full tier). Never the UI-driving tools, never
 *   `consult_advisor`.
 *
 * A discriminated union rather than Rust's enum-with-payload — the idiomatic
 * TS shape for the same thing, discriminated on `kind` to match this
 * workspace's existing unions in `shared/apiTypes.ts`.
 *
 * THE SCOPE IS THE SECURITY BOUNDARY: do not widen the cloud scope.
 */
export type ToolScope =
  | { readonly kind: "CloudAdvisor"; readonly includeMcp: boolean }
  | { readonly kind: "CloudEngine" }
  | { readonly kind: "LocalEngine" }
  | { readonly kind: "ExternalAgent" };

/**
 * Does this scope advertise the room's connected MCP servers? Ported from
 * `ToolScope::include_mcp`. Every tier except a plain (non-MCP)
 * `CloudAdvisor` does.
 *
 * The other scope-gated catalog decisions (`include_ui_tools`,
 * `include_job_tools`, …) all read the real tool catalog, which is out of
 * scope for this batch — this one is ported now because
 * {@link ToolDispatcher} is declared in terms of the scope and a later batch
 * needs the tier question already answered in one place.
 */
export function includeMcp(scope: ToolScope): boolean {
  switch (scope.kind) {
    case "CloudAdvisor":
      return scope.includeMcp;
    case "CloudEngine":
    case "LocalEngine":
    case "ExternalAgent":
      return true;
  }
}

// -------------------------------------------------- ToolDispatcher (the seam)

/**
 * One tool as served by `tools/list` — the wire shape `mcp_client.py`'s
 * `list_tools()` parses (`name` / `description` / `inputSchema`).
 *
 * `annotations` is declared but never touched here: `arcelle_tool_annotations`
 * attaches it in the Rust source, and this module hands whatever the
 * dispatcher returns straight to `JSON.stringify` rather than rebuilding each
 * spec field by field — a `.map()` that copies only the three known keys
 * would silently drop annotations the moment the real catalog lands.
 */
export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** One content block of a `tools/call` result — exactly the two shapes
 * `mcp_client.py`'s `_parse_tool_result` recognizes.
 *
 * `mimeType` is optional here and ignored by `_parse_tool_result`, but the
 * Rust `tool_result` always emits `"image/png"` on an image block and the MCP
 * spec (`2024-11-05`) REQUIRES it — this bridge also serves `claude -p` and
 * `codex exec`, which do read it. Declared so `bridgeDispatcher.ts` can emit a
 * spec-correct block without an assertion; see its `toolResult`. */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType?: string };

/** One `tools/call` outcome — the ENTIRE wire shape nested under JSON-RPC's
 * `result` for a real tool call. `isError: true` is not a protocol failure; it
 * is how a tool reports its OWN failure to the model. */
export interface ToolCallResult {
  isError: boolean;
  content: ToolContent[];
}

/**
 * THE SEAM: what a later batch supplies once `exec_tool`'s command surface is
 * ported. This bridge calls exactly these two methods for every real
 * `tools/list` / `tools/call`.
 */
export interface ToolDispatcher {
  listTools(scope: ToolScope): ToolSpec[];
  callTool(scope: ToolScope, name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

/**
 * A run's cancellation flag, read-only from this module's point of view.
 * Structurally exactly `cancel.ts`'s `CancelFlag`, so `bridge.cancelFlag =
 * node.flag()` composes with no glue — but declared as a shape rather than a
 * hard import, so this file stays usable (and testable) without pulling in
 * the whole cancel tree. The direct analogue of Rust's
 * `run_cancel: Option<&Arc<AtomicBool>>`.
 */
export interface CancelFlagLike {
  load(): boolean;
}

// ------------------------------------------------------------ authorize / ctEq

/**
 * Length-independent byte equality for the bearer-token compare, ported from
 * `ct_eq` (room_mcp.rs lines 743-752). The full-tier token is long-lived
 * (persisted across restarts), so a short-circuiting `===` would hand a local
 * prober a timing oracle it never had against the old per-run tokens.
 *
 * Node's `crypto.timingSafeEqual` REFUSES mismatched-length buffers — it
 * throws rather than compare — so both inputs are first copied into
 * equal-length zero-padded buffers, mirroring `ct_eq`'s own
 * `a.get(i).unwrap_or(&0)` treatment of a missing byte. The lengths are then
 * compared separately, in full.
 *
 * That last word is deliberate, and is the ONE place this knowingly diverges
 * from the Rust source rather than reproducing it. `ct_eq` seeds its
 * accumulator with `(a.len() ^ b.len()) as u8` — a u8 TRUNCATION, so any
 * length difference that is a multiple of 256 folds to zero, and the byte
 * loop then compares the shorter input against zero padding. A value that is
 * the real token followed by exactly 256 NUL bytes therefore satisfies both
 * halves and authenticates. (Not reachable through Node's own HTTP parser
 * today — llhttp rejects NUL inside a header value with a 400 before this
 * function is ever called — but `ctEq` is an exported primitive, the padding
 * length is attacker-chosen, and "safe only because of what a different
 * layer happens to reject" is not a property to inherit on purpose.) A full
 * length compare is an integer compare, not a content compare, so it leaks
 * nothing about WHICH byte differed and adds no timing signal of its own.
 */
export function ctEq(a: Buffer, b: Buffer): boolean {
  // `max(..., 1)` only so the zero-length/zero-length case has a buffer to
  // hand `timingSafeEqual`; two 1-byte zero buffers compare equal, which is
  // the same answer `ct_eq(b"", b"")` gives.
  const n = Math.max(a.length, b.length, 1);
  const paddedA = Buffer.alloc(n);
  const paddedB = Buffer.alloc(n);
  a.copy(paddedA);
  b.copy(paddedB);
  const contentEqual = timingSafeEqual(paddedA, paddedB);
  return contentEqual && a.length === b.length;
}

/**
 * One header value, collapsing Node's repeated-header array form.
 *
 * FIRST occurrence wins, deliberately, and that is what a repeated
 * `Authorization` header gets here — not a rejection. Node's parser already
 * decided this for us: `authorization` is one of the fields it treats as
 * unique, so a second one is DROPPED at parse time and `req.headers`
 * never holds an array for it. Taking `[0]` is what keeps this function
 * agreeing with the parser above it AND with `header_value` in the Rust source
 * (`head.lines().find_map(…)` — also the first match), rather than inventing a
 * third answer at a security boundary. The array branch is therefore
 * defence for a non-Node caller, not a path a real request reaches.
 */
/**
 * The request carries the run's bearer token, or it is rejected. Ported from
 * `authorize` (room_mcp.rs lines 734-739), including the `.trim()` of the
 * header value.
 */
export function authorize(authorizationHeader: string | undefined, token: string): boolean {
  if (authorizationHeader === undefined) {
    return false;
  }
  return ctEq(
    Buffer.from(authorizationHeader.trim(), "utf8"),
    Buffer.from(`Bearer ${token}`, "utf8")
  );
}

// ---------------------------------------------------------- request body cap

/**
 * Ceiling on ONE JSON-RPC request body, in bytes. Ported from
 * `MAX_REQUEST_BODY` (room_mcp.rs lines 667-679).
 *
 * The bearer token is only checked on the parsed head, so anything already
 * running on this Mac could open the loopback port, declare a 100 GB body and
 * push bytes into memory until the app died without ever knowing the token.
 * The cap runs BEFORE the first body byte is read, so a declared-huge request
 * costs nothing.
 *
 * 16 MiB is far above any real call: the largest thing that legitimately
 * arrives here is a tool call carrying a base64 image, and the sidecar's own
 * result caps sit well below this.
 */
export const MAX_REQUEST_BODY = 16 * 1024 * 1024;

/**
 * The DECLARED body size, or `null` when the peer declared nothing parseable.
 *
 * Compared as a decimal string rather than through `Number`, because a
 * declaration is attacker-chosen: `Number("9".repeat(30))` is finite but not
 * a safe integer, and a check that bailed out to "unknown" there would send
 * the single most obviously-hostile declaration down the streaming path
 * instead of refusing it instantly. Digit count first, then a plain numeric
 * compare only once the value is known to be small enough to be exact.
 */
export function declaredBodySize(header: string | string[] | undefined): number | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const digits = trimmed.replace(/^0+(?=\d)/, "");
  // 16 digits cannot be confused by float rounding at this cap, and anything
  // longer is astronomically over it regardless of its exact value.
  if (digits.length > 16) {
    return Number.POSITIVE_INFINITY;
  }
  return Number(digits);
}

// --------------------------------------------------------- dispatch_jsonrpc

/** What one JSON-RPC dispatch produced: an HTTP status and the exact response
 * bytes to write. */
export interface DispatchResult {
  status: number;
  body: Buffer;
}

/** The synthesized refusal `tools/call` returns for an already-cancelled run
 * — byte-identical to the Rust string (room_mcp.rs line 818), em dash
 * included. Exported so a test asserts against the constant rather than a
 * copy of it that could drift. */
export const STOPPED_REFUSAL_TEXT = "Stopped by the user — this tool was not run.";

/** The MCP revision this bridge speaks when the client names none. Matches
 * `mcp_client.py`'s `PROTOCOL_VERSION`. */
export const PROTOCOL_VERSION = "2024-11-05";

export const EMPTY_JSON_OBJECT = Buffer.from("{}", "utf8");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type RpcOutcome = { ok: true; value: unknown } | { ok: false; message: string };

function jsonRequest(body: Buffer): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return undefined;
  }
}

function hasRequestId(request: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(request, "id");
}

function requestMethod(request: Record<string, unknown>): string {
  return typeof request.method === "string" ? request.method : "";
}

function requestParams(request: Record<string, unknown>): Record<string, unknown> {
  return isRecord(request.params) ? request.params : {};
}

function initializeOutcome(params: Record<string, unknown>, serverVersion: string): RpcOutcome {
  const protocolVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION;
  return {
    ok: true,
    value: {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "arcelle", version: serverVersion },
    },
  };
}

function stoppedToolCallResult(): ToolCallResult {
  return {
    content: [{ type: "text", text: STOPPED_REFUSAL_TEXT }],
    isError: true,
  };
}

async function toolCallOutcome(
  params: Record<string, unknown>,
  scope: ToolScope,
  dispatcher: ToolDispatcher,
  cancelFlag: CancelFlagLike | undefined
): Promise<RpcOutcome> {
  if (cancelFlag?.load() === true) {
    return { ok: true, value: stoppedToolCallResult() };
  }
  const name = typeof params.name === "string" ? params.name : "";
  const args = isRecord(params.arguments) ? params.arguments : {};
  return { ok: true, value: await dispatcher.callTool(scope, name, args) };
}

async function methodOutcome(
  method: string,
  params: Record<string, unknown>,
  scope: ToolScope,
  dispatcher: ToolDispatcher,
  cancelFlag: CancelFlagLike | undefined,
  serverVersion: string
): Promise<RpcOutcome> {
  switch (method) {
    case "initialize":
      return initializeOutcome(params, serverVersion);
    case "ping":
      return { ok: true, value: {} };
    case "tools/list":
      // Handed through unchanged — see ToolSpec's doc on `annotations`.
      return { ok: true, value: { tools: dispatcher.listTools(scope) } };
    case "tools/call":
      return toolCallOutcome(params, scope, dispatcher, cancelFlag);
    default:
      return { ok: false, message: `method not found: ${method}` };
  }
}

function jsonRpcReply(id: unknown, outcome: RpcOutcome): DispatchResult {
  const reply = outcome.ok
    ? { jsonrpc: "2.0", id, result: outcome.value }
    : { jsonrpc: "2.0", id, error: { code: -32601, message: outcome.message } };
  return { status: 200, body: Buffer.from(JSON.stringify(reply), "utf8") };
}

/**
 * Dispatch one already-framed JSON-RPC request body, returning (HTTP status,
 * body). Ported from `dispatch_jsonrpc` (room_mcp.rs lines 756-850) minus the
 * excluded parts. Pure aside from `dispatcher.callTool` — no socket, no auth —
 * so the JSON-RPC layer is unit-testable independently of the HTTP one.
 */
export async function dispatchJsonRpc(
  body: Buffer,
  scope: ToolScope,
  dispatcher: ToolDispatcher,
  cancelFlag: CancelFlagLike | undefined,
  serverVersion: string
): Promise<DispatchResult> {
  const request = jsonRequest(body);
  if (request === undefined) {
    return { status: 400, body: EMPTY_JSON_OBJECT };
  }
  // Rust reaches this point with a `serde_json::Value` of ANY shape and then
  // asks it for `"id"`; a Value that is not an object answers `None`, which
  // is the notification path. So a body of `null`, `5`, `true` or `[…]` is a
  // 202 there, not a 400, and this must agree — a JSON-RPC batch array is the
  // realistic one of those, and answering 400 where the host answers 202
  // would be a wire difference nothing else would catch.
  // Presence of the "id" KEY decides notification-vs-request, matching
  // `req.get("id")` returning `None` only when the key is absent. An explicit
  // `"id": null` is still a REQUEST. `mcp_client.py`'s `notify()` omits the
  // key entirely, and its `_rpc()` always sends one.
  if (!hasRequestId(request)) {
    // Notifications (e.g. notifications/initialized) need no body — and get
    // literally zero bytes, not `{}`. `McpClient.notify()` never parses it.
    return { status: 202, body: Buffer.alloc(0) };
  }
  const outcome = await methodOutcome(
    requestMethod(request),
    requestParams(request),
    scope,
    dispatcher,
    cancelFlag,
    serverVersion
  );
  return jsonRpcReply(request.id, outcome);
}
