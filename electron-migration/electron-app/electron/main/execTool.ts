/**
 * `exec_tool`'s OUTER SHELL — argument validation, the effects/usage
 * accounting wrapper, error shaping, and the dispatch structure (a name-keyed
 * match, faithfully mirroring how the Rust source does it), WITHOUT porting
 * every arm's real logic.
 *
 * Ported from `src-tauri/src/commands/agent.rs` lines ~3053-4803 (`exec_tool`
 * itself, ~1750 lines) plus the `ToolEffects` struct (lines ~3002-3051, just
 * above it) and `effects_json` (lines ~1538-1573).
 *
 * MOST ARMS ARE STUBS, and that is the honest state of the port rather than an
 * oversight. `exec_tool` dispatches into whole subsystems this rewrite has not
 * reached — `edit_match.rs`, the AgentUi screen-driving bridge, the private
 * browser's command surface, the Scripts/Studio/sketch/STT/
 * jobs-workflows/local-generate lanes, and the external-CLI advisor
 * subprocess. `web.rs` (and its `fetch`/`guard`/`search` submodules) is now
 * REAL — see `web_search`/`fetch_page` below — but `save_link`/`download_url`,
 * whose OWN arms reach further pieces of it plus `files.rs`'s
 * `import_link_and_index`, are not.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD: every name the tool catalog or an
 * `McpRoute` can produce reaches a NAMED arm. A stub returns a labeled
 * `NOT_IMPLEMENTED: …` naming the batch that owns it — never a thrown
 * exception that would crash the turn, never a fabricated success, and never
 * the `Unknown tool:` fallthrough, which is reserved for a name that is
 * genuinely neither a built-in nor a connected route. `execTool.test.ts`
 * proves it by DRIVING every catalog name through this function with
 * schema-satisfying arguments, not by comparing two hand-written lists.
 *
 * REAL ARMS (wired against already-committed modules):
 * - memories — `add_memory` / `list_memories` / `update_memory` /
 *   `delete_memory`, against `db-host/memories.ts`.
 * - skills — `list_skills` / `read_skill` / `read_skill_resource` /
 *   `save_skill` (fully, EXCEPT its `source_files` snapshot path) /
 *   `write_skill_resource` / `delete_skill_resource`, against
 *   `db-host/skills.ts`.
 * - `consult_advisor` — its budget cap, question validation and engine choice
 *   are real; only the subprocess is an injected seam.
 * - the connector route — real dispatch STRUCTURE with both of Rust's doors
 *   (outbound masking, SEC-1b consent) required rather than skipped.
 * - files, read side — `list_room_files` / `search_room` / `open_file` /
 *   `annotate_file`, against the now-committed `db-host/files.ts` and
 *   `db-host/retrieval.ts`; the arms themselves live in `fileTools.ts`.
 *   `search_room` degrades to keyword-only retrieval, because `embed_question`
 *   has no Electron port yet — see that file's own module doc for why that is
 *   the Rust arm's own no-embed-model path rather than a stand-in.
 * - the organize box — `mark_image` / `create_file` / `rename_file` /
 *   `move_file` / `set_in_library` / `organize_files` / `trash_files` /
 *   `merge_files`, against the already-committed `organize.ts` and
 *   `db-host/{files,folders,versions,artifacts}.ts`, plus `bulkReport.ts`
 *   (the `BulkReport::changed_anything`/`::sentence` helpers `organize.ts`'s
 *   own doc flags as the one piece of `commands/bulk.rs` still missing) and
 *   `docsHtml.ts` (the scratch-pad and HTML-first slice of
 *   `commands/docs_html.rs` `create_file` needs, carrying the app's real
 *   inlined design system rather than a look-alike); the arms themselves live
 *   in `organizeTools.ts`. Seven are fully real, `create_file` included — the
 *   ART-1 staged-artifact commit is replicated by hand against
 *   `db-host/artifacts.ts`, since `commands/artifact.rs`'s fluent `Artifact`
 *   builder has no port of its own yet. `mark_image` is the one honestly
 *   PARTIAL arm: it resolves the image and answers a repeat-mark for real,
 *   but the vision grounding pass (`ollama.rs`'s model listing and vision
 *   pick, the privacy-door check, `ground_prepared_image`) is wholly unported
 *   and still comes back `NOT_IMPLEMENTED` — see `organizeTools.ts`'s own
 *   module doc for why that refusal deliberately does NOT borrow Rust's "no
 *   vision model installed on this Mac" wording.
 * - MCP connector management — `list_mcps` / `read_mcp` / `save_mcp` against
 *   `mcpConfig.ts`. `delete_mcp` is wired to the same module but REFUSES
 *   while {@link ExecToolDeps.confirmDestructive} is unwired, for the reason
 *   `delete_skill` gives: a deletion that erases a saved OAuth token must not
 *   happen behind a confirmation the user never saw. The live `McpManager`
 *   (statuses, reconnects) has no app-wide container yet, and the per-Mac
 *   connector-grants file needs the app's `userDataDir`, which an `exec_tool`
 *   arm has no access to — each degrades through its own named dep below.
 * - the web tools — `web_search` (against `web.ts`'s search-fusion wrapper,
 *   `db-host/webCache.ts`'s 15-minute cache, and `browser/webAccess.ts`'s
 *   internet switch) and `fetch_page` (same cache/switch, against `web.ts`'s
 *   guarded HTTP client — `web/fetch.rs`'s per-hop SSRF re-check, DNS pinning
 *   and streaming byte caps, over `web/guard.rs`'s SSRF guard, already ported
 *   and committed as `browser/guard.ts` by an earlier batch). Both hold their
 *   PRIV-4 door open as an injected seam — {@link ExecToolDeps.maskOutboundWeb}
 *   for `web_search`'s outbound QUERY, {@link ExecToolDeps.outboundUrlRefusal}
 *   (shared with `download_media`) for `fetch_page`'s URL — and REFUSE while
 *   it is unwired rather than ever sending real names to the network unmasked.
 *   {@link withRealPrivacyGates} is the one-line way to fill both with
 *   `privacy.ts`'s real, committed port. `download_media` is the only OTHER
 *   web/download arm that is real; `save_link`/`download_url` still reach
 *   pieces of `web.ts` that back THEM specifically (the YouTube-transcript and
 *   binary-download engines) but are not wired to a tool arm here.
 */

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
import { agentDeleteSkill } from "./skillsCmds.js";
import {
  execAnnotateFile,
  execListRoomFiles,
  execOpenFile,
  execSearchRoom,
} from "./fileTools.js";
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
  if (
    effects.boxes === null &&
    effects.annotation === null &&
    effects.editOutcomes.length === 0 &&
    effects.tokenUsage === null &&
    effects.agentPlan === null
  ) {
    return null;
  }
  const map: Record<string, unknown> = {};
  if (effects.boxes !== null) {
    map.boxes = effects.boxes;
  }
  if (effects.annotation !== null) {
    map.annotation = effects.annotation;
  }
  if (effects.editOutcomes.length > 0) {
    map.edits = effects.editOutcomes;
  }
  if (effects.tokenUsage !== null) {
    map.usage = effects.tokenUsage;
  }
  if (effects.agentPlan !== null) {
    map.agents = effects.agentPlan;
  }
  return map;
}

// --------------------------------------------------------------- ToolOutcome

/** `exec_tool`'s `Result<String, String>`, as a discriminated union. `ok:
 * false` is a genuine tool FAILURE (what the Rust source's `Err(String)`
 * meant) — `bridgeDispatcher.ts` turns this into an MCP `isError: true`
 * result, never a JSON-RPC-level crash. */
export type ToolOutcome = { ok: true; text: string } | { ok: false; error: string };

function ok(text: string): ToolOutcome {
  return { ok: true, text };
}

