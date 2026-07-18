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
}

/** An MCP config awaiting the user's approval before its servers start (SEC-1). */
export interface McpApproval {
  fingerprint: string;
  servers: { name: string; command: string }[];
}

/** A prior saved state of a file (ADD-2). */
export interface FileVersion {
  id: string;
  savedAt: string;
  cause: string;
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
}

/** A one-level folder inside the room (ADD-16). */
export interface Folder {
  id: string;
  name: string;
}

/** A prebuilt "#name" chat workflow, for autocomplete/help. */
export interface ChatCommand {
  name: string;
  summary: string;
  usage: string;
  needsRefs: boolean;
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
}

/** ADD-23: the `effects` column payload — what a turn's tools drew. */
export interface MessageEffects {
  boxes?: {
    fileId: string;
    name?: string;
    boxes: { label: string; x1: number; y1: number; x2: number; y2: number }[];
  };
  annotation?: AnnotationPayload;
  /** Wave 2 (Idea 4): content-free per-edit outcome records for the turn
   * (`{tool, outcome, n}`). Telemetry only — the UI renders nothing from it. */
  edits?: { tool: string; outcome: string; n?: number; files?: number }[];
}

/** ADD-25: one backend→webview request on the agent↔UI bridge. The driver
 * answers via api.resolveAgentUi(id, payload). */
export interface AgentUiRequest {
  id: string;
  kind: "ui_snapshot" | "ui_act" | "view_screenshot" | "media_frame";
  args: Record<string, unknown>;
}

export interface Memory {
  id: string;
  content: string;
  /** Wave 1b (idea 5): preference | fact | project | instruction, or null =
   * uncategorized (every pre-category row). */
  category: string | null;
  createdAt: string;
}

export interface FileContent {
  kind:
    | "image"
    | "pdf"
    | "docx"
    | "sheet"
    | "csv"
    | "markdown"
    | "html"
    | "code"
    | "text"
    | "audio"
    | "video"
    | "recording"
    | "binary";
  name: string;
  mime: string;
  editable: boolean;
  text: string | null;
  dataB64: string | null;
  /** ADD-24: audio/video only — token for the roommedia:// streaming
   * protocol (seekable, any size). The viewer plays
   * `roommedia://localhost/<token>` instead of a base64 data URL. */
  mediaToken: string | null;
}

// ---- ADD-27: the live Recording file ----

/** One transcribed word on the recording's timeline (centiseconds). `del`
 * marks words removed in the transcript editor — playback skips their span. */
export interface RecWord {
  w: string;
  t0: number;
  t1: number;
  del?: boolean;
}

export interface RecSegment {
  id: string;
  /** Which capture lane heard it: your mic, or the Mac's (meeting) audio. */
  source: "mic" | "sys";
  /** "You" for the mic; "Speaker N" for clustered meeting voices. */
  speaker: string;
  t0: number;
  t1: number;
  text: string;
  words: RecWord[];
  lang?: string | null;
}

/** A span deleted from the transcript; playback skips it, export removes it. */
export interface RecCut {
  t0: number;
  t1: number;
}

export interface RecMeta {
  version: number;
  durationCs: number;
  segments: RecSegment[];
  cuts: RecCut[];
  /** 0 = speakers are discovered from their voices (always, from the UI).
   * A non-zero value pins the participant count for an older room. */
  maxSpeakers: number;
}

export interface RecStart {
  fileId: string;
  name: string;
  meta: RecMeta;
}

export interface RecLive {
  fileId: string;
  status: string;
  durationCs: number;
  /** Durable per-source health [status, message] — lets a viewer that
   *  mounted after a fast failure still show the banner. */
  mic: [string, string];
  sys: [string, string];
}

export interface RecFile {
  name: string;
  meta: RecMeta;
}

// ---- ADD-28: feedback → GitHub issue ----

export interface FeedbackDraft {
  title: string;
  body: string;
}

export interface AppDiag {
  version: string;
  os: string;
  arch: string;
  /** "owner/repo" the issue opens against. */
  repo: string;
}

export interface AiStatus {
  running: boolean;
  /** True when Ollama is installed on this Mac even if not currently running
   * — lets onboarding tell "not installed" from "not started" (ADD-10). */
  installed: boolean;
  models: string[];
  defaultModel: string;
  /** Cloud CLIs detected on this Mac ("claude-cli", "codex-cli"). */
  external: string[];
}

export const ENGINE_LABELS: Record<string, string> = {
  "claude-cli": "Claude Code",
  "codex-cli": "Codex",
};

/** A specific model offered by a cloud engine (the Cloud picker's second
 * level) — `slug` is what gets sent to the CLI via `--model`, `label` is the
 * friendly display name, `efforts` are its supported reasoning levels (empty
 * if the engine has no effort knob), `defaultEffort` the engine-reported
 * default if any. */
