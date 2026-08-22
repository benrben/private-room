/**
 * Room MCP bridge — the room's agent tools, served over loopback.
 *
 * Ported from `src-tauri/src/room_mcp.rs` (module doc lines 1-38; transport
 * lines 605-850). Every engine — the local Python agent hub included —
 * reaches the room's files through THIS bridge; `claude -p` on its own is a
 * one-shot text pipe with no abilities at all. A token-guarded, loopback-only
 * MCP endpoint (streamable HTTP, JSON-RPC) executing one tool dispatch for
 * all of them — decryption stays inside the host process; only tool RESULTS
 * cross the boundary, exactly like chat content already does.
 *
 * Lifetime = one `ask`: started right before the client spawns, stopped when
 * it returns. A fresh bearer token per run; requests without it are rejected.
 *
 * `sidecar/arcelle_sidecar/mcp_client.py` is the real, unmodified client this
 * module must satisfy byte-for-byte on the wire —
 * `sidecar/tests/test_mcp_bridge_wire_compat.py` runs the two against each
 * other over a real socket. That client's own docstring states the two
 * protocol details that bite:
 *
 * - A JSON-RPC request with no `id` is a NOTIFICATION: the bridge answers
 *   `202 Accepted` with an EMPTY body — literally zero bytes, not `{}` and
 *   not `null`. `McpClient.notify()` deliberately never calls `.json()` on
 *   it; sending a JSON body there would still "work" today and quietly
 *   become load-bearing tomorrow.
 * - A tool FAILURE is not a JSON-RPC error. It comes back as a normal result
 *   with `isError: true` — deliberately, so the model can see the failure and
 *   react to it. Only protocol-level failures (unknown method, bad auth,
 *   unparseable body) are JSON-RPC errors / HTTP error statuses.
 *
 * =====================================================================
 * EXPLICITLY OUT OF SCOPE for this batch (a later one owns each, once the
 * Rust command surface it depends on is itself ported):
 * =====================================================================
 * - The real tool catalog (`served_tools`/`scoped_specs`/`builtin_mcp_tools`/
 *   `mcp_proxy_tools`/`searchable_mcp_tools`/`search_mcp_entries`/
 *   `to_mcp_tool`/`arcelle_tool_annotations`) — depends on `exec_tool`'s
 *   whole command surface.
 * - `tool_call`'s dispatch body past the transport layer
 *   (`consult_advisor`/`search_mcp_tools`/`run_mcp_tool`/the real `exec_tool`
 *   call and its cloud-redaction wrapping) — same reason.
 * - The `Bridge`/`start`/`prepare_advisor_runtime` process-lifecycle wiring
 *   against a real `AppState` and a real room — there is no ported room/DB
 *   layer to wire it to yet.
 *
 * THE SEAM for all of the above is {@link ToolDispatcher}: two methods,
 * `listTools`/`callTool`, that a later batch implements for real. Every case
 * except the already-cancelled-run refusal and the
 * notification/initialize/ping short-circuits goes through it.
 *
 * `ToolScope` (the security-tier union) IS ported in full: it is small,
 * load-bearing for that interface, and a settled decision.
 *
 * ## Node's `http` instead of Rust's hand-rolled `TcpStream` framing
 *
 * `serve_conn`/`read_framed_request` parse HTTP/1.1 by hand because Rust had
 * no dependency doing it. Node does, so this uses it — but every
 * security-load-bearing behaviour of the hand-rolled version is preserved and
 * tested here, because Node's `http` module has NO body-size limit of its own
 * (`maxHeaderSize` caps only the head) and would otherwise buffer a declared
 * 100 GB body into memory happily:
 *
 * - A declared `Content-Length` over {@link MAX_REQUEST_BODY} is refused with
 *   413 BEFORE a single `data` listener is attached, so the body stream is
 *   never even asked to deliver bytes.
 * - The ACTUAL bytes received are independently capped as they arrive, so a
 *   lying `Content-Length` — or a chunked flood with none at all — cannot
 *   grow the buffer past the cap either.
 * - The refusal is delivered AND the connection is then severed, in that
 *   order. See {@link McpBridge.refuseOversize} for why that ordering needs
 *   care in Node specifically.
 */

