/**
 * D9 / Wave 1a — THE LEASH, revived: the room's persistent MCP server, started
 * for real on unlock and stopped for real on lock.
 *
 * RUST SOURCE OF TRUTH: `src-tauri/src/commands/rooms.rs`'s
 * `spawn_room_server_if_enabled` (the fire-and-forget unlock hook, read in
 * full), `src-tauri/src/commands/moonshot/server.rs`'s `leash_scope`/
 * `leash_identity`/`web_lanes`/`store_bridge_if_current`/`scope_name`,
 * `src-tauri/src/commands/moonshot/discovery.rs`'s writers, and
 * `src-tauri/src/room_mcp.rs`'s `start`/`dispatch_jsonrpc`/`log_catalog`.
 *
 * ============================================================================
 * WHAT WAS ACTUALLY MISSING, AND WHY IT IS NO LONGER
 * ============================================================================
 * Three already-landed files each named the same gap, in almost the same
 * words, and all three premises are now false:
 *
 *   - `roomManager.ts`'s `ROOM_SERVER_NOT_IMPLEMENTED`: "no Electron port yet
 *     … until a real room/DB layer exists to wire it to". That layer is
 *     `electron/main/index.ts` — a real, tested, booting bootstrap over a real
 *     `db-host` — plus `ipc/registry.ts`'s one shared `RoomManagerState`.
 *   - `moonshotServer.ts`'s `START_ROOM_BRIDGE_NOT_IMPLEMENTED`: a live bridge
 *     "needs a real ExecToolDeps … and a real ActivePolicy … neither exists in
 *     this tree yet". `liveContext.ts`'s `liveExecToolDeps` is the first (its
 *     own doc names `RoomToolDispatcherOptions.execDeps` as a destination);
 *     `privacy.ts`'s `activePolicy()` over `privacyRedact.ts`'s `Redactor` is
 *     the second.
 *   - `bridgeDispatcher.ts`'s `RedactionPolicy` doc: "a future privacy/
 *     redaction batch supplies a real implementation". {@link toRedactionPolicy}
 *     is that implementation — and it is the ONLY genuinely new logic in this
 *     file: a shape adapter, never new redaction behaviour. (`Redactor.redact`
 *     takes a mutable `PrivacyReport` accumulator and returns a string;
 *     `RedactionPolicy.redact` wants one self-contained
 *     `{text, entitiesHidden}` per call. `externalAdvisor.ts` already adapts
 *     the SAME policy cell into a DIFFERENT consumer shape
 *     (`AdvisorPrivacyPolicy`, the `Redactor`'s own raw two-argument methods),
 *     so this is not a second copy of that — it cannot reuse it.)
 *
 * Everything else here is composition of already-real, already-tested pieces:
 * `roomMcp.ts`'s `bridgeStarterFor`/`openRoomWebLanes`/
 * `liveLanesDispatcherOptions`/`withCatalogTelemetry`, `bridgeDispatcher.ts`'s
 * `RoomToolDispatcher`/`createWebThrottle`, `moonshotServer.ts`'s
 * `leashScope`/`leashIdentity`/`webLanesFromSettings`/`storeBridgeIfCurrent`/
 * `createRoomBridge`, and `moonshotDiscovery.ts`'s discovery-file writers.
 * What never existed was ONE caller assembling them from the room-open
 * lifecycle.
 *
 * ============================================================================
 * ONE DEPS BUNDLE FOR BOTH DOORS INTO THE SAME BRIDGE
 * ============================================================================
 * {@link createRoomServerDeps} returns `moonshotServer.ts`'s own
 * `SetRoomServerDeps` — deliberately the SAME bundle for both ways a bridge
 * can come up:
 *
 *   - the unlock path ({@link spawnRoomServerIfEnabledCore}, this file), and
 *   - the Settings toggle (`setRoomServer`/`regenerateLeashToken`, which
 *     `registerMoonshotServerIpc` already dispatches and which until now got
 *     `startRoomBridgeNotImplemented`).
 *
 * Both must also share ONE slot ({@link roomServerSlotOver}) — the same
 * `RoomManagerState.roomServer` field `roomManager.ts`'s `teardownOpenRoom`
 * stops on lock. Two slots would mean `room_server_status` reporting "not
 * running" while the Leash is live, `set_room_server` starting a SECOND bridge
 * next to the unlock path's (its own slot being empty), and a lock stopping
 * only one of them — a leaked listener still holding the room's bearer token.
 *
 * ============================================================================
 * ONE NAMED, DELIBERATE DEVIATION — the discovery write is SCOPE-GATED
 * ============================================================================
 * `spawn_room_server_if_enabled` writes `~/.arcelle/leash.json` unconditionally
 * whenever `store_bridge_if_current` returns true, with NO scope check — unlike
 * its sibling `set_room_server` (server.rs 188-196), whose own comment is
 * explicit: "Only the full tier advertises itself on disk — the files-tier UI
 * promises the token reaches the room by paste only, so we must not drop its
 * bearer token into ~/.arcelle/leash.json." Reproducing the literal
 * unconditional write would mean: enable the Leash at the files tier once (no
 * disk write, by `set_room_server`'s own design), then relock and unlock the
 * SAME room — and now its ephemeral files-tier bearer token IS on disk,
 * contradicting the one guarantee that comment states in writing. This port
 * applies `set_room_server`'s gate here too. If the Rust asymmetry is ever
 * found to be intentional, it is a one-line revert (drop the `if` in
 * {@link spawnRoomServerIfEnabledCore}).
 *
 * NOT the deviation's mirror image, deliberately: `set_room_server`'s files-tier
 * branch also `remove_discovery()`s, and this path does NOT. That branch is
 * answering an explicit user action that CHANGED the tier (a stale full-tier
 * record must not survive a downgrade); an unlock has changed nothing, and the
 * only record that could be on disk at that moment belongs to a bridge this
 * same lock/unlock cycle already removed through `teardownOpenRoom`'s own
 * `removeDiscovery`.
 *
 * ============================================================================
 * NOT SCOPED HERE
 * ============================================================================
 * `opts.routes` is `[]` — a live `McpManager` connector transport is a
 * separate, undone integration (`roomManager.ts`'s own bucket-1 list, and
 * `liveContext.ts`'s own caller gives the identical honest answer). `advisor`
 * is `null`: `prepareAdvisorRuntime` is a per-ASK concern with no owner on a
 * persistent, ask-less bridge, matching Rust's own `None` at this call site.
 */