function fail(error: string): ToolOutcome {
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
function notImplemented(reason: string): ToolOutcome {
  return fail(`NOT_IMPLEMENTED: ${reason}`);
}

// ------------------------------------------------------------------------ deps

/** Everything a real arm in this batch needs. Everything else (files,
 * retrieval, edit_match, the UI bridge, browse, scripts, studios, sketch,
 * skills commands, MCP management, jobs/workflows, local_generate, the
 * external-CLI advisor call, and live connector dispatch) is out of scope —
 * see the module doc — so `deps` carries only what {@link execTool}'s REAL
 * arms use. */
export interface ExecToolDeps {
  /** The open room's connection, or `null` when no room is open (mirrors
   * `state.room.lock().unwrap().as_ref().ok_or("No room is open.")`). */
  db: Database.Database | null;
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

const NO_ROOM_OPEN = "No room is open.";

/** `state.room.lock().unwrap().as_ref().ok_or("No room is open.")` as a value.
 * Every real arm below goes through this rather than reading `deps.db`
 * directly, so "no room is open" is one sentence in one place. */
function requireRoom(deps: ExecToolDeps): { ok: true; db: Database.Database } | { ok: false; error: string } {
  if (deps.db === null) {
    return { ok: false, error: NO_ROOM_OPEN };
  }
  return { ok: true, db: deps.db };
}

/** `let _ = window.emit(...)` — a best-effort UI notification that must never
 * turn a successful room mutation into a failed tool call. */
function emitSafely(deps: ExecToolDeps, event: string, payload: unknown): void {
  try {
    deps.emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = window.emit(...)`.
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------- memory arm

/**
 * UX-5: an existing memory whose normalized text equals `content`'s, if any.
 * Ported verbatim from `commands::library::duplicate_memory`.
 */
function duplicateMemory(db: Database.Database, content: string): Memory | null {
  const norm = normalizeForMatch(content);
  return listMemories(db).find((m) => normalizeForMatch(m.content) === norm) ?? null;
}

/** Wave 1b (idea 5): fold a raw category string onto the fixed vocabulary.
 * Ported verbatim from `commands::library::normalize_category`. */
function normalizeCategory(raw: string): string | null {
  switch (raw.trim().toLowerCase()) {
    case "preference":
      return "preference";
    case "fact":
      return "fact";
    case "project":
      return "project";
    case "instruction":
      return "instruction";
    default:
      return null;
  }
}

/** Ported verbatim from `format_memory_list`. */
function formatMemoryList(memories: readonly Memory[]): string {
  const total = memories.length;
  const lines = memories.slice(0, MAX_LISTED_MEMORIES).map((m) =>
    m.category !== null ? `- [${m.category}] ${m.content}` : `- ${m.content}`
  );
  if (total > MAX_LISTED_MEMORIES) {
    lines.push(
      `…and ${total - MAX_LISTED_MEMORIES} more memories — ask about something more specific to find them.`
    );
  }
  return lines.join("\n");
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function execAddMemory(
  deps: ExecToolDeps,
  db: Database.Database,
  args: Record<string, unknown>
): ToolOutcome {
  const raw = asString(args.content);
  if ([...raw].length > MAX_MEMORY_CONTENT_CHARS) {
    return ok(
      `Memory too long (${[...raw].length} chars); save a shorter note under ${MAX_MEMORY_CONTENT_CHARS} characters.`
    );
  }
  const category = typeof args.category === "string" ? normalizeCategory(args.category) : null;
  if (duplicateMemory(db, raw) !== null) {
    return ok("Already remembered.");
  }
  addMemory(db, raw, category);
  emitSafely(deps, "memories-changed", undefined);
  return ok("Memory saved.");
}

function execListMemories(db: Database.Database): ToolOutcome {
  const memories = listMemories(db);
  if (memories.length === 0) {
    return ok("No memories are saved in this room yet.");
  }
  return ok(formatMemoryList(memories));
}

function execUpdateOrDeleteMemory(
  deps: ExecToolDeps,
  db: Database.Database,
  toolName: "update_memory" | "delete_memory",
  args: Record<string, unknown>
): ToolOutcome {
  const find = asString(args.find).trim();
  if (find.length === 0) {
    return ok("Say which note to change, using a phrase from it.");
  }
  const hits = memoriesLike(db, find.toLowerCase());
  if (hits.length === 0) {
    return ok(`No memory contains "${find}". Call list_memories to see them.`);
  }
  if (hits.length > 1) {
    const listing = hits.map(([, content]) => `- ${content}`).join("\n");
    return ok(`"${find}" matches ${hits.length} notes; be more specific:\n${listing}`);
  }
  const [id, old] = hits[0]!;
  if (toolName === "delete_memory") {
    deleteMemory(db, id, { kind: "agent", who: "delete_memory" });
    emitSafely(deps, "memories-changed", undefined);
    return ok(`Forgot: ${old}`);
  }
  const content = asString(args.content).trim();
  if (content.length === 0) {
    return ok("Give the corrected note in `content`.");
  }
  if ([...content].length > MAX_MEMORY_CONTENT_CHARS) {
    return ok(`Memory too long (${[...content].length} chars); keep it under ${MAX_MEMORY_CONTENT_CHARS}.`);
  }
  // update_memory SETs category, so a text-only fix would silently clear it —
  // carry the existing one.
  const keep = listMemories(db).find((m) => m.id === id)?.category ?? null;
  updateMemory(db, id, content, keep);
  emitSafely(deps, "memories-changed", undefined);
  return ok(`Updated. Was: ${old}`);
}

// ---------------------------------------------------------------- skill arms

/**
 * The skill COMMAND layer's read/write arms, ported from
 * `src-tauri/src/commands/skills.rs` against the already-committed
 * `db-host/skills.ts`. Every refusal string below is verbatim from that source.
 *
 * `delete_skill` and `run_skill_script` are NOT here: the first needs the
 * `confirm_destructive` consent dialog and the second needs script execution,
 * neither of which is ported — see their stub arms.
 */

const SKILL_LIST_TRUNCATED =
  "\n… (list truncated — this room holds more skills than this tool can return.)";
const SKILL_BODY_TRUNCATED =
  "\n\n… (instructions truncated — the full SKILL.md is longer than this tool can return. " +
  "Work from what is above and say so if the rest was needed.)";
const SKILL_RESOURCES_TRUNCATED = "\n… (more bundled resources than this tool can list.)";
const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 2000;
const MAX_INSTRUCTIONS = 200_000;

function tryDecodeUtf8(buf: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** Ported from `commands::skills::normalize_skill_path`. */
function normalizeSkillPath(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (trimmed === "" || trimmed.length > 240) {
    return { ok: false, error: "Use a short relative resource path." };
  }
  if (trimmed.endsWith("/")) {
    return {
      ok: false,
      error: 'A resource path must name a file, not a folder — remove the trailing "/".',
    };
  }
  if (trimmed.startsWith("/") || trimmed.toLowerCase() === "skill.md") {
    return {
      ok: false,
      error:
        "Resource paths must stay inside the skill folder; SKILL.md is edited through the skill fields.",
    };
  }
  const parts = trimmed.split("/").filter((p) => p !== "");
  if (parts.some((p) => p === "." || p === "..")) {
    return {
      ok: false,
      error:
        "Resource paths must stay inside the skill folder; SKILL.md is edited through the skill fields.",
    };
  }
  if (parts.length === 0) return { ok: false, error: "Use a short relative resource path." };
  return { ok: true, value: parts.join("/") };
}

/** Ported from `commands::skills::skill_resource_kind`. */
function skillResourceKind(path: string): string {
  switch (path.split("/")[0] ?? "") {
    case "scripts":
      return "script";
    case "references":
      return "reference";
    case "assets":
      return "asset";
    case "agents":
      return "agent";
    default:
      return "resource";
  }
}

/** Ported from `commands::skills::check_resource_paths`. Case-fold is ASCII
 * (`toLowerCase` on the compared slice), matching Rust's
 * `eq_ignore_ascii_case`, since a resource path is expected to be ASCII. */
function checkResourcePaths(paths: readonly string[]): string | null {
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const a = paths[i]!;
      const b = paths[j]!;
      const [dir, under] = a.length < b.length ? [a, b] : [b, a];
      if (
        under.length > dir.length &&
        under[dir.length] === "/" &&
        under.slice(0, dir.length).toLowerCase() === dir.toLowerCase()
      ) {
        return `"${dir}" and "${under}" can't both be in one skill: a file and a folder cannot share a name. Rename one of them.`;
      }
    }
  }
  return null;
}

