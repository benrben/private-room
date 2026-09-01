/** Cohesive extraction from execTool.ts; its public API remains on that module. */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { webAccessEnabled } from "./browser/webAccess.js";
import {
  addMemory,
  deleteMemory,
  listMemories,
  memoriesLike,
  updateMemory,
  type Memory,
} from "./db-host/memories.js";
import {
  createSkill as createSkillDb,
  deleteSkillResource as deleteSkillResourceDb,
  findSkill as findSkillDb,
  getSkillResource as getSkillResourceDb,
  listSkillResources as listSkillResourcesDb,
  listSkills as listSkillsDb,
  setSkillEnabled as setSkillEnabledDb,
  updateSkill as updateSkillDb,
  upsertSkillResource as upsertSkillResourceDb,
} from "./db-host/skills.js";
import { agentDeleteSkill, agentSaveSkill } from "./skillsCmds.js";
import {
  execAnnotateFile,
  execListRoomFiles,
  execOpenFile,
  execSearchRoom,
} from "./fileTools.js";
import {
  execDraw,
  execDrawInRoom,
  execReadDrawing,
  execReadDrawingInRoom,
  type SketchRoom,
} from "./sketchCommands.js";
import { execViewFileImage } from "./staticVisualTools.js";
import {
  agentDeleteMcp,
  agentListMcps,
  agentReadMcp,
  agentSaveMcp,
} from "./mcpConfig.js";
import type { ServerConfig } from "./mcpClient.js";
import {
  execCreateFile,
  execMarkImage,
  execMergeFiles,
  execMoveFile,
  execOrganizeFiles,
  execRenameFile,
  execSetInLibrary,
  execTrashFiles,
} from "./organizeTools.js";
import {
  DOWNLOAD_ENGINE_MEDIA,
  startDownloadJobInner,
  type DownloadJobDeps,
} from "./jobDownload.js";
import { makeRunAdvisorCli, realRunAdvisorCli, type RunExternalOptions } from "./externalAdvisor.js";
import {
  agentDeleteWorkflow,
  agentListWorkflows,
  agentRunWorkflow,
  agentSaveWorkflow,
  agentTestWorkflow,
  agentUpdateWorkflow,
  type AgentTestWorkflowDeps,
} from "./workflowRuns.js";
import { DELETE_DECLINED } from "./mcpConfig.js";
import { getFreshWebPage, getFreshWebSearch, putWebSearch, saveWebPage } from "./db-host/webCache.js";
import { blockedNote, fetchPage, joinNames, renderHits, searchWeb, type FetchedPage, type SearchPage } from "./web.js";
import { fetchPageReply } from "./fetchPageWindow.js";
import { maskOutboundWeb as privacyMaskOutboundWeb, outboundUrlHides, webMaskNote } from "./privacy.js";
import { clampBytes, clampBytesMarked, normalizeForMatch } from "./textClamp.js";
import {
  BUILTIN_TOOL_NAMES,
  MAX_ADVISOR_CALLS,
  MAX_MEMORY_CONTENT_CHARS,
  MAX_LISTED_MEMORIES,
  SKILL_AGENT_IDS,
  isBrowseTool,
  maskedArgsNote,
  masksOutboundArgs,
  type McpRoute,
} from "./toolSpecs.js";
import { missingRequiredArg } from "./toolSchema.js";
import { mindmapSpec, RUN_STUDIO_PIPELINE_GAP as RUN_STUDIO_PIPELINE_GAP_MINDMAP } from "./studiosMindmap.js";
import { EXEC_STUDIO_FLASHCARDS_GAP, execStudioFlashcards } from "./studiosFlashcards.js";
import { execStudio, type RunStudioDeps, type StudioSpec } from "./studiosCmds.js";
import { podcastSpec, RUN_STUDIO_PIPELINE_GAP as RUN_STUDIO_PIPELINE_GAP_PODCAST } from "./studiosPodcast.js";
import { withRealAdvisorCli, withRealPrivacyGates } from "./execToolAdvisor.js";
import { execTool } from "./execToolDispatch.js";
// ------------------------------------------------------------------ ToolEffects

/**
 * Viewer payloads and turn-level bookkeeping tool calls accumulate during a
 * turn. Ported field-for-field from the Rust `ToolEffects` struct. Every
 * field is kept even though most are never SET by a real arm in this batch
 * (they are still read/written by {@link effectsJson} and by
 * `bridgeDispatcher.ts`'s wrapper, which is what actually needs the shape
 * to exist and be correct).
 */
