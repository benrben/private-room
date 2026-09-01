/** Persistent room MCP-server orchestration (the Leash).
 *
 * This module binds the existing Node HTTP bridge, persists scope/identity,
 * manages discovery, and keeps the explicit dispatcher-construction refusal.
 * Remote Ollama address handling (the Closet) lives in `moonshotOllama.ts`.
 * These are user-facing IPC commands, never model-invocable tools.
 */

import { randomUUID } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";

import { getSetting, setSetting } from "./db-host/settings.js";
import { removeDiscovery, writeDiscovery } from "./moonshotDiscovery.js";
import { webAccessEnabled } from "./gatherContext.js";
import { McpBridge } from "./mcpBridge.js";
import type { ToolDispatcher, ToolScope } from "./mcpBridge.js";
import type { WebLanes } from "./toolSpecs.js";
import {
  getOllamaUrl,
  setOllamaUrl,
  testOllamaUrl,
} from "./moonshotOllama.js";

export {
  getOllamaUrl,
  normalizeOllamaUrl,
  setOllamaUrl,
  testOllamaUrl,
} from "./moonshotOllama.js";

/** Wire shape polled by the Settings screen. */
export interface RoomServerStatus {
  running: boolean;
  url: string;
  config: string;
  /** `"files"` | `"full"`. */
  scope: string;
  stable: boolean;
  allowCloud: boolean;
}

/** Default fixed port for the full tier. */
export const LEASH_DEFAULT_PORT = 17872;

/** Map persisted scope to the safe bridge tier unless `full` is explicit. */
export function leashScope(setting: string | null | undefined, allowCloud: boolean): ToolScope {
  if (setting === "full") {
    return { kind: "ExternalAgent" };
  }
  return { kind: "CloudAdvisor", includeMcp: allowCloud };
}

/** The wire name of a bridge scope. */
export function scopeName(scope: ToolScope): string {
  return scope.kind === "ExternalAgent" ? "full" : "files";
}

/** Compare both the tier and its cloud-advisor MCP option. */
function toolScopeEquals(a: ToolScope, b: ToolScope): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "CloudAdvisor" && b.kind === "CloudAdvisor") {
    return a.includeMcp === b.includeMcp;
  }
  return true;
}

/** A v4 UUID in the Rust `simple()` representation. */
function simpleUuid(): string {
  return randomUUID().replace(/-/g, "");
}

/** Parse a persisted port using the Rust `u16` boundary. */
function parseStoredPort(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) {
    return null;
  }
  const n = Number(raw);
  return n <= 65535 ? n : null;
}

/** Read or create the full tier's stable persisted port and token. */
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

/** Read both web lanes; absent settings retain the historical enabled default. */
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
  const makeBridge = () => newRoomMcpBridge(opts, token);
  const bound = await bindRoomMcpBridge(makeBridge, opts.port);
  return runningRoomBridge(bound.bridge, token, opts.scope, bound.stable);
}

function newRoomMcpBridge(opts: CreateRoomBridgeOptions, token: string): McpBridge {
  return new McpBridge({
    token,
    scope: opts.scope,
    dispatcher: opts.dispatcher,
    serverVersion: opts.serverVersion,
  });
}

interface BoundRoomMcpBridge {
  bridge: McpBridge;
  stable: boolean;
}

async function bindRoomMcpBridge(makeBridge: () => McpBridge, port: number | undefined): Promise<BoundRoomMcpBridge> {
  if (port === undefined) return bindEphemeralRoomMcpBridge(makeBridge);
  const fixed = await bindFixedRoomMcpBridge(makeBridge, port);
  if (fixed !== null) return { bridge: fixed, stable: true };
  return bindEphemeralRoomMcpBridge(makeBridge);
}

async function bindFixedRoomMcpBridge(makeBridge: () => McpBridge, port: number): Promise<McpBridge | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = makeBridge();
    try {
      await candidate.listen(port);
      return candidate;
    } catch {
      await sleep(50);
    }
  }
  return null;
}