function checkNewResourcePath(conn: Database.Database, skillId: string, path: string): string | null {
  const paths = listSkillResourcesDb(conn, skillId)
    .map((r) => r.path)
    .filter((p) => p !== path);
  paths.push(path);
  return checkResourcePaths(paths);
}

/** Ported from `commands::skills::validate_skill_name`. */
function validateSkillName(name: string): { ok: true; value: string } | { ok: false; error: string } {
  const n = name.trim().toLowerCase().replace(/[ _]/g, "-");
  if (n === "") return { ok: false, error: "Give the skill a name." };
  if (n.length > MAX_NAME || n.startsWith("-") || n.endsWith("-") || !/^[a-z0-9-]+$/.test(n)) {
    return {
      ok: false,
      error:
        "Skill names must be 1–64 lowercase letters, numbers, or hyphens, without a leading or trailing hyphen.",
    };
  }
  return { ok: true, value: n };
}

/** Ported from `commands::skills::validate_skill_fields`. */
function validateSkillFields(
  name: string,
  description: string,
  instructions: string
): { ok: true; value: string } | { ok: false; error: string } {
  const nameResult = validateSkillName(name);
  if (!nameResult.ok) return nameResult;
  const desc = description.trim();
  if (desc === "") {
    return { ok: false, error: "Describe what the skill does and when the assistant should use it." };
  }
  if (Array.from(desc).length > MAX_DESCRIPTION) {
    return { ok: false, error: `Keep the skill description under ${MAX_DESCRIPTION} characters.` };
  }
  if (Array.from(instructions).length > MAX_INSTRUCTIONS) {
    return { ok: false, error: "SKILL.md is too large. Move detailed material into references/." };
  }
  return { ok: true, value: nameResult.value };
}

function execListSkills(deps: ExecToolDeps, args: Record<string, unknown>): ToolOutcome {
  const room = requireRoom(deps);
  if (!room.ok) return fail(room.error);
  const all = listSkillsDb(room.db, false);
  const caller = asString(args["agent"]).trim();
  const skills = all.filter((s) => {
    const owner = s.agent.trim();
    return owner === "" || caller === "" || owner === caller;
  });
  if (skills.length === 0) {
    return ok(all.length === 0 ? "No skills are stored in this room yet." : "No skills are assigned to you yet.");
  }
  const lines = skills
    .map(
      (s) =>
        `- ${s.name} [${s.enabled ? "enabled" : "disabled draft"}]${
          s.agent.trim() !== "" && s.agent.trim() === caller ? " (yours)" : ""
        } — ${s.description} (${s.resourceCount} resources)`
    )
    .join("\n");
  return ok(clampBytesMarked(lines, 12_000, SKILL_LIST_TRUNCATED));
}

function execReadSkill(deps: ExecToolDeps, args: Record<string, unknown>): ToolOutcome {
  const key = asString(args["skill"]);
  const room = requireRoom(deps);
  if (!room.ok) return fail(room.error);
  const skill = findSkillDb(room.db, key);
  if (skill === null) return fail(`No skill named "${key}" exists.`);
  const resources = listSkillResourcesDb(room.db, skill.id);
  const tree =
    resources.length === 0
      ? "(no bundled resources)"
      : resources.map((r) => `- ${r.path} (${r.kind})`).join("\n");
  const instructions = clampBytesMarked(skill.instructions, 16_000, SKILL_BODY_TRUNCATED);
  const treeClamped = clampBytesMarked(tree, 3_000, SKILL_RESOURCES_TRUNCATED);
  return ok(
    `# Skill: ${skill.name}\nStatus: ${skill.enabled ? "enabled" : "disabled draft"}\nDescription: ${skill.description}\n\n${instructions}\n\nBundled resources:\n${treeClamped}`
  );
}

function execReadSkillResource(deps: ExecToolDeps, args: Record<string, unknown>): ToolOutcome {
  const key = asString(args["skill"]);
  const pathResult = normalizeSkillPath(asString(args["path"]));
  if (!pathResult.ok) return fail(pathResult.error);
  const room = requireRoom(deps);
  if (!room.ok) return fail(room.error);
  const skill = findSkillDb(room.db, key);
  if (skill === null) return fail(`No skill named "${key}" exists.`);
  let resource;
  try {
    resource = getSkillResourceDb(room.db, skill.id, pathResult.value);
  } catch (e) {
    return fail(errMessage(e));
  }
  const text = tryDecodeUtf8(resource.content);
  if (text === null) return fail(`${pathResult.value} is binary and cannot be loaded as text.`);
  return ok(clampBytes(text, 20_000));
}

function execSaveSkill(deps: ExecToolDeps, args: Record<string, unknown>): ToolOutcome {
  const rawName = asString(args["name"]);
  const description = asString(args["description"]);
  const instructions = asString(args["instructions"]);
  const agentOwner = asString(args["agent"]).trim();
  if (agentOwner !== "" && !(SKILL_AGENT_IDS as readonly string[]).includes(agentOwner)) {
    return fail(
      `agent must be one of: ${SKILL_AGENT_IDS.join(", ")} — or omit it for a skill any agent may ` +
        `use. Got ${JSON.stringify(agentOwner)}; nothing was saved.`
    );
  }
  const nameResult = validateSkillFields(rawName, description, instructions);
  if (!nameResult.ok) return fail(nameResult.error);
  const sourceNames = Array.isArray(args["source_files"])
    ? (args["source_files"] as unknown[])
        .filter((v): v is string => typeof v === "string")
        .map((s) => s.trim())
        .filter((s) => s !== "")
    : [];
  if (sourceNames.length > 0) {
    // Genuinely partial: everything BELOW works today against skills.ts;
    // only the source_files→room-file resolution/snapshot step needs
    // files.ts, which is not committed to this migration yet.
    return notImplemented(
      "save_skill's source_files → room-file snapshot step needs db-host/files.ts — Batch D. " +
        "save_skill WITHOUT source_files is implemented for real; nothing was saved here"
    );
  }
  const room = requireRoom(deps);
  if (!room.ok) return fail(room.error);
  const existing = findSkillDb(room.db, nameResult.value);
  let id: string;
  let updated: boolean;
  if (existing !== null) {
    const owner = agentOwner === "" ? existing.agent : agentOwner;
    updateSkillDb(room.db, existing.id, nameResult.value, description.trim(), instructions, owner);
    setSkillEnabledDb(room.db, existing.id, false);
    id = existing.id;
    updated = true;
  } else {
    id = createSkillDb(
      room.db,
      nameResult.value,
      description.trim(),
      instructions,
      false,
      "agent",
      agentOwner
    );
    updated = false;
  }
  emitSafely(deps, "skills-changed", undefined);
  // No "bundled N room file snapshot(s)" clause here (unlike Rust's own
  // reply) — source_files is handled above, and always empty by the time
  // this line runs, so there is nothing bundled to report.
  return ok(
    `${updated ? "Updated" : "Created"} skill "${nameResult.value}" as a disabled draft (id: ${id}). The user can review and enable it in Skills.`
  );
}

