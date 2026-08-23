/**
 * D9 (the Leash: the room's persistent MCP server) + D10 (the Closet: the
 * remote-Ollama override). Ported from `src-tauri/src/commands/moonshot/
 * server.rs` (462 lines, read in full including its `#[cfg(test)] mod tests`).
 * `moonshot.rs` (the top-level `mod` dispatcher this file's Rust source lives
 * under) is a plain re-export hub with no logic of its own beyond
 * `resolve_structured_model`/`recommended_models`/`ensure_embed_model`, none
 * of which `server.rs` touches — nothing from it needed porting here.
 *
 * ============================================================================
 * NONE OF THIS IS MODEL-INVOCABLE
 * ============================================================================
 * `room_server_status`, `set_room_server`, `regenerate_leash_token`,
 * `set_ollama_url`, `test_ollama_url`, `get_ollama_url` are plain
 * `#[tauri::command]`s in `lib.rs`'s `invoke_handler` list — none appears in
 * `agent.rs`'s `exec_tool` match arms. Confirmed by grepping both the Rust
 * source and this migration's `execTool.ts`/`toolSpecs.ts`/`toolSchema.ts`.
 * No `execTool.ts` arm is added by this file (rule 6 does not apply — there is
 * nothing to wire).
 *
 * ============================================================================
 * NO NEW NATIVE/OS BINDING — Node's `http` already carries the transport
 * ============================================================================
 * `server.rs` itself never frames a TCP connection: it calls into
 * `room_mcp::start`, a DIFFERENT Rust source file (3096 lines). That
 * transport's Electron port already exists and is real: `mcpBridge.ts`'s
 * `McpBridge` binds loopback with Node's `http` module (the same choice this
 * file's own doc block explains and justifies), and `bridgeDispatcher.ts`'s
 * `RoomToolDispatcher` is a complete, verbatim port of `tool_call`'s dispatch
 * body. What is genuinely missing is glue, not a binding: this file needs the
 * bind/token/port-retry ORCHESTRATION `server.rs` itself owns (D9's
 * `leash_scope`/`scope_name`/`leash_identity`/`room_server_status_snapshot`/
 * `store_bridge_if_current`), which is what this port supplies for real —
 * see {@link createRoomBridge}.
 *
 * ============================================================================
 * WHAT IS REAL HERE
 * ============================================================================
 *   - D9: {@link leashScope}, {@link scopeName}, {@link leashIdentity},
 *     {@link roomServerStatusSnapshot}, {@link storeBridgeIfCurrent},
 *     {@link roomServerStatus}, {@link webLanesFromSettings} (a small,
 *     self-contained `commands::web_lanes` port — `server.rs` calls it
 *     directly and no Electron port of it existed anywhere in this tree).
 *   - The discovery file (`~/.arcelle/leash.json`): `writeDiscovery`/
 *     `removeDiscovery`, IMPORTED from `moonshotDiscovery.ts` (the dedicated
 *     port of the separate Rust source `commands/moonshot/discovery.rs`) and
 *     re-exported under this file's own names, exactly as `server.rs` reaches
 *     its sibling module's `pub(crate)` functions by a plain call. See the
 *     "discovery file" section below for the duplicate this replaced.
 *   - {@link createRoomBridge}: a REAL, faithful port of `room_mcp::start`'s
 *     BINDING half — the fixed-port retry (5 attempts, 50 ms apart) with
 *     fallback to an ephemeral port (`stable: false`), built on the already-
 *     real `McpBridge`. It takes a `dispatcher` as a plain argument, so once a
 *     future batch can build a real one, this function needs no changes.
 *   - D10 in full: {@link normalizeOllamaUrl}, {@link setOllamaUrl},
 *     {@link testOllamaUrl}, {@link getOllamaUrl}.
 *   - {@link setRoomServer}/{@link regenerateLeashToken}: the settings
 *     persistence, scope-comparison restart logic, and discovery-file
 *     read-through are ALL real and tested. The one seam is described next.
 *
 * ============================================================================
 * THE ONE HONEST STUB — HONEST REFUSAL, NEVER A FABRICATED "IT'S RUNNING"
 * ============================================================================
 * `room_mcp::start` does more than bind a socket: it needs a `ToolDispatcher`
 * that actually serves the room's tools, i.e. a real `RoomToolDispatcher`
 * (`bridgeDispatcher.ts`) built from a real `ExecToolDeps` (routes,
 * `callConnectorTool`, `outboundUnmaskFor` — the MCP connector transport) and
 * a real `ActivePolicy` (`privacy.rs`'s redaction `Redactor`, restated as
 * unported in `bridgeDispatcher.ts`'s own module doc: "TODO: a future
 * privacy/redaction batch supplies a real implementation"). Assembling that is
 * a cross-cutting integration decision — get it wrong and a room's real,
 * unredacted file contents reach a cloud/external client over the Leash — and
 * belongs to a dedicated batch, not a side effect of porting this settings
 * file. `roomManager.ts` already reached the identical conclusion for the
 * SAME reason and left the SAME seam (`spawnRoomServerIfEnabledNotImplemented`
 * / `ROOM_SERVER_NOT_IMPLEMENTED`, which names this file's own
 * `leash_scope`/`leash_identity`/`store_bridge_if_current` as exactly the
 * pieces still missing at the time it was written) — this port is what closes
 * that list, minus the dispatcher assembly itself.
 *
 * {@link BridgeStarter} is the seam: {@link setRoomServer}/
 * {@link regenerateLeashToken} take one as a REQUIRED dependency (no silent
 * default is wired automatically), with {@link startRoomBridgeNotImplemented}
 * as the ready-made, honestly-rejecting default — the same shape
 * `roomManager.ts`'s `RoomManagerDeps.spawnRoomServerIfEnabled` and
 * `ollamaModels.ts`'s `AiStatusDeps.detectedExternal` already establish.
 * Turning OFF the Leash (`enabled: false`) needs no dispatcher at all and
 * works for real regardless — stopping a bridge and removing the discovery
 * file never required one.
 *
 * A Rust behavior this stub PRESERVES rather than papers over: settings are
 * persisted BEFORE the (possibly-failing) start is attempted, exactly as
 * `state.with_room(...)?` runs to completion before `room_mcp::start(...)
 * .await?` is even called — so calling {@link setRoomServer} with the default
 * dependency and `enabled: true` genuinely flips `room_server_enabled`/
 * `room_server_scope` in the room's settings and THEN rejects, matching what a
 * real start failure would do one line later in the Rust source.
 *
 * ============================================================================
 * IPC WIRING
 * ============================================================================
 * {@link registerMoonshotServerIpc} is written and tested but NOT invoked from
 * any bootstrap file, per `recIpc.ts`'s precedent (rule 4): Phase 2 needs an
 * explicit owner go-ahead before touching the live shipping app.
 */

