import type { Chat, FileMeta } from "./apiTypesCore.js";
import { ENGINE_LABELS } from "./apiTypesMedia.js";
import type { CastMember, CreateModel, ExternalModelInfo, Memory, StoryList } from "./apiTypesMedia.js";

export interface ShotPreview {
  shotId: string;
  /** 1-based place in the list, as the row is labelled. */
  n: number;
  action: string;
  /** The words that will be sent, verbatim. */
  prompt: string;
  /** The length after the model's own published list has had its say. */
  seconds: number | null;
  model: string;
  /** The picture the clip opens on, and the one it closes on — the second is
   * the next shot's opening picture, which is what joins them. */
  startFileId: string | null;
  endFileId: string | null;
  /** The portraits that ride along as guidance. "Mira is in this shot" is a
   * claim; the picture that will be sent is the evidence for it. */
  referenceFileIds: string[];
  cast: string[];
  /** Cast in this shot with NO picture — the ones who will be re-imagined from
   * words on every call rather than looking like themselves. */
  faceless: string[];
  /** The model that would not take an ending picture here, so the join was
   * dropped. Per shot, because a list can mix models. */
  joinDropped: string | null;
  /** True when this clip OPENS on the frame the previous clip really ends on —
   * captured from the finished video, not aimed at. The join, stated as a
   * promise the run can actually keep. */
  startsOnPrevious: boolean;
  /** Why this shot is not being sent. Null means it is. */
  skip: string | null;
}

/** What pressing "Draw them" / "Film them" would actually do. */
export interface FilmPlan {
  kind: "image" | "video";
  /** Every shot, sent or not — a row missing from the review is a row nobody
   * can ask about. */
  shots: ShotPreview[];
  sending: number;
  skipped: number;
  totalSeconds: number;
  /** How many clips OPEN on the captured end of the one before. Aiming with a
   * last frame is not counted — it is aim, not contact. */
  joined: number;
  overCap: boolean;
  /** The model that will not take an ending picture. THE reason "clip one ends
   * on a frame clip two does not start with" — the clips get made either way,
   * so without this the failure is only findable by watching twenty videos. */
  joinBlockedBy: string | null;
  /** Everyone in the run with no portrait, deduplicated. */
  faceless: string[];
}

/** The outcome of one press of "Draw them" / "Film them". */
export interface ShotRunStarted {
  jobIds: string[];
  /** How many were meant to start, so a short run reads as a shortfall rather
   * than as a smaller number with nothing to compare it against. */
  asked: number;
  shortfall: string | null;
}

/** One shot: what happens, who is in it, and what has been made of it. */
export interface StoryShot {
  id: string;
  listId: string;
  ord: number;
  action: string;
  castIds: string[];
  /** Null = the model's own default. Legal lengths differ per model, so a
   * number chosen before the model may be illegal after it. */
  seconds: number | null;
  imageModel: string;
  videoModel: string;
  stillFileId: string | null;
  clipFileId: string | null;
}

/** One room picture, small enough to draw a hundred of. The thumbnail is a
 * downscaled JPEG — a grid of full-size pictures would cost hundreds of
 * megabytes to show a few kilobytes of information. */
export interface RoomPicture {
  fileId: string;
  name: string;
  thumbB64: string;
}

/** One shot a split would produce. */
export interface PlannedShot {
  action: string;
  /** This shot's OWN length — per shot, not one number for all of them. A
   * real script has a ten-second beat in it, and flattening that to fifteen
   * would change the author's pacing without saying so. */
  seconds: number;
}

/** What breaking a script into shots would produce, before it is written. */
export interface ShotPlan {
  parts: number;
  totalSeconds: number;
  /** Every shot, so the split can be seen before it is committed. */
  shots: PlannedShot[];
  /** True when the SCRIPT declared its own chunks (`**00:00–00:15** — …`) and
   * they were used verbatim, rather than the room cutting it by length. The
   * two produce very different results, so the page says which happened. */
  fromScript: boolean;
}

/** Everything the Story tab draws itself from, in one round trip. */
export interface StoryBoard {
  cast: CastMember[];
  lists: StoryList[];
  shots: StoryShot[];
  selected: string | null;
}

/** Why a set of models is NOT on the Create shelf. Returned rather than
 * dropped: "where is Claude" is the question this page has to answer. */
export interface CreateExclusion {
  engineLabel: string;
  reason: string;
  count: number;
  examples: string[];
}