function execWriteSkillResource(deps: ExecToolDeps, args: Record<string, unknown>): ToolOutcome {
  const key = asString(args["skill"]);
  const pathResult = normalizeSkillPath(asString(args["path"]));
  if (!pathResult.ok) return fail(pathResult.error);
  const content = asString(args["content"]);
  if (Buffer.byteLength(content, "utf8") > MAX_RESOURCE_BYTES) {
    return fail("That resource is too large (32 MB maximum).");
  }
  const room = requireRoom(deps);
  if (!room.ok) return fail(room.error);
  const skill = findSkillDb(room.db, key);
  if (skill === null) return fail(`No skill named "${key}" exists.`);
  const clash = checkNewResourcePath(room.db, skill.id, pathResult.value);
  if (clash !== null) return fail(clash);
  upsertSkillResourceDb(
    room.db,
    skill.id,
    pathResult.value,
    skillResourceKind(pathResult.value),
    Buffer.from(content, "utf8")
  );
  setSkillEnabledDb(room.db, skill.id, false);
  emitSafely(deps, "skills-changed", undefined);
  return ok(`Saved ${pathResult.value} in "${skill.name}" and left the skill disabled for review.`);
}

function execDeleteSkillResource(deps: ExecToolDeps, args: Record<string, unknown>): ToolOutcome {
  const key = asString(args["skill"]).trim();
  const path = asString(args["path"]).trim().replace(/\\/g, "/");
  if (key === "") return fail("delete_skill_resource needs a skill name or id.");
  const room = requireRoom(deps);
  if (!room.ok) return fail(room.error);
  const skill = findSkillDb(room.db, key);
  if (skill === null) return fail(`No skill named "${key}" exists.`);
  try {
    deleteSkillResourceDb(room.db, skill.id, path);
  } catch (e) {
    return fail(errMessage(e));
  }
  emitSafely(deps, "skills-changed", undefined);
  return ok(`Deleted ${path} from skill "${skill.name}".`);
}


// -------------------------------------------------------- REAL: consult_advisor

/**
 * ADD-21: delegate a hard subtask to a cloud CLI. Ported from `exec_tool`'s own
 * `"consult_advisor"` arm (agent.rs lines ~4620-4662) — the SECOND of the two
 * budget checks, deliberately.
 *
 * `bridgeDispatcher.ts` already refused an over-budget call against the
 * per-turn `AdvisorRuntime` counter; this one reads `effects.advisorCalls`, a
 * different counter on a different object, and Rust keeps both for a stated
 * reason: "the tool is only in the catalog when the advanced setting is on and
 * a CLI exists, but re-check the budget here so the model can't overspend the
 * user's cloud account by looping". A native (non-bridge) chat loop reaches
 * THIS check and nothing else.
 *
 * The budget is spent BEFORE the slow call so a mid-flight retry cannot
 * double-spend, and a CLI that fails comes back as `Ok` — the local model then
 * recovers by answering itself instead of showing the user a raw tool error.
 *
 * {@link ExecToolDeps.runAdvisorCli} is the injected seam. The subprocess
 * behind it IS ported (`externalAdvisor.ts`); what no code path does yet is
 * INSTALL it, which {@link withRealAdvisorCli} exists to do. Without it this
 * REFUSES rather than inventing an advisor's answer — the one thing a tool
 * whose whole output is "what a second model said" must never do.
 */
async function execConsultAdvisor(
  deps: ExecToolDeps,
  effects: ToolEffects,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  if (effects.advisorCalls >= MAX_ADVISOR_CALLS) {
    return ok(
      "You have already consulted an advisor this turn. Use that answer, or " +
        "answer the user yourself — do not consult again."
    );
  }
  const question = asString(args.question).trim();
  if (question.length === 0) {
    return fail(
      "consult_advisor needs a non-empty `question` holding the full, " +
        "self-contained task and all context the advisor will need."
    );
  }
  const want = typeof args.advisor === "string" ? args.advisor : "claude";
  const engine = want === "codex" ? "codex-cli" : "claude-cli";
  if (deps.runAdvisorCli === undefined) {
    return notImplemented(
      "nothing has installed the advisor seam on this deps object. The advisor SELECTION, both " +
        "budget caps AND the CLI subprocess itself (externalAdvisor.ts's runExternalCli) are all " +
        "implemented for real — the only missing piece is a host bootstrap that builds its deps " +
        "through execTool.ts's withRealAdvisorCli(). Do NOT re-port run_external"
    );
  }
  // Spend the budget before the slow call so a mid-flight retry can't
  // double-spend. Deliberately AFTER the not-implemented refusal above: a
  // refusal that cost nothing must not also cost the turn's only consult.
  effects.advisorCalls += 1;
  try {
    const answer = await deps.runAdvisorCli(engine, question);
    return ok(`Advisor (${want}) replied:\n\n${answer}`);
  } catch (e) {
    // Ok, not an error, so the local model recovers by answering itself
    // instead of surfacing a raw tool error to the user.
    return ok(
      `The advisor could not be reached (${errMessage(e)}). Answer the user from what you ` +
        `already have.`
    );
  }
}

/**
 * ADD-21 wiring: fills {@link ExecToolDeps.runAdvisorCli} with the real
 * `claude -p` / `codex exec` subprocess (`externalAdvisor.ts`'s port of
 * `run_external`) whenever a caller has not already supplied its own —
 * purely additive, and it never touches {@link execConsultAdvisor} above:
 * every existing test that builds its own bare `ExecToolDeps` object literal
 * (this file's own `deps()` test helper included) still exercises the
 * injected-seam behavior exactly as before, because nothing calls this
 * function on their behalf. A REAL caller constructing the deps a running app
 * hands to {@link execTool} should build its object THROUGH this
 * (`execTool("consult_advisor", args, effects, withRealAdvisorCli(deps))`) so
 * `consult_advisor` gets a real advisor instead of `NOT_IMPLEMENTED`.
 *
 * The PRIVACY DOOR needs nothing from here: `externalAdvisor.ts` looks
 * `privacy.ts`'s active policy up in the leaf itself, exactly as
 * `run_external` calls `active_policy()`, so a caller cannot forget to pass
 * it. `options` is for the two pieces that must be handed DOWN because they
 * belong to one ask rather than to the process — a per-ask MCP bridge and the
 * run's cancel flag. Neither has a live instance anywhere in this migration
 * yet (no ported per-ask bridge lifecycle; no ported chat loop that hands
 * `execTool` a run-scoped flag), so the default passes neither.
 *
 * THE BRIDGE IS CLAUDE-ONLY, and this function — not the leaf — is where that
 * rule lives, because it is a property of the `consult_advisor` CALL SITE:
 * agent.rs line 4642 is `let bridge = if engine == "claude-cli" {
 * advisor_bridge } else { None };`, with the reason in its own comment ("the
 * per-ask advisor bridge … is claude-only; codex gets a plain pipe").
 * `runExternalCli` itself supports the bridge on BOTH engines on purpose —
 * `jobs/workflow.rs` really does hand a codex chat turn one — so restricting
 * it there would break the other caller. Binding `options` before the engine
 * is known is exactly how a codex advisor would have quietly acquired the
 * room's file tools, so the seam below picks per call instead.
 *
 * WIRING HAZARD for whichever host bootstrap fills this in: pass `cancel`.
 * Rust's own arm passes `cancel.clone()` on every consult, and it is the ONLY
 * kill path either port has — there is no wall-clock timeout in `run_external`
 * or in `runExternalCli`. Without it a wedged `claude -p` leaves this
 * `await` pending for the life of the process, holding the turn open with no
 * way for Stop to end it.
 */
export function withRealAdvisorCli(deps: ExecToolDeps, options?: RunExternalOptions): ExecToolDeps {
  if (deps.runAdvisorCli !== undefined) {
    return deps;
  }
  if (options === undefined) {
    return { ...deps, runAdvisorCli: realRunAdvisorCli };
  }
  const withBridge = makeRunAdvisorCli(options);
  if (options.bridge === undefined) {
    return { ...deps, runAdvisorCli: withBridge };
  }
  const withoutBridge = makeRunAdvisorCli({ ...options, bridge: undefined });
  return {
    ...deps,
    runAdvisorCli: (engine, question) =>
      engine === "claude-cli" ? withBridge(engine, question) : withoutBridge(engine, question),
  };
}

