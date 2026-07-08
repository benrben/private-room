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
}

export interface Memory {
  id: string;
  content: string;
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
    | "binary";
  name: string;
  mime: string;
  editable: boolean;
  text: string | null;
  dataB64: string | null;
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
  "claude-cli": "Claude (cloud)",
  "codex-cli": "OpenAI (cloud)",
};

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

/** D9: state of the persistent Room MCP server (the Leash). */
export interface RoomServerStatus {
  running: boolean;
  url: string;
  config: string;
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
