/**
 * The last genuinely-uncovered pieces of `src-tauri/src/room_mcp.rs` (3096
 * lines), after reading that file in full and cross-checking every function
 * and struct in it against the CURRENT contents (not the doc comments, which
 * have gone stale in places) of `mcpBridge.ts`, `bridgeDispatcher.ts` and
 * `moonshotServer.ts`.
 *
 * ============================================================================
 * CONFIRMED ALREADY COVERED — deliberately NOT re-ported here
 * ============================================================================
 * - `authorize`/`ct_eq` (room_mcp.rs 730-752) → `mcpBridge.ts`'s `authorize`/
 *   `ctEq` (lines 223-267), with one documented, deliberate hardening of
 *   `ct_eq`'s `u8`-truncated length seed.
 * - `serve_conn`/`handle_conn`/`read_framed_request`/`write_response`/
 *   `find_head_end`/`header_value`/`FramedRequest`/`OversizeRequest`/
 *   `MAX_REQUEST_BODY` (553-1829) → superseded by `node:http` in
 *   `mcpBridge.ts`'s `McpBridge`, which reproduces every security-load-bearing
 *   behaviour of the hand-rolled framing (declared-size refusal before any
 *   body byte, an independent actual-bytes cap, 413-then-lingering-close,
 *   401/405/202-with-zero-bytes, and a stop that severs live keep-alive
 *   connections AND revokes an in-flight response).
 * - `dispatch_jsonrpc` (756-850) → `mcpBridge.ts`'s `dispatchJsonRpc`, EXCEPT
 *   the two things below that this file supplies.
 * - `ToolScope` and every `include_*` predicate, `label`,
 *   `arcelle_tool_annotations`, `sanitized_tool_annotations`, `to_mcp_tool`,
 *   `mcp_proxy_tools`, `searchable_mcp_tools`/`mcp_search_score`/
 *   `search_mcp_entries`, `builtin_mcp_tools`, `scoped_specs`,
 *   `tier_tool_names`, `room_tool_names_with`, `served_tools_with`,
 *   `tool_cancel_for`, `tool_call`, `nested_run_arguments`, `json_kind`,
 *   `tool_result`, `EffectsSink`, `WebThrottle`/`web_throttled`/
 *   `note_web_throttled`, `AdvisorRuntime` (minus `room_bridge`) →
 *   `bridgeDispatcher.ts`, verbatim.
 * - `Bridge` + `StartOpts` + `start()`'s BINDING half (284-513: fixed-port
 *   retry 5×50 ms, then ephemeral with `stable: false`) →
 *   `moonshotServer.ts`'s `createRoomBridge`/`RunningBridge`, written
 *   generically over any `ToolScope` + any `ToolDispatcher`. REUSED below,
 *   never re-implemented. `StartOpts.cancel` is covered one layer down by
 *   `McpBridgeOptions.cancelFlag`, which `dispatchJsonRpc` already reads for
 *   the post-Stop `tools/call` refusal.
 *
 * ============================================================================
 * WHAT IS GENUINELY NEW HERE — three pieces
 * ============================================================================
 *
 * 1. `log_catalog` (217-230) and the `obs::tool_dispatched` call `tool_call`
 *    makes (line 1725), plus the two `obs.rs` functions under them
 *    (`turn_fields`/`tool_catalog`/`tool_dispatched`, obs.rs ~600-655).
 *    `obs.ts`'s own module doc defers every "instrumented decision" call site
 *    to "ported incrementally alongside the features that use them", and
 *    grepping this migration for `tools.catalog`/`tools.call` outside
 *    `obs.test.ts`'s own generic examples finds nothing — so both were still
 *    missing. {@link withCatalogTelemetry} additionally WIRES the catalog
 *    event at exactly Rust's own call site without editing any existing file
 *    (see its doc for why the per-call event cannot be wired the same way).
 *
 * 2. `dispatch_jsonrpc`'s PER-REQUEST live web-lane intersection (788-795) —
 *    {@link intersectWebLanes}/{@link openRoomWebLanes}/
 *    {@link liveLanesDispatcherOptions}. Neither `mcpBridge.ts` (whose
 *    `dispatchJsonRpc` has no lanes concept at all) nor `bridgeDispatcher.ts`
 *    (whose `RoomToolDispatcherOptions.lanes` is a fixed value captured when
 *    the dispatcher is constructed) reproduces it, and the Rust source's own
 *    comment says exactly what breaks without it: "An external agent (Claude
 *    Code, Codex, Claude Desktop) holds ONE connection for the whole session,
 *    so a bridge that answered `tools/list` at connect time kept serving the
 *    web and browser tools for the rest of it: flipping either switch in
 *    Settings changed nothing until the room was closed, with no hint it had
 *    not taken."
 *
 * 3. `prepare_advisor_runtime` (519-549) — {@link prepareAdvisorRuntime}.
 *    Four already-landed files independently name this as an open gap
 *    (`mcpBridge.ts`'s "EXPLICITLY OUT OF SCOPE" list, `bridgeDispatcher.ts`'s
 *    `AdvisorRuntime` doc, `externalAdvisor.ts`'s module doc, `specialists.ts`'s
 *    module doc). Three of those four claims are now STALE in one respect:
 *    they say there is no ported process-lifecycle `Bridge` to hand a nested
 *    advisor — and `moonshotServer.ts`'s `createRoomBridge`/`RunningBridge`,
 *    which landed later, is one. That was the single missing dependency; this
 *    file supplies the orchestration Rust wraps around it.
 *
 * ============================================================================
 * WHAT IS STILL OPEN, NAMED RATHER THAN FAKED
 * ============================================================================
 * - `start()`'s non-binding half for the room's OWN per-ask bridge — the
 *   `EffectsSink`/`AdvisorRuntime`/`cancel`/`turn`/`tool_ran` assembly
 *   `sidecar.rs` performs immediately before each `ask`. Every INGREDIENT is
 *   ported (`McpBridgeOptions.cancelFlag`, `RoomToolDispatcherOptions`'
 *   `sharedEffects`/`advisor`/`markToolRan`, `createRoomBridge`), but the
 *   assembly belongs to the `ask` orchestration in `sidecar.rs` — a different,
 *   much larger Rust file this migration has not ported. Writing a second
 *   `createRoomBridge` here with a `cancelFlag`/`toolRan` slot and no caller
 *   would be a near-duplicate seam nothing exercises, which this codebase's
 *   review history repeatedly flags; a caller that needs those two today can
 *   construct `new McpBridge({ …, cancelFlag })` directly, which is what
 *   `createRoomBridge` itself does one line down.
 * - `AdvisorRuntime.room_bridge` stays absent from `bridgeDispatcher.ts`'s
 *   class. In Rust, `tool_call` reads that field on every dispatched call and
 *   threads it into `exec_tool`'s `advisor_bridge` parameter; this migration
 *   reaches the identical CLI subprocess through an already-real seam instead
 *   — `execTool.ts`'s `withRealAdvisorCli(deps, { bridge, cancel })` closes
 *   over one fixed `AdvisorBridge` per ask, the same "one nested bridge for
 *   the whole turn" lifetime, wired through a closure rather than a struct
 *   field. So {@link prepareAdvisorRuntime} returns the nested bridge as a
 *   second, independent value — mirroring Rust's own
 *   `(Option<AdvisorRuntime>, Option<Arc<Bridge>>)` — and
 *   {@link adaptRunningBridge} is the one-line adapter onto that seam.
 * - `StartOpts.privacy_bypass` is NOT a parameter of
 *   {@link prepareAdvisorRuntime}. In Rust it rides `StartOpts` into the
 *   nested bridge's own `tool_call` redaction gate; on this port that decision
 *   lives one layer down, on `RoomToolDispatcherOptions.privacyBypass`, which
 *   belongs to whoever builds the nested bridge's dispatcher — see
 *   {@link bridgeStarterFor}, whose `makeDispatcher` callback is exactly that
 *   place. A parameter this function could only accept and drop would be a
 *   fabricated seam. The failure direction if a caller forgets is toward MORE
 *   redaction, not less.
 */