/**
 * PRIV-4 wiring, the counterpart to {@link withRealAdvisorCli}: fills
 * {@link ExecToolDeps.maskOutboundWeb} and
 * {@link ExecToolDeps.outboundUrlRefusal} with `privacy.ts`'s real, committed
 * port of `privacy::mask_outbound_web` / `privacy::web_mask_note` /
 * `privacy::outbound_url_hides`, for any caller that has not supplied its own.
 *
 * THIS FUNCTION EXISTS BECAUSE THE CHECKS ARE NOT MISSING. Both seams read as
 * "privacy has no port yet" if you only look at the arms, and BOTH candidate
 * ports of the web tools wrote that in their refusal text — but `privacy.ts` is
 * committed, tested, and already read directly by `externalAdvisor.ts`'s leaf
 * (`activePolicy()`, exactly as `run_external` calls it). The only thing still
 * absent is a host bootstrap that builds the deps object a running app hands to
 * {@link execTool}; that bootstrap should build it through here
 * (`execTool(name, args, effects, withRealPrivacyGates(deps))`) so `web_search`
 * masks and `fetch_page`/`download_media` refuse for real instead of coming
 * back `NOT_IMPLEMENTED`.
 *
 * Purely additive, and deliberately NOT applied inside the arms: every existing
 * test that builds a bare `ExecToolDeps` literal still exercises the
 * injected-seam behavior unchanged, because nothing calls this on its behalf.
 *
 * NO ROOM/POLICY ARGUMENT, on purpose. `privacy.ts` holds the active policy in
 * a module-level cell that `refreshPolicy` installs and room teardown clears —
 * the direct analogue of Rust's `active_policy()` global. When no policy is
 * installed (or the Cloud-privacy switch is off) both functions return "nothing
 * to do", which is precisely what the Rust arms do in the same situation: the
 * door is a switch the user owns, not a check this seam can forget.
 */
export function withRealPrivacyGates(deps: ExecToolDeps): ExecToolDeps {
  const filled: ExecToolDeps = { ...deps };
  if (filled.maskOutboundWeb === undefined) {
    filled.maskOutboundWeb = realMaskOutboundWeb;
  }
  if (filled.outboundUrlRefusal === undefined) {
    filled.outboundUrlRefusal = realOutboundUrlRefusal;
  }
  return filled;
}

/** `privacy.ts`'s `maskOutboundWeb` reshaped to this file's seam: the masked
 * query plus the disclosure line `web_mask_note` writes, or `null` when nothing
 * needed masking. Mirrors the Rust arm's own two-line
 * `mask_outbound_web(...)` + `web_mask_note(hidden)`. */
function realMaskOutboundWeb(query: string): { query: string; note: string } | null {
  const masked = privacyMaskOutboundWeb(query);
  return masked === null ? null : { query: masked.masked, note: webMaskNote(masked.hidden) };
}

/** Ported verbatim from agent.rs's `outbound_url_refusal`: `outbound_url_hides`
 * behind the sentence the model reads. */
function realOutboundUrlRefusal(url: string): string | null {
  const hidden = outboundUrlHides(url);
  if (hidden === null) {
    return null;
  }
  return (
    `Not fetched: this URL carries ${hidden} protected name(s) from this room's block list, and ` +
    "Cloud privacy is on, so it must not leave this Mac (Settings → Cloud privacy). Tell the user " +
    "rather than retrying."
  );
}

// -------------------------------------------------------------- REAL: web_search

/**
 * BROWSE-3: free multi-engine web search with no account or API key. Ported
 * from `exec_tool`'s own `"web_search"` arm (agent.rs lines ~3591-3683).
 *
 * PRIV-4 GATE FIRST, mirroring the Rust arm's own order: the query is masked
 * (or the call refused outright while the seam is unwired — see
 * {@link ExecToolDeps.maskOutboundWeb}'s own doc) before anything else runs,
 * including before the room's own internet switch is read.
 *
 * CHG-33's two caches: an exact-or-normalized repeat within 15 minutes is
 * served from `db-host/webCache.ts` with no network touched at all; once a
 * live search fails outright this turn ({@link ToolEffects.webSearchThrottled}),
 * the model is steered to stop calling this tool rather than deepening
 * whatever blocked it. An empty fusion is reported as EITHER "no results"
 * (the web really had nothing) OR "the search did not run" (every engine
 * was blocked/rate-limited/too slow) — conflating the two would tell a model
 * a subject does not exist online because a scraper hit a 429.
 */
async function execWebSearch(
  deps: ExecToolDeps,
  effects: ToolEffects,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const asked = asString(args.query);
  if (deps.maskOutboundWeb === undefined) {
    return notImplemented(
      "nothing has installed the PRIV-4 outbound-query mask on this deps object, so this refused " +
        "rather than sending an unmasked query to seven search engines. Both halves ARE " +
        "implemented for real — privacy.ts's maskOutboundWeb/webMaskNote and web.ts's search " +
        "fusion — and execTool.ts's withRealPrivacyGates() installs the mask in one line. Do NOT " +
        "re-port privacy.rs or web/search.rs"
    );
  }
  const masked = deps.maskOutboundWeb(asked);
  const query = masked?.query ?? asked;
  const maskNote = masked?.note ?? "";

  const room = requireRoom(deps);
  if (!room.ok) {
    return fail(room.error);
  }
  if (!webAccessEnabled(room.db)) {
    return ok("Web access is turned off in Settings → Online features.");
  }

  // CHG-33: serve a recent (<15m) cached result list without touching the
  // network. Catches exact repeats and case/spacing variants, and avoids
  // deepening any ban.
  const cached = getFreshWebSearch(room.db, query);
  if (cached !== null) {
    // BROWSE-3: the cache holds hits now, not rendered text, and the
    // browser's results page shares this row. A search the user ran in the
    // address bar lands here as a free hit — same web, same ranking,
    // whichever of the two asked first.
    return ok(`${renderHits(cached)}${maskNote}`);
  }

  // CHG-33: once the search path has failed outright this turn, don't keep
  // calling it — steer the model to salvage the answer from what it already
  // has.
  if (effects.webSearchThrottled) {
    return ok(
      "Web search is unavailable right now; answer from what you already have or from fetched " +
        "pages — do not search again this turn."
    );
  }

  let page: SearchPage;
  try {
    page = await searchWeb(query);
  } catch (e) {
    effects.webSearchThrottled = true;
    return fail(errMessage(e));
  }

  const hits = page.hits;
  if (hits.length === 0) {
    // "No results found." is a claim about the WEB. When every engine was
    // blocked or rate limited it is a claim about our scrapers, and the
    // model has no way to tell the two apart — so say which happened, and
    // never cache a blocked search as an empty one.
    if (page.failed.length === 0) {
      return ok(`No results found.${maskNote}`);
    }
    return ok(
      `The search did not run: ${joinNames(page.failed)} could not be reached (blocked, rate ` +
        "limited or too slow). This is NOT evidence that nothing exists for this query — tell the " +
        "user the search was blocked rather than reporting no results, and answer from a fetched " +
        "page or what you already have."
    );
  }

  try {
    putWebSearch(room.db, query, hits);
  } catch {
    // Best-effort, matching Rust's `let _ = db::put_web_search(...)`.
  }

  const note = blockedNote(page);
  const rendered = note !== null ? `${renderHits(hits)}\n\n${note}` : renderHits(hits);
  return ok(`${rendered}${maskNote}`);
}

// -------------------------------------------------------------- REAL: fetch_page

/**
 * Read one web page's text. Ported from `exec_tool`'s own `"fetch_page"` arm
 * (agent.rs lines ~3684-3731).
 *
 * PRIV-4 GATE FIRST, mirroring the Rust arm's own order and its own reasoning
 * for reusing `outbound_url_refusal` (the same seam `download_media` needs)
 * rather than `web_search`'s masking seam: a URL is ENCODED, so a masked
 * placeholder in a path or query string just 404s — this REFUSES instead of
 * fetching, and refuses outright (a `NOT_IMPLEMENTED` result) while the seam
 * itself is unwired, exactly like `download_media`.
 *
 * RM-2's cache: a fetch within the last 24h is served from
 * `db-host/webCache.ts` with no network touched, and (because a cache hit
 * carries no live redirect info) the redirect note only ever appears on a
 * fresh fetch that actually landed somewhere other than the requested URL.
 */