async function bindEphemeralRoomMcpBridge(makeBridge: () => McpBridge): Promise<BoundRoomMcpBridge> {
  const bridge = makeBridge();
  await bridge.listen(0);
  return { bridge, stable: false };
}

function runningRoomBridge(started: McpBridge, token: string, scope: ToolScope, stable: boolean): RunningBridge {
  const boundPort = started.port;
  if (boundPort === null) {
    throw new Error("mcp bridge bind failed: no address");
  }
  return {
    port: boundPort,
    token,
    scope,
    stable: stable,
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

interface RoomServerStartContext {
  webEnabled: boolean;
  scope: ToolScope;
  options: Parameters<BridgeStarter>[2];
}

function persistRoomServerSettings(db: Database.Database, args: SetRoomServerArgs): boolean {
  const wantFull = args.scope === "full";
  setSetting(db, "room_server_enabled", args.enabled ? "1" : "0");
  setSetting(db, "room_server_scope", wantFull ? "full" : "files");
  return wantFull;
}

function fullTierBridgeIdentity(db: Database.Database, wantFull: boolean): { port?: number; token?: string } {
  if (!wantFull) return {};
  const identity = leashIdentity(db);
  return { port: identity.port, token: identity.token };
}

function requestedRoomServerScope(wantFull: boolean, allowCloud: boolean): ToolScope {
  if (wantFull) return leashScope("full", allowCloud);
  return leashScope("files", allowCloud);
}

function roomServerStartContext(
  db: Database.Database,
  wantFull: boolean,
  allowCloud: boolean
): RoomServerStartContext {
  const identity = fullTierBridgeIdentity(db, wantFull);
  return {
    webEnabled: webAccessEnabled(db),
    scope: requestedRoomServerScope(wantFull, allowCloud),
    options: { ...identity, lanes: webLanesFromSettings(db) },
  };
}

interface RoomBridgeAction {
  kept: boolean;
  existing: RunningBridge | null;
}

function roomBridgeAction(slot: RoomServerSlot, wanted: ToolScope): RoomBridgeAction {
  const current = slot.bridge;
  if (current === null) return { kept: false, existing: null };
  if (toolScopeEquals(current.scope, wanted)) return { kept: true, existing: null };
  slot.bridge = null;
  return { kept: false, existing: current };
}

async function startRequestedRoomBridge(
  roomPath: string,
  roomName: string,
  slot: RoomServerSlot,
  roomSource: RoomServerRoomSource,
  deps: SetRoomServerDeps,
  context: RoomServerStartContext
): Promise<void> {
  const action = roomBridgeAction(slot, context.scope);
  if (action.kept) return;
  if (action.existing !== null) await action.existing.stopAndWait();
  const bridge = await deps.startBridge(context.webEnabled, context.scope, context.options);
  if (!storeBridgeIfCurrent(roomSource, slot, roomPath, bridge)) return;
  updateRoomBridgeDiscovery(deps, bridge, roomName);
}

function updateRoomBridgeDiscovery(deps: SetRoomServerDeps, bridge: RunningBridge, roomName: string): void {
  if (bridge.scope.kind !== "ExternalAgent") {
    deps.removeDiscovery();
    return;
  }
  try {
    deps.writeDiscovery(bridge.port, bridge.token, scopeName(bridge.scope), roomName);
  } catch {
    // Best-effort, matching Rust's `let _ = write_discovery(...)`.
  }
}

function stopRequestedRoomBridge(slot: RoomServerSlot, deps: SetRoomServerDeps): void {
  const bridge = slot.bridge;
  slot.bridge = null;
  if (bridge !== null) bridge.stop();
  deps.removeDiscovery();
}

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
  const wantFull = persistRoomServerSettings(db, args);
  const context = roomServerStartContext(db, wantFull, args.allowCloud);
  if (args.enabled) {
    await startRequestedRoomBridge(roomPath, roomName, slot, roomSource, deps, context);
  } else {
    stopRequestedRoomBridge(slot, deps);
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