import type Database from "better-sqlite3-multiple-ciphers";

import * as obs from "./obs.js";
import type { Val } from "./obs.js";
import { TurnId } from "./turn.js";
import type { CancelFlagLike, ToolDispatcher, ToolScope, ToolSpec } from "./mcpBridge.js";
import { AdvisorRuntime, scopeLabel, type RoomToolDispatcherOptions } from "./bridgeDispatcher.js";
import {
  createRoomBridge,
  startRoomBridgeNotImplemented,
  webLanesFromSettings,
  type BridgeStarter,
  type RunningBridge,
} from "./moonshotServer.js";
import { WEB_LANES_ALL, type WebLanes } from "./toolSpecs.js";
import type { AdvisorBridge } from "./externalAdvisor.js";

// ============================================================================
// obs: turn_fields / tool_catalog / tool_dispatched / log_catalog
// ============================================================================

/**
 * The run/chat this event belongs to, as leading fields. Ported verbatim from
 * `obs::turn_fields`. A caller with no turn (a headless workflow, a persistent
 * bridge) says so with `"-"`, exactly as Rust's `None` arm does — the envelope
 * still carries both fields, so the log never looks like one was silently
 * omitted.
 */
export function turnFields(
  turn: TurnId | null
): readonly [readonly ["run", Val], readonly ["chat", Val]] {
  if (turn !== null) {
    return [
      ["run", obs.id(turn.runId)],
      ["chat", obs.id(turn.chatId)],
    ] as const;
  }
  return [
    ["run", obs.state("-")],
    ["chat", obs.state("-")],
  ] as const;
}