import { randomUUID } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";

import { getSetting, setSetting } from "./db-host/settings.js";
import { removeDiscovery, writeDiscovery } from "./moonshotDiscovery.js";
import { webAccessEnabled } from "./gatherContext.js";
import { resolvedBaseUrl, setBaseUrlOverride } from "./engineRouting.js";
import { authedHeaders, busy, ensureUp } from "./sidecar.js";
import { McpBridge } from "./mcpBridge.js";
import type { ToolDispatcher, ToolScope } from "./mcpBridge.js";
import type { WebLanes } from "./toolSpecs.js";

// ============================================================================
// D9: the Leash (persistent room MCP server)
// ============================================================================

/** Wire shape for the room-server status the Settings screen polls. Ported
 * from `RoomServerStatus` (`#[serde(rename_all = "camelCase")]`). */
export interface RoomServerStatus {
  running: boolean;
  url: string;
  config: string;
  /** `"files"` | `"full"`. */
  scope: string;
  stable: boolean;
  allowCloud: boolean;
}

/** The fixed port the full tier binds by default. Ported verbatim from
 * `LEASH_DEFAULT_PORT`. */
export const LEASH_DEFAULT_PORT = 17872;

/**
 * Map the persisted `room_server_scope` setting to a bridge scope. Ported
 * verbatim from `leash_scope`: only an explicit `"full"` opt-in reaches the
 * external tier; anything else — missing, unknown, `"files"` — is the safe
 * cloud-advisor tier, with `allowCloud` mapping to the advisor sub-option.
 */
