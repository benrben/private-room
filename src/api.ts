import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  open,
  save,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "@tauri-apps/plugin-dialog";

export * from "./apiTypes";
import type {
  AppDiag,
  FeedbackDraft,
  RecFile,
  RecLive,
  RecMeta,
  RecSegment,
  RecStart,
  RoomInfo,
  ImportReport,
  FileMeta,
  FileContent,
  Job,
  JobProgress,
  FileVersion,
  RecentRoom,
  Memory,
  Folder,
  SearchResults,
  McpServerStatus,
  AiStatus,
  ModelCaps,
  Chat,
  Message,
  ChatCommand,
  ImageBox,
  SttStatus,
  AiActionDef,
  AgentOpenFilePayload,
  AgentUiRequest,
  AnnotationPayload,
  EditApproveRequest,
  McpApproveRequest,
  RecommendedModels,
  RoomGraph,
  FrontPage,
  StudioPrompts,
  MemorySuggestion,
  FileMetaSuggestion,
  RoomServerStatus,
  RoomRole,
  ExternalModelInfo,
  VoiceInfo,
} from "./apiTypes";

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
  // Returns a re-issued recovery code when the room had one (the old code
  // wrapped the old password and is now useless) — show it once, like
  // write_recovery_key's.
  changePassword: (current: string, newPassword: string) =>
    invoke<string | null>("change_password", { current, newPassword }),
  duplicateRoom: (destPath: string, newPassword: string | null) =>
    invoke<void>("duplicate_room", { destPath, newPassword }),
  compactRoom: () => invoke<string>("compact_room"),
  listRecent: () => invoke<RecentRoom[]>("list_recent"),
  removeRecent: (path: string) => invoke<void>("remove_recent", { path }),
  clearRecent: () => invoke<void>("clear_recent"),
  saveGeneratedFile: (name: string, content: string) =>
    invoke<FileMeta>("save_generated_file", { name, content }),
  // Write an HTML file to temp and open it in the real browser (interactive
  // pages render fully there; the in-app sandbox can't run their scripts).
  openHtmlInBrowser: (name: string, html: string) =>
    invoke<string>("open_html_in_browser", { name, html }),
  // Stage a self-contained HTML page for the isolated roomdoc:// preview (runs
  // its own JS/CSS, no network). Returns a token → roomdoc://localhost/<token>.
  stagePreviewHtml: (html: string) =>
    invoke<string>("stage_preview_html", { html }),
  addMemory: (content: string, category?: string | null) =>
    invoke<Memory>("add_memory", { content, category: category ?? null }),
  listMemories: () => invoke<Memory[]>("list_memories"),
  deleteMemory: (id: string) => invoke<void>("delete_memory", { id }),
  updateMemory: (id: string, content: string, category?: string | null) =>
    invoke<void>("update_memory", { id, content, category: category ?? null }),
  // Wave 1b (idea 10): get-or-create the room's canonical "Scratch pad.md".
  openScratchPad: () => invoke<FileMeta>("open_scratch_pad"),
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
  // Wave 2 (Idea 6): answer a diff-preview approval ("once" | "turn" | "deny").
  resolveEditApproval: (id: string, decision: "once" | "turn" | "deny") =>
    invoke<void>("resolve_edit_approval", { id, decision }),
  // ADD-12: fetch a web page and save it as a readable room file.
  importLink: (url: string) => invoke<FileMeta>("import_link", { url }),
  // ADD-17: build/refresh the "Room summary.md" file; emits summarize-progress.
  summarizeRoom: () => invoke<FileMeta>("summarize_room"),
  // ---- ADD-30: durable background jobs (the sidebar jobs panel) ----
  listJobs: () => invoke<Job[]>("list_jobs"),
  /** Start the room deep-summary job; returns its id. Progress → job-progress. */
  startDeepSummary: () => invoke<string>("start_deep_summary"),
  /** ADD-32: start a whole-file pass — reads the ENTIRE file window by window
   *  in a durable background job and saves the result as a new room file.
   *  mode "merge" folds notes into one document; "stitch" joins transformed
   *  parts in order. Returns the job id; progress → job-progress. */
  startFilePass: (file: string, instruction: string, mode?: "merge" | "stitch") =>
    invoke<string>("start_file_pass", { file, instruction, mode }),
  /** Pause a running job — it checkpoints and parks as 'paused'. */
  cancelJob: (id: string) => invoke<void>("cancel_job", { id }),
  /** Continue a paused/errored job from its checkpoint. */
  resumeJob: (id: string) => invoke<void>("resume_job", { id }),
  deleteJob: (id: string) => invoke<void>("delete_job", { id }),
  aiStatus: () => invoke<AiStatus>("ai_status"),
  /** ADD-22: tool/vision abilities per installed model, for Settings badges. */
  modelCapabilities: () => invoke<ModelCaps[]>("model_capabilities"),
  /** Models available for a detected cloud engine ("claude-cli"/"codex-cli"),
   *  for the Cloud picker's second level. */
  listEngineModels: (engine: string) =>
    invoke<ExternalModelInfo[]>("list_engine_models", { engine }),
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

  // ---- Idea 3: supernatural voice (on-device AVSpeech synthesis) ----
  /** Synthesize one sentence-sized chunk (≤1,000 chars) to WAV, base64. */
  speakText: (
    text: string,
    voiceId: string | null,
    rate: number,
    pitch: number,
    volume: number,
  ) => invoke<string>("speak_text", { text, voiceId, rate, pitch, volume }),
  /** Installed system voices, for the Settings picker. */
  listSpeechVoices: () => invoke<VoiceInfo[]>("list_speech_voices"),

  // ---- AI actions (per-file / whole-room one-shot Markdown generators) ----
  /** The catalog of AI actions (file- and room-scoped), for the menus. */
  aiActionPrompts: () => invoke<AiActionDef[]>("ai_action_prompts"),
  /** Run an AI action; saves a Markdown file and emits agent-open-file. */
  aiAction: (
    action: string,
    opts: {
      scope?: string | null;
      refs?: string[] | null;
      instructions?: string | null;
      question?: string | null;
    },
  ) =>
    invoke<FileMeta>("ai_action", {
      action,
      scope: opts.scope ?? null,
      refs: opts.refs ?? null,
      instructions: opts.instructions ?? null,
      question: opts.question ?? null,
    }),

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
  // ADD-31: named stage while a Studio (flashcards/mindmap/podcast) runs.
  onStudioStep: (cb: (text: string) => void): Promise<UnlistenFn> =>
    listen<string>("studio-step", (e) => cb(e.payload)),
  // ADD-30: live progress of a background job, plus its terminal flags.
  onJobProgress: (cb: (p: JobProgress) => void): Promise<UnlistenFn> =>
    listen<JobProgress>("job-progress", (e) => cb(e.payload)),
  // ADD-31: live import queue — done/total/current name, plus a final receipt
  // (done === total) carrying imported/failed counts.
  onImportProgress: (
    cb: (p: {
      done: number;
      total: number;
      name: string;
      imported?: number;
      failed?: number;
    }) => void,
  ): Promise<UnlistenFn> =>
    listen<{
      done: number;
      total: number;
      name: string;
      imported?: number;
      failed?: number;
    }>("import-progress", (e) => cb(e.payload)),
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
  // Wave 2 (Idea 6): the AI is about to change a file and (with the gate on)
  // needs the user to approve the before/after diff.
  onEditApproveRequest: (
    cb: (req: EditApproveRequest) => void,
  ): Promise<UnlistenFn> =>
    listen<EditApproveRequest>("edit-approve-request", (e) => cb(e.payload)),
  onMcpStatus: (
    cb: (statuses: McpServerStatus[]) => void,
  ): Promise<UnlistenFn> =>
    listen<McpServerStatus[]>("mcp-status", (e) => cb(e.payload)),

  // ---- ADD-27: live Recording file ----
  /** Start recording — a fresh file (fileId omitted) or resume an existing
   *  recording file. Mic PCM is pushed separately via recPushAudio. The
   *  meeting's speakers are discovered from their voices; nothing to pre-set. */
  recStart: (opts: {
    fileId?: string | null;
    systemAudio: boolean;
    liveTranslate?: string | null;
  }) =>
    invoke<RecStart>("rec_start", {
      fileId: opts.fileId ?? null,
      systemAudio: opts.systemAudio,
      liveTranslate: opts.liveTranslate ?? null,
    }),
  /** ~250ms of mic samples: little-endian f32 bytes, base64-packed. */
  recPushAudio: (rate: number, dataB64: string) =>
    invoke<void>("rec_push_audio", { rate, dataB64 }),
  recPause: () => invoke<void>("rec_pause"),
  recResume: () => invoke<void>("rec_resume"),
  /** Stop and save; resolves once the tail phrases finished transcribing. */
  recStop: () => invoke<RecMeta>("rec_stop"),
  recLiveStatus: () => invoke<RecLive | null>("rec_live_status"),
  recSetLiveTranslate: (language: string | null) =>
    invoke<void>("rec_set_live_translate", { language }),
  /** Live transcription on/off mid-recording. Off: the audio keeps recording
   *  but no text is written (recoverable later with recRetranscribe). */
  recSetLiveStt: (on: boolean) => invoke<void>("rec_set_live_stt", { on }),
  recGet: (id: string) => invoke<RecFile>("rec_get", { id }),
  /** Studio-style edit: delete a [t0,t1) span from transcript + playback. */
  recDeleteRange: (id: string, t0: number, t1: number) =>
    invoke<RecMeta>("rec_delete_range", { id, t0, t1 }),
  /** Render the cuts into a new "<name> (edited).wav" file. */
  recExportClean: (id: string) => invoke<FileMeta>("rec_export_clean", { id }),
  /** Translate the whole transcript on the local model into any language. */
  recTranslate: (id: string, language: string) =>
    invoke<FileMeta>("rec_translate", { id, language }),
  /** Rebuild the whole transcript from the audio with the current pipeline
   *  (saved recordings only; the audio is untouched, the old transcript goes
   *  to History). Progress arrives via onRecRetranscribe. */
  recRetranscribe: (id: string) => invoke<RecMeta>("rec_retranscribe", { id }),
  onRecPartial: (
    cb: (p: { fileId: string; source: "mic" | "sys"; t0: number; text: string }) => void,
  ): Promise<UnlistenFn> => listen("rec-partial", (e) => cb(e.payload as never)),
  onRecSegment: (
    cb: (p: { fileId: string; segment: RecSegment }) => void,
  ): Promise<UnlistenFn> => listen("rec-segment", (e) => cb(e.payload as never)),
  /** A row already on screen was the microphone's echo of meeting audio the
   *  system lane captured too — remove it. */
  onRecSegmentDrop: (
    cb: (p: { fileId: string; id: string }) => void,
  ): Promise<UnlistenFn> => listen("rec-segment-drop", (e) => cb(e.payload as never)),
  /** The meeting's speakers were re-derived from every voice heard so far —
   *  labels already on screen may change (that's the point). */
  onRecRelabel: (
    cb: (p: { fileId: string; labels: { id: string; speaker: string }[] }) => void,
  ): Promise<UnlistenFn> => listen("rec-relabel", (e) => cb(e.payload as never)),
  onRecLevel: (
    cb: (p: { fileId: string; mic: number; sys: number; durationCs: number }) => void,
  ): Promise<UnlistenFn> => listen("rec-level", (e) => cb(e.payload as never)),
  onRecState: (
    cb: (p: { fileId: string; status: string; durationCs: number }) => void,
  ): Promise<UnlistenFn> => listen("rec-state", (e) => cb(e.payload as never)),
  /** Stop→saved drain progress: the audio is already durable when the first
   *  event arrives; `remaining` counts phrase decodes still queued. */
  onRecSaveProgress: (
    cb: (p: { fileId: string; stage: "transcribing" | "writing"; remaining: number }) => void,
  ): Promise<UnlistenFn> => listen("rec-save-progress", (e) => cb(e.payload as never)),
  onRecSource: (
    cb: (p: { fileId: string; source: string; status: string; message: string }) => void,
  ): Promise<UnlistenFn> => listen("rec-source", (e) => cb(e.payload as never)),
  onRecError: (
    cb: (p: { fileId: string; message: string }) => void,
  ): Promise<UnlistenFn> => listen("rec-error", (e) => cb(e.payload as never)),
  onRecLiveTranslation: (
    cb: (p: { fileId: string; segId: string; text: string }) => void,
  ): Promise<UnlistenFn> => listen("rec-live-translation", (e) => cb(e.payload as never)),
  onRecTranslateProgress: (
    cb: (p: { fileId: string; done: number; total: number }) => void,
  ): Promise<UnlistenFn> => listen("rec-translate-progress", (e) => cb(e.payload as never)),
  onRecRetranscribe: (
    cb: (p: { fileId: string; doneCs: number; totalCs: number }) => void,
  ): Promise<UnlistenFn> => listen("rec-retranscribe", (e) => cb(e.payload as never)),

  // ---- ADD-28: feedback → GitHub issue ----
  /** Draft an issue title/body from raw feedback on the LOCAL model. */
  feedbackDraft: (text: string) =>
    invoke<FeedbackDraft>("feedback_draft", { text }),
  appDiag: () => invoke<AppDiag>("app_diag"),

  // ADD-26: download a YouTube video into the room (yt-dlp on first use).
  importYoutubeVideo: (url: string) =>
    invoke<ImportReport>("import_youtube_video", { url }),
  onYtdlpProgress: (
    cb: (p: { status: string; percent: number | null }) => void,
  ): Promise<UnlistenFn> =>
    listen<{ status: string; percent: number | null }>("ytdlp-progress", (e) =>
      cb(e.payload),
    ),

  // ADD-25: the agent↔UI bridge — the backend asks the live webview for an
  // element snapshot / click / frame grab; the driver answers by id.
  onAgentUiRequest: (
    cb: (req: AgentUiRequest) => void,
  ): Promise<UnlistenFn> =>
    listen<AgentUiRequest>("agent-ui-request", (e) => cb(e.payload)),
  resolveAgentUi: (id: string, payload: unknown) =>
    invoke<void>("resolve_agent_ui", { id, payload }),

  // ---- dialogs (@tauri-apps/plugin-dialog) ----
  chooseOpenPath: (options?: OpenDialogOptions) => open(options),
  chooseSavePath: (options?: SaveDialogOptions) => save(options),
};

