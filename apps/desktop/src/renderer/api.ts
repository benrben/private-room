import { invoke } from "./platform";

export * from "./apiTypes";
import type {
  RoomInfo,
  FileMeta,
  RecommendedModels,
  RoomGraph,
  FrontPage,
  StudioPrompts,
  MemorySuggestion,
  FileMetaSuggestion,
  RoomServerStatus,
  RoomRole
} from "./apiTypes";
import {
  fileExtensionLabel,
  isTextExtension,
} from "../shared/fileExtensions";

export interface RoomStorageUsage {
  kind: "legacy" | "workspace";
  liveFileBytes: number;
  databaseBytes: number;
  privateHistoryBytes: number;
  totalOnDiskBytes: number;
}

export interface SealedFileEntry {
  fileId: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}

export interface SealedPackageInspection {
  version: number;
  purpose: string;
  createdAt: string;
  roomId: string;
  fileCount: number;
  objectCount: number;
  files: SealedFileEntry[];
}

export interface WorkspaceWatcherStatus {
  state: "starting" | "healthy" | "error";
  lastReconciledAt: string | null;
  lastError: string | null;
  polling: boolean;
}



/* ============================================================
 * Moonshot feature wrappers (Wave-3 API surface). Thin invoke() wrappers,
 * imported by name by the Workspace / App / Settings / Viewers agents.
 * Tauri maps snake_case Rust params → camelCase invoke keys.
 * ============================================================ */

/** D1: static list the picker uses to drive pulls. */
import { apiWorkspace } from "./apiWorkspace";
import { apiCreation } from "./apiCreation";
import { apiIntelligence } from "./apiIntelligence";
import { apiRecording } from "./apiRecording";
export { askEvent } from "./askEvent";

export const api = { ...apiWorkspace, ...apiCreation, ...apiIntelligence, ...apiRecording };

export const recommendedModels = () =>
  invoke<RecommendedModels>("recommended_models");

/** D2: pull the embed model if missing, then backfill; no-op/quiet if offline. */
export const ensureEmbedModel = () => invoke<void>("ensure_embed_model");

/** D3: the room's similarity graph (files + memories). Model-free, instant. */
export const roomGraph = () => invoke<RoomGraph>("room_graph");

/** D4: instant Front Page snapshot (no model call, safe to call on unlock). */
export const frontPage = () => invoke<FrontPage>("front_page");

/** D4: lazy follow-up — up to 3 suggested questions; call after frontPage(). */
export const frontPageSuggestions = () =>
  invoke<string[]>("front_page_suggestions");

export const studioPrompts = () => invoke<StudioPrompts>("studio_prompts");

/* The one-shot Studio builders (`studio_flashcards`, `studio_mindmap`,
 * `generate_podcast_script`) and the whole-file pass (`start_file_pass`) have
 * no front-end wrapper on purpose: the screens run them as durable background
 * jobs through `api.startStudioJob` / the jobs panel, and the assistant reaches
 * the one-shot commands as tools. A wrapper here would only be a second, unused
 * way in. */

/** D6: does this chat's last exchange hold a fact worth remembering? */
export const memorySuggestion = (chatId: string) =>
  invoke<MemorySuggestion>("memory_suggestion", { chatId });

/** D7: suggested title/folder/tags for a freshly imported file. */
export const suggestFileMeta = (fileId: string) =>
  invoke<FileMetaSuggestion>("suggest_file_meta", { fileId });

/** Generic adaptive-UI-text pipe (not a Dx feature — a small reusable service
 * several features call): the caller composes the whole `prompt` (and the
 * `facts` it's based on, used server-side only for the numeral-fabrication
 * guard); the model returns one short string sized to `maxWords`, or `null`.
 * `null` is a normal, expected result (offline model, failed validation,
 * degraded generation) — never an error. See workspace/adaptiveText.ts for
 * the caching/timing contract wrapped around this call. */
export const generateUiText = (
  kind: string,
  prompt: string,
  facts: unknown,
  maxWords: number,
) =>
  invoke<string | null>("generate_ui_text", { kind, prompt, facts, maxWords });

/** D9: current state of the Room MCP server (the Leash). */
export const roomServerStatus = () =>
  invoke<RoomServerStatus>("room_server_status");

/** D9/Wave 1a: turn the Leash on/off at a trust tier — "files" (read/search/
 * edit) or "full" (external-agent parity: + background jobs + local AI).
 * `allowCloud` gates non-local access (files tier only). */
export const setRoomServer = (
  enabled: boolean,
  allowCloud: boolean,
  scope: "files" | "full",
) => invoke<RoomServerStatus>("set_room_server", { enabled, allowCloud, scope });