export function leashScope(setting: string | null | undefined, allowCloud: boolean): ToolScope {
  if (setting === "full") {
    return { kind: "ExternalAgent" };
  }
  return { kind: "CloudAdvisor", includeMcp: allowCloud };
}

/** The wire name of a bridge scope. Ported verbatim from `scope_name`. */
export function scopeName(scope: ToolScope): string {
  return scope.kind === "ExternalAgent" ? "full" : "files";
}

/** `ToolScope`'s `PartialEq`, ported: two scopes are the same tier AND (for
 * `CloudAdvisor`) the same `includeMcp` policy. Used by {@link setRoomServer}
 * to decide whether a running bridge already matches what was requested. */
function toolScopeEquals(a: ToolScope, b: ToolScope): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "CloudAdvisor" && b.kind === "CloudAdvisor") {
    return a.includeMcp === b.includeMcp;
  }
  return true;
}

/** A v4 UUID with no dashes — Node's equivalent of `Uuid::new_v4().simple()
 * .to_string()`, used for both the leash token and the discovery/status
 * tokens `room_mcp::start` mints when none is supplied. */
function simpleUuid(): string {
  return randomUUID().replace(/-/g, "");
}

/** A stored port setting is only trusted if it parses as a genuine port
 * number (0-65535, matching Rust's `u16`) — anything else re-seeds the
 * default, exactly like a missing setting does. */
function parseStoredPort(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) {
    return null;
  }
  const n = Number(raw);
  return n <= 65535 ? n : null;
}

/**
 * Read-or-create the full tier's stable identity — `leash_port` (default
 * {@link LEASH_DEFAULT_PORT}) and `leash_token` (a fresh uuid, persisted like
 * every other room setting). Persisting on first read is what lets a pasted
 * config survive restarts. Ported verbatim from `leash_identity`.
 */
export function leashIdentity(db: Database.Database): { port: number; token: string } {
  const storedPort = parseStoredPort(getSetting(db, "leash_port"));
  let port: number;
  if (storedPort !== null) {
    port = storedPort;
  } else {
    port = LEASH_DEFAULT_PORT;
    setSetting(db, "leash_port", String(LEASH_DEFAULT_PORT));
  }
  const storedToken = getSetting(db, "leash_token");
  let token: string;
  if (storedToken !== null && storedToken !== "") {
    token = storedToken;
  } else {
    token = simpleUuid();
    setSetting(db, "leash_token", token);
  }
  return { port, token };
}

/**
 * Read this room's two web lanes. ABSENT MEANS ON — every room that existed
 * before the toggles keeps its current behaviour without a migration. Ported
 * verbatim from `commands::web_lanes`; small and self-contained enough to
 * port directly here rather than leave `server.rs`'s own direct call
 * unimplemented (no Electron port of it existed anywhere in this tree).
 */
export function webLanesFromSettings(db: Database.Database): WebLanes {
  const on = (key: string): boolean => getSetting(db, key) !== "off";
  return { search: on("web_agent_search"), browse: on("web_agent_browse") };
}

// ---------------------------------------------------------------- RunningBridge

/**
 * The minimal shape `server.rs` needs from a live Leash bridge — standing in
 * for `crate::room_mcp::Bridge`. Structurally compatible with (a superset of)
 * `roomManager.ts`'s `RoomServerBridge` (`{ stop(): void }`), so a future
 * batch wiring `RoomManagerDeps.spawnRoomServerIfEnabled` for real can hand a
 * {@link RunningBridge} to `state.roomServer` with no adapter — this is a
 * structural-typing fact, not an import; the two files stay independent.
 */