/* ============================================================
 * Moonshot feature wrappers (Wave-3 API surface). Thin invoke() wrappers,
 * imported by name by the Workspace / App / Settings / Viewers agents.
 * Tauri maps snake_case Rust params → camelCase invoke keys.
 * ============================================================ */

/** D1: static list the picker uses to drive pulls. */
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

/** D5: build a self-contained flashcard deck (.html); opens in HtmlView.
 *  `instructions` is the user-edited prompt; `refs` are file ids from any
 *  @-mentioned files/folders (omit to use the current scope / whole room). */
export const studioFlashcards = (
  scope?: string,
  instructions?: string,
  refs?: string[],
  opId?: string,
) => invoke<FileMeta>("studio_flashcards", { scope, instructions, refs, opId });

/** D5: build a self-contained mind map (.html). */
export const studioMindmap = (
  scope?: string,
  instructions?: string,
  refs?: string[],
  opId?: string,
) => invoke<FileMeta>("studio_mindmap", { scope, instructions, refs, opId });

/** D12: render a two-host podcast script (.html); script only, no audio. */
export const generatePodcastScript = (
  scope?: string,
  instructions?: string,
  refs?: string[],
  opId?: string,
) =>
  invoke<FileMeta>("generate_podcast_script", {
    scope,
    instructions,
    refs,
    opId,
  });

/** D6: does this chat's last exchange hold a fact worth remembering? */
export const memorySuggestion = (chatId: string) =>
  invoke<MemorySuggestion>("memory_suggestion", { chatId });

/** D7: suggested title/folder/tags for a freshly imported file. */
export const suggestFileMeta = (fileId: string) =>
  invoke<FileMetaSuggestion>("suggest_file_meta", { fileId });

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
  | "recording"
  | "file";

export function fileKind(f: FileMeta): FileKind {
  if (f.mimeType.startsWith("image/")) return "image";
  // ADD-27: live recordings carry their own source tag and icon.
  if (f.source === "recording") return "recording";
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