async function execFetchPage(deps: ExecToolDeps, args: Record<string, unknown>): Promise<ToolOutcome> {
  const url = asString(args.url);
  if (deps.outboundUrlRefusal === undefined) {
    return notImplemented(
      "nothing has installed the PRIV-4 outbound-URL check on this deps object, so this refused " +
        "rather than skipping it. Both halves ARE implemented for real — privacy.ts's " +
        "outboundUrlHides and web.ts's guarded HTTP client (per-hop SSRF re-check, DNS pinning, " +
        "streamed byte caps) — and execTool.ts's withRealPrivacyGates() installs the check in one " +
        "line. Do NOT re-port privacy.rs or web/fetch.rs"
    );
  }
  const refusal = deps.outboundUrlRefusal(url);
  if (refusal !== null) {
    return ok(refusal);
  }
  // CHG-5/CHG-28: continue reading a long page from a char offset.
  const rawStart = args.start;
  const start = typeof rawStart === "number" && Number.isFinite(rawStart) && rawStart >= 0 ? Math.trunc(rawStart) : 0;

  const room = requireRoom(deps);
  if (!room.ok) {
    return fail(room.error);
  }
  if (!webAccessEnabled(room.db)) {
    return ok("Web access is turned off in Settings → Online features.");
  }

  // RM-2: serve a fresh (<24h) cached copy without touching the network.
  const cached = getFreshWebPage(room.db, url);
  let title: string;
  let text: string;
  // D2 (2026-08-04): a cache hit has no live redirect info; a fresh fetch's
  // `finalUrl` is only worth mentioning when it actually differs from what
  // was asked for — otherwise every ordinary fetch would carry a pointless
  // "redirected to the same URL" line.
  let redirectedTo: string | null = null;
  if (cached !== null) {
    title = cached.title;
    text = cached.text;
  } else {
    let fetched: FetchedPage;
    try {
      fetched = await fetchPage(url);
    } catch (e) {
      return fail(errMessage(e));
    }
    title = fetched.title;
    text = fetched.text;
    try {
      saveWebPage(room.db, url, title, text);
    } catch {
      // Best-effort, matching Rust's `let _ = db::save_web_page(...)`.
    }
    redirectedTo = fetched.finalUrl !== url ? fetched.finalUrl : null;
  }
  return ok(fetchPageReply(title, url, text, start, redirectedTo));
}

// ------------------------------------------------------------ REAL: download_media

/**
 * BROWSE-2 (D18): download the media at a yt-dlp-supported URL as a durable
 * background job. Ported from `exec_tool`'s own `"download_media"` arm
 * (agent.rs lines ~3817-3836).
 *
 * TWO GATES RUN BEFORE THE JOB IS EVEN CREATED, mirrored from the Rust arm in
 * the same order:
 *   1. `outbound_url_refusal` (privacy.rs's `outbound_url_hides`) — refused
 *      (never silently skipped) while {@link ExecToolDeps.outboundUrlRefusal}
 *      is unwired; see that field's own doc. Needs no open room, so it runs
 *      BEFORE "No room is open." can even be asked — exactly the Rust arm's
 *      own order.
 *   2. The room's own internet switch, answered with a friendly `ok()`
 *      sentence rather than a tool FAILURE — exactly the Rust arm's own
 *      `Ok("Web access is turned off...")`, not an error a model would need
 *      to recover from.
 *
 * Only once both pass does {@link ExecToolDeps.downloadJob} — the real
 * job-queue wiring ({@link startDownloadJobInner} from `jobDownload.ts`) —
 * actually create, and (if the slot is free) start, the job.
 */
async function execDownloadMedia(
  deps: ExecToolDeps,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const url = asString(args.url).trim();
  if (deps.outboundUrlRefusal === undefined) {
    return notImplemented(
      "privacy.rs's outbound_url_hides check (the cloud-privacy protected-name guard every " +
        "download/save tool runs before reaching the network) has no Electron port yet — refused " +
        "rather than skipping it. jobDownload.ts's yt-dlp job-queue wrapper is fully implemented " +
        "and tested; it is ready to wire in once that check lands"
    );
  }
  const refusal = deps.outboundUrlRefusal(url);
  if (refusal !== null) {
    return ok(refusal);
  }
  const room = requireRoom(deps);
  if (!room.ok) {
    return fail(room.error);
  }
  if (!webAccessEnabled(room.db)) {
    return ok("Web access is turned off in Settings → Online features.");
  }
  if (deps.downloadJob === undefined) {
    return notImplemented(
      "the download-job queue wiring (an app-wide JobQueueDeps + yt-dlp's data dir + the room's " +
        "import funnel) is not connected to execTool yet — Batch D"
    );
  }
  try {
    const jobId = startDownloadJobInner(deps.downloadJob, url, DOWNLOAD_ENGINE_MEDIA);
    return ok(
      `Downloading the media as background job ${jobId} — track it with job_status. The file will ` +
        "be transcribed automatically after it arrives."
    );
  } catch (e) {
    return fail(errMessage(e));
  }
}

// ------------------------------------------------- the connector-route default

/**
 * `exec_tool`'s `other => match routes.iter().find(...)` arm: a name that is
 * not a built-in is looked up as a connected MCP tool, and is a real
 * `Unknown tool:` error only when no route claims it.
 *
 * TWO DOORS STAND BETWEEN A MODEL AND A CONNECTOR IN RUST, and this port
 * refuses rather than skipping either:
 *
 * 1. The OUTBOUND redaction seam. A remote connector is a non-local
 *    destination, so the room's known entities are masked in the arguments
 *    before they leave and restored in the result on the way home
 *    ({@link masksOutboundArgs}). What the consent card SHOWS is what is
 *    SENT — Rust computes the masked copy before building the card precisely
 *    because it once did the opposite, and a user approved "look up Dana
 *    Cohen" while the connector was asked about "[Person A]".
 * 2. SEC-1b consent. The user is asked before a connector's tool runs, unless
 *    they chose "always allow" for it earlier this session.
 *
 * Neither subsystem is ported. So when a call WOULD be masked and no
 * {@link RemoteSeam} exists, this refuses instead of sending the room's real
 * text to a remote server; and with no {@link ExecToolDeps.connectorApproved}
 * it refuses instead of running ungated. `routes` is empty in production today
 * (no connector manager is ported either), so this is reachable only from a
 * caller that supplies its own route — and that caller has to supply the doors
 * with it.
 */
