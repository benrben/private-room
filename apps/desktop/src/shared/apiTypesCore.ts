import type { MessageEffects } from "./apiTypesMedia.js";

export interface RoomInfo {
  name: string;
  path: string;
  fileCount: number;
  messageCount: number;
  /** True when the room file lives in a cloud-sync folder (HLT-6). */
  synced: boolean;
  /** Set when the room has enabled MCP servers whose config fingerprint is
   * not yet approved on this Mac — the UI must ask before anything runs
   * (SEC-1). null when there's nothing to approve. */
  pendingMcp: McpApproval | null;
  /** Another Arcelle process owns this workspace's writer lease. */
  readOnly?: boolean;
  /** A raw filesystem copy reused another workspace's identity. */
  duplicateRoomIdentity?: boolean;
}

// ---- Unified provider-neutral agent harness -----------------------------

export type HarnessProvider =
  | "codex"
  | "claude"
  | "ollama-local"
  | "ollama-cloud"
  | "openrouter";
export type HarnessName =
  | "codex-app-server"
  | "claude-agent-sdk"
  | "arcelle-deep"
  | "legacy-cli";
export type HarnessPrivacyMode = "local" | "cloud-direct" | "cloud-redacted";
export type HarnessApprovalDecision =
  | "allow-once"
  | "allow-run"
  | "deny"
  | "cancel";

/** Provider-neutral events emitted by the Electron harness controller. */
export type HarnessEvent =
  | { type: "run_started"; runId: string; harness: HarnessName }
  | { type: "agent_started"; runId: string; agentId: string; label?: string }
  | { type: "plan_updated"; runId: string; text: string }
  | { type: "text_delta"; runId: string; text: string; agentId?: string }
  | { type: "tool_requested"; runId: string; requestId: string; tool: string; input: unknown }
  | { type: "approval_requested"; runId: string; requestId: string; tool: string; detail: string }
  | { type: "tool_started"; runId: string; tool: string; toolId?: string }
  | { type: "tool_completed"; runId: string; tool: string; toolId?: string; result?: unknown; error?: string }
  | { type: "file_changed"; runId: string; relativePath: string; change: string }
  | { type: "usage_updated"; runId: string; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: "agent_completed"; runId: string; agentId: string }
  | { type: "run_failed"; runId: string; error: string }
  | { type: "run_completed"; runId: string; status: "completed" | "cancelled" };

export interface HarnessCapabilities {
  flags: Record<string, boolean>;
  roomFormat: "workspace-folder" | "sealed-db" | null;
  outsideWorkspaceIsolation: boolean;
  providers: Record<
    string,
    {
      enabled: boolean;
      installed: boolean;
      reason: string | null;
      harness: HarnessName | null;
    }
  >;
}

export interface HarnessRollbackResult {
  restored: string[];
  removedCreated: string[];
  conflicts: string[];
}

export interface HarnessHistoryChange {
  fileId: string;
  relativePath: string;
  change: string;
  rollbackState: string | null;
}

export interface HarnessHistoryRun {
  runId: string;
  provider: string;
  harness: string;
  model: string;
  privacyMode: HarnessPrivacyMode;
  status: string;
  writeEnabled: boolean;
  baselineCompleted: boolean;
  rollbackStatus: string;
  startedAt: string;
  completedAt: string | null;
  changes: HarnessHistoryChange[];
}

/** Live, provider-neutral progress for long workspace storage operations. */
export type WorkspaceOperationKind =
  | "legacy-conversion"
  | "sealed-package-create"
  | "sealed-package-import"
  | "workspace-checkpoint"
  | "write-baseline";

export type WorkspaceOperationPhase =
  | "preparing"
  | "planning"
  | "scanning"
  | "copying-files"
  | "copying-history"
  | "validating"
  | "publishing"
  | "snapshotting"
  | "completed"
  | "failed";

export interface WorkspaceOperationProgressEvent {
  /** Stable for one invocation; write baselines use the harness run ID. */
  operationId: string;
  operation: WorkspaceOperationKind;
  phase: WorkspaceOperationPhase;
  status: "started" | "running" | "completed" | "failed";
  completed: number;
  total: number | null;
  unit: "steps" | "files" | "objects";
}