/**
 * Every value `scopeLabel` (`bridgeDispatcher.ts`) can return —
 * `ToolScope::label`'s closed set, as a whitelist for {@link obs.oneOf}.
 *
 * Rust passes the label to `obs::state`, which is safe there because
 * `ToolScope::label` returns a `&'static str` — a compile-time literal by
 * construction, which is how that module satisfies its privacy boundary
 * ("room content can never reach a field value"). `scopeLabel`'s TS return
 * type is a plain `string`, which `obs.state`'s `Literal<S>` constraint
 * rejects on purpose, so `oneOf` carries it onto this known closed set
 * instead — a value outside it becomes `obs.UNEXPECTED` rather than being
 * trusted verbatim. That is `obs.ts`'s own documented answer for exactly this
 * situation, not a workaround invented here.
 */
export const TOOL_SCOPE_LABELS = [
  "CloudAdvisor+mcp",
  "CloudAdvisor",
  "CloudEngine",
  "LocalEngine",
  "ExternalAgent",
] as const;

/**
 * The narrow slice of `obs.ts` this module logs through, injectable so a test
 * can assert on the exact `(event, fields)` pair — the same
 * `{ X: typeof obs.X }` / `REAL_LOG` shape `studiosCmds.ts`'s `StudioLog` and
 * `recRead.ts`'s `RecReadLog` already establish.
 */
export interface RoomMcpLog {
  info: typeof obs.info;
  debug: typeof obs.debug;
}

const REAL_LOG: RoomMcpLog = obs;

/**
 * The tool catalog one engine was actually served. Ported verbatim from
 * `obs::tool_catalog`. THE event `room_mcp.rs`'s own `log_catalog` doc says it
 * was ordered for: "an engine handed an empty tool bridge does not report 'my
 * bridge is empty' — it rationalises, and the rationalisation becomes the bug
 * report". The count and the names exist here so the model cannot narrate over
 * them.
 */
export function toolCatalog(
  scope: string,
  names: readonly string[],
  turn: TurnId | null,
  log: RoomMcpLog = REAL_LOG
): void {
  const [run, chat] = turnFields(turn);
  log.info("tools.catalog", [
    run,
    chat,
    ["scope", obs.oneOf(scope, TOOL_SCOPE_LABELS)],
    ["served", obs.count(names.length)],
    ["names", obs.ids(names)],
  ]);
}

/**
 * One tool call, at `debug` — the per-call detail turned on for a live
 * investigation and never shipped enabled. Ported verbatim from
 * `obs::tool_dispatched`. The tool's NAME and verdict only: its ARGUMENTS are
 * room content by definition (a filename to open, a passage to write, a query
 * about the user's own documents), so there is no parameter here for them to
 * arrive through.
 *
 * WHERE IT BELONGS, and why this file does not put it there: Rust calls this
 * INSIDE `tool_call`, after `exec_tool` returns and BEFORE the cloud-redaction
 * wrap, with two values only reachable from inside that function —
 * `call.name` (the RESOLVED dispatch name: for a `run_mcp_tool` proxy call
 * that is the connector tool that actually ran, not the string
 * `"run_mcp_tool"`, and the Rust source says so explicitly) and the
 * PRE-redaction `text.len()`. Both live inside
 * `bridgeDispatcher.ts`'s `RoomToolDispatcher.callTool`, past this file's
 * reach without editing it. A `ToolDispatcher` decorator — the trick
 * {@link withCatalogTelemetry} uses for the catalog event, where it is exact —
 * would silently log the REQUESTED name and the POST-redaction size, so it is
 * deliberately not offered: two quiet divergences would be worse than an
 * honest one-line call added at the real site by whichever batch next touches
 * that file.
 */