async function execConnectorRoute(
  deps: ExecToolDeps,
  effects: ToolEffects,
  name: string,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const route = deps.routes.find((r) => r.catalogName === name);
  if (route === undefined) {
    // The one genuine "no such tool" in this whole function. Every BUILT-IN
    // name was answered by a named arm above; reaching here means the name is
    // neither a built-in nor a connected route.
    return fail(`Unknown tool: ${name}`);
  }
  if (deps.callConnectorTool === undefined) {
    return notImplemented(
      `connector dispatch for "${name}" (the MCP client transport) is not wired up — Batch D`
    );
  }

  // Read PER CONNECTOR: one remote service being trusted with the room's names
  // says nothing about the next one.
  const unmaskOutbound = deps.outboundUnmaskFor?.(route.serverName) ?? false;
  const masks = masksOutboundArgs(route.remote, unmaskOutbound);
  let sent = args;
  let hidden = 0;
  if (masks) {
    if (deps.remoteSeam === undefined) {
      return notImplemented(
        `outbound masking for the remote connector "${route.serverName}" (privacy.rs's ` +
          `remote_seam_redactor) is not ported, and sending this room's real values to a remote ` +
          `server unmasked is not a substitute — refused, nothing left this room`
      );
    }
    const masked = deps.remoteSeam.redactValue(args);
    sent = masked.value;
    hidden = masked.entitiesHidden;
  }

  if (deps.connectorApproved === undefined) {
    return notImplemented(
      `the SEC-1b consent gate (mcp_call_approved) is not ported, so "${route.toolName}" from ` +
        `"${route.serverName}" cannot be run with the user's approval — refused, nothing left this room`
    );
  }
  if (!(await deps.connectorApproved(route, sent))) {
    return ok(
      `The user declined to run the "${route.toolName}" tool from "${route.serverName}", so it did ` +
        `not run and nothing left this room. Answer from what you already have, and tell the user ` +
        `you skipped that connected tool.`
    );
  }

  let reply: ConnectorReply;
  try {
    reply = await deps.callConnectorTool(route, sent);
  } catch (e) {
    return fail(errMessage(e));
  }
  let result = masks && deps.remoteSeam !== undefined ? deps.remoteSeam.restore(reply.text) : reply.text;

  // A connector that answers with a PICTURE goes through the same perception
  // funnel the room's own tools use: pixels ride along only for a chat model
  // that can read them, and otherwise a LOCAL vision model describes them.
  // That local describer (`perceive_image`) is not ported, so an image for a
  // non-vision consumer is REPORTED as unattached rather than silently
  // dropped — Rust's own failure wording, which is never fatal because the
  // TEXT half of the result is still good.
  for (const [i, image] of (reply.images ?? []).entries()) {
    const caption = `image ${i + 1} from "${route.toolName}"`;
    if (effects.visionChat) {
      effects.pendingImages.push(image);
    } else {
      result += `\n\n[${caption} could not be attached: the local vision describer (perceive_image) is not ported yet]`;
    }
  }

  // Appended AFTER any clamp so the one sentence explaining a thin result
  // cannot be the part that gets cut.
  const note = maskedArgsNote(route.serverName, hidden);
  return ok(note === null ? result : `${result}${note}`);
}

// ------------------------------------------------------------ dispatch (Rust: match)

/**
 * The names {@link execTool} answers with a NAMED arm rather than the
 * connector-route fallthrough: `BUILTIN_TOOL_NAMES` MINUS the MCP proxy pair.
 *
 * `search_mcp_tools`/`run_mcp_tool` are intercepted one layer up, in
 * `bridgeDispatcher.ts` — the Rust `exec_tool` never receives either name as
 * `call.name` either, so an arm for them here would be dead code pretending to
 * be coverage.
 *
 * DERIVED, not written down: a hand-kept second copy of the tool list is
 * exactly the thing that drifts. The exhaustive test in `execTool.test.ts`
 * does not trust this constant either — it DRIVES every name through the real
 * `execTool` with schema-satisfying arguments and asserts none of them comes
 * back as the `Unknown tool:` fallthrough.
 */
export const NAMED_ARM_TOOL_NAMES: readonly string[] = BUILTIN_TOOL_NAMES.filter(
  (n) => n !== "search_mcp_tools" && n !== "run_mcp_tool"
);

/**
 * One tool call, dispatched by name. Ported from `exec_tool`'s outer shell —
 * see the module doc for exactly which arms are real vs. `NOT_IMPLEMENTED`
 * stubs.
 */