/** Everything the Create page needs to draw itself. */
export interface CreateCatalog {
  models: CreateModel[];
  /** The denominator in "11 of 34 can make a picture". */
  scanned: number;
  excluded: CreateExclusion[];
  /** False means "connect a provider", which is a different sentence from
   * "nothing here can draw". */
  anyProvider: boolean;
  /** A provider is connected but its catalog would not load. */
  error: string | null;
}

export interface AiProviderStatus {
  id: string;
  label: string;
  connected: boolean;
}

const EXTERNAL_MODEL_ENGINES = new Set([
  "claude-cli",
  "codex-cli",
  "antigravity-cli",
  "openrouter",
]);

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
  const engine = parts[0] ?? "";
  if (!EXTERNAL_MODEL_ENGINES.has(engine)) {
    return [model, null, null];
  }
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

/** One capability answer. `"unknown"` is a real answer, not a missing one: an
 * engine we could not reach must never be rendered as capable OR incapable —
 * the same rule the host's `Support` enum states. */
export type Support = "yes" | "no" | "unknown";

/** The capability questions the host will answer. Closed on purpose — mirrors
 *  the host's `Capability` enum, so a caller cannot ask for one nothing
 *  declares an answer for. */
export type Capability =
  | "streaming"
  | "tool_calling"
  | "vision"
  | "structured_output"
  | "chat"
  | "image_generation"
  | "video_generation";

/** The engine's DECLARED capability record (src-tauri/src/commands/
 *  capabilities.rs). One record per provider, refined per-model where the live
 *  catalog knows more. Nothing in the UI re-derives these from a model name. */
export interface EngineCapabilities {
  engine: string;
  label: string;
  model: string;
  local: boolean;
  streaming: Support;
  toolCalling: Support;
  vision: Support;
  structuredOutput: Support;
  chat: Support;
  /** Can it hand back PIXELS / a CLIP — the mirror of `vision`, and separate
   *  questions from each other: a model that draws a still need not move it.
   *  `"unknown"` on every engine that publishes no modality list, which the
   *  Create page treats as "do not offer this". */
  imageGeneration: Support;
  videoGeneration: Support;
  contextWindow: number | null;
  tier: string;
  /** Would pixels actually ARRIVE? The privacy door strips images out of every
   *  non-local request, so "can see" and "will receive the picture" are two
   *  different facts and the UI must not merge them. */
  imageReaches: boolean;
}

/** Why a preflight blocked, as a value rather than a sentence — two blocks that
 *  read alike need different offers, and matching on the prose would re-derive
 *  a distinction the host's record already made.
 *   • "capability"  — the engine itself cannot. A different (or newly
 *     downloaded) model is the fix, so an offer to install one is honest.
 *   • "privacy-door" — it can, but this room's door removes what it needs. The
 *     fix is a switch the user owns; offering a download here is noise. */
export type BlockCode = "capability" | "privacy-door";

/** What a PREFLIGHT check concluded for the room's engine, before a run. */
export type EnginePreflight =
  | { status: "ready" }
  | { status: "unknown"; reason: string }
  | { status: "blocked"; code: BlockCode; reason: string };

export interface AgentRow {
  id: string;
  label: string;
}

export interface ProviderRow extends EngineCapabilities {
  /** Installed / connected on THIS Mac right now. */
  available: boolean;
  /** Agent ids this provider's tier can reach — derived by the sidecar from its
   *  own registry, never a list written down here. */
  agents: string[];
}

/** The published provider × agent support matrix (owner decision #3). */
export interface SupportMatrix {
  agents: AgentRow[];
  providers: ProviderRow[];
  /** False when the sidecar could not be reached. The capability columns are
   *  still true (they are declared in the host); the agent columns are simply
   *  not known, and the UI says so rather than drawing an empty grid that would
   *  read as "no agent works anywhere". */
  agentsKnown: boolean;
  agentsError: string | null;
}

/** ADD-18: state of the built-in dictation/transcription engine. The engine
 * (Whisper) is compiled into the app; only the model file downloads on demand. */
export interface SttStatus {
  installed: boolean;
  downloading: boolean;
  sizeMb: number;
}

/** Renderer-owned streaming dictation session. Electron provisions the
 * authenticated sidecar URL; PCM and transcript events never cross IPC. */