export function toolDispatched(
  scope: string,
  tool: string,
  isError: boolean,
  resultBytes: number,
  turn: TurnId | null,
  log: RoomMcpLog = REAL_LOG
): void {
  const [run, chat] = turnFields(turn);
  log.debug("tools.call", [
    run,
    chat,
    ["scope", obs.oneOf(scope, TOOL_SCOPE_LABELS)],
    ["tool", obs.id(tool)],
    ["error", obs.flag(isError)],
    ["resultBytes", obs.bytes(resultBytes)],
  ]);
}

/**
 * Record the catalog a bridge is about to advertise. Ported verbatim from
 * `room_mcp.rs`'s own `log_catalog` (217-230) — the thin wrapper `tools/list`
 * calls: the scope's label, and the `name` of every served tool.
 */
export function logCatalog(
  scope: ToolScope,
  tools: readonly ToolSpec[],
  turn: TurnId | null,
  log: RoomMcpLog = REAL_LOG
): void {
  toolCatalog(
    scopeLabel(scope),
    tools.map((t) => t.name),
    turn,
    log
  );
}

/**
 * Wrap a {@link ToolDispatcher} so every `tools/list` it answers is recorded
 * with {@link logCatalog} — Rust's `"tools/list" => { let tools =
 * served_tools(…); log_catalog(scope, &tools, turn); … }`, at the same point,
 * with the same three inputs and no behavioural change of its own.
 *
 * A decorator rather than an edit to `mcpBridge.ts`'s `dispatchJsonRpc`
 * because that function takes no `turn` — and, unlike the per-call event (see
 * {@link toolDispatched}), the catalog event needs NOTHING that is only
 * visible from inside the dispatcher: the scope, the served list and the turn
 * are all in hand here, so the decorator is exact rather than approximate.
 *
 * `callTool` is forwarded untouched.
 */
export function withCatalogTelemetry(
  inner: ToolDispatcher,
  turn: TurnId | null,
  log: RoomMcpLog = REAL_LOG
): ToolDispatcher {
  return {
    listTools(scope: ToolScope): ToolSpec[] {
      const tools = inner.listTools(scope);
      logCatalog(scope, tools, turn, log);
      return tools;
    },
    callTool: (scope, name, args) => inner.callTool(scope, name, args),
  };
}

// ============================================================================
// dispatch_jsonrpc's per-request live web lanes
// ============================================================================

/**
 * The room's per-agent web switches as they are RIGHT NOW, intersected with
 * what the caller asked for. Ported verbatim from the `let lanes = { … }`
 * block at the top of `dispatch_jsonrpc` (room_mcp.rs 788-795).
 *
 * Intersected rather than replaced, deliberately and for the reason the Rust
 * comment gives: "a caller that deliberately narrowed the catalog (a workflow
 * node) keeps its narrowing". A live switch can only ever take a lane AWAY.
 */
export function intersectWebLanes(caller: WebLanes, live: WebLanes): WebLanes {
  return {
    search: caller.search && live.search,
    browse: caller.browse && live.browse,
  };
}

/**
 * The OPEN room's web lanes, or both-on when no room is open. Ported from
 * `commands::open_room_web_lanes`, which `dispatch_jsonrpc` calls inline.
 *
 * The no-room answer is `WebLanes::default()`, and `WebLanes`' `Default` impl
 * is `ALL` — NOT the derived all-false — with its own comment explaining why:
 * "a bridge that silently served no web tools would look exactly like a room
 * that is offline". Deriving that fallback wrong is silent in both directions,
 * which is why this tiny wrapper is a named, tested function rather than three
 * lines each caller writes for itself.
 */
export function openRoomWebLanes(
  currentRoom: () => { db: Database.Database } | null
): WebLanes {
  const room = currentRoom();
  return room === null ? WEB_LANES_ALL : webLanesFromSettings(room.db);
}