export interface ToolEffects {
  boxes: unknown | null;
  annotation: unknown | null;
  /** CHG-10: true when a write tool succeeded this turn — the deterministic
   * ground truth for the anti-fabrication gate (`claimsUnbackedAction`). */
  wrote: boolean;
  /** CHG-33: true when web_search hit a rate-limit/human-check this turn. */
  webSearchThrottled: boolean;
  /** ADD-21: cloud-advisor consults spent this turn, capped at
   * `MAX_ADVISOR_CALLS`. */
  advisorCalls: number;
  /** ADD-25: base64 PNGs captured this round. */
  pendingImages: string[];
  /** Exact locally-extracted video frames used by a model this turn. The
   * encrypted message effects retain the timestamp/hash receipt, not pixels. */
  mediaFrames: MediaFrameReceipt[];
  /** ADD-25: whether the chat model can read attached images. */
  visionChat: boolean;
  /** Wave 2 (Idea 4): content-free per-edit outcome records for this turn. */
  editOutcomes: unknown[];
  /** Wave 2 (Idea 6): true only on the run-scoped LocalEngine sink. */
  runScoped: boolean;
  /** Wave 2 (Idea 6): "Apply for the rest of this answer" was chosen. */
  editApprovedThisTurn: boolean;
  /** Token-budget bar: this turn's usage snapshot, or `null`. */
  tokenUsage: unknown | null;
  /** Dispatch-first agent visibility: this turn's agent roster, or `null`. */
  agentPlan: unknown | null;
}

export interface MediaFrameReceipt {
  fileName: string;
  requestedAt: string;
  actualSeconds: number;
  sha256: string;
  width: number;
  height: number;
}

/** A fresh, all-default `ToolEffects` — the TS analogue of Rust's
 * `#[derive(Default)]`. */
export function createToolEffects(): ToolEffects {
  return {
    boxes: null,
    annotation: null,
    wrote: false,
    webSearchThrottled: false,
    advisorCalls: 0,
    pendingImages: [],
    mediaFrames: [],
    visionChat: false,
    editOutcomes: [],
    runScoped: false,
    editApprovedThisTurn: false,
    tokenUsage: null,
    agentPlan: null,
  };
}

/**
 * ADD-23: the message-row `effects` JSON for this turn's tool effects, or
 * `null` when nothing worth persisting fired — so the column stays NULL for
 * plain answers. Ported verbatim from `effects_json`.
 */
export function effectsJson(effects: ToolEffects): Record<string, unknown> | null {
  if (!hasPersistedEffects(effects)) return null;
  const map: Record<string, unknown> = {};
  addNullableEffect(map, "boxes", effects.boxes);
  addNullableEffect(map, "annotation", effects.annotation);
  addListEffect(map, "edits", effects.editOutcomes);
  addListEffect(map, "mediaFrames", effects.mediaFrames);
  addNullableEffect(map, "usage", effects.tokenUsage);
  addNullableEffect(map, "agents", effects.agentPlan);
  return map;
}

export function hasPersistedEffects(effects: ToolEffects): boolean {
  return hasVisualEffects(effects) || effects.tokenUsage !== null || effects.agentPlan !== null;
}

export function hasVisualEffects(effects: ToolEffects): boolean {
  return (
    effects.boxes !== null ||
    effects.annotation !== null ||
    effects.editOutcomes.length > 0 ||
    effects.mediaFrames.length > 0
  );
}

export function addNullableEffect(map: Record<string, unknown>, key: string, value: unknown | null): void {
  if (value !== null) map[key] = value;
}

export function addListEffect(map: Record<string, unknown>, key: string, value: readonly unknown[]): void {
  if (value.length > 0) map[key] = value;
}

// --------------------------------------------------------------- ToolOutcome

/** `exec_tool`'s `Result<String, String>`, as a discriminated union. `ok:
 * false` is a genuine tool FAILURE (what the Rust source's `Err(String)`
 * meant) — `bridgeDispatcher.ts` turns this into an MCP `isError: true`
 * result, never a JSON-RPC-level crash. */
export type ToolOutcome = { ok: true; text: string } | { ok: false; error: string };

export function ok(text: string): ToolOutcome {
  return { ok: true, text };
}

export function fail(error: string): ToolOutcome {
  return { ok: false, error };
}