export interface DictSessionInfo {
  url: string;
  stopBaseMs: number;
  stopPerAudioSecondMs: number;
}

/** Idea 3: one voice from the Edge service's LIVE catalog (the app bundles
 * no roster — the picker is fed from `list_neural_voices` at open). */
export interface NeuralVoiceInfo {
  id: string;
  gender: string;
  locale: string;
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
  /** True when reached over the network (a remote HTTP server) — the UI badges
   * it "reaches the internet" vs a local "runs on your Mac" connector. */
  remote: boolean;
}

/** One connector's answers to the two connector powers (mirrors Rust's
 * `ConnectorOverride`). A power that is ABSENT means "follow the Mac-wide
 * switch" — that is a third state, not a `false`, and collapsing it would make
 * the switch above unable to change anything. */
export interface ConnectorOverride {
  auto_approve?: boolean;
  outbound_unmask?: boolean;
}

/** Per-connector overrides keyed by connector name. Empty when every connector
 * follows the two switches. */
export type ConnectorPowers = Record<string, ConnectorOverride>;

/** What "Install" would write into the room's mcpServers config, from the
 * marketplace. Tagged union on `kind` (mirrors Rust's InstallSpec). */
export type InstallSpec =
  | { kind: "stdio"; command: string; args: string[]; envKeys: string[] }
  | { kind: "http"; url: string; headerKeys: string[] };

/** One normalized marketplace listing from the MCP registry (mcp_registry.rs
 * CatalogEntry). */
export interface CatalogEntry {
  id: string;
  name: string;
  /** The registry's human title when present; the UI shows this, falling back
   * to `name`. */
  title: string | null;
  /** The server's icon as an inlined `data:` URI (backend-proxied — the CSP
   * blocks remote images), or null → show a monogram. */
  icon: string | null;
  description: string;
  publisher: string;
  /** The publisher demonstrably owns the namespace (registry trust signal). */
  verified: boolean;
  /** Installs a remote endpoint — data leaves the Mac when the tool is called. */
  remote: boolean;
  transport: "stdio" | "http" | "sse" | string;
  repository: string | null;
  install: InstallSpec;
  /** The other transport when the record offers both a local package and a
   * remote endpoint — `install` is the (privacy-first) local default, this is
   * the cloud alternative the drawer can switch to. null when only one exists. */
  altInstall: InstallSpec | null;
}

/** SEC-1b: a pending per-call MCP approval prompt from the backend. */
export interface McpApproveRequest {
  id: string;
  server: string;
  tool: string;
  args: string;
  /** Audit #505: set when this card is an agent-initiated DELETION, not a tool
   * call — the sentence naming what goes with it. `server` is then the thing's
   * name and `tool` is what kind of thing it is. Present means the destructive
   * card: no "always allow", because standing consent to run connector tools
   * was never consent to destroy the room's own configuration. */
  confirm?: string;
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

/** D1: the two SPECIAL models Settings offers to pull. There was a `chat`
 * list here too, which no screen ever rendered — the first-run chooser has its
 * own richer roster in `workspace/constants.ts`. */
export interface RecommendedModels {
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

/** D3: a TYPED link between two nodes. `kind` says which relationship it is —
 *  "derived" | "same_page" | "mentions" | "cited" | "same_site" are relations
 *  the room can prove from what it stored, "similar" is the only inferred one.
 *  `directed` marks the a → b relations (a produced b, or a names b), and
 *  `shared` holds up to 3 short pieces of evidence for the link. */
export interface GraphEdge {
  a: string;
  b: string;
  weight: number;
  kind: string;
  directed: boolean;
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

/** Whether a local connector's command can run right now, and if not, whether
 * one download fixes it (`mcp_runtime_for_command`). A connector needing
 * `uvx`/`npx` on a Mac without them used to fail with the launcher's raw error
 * and no way to fix it from inside the app. */
export interface RuntimeStatus {
  /** The command can run as-is — a downloaded or system runtime satisfies it. */
  available: boolean;
  /** The runtime a download would provide ("uv" | "node"), when there is one. */
  kind: string | null;
  /** A one-time download would make it available. */
  provisionable: boolean;
  /** One plain-words line for the prompt. */
  note: string;
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
  /** Why this job stopped when nobody chose to stop it — the room was locked,
   * or the app closed, while it was still running. Null/absent means the pause
   * was the user's own Stop, which the card says differently. */
  parkedReason?: string | null;
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