import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
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
 * `mcp_client.py`'s `_parse_tool_result` recognizes. */
export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string };

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
function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

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

/** How long a refused connection is drained with NO inbound progress before
 * it is destroyed, and the hard ceiling on that draining however much
 * progress the peer keeps making. See {@link McpBridge.refuseOversize}:
 * together they are long enough for a refused peer to finish pushing and read
 * its 413, and short enough that one that never stops cannot hold the
 * descriptor. Draining buffers nothing, so neither budget weakens the cap. */
const OVERSIZE_LINGER_IDLE_MS = 500;
const OVERSIZE_LINGER_MAX_MS = 10_000;

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

/** Why {@link readCappedBody} gave up. */
type BodyRead =
  | { ok: true; body: Buffer }
  | { ok: false; reason: "oversize" }
  | { ok: false; reason: "aborted" };

/**
 * Read a request body, refusing the moment the ACTUAL byte count crosses
 * `cap` — even if `Content-Length` under-declared it or was absent entirely
 * (chunked transfer). The declared-length check that runs before this is the
 * primary guard, since it costs the peer nothing to be refused instantly;
 * this is the backstop for a peer that lied, and is what makes the cap a
 * memory guarantee rather than an honour system.
 */
function readCappedBody(req: IncomingMessage, cap: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (result: BodyRead): void => {
      if (settled) {
        return;
      }
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onAborted);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > cap) {
        // Drop what we have rather than hand it on: nothing downstream is
        // allowed to see a body this size, so keeping it alive to the end of
        // the turn would defeat the point of refusing it.
        chunks.length = 0;
        finish({ ok: false, reason: "oversize" });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish({ ok: true, body: Buffer.concat(chunks) });
    const onError = (): void => finish({ ok: false, reason: "aborted" });
    const onAborted = (): void => finish({ ok: false, reason: "aborted" });

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
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

const EMPTY_JSON_OBJECT = Buffer.from("{}", "utf8");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { status: 400, body: EMPTY_JSON_OBJECT };
  }
  // Rust reaches this point with a `serde_json::Value` of ANY shape and then
  // asks it for `"id"`; a Value that is not an object answers `None`, which
  // is the notification path. So a body of `null`, `5`, `true` or `[…]` is a
  // 202 there, not a 400, and this must agree — a JSON-RPC batch array is the
  // realistic one of those, and answering 400 where the host answers 202
  // would be a wire difference nothing else would catch.
  const request: Record<string, unknown> = isRecord(parsed) ? parsed : {};

  // Presence of the "id" KEY decides notification-vs-request, matching
  // `req.get("id")` returning `None` only when the key is absent. An explicit
  // `"id": null` is still a REQUEST. `mcp_client.py`'s `notify()` omits the
  // key entirely, and its `_rpc()` always sends one.
  if (!Object.prototype.hasOwnProperty.call(request, "id")) {
    // Notifications (e.g. notifications/initialized) need no body — and get
    // literally zero bytes, not `{}`. `McpClient.notify()` never parses it.
    return { status: 202, body: Buffer.alloc(0) };
  }
  const id = request.id;
  const method = typeof request.method === "string" ? request.method : "";
  const params = isRecord(request.params) ? request.params : {};

  let outcome: { ok: true; value: unknown } | { ok: false; message: string };
  switch (method) {
    case "initialize": {
      const protocolVersion =
        typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION;
      outcome = {
        ok: true,
        value: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "arcelle", version: serverVersion },
        },
      };
      break;
    }
    case "ping":
      outcome = { ok: true, value: {} };
      break;
    case "tools/list":
      // Handed through unchanged — see ToolSpec's doc on `annotations`.
      outcome = { ok: true, value: { tools: dispatcher.listTools(scope) } };
      break;
    case "tools/call": {
      // Stop lands BEFORE the side effect, not after it. Everything else this
      // bridge answers (initialize / ping / tools/list) stays served even on
      // a cancelled run: refusing tools/list would report an EMPTY CATALOG,
      // which the Main agent surfaces as "the room tool bridge served 0
      // tools" — turning a clean user Stop into what looks like a wiring
      // failure. Only the call that would actually write is refused, and it
      // is refused as a NORMAL successful result so the model sees a
      // tool-shaped failure it can react to. TS `switch` has no Rust-style
      // match guard, so this branches inside the case rather than as a second
      // arm.
      if (cancelFlag?.load() === true) {
        outcome = {
          ok: true,
          value: {
            content: [{ type: "text", text: STOPPED_REFUSAL_TEXT }],
            isError: true,
          } satisfies ToolCallResult,
        };
        break;
      }
      const name = typeof params.name === "string" ? params.name : "";
      const args = isRecord(params.arguments) ? params.arguments : {};
      outcome = { ok: true, value: await dispatcher.callTool(scope, name, args) };
      break;
    }
    default:
      outcome = { ok: false, message: `method not found: ${method}` };
  }

  const reply = outcome.ok
    ? { jsonrpc: "2.0", id, result: outcome.value }
    : { jsonrpc: "2.0", id, error: { code: -32601, message: outcome.message } };
  return { status: 200, body: Buffer.from(JSON.stringify(reply), "utf8") };
}