/** An MCP config awaiting the user's approval before its servers start (SEC-1). */
export interface McpApproval {
  fingerprint: string;
  servers: { name: string; command: string }[];
}

/** ART-1: what produced one state of a generated artifact — ids and names only,
 * never content. Every field is optional because the room records what it
 * actually witnessed: a missing `agent` means nobody recorded one, not "unknown
 * agent". */
export interface Provenance {
  runId?: string;
  agent?: string;
  tool?: string;
  sourceFileIds?: string[];
}

/** A prior saved state of a file (ADD-2). `provenance` is present only where the
 * app witnessed the write (ART-1) — absent on a person's own saves and on every
 * version from before provenance was recorded. */
export interface FileVersion {
  id: string;
  savedAt: string;
  cause: string;
  provenance?: Provenance;
  /** Kept on purpose: outside the rolling window the room prunes on each save. */
  pinned: boolean;
  /** Bytes this snapshot occupies — every version is a whole copy of the file. */
  bytes: number;
}

/** Idea 11: a saved version's extracted text next to the file's current text,
 * for the read-only side-by-side compare view. Either side is null when that
 * file kind has no comparable text (image/binary). */
export interface VersionContent {
  fileName: string;
  versionText: string | null;
  currentText: string | null;
}

/** Idea 9: one whole-room checkpoint — a full encrypted copy of the room file
 * beside it, with plaintext metadata only (name/date/size). `auto` marks the
 * pre-rollback safety copies (capped, pruned) apart from user checkpoints. */
export interface CheckpointMeta {
  id: string;
  name: string;
  createdAt: string;
  sizeBytes: number;
  auto: boolean;
}

/** A recently opened room, listed on the start screen (ADD-5). */
export interface RecentRoom {
  name: string;
  path: string;
  /** Unix epoch millis of the last open; absent for entries saved earlier. */
  openedAt?: number | null;
  /** True when nothing is at `path` any more — moved, deleted, or on a drive
   * that isn't plugged in. Recomputed by `list_recent` on every read, so it is
   * an answer about right now, not a cached one. */
  missing?: boolean;
}

export interface FileMeta {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  source: string;
  hasText: boolean;
  createdAt: string;
  /** Folder this file sits in, or null for the top level (ADD-16). */
  folderId: string | null;
  /** True when only the first N chunks were indexed (HLT-4). */
  partiallyIndexed: boolean;
  /** The cached one-liner describing this file ("Describe new files
   * automatically" in Settings, or a manual Summarize-room run) — null until
   * that has run for this file, or for a file with nothing to describe. */
  aiSummary: string | null;
  /** Which destination MADE this file — "library" for everything that belongs
   * to the room at large (imports, saved pages, generated artifacts, and every
   * file that predates this column), else "sketch", "create", "recordings". */
  originDestination: string;
  /** Whether Home's Library shows it. A second, independent fact: a promoted
   * sketch is still a sketch, and a Library file opened in the sketch editor is
   * still a Library file. See `isLibraryVisible` in fileVisibility.ts. */
  libraryVisibility: "linked" | "sectionOnly";
}

/** Who deleted a file. Recorded at the moment of deletion — `"unknown"` is a
 * row written before the actor was tracked, and says so rather than being
 * blamed on the person. */
export type TrashActorKind = "user" | "agent" | "app" | "unknown";

/** Trash: a deleted file, as the trash view shows it. NOT a `FileMeta` — a
 * trashed file is not in the room, and giving it the same shape invites it into
 * a list that means "what's here". */
export interface TrashedFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** When it was deleted (ISO-8601, the room's own clock). */
  trashedAt: string;
  trashedBy: TrashActorKind;
  /** Which agent/tool or which command, when the kind alone isn't the answer. */
  trashedById: string | null;
  /** The folder it goes back to on restore, or null for the top level. */
  folderId: string | null;
}

/** A one-level folder inside the room (ADD-16). */
export interface Folder {
  id: string;
  name: string;
}