import type Database from "better-sqlite3-multiple-ciphers";

import {
  createWebThrottle,
  RoomToolDispatcher,
  type ActivePolicy,
  type RedactionPolicy,
  type RoomToolDispatcherOptions,
} from "./bridgeDispatcher.js";
import { getSetting } from "./db-host/settings.js";
import { webAccessEnabled } from "./gatherContext.js";
import { liveExecToolDeps } from "./liveContext.js";
import type { ToolDispatcher, ToolScope } from "./mcpBridge.js";
import { removeDiscovery, writeDiscovery } from "./moonshotDiscovery.js";
import {
  leashIdentity,
  leashScope,
  scopeName,
  storeBridgeIfCurrent,
  webLanesFromSettings,
  type RoomServerRoomSource,
  type RoomServerSlot,
  type RunningBridge,
  type SetRoomServerDeps,
} from "./moonshotServer.js";
import { activePolicy as roomActivePolicy, type PolicyState } from "./privacy.js";
import { emptyPrivacyReport } from "./privacyRedact.js";
import { bridgeStarterFor, liveLanesDispatcherOptions, openRoomWebLanes, withCatalogTelemetry } from "./roomMcp.js";
import type { Room, RoomManagerState } from "./roomManager.js";
import type { WebLanes } from "./toolSpecs.js";
import type { EventSender } from "./turn.js";
import { liveMcpRoutes, type LiveAppServices } from "./liveAppServices.js";
import { createWorkspaceMcpBridge } from "./workspace/workspaceMcp.js";

// ============================================================================
// The RedactionPolicy adapter over privacy.ts's real Redactor
// ============================================================================

/**
 * Adapt `privacy.ts`'s real {@link PolicyState} to `bridgeDispatcher.ts`'s
 * {@link RedactionPolicy} shape — the one genuinely new piece in this file
 * (see the module doc). A fresh {@link emptyPrivacyReport} is opened and closed
 * per call, exactly as every other single-call site in this tree
 * (`privacy.ts`'s own `maybeRedactForCloud`/`wouldLeak`, `externalAdvisor.ts`'s
 * `redact`) already does.
 */
export function toRedactionPolicy(policy: PolicyState): RedactionPolicy {
  return {
    restoreValue: (value: unknown): unknown => policy.redactor.restoreValue(value),
    redact: (text: string): { text: string; entitiesHidden: number } => {
      const report = emptyPrivacyReport();
      const masked = policy.redactor.redact(text, report);
      return { text: masked, entitiesHidden: report.entitiesHidden };
    },
  };
}