// ------------------------------------------------------------- the HTTP server

/** Constructor options for {@link McpBridge}. */
export interface McpBridgeOptions {
  /** The bearer token this bridge accepts for its whole lifetime. */
  token: string;
  scope: ToolScope;
  dispatcher: ToolDispatcher;
  /**
   * The run's cancel flag, for a per-ask bridge — `node.flag()` straight off
   * `cancel.ts`. `undefined` for a persistent/nested bridge, which has no ask
   * behind it, matching Rust's `run_cancel: None`.
   */
  cancelFlag?: CancelFlagLike;
  /**
   * What `serverInfo.version` reports. Rust reads `env!("CARGO_PKG_VERSION")`
   * at compile time; there is no ported app-version wiring yet, so a later
   * batch passes `app.getVersion()` here the same way `obs.init` already
   * takes its version as an argument rather than inventing one.
   */
  serverVersion?: string;
}

/**
 * Bind loopback and serve MCP until {@link McpBridge.stop}. Behavioural port
 * (not literal code shape) of `serve_conn` + `dispatch_jsonrpc`
 * (room_mcp.rs lines 605-850). Every observable behaviour of the hand-rolled
 * version holds:
 *
 * - POST only; anything else gets 405 (a GET — the optional SSE channel — is
 *   not implemented).
 * - A missing/wrong bearer gets 401.
 * - A body over {@link MAX_REQUEST_BODY} gets 413 and the connection is
 *   severed — whether the peer over-DECLARED it or lied and pushed the bytes.
 * - A notification (no `id`) gets 202 with a zero-byte body.
 * - {@link stop} severs every live connection immediately, INCLUDING one
 *   whose response is mid-flight when the stop lands: that response is
 *   revoked, never delivered.
 */
export class McpBridge {
  private readonly server: Server;
  private readonly serverVersion: string;
  private stopped = false;

  constructor(private readonly opts: McpBridgeOptions) {
    this.serverVersion = opts.serverVersion ?? "0.0.0";
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
  }

  /** The bound port, once {@link listen} has resolved. */
  get port(): number | null {
    const address = this.server.address();
    return address === null || typeof address === "string" ? null : address.port;
  }

  /** The loopback URL an MCP client POSTs JSON-RPC to. */
  get url(): string {
    const port = this.port;
    if (port === null) {
      throw new Error("McpBridge is not listening yet");
    }
    return `http://127.0.0.1:${port}/mcp`;
  }