/**
 * A clearly-labeled "this tool exists in the catalog but this rewrite has
 * not wired its real logic yet" result — never a silent success, never a
 * thrown exception. `reason` names the subsystem/batch that owns the real
 * implementation, so a caller (or a person reading a transcript) can tell
 * "not built yet" apart from "the model's arguments were wrong" apart from
 * "the room genuinely has none".
 */
export function notImplemented(reason: string): ToolOutcome {
  return fail(`NOT_IMPLEMENTED: ${reason}`);
}

// ------------------------------------------------------------------------ deps

/** Everything a real arm in this batch needs. Everything else (files,
 * retrieval, edit_match, the UI bridge, browse, scripts, studios,
 * skills commands, MCP management, jobs/workflows, local_generate, the
 * external-CLI advisor call, and live connector dispatch) is out of scope —
 * see the module doc — so `deps` carries only what {@link execTool}'s REAL
 * arms use. (`draw`/`read_drawing` are real too, against
 * `sketchCommands.ts` — they need only `deps.db` and `deps.emit`, already
 * on this list.) */
export interface ExecToolDeps {
  /** The open room's connection, or `null` when no room is open (mirrors
   * `state.room.lock().unwrap().as_ref().ok_or("No room is open.")`). */
  db: Database.Database | null;
  /** Live folder-room handle for tools that need the normal-file source of truth. */
  currentRoom?: () => SketchRoom | null;
  /**
   * The Stop flag `tool_cancel_for` resolved for this call (`bridgeDispatcher.ts`
   * always computes and threads this through, matching the Rust source's
   * `exec_tool(..., cancel: Option<Arc<AtomicBool>>, ...)` parameter).
   *
   * `create_file` is the one arm reading it today — the ART-1 staging funnel
   * reads the flag BETWEEN staging and committing, so the live object is what
   * gets handed over, never a boolean snapshot taken here. The other
   * write-side effects that would read it (`gated_write`'s commit gate,
   * `run_script`'s wait) still live in subsystems stubbed as
   * `NOT_IMPLEMENTED`; the seam is threaded through for all of them so a
   * future batch's real arm has it already wired rather than needing every
   * call site touched again.
   */
  cancel?: { load(): boolean } | null;
  /**
   * `turn.map(|t| t.run_id())` — the run this call belongs to, recorded in the
   * provenance of anything it writes so History can say which answer produced
   * a file. `create_file` is its only reader so far.
   *
   * `undefined`/`null` are NOT a gap this port introduces: they are Rust's own
   * `turn: None` path, which is what a tool dispatched by the persistent room
   * bridge (the one caller wired today, `bridgeDispatcher.ts`) genuinely has.
   * The seam is threaded now for the same reason {@link ExecToolDeps.cancel}
   * was, so the chat/turn path can supply it without every call site being
   * touched again.
   */
  runId?: string | null;
  /** Best-effort UI notification for a room mutation the user may be looking
   * at (`window.emit("memories-changed", ())`). Optional and swallowed on
   * failure, exactly like the Rust source's `let _ = window.emit(...)`. */
  emit?: (event: string, payload: unknown) => void;
  /** The connected MCP tools this turn may dispatch to — the default arm's
   * (`other => match routes...`) lookup table. Real connector dispatch
   * (the actual client call, the consent gate, the outbound redaction seam)
   * is not ported — see {@link ExecToolDeps.callConnectorTool}. */
  routes: readonly McpRoute[];
  /**
   * The actual "call this connector's tool" side effect. `undefined` (the
   * default posture, and what every test but its own exercises) makes a
   * matched route resolve to {@link notImplemented} rather than crashing or
   * fabricating a result — the MCP client/consent-gate subsystem
   * (`mcp_call_approved`, `route.client.call_tool`) is a separate,
   * not-yet-ported system.
   */
  callConnectorTool?: (route: McpRoute, args: Record<string, unknown>) => Promise<ConnectorReply>;
  /**
   * `outbound_unmask_for(state, server_name)` — whether THIS connector may see
   * the room's real values. Read per connector since the 2026-08-03 split:
   * "may run unattended" says nothing about "may carry real text". Injected
   * because the setting lives in the not-yet-ported connector manager;
   * `undefined` means "not configured", which {@link masksOutboundArgs} treats
   * exactly as Rust's `false` does — masking ON for a remote connector.
   */
  outboundUnmaskFor?: (serverName: string) => boolean;
  /**
   * The outbound-remote redaction seam (`remote_seam_redactor`). Masks the
   * room's known entities in a REMOTE connector's arguments on the way out and
   * restores them in the result on the way home. `undefined` while the privacy
   * subsystem is unported — which is why {@link execTool}'s connector arm
   * REFUSES a masked call outright rather than sending unmasked arguments. See
   * that arm's comment.
   *
   * WHEN BATCH D WIRES THIS: `undefined` here means "the seam does not exist",
   * NOT "the seam has nothing to hide". Rust's `remote_seam_redactor()` returns
   * `Option<..>` and answers `None` for an EMPTY entity map, in which case the
   * call proceeds with real (and identical) arguments. Mapping that `Option`
   * straight onto `RemoteSeam | undefined` would make this arm refuse every
   * remote connector call in every room with no protected names — which is
   * most rooms. The empty-map case must arrive as a real seam whose
   * `redactValue` returns the value unchanged with `entitiesHidden: 0`.
   */
  remoteSeam?: RemoteSeam;
  /**
   * SEC-1b: ask the user before a connector's tool runs, unless they chose
   * "always allow" for it earlier this session (`mcp_call_approved`). Injected;
   * `undefined` means no consent surface exists yet, and the connector arm
   * refuses rather than running ungated.
   */
  connectorApproved?: (route: McpRoute, sentArgs: Record<string, unknown>) => Promise<boolean>;
  /**
   * ADD-21: actually run the chosen advisor CLI (`run_external` spawning
   * `claude -p` / `codex exec`) and return its answer. `undefined` means no
   * caller filled the seam in, and `consult_advisor` then refuses rather than
   * fabricating an advisor's reply.
   *
   * The subprocess itself IS ported — `externalAdvisor.ts`'s `runExternalCli`,
   * with its shell-safety gate, privacy door, image staging and
   * kill-on-cancel. {@link withRealAdvisorCli} is the one-line way to install
   * it. What is still missing is only a HOST BOOTSTRAP that builds the deps
   * through that helper; until one exists this stays `undefined` in every real
   * app path, which is why the refusal below is still the honest answer.
   */
  runAdvisorCli?: (engine: "claude-cli" | "codex-cli", question: string) => Promise<string>;
  /**
   * `confirm_destructive` — ask the user before the agent destroys something
   * with no undo (a connector deletion erases its saved OAuth token with
   * it). `undefined` means no consent dialog is wired yet, so `delete_mcp`
   * refuses rather than deleting behind a confirmation the user never saw
   * (`delete_skill`, just above it in the dispatch below, is stubbed for the
   * exact same missing seam). Shaped after `mcp_cmds.rs`'s own
   * `confirm_destructive(state, window, what, name, detail)`.
   */
  confirmDestructive?: (what: string, name: string, detail: string) => Promise<boolean>;
  /**
   * `state.mcp.lock().unwrap().statuses()`, reduced to what `agent_list_mcps`
   * reads: a connector NAME -> live status string (e.g. "connected",
   * "failed"). `undefined`/a name missing from the map degrades exactly like
   * Rust's own fallback — every enabled connector reads "configured" rather
   * than a live state — because no persistent, app-wide `McpManager`
   * (`mcpClient.ts`) is wired into a running app yet in this migration.
   */
  mcpStatuses?: ReadonlyMap<string, string>;
  /**
   * `forget_connector_grants` — clears this Mac's per-connector standing
   * permissions ("run without asking" / "send real values") for one
   * connector after `save_mcp` retargets it or `delete_mcp` removes it. Per-
   * Mac file I/O (`mcp_connector_powers.json`) outside any room: the store
   * itself IS ported (`mcpConfig.ts`'s `forgetConnectorGrants`), but it needs
   * the app's `userDataDir` and the process's session-grant set, which an
   * `exec_tool` arm has neither of — hence the seam. `undefined` silently
   * skips the extra sentence a real store would add to the reply — harmless,
   * since nothing in this migration can yet have granted such a permission
   * for it to clear.
   */
  mcpForgetConnectorGrants?: (server: string) => { cleared: boolean };
  /**
   * `start_mcp_connections` — kick off a live reconnect off the servers
   * `save_mcp`/`delete_mcp` just wrote. `undefined` means no live Manager to
   * refresh yet (same gap as {@link ExecToolDeps.mcpStatuses}); harmless
   * here because every connector `save_mcp` writes is saved DISABLED
   * regardless (`mcpConfig.ts`'s own SEC-1 property), so nothing runs or
   * reaches the network until a human reviews and enables it in Connectors
   * either way.
   */
  mcpReconnect?: (servers: ReadonlyArray<[string, ServerConfig]>) => void;
  /**
   * `outbound_url_refusal` (agent.rs) — `privacy::outbound_url_hides` behind a
   * refusal sentence. Every fetch/download/save tool checks a URL against the
   * room's protected-name block list before it ever reaches the network, so
   * that a URL built to exfiltrate a hidden name (e.g. embedded in a query
   * string) cannot leave this Mac while Cloud privacy is on. Returns the
   * refusal SENTENCE (never throws), or `null` when the URL is clean.
   *
   * `undefined` means NOTHING HAS INSTALLED the check on this deps object, and
   * every arm that needs it then REFUSES rather than skipping it. The check
   * itself is NOT missing: `privacy.ts` is committed and exports
   * `outboundUrlHides`/`percentDecode`, and {@link withRealPrivacyGates} fills
   * this field with the real thing in one line. What is still absent is only a
   * host bootstrap that builds its deps through that helper.
   */
  outboundUrlRefusal?: (url: string) => string | null;
  /**
   * PRIV-4 (`privacy.rs`'s `mask_outbound_web`/`web_mask_note`): mask the
   * room's protected names out of a `web_search` QUERY before it leaves this
   * Mac for seven search engines, and report the fact in the tool result.
   * The door restores placeholders in a cloud model's tool arguments so ROOM
   * tools see real values — but this argument does not stay on the Mac, so
   * it has to be masked back out at exactly this seam.
   *
   * `undefined` is the same "nothing installed it" gap
   * {@link ExecToolDeps.outboundUrlRefusal} documents, answered the same way:
   * `web_search` REFUSES (a `NOT_IMPLEMENTED` result) rather than silently
   * sending an unmasked query, and {@link withRealPrivacyGates} installs
   * `privacy.ts`'s real `maskOutboundWeb`/`webMaskNote`.
   *
   * A URL cannot take the analogous seam — a masked placeholder in a path or
   * query string just 404s — which is why `fetch_page` reuses
   * {@link ExecToolDeps.outboundUrlRefusal} instead, exactly as
   * `download_media` does and for the reason the Rust arm gives.
   *
   * Returns the masked query and its user-facing disclosure note, or `null`
   * when nothing needed masking (no note to add).
   */
  maskOutboundWeb?: (query: string) => { query: string; note: string } | null;
  /**
   * The real job-queue wiring `download_media` dispatches through —
   * `jobDownload.ts`'s `DownloadJobDeps`: the shared job-queue slot/room/sink/
   * cancel registry plus yt-dlp's data dir and the room's import funnel. The
   * room the job is written to and pinned against is read from that bundle's
   * own `rooms` source at creation time, exactly as Rust's
   * `state.with_room(…)` does — never a separately-supplied path that could
   * disagree with the room actually open. `undefined` (every test but its own)
   * means no host bootstrap has wired an app-wide job queue into execTool
   * yet — the same gap every other unwired seam in this file
   * (`callConnectorTool`, `remoteSeam`, …) documents.
   *
   * WIRING HAZARD for whichever host bootstrap fills this in: the bundle's
   * `starters` map MUST carry `["download", downloadRowStarter(engineDeps)]`.
   * `startDownloadJobInner` starts the runner ITSELF only when the single
   * heavy-work slot is free; when it is busy the row is left 'queued', and the
   * later `pump` resolves it through that map. With no "download" entry
   * `jobQueue.ts` falls back to `notImplementedRowStarter`, which poisons the
   * row — so a download would work when the app is idle and fail when it is
   * busy, which is the worst possible shape for the bug to take.
   */
  downloadJob?: DownloadJobDeps;
  /**
   * `workflowRuns.ts`'s run glue: the app-wide job queue + room script-approvals
   * dir that `run_workflow` (`agent_run_workflow`) and `test_workflow`
   * (`agent_test_workflow`) dispatch through, and whose `cancelState`
   * `delete_workflow` uses to signal an in-flight job before its row goes.
   * Mirrors {@link ExecToolDeps.downloadJob} exactly: `undefined` (every test
   * but its own) means no host bootstrap has wired a job queue into execTool
   * yet, so those two arms refuse with `NOT_IMPLEMENTED` rather than silently
   * no-op'ing, and `delete_workflow` still deletes but cannot first signal a
   * running job's runner to stop (the same best-effort posture
   * `deleteWorkflowCmd` documents for a caller with no `cancelState` at all).
   *
   * `AgentTestWorkflowDeps` is `WorkflowRunDeps` plus `test_workflow`'s own
   * poll cadence, so ONE bundle serves all three arms.
   *
   * WIRING HAZARD for whichever host bootstrap fills this in: the bundle's
   * `starters` map should carry `["workflow", workflowRowStarter(engineDeps)]`
   * — the same hazard {@link ExecToolDeps.downloadJob}'s doc names for the
   * download kind. `startWorkflowRun` fills a MISSING entry in for the run it
   * starts itself (`workflowQueueDeps`), but a `pump()` driven from anywhere
   * else uses whatever map that caller built, and with no "workflow" entry
   * `jobQueue.ts` falls back to `notImplementedRowStarter`, which poisons the
   * row — so a workflow would work when the app is idle and fail when it is
   * busy, the worst possible shape for the bug to take.
   */
  workflowRun?: AgentTestWorkflowDeps;
  /**
   * `studiosCmds.ts`'s `RunStudioDeps` — the live `RoomSource` (the app's
   * actually-open room) plus the app-wide cancel-tree `CancelState`
   * `studiosFlashcards.ts`'s `execStudioFlashcards` needs to run the real,
   * tested `runStudio` pipeline. Mirrors {@link ExecToolDeps.downloadJob}
   * exactly: `undefined` (every test but its own) means no host bootstrap has
   * wired an app-wide room/cancel-tree into execTool yet, so
   * `studio_flashcards` refuses with `NOT_IMPLEMENTED` rather than
   * fabricating a saved deck — see `studiosFlashcards.ts`'s own
   * `EXEC_STUDIO_FLASHCARDS_GAP` doc for exactly what that means and why.
   *
   * Deliberately the SAME bundle {@link studioFlashcards} (a future
   * Tauri-command-equivalent IPC handler) would also take — one live
   * `RunStudioDeps`, not a second per-tool copy — so a host bootstrap that
   * builds one wires both the button and the agent tool from it.
   */
  runStudioDeps?: RunStudioDeps;
  /** Live renderer driver for app controls, screenshots, and staged media frames. */
  agentUi?: (
    kind: "ui_snapshot" | "ui_act" | "view_screenshot" | "media_frame",
    args: Record<string, unknown>
  ) => Promise<unknown>;
  /** App-wide implementations for tool arms whose engines live in host
   * surfaces (browser, scripts, extraction, STT and durable jobs). Returning
   * `null` means this runtime does not own the requested tool. */
  runtimeTool?: (
    name: string,
    args: Record<string, unknown>,
    effects: ToolEffects,
  ) => Promise<ToolOutcome | null>;
}