export interface ExternalModelInfo {
  slug: string;
  label: string;
  efforts: string[];
  defaultEffort: string | null;
}

/** A cloud engine selection, most-specific-last:
 *   "claude-cli"                    bare engine (CLI default model+effort)
 *   "codex-cli::gpt-5.6-sol"        a specific model
 *   "codex-cli::gpt-5.6-sol::high"  a specific model AND reasoning effort
 * Mirrors the Rust-side `split_external_model`. Returns
 * [engine, model|null, effort|null]. */
export function splitExternalModel(
  model: string,
): [string, string | null, string | null] {
  const parts = model.split("::");
  const engine = parts[0];
  if (engine !== "claude-cli" && engine !== "codex-cli") return [model, null, null];
  return [engine, parts[1] ?? null, parts[2] ?? null];
}

/** Friendly label for any model id — local, bare cloud engine, or a composite
 * cloud-engine + model (+ effort) selection. `engineModels` is an optional
 * cache of the fetched model list per engine, used to turn a slug into its
 * display label; the effort (if any) is appended as "· <effort>". */
export function engineModelLabel(
  model: string,
  engineModels?: Record<string, ExternalModelInfo[]>,
): string {
  const [engine, submodel, effort] = splitExternalModel(model);
  const engineLabel = ENGINE_LABELS[engine];
  if (!engineLabel) return modelLabel(model) ?? model;
  if (!submodel) return engineLabel;
  const known = engineModels?.[engine]?.find((m) => m.slug === submodel)?.label;
  const base = `${engineLabel} — ${known ?? submodel}`;
  return effort ? `${base} · ${effort}` : base;
}

/** ADD-22: a local model's declared abilities (from Ollama /api/show), so the
 * picker can badge each model and warn when the chosen one can't drive the app. */
export interface ModelCaps {
  name: string;
  tools: boolean;
  vision: boolean;
}

/** ADD-18: state of the built-in dictation/transcription engine. The engine
 * (Whisper) is compiled into the app; only the model file downloads on demand. */
export interface SttStatus {
  installed: boolean;
  downloading: boolean;
  sizeMb: number;
}

/** Idea 3: one installed system speech voice (AVSpeechSynthesisVoice). */
export interface VoiceInfo {
  id: string;
  name: string;
  lang: string;
}

/** Friendly display names for models we ship guidance for. The stored setting
 * always keeps the raw id — this is display only (CHG-4). Unknown models the
 * user pulled themselves fall through to their raw id. */
const MODEL_LABELS: { match: (id: string) => boolean; label: string }[] = [
  { match: (m) => m.startsWith("qwen3.5"), label: "Standard local AI (recommended)" },
  { match: (m) => m.includes("qwen2.5vl") || m.includes("qwen2.5-vl"), label: "Vision helper (marks images)" },
];

/** Friendly name for a model id, or `null` if we ship no label for it. */
export function modelLabel(id: string): string | null {
  return MODEL_LABELS.find((m) => m.match(id))?.label ?? null;
}