  /** Start listening on loopback. Pass `0` (the default) for an ephemeral
   * port; resolves with the port actually bound. */
  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.server.once("error", onError);
      this.server.listen(port, "127.0.0.1", () => {
        this.server.removeListener("error", onError);
        const bound = this.port;
        if (bound === null) {
          reject(new Error("mcp bridge bind failed: no address"));
          return;
        }
        resolve(bound);
      });
    });
  }

  /**
   * Stop accepting new connections AND sever every live one immediately —
   * MCP clients hold keep-alive connections, and a stopped or tier-downgraded
   * bridge must not keep serving them with the captured scope and token
   * (Rust's bridge-wide `shutdown` watch channel, which every `serve_conn`
   * selects on with `biased`).
   *
   * Always waits for the server to be fully closed: a fire-and-forget stop
   * races EADDRINUSE on an immediate rebind of the same fixed port.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    // Without this, close() would wait forever for a client's long-lived
    // keep-alive connection to end on its own.
    this.server.closeAllConnections();
    await closed;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Refused on the DECLARATION, before a single body byte is buffered —
      // and before auth, exactly as the Rust source refuses an oversize frame
      // before it looks at the token.
      const declared = declaredBodySize(req.headers["content-length"]);
      if (declared !== null && declared > MAX_REQUEST_BODY) {
        this.refuseOversize(req, res);
        return;
      }

      if (!authorize(headerValue(req.headers, "authorization"), this.opts.token)) {
        this.write(res, 401, EMPTY_JSON_OBJECT);
        return;
      }

      if (req.method !== "POST") {
        this.write(res, 405, EMPTY_JSON_OBJECT);
        return;
      }

      const read = await readCappedBody(req, MAX_REQUEST_BODY);
      if (!read.ok) {
        if (read.reason === "oversize") {
          this.refuseOversize(req, res);
        } else {
          // A truncated or aborted body: the framing is no longer
          // trustworthy, so — like `serve_conn`'s `?` propagation on a read
          // error — the connection simply ends with no response.
          req.socket.destroy();
        }
        return;
      }

      const { status, body } = await dispatchJsonRpc(
        read.body,
        this.opts.scope,
        this.opts.dispatcher,
        this.opts.cancelFlag,
        this.serverVersion
      );

      // A stop that arrived while the dispatch ran revokes the response too:
      // a tier downgrade or token rotation must not hand a result back on the
      // old scope. The dispatch's side effects have already happened — this
      // severs DELIVERY, the strongest guarantee available post-read
      // (room_mcp.rs lines 647-653). Deliberately not applied to the
      // 401/405/413 short-circuits, which are decided before any dispatch and
      // are written unconditionally in the Rust source too.
      if (this.stopped) {
        req.socket.destroy();
        return;
      }

      this.write(res, status, body);
    } catch {
      // A later batch's real dispatcher throwing must not take the main
      // process with it. Rust has no 500 because `tool_call` returns a
      // `Result`; here an unexpected throw is the same class of event and
      // gets the same treatment a failed tool does — an answer, not a crash.
      if (!res.headersSent) {
        try {
          this.write(res, 500, EMPTY_JSON_OBJECT);
        } catch {
          // The socket may already be gone.
        }
      }
    }
  }

  private write(res: ServerResponse, status: number, body: Buffer): void {
    if (res.writableEnded) {
      return;
    }
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": String(body.length),
    });
    res.end(body);
  }

  /**
   * Refuse an oversized request with 413 and then sever the connection —
   * "the framing is only trustworthy up to the head, so there is no safe way
   * to skip past a body we refused to read" (room_mcp.rs lines 630-636).
   *
   * Both halves need care in Node, and getting either wrong is SILENT: the
   * status code alone looks right in all three of the wrong versions below.
   *
   * - Severing via `res.socket.destroy()` on the response's `finish` event
   *   does NOTHING AT ALL. Node detaches the socket from the response before
   *   emitting `finish`, so `res.socket` is already `null` and the optional
   *   chain swallows it. The connection then lingers open, still framing a
   *   declared 16 MiB body that will never arrive — the same exhaustion
   *   posture the cap exists to close, moved from memory to descriptors.
   *   `req.socket` is the real socket and stays valid.
   * - Destroying that socket while the peer is still uploading sends an RST,
   *   and an RST DISCARDS the peer's unread receive buffer — including the
   *   413 just written into it. The peer sees ECONNRESET and never learns
   *   why it was refused.
   * - Sending `Connection: close` makes Node's own `resOnFinish` call
   *   `socket.destroySoon()` as soon as the write flushes, which reintroduces
   *   exactly that RST. The header is therefore deliberately NOT set; this
   *   method owns the close.
   *
   * So: a lingering close, the same shape nginx's `lingering_close` uses.
   * After writing the refusal, keep reading the peer's remaining bytes and
   * THROW THEM AWAY — the chunks go to a listener that does nothing with
   * them, so nothing is buffered and the cap still holds however long the
   * peer keeps pushing. That is what stops an RST from wiping out the 413,
   * and it matters because the real client writes its WHOLE body before it
   * reads a single byte of the reply: a bridge that severs on write never
   * tells anyone why it refused them.
   *
   * The connection is then severed only when that drain did NOT finish —
   * because the peer went quiet mid-body ({@link OVERSIZE_LINGER_IDLE_MS}) or
   * kept pushing past the ceiling ({@link OVERSIZE_LINGER_MAX_MS}). That is
   * precisely the condition the Rust comment is protecting against: "the
   * framing is only trustworthy up to the head, so there is no safe way to
   * skip past a body we refused to read". A drain that reached the end of the
   * body HAS skipped past it safely — the next request on that connection is
   * correctly framed — so severing there would buy nothing and would instead
   * hand the client a dead pooled connection to trip over on its very next
   * call. Both timers are `unref`'d so neither can hold the process open.
   *
   * ORDERING, and it is load-bearing rather than cosmetic: the drain is armed
   * BEFORE the refusal is written. Node registers its own `resOnFinish` as a
   * `finish` listener when the request ARRIVES — ahead of anything
   * `res.end(…, cb)` could add — and, for a request nothing has read yet, that
   * handler calls `req._dump()`. `_dump()` sets `_dumped`, which makes the
   * parser DROP body chunks instead of pushing them, and removes every `data`
   * listener. A drain attached from the `end` callback therefore never
   * receives a single chunk on the declared-oversize path, {@link armIdle} is
   * never re-armed, and the connection is severed 500 ms after the refusal
   * however hard the peer is still pushing — reintroducing exactly the RST
   * that discards the 413 this method exists to deliver. Touching the request
   * first marks it as being consumed, so `_dump()` is skipped and the chunks
   * reach `discard`. (The lying-Content-Length path never had the problem:
   * {@link readCappedBody} had already attached a `data` listener, so Node
   * skipped `_dump()` there — which is why the two paths silently disagreed.)
   */
  private refuseOversize(req: IncomingMessage, res: ServerResponse): void {
    if (res.writableEnded) {
      return;
    }
    this.drainRefusedBody(req);
    res.writeHead(413, {
      "content-type": "application/json",
      "content-length": String(EMPTY_JSON_OBJECT.length),
    });
    res.end(EMPTY_JSON_OBJECT);
  }

  /** The lingering drain itself — see {@link refuseOversize}, including why
   * this runs before the response rather than after it. */
  private drainRefusedBody(req: IncomingMessage): void {
    // Nothing left to skip past: the body already ended, so the framing is
    // intact and arming an idle timer would sever a healthy connection.
    if (req.readableEnded) {
      return;
    }
    const socket = req.socket;
    let idle: NodeJS.Timeout | undefined;
    const stopDraining = (): void => {
      clearTimeout(hard);
      clearTimeout(idle);
      req.removeListener("data", discard);
      req.removeListener("end", drained);
    };
    /** The drain never finished: the framing is broken, so the connection
     * cannot be handed back to Node's keep-alive. */
    const sever = (): void => {
      stopDraining();
      socket.destroy();
    };
    const armIdle = (): void => {
      clearTimeout(idle);
      idle = setTimeout(sever, OVERSIZE_LINGER_IDLE_MS);
      idle.unref();
    };
    /** Received and dropped on the floor: nothing holds a reference to the
     * chunk, so this costs no memory however much the peer sends. */
    const discard = (): void => armIdle();
    /** The whole refused body went past: framing is intact again, so the
     * connection is left to Node's ordinary keep-alive handling. */
    const drained = (): void => stopDraining();
    const hard = setTimeout(sever, OVERSIZE_LINGER_MAX_MS);
    hard.unref();
    req.on("data", discard);
    req.once("end", drained);
    armIdle();
    req.resume();
  }
}