/** One speaker in a podcast script, and the voice that reads them. */
export interface PodcastHost {
  /** The JOIN KEY between a line and a voice — the speaker name exactly as it
   * appears in every turn. Renaming a host rewrites its turns to match. */
  name: string;
  /** A neural voice id from the live catalog. "" = the product default. */
  voice: string;
  /** Edge prosody, e.g. "+22%" / "-2Hz". "" = the service default. */
  rate: string;
  pitch: string;
}

/** One line of an episode. */
export interface PodcastTurn {
  speaker: string;
  line: string;
}

/** A generated podcast script as DATA, so its hosts can be cast and the
 * episode rendered without asking the model to write it again. */
export interface Podcast {
  /** The script page's file id — the row's identity. */
  fileId: string;
  title: string;
  turns: PodcastTurn[];
  cast: PodcastHost[];
  /** The rendered episode, when one exists — an ordinary room file. */
  audioFileId: string | null;
  createdAt: string;
}

/** One file a batch operation could not act on, and why. */
export interface BulkFailure {
  /** The file's name, or its id when even that could no longer be read. */
  name: string;
  error: string;
}

/** What a batch file operation actually did (`commands::bulk`).
 *
 * Every field is read back from the room, never assumed from the input list —
 * which is the whole reason these commands return a value instead of `void`.
 * A multi-file move is best-effort by design (unlike `edit_files`, which is
 * atomic): independent files must not lose 39 good moves to a 40th bad id, so
 * the ones that failed come back NAMED rather than silently dropped. */
export interface BulkReport {
  /** Names of the files that really changed, in the order given. */
  ok: string[];
  failed: BulkFailure[];
  /** Ids past the backend's per-batch ceiling that were never attempted. */
  capped: number;
}

/** A prebuilt "#name" chat workflow, for autocomplete/help. */
export interface ChatCommand {
  name: string;
  summary: string;
  usage: string;
}

/** One canonical specialist row for the composer's "*name" menu. Derived per
 *  room by the sidecar registry (`list_specialists`), never duplicated in the
 *  frontend. A missing prerequisite keeps the row in the catalog with
 *  `capability: "unavailable"`, so discovery and dispatch policy cannot drift. */
export interface Specialist {
  /** The short key the user types after "*" ("browse"). */
  key: string;
  /** The `ask_*_agent` tool this specialist's domain hangs under. */
  tool: string;
  /** The worker this tag runs ("chat.browse"). One row per AGENT, not per
   *  domain — the Browser agent is its own menu entry beside the Web agent. */
  agent: string;
  /** Its own label, the same words the agent diagram uses ("Browser agent"). */
  label: string;
  /** One plain-words noun phrase: the area it covers. */
  area: string;
  /** The full sentence: what it can actually be asked for. */
  description: string;
  /** Effective ability after the selected provider and privacy policy. */
  capability?: "full" | "inspect-only" | "unavailable";
  /** Why actions are restricted, written for display before dispatch. */
  capabilityReason?: string;
  /** Changing to an on-device model restores the restricted actions. */
  localHandoff?: boolean;
}

/** Grouped results of a room-wide search (ADD-6). */
export interface SearchResults {
  files: { id: string; name: string; snippet: string }[];
  messages: { chatId: string; messageId: string; snippet: string }[];
  memories: { id: string; snippet: string }[];
}

export interface ImportReport {
  imported: FileMeta[];
  errors: string[];
}

/** One quality a video offers, for the download modal's picker. `approxBytes`
 *  is the estimated finished size when the site states one — absent means
 *  "size unknown", never a made-up number. `fits` says whether that estimate
 *  fits the room-file cap. */
export interface MediaQualityOption {
  height: number;
  approxBytes: number | null;
  fits: boolean;
}

/** A single AI action definition surfaced in the file/room "AI actions" menu.
 *  `scope` decides where it appears (file context menu vs whole-room area);
 *  `needsQuestion` is true only for "research", which shows an extra field. */
export interface AiActionDef {
  id: string;
  title: string;
  description: string;
  scope: "file" | "room";
  needsQuestion: boolean;
  /** ADD-27: true only for "translate" — the modal shows a language picker. */
  needsLanguage: boolean;
  defaultPrompt: string;
}