/**
 * `commands::active_policy()` for the Leash — the room's live cloud-privacy
 * policy (populated on room open by `privacy.ts`'s `refreshPolicy`, which
 * `ipc/registry.ts` wires as `RoomManagerDeps.policy`), or `null` when the
 * privacy door is off / no room is open, exactly {@link ActivePolicy}'s
 * contract.
 *
 * Re-resolved on every dispatched call, never captured once: the switch and the
 * rule set can both change between two tool calls on the same long-lived
 * connection, and `RoomToolDispatcher.callTool` already calls
 * `opts.activePolicy()` fresh every time.
 */
export const realActivePolicy: ActivePolicy = (): RedactionPolicy | null => {
  const policy = roomActivePolicy();
  return policy === null ? null : toRedactionPolicy(policy);
};

// ============================================================================
// The real ToolDispatcher factory
// ============================================================================

/**
 * The dispatcher factory {@link bridgeStarterFor} calls ONCE per bridge start:
 * a real `RoomToolDispatcher` over `liveContext.ts`'s real `ExecToolDeps`,
 * wrapped in the two per-bridge behaviours `room_mcp::start`/`dispatch_jsonrpc`
 * give every bridge in the Rust source and that a naive composition silently
 * drops:
 *
 *  - {@link liveLanesDispatcherOptions} — the PER-REQUEST live web-lane re-read
 *    (`dispatch_jsonrpc`, room_mcp.rs 788-795). The Leash is the exact case
 *    that motivated it: "an external agent (Claude Code, Codex, Claude Desktop)
 *    holds ONE connection for the whole session, so a bridge that answered
 *    `tools/list` at connect time kept serving the web and browser tools for
 *    the rest of it: flipping either switch in Settings changed nothing until
 *    the room was closed, with no hint it had not taken."
 *  - `webThrottle` — CHG-33's web-search brake, whose lifetime in Rust is the
 *    BRIDGE (`let web_throttle_task: WebThrottle = …` at room_mcp.rs 467,
 *    cloned into each connection), so it is created here, once per start,
 *    rather than per call (which would never trip) or per process (which would
 *    leak one room's failure into the next).
 *  - {@link withCatalogTelemetry} — `log_catalog` at Rust's own `tools/list`
 *    call site. `turn` is `null`: a persistent bridge belongs to no ask, which
 *    `turnFields` already spells `"-"` rather than omitting.
 *
 * No per-turn concept applies to a bridge with no owning ask, so
 * `advisor`/`runCancel`/`sharedEffects` are `null` (Rust's own `None` for all
 * three at this call site) and `privacyBypass` is `false` — the safe default;
 * {@link realActivePolicy} is what decides whether anything is redacted, and
 * `false` only means "do not skip that decision".
 */
export function roomServerDispatcherFactory(
  state: RoomManagerState,
  emit: EventSender,
  services?: LiveAppServices,
): (webEnabled: boolean, scope: ToolScope, lanes: WebLanes) => ToolDispatcher {
  const readLiveLanes = (): WebLanes =>
    openRoomWebLanes((): { db: Database.Database } | null =>
      state.room === null ? null : { db: state.room.conn }
    );

  return (webEnabled, scope, lanes): ToolDispatcher => {
    const routes = services === undefined ? [] : liveMcpRoutes(state, services.mcp.manager);
    const base: RoomToolDispatcherOptions = {
      webEnabled,
      lanes,
      routes,
      advisor: null,
      runCancel: null,
      sharedEffects: null,
      privacyBypass: false,
      activePolicy: realActivePolicy,
      webThrottle: createWebThrottle(),
      execDeps: liveExecToolDeps(state, emit, services === undefined ? {} : { services }),
      // The persistent bridge is read-only. A write-enabled per-run bridge is
      // created only after HarnessOrchestrator completes rollback baselines.
      workspace: state.room?.workspace === undefined ? null : createWorkspaceMcpBridge(state, false),
    };
    return withCatalogTelemetry(
      new RoomToolDispatcher(liveLanesDispatcherOptions(base, readLiveLanes)),
      null
    );
  };
}

// ============================================================================
// RoomManagerState viewed as moonshotServer.ts's two seams
// ============================================================================

