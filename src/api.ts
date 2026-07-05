import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  open,
  save,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "@tauri-apps/plugin-dialog";

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
  "claude-cli": "Claude Code (cloud)",
  "codex-cli": "Codex (cloud)",
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

export const api = {
  createRoom: (path: string, password: string) =>
    invoke<RoomInfo>("create_room", { path, password }),
  openRoom: (path: string, password: string) =>
    invoke<RoomInfo>("open_room", { path, password }),
  closeRoom: () => invoke<void>("close_room"),
  // ---- Wave 6: Touch ID unlock (ADD-11) ----
  touchIdHas: (path: string) => invoke<boolean>("touchid_has", { path }),
  touchIdEnable: () => invoke<void>("touchid_enable"),
  touchIdDisable: (path: string) => invoke<void>("touchid_disable", { path }),
  touchIdOpen: (path: string) => invoke<RoomInfo>("touchid_open", { path }),
  roomInfo: () => invoke<RoomInfo | null>("room_info"),
  takePendingOpen: () => invoke<string | null>("take_pending_open"),
  importFiles: (paths: string[]) => invoke<ImportReport>("import_files", { paths }),
  listFiles: () => invoke<FileMeta[]>("list_files"),
  getFileContent: (id: string) => invoke<FileContent>("get_file_content", { id }),
  updateFileContent: (id: string, content: string) =>
    invoke<FileMeta>("update_file_content", { id, content }),
  setCell: (id: string, sheet: string | null, cell: string, value: string) =>
    invoke<void>("set_cell", { id, sheet, cell, value }),
  deleteFile: (id: string) => invoke<void>("delete_file", { id }),
  // ---- Wave 2: data safety ----
  listFileVersions: (id: string) =>
    invoke<FileVersion[]>("list_file_versions", { id }),
  restoreFileVersion: (versionId: string) =>
    invoke<void>("restore_file_version", { versionId }),
  exportFile: (id: string, destPath: string) =>
    invoke<void>("export_file", { id, destPath }),
  exportAll: (destDir: string) => invoke<number>("export_all", { destDir }),
  changePassword: (current: string, newPassword: string) =>
    invoke<void>("change_password", { current, newPassword }),
  duplicateRoom: (destPath: string, newPassword: string | null) =>
    invoke<void>("duplicate_room", { destPath, newPassword }),
  compactRoom: () => invoke<string>("compact_room"),
  listRecent: () => invoke<RecentRoom[]>("list_recent"),
  removeRecent: (path: string) => invoke<void>("remove_recent", { path }),
  clearRecent: () => invoke<void>("clear_recent"),
  saveGeneratedFile: (name: string, content: string) =>
    invoke<FileMeta>("save_generated_file", { name, content }),
  addMemory: (content: string) => invoke<Memory>("add_memory", { content }),
  listMemories: () => invoke<Memory[]>("list_memories"),
  deleteMemory: (id: string) => invoke<void>("delete_memory", { id }),
  updateMemory: (id: string, content: string) =>
    invoke<void>("update_memory", { id, content }),
  // ---- Wave 4: folders (ADD-16) ----
  listFolders: () => invoke<Folder[]>("list_folders"),
  createFolder: (name: string) => invoke<Folder>("create_folder", { name }),
  renameFolder: (id: string, name: string) =>
    invoke<void>("rename_folder", { id, name }),
  deleteFolder: (id: string) => invoke<void>("delete_folder", { id }),
  renameFile: (id: string, name: string) =>
    invoke<void>("rename_file", { id, name }),
  moveFileToFolder: (fileId: string, folderId: string | null) =>
    invoke<void>("move_file_to_folder", { fileId, folderId }),
  // ---- Wave 4: room-wide search (ADD-6) ----
  searchAll: (query: string) => invoke<SearchResults>("search_all", { query }),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  webSearchTest: () => invoke<string>("web_search_test"),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),
  mcpGetConfig: () => invoke<string>("mcp_get_config"),
  mcpApplyConfig: (json: string) =>
    invoke<McpServerStatus[]>("mcp_apply_config", { json }),
  mcpStatus: () => invoke<McpServerStatus[]>("mcp_status"),
  // SEC-1: approve the pending config fingerprint and start its servers.
  approveMcp: (fingerprint: string) =>
    invoke<McpServerStatus[]>("approve_mcp", { fingerprint }),
  // SEC-1b: answer a per-call MCP approval prompt ("once" | "always" | "deny").
  resolveMcpCall: (id: string, decision: "once" | "always" | "deny") =>
    invoke<void>("resolve_mcp_call", { id, decision }),
  // ADD-12: fetch a web page and save it as a readable room file.
  importLink: (url: string) => invoke<FileMeta>("import_link", { url }),
  // ADD-17: build/refresh the "Room summary.md" file; emits summarize-progress.
  summarizeRoom: () => invoke<FileMeta>("summarize_room"),
  aiStatus: () => invoke<AiStatus>("ai_status"),
  /** ADD-22: tool/vision abilities per installed model, for Settings badges. */
  modelCapabilities: () => invoke<ModelCaps[]>("model_capabilities"),
  warmModel: () => invoke<void>("warm_model"),
  pullModel: (name: string) => invoke<void>("pull_model", { name }),
  deleteModel: (name: string) => invoke<void>("delete_model", { name }),
  openOllama: () => invoke<void>("open_ollama"),
  listChats: () => invoke<Chat[]>("list_chats"),
  createChat: () => invoke<Chat>("create_chat"),
  deleteChat: (id: string) => invoke<void>("delete_chat", { id }),
  renameChat: (id: string, title: string) =>
    invoke<void>("rename_chat", { id, title }),
  getMessages: (chatId: string) => invoke<Message[]>("get_messages", { chatId }),
  deleteMessage: (id: string) => invoke<void>("delete_message", { id }),
  // ADD-7: each ask carries an id so it can be cancelled mid-stream.
  ask: (chatId: string, question: string, attachments: string[], askId: string) =>
    invoke<Message>("ask", { chatId, question, attachments, askId }),
  cancelAsk: (askId: string) => invoke<void>("cancel_ask", { askId }),
  /** Run a prebuilt "#name" workflow. `refs` are @-pinned file ids; `raw` is
   *  the full line the user typed (saved verbatim as the user message). Streams
   *  the same ask-delta/ask-step/ask-notice events as `ask`. */
  runCommand: (
    chatId: string,
    command: string,
    args: string,
    refs: string[],
    raw: string,
    askId: string,
  ) => invoke<Message>("run_command", { chatId, command, args, refs, raw, askId }),
  /** The catalog of "#name" commands (for autocomplete + help). */
  listChatCommands: () => invoke<ChatCommand[]>("list_chat_commands"),
  // ADD-8: import a pasted image (base64) as a room file.
  importImageBytes: (name: string, b64: string) =>
    invoke<FileMeta>("import_image_bytes", { name, b64 }),
  // ADD-18: store an in-room voice note; transcribes in the background.
  importAudioBytes: (name: string, b64: string) =>
    invoke<FileMeta>("import_audio_bytes", { name, b64 }),
  locateInImage: (
    fileId: string,
    query: string,
    imgWidth: number,
    imgHeight: number,
  ) =>
    invoke<ImageBox[]>("locate_in_image", { fileId, query, imgWidth, imgHeight }),
  // ---- ADD-18: on-device dictation & transcription (Whisper built in) ----
  sttStatus: () => invoke<SttStatus>("stt_status"),
  sttDownloadModel: () => invoke<void>("stt_download_model"),
  sttDeleteModel: () => invoke<void>("stt_delete_model"),
  /** Transcribe recorded audio bytes on-device. Rejects with STT_MODEL_MISSING
   *  when the dictation model hasn't been downloaded yet (Settings → AI). */
  transcribeAudio: (dataB64: string, ext: string, timestamps: boolean) =>
    invoke<string>("transcribe_audio", { dataB64, ext, timestamps }),
  /** Post-process dictated text on the LOCAL model (alfred's pipeline):
   *  optional translate-to-English + an intent rewrite (raw/email/message/
   *  commit/notes/prompt). mode="off" && !translate returns text unchanged. */
  shapeText: (text: string, translate: boolean, mode: string) =>
    invoke<string>("shape_text", { text, translate, mode }),

  // ---- events (@tauri-apps/api/event) ----
  onSttDownloadProgress: (
    cb: (p: { got: number; total: number; percent: number }) => void,
  ): Promise<UnlistenFn> =>
    listen<{ got: number; total: number; percent: number }>(
      "stt-download-progress",
      (e) => cb(e.payload),
    ),
  /** Background transcription of an imported recording: [fileName, phase],
   *  phase one of started | done | none | model-missing. */
  onSttProgress: (cb: (p: [string, string]) => void): Promise<UnlistenFn> =>
    listen<[string, string]>("stt-progress", (e) => cb(e.payload)),
  onOpenRoomFile: (cb: (path: string) => void): Promise<UnlistenFn> =>
    listen<string>("open-room-file", (e) => cb(e.payload)),
  onAskDelta: (cb: (delta: string) => void): Promise<UnlistenFn> =>
    listen<string>("ask-delta", (e) => cb(e.payload)),
  // CHG-5: structured turn events. `ask-step` fires when a tool runs;
  // `ask-round` fires when a new model round starts (clear the live text);
  // `ask-notice` carries a user-facing warning (e.g. UX-4 truncation).
  onAskStep: (cb: (label: string) => void): Promise<UnlistenFn> =>
    listen<string>("ask-step", (e) => cb(e.payload)),
  // ADD-22: the deterministic router's chosen lane ("Answering", "Working on
  // your files", …), shown as a subtle label so an odd answer is explainable.
  onAskLane: (cb: (label: string) => void): Promise<UnlistenFn> =>
    listen<string>("ask-lane", (e) => cb(e.payload)),
  // ADD-22: outcome of the most recent tool step, so a failed chip reads failed.
  onAskStepStatus: (cb: (p: { ok: boolean }) => void): Promise<UnlistenFn> =>
    listen<{ ok: boolean }>("ask-step-status", (e) => cb(e.payload)),
  onAskRound: (cb: () => void): Promise<UnlistenFn> =>
    listen("ask-round", () => cb()),
  onAskNotice: (cb: (text: string) => void): Promise<UnlistenFn> =>
    listen<string>("ask-notice", (e) => cb(e.payload)),
  // ADD-17: progress while the room summary is being built.
  onSummarizeProgress: (cb: (text: string) => void): Promise<UnlistenFn> =>
    listen<string>("summarize-progress", (e) => cb(e.payload)),
  onAgentOpenFile: (
    cb: (payload: AgentOpenFilePayload) => void,
  ): Promise<UnlistenFn> =>
    listen<AgentOpenFilePayload>("agent-open-file", (e) => cb(e.payload)),
  onAgentAnnotate: (
    cb: (payload: AnnotationPayload) => void,
  ): Promise<UnlistenFn> =>
    listen<AnnotationPayload>("agent-annotate", (e) => cb(e.payload)),
  onFileUpdated: (cb: (fileId: string) => void): Promise<UnlistenFn> =>
    listen<string>("file-updated", (e) => cb(e.payload)),
  onRoomFilesChanged: (cb: () => void): Promise<UnlistenFn> =>
    listen("room-files-changed", () => cb()),
  // SEC-1b: the AI is about to invoke a connected (MCP) tool and needs consent.
  onMcpApproveRequest: (
    cb: (req: McpApproveRequest) => void,
  ): Promise<UnlistenFn> =>
    listen<McpApproveRequest>("mcp-approve-request", (e) => cb(e.payload)),
  onMcpStatus: (
    cb: (statuses: McpServerStatus[]) => void,
  ): Promise<UnlistenFn> =>
    listen<McpServerStatus[]>("mcp-status", (e) => cb(e.payload)),

  // ---- dialogs (@tauri-apps/plugin-dialog) ----
  chooseOpenPath: (options?: OpenDialogOptions) => open(options),
  chooseSavePath: (options?: SaveDialogOptions) => save(options),
};

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type FileKind =
  | "image"
  | "generated"
  | "pdf"
  | "docx"
  | "sheet"
  | "markdown"
  | "web"
  | "text"
  | "file";

export function fileKind(f: FileMeta): FileKind {
  if (f.mimeType.startsWith("image/")) return "image";
  if (f.source === "generated") return "generated";
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (["doc", "docx"].includes(ext)) return "docx";
  if (["xls", "xlsx", "csv", "tsv"].includes(ext)) return "sheet";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (["txt", "log"].includes(ext)) return "text";
  if (["html", "htm"].includes(ext)) return "web";
  return "file";
}