export interface RunningBridge {
  port: number;
  token: string;
  scope: ToolScope;
  /** True when a requested FIXED port was actually bound — the pasted config
   * survives restarts. False for ephemeral binds, including the
   * fixed-port-taken fallback. */
  stable: boolean;
  /** The `--mcp-config` JSON handed to an external CLI. Ported from
   * `Bridge::mcp_config_json`. */
  mcpConfigJson(): string;
  /** Fire-and-forget stop (Rust's `Bridge::stop`). */
  stop(): void;
  /** Stop AND wait for the listener to fully release the port before
   * returning (Rust's `Bridge::stop_and_wait`) — required before an immediate
   * rebind of the same fixed port. */
  stopAndWait(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Options for {@link createRoomBridge}. */
export interface CreateRoomBridgeOptions {
  scope: ToolScope;
  /** The REAL tool catalog/dispatch this bridge serves. Not this module's
   * job to build — see the module doc's "ONE HONEST STUB" section. */
  dispatcher: ToolDispatcher;
  /** A fixed port to retry-then-fall-back-to-ephemeral on, or `undefined` for
   * a plain ephemeral bind (the files tier's own behavior). */
  port?: number;
  /** A specific bearer token, or `undefined` to mint a fresh one. */
  token?: string;
  serverVersion?: string;
}

/**
 * Bind loopback and serve MCP until the returned bridge's `stop()`/
 * `stopAndWait()`. Ported from `room_mcp::start`'s BINDING half only — the
 * fixed-port retry (5 attempts, 50 ms apart) with fallback to an ephemeral
 * port (`stable: false`) rather than failing the whole start. Real today
 * because it needs no tool catalog of its own: `opts.dispatcher` is the
 * caller's, exactly like `McpBridgeOptions.dispatcher` already is one layer
 * down.
 *
 * A fresh {@link McpBridge} instance is created per bind attempt rather than
 * retrying `.listen()` on one instance — Node gives no guarantee that an
 * `http.Server` is reusable after a failed `listen()`, and a fresh instance
 * per attempt mirrors Rust's own `TcpListener::bind` (also a fresh bind
 * attempt each iteration, never a retry on the same listener).
 */
export async function createRoomBridge(opts: CreateRoomBridgeOptions): Promise<RunningBridge> {
  const token = opts.token ?? simpleUuid();
  const makeBridge = (): McpBridge =>
    new McpBridge({
      token,
      scope: opts.scope,
      dispatcher: opts.dispatcher,
      serverVersion: opts.serverVersion,
    });

  let bridge: McpBridge | null = null;
  let stable = false;
  if (opts.port !== undefined) {
    for (let attempt = 0; attempt < 5 && bridge === null; attempt++) {
      const candidate = makeBridge();
      try {
        await candidate.listen(opts.port);
        bridge = candidate;
        stable = true;
      } catch {
        await sleep(50);
      }
    }
    if (bridge === null) {
      bridge = makeBridge();
      await bridge.listen(0);
      stable = false;
    }
  } else {
    bridge = makeBridge();
    await bridge.listen(0);
  }

  const started = bridge;
  const boundPort = started.port;
  if (boundPort === null) {
    throw new Error("mcp bridge bind failed: no address");
  }
  return {
    port: boundPort,
    token,
    scope: opts.scope,
    stable,
    mcpConfigJson: () =>
      JSON.stringify({
        mcpServers: {
          room: {
            type: "http",
            url: `http://127.0.0.1:${boundPort}/mcp`,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      }),
    stop: () => {
      void started.stop();
    },
    stopAndWait: () => started.stop(),
  };
}

// ------------------------------------------------------------- status snapshot

/** A mutable holder for the room's persistent MCP server, standing in for
 * `state.room_server: Mutex<Option<Bridge>>`. A plain field, matching
 * `roomManager.ts`'s `RoomManagerState.roomServer` — Node has no threads to
 * race a plain object read/write, so there is no lock to model. */
export interface RoomServerSlot {
  bridge: RunningBridge | null;
}

/** Snapshot the current room server state. Pure over the slot — ported
 * verbatim from `room_server_status_snapshot`. */
export function roomServerStatusSnapshot(slot: RoomServerSlot): RoomServerStatus {
  const bridge = slot.bridge;
  if (bridge === null) {
    return { running: false, url: "", config: "", scope: "files", stable: false, allowCloud: false };
  }
  return {
    running: true,
    url: `http://127.0.0.1:${bridge.port}/mcp`,
    config: bridge.mcpConfigJson(),
    scope: scopeName(bridge.scope),
    stable: bridge.stable,
    allowCloud: bridge.scope.kind === "CloudAdvisor" && bridge.scope.includeMcp === true,
  };
}

/** D9: is the room server running, and if so, its URL + mcp config. Ported
 * verbatim from `room_server_status`. */
export function roomServerStatus(slot: RoomServerSlot): RoomServerStatus {
  return roomServerStatusSnapshot(slot);
}

// ------------------------------------------------------------------ room source

/** The slice of the (not-yet-ported) `AppState` this file needs to answer
 * "which room is open RIGHT NOW" — re-invoked at call time, never cached,
 * because a room can close/reopen/switch while a bridge-start `await` is in
 * flight. Structurally the `{path, db}` pair every other ported command file
 * uses (`recIpc.ts`'s own `RoomSource`), widened with `name` — the one extra
 * field `write_discovery`/`regenerate_leash_token` need that those files
 * never did. */
export interface RoomServerRoomSource {
  currentRoom(): { path: string; name: string; db: Database.Database } | null;
}

/**
 * Store a freshly-started bridge ONLY while the room it was started for is
 * still the open one AND the toggle is still on — otherwise stop it. Ported
 * verbatim from `store_bridge_if_current`.
 *
 * ONE deliberate simplification from the Rust source, stated because it is a
 * real difference in SHAPE even though the OBSERVABLE behavior is identical:
 * Rust re-checks `state.room_server.lock()` a second time after deciding to
 * store, guarding against a genuinely concurrent OS thread racing the same
 * `Mutex` between the two locks (`std::sync::Mutex` across a real
 * multi-threaded tokio pool). Node has no thread pool racing bare synchronous
 * code — nothing can run between two statements with no `await` between them
 * — so that second check can never observe a different answer than the first
 * one gave, and is omitted rather than kept as decoration that no test could
 * ever fail.
 */
export function storeBridgeIfCurrent(
  roomSource: RoomServerRoomSource,
  slot: RoomServerSlot,
  roomPath: string,
  bridge: RunningBridge
): boolean {
  const room = roomSource.currentRoom();
  const current =
    room !== null && room.path === roomPath && getSetting(room.db, "room_server_enabled") === "1";
  if (current && slot.bridge === null) {
    slot.bridge = bridge;
    return true;
  }
  bridge.stop();
  return false;
}

// -------------------------------------------------------------- discovery file

/**
 * `~/.arcelle/leash.json` — REUSED from `moonshotDiscovery.ts`, the dedicated
 * port of `commands/moonshot/discovery.rs`, never re-implemented here.
 *
 * This file used to carry its own second copy (written before
 * `moonshotDiscovery.ts` landed in the tree), and the two disagreed: this one
 * resolved the home directory with `os.homedir()`, the other with
 * `process.env.HOME`-or-throw. With `HOME` unset they named DIFFERENT files,
 * so a Leash started here and torn down through `roomManager.ts` (which will
 * reach for `moonshotDiscovery.ts`, the discovery module) would have left a
 * live 0600 bearer token on disk after the room closed. One implementation,
 * one answer — `moonshotDiscovery.ts`'s, which reproduces `dirs::home_dir()`'s
 * actual `$HOME`-then-`getpwuid` order.
 *
 * `discoveryFilePath` keeps this file's own name for the path helper (it is
 * what `server.rs`'s call sites read as), aliased to the shared one.
 */
export { writeDiscovery, removeDiscovery };
export { writeDiscoveryAt, discoveryFile as discoveryFilePath } from "./moonshotDiscovery.js";

// ------------------------------------------------------- the one honest stub

/** What {@link setRoomServer}/{@link regenerateLeashToken} need to actually
 * bind and serve — `room_mcp::start`'s full signature, minus `app`/`effects`
 * (Tauri-specific / always `None` at both of `server.rs`'s own call sites). */
export type BridgeStarter = (
  webEnabled: boolean,
  scope: ToolScope,
  opts: { port?: number; token?: string; lanes: WebLanes }
) => Promise<RunningBridge>;

export const START_ROOM_BRIDGE_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: room_mcp::start — a live Leash bridge needs a real " +
  "ToolDispatcher (bridgeDispatcher.ts's RoomToolDispatcher), which itself " +
  "needs a real ExecToolDeps (routes/callConnectorTool/outboundUnmaskFor — " +
  "the MCP connector transport) and a real ActivePolicy (privacy.rs's " +
  "redaction Redactor) wired end to end — neither exists in this tree yet. " +
  "The bind/retry mechanics this stub would otherwise perform ARE real: see " +
  "createRoomBridge in moonshotServer.ts, which a caller can invoke directly " +
  "once it has a real ToolDispatcher to hand it.";

/** The ready-made default for {@link SetRoomServerDeps.startBridge}. Rejects
 * rather than fabricating a running server — see the module doc's "ONE
 * HONEST STUB" section. */
export const startRoomBridgeNotImplemented: BridgeStarter = () =>
  Promise.reject(new Error(START_ROOM_BRIDGE_NOT_IMPLEMENTED));

// --------------------------------------------------------------- set_room_server

export interface SetRoomServerArgs {
  enabled: boolean;
  allowCloud: boolean;
  /** `"full"` for the external-agent tier; anything else is the safe files
   * tier — matches `leash_scope`'s own `Some("full") => ... , _ => ...`. */
  scope: string;
}

export interface SetRoomServerDeps {
  startBridge: BridgeStarter;
  writeDiscovery: (port: number, token: string, scope: string, room: string) => void;
  removeDiscovery: () => void;
}

export const defaultSetRoomServerDeps: SetRoomServerDeps = {
  startBridge: startRoomBridgeNotImplemented,
  writeDiscovery,
  removeDiscovery,
};

/**
 * D9/Wave 1a: turn the persistent room MCP server on/off at a chosen tier.
 * Ported verbatim from `set_room_server`, including the exact ordering that
 * makes the default {@link SetRoomServerDeps.startBridge} an honest failure
 * rather than a silent no-op: settings are persisted FIRST, unconditionally,
 * then the (possibly-rejecting) start is attempted — see the module doc.
 *
 * `db`/`roomPath`/`roomName` are the CALLER's snapshot of "the room open
 * right now" (mirrors `state.with_room(|room| ...)`'s closure argument);
 * `roomSource` is re-consulted only inside {@link storeBridgeIfCurrent}, AFTER
 * `deps.startBridge`'s `await`, for the same reason Rust re-locks
 * `state.room` there instead of trusting the pre-await snapshot.
 */
export async function setRoomServer(
  db: Database.Database,
  roomPath: string,
  roomName: string,
  args: SetRoomServerArgs,
  slot: RoomServerSlot,
  roomSource: RoomServerRoomSource,
  deps: SetRoomServerDeps = defaultSetRoomServerDeps
): Promise<RoomServerStatus> {
  const wantFull = args.scope === "full";
  setSetting(db, "room_server_enabled", args.enabled ? "1" : "0");
  setSetting(db, "room_server_scope", wantFull ? "full" : "files");

  let port: number | undefined;
  let token: string | undefined;
  if (wantFull) {
    const identity = leashIdentity(db);
    port = identity.port;
    token = identity.token;
  }
  const lanes = webLanesFromSettings(db);
  const webEnabled = webAccessEnabled(db);
  const want = leashScope(wantFull ? "full" : "files", args.allowCloud);

  if (args.enabled) {
    const current = slot.bridge;
    let kept = false;
    let existing: RunningBridge | null = null;
    if (current !== null && toolScopeEquals(current.scope, want)) {
      // Same tier AND same policy already running — keep it (and its token)
      // untouched.
      kept = true;
    } else {
      existing = current;
      slot.bridge = null;
    }
    if (!kept) {
      if (existing !== null) {
        // Await the listener's death — the full tier rebinds the same fixed
        // port right below.
        await existing.stopAndWait();
      }
      const bridge = await deps.startBridge(webEnabled, want, { port, token, lanes });
      const stored = storeBridgeIfCurrent(roomSource, slot, roomPath, bridge);
      if (stored) {
        // Only the full tier advertises itself on disk — the files-tier UI
        // promises the token reaches the room by paste only.
        if (bridge.scope.kind === "ExternalAgent") {
          try {
            deps.writeDiscovery(bridge.port, bridge.token, scopeName(bridge.scope), roomName);
          } catch {
            // Best-effort, matching Rust's `let _ = write_discovery(...)`.
          }
        } else {
          deps.removeDiscovery();
        }
      }
    }
  } else {
    const taken = slot.bridge;
    slot.bridge = null;
    if (taken !== null) {
      taken.stop();
    }
    deps.removeDiscovery();
  }
  return roomServerStatusSnapshot(slot);
}

// ---------------------------------------------------------- regenerate_leash_token

/**
 * Wave 1a: mint a NEW `leash_token`. A running full-tier bridge is restarted
 * with the new token (severing every live connection holding the old one) and
 * the discovery file is rewritten; a files-tier bridge (or no bridge at all)
 * is left untouched, matching Rust's own `_ => None` fallthrough. Ported
 * verbatim from `regenerate_leash_token`.
 */
export async function regenerateLeashToken(
  db: Database.Database,
  roomPath: string,
  roomName: string,
  slot: RoomServerSlot,
  roomSource: RoomServerRoomSource,
  deps: SetRoomServerDeps = defaultSetRoomServerDeps
): Promise<RoomServerStatus> {
  setSetting(db, "leash_token", simpleUuid());
  const identity = leashIdentity(db);
  const lanes = webLanesFromSettings(db);
  const webEnabled = webAccessEnabled(db);

  const current = slot.bridge;
  let existing: RunningBridge | null = null;
  if (current !== null && current.scope.kind === "ExternalAgent") {
    existing = current;
    slot.bridge = null;
  }
  if (existing !== null) {
    await existing.stopAndWait();
    const bridge = await deps.startBridge(webEnabled, { kind: "ExternalAgent" }, {
      port: identity.port,
      token: identity.token,
      lanes,
    });
    if (storeBridgeIfCurrent(roomSource, slot, roomPath, bridge)) {
      try {
        deps.writeDiscovery(bridge.port, bridge.token, scopeName(bridge.scope), roomName);
      } catch {
        // Best-effort.
      }
    }
  }
  return roomServerStatusSnapshot(slot);
}

// ============================================================================
// D10: the Closet (remote Ollama URL)
// ============================================================================

const OLLAMA_URL_SHAPE = "use something like http://192.168.1.20:11434";

/**
 * D10: what the Closet field accepts, and the exact value to store — `""`
 * means "clear the override, use this Mac". Ported verbatim from
 * `normalize_ollama_url`, including every character/port validation rule and
 * the exact refusal wording. Throws (matching Rust's `Result::Err`) rather
 * than returning a union — house convention for a `Result<T, String>` port
 * (see `skillsCmds.ts`'s validators).
 */
export function normalizeOllamaUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return "";
  }
  if (/\s/u.test(trimmed)) {
    throw new Error(`A server address cannot contain spaces — ${OLLAMA_URL_SHAPE}.`);
  }
  const schemeSplit = trimmed.indexOf("://");
  let scheme: string;
  let rest: string;
  if (schemeSplit === -1) {
    scheme = "http";
    rest = trimmed;
  } else {
    scheme = trimmed.slice(0, schemeSplit).toLowerCase();
    rest = trimmed.slice(schemeSplit + 3);
  }
  if (scheme !== "http" && scheme !== "https") {
    throw new Error(`The address must start with http:// or https:// — ${OLLAMA_URL_SHAPE}.`);
  }
  const authority = rest.split(/[/?#]/)[0] ?? "";
  // Split an optional :port off the end; an IPv6 literal keeps its brackets.
  const colonIndex = authority.lastIndexOf(":");
  let host: string;
  let port: string | null;
  if (colonIndex !== -1 && !authority.slice(colonIndex + 1).includes("]")) {
    host = authority.slice(0, colonIndex);
    port = authority.slice(colonIndex + 1);
  } else {
    host = authority;
    port = null;
  }
  const hostOk =
    host.length > 0 &&
    [...host].every((c) => /^[a-zA-Z0-9]$/.test(c) || c === "." || c === "-" || c === "_" || c === "[" || c === "]" || c === ":");
  let portOk: boolean;
  if (port === null) {
    portOk = true;
  } else {
    portOk = /^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535;
  }
  if (!hostOk || !portOk) {
    throw new Error(`"${trimmed}" is not a server address — ${OLLAMA_URL_SHAPE}.`);
  }
  return `${scheme}://${rest.replace(/\/+$/, "")}`;
}

/**
 * D10: point Ollama at a remote base URL ("closet supercomputer") and persist
 * it for this room, or clear it when empty. The address is checked and
 * normalized FIRST, so a rejected one never reaches the override or the
 * room's settings. Ported verbatim from `set_ollama_url` — including the one
 * asymmetry the Rust source itself has: the runtime override applies
 * regardless of whether a room is open, but the SETTING is only persisted
 * when one is (`db` may be `null`, matching `state.room.lock().unwrap()
 * .as_ref()`'s `None` branch being a silent no-op rather than a refusal).
 */
export function setOllamaUrl(db: Database.Database | null, url: string): void {
  const normalized = normalizeOllamaUrl(url);
  setBaseUrlOverride(normalized === "" ? null : normalized);
  if (db !== null) {
    setSetting(db, "remote_ollama_url", normalized);
  }
}

/**
 * A small private duplicate of the same `/models` POST `engineRouting.ts`'s
 * `listModels` makes, needed for the SAME reason `ollamaModels.ts`'s own
 * `rawListModels` exists (see that function's doc): `listModels` folds every
 * failure into `[]`, but {@link testOllamaUrl} needs the raw Ok/Err split to
 * report "reached, but empty" and "could not reach" as the two DIFFERENT
 * sentences Rust's `list_models().await` match produces. Not a second public
 * list-models API — a second small private one, exactly like
 * `ollamaModels.ts`'s.
 */
async function rawListModels(): Promise<string[]> {
  const base = await ensureUp();
  const guard = busy();
  try {
    const resp = await fetch(`${base}/models`, {
      method: "POST",
      headers: { ...authedHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ base_url: resolvedBaseUrl() }),
    });
    if (!resp.ok) {
      throw new Error(`sidecar /models status ${resp.status}`);
    }
    const value: unknown = await resp.json();
    const models =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>).models
        : undefined;
    return Array.isArray(models) ? models.filter((m): m is string => typeof m === "string") : [];
  } finally {
    guard.release();
  }
}

/**
 * D10: save the remote-Ollama address and then actually TRY it, reporting
 * what happened in one sentence. Ported verbatim from `test_ollama_url`.
 */
export async function testOllamaUrl(db: Database.Database | null, url: string): Promise<string> {
  setOllamaUrl(db, url);
  const where = resolvedBaseUrl();
  let models: string[];
  try {
    models = await rawListModels();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not reach ${where}: ${message}`);
  }
  if (models.length === 0) {
    return `Reached ${where}, but it has no models installed — nothing there can answer yet.`;
  }
  return `✓ Reached ${where} — ${models.length} model${models.length === 1 ? "" : "s"} available.`;
}

/** D10: the room's saved remote-Ollama URL (empty = use the local default).
 * Ported verbatim from `get_ollama_url`. */
export function getOllamaUrl(db: Database.Database | null): string {
  if (db === null) {
    return "";
  }
  return getSetting(db, "remote_ollama_url") ?? "";
}

// ============================================================================
// IPC registration — NOT wired into a live bootstrap (rule 4 / recIpc.ts)
// ============================================================================

export const NO_ROOM_OPEN = "No room is open.";

/** Register every `server.rs` channel on `ipcMain`. Channel names are the
 * Rust `#[tauri::command]` names verbatim, so a renderer needs no rename. */
export function registerMoonshotServerIpc(
  ipcMain: Pick<IpcMain, "handle">,
  roomSource: RoomServerRoomSource,
  slot: RoomServerSlot,
  deps: SetRoomServerDeps = defaultSetRoomServerDeps
): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R): void => {
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: A) => fn(...args));
  };
  const requireRoom = (): { path: string; name: string; db: Database.Database } => {
    const room = roomSource.currentRoom();
    if (room === null) {
      throw new Error(NO_ROOM_OPEN);
    }
    return room;
  };
  const dbOrNull = (): Database.Database | null => roomSource.currentRoom()?.db ?? null;

  handle("room_server_status", () => roomServerStatus(slot));
  handle("set_room_server", (args: SetRoomServerArgs) => {
    const room = requireRoom();
    return setRoomServer(room.db, room.path, room.name, args, slot, roomSource, deps);
  });
  handle("regenerate_leash_token", () => {
    const room = requireRoom();
    return regenerateLeashToken(room.db, room.path, room.name, slot, roomSource, deps);
  });
  handle("set_ollama_url", (args: { url: string }) => setOllamaUrl(dbOrNull(), args.url));
  handle("test_ollama_url", (args: { url: string }) => testOllamaUrl(dbOrNull(), args.url));
  handle("get_ollama_url", () => getOllamaUrl(dbOrNull()));
}