export async function execTool(
  name: string,
  rawArgs: Record<string, unknown>,
  effects: ToolEffects,
  deps: ExecToolDeps
): Promise<ToolOutcome> {
  // The Rust source holds `call.arguments` as a `serde_json::Value` and every
  // arm reads it through `args["k"]`/`args.get("k")`, which are TOTAL: a Value
  // that is not an object simply answers null/None and the arm below reports a
  // missing argument. Indexing is not total in JS — `null["k"]` and
  // `Object.prototype.hasOwnProperty.call(null, "k")` both THROW — so a model
  // that emitted `"arguments": null` (or a bare string, array or number) would
  // reach an arm and crash the turn with a `TypeError`, which is precisely the
  // "never a thrown exception" this module's own doc forbids.
  //
  // `bridgeDispatcher.ts` already normalizes on the bridge path and
  // `mcpBridge.ts` before it, so this is the THIRD door on that route — but
  // `execTool` is exported and a native (non-bridge) chat loop calls it
  // directly with whatever the model emitted, and that caller has no such
  // door. One coercion here makes the function total for every caller, the
  // same way the `Value` makes it total for every Rust caller.
  const args: Record<string, unknown> =
    typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs) ? rawArgs : {};

  // Never trust the model's arguments — checked centrally, against each
  // tool's own advertised schema, so the guard cannot drift from what the
  // model was told. Ported verbatim from the Rust source's guard, which
  // runs before the match on every call, real arm or stub alike.
  const missing = missingRequiredArg(name, args);
  if (missing !== null) {
    return fail(missing);
  }

  if (isBrowseTool(name)) {
    return notImplemented(
      "the private browser's command surface (commands/browse.rs -> electron/main/browser/) is a separate, in-progress porting effort this batch did not wire into exec_tool"
    );
  }

  switch (name) {
    // ---------------------------------------------------------- REAL: memories
    case "add_memory": {
      const room = requireRoom(deps);
      return room.ok ? execAddMemory(deps, room.db, args) : fail(room.error);
    }
    case "list_memories": {
      const room = requireRoom(deps);
      return room.ok ? execListMemories(room.db) : fail(room.error);
    }
    case "update_memory":
    case "delete_memory": {
      const room = requireRoom(deps);
      return room.ok ? execUpdateOrDeleteMemory(deps, room.db, name, args) : fail(room.error);
    }

    // ------------------------------------------------------------ REAL: skills
    case "list_skills":
      return execListSkills(deps, args);
    case "read_skill":
      return execReadSkill(deps, args);
    case "read_skill_resource":
      return execReadSkillResource(deps, args);
    case "save_skill":
      return execSaveSkill(deps, args);
    case "write_skill_resource":
      return execWriteSkillResource(deps, args);
    case "delete_skill_resource":
      return execDeleteSkillResource(deps, args);

    // ------------------------------------------------------------- REAL: files
    case "list_room_files": {
      const room = requireRoom(deps);
      return room.ok ? execListRoomFiles(room.db) : fail(room.error);
    }
    case "search_room": {
      const room = requireRoom(deps);
      return room.ok ? execSearchRoom(room.db, args) : fail(room.error);
    }
    case "open_file": {
      const room = requireRoom(deps);
      return room.ok ? execOpenFile(room.db, args, deps.emit) : fail(room.error);
    }
    case "annotate_file": {
      const room = requireRoom(deps);
      return room.ok ? execAnnotateFile(room.db, args, effects, deps.emit) : fail(room.error);
    }

    // -------------------------------------------------- REAL: the organize box
    case "mark_image": {
      const room = requireRoom(deps);
      return room.ok ? execMarkImage(room.db, args, effects) : fail(room.error);
    }
    case "create_file": {
      const room = requireRoom(deps);
      // The cancel FLAG is handed over, never a boolean snapshot of it: Rust
      // reads it inside `Artifact::commit`, between staging and committing,
      // and reading it out here instead would miss a Stop pressed while the
      // bytes were being staged — "a window in which a Stop is honoured
      // everywhere except the write", as that funnel's own comment puts it.
      return room.ok
        ? execCreateFile(room.db, args, effects, {
            runId: deps.runId,
            cancel: deps.cancel,
            emit: deps.emit,
          })
        : fail(room.error);
    }
    case "rename_file": {
      const room = requireRoom(deps);
      return room.ok ? execRenameFile(room.db, args, effects, deps.emit) : fail(room.error);
    }
    case "move_file": {
      const room = requireRoom(deps);
      return room.ok ? execMoveFile(room.db, args, effects, deps.emit) : fail(room.error);
    }
    case "set_in_library": {
      const room = requireRoom(deps);
      return room.ok ? execSetInLibrary(room.db, args, effects, deps.emit) : fail(room.error);
    }
    case "organize_files": {
      const room = requireRoom(deps);
      return room.ok ? execOrganizeFiles(room.db, args, effects, deps.emit) : fail(room.error);
    }
    case "trash_files": {
      const room = requireRoom(deps);
      return room.ok ? execTrashFiles(room.db, args, effects, deps.emit) : fail(room.error);
    }
    case "merge_files": {
      const room = requireRoom(deps);
      return room.ok ? execMergeFiles(room.db, args, effects, deps.emit) : fail(room.error);
    }

    // ---------------------------------------------------------- edit_match gap
    case "edit_file":
    case "edit_files":
    case "write_file":
    case "set_cells":
      return notImplemented("the edit_match.rs port (diff-preview gate + fuzzy/section matching) — Batch D");

    // --------------------------------------------------------------- UI bridge
    case "ui_snapshot":
    case "ui_act":
    case "view_screenshot":
    case "view_media_frame":
      return notImplemented(
        "the AgentUi screen-driving bridge and native window/webview snapshot capture — Batch D"
      );

    // ------------------------------------------------------------- web/download
    case "web_search":
      return execWebSearch(deps, effects, args);
    case "fetch_page":
      return execFetchPage(deps, args);
    case "save_link":
      // NOT `commands/organize.rs` (ported) and NOT `web/fetch.rs` (ported —
      // `web.ts`'s `fetchReadable`/`youtubeTranscript` ARE the two engines this
      // arm reads with). What is missing is the INGESTION half:
      // `commands/files.rs`'s `import_link_and_index`, which turns either
      // reading into a Markdown room file and indexes it. Naming the wrong
      // module here would send Batch D to files that are already done.
      return notImplemented(
        "commands/files.rs's import_link_and_index (the save-as-Markdown / YouTube-transcript " +
          "ingestion funnel behind save_link) — Batch D. Its two READ engines are already ported " +
          "and tested as web.ts's fetchReadable/youtubeTranscript; do not re-port web/fetch.rs"
      );
    case "download_url":
      // Unlike download_media (wired for real just below), this arm needs
      // `files.rs`'s `import_download` — the staged-file → room-file import —
      // which has no Electron port. The FETCH half is done: `web.ts`'s
      // `downloadToTemp` ports `web/fetch.rs`'s guarded, streaming,
      // size-capped download (per-hop SSRF re-check, DNS pinning) including
      // `INLINE_DOWNLOAD_BYTES`/`MAX_DOWNLOAD_BYTES`. Wiring the fetch without
      // the import would stage a temp file nobody ever collects, so this stays
      // an honest stub until its other half lands.
      return notImplemented(
        "commands/files.rs's import_download (staged temp file → room file), plus the " +
          "outbound_url_hides cloud-privacy gate every download/save tool checks first — Batch D. " +
          "The guarded download engine itself IS ported and tested (web/fetch.rs's " +
          "download_to_temp is web.ts's downloadToTemp), as is the privacy check (privacy.ts, " +
          "installed via withRealPrivacyGates); do not re-port either. download_media (yt-dlp's " +
          "media engine) is wired for real; see that arm"
      );
    case "download_media":
      return execDownloadMedia(deps, args);

    // ------------------------------------------------------------------ scripts
    case "list_scripts":
    case "run_script":
      return notImplemented("the Scripts subsystem (fingerprint consent + script execution) — Batch D");

    // -------------------------------------------------------------------- sketch
    case "read_drawing":
    case "draw":
      return notImplemented("sketch.rs (the creator.draw agent) — out of scope for this batch per its own brief");

    // ------------------------------------------------------------------- studios
    case "studio_flashcards":
    case "studio_mindmap":
    case "generate_podcast_script":
      return notImplemented("the Studio generators — out of scope for this batch per its own brief");

    // ------------------------------------------------------------- transcription
    case "stt_status":
    case "read_recording":
    case "retranscribe_file":
      return notImplemented("rec/engine.py's on-device STT surface — Batch C/D");

    // --------------------------------------------- skills: the two gated verbs
    case "delete_skill": {
      // Rust routes this through `confirm_destructive` — a user-facing
      // consent dialog. `ExecToolDeps.confirmDestructive` now exists
      // (`delete_mcp` below already uses it), so this mirrors that arm's
      // exact pattern: refuse unconditionally while no consent surface is
      // wired, otherwise resolve, confirm, then delete via
      // `skillsCmds.ts`'s `agentDeleteSkill` (`agent_delete_skill`).
      // Checked before `requireRoom`, matching `delete_mcp`: a missing
      // consent surface is refused unconditionally, not only once a room
      // happens to be open.
      if (deps.confirmDestructive === undefined) {
        return notImplemented(
          "the confirm_destructive consent dialog for a skill deletion is not wired up — Batch D"
        );
      }
      const room = requireRoom(deps);
      if (!room.ok) return fail(room.error);
      try {
        const text = await agentDeleteSkill(room.db, args, deps.confirmDestructive);
        emitSafely(deps, "skills-changed", undefined);
        return ok(text);
      } catch (e) {
        return fail(errMessage(e));
      }
    }
    case "run_skill_script":
      return notImplemented("skill script execution (fingerprint consent + the script runner) — Batch D");

    // ----------------------------------------------------------- REAL: MCP mgmt
    case "list_mcps": {
      const room = requireRoom(deps);
      if (!room.ok) return fail(room.error);
      try {
        return ok(agentListMcps(room.db, deps.mcpStatuses ?? new Map()));
      } catch (e) {
        return fail(errMessage(e));
      }
    }
    case "read_mcp": {
      const room = requireRoom(deps);
      if (!room.ok) return fail(room.error);
      try {
        return ok(agentReadMcp(room.db, asString(args["name"])));
      } catch (e) {
        return fail(errMessage(e));
      }
    }
    case "save_mcp": {
      const room = requireRoom(deps);
      if (!room.ok) return fail(room.error);
      try {
        // Always saved disabled (agentSaveMcp force-sets it) — a human must
        // still review and approve it in Connectors before it can run.
        return ok(
          agentSaveMcp(room.db, args, {
            forgetConnectorGrants: deps.mcpForgetConnectorGrants,
            reconnect: deps.mcpReconnect,
          })
        );
      } catch (e) {
        return fail(errMessage(e));
      }
    }
    case "delete_mcp": {
      // Unrecoverable (the saved OAuth token goes with it) and reachable
      // from anything the agent READ, so — same reasoning as `delete_skill`
      // just above, and matching Rust's own `agent_delete_mcp`, which asks
      // BEFORE it ever touches `state.room` — this stays refused until a
      // real consent dialog is wired, rather than deleting behind a
      // confirmation the user never saw. Checked before `requireRoom` on
      // purpose: a missing consent surface is refused unconditionally, not
      // only once a room happens to be open.
      if (deps.confirmDestructive === undefined) {
        return notImplemented(
          "the confirm_destructive consent dialog for a connector deletion is not wired up — Batch D"
        );
      }
      const room = requireRoom(deps);
      if (!room.ok) return fail(room.error);
      try {
        const text = await agentDeleteMcp(room.db, args, {
          confirmDestructive: deps.confirmDestructive,
          forgetConnectorGrants: deps.mcpForgetConnectorGrants,
          reconnect: deps.mcpReconnect,
        });
        return ok(text);
      } catch (e) {
        return fail(errMessage(e));
      }
    }

    // -------------------------------------------------------- jobs/workflows
    case "start_file_pass":
    case "job_status":
    case "list_workflows":
    case "save_workflow":
    case "update_workflow":
    case "delete_workflow":
    case "run_workflow":
    case "test_workflow":
      return notImplemented("the jobs/workflows backend (no db-host/jobs.ts yet) — Batch C");

    // ------------------------------------------------------------ local_generate
    case "local_generate":
      return notImplemented("Ollama local-model execution (ollama.rs) — Batch D");

    // ---------------------------------------------------- REAL: consult_advisor
    case "consult_advisor":
      return execConsultAdvisor(deps, effects, args);

    default:
      return execConnectorRoute(deps, effects, name, args);
  }
}