/**
 * `RoomManagerState.roomServer` as `moonshotServer.ts`'s {@link RoomServerSlot}
 * — an accessor pair, NOT a second field: every read and write goes straight
 * through to the one field `roomManager.ts`'s `teardownOpenRoom` already stops
 * and clears on lock. See the module doc for why a second slot would be a real
 * defect rather than a tidiness question.
 *
 * The read-side cast is safe because this module and
 * `moonshotServer.ts`'s `setRoomServer` (which is handed THIS slot) are the
 * only writers, and both only ever store a real {@link RunningBridge} — a
 * structural superset of `roomManager.ts`'s `RoomServerBridge`, as that file's
 * own doc on the field records. The write side needs no cast for the same
 * reason.
 */
export function roomServerSlotOver(state: RoomManagerState): RoomServerSlot {
  return {
    get bridge(): RunningBridge | null {
      return state.roomServer as RunningBridge | null;
    },
    set bridge(value: RunningBridge | null) {
      state.roomServer = value;
    },
  };
}

/** {@link RoomManagerState} as `moonshotServer.ts`'s {@link RoomServerRoomSource}
 * (`{path, name, db}`) — re-consulted at call time, never cached, because a
 * room can close/reopen/switch while a bridge-start `await` is in flight. */
export function roomServerRoomSource(state: RoomManagerState): RoomServerRoomSource {
  return {
    currentRoom: (): { path: string; name: string; db: Database.Database } | null =>
      state.room === null
        ? null
        : { path: state.room.path, name: state.room.name, db: state.room.conn },
  };
}

// ============================================================================
// The one deps bundle
// ============================================================================

/** Test-only seams. Production passes nothing: the real
 * `~/.arcelle/leash.json` and `McpBridge`'s own default server version. */
export interface RoomServerDepsOptions {
  /** Reported in the MCP `initialize` handshake. */
  serverVersion?: string;
  /** `writeDiscovery`/`removeDiscovery`'s own documented `home` override, so a
   * test never touches the real `~/.arcelle`. */
  discoveryHome?: string;
  services?: LiveAppServices;
}

/**
 * The real `SetRoomServerDeps` for `state`: a real {@link ToolDispatcher}-backed
 * `BridgeStarter` over `moonshotServer.ts`'s `createRoomBridge`, plus the real
 * discovery-file writers. Shared by BOTH doors into the same bridge — see the
 * module doc.
 */
export function createRoomServerDeps(
  state: RoomManagerState,
  emit: EventSender,
  opts: RoomServerDepsOptions = {}
): SetRoomServerDeps {
  return {
    startBridge: bridgeStarterFor(roomServerDispatcherFactory(state, emit, opts.services), opts.serverVersion),
    writeDiscovery: (port, token, scope, room) =>
      writeDiscovery(port, token, scope, room, opts.discoveryHome),
    removeDiscovery: () => removeDiscovery(opts.discoveryHome),
  };
}

/** A standalone `() => void` for `RoomManagerDeps.removeDiscovery` —
 * `teardownOpenRoom` calls it whenever it stopped a bridge, at any tier
 * (`moonshotDiscovery.ts`'s removal is best-effort and idempotent, so a missing
 * file because the files tier never wrote one is fine). */
export function createRemoveDiscovery(discoveryHome?: string): () => void {
  return () => removeDiscovery(discoveryHome);
}

// ============================================================================
// spawn_room_server_if_enabled
// ============================================================================

/** Which branch {@link spawnRoomServerIfEnabledCore} took.
 *
 * A small, honest ADDITION over the Rust function's bare `()`: Rust callers can
 * observe the outcome only through `state.room_server` / the discovery file /
 * an open socket, so a `void` port would force every test to poll those same
 * side channels through a timing race. Reporting which branch ran changes no
 * side effect — the same enrichment `jobQueue.ts`'s `RowStartResult` already
 * sets precedent for in this codebase. */
export type SpawnRoomServerResult =
  /** The toggle is off, or the full tier's identity could not be read/persisted
   * (Rust's `Err(_) => return`, which happens BEFORE the `enabled` check there
   * too). */
  | { kind: "disabled" }
  | { kind: "already-running" }
  | { kind: "start-failed" }
  /** The bridge bound, but the room changed (closed, swapped, or the toggle
   * flipped off) while the `await` was in flight — `storeBridgeIfCurrent`
   * declined and already stopped it. */
  | { kind: "stale-room" }
  | { kind: "started"; bridge: RunningBridge };