export interface ImageBox {
  label: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Where a viewer should navigate/highlight when a file opens. */
export interface FileTarget {
  page?: number;
  cell?: string;
  find?: string;
  sheet?: string;
  range?: string;
  quote?: string;
}

/** Payload of an ```annotation block / agent-annotate event. */
export interface AnnotationPayload {
  fileId: string;
  name?: string;
  quote?: string;
  page?: number;
  sheet?: string;
  range?: string;
  note?: string;
  /** ADD-22: true when the exact quote wasn't found and the closest passage was
   * highlighted instead — the UI marks it "≈ closest match". */
  approx?: boolean;
}

export interface McpServerStatus {
  name: string;
  status: "connecting" | "connected" | "failed" | "disabled";
  error: string | null;
  tools: string[];
}

/** SEC-1b: a pending per-call MCP approval prompt from the backend. */
export interface McpApproveRequest {
  id: string;
  server: string;
  tool: string;
  args: string;
}

/** Wave 2 (Idea 6): one file's before/after in a diff-preview approval card. */
export interface EditPreviewFile {
  name: string;
  before: string;
  after: string;
  /** True when the preview text was clipped to the size ceiling. */
  clipped: boolean;
}

/** Wave 2 (Idea 6): a pending diff-preview approval prompt from the backend.
 * `allowTurn` is true only when the cadence is "Once per answer" AND the request
 * came from the run-scoped local engine — so the "rest of this answer" button is
 * never offered to a sink-less cloud/external client. */
export interface EditApproveRequest {
  id: string;
  tool: string;
  allowTurn: boolean;
  files: EditPreviewFile[];
}

/** Payload of the agent-open-file event: a bare file id, or an id with a
 * navigation hint (page/cell/find). */
export type AgentOpenFilePayload =
  | string
  | { id: string; page?: number; cell?: string; find?: string };

/* ============================================================
 * Moonshot feature types (Wave-3 API surface). Every new backend command
 * struct derives serde rename_all="camelCase", so fields are camelCase here.
 * ============================================================ */

/** D1: static model recommendations that drive first-run / vision pulls. */
export interface RecommendedModels {
  chat: string[];
  embed: string;
  vision: string;
}

/** D3: one node in the room's similarity graph (a file or a memory). */
export interface GraphNode {
  id: string;
  name: string;
  folder?: string;
  summary?: string;
  kind: "file" | "memory";
}

/** D3: a similarity link between two nodes; `shared` holds up to 3 short
 *  reason strings (overlapping terms, or a shared snippet). */
export interface GraphEdge {
  a: string;
  b: string;
  weight: number;
  shared: string[];
}

/** D3: the whole room graph, from roomGraph(). */
export interface RoomGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** D4: instant, model-free snapshot for the Front Page on unlock. */
export interface FrontPage {
  recentFiles: FileMeta[];
  recentChats: Chat[];
  memories: Memory[];
  suggestions: string[];
  fileCount: number;
  chatCount: number;
}

/** D6: whether the last exchange is worth remembering, plus the distilled fact. */
export interface MemorySuggestion {
  worth: boolean;
  fact: string;
}

/** D7: a suggested tidy-up for a freshly imported file (Smart import). */
export interface FileMetaSuggestion {
  title: string;
  folder: string;
  tags: string[];
}

/** D9: state of the persistent Room MCP server (the Leash). Wave 1a: `scope`
 * is the running trust tier; `stable` means the fixed port was bound (the
 * pasted config survives restarts); `allowCloud` echoes the effective cloud
 * sub-option so Settings shows the truth after reopening. */
export interface RoomServerStatus {
  running: boolean;
  url: string;
  config: string;
  scope: "files" | "full";
  stable: boolean;
  allowCloud: boolean;
}

/** D11: a selectable room persona (tutor, critic, opposing-counsel, …). */
export interface RoomRole {
  id: string;
  name: string;
  blurb: string;
  instructions: string;
  prompts: string[];
  commands: string[];
}

/** The default, editable prompts each Studio action runs with. */
export interface StudioPrompts {
  flashcards: string;
  mindmap: string;
  podcast: string;
}

/** ADD-30: a durable background job (deep summary) as the jobs panel sees it.
 * `status` is queued | running | paused | error | done. */
export interface Job {
  id: string;
  kind: string;
  title: string;
  plan: unknown;
  state: unknown;
  cursor: number;
  total: number;
  status: string;
  error: string | null;
  /** Wave 4a: set on a workflow's inline child job (hidden from the sidebar). */
  parentJobId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** ADD-30: one `job-progress` event — live counts plus terminal flags. */
export interface JobProgress {
  jobId: string;
  label: string;
  done: number;
  total: number;
  finished?: boolean;
  paused?: boolean;
  failed?: boolean;
  fileId?: string | null;
}

// ------------------------------------------------------------ Wave 4a: workflows

/** Where a workflow surfaces. `general` = library/top bar; `file` = a file's
 * Actions menu, run on that file. */
export type WorkflowBinding =
  | { scope: "general" }
  | { scope: "file"; kinds?: string[]; exts?: string[]; file_id?: string | null };

/** A saved LLM graph workflow. `definition`/`binding` are opaque JSON here. */
export interface Workflow {
  id: string;
  name: string;
  description: string;
  emoji: string;
  definition: WorkflowDef;
  status: "draft" | "active";
  createdBy: "user" | "agent";
  binding: WorkflowBinding;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The node graph. Nodes carry a `kind` discriminant plus its params. */
export interface WorkflowDef {
  version: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowNode {
  id: string;
  label?: string;
  kind:
    | "generate"
    | "summarize_file"
    | "file_pass"
    | "agent_run"
    | "save_file"
    | "condition";
  // Kind-specific params (flattened): prompt/model/select/instruction/mode/
  // name_template/format/question/op/value. Kept loose so the param sheet edits
  // them generically.
  [key: string]: unknown;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  branch?: "then" | "else" | null;
}

export interface Schedule {
  id: string;
  workflowId: string;
  kind: "interval" | "daily" | "weekly";
  param: string;
  enabled: boolean;
  catchUp: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastJobId: string | null;
}

export interface ScheduleArg {
  kind: string; // interval|daily|weekly, or "" to clear
  param?: string;
  enabled?: boolean;
  catchUp?: boolean;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  jobId: string | null;
  trigger: string;
  status: string;
  error: string | null;
  inputFileId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface WorkflowTemplate {
  name: string;
  description: string;
  emoji: string;
  binding: WorkflowBinding;
  schedule?: ScheduleArg;
  definition: WorkflowDef;
}

/** One `workflow-node` event — a node's live status during a run. */
export interface WorkflowNodeEvent {
  jobId: string;
  workflowId: string;
  nodeId: string;
  status: "running" | "done" | "skipped" | "error";
  peek?: string | null;
}