/** Wave 1a: mint a new full-tier bearer token (revokes the old one everywhere,
 * severing live external-agent connections) and rewrite the discovery file. */
export const regenerateLeashToken = () =>
  invoke<RoomServerStatus>("regenerate_leash_token");

/** D10: point the app at a remote Ollama ("the closet"); "" clears the override. */
export const setOllamaUrl = (url: string) =>
  invoke<void>("set_ollama_url", { url });

/** D10: save the remote-Ollama address and then actually try to reach it.
 *  Rejects with what went wrong — a well-formed address for a machine that is
 *  off used to be accepted with "Saved", after which every AI feature blamed
 *  the LOCAL Ollama. */
export const testOllamaUrl = (url: string) =>
  invoke<string>("test_ollama_url", { url });

/** D10: the Ollama base URL currently in effect. */
export const getOllamaUrl = () => invoke<string>("get_ollama_url");

/** D11: the catalog of room personas. */
export const listRoles = () => invoke<RoomRole[]>("list_roles");

/** A3: write a recovery sidecar for the OPEN room; returns the one-time code. */
export const writeRecoveryKey = () => invoke<string>("write_recovery_key");

/** A3: does the room file at `path` have a recovery sidecar? */
export const hasRecoveryKey = (path: string) =>
  invoke<boolean>("has_recovery_key", { path });

/** A3: open a room using its recovery code instead of the password. */
export const openRoomWithRecovery = (path: string, code: string) =>
  invoke<RoomInfo>("open_room_with_recovery", { path, code });

/** The app's one human file size. Carries on past MB — a 2 GB recording used to
 * read "2048.0 MB". */
export function formatSize(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
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
  | "recording"
  | "file";

/** True for files that belong to the Recordings lens: engine-made recordings
 * plus imported audio/video (they transcribe in the background too). This is the
 * ONE definition of "is this a recording" — the Recordings list/count, the file
 * icon (via fileKind), and Home's labels all derive from it, so an imported
 * audio file reads as a recording everywhere, not just in the Recordings pane. */
export function isRecordingFile(f: FileMeta): boolean {
  return (
    f.source === "recording" ||
    f.mimeType.startsWith("audio/") ||
    f.mimeType.startsWith("video/")
  );
}

/** A short human word for a file's type, from its metadata. Shared by the
 * Library rows and the Home "Continue" list so a note isn't mislabeled "File"
 * and a recording always reads as a recording. */
export function fileKindLabel(f: FileMeta): string {
  if (isRecordingFile(f)) return "recording";
  const m = f.mimeType;
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf") return "PDF";
  const lower = f.name.toLowerCase();
  const ext = lower.split(".").pop() ?? "";
  return fileExtensionLabel(ext) ?? "file";
}

const EARLY_FILE_KINDS: ReadonlyMap<string, FileKind> = new Map([
  ["pdf", "pdf"], ["ai", "pdf"],
  ["doc", "docx"], ["docx", "docx"],
  ["xls", "sheet"], ["xlsx", "sheet"], ["ods", "sheet"], ["csv", "sheet"], ["tsv", "sheet"],
  ["md", "markdown"], ["markdown", "markdown"],
]);

const SPECIAL_TEXT_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "eml", "msg", "srt", "vtt",
]);

const LATE_FILE_KINDS: ReadonlyMap<string, FileKind> = new Map([
  ["html", "web"], ["htm", "web"], ["svg", "web"],
  // Decks, books and notebooks have real viewers, so they get the document
  // glyph rather than the blank "unknown file" one.
  ["pptx", "docx"], ["ppt", "docx"], ["odp", "docx"],
  ["epub", "docx"], ["mobi", "docx"], ["azw", "docx"], ["azw3", "docx"],
  ["fb2", "docx"], ["cbz", "docx"], ["ipynb", "docx"],
]);

function isRecognizedTextExtension(extension: string): boolean {
  return isTextExtension(extension) || SPECIAL_TEXT_FILE_EXTENSIONS.has(extension);
}

function fileKindForExtension(extension: string): FileKind {
  const earlyKind = EARLY_FILE_KINDS.get(extension);
  if (earlyKind !== undefined) return earlyKind;
  if (isRecognizedTextExtension(extension)) return "text";
  return LATE_FILE_KINDS.get(extension) ?? "file";
}

export function fileKind(f: FileMeta): FileKind {
  if (f.mimeType.startsWith("image/")) return "image";
  // Live recordings AND imported audio/video share the recording icon.
  if (isRecordingFile(f)) return "recording";
  if (f.source === "generated") return "generated";
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  return fileKindForExtension(ext);
}