/**
 * The awaitable core, ported step for step from `spawn_room_server_if_enabled`
 * (`rooms.rs` 254-308):
 *
 *  1. Snapshot every decision off THIS room's settings before any await —
 *     Rust's own `{ … }` block taken under the room lock.
 *  2. Resolve the tier with `allowCloud` FIXED to `false`. The Rust source's
 *     own deliberate asymmetry: the advisor/cloud sub-option is not persisted,
 *     so an unlock-restart begins with cloud MCP OFF; only an explicit
 *     `set_room_server` turns it back on.
 *  3. FULL TIER ONLY: read-or-create the stable `leash_port`/`leash_token`, so
 *     a pasted external-agent config survives restarts. A failure aborts the
 *     whole spawn (Rust's `Err(_) => return`) — even when the toggle is off,
 *     because Rust resolves this before it ever checks `enabled` either.
 *  4. Toggle off → nothing to start.
 *  5. NEVER DOUBLE-START: a bridge already in the slot (a stale flag racing a
 *     manual toggle) aborts rather than binding a second listener nobody can
 *     reach or stop.
 *  6. Start. A failed start is swallowed (Rust's `if let Ok(bridge) = …`): the
 *     room simply has no Leash this session, the fire-and-forget-spawn posture
 *     `roomManager.ts` documents for every bucket-1 unlock spawn.
 *  7. Store ONLY if the room this was started for is STILL open
 *     (`storeBridgeIfCurrent`) — a teardown during the await must win, or the
 *     stale bridge would serve the NEXT room with THIS room's token. Only a
 *     stored, full-tier bridge is advertised on disk (see the module doc's
 *     named deviation).
 */
export async function spawnRoomServerIfEnabledCore(
  state: RoomManagerState,
  room: Room,
  deps: Pick<SetRoomServerDeps, "startBridge" | "writeDiscovery">
): Promise<SpawnRoomServerResult> {
  const enabled = getSetting(room.conn, "room_server_enabled") === "1";
  const scope = leashScope(getSetting(room.conn, "room_server_scope"), false);

  let port: number | undefined;
  let token: string | undefined;
  if (scope.kind === "ExternalAgent") {
    try {
      ({ port, token } = leashIdentity(room.conn));
    } catch {
      return { kind: "disabled" };
    }
  }
  const lanes = webLanesFromSettings(room.conn);
  const webEnabled = webAccessEnabled(room.conn);
  const roomPath = room.path;
  const roomName = room.name;

  if (!enabled) {
    return { kind: "disabled" };
  }
  if (state.roomServer !== null) {
    return { kind: "already-running" };
  }

  let bridge: RunningBridge;
  try {
    bridge = await deps.startBridge(webEnabled, scope, { port, token, lanes });
  } catch {
    return { kind: "start-failed" };
  }

  if (!storeBridgeIfCurrent(roomServerRoomSource(state), roomServerSlotOver(state), roomPath, bridge)) {
    return { kind: "stale-room" };
  }
  if (bridge.scope.kind === "ExternalAgent") {
    try {
      deps.writeDiscovery(bridge.port, bridge.token, scopeName(bridge.scope), roomName);
    } catch {
      // Best-effort, matching Rust's `let _ = write_discovery(...)`.
    }
  }
  return { kind: "started", bridge };
}

/**
 * The fire-and-forget `(room: Room) => void` `RoomManagerDeps
 * .spawnRoomServerIfEnabled` declares — the direct replacement for
 * `roomManager.ts`'s `spawnRoomServerIfEnabledNotImplemented`. Rust's own call
 * site is a `tauri::async_runtime::spawn`, and a room open/create must never
 * await this or fail because it rejected.
 *
 * The `.catch` is belt-and-braces beyond the Rust behaviour
 * ({@link spawnRoomServerIfEnabledCore} already swallows a failed start
 * itself): an uncaught rejection out of a `void`-called async function is an
 * unhandled promise rejection in Node which — unlike a panic inside a spawned
 * Tokio task — can print noisily or, depending on process configuration, take
 * the app down. A room unlock must not be that fragile because one settings row
 * was unreadable.
 */
export function createSpawnRoomServerIfEnabled(
  state: RoomManagerState,
  deps: Pick<SetRoomServerDeps, "startBridge" | "writeDiscovery">
): (room: Room) => void {
  return (room: Room): void => {
    void spawnRoomServerIfEnabledCore(state, room, deps).catch(() => {
      // Swallowed deliberately — see this function's own doc.
    });
  };
}