/**
 * `RoomToolDispatcherOptions` whose `lanes` are re-read on every `tools/list`
 * and every `tools/call`, instead of being frozen when the dispatcher was
 * built — the behaviour `dispatch_jsonrpc` gets by recomputing `lanes` at the
 * top of each request.
 *
 * WHY A GETTER RATHER THAN A WRAPPER DISPATCHER: a `ToolDispatcher` decorator
 * cannot reach this, because the lanes are consumed INSIDE
 * `RoomToolDispatcher` (`servedToolsWith(this.opts.webEnabled,
 * this.opts.lanes, …)`, in both `listTools` and `callTool`). That class reads
 * `this.opts.lanes` fresh on every call and never caches it, so an accessor on
 * the options object IS the per-request re-read, mapped onto this
 * architecture's own seam — `dispatchJsonRpc` has no lanes parameter to carry
 * it instead. `roomMcp.test.ts` drives a REAL `RoomToolDispatcher` across a
 * live lane flip, so if that class ever starts caching `lanes` in its
 * constructor, this stops being true and the test says so rather than the
 * catalog quietly going stale again.
 *
 * `base.lanes` is captured ONCE as the caller's narrowing (the `lanes`
 * argument `start`'s `StartOpts` froze for the bridge's lifetime) and
 * intersected with each fresh live reading — see {@link intersectWebLanes}.
 */
export function liveLanesDispatcherOptions(
  base: RoomToolDispatcherOptions,
  readLiveLanes: () => WebLanes
): RoomToolDispatcherOptions {
  const callerLanes = base.lanes;
  return {
    ...base,
    get lanes(): WebLanes {
      return intersectWebLanes(callerLanes, readLiveLanes());
    },
  };
}

// ============================================================================
// prepare_advisor_runtime
// ============================================================================

/** `(Option<AdvisorRuntime>, Option<Arc<Bridge>>)` — Rust's own two
 * independent return values, given names instead of tuple positions. */
export interface PreparedAdvisorRuntime {
  /** `null` only when `advisors` was empty — the Advisor feature is off for
   * this room, the common case. Mirrors Rust's `(None, None)` early return. */
  advisorRuntime: AdvisorRuntime | null;
  /** The nested `CloudAdvisor{includeMcp:true}` bridge a consulted Claude CLI
   * gets its own room tools from, or `null` when advisor tools are off, the
   * only configured advisor is Codex, or the start genuinely failed. Stop it
   * when the parent turn ends. */
  nestedBridge: RunningBridge | null;
}

export interface PrepareAdvisorRuntimeOptions {
  /** The room's master "may this room reach the web" switch, handed to
   * `startBridge` exactly as Rust hands it to `start`. */
  webEnabled: boolean;
  /** Installed/enabled advisor CLI ids for this top-level turn
   * (`"claude-cli"`, `"codex-cli"`), or empty when the Advisor feature is off
   * entirely. */
  advisors: readonly string[];
  /** The room's "give the consulted advisor the room's own tools" sub-option
   * (`advisor_tools_enabled`). */
  advisorToolsEnabled: boolean;
  /** This ask's Stop flag — becomes `AdvisorRuntime.cancel`, which
   * `toolCancelFor` hands down to every dispatched tool's commit gate. */
  cancel: CancelFlagLike;
  /**
   * How to actually bind and serve the nested bridge. Defaults to
   * `moonshotServer.ts`'s `startRoomBridgeNotImplemented` — the same
   * ready-made, honestly-rejecting default `setRoomServer`/
   * `regenerateLeashToken` already use — so a caller that has not assembled a
   * real dispatcher yet still gets the REAL orchestration with the nested
   * bridge honestly `null` rather than fabricated as running.
   * {@link bridgeStarterFor} turns a real dispatcher into a real one.
   */
  startBridge?: BridgeStarter;
}