export interface Chat {
  id: string;
  title: string;
  createdAt: string;
  /** When this conversation was last spoken in — the newest message's stamp,
   *  or `createdAt` for one nobody has written in yet. The list is ordered by
   *  this, so "Continue where you left off" means the thread you were in. */
  lastAt: string;
}

export interface Message {
  id: string;
  role: string;
  content: string;
  sources: string[];
  createdAt: string;
  /** ADD-23: structured viewer effects (boxes/annotation) for this turn.
   * Rendered from data — the message content itself stays plain prose.
   * Null for plain answers and for user messages. */
  effects: MessageEffects | null;
  /** Marks a non-ordinary row without repurposing `role` — today only
   * `"handoff"` (a context-compaction summary marker). Null/absent for every
   * ordinary user/assistant message. */
  kind?: string | null;
}

/** PRIV-1: one protected entity in the room's map. */
export interface PrivacyEntity {
  id: string;
  realText: string;
  placeholder: string;
  category: string;
  /** "user" (block list) | "scan" (found by the local scanner). */
  source: string;
}

/** PRIV-1: the Settings section's full picture. */
export interface PrivacyStatus {
  globalDefaultOn: boolean;
  /** The room's explicit override: "on" | "off" | null (= follow global). */
  roomSetting: string | null;
  effectiveOn: boolean;
  entities: PrivacyEntity[];
  concepts: string[];
  pendingFiles: number;
  scanning: boolean;
  /** Why the last scan stopped without finishing, if it did. The terminal
   *  `privacy-scan` event says the same thing once; this survives for a window
   *  that had not mounted its listener yet. */
  lastScanError: string | null;
  /** Whether remote-connector arguments are masked right now. NOT implied by
   * `effectiveOn` — that seam is deliberately switch-blind, so the panel is
   * told rather than left to infer it. */
  connectorArgsMasked: boolean;
}

/** PRIV-1: the reader's cloud view — the file exactly as a non-local model
 * would receive it. */
export interface PrivacyPreview {
  text: string;
  entitiesHidden: number;
  replacements: number;
  present: string[];
}

/** PRIV-1: the ask-privacy event — what the door did on one turn. */
export interface AskPrivacy {
  entities_hidden?: number;
  replacements?: number;
  images_blocked?: number;
  bypassed?: boolean;
}

/** The token-budget bar's 5 fixed breakdown categories, in legend/stacking
 * order (tokens.css --tok-* vars). Never reordered. */
export type TokenCategory = "system" | "history" | "tools" | "skills" | "files";

/** The ask-token-usage event — one live per-turn snapshot, pushed once per
 * completed assistant turn. Snake_case throughout, matching `AskPrivacy`:
 * this is a raw pass-through of the sidecar/Rust-constructed JSON value, not
 * a camelCase-derived struct. `breakdown` is always a char-length estimate
 * (proportional split, scaled to `total_tokens` when a real engine aggregate
 * is known); `estimated` flags when `total_tokens` itself is also estimated
 * (no exact usage obtainable from this engine at all). The same shape is
 * reused for the persisted `MessageEffects.usage` blob. */
export interface AskTokenUsage {
  round?: number;
  total_tokens: number;
  max_context: number;
  estimated: boolean;
  breakdown: Record<TokenCategory, { tokens: number; estimated: boolean }>;
}

/** Dispatch-first agent visibility: one roster entry per plan step — which
 * domain agent will handle it. The whole array arrives once per ask via
 * `ask-plan`, before any work starts (single-step turns get a 1-item roster).
 * Snake-free pass-through of the sidecar's plan event body. */
