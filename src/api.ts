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
}

export interface FileMeta {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  source: string;
  hasText: boolean;
  createdAt: string;
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
    | "code"
    | "text"
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
}

export interface McpServerStatus {
  name: string;
  status: "connecting" | "connected" | "failed" | "disabled";
  error: string | null;
  tools: string[];
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
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  webSearchTest: () => invoke<string>("web_search_test"),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),
  mcpGetConfig: () => invoke<string>("mcp_get_config"),
  mcpApplyConfig: (json: string) =>
    invoke<McpServerStatus[]>("mcp_apply_config", { json }),
  mcpStatus: () => invoke<McpServerStatus[]>("mcp_status"),
  aiStatus: () => invoke<AiStatus>("ai_status"),
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
  // ADD-8: import a pasted image (base64) as a room file.
  importImageBytes: (name: string, b64: string) =>
    invoke<FileMeta>("import_image_bytes", { name, b64 }),
  locateInImage: (
    fileId: string,
    query: string,
    imgWidth: number,
    imgHeight: number,
  ) =>
    invoke<ImageBox[]>("locate_in_image", { fileId, query, imgWidth, imgHeight }),

  // ---- events (@tauri-apps/api/event) ----
  onOpenRoomFile: (cb: (path: string) => void): Promise<UnlistenFn> =>
    listen<string>("open-room-file", (e) => cb(e.payload)),
  onAskDelta: (cb: (delta: string) => void): Promise<UnlistenFn> =>
    listen<string>("ask-delta", (e) => cb(e.payload)),
  // CHG-5: structured turn events. `ask-step` fires when a tool runs;
  // `ask-round` fires when a new model round starts (clear the live text);
  // `ask-notice` carries a user-facing warning (e.g. UX-4 truncation).
  onAskStep: (cb: (label: string) => void): Promise<UnlistenFn> =>
    listen<string>("ask-step", (e) => cb(e.payload)),
  onAskRound: (cb: () => void): Promise<UnlistenFn> =>
    listen("ask-round", () => cb()),
  onAskNotice: (cb: (text: string) => void): Promise<UnlistenFn> =>
    listen<string>("ask-notice", (e) => cb(e.payload)),
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