/**
 * Build the optional Advisor capability for one top-level turn. Ported from
 * `room_mcp::prepare_advisor_runtime` (room_mcp.rs 519-549), minus `app`
 * (Tauri-specific — replaced by the {@link PrepareAdvisorRuntimeOptions.startBridge}
 * seam) and `privacy_bypass` (see this module's doc for why that one is
 * dropped rather than threaded through unused).
 *
 * Three behaviours, each load-bearing:
 * - `advisors.length === 0` short-circuits to `(null, null)` before anything
 *   is built, matching Rust's own early return.
 * - The nested bridge is started ONLY when the sub-option is on AND
 *   `"claude-cli"` is among the advisors — Codex is not given room tools by
 *   this path. It is started with `ToolScope::CloudAdvisor{includeMcp:true}`,
 *   no fixed port and no fixed token (`StartOpts::default()`: a fresh
 *   ephemeral bind and a fresh bearer token every time) and
 *   `WebLanes::default()`, which is BOTH LANES ON, not all-off.
 * - That nested bridge intentionally gets no `AdvisorRuntime` of its own —
 *   nobody calls this function for it — which is the recursion boundary: a
 *   consulted Claude cannot consult a further advisor.
 *
 * A failed start degrades to "no room tools for the consulted advisor" rather
 * than failing the whole turn — Rust's `.ok().map(Arc::new)`, which turns a
 * bind `Err` into `None` and builds the `AdvisorRuntime` either way.
 * `consult_advisor` still works over the plain text pipe.
 */
export async function prepareAdvisorRuntime(
  opts: PrepareAdvisorRuntimeOptions
): Promise<PreparedAdvisorRuntime> {
  if (opts.advisors.length === 0) {
    return { advisorRuntime: null, nestedBridge: null };
  }
  const startBridge = opts.startBridge ?? startRoomBridgeNotImplemented;
  let nestedBridge: RunningBridge | null = null;
  if (opts.advisorToolsEnabled && opts.advisors.includes("claude-cli")) {
    try {
      // `await` inside the `try` on purpose: this must swallow a starter that
      // throws SYNCHRONOUSLY just as surely as one that rejects.
      nestedBridge = await startBridge(
        opts.webEnabled,
        { kind: "CloudAdvisor", includeMcp: true },
        { lanes: WEB_LANES_ALL }
      );
    } catch {
      nestedBridge = null;
    }
  }
  return {
    advisorRuntime: new AdvisorRuntime(opts.advisors, opts.cancel),
    nestedBridge,
  };
}

/**
 * A REAL {@link BridgeStarter} over `moonshotServer.ts`'s `createRoomBridge`,
 * for a caller that can build a dispatcher.
 *
 * `makeDispatcher` takes the three inputs Rust's `start` receives and uses to
 * decide the catalog — `web_enabled`, `scope`, `lanes` — rather than closing
 * over one pre-built dispatcher, so nothing in the `BridgeStarter` contract is
 * accepted and quietly ignored. It is also the place
 * `RoomToolDispatcherOptions.privacyBypass` is set for the bridge being
 * started (see this module's doc).
 */
export function bridgeStarterFor(
  makeDispatcher: (webEnabled: boolean, scope: ToolScope, lanes: WebLanes) => ToolDispatcher,
  serverVersion?: string
): BridgeStarter {
  return (webEnabled, scope, opts) =>
    createRoomBridge({
      scope,
      dispatcher: makeDispatcher(webEnabled, scope, opts.lanes),
      port: opts.port,
      token: opts.token,
      serverVersion,
    });
}

/**
 * Adapt a live {@link RunningBridge} into the {@link AdvisorBridge} shape
 * `externalAdvisor.ts`'s `runExternalCli`/`withRealAdvisorCli` needs — the
 * last piece connecting {@link prepareAdvisorRuntime}'s output to
 * `RunExternalOptions.bridge`, and this port's stand-in for Rust threading
 * `AdvisorRuntime.room_bridge` into `exec_tool`.
 *
 * `externalAdvisor.ts`'s own `adaptMcpBridge` adapts the lower-level
 * `McpBridge` server class; `RunningBridge` wraps that class one layer up and
 * does not re-expose it, so it needs its own small adapter. `mcpUrl` is built
 * exactly as `Bridge::mcp_url` builds it (room_mcp.rs 362-365) —
 * `RunningBridge` carries only the port — and `mcpConfigJson` is read straight
 * off the bridge, which already reproduces `Bridge::mcp_config_json`.
 */
export function adaptRunningBridge(bridge: RunningBridge): AdvisorBridge {
  return {
    token: bridge.token,
    mcpUrl: () => `http://127.0.0.1:${bridge.port}/mcp`,
    mcpConfigJson: () => bridge.mcpConfigJson(),
  };
}