/** What an injected connector call returns: the tool's text plus any images it
 * produced. Mirrors `mcp::Client::call_tool`'s `{text, images}`. */
export interface ConnectorReply {
  text: string;
  images?: readonly string[];
}

/** The outbound-remote redaction seam, restricted to what the connector arm
 * needs (`Redactor::redact_value` on the way out, `Redactor::restore` on the
 * way home). */
export interface RemoteSeam {
  redactValue(value: Record<string, unknown>): {
    value: Record<string, unknown>;
    entitiesHidden: number;
  };
  restore(text: string): string;
}

export const NO_ROOM_OPEN = "No room is open.";

/** `state.room.lock().unwrap().as_ref().ok_or("No room is open.")` as a value.
 * Every real arm below goes through this rather than reading `deps.db`
 * directly, so "no room is open" is one sentence in one place. */
export function requireRoom(deps: ExecToolDeps):
  | { ok: true; db: Database.Database; room: SketchRoom | null }
  | { ok: false; error: string } {
  const live = deps.currentRoom?.() ?? null;
  const db = live?.db ?? deps.db;
  if (db === null) {
    return { ok: false, error: NO_ROOM_OPEN };
  }
  return { ok: true, db, room: live };
}

/** `let _ = window.emit(...)` — a best-effort UI notification that must never
 * turn a successful room mutation into a failed tool call. */
export function emitSafely(deps: ExecToolDeps, event: string, payload: unknown): void {
  try {
    deps.emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = window.emit(...)`.
  }
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