export interface AskPlanStep {
  /** Registry id, e.g. "jobs.run". */
  agent: string;
  /** Human-readable agent name, e.g. "Jobs & long passes". */
  label: string;
  /** The clause of the user's ask this step will execute. */
  instruction: string;
  /** This entry's own state. Every `ask-plan` is a COMPLETE snapshot, so the
   * latest one is the whole truth — no diffing, no dependence on event order
   * (children emit concurrently, so their order guarantees nothing).
   * Optional: an older sidecar omits it, and the graph falls back to deriving
   * state from the single `step` marker. */
  status?: AgentNodeStatus;
  /** Which dispatch round sent this specialist. Entries sharing a batch were
   * launched TOGETHER and run in parallel — the one fact that makes the
   * fan-out legible, and the one thing roster growth alone cannot express.
   * `null` on the Main agent, which is the hub rather than a dispatched child. */
  batch?: number | null;
  /** Uniquely addresses this node ("main", or "<agent id>#<slot>"). The
   * registry id will NOT do: one round can dispatch two `files.read` children,
   * and each needs its own tool-step bucket. */
  key?: string;
  /** Why a node that never RAN is marked failed — a delegation to a domain
   * this room cannot serve. It rides on the roster rather than arriving as an
   * `ask-report` because the sidecar refuses these from a synchronous path
   * that cannot emit. A node that ran reports through `ask-report` instead. */
  report?: string;
}

/** The `ask-report` event: what one specialist handed back to the Main agent.
 *
 * The same words stream as `ask-delta` while that child holds the live-text
 * lease, and the next `ask-round` wipes them — correctly, since that area shows
 * the current round. This is the durable copy, so the diagram can show what a
 * child actually said instead of only that it said something. */
export interface AskReport {
  /** The `AskPlanStep.key` of the agent that reported. */
  node: string | null;
  text: string;
  /** False when the delegation failed — then `text` is the reason. */
  ok: boolean;
}

/** A node's state in the turn's agent graph. Rendered so it never depends on
 * colour alone — each state also carries its own glyph and outline. */
export type AgentNodeStatus = "pending" | "running" | "done" | "failed";

/** The `ask-agent` event — which roster entry is active right now. */
export interface AskActiveAgent {
  id: string;
  label: string;
  /** 1-based position in the roster. With a parallel batch in flight this
   * points at the FIRST running child; read `active_steps` for the real set. */
  step: number;
  total: number;
  /** Every 1-based slot running right now. A batch lights several at once,
   * which `step` alone cannot say. Optional — older sidecars omit it. */
  active_steps?: number[];
}

/** The `ask-step` event. Payload is a bare string from the many non-sidecar
 * emitters (chat commands, ai_actions, the native agent paths) and an object
 * from the sidecar, which stamps the emitting agent's graph slot. `api.ts`
 * normalises both to this shape. */
export interface AskStep {
  label: string;
  /** The `AskPlanStep.key` of the agent that ran this tool, when known. */
  node?: string | null;
}

/** Who an `ask-*` event belongs to (owner replacement #4, 2026-08-03).
 *
 * Every turn event is broadcast to the whole window, so before this the only
 * way a listener could tell whose event it was reading was "whatever chat is
 * mounted right now" — which is why an answer streamed into the wrong
 * conversation and a brand-new chat showed the previous one's token bar.
 *
 * `runId` is the ask id the composer minted and handed to `ask`/`run_command`,
 * so the chat has the run registered before the first event can arrive and
 * rejects anything naming a different one — including a late event from a turn
 * it already finished. Both are null for the handful of emitters that belong to
 * no conversation at all (the AI-actions menu); see `ownerOf` in effects.ts. */
export interface AskTurn {
  runId: string | null;
  chatId: string | null;
}

/** PRIV-2: privacy-scan progress events. */
export interface PrivacyScanProgress {
  running: boolean;
  done: number;
  total: number;
  label?: string;
  /** Terminal events only: why the scan stopped without finishing. */
  error?: string | null;
}

/** ADD-31: a named stage while a Studio artefact is being written.
 *
 * `local` is the whole reason this is a struct and not a string. When it is
 * false the step says room content is leaving the Mac, which is a privacy
 * consequence rather than a progress aside, and the AI pane draws the two
 * differently. Recovering that by matching "leaves this Mac" against `step`
 * would break on the first reworded sentence — silently, and in the direction
 * that under-warns. It comes from the model's DECLARED capabilities in
 * studios.rs, not from its name. */
