import { invoke, listen, type UnlistenFn } from "./platform";
import {
  open,
  save,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "./platform";

export * from "./apiTypes";
import type {
  AppDiag,
  CastMember,
  CreateCatalog,
  RoomPicture,
  PlannedShot,
  ShotPlan,
  FilmPlan,
  ShotRunStarted,
  RoomDocument,
  ParsedMember,
  CastFromFile,
  StoryBoard,
  StoryShot,
  FeedbackDraft,
  RecFile,
  RecLive,
  RecMeta,
  NoteKind,
  RecSegment,
  RecStart,
  SavedVoice,
  RoomInfo,
  ImportReport,
  MediaQualityOption,
  FileMeta,
  TrashedFile,
  BulkReport,
  Podcast,
  PodcastHost,
  FileContent,
  DecodedFileText,
  AudioPeaks,
  MediaMeta,
  QuickLookPreview,
  SlideImage,
  Job,
  JobProgress,
  Workflow,
  WorkflowRun,
  Schedule,
  ScheduleArg,
  WorkflowTemplate,
  WorkflowNodeEvent,
  ScriptInfo,
  ScriptApproveRequest,
  SkillSummary,
  SkillBundle,
  SkillResourceContent,
  BrowserInfo,
  BrowserPageSelection,
  BrowserPageText,
  BrowserSearchResult,
  ResultPreview,
  BrowseClearScope,
  BrowseJournalRow,
  StopReport,
  FileVersion,
  Provenance,
  VersionContent,
  CheckpointMeta,
  RecentRoom,
  Memory,
  Folder,
  SearchResults,
  McpServerStatus,
  ConnectorPowers,
  CatalogEntry,
  AiStatus,
  ModelCaps,
  Capability,
  EngineCapabilities,
  EnginePreflight,
  SupportMatrix,
  Chat,
  Message,
  ChatCommand,
  Specialist,
  ImageBox,
  SttStatus,
  DictSessionInfo,
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
  RuntimeStatus,
  ExternalModelInfo,
  NeuralVoiceInfo,
  AskPrivacy,
  AiProviderStatus,
  AskTokenUsage,
  AskPlanStep,
  AskActiveAgent,
  AskReport,
  AskStep,
  AskTurn,
  PrivacyEntity,
  PrivacyPreview,
  PrivacyScanProgress,
  StudioStep,
  PrivacyStatus,
  BrowserTab,
  SketchDrawn,
  ViewMenuState,
  OrganizedChange,
  HarnessApprovalDecision,
  HarnessCapabilities,
  HarnessEvent,
  HarnessPrivacyMode,
  HarnessProvider,
  HarnessRollbackResult,
  HarnessHistoryRun,
  WorkspaceOperationProgressEvent,
} from "./apiTypes";

export interface RoomStorageUsage {
  kind: "legacy" | "workspace";
  liveFileBytes: number;
  databaseBytes: number;
  privateHistoryBytes: number;
  totalOnDiskBytes: number;
}

export interface WorkspaceWatcherStatus {
  state: "starting" | "healthy" | "error";
  lastReconciledAt: string | null;
  lastError: string | null;
  polling: boolean;
}

/** The wire shape of every `ask-*` event: the payload the listener wants, in
 * `v`, under the ids of the run and chat that produced it. Built by
 * `crate::turn` on the host side — see `AskTurn`. */
interface AskEnvelope<T> {
  runId: string | null;
  chatId: string | null;
  v: T;
}

/** Subscribe to one identified turn event.
 *
 * Every listener gets `(payload, turn)` — never the bare payload — so no call
 * site can accidentally go back to guessing whose event it is reading. A
 * payload that arrives WITHOUT an envelope is impossible from this app's own
 * host (every emitter goes through `crate::turn`), so it is treated as
 * unowned rather than silently attributed. */
function askEvent<T>(
  event: string,
  cb: (v: T, turn: AskTurn) => void,
): Promise<UnlistenFn> {
  return listen<AskEnvelope<T>>(event, (e) => {
    const wrapped = e.payload as AskEnvelope<T> | null;
    const owned =
      wrapped != null && typeof wrapped === "object" && "v" in wrapped;
    cb(owned ? wrapped.v : (e.payload as unknown as T), {
      runId: owned ? (wrapped.runId ?? null) : null,
      chatId: owned ? (wrapped.chatId ?? null) : null,
    });
  });
}

export const api = {
  /** `name` is the name the user TYPED on the Create screen. Omit it and the
   *  room is named after its file, as it always was. */
  createRoom: (
    path: string,
    password: string,
    name?: string,
    format: "sealed-db" | "workspace-folder" = "workspace-folder",
  ) => invoke<RoomInfo>("create_room", { path, password, name: name ?? null, format }),
  convertLegacyRoom: (sourcePath: string, password: string, destinationPath: string) =>
    invoke<{
      sourcePath: string;
      destinationPath: string;
      roomId: string;
      convertedFiles: number;
      renamed: Array<{ fileId: string; originalPath: string; convertedPath: string }>;
      skipped: Array<{ fileId: string; name: string; reason: string }>;
      resumed: boolean;
    }>("convert_legacy_room", { sourcePath, password, destinationPath }),
  createSealedPackage: (
    destinationPath: string,
    exportPassword: string | null = null,
    purpose = "backup",
  ) => invoke<{
    version: number;
    purpose: string;
    createdAt: string;
    roomId: string;
    fileCount: number;
    objectCount: number;
  }>("create_sealed_package", { destinationPath, exportPassword, purpose }),
  inspectSealedPackage: (packagePath: string, password: string) => invoke<{
    version: number;
    purpose: string;
    createdAt: string;
    roomId: string;
    fileCount: number;
    objectCount: number;
  }>("inspect_sealed_package", { packagePath, password }),
  importSealedPackage: (
    packagePath: string,
    packagePassword: string,
    destinationPath: string,
    workspacePassword: string | null = null,
  ) => invoke<{ destinationPath: string; roomId: string; fileCount: number; objectCount: number }>(
    "import_sealed_package",
    { packagePath, packagePassword, destinationPath, workspacePassword },
  ),
  openRoom: (path: string, password: string) =>
    invoke<RoomInfo>("open_room", { path, password }),
  closeRoom: () => invoke<void>("close_room"),
  // ---- Wave 6: Touch ID unlock (ADD-11) ----
  touchIdHas: (path: string) => invoke<boolean>("touchid_has", { path }),
  touchIdEnable: () => invoke<void>("touchid_enable"),
  touchIdDisable: (path: string) => invoke<void>("touchid_disable", { path }),
  touchIdOpen: (path: string) => invoke<RoomInfo>("touchid_open", { path }),
  roomInfo: () => invoke<RoomInfo | null>("room_info"),
  roomStorageUsage: () => invoke<RoomStorageUsage>("room_storage_usage"),
  workspaceWatcherStatus: () =>
    invoke<WorkspaceWatcherStatus | null>("workspace_watcher_status"),
  rescanWorkspaceRoom: () => invoke<WorkspaceWatcherStatus>("rescan_workspace_room"),
  setWorkspaceWatcherPolling: (enabled: boolean) =>
    invoke<WorkspaceWatcherStatus>("set_workspace_watcher_polling", { enabled }),
  harnessCapabilities: () =>
    invoke<HarnessCapabilities>("harness_capabilities", {}),
  harnessListRuns: () => invoke<HarnessHistoryRun[]>("harness_list_runs", {}),
  harnessStart: (request: {
    provider: HarnessProvider;
    model: string;
    privacyMode: HarnessPrivacyMode;
    writeEnabled: boolean;
    text: string;
    threadId?: string;
    systemPrompt?: string;
  }) => invoke<{ runId: string }>("harness_start", request),
  harnessApprove: (
    runId: string,
    requestId: string,
    decision: HarnessApprovalDecision,
  ) => invoke<void>("harness_approve", { runId, requestId, decision }),
  harnessCancel: (runId: string) =>
    invoke<void>("harness_cancel", { runId }),
  harnessCloudWriteback: (runId: string, approved: boolean) =>
    invoke<void>("harness_cloud_writeback", { runId, approved }),
  harnessRollback: (runId: string) =>
    invoke<HarnessRollbackResult>("harness_rollback", { runId }),
  harnessRestoreBaselineCopies: (runId: string, relativePaths: string[]) =>
    invoke<string[]>("harness_restore_baseline_copies", { runId, relativePaths }),
  /** Rename the open room. The name lives in the room's own encrypted `meta`
   *  table, not in the file path — renaming the `.roomai` in Finder changes
   *  nothing — so this command is the only way to change it. It writes both
   *  copies (the room's `meta` and the recents entry for this path) and returns
   *  the refreshed RoomInfo; feed that straight back into the shell's `info` so
   *  the top bar updates without a reopen. The name is trimmed; empty or over
   *  120 characters is rejected, as is a rename during a checkpoint rollback. */
  renameRoom: (name: string) => invoke<RoomInfo>("rename_room", { name }),
  registerWorkspaceCopy: () => invoke<RoomInfo>("register_workspace_copy"),
  takePendingOpen: () => invoke<string | null>("take_pending_open"),
  /** The last unlock's "audio from an interrupted recording could not be
   *  restored" message, or null when nothing failed — which is the ordinary
   *  answer. Collected once on workspace mount: the unlock finishes before any
   *  listener exists, so the backend parks this instead of relying on an event
   *  arriving after the race. Reading it clears it. */
  takeRecRecoveryError: () => invoke<string | null>("take_rec_recovery_error"),
  importFiles: (paths: string[]) => invoke<ImportReport>("import_files", { paths }),
  listFiles: () => invoke<FileMeta[]>("list_files"),
  getFileContent: (id: string) => invoke<FileContent>("get_file_content", { id }),
  /** Re-read a plain-text file's ORIGINAL BYTES, optionally as a named charset.
   * `encoding: null` answers with the automatic reading — the same one
   * `getFileContent` returned — which is how the viewer's encoding strip learns
   * what is in effect without guessing a second time. */
  decodeFileText: (id: string, encoding: string | null) =>
    invoke<DecodedFileText>("decode_file_text", { id, encoding }),
  /** Waveform envelope for a recording, computed on-device. Decoding happens
   * in Rust (the same path transcription uses) so the webview never pulls a
   * long meeting through the Web Audio API. */
  audioPeaks: (id: string, buckets?: number) =>
    invoke<AudioPeaks>("audio_peaks", { id, buckets: buckets ?? null }),
  /** Read (and cache) what a video's container actually says — duration,
   * display size, codec, frame rate, audio track. `null` means the OS would
   * not open it as media, or opened it and could say nothing; it is a real
   * answer, not an error. */
  probeVideoMeta: (id: string) =>
    invoke<MediaMeta | null>("probe_video_meta", { id }),
  /** Cut a span out of a video into a NEW room file. The original is never
   * modified. The clip arrives with no transcript and is queued on the same
   * on-device transcriber lane an imported video would be. */
  videoTrim: (id: string, startSecs: number, endSecs: number) =>
    invoke<FileMeta>("video_trim", { id, startSecs, endSecs }),
  /** Keep one frame of a video as a PNG file in the room. The pixels are drawn
   * in the webview (see `viewers/frameGrab.ts`); this only stores them, and
   * rejects anything that isn't really a PNG. */
  saveVideoFrame: (id: string, pngB64: string, atSecs: number) =>
    invoke<FileMeta>("save_video_frame", { id, pngB64, atSecs }),
  /** Ask macOS to draw a preview of a file this app can't render itself
   * (.key/.pages/.numbers, legacy .doc/.ppt, RAW, PSD, 3D models). `null` when
   * this Mac has nothing that can draw it either — a normal answer, not an
   * error. */
  quicklookPreview: (id: string) =>
    invoke<QuickLookPreview | null>("quicklook_preview", { id }),
  /** One slide of a .pptx, drawn by macOS at full fidelity. Quick Look renders
   * page one, so the backend hands it a copy of the deck with the wanted slide
   * moved to the front — every layout, master, theme and image untouched. */
  slidePreview: (id: string, index: number) =>
    invoke<SlideImage | null>("slide_preview", { id, index }),
  /** A legacy .doc/.rtf as formatted HTML, via macOS's own Word importer. */
  officeHtml: (id: string) => invoke<string | null>("office_html", { id }),
  updateFileContent: (id: string, content: string) =>
    invoke<FileMeta>("update_file_content", { id, content }),
  /** Save edited text back INTO a .docx, paragraph by paragraph, keeping the
   * document's styles, tables and images. The user-facing twin of the agent's
   * `edit_file` docx path — before this, editing a Word file in the app could
   * only produce a separate Markdown copy. */
  updateDocxText: (id: string, content: string) =>
    invoke<FileMeta>("update_docx_text", { id, content }),
  setCell: (id: string, sheet: string | null, cell: string, value: string) =>
    invoke<void>("set_cell", { id, sheet, cell, value }),
  // ---- Trash / undo ----
  // Deleting moves a file to the room's trash: out of every list, count and
  // search, but recoverable. The bytes never leave the encrypted room — there
  // is no system-trash hop.
  trashFile: (id: string) => invoke<void>("trash_file", { id }),
  listTrashedFiles: () => invoke<TrashedFile[]>("list_trashed_files"),
  restoreFile: (id: string) => invoke<FileMeta>("restore_file", { id }),
  /** Add this object to Home's Library, or take the Home reference away.
   * Room-local organization: one row is updated in place, so the object keeps
   * its id, bytes, history, title and origin destination either way. Nothing is
   * exported, uploaded, shared or copied. Idempotent in both directions. */
  setFileInLibrary: (id: string, linked: boolean) =>
    invoke<FileMeta>("set_file_in_library", { id, linked }),
  /** Irreversible, and only reachable for a file that is ALREADY in the trash. */
  deleteFilePermanently: (id: string) =>
    invoke<void>("delete_file_permanently", { id }),
  /** Returns how many files were actually destroyed. */
  emptyTrash: () => invoke<number>("empty_trash"),
  // ---- Batch twins of the four above (the Library's multi-selection) ----
  // Each returns a BulkReport instead of throwing on the first bad id: the
  // files that CAN be acted on are, and the ones that can't come back named.
  // One backend call means one room event, so a 40-file move re-renders the
  // library once rather than forty times.
  trashFiles: (ids: string[]) => invoke<BulkReport>("trash_files", { ids }),
  moveFilesToFolder: (fileIds: string[], folderId: string | null) =>
    invoke<BulkReport>("move_files_to_folder", { fileIds, folderId }),
  restoreFiles: (ids: string[]) => invoke<BulkReport>("restore_files", { ids }),
  /** Irreversible, and each id must ALREADY be in the trash. */
  deleteFilesPermanently: (ids: string[]) =>
    invoke<BulkReport>("delete_files_permanently", { ids }),
  // ---- Wave 2: data safety ----
  listFileVersions: (id: string) =>
    invoke<FileVersion[]>("list_file_versions", { id }),
  /** ART-1: what produced the file's CURRENT content — null when the app never
   * recorded it (a person's own file, or one written before provenance). */
  getFileProvenance: (id: string) =>
    invoke<Provenance | null>("get_file_provenance", { id }),
  restoreFileVersion: (versionId: string) =>
    invoke<void>("restore_file_version", { versionId }),
  /** How many UNPINNED versions a file keeps before the oldest is dropped. */
  fileVersionsKept: () => invoke<number>("file_versions_kept"),
  /** Keep this version forever (outside the rolling window), or stop keeping it. */
  pinFileVersion: (versionId: string, pinned: boolean) =>
    invoke<void>("pin_file_version", { versionId, pinned }),
  /** Delete one saved version. Not undoable — confirm first. */
  deleteFileVersion: (versionId: string) =>
    invoke<void>("delete_file_version", { versionId }),
  // Idea 11: read a saved version's text (+ the current text) without restoring.
  getFileVersion: (versionId: string) =>
    invoke<VersionContent>("get_file_version", { versionId }),
  // Idea 9: whole-room checkpoints.
  createRoomCheckpoint: (name: string) =>
    invoke<CheckpointMeta>("create_room_checkpoint", { name }),
  listRoomCheckpoints: () =>
    invoke<{ entries: CheckpointMeta[]; totalBytes: number }>(
      "list_room_checkpoints",
    ),
  deleteRoomCheckpoint: (id: string) =>
    invoke<void>("delete_room_checkpoint", { id }),
  rollbackRoomCheckpoint: (id: string) =>
    invoke<RoomInfo>("rollback_room_checkpoint", { id }),
  // The checkpoints a rollback could NOT open with the room's current password.
  // Asked right after a password change: a `.roomck` whose re-key failed is
  // still a good copy, just locked under the password just replaced — and
  // saying nothing meant the user met it weeks later as a rollback error that
  // blamed the password they were typing.
  listStrandedCheckpoints: () => invoke<string[]>("list_stranded_checkpoints"),
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
  trashRoom: (path: string) => invoke<void>("trash_room", { path }),
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
  // PRIV-1: the cloud-privacy gatekeeper (switch, block list, preview, scan).
  privacyStatus: () => invoke<PrivacyStatus>("privacy_status"),
  setPrivacyRoom: (mode: "on" | "off" | "default") =>
    invoke<void>("set_privacy_room", { mode }),
  setPrivacyGlobal: (on: boolean) => invoke<void>("set_privacy_global", { on }),
  addPrivacyBlock: (text: string, category: string) =>
    invoke<PrivacyEntity>("add_privacy_block", { text, category }),
  removePrivacyEntity: (id: string) =>
    invoke<void>("remove_privacy_entity", { id }),
  setPrivacyConcepts: (concepts: string[]) =>
    invoke<void>("set_privacy_concepts", { concepts }),
  privacyPreview: (fileId: string) =>
    invoke<PrivacyPreview>("privacy_preview", { fileId }),
  startPrivacyScan: () => invoke<void>("start_privacy_scan"),
  webSearchTest: () => invoke<string>("web_search_test"),

  // BROWSE-1: the private browser area. The page itself is a NATIVE child
  // webview, so these only drive its chrome — position, navigation, takeover,
  // and the room-side journal of what the agent did.
  browserNavigate: (url: string) => invoke<string>("browser_navigate", { url }),
  /** Open another page. Pass "" for an empty tab. Returns its id. */
  browserNewTab: (url: string) => invoke<string>("browser_new_tab", { url }),
  /** Show one page and park the rest — no webview is created or destroyed, so
   *  a background page keeps its scroll, its forms and its session. */
  browserSelectTab: (id: string) => invoke<void>("browser_select_tab", { id }),
  browserCloseTab: (id: string) => invoke<void>("browser_close_tab", { id }),
  browserTabs: () => invoke<BrowserTab[]>("browser_tabs"),
  browserSetBounds: (x: number, y: number, width: number, height: number) =>
    invoke<void>("browser_set_bounds", { x, y, width, height }),
  browserInfo: () => invoke<BrowserInfo>("browser_info"),
  browserGo: (action: "back" | "forward" | "reload" | "stop") =>
    invoke<void>("browser_go", { action }),
  browserSetTakeover: (on: boolean) =>
    invoke<void>("browser_set_takeover", { on }),
  browserJournal: (limit?: number) =>
    invoke<BrowseJournalRow[]>("browser_journal", { limit }),
  browserClearJournal: () => invoke<void>("browser_clear_journal"),
  /** What a Clear would actually delete.
   *
   * The button says "Erase this record"; the command behind it also empties the
   * whole web cache — cached search terms, page text and preview images. Asking
   * first is what lets the confirmation name the larger deletion instead of
   * understating it. */
  browserClearScope: () => invoke<BrowseClearScope>("browser_clear_scope"),
  browserVerifyPrivate: () => invoke<boolean>("browser_verify_private"),
  /** Compile and re-attach the tracker block list to every open page, without
   *  navigating any of them. The recovery the shield offers when WebKit refused
   *  the list — a browser that silently gave up on its own protection is the
   *  defect this exists for. */
  browserRetryProtection: () => invoke<void>("browser_retry_protection"),
  /** Item #18: the current page as text, for the reading view. The page is a
   *  native layer the host DOM cannot reach into, so this — the same extractor
   *  `browse_read` uses — is the only honest way to put its content in front of
   *  a screen reader. Refuses while the page is parked, rather than returning
   *  the fragment a 1×1 layout viewport produces. */
  browserPageText: (mode: "main" | "full", offset: number) =>
    invoke<BrowserPageText>("browser_page_text", { mode, offset }),
  /** The passage selected on the live page, for the assistant's "selected
   *  passage" scope. Read-only: unlike `browserSavePage("selection")` it writes
   *  no room file and no journal row. */
  browserPageSelection: () =>
    invoke<BrowserPageSelection>("browser_page_selection"),
  /** Item #18: take the window's first responder back from the native page.
   *  Nothing in JavaScript can do this — they are different native views. */
  browserFocusApp: () => invoke<void>("browser_focus_app"),
  /** BROWSE-3: the address bar's second half. Text that isn't a URL runs a real
   *  search instead of erroring, and shares the assistant's own 15-minute
   *  cache — searching here warms the model's next lookup, and vice versa. */
  browserSearch: (query: string) =>
    invoke<BrowserSearchResult>("browser_search", { query }),
  /** BROWSE-3b: the enrich pass. Reads result pages for their own preview
   *  image, description and text. Progressive and never blocking — the results
   *  are already on screen when this is called, and a page that refuses us just
   *  keeps its monogram tile. */
  browserPreview: (urls: string[]) =>
    invoke<ResultPreview[]>("browser_preview", { urls }),
  /** BROWSE-3: readable text for one result's inline Peek. Usually free — the
   *  enrich pass already cached it. */
  browserPeek: (url: string) => invoke<string>("browser_peek", { url }),
  /** BROWSE-3: one grounded paragraph over the top results, written by the
   *  room's own engine with every claim cited by result number. */
  browserSearchSummary: (query: string) =>
    invoke<string>("browser_search_summary", { query }),
  /** BROWSE-3: the ＋ button — seal one result into the room as a source. A
   *  page saves a readable Markdown copy, a YouTube link its captions, and
   *  anything else goes through the binary download funnel. */
  importSearchResult: (url: string, title: string) =>
    invoke<FileMeta>("import_search_result", { url, title }),
  /** BROWSE-2: save the current page (or the user's selection) into the room.
   *  Returns a human sentence naming what was saved. */
  browserSavePage: (what: "page" | "selection") =>
    invoke<string>("browser_save_page", { what }),
  /** BROWSE-2 (D18): download a URL (engine "fetch") or a video/audio page
   *  (engine "media", via yt-dlp) as a durable background job. Returns the
   *  job id; progress arrives on the normal job-progress events. */
  startDownloadJob: (url: string, engine: "fetch" | "media") =>
    invoke<string>("start_download_job", { url, engine }),

  /** The Create page's shelf: every model this room's providers say can make
   *  a picture or a clip, plus why the rest cannot. Read live from the
   *  catalog — never a list kept here. */
  listCreateModels: () => invoke<CreateCatalog>("list_create_models"),
  /** Make one. Returns the job id; the pictures land as room files and
   *  progress arrives on the normal job-progress events. */
  startCreateJob: (opts: {
    prompt: string;
    model: string;
    kind: "image" | "video";
    variations?: number;
    /** Clip length. Only ever a value the model's own catalogue lists. */
    seconds?: number | null;
    resolution?: string;
    aspectRatio?: string;
    /** Room files sent as guiding pictures — the cast's faces. */
    referenceFileIds?: string[];
    /** A room file pinned as the clip's FIRST FRAME. Not a reference: the
     *  clip literally begins on this picture. */
    frameFileId?: string | null;
    /** The user was shown these pictures and pressed a button saying they
     *  would be sent. Nothing else may set this — see `videogen.guard`. */
    referencesAck?: boolean;
    shotId?: string | null;
  }) => invoke<string>("start_create_job", opts),
  /** What making the whole list WOULD do — every part's exact prompt, its
   *  length, and both ends of its clip — before a penny of it is spent.
   *  Built by the same Rust that runs the job, so it cannot drift from it. */
  storyFilmPlan: (listId: string, kind: "image" | "video", continuous = true) =>
    invoke<FilmPlan>("story_film_plan", { listId, kind, continuous }),
  /** Make every unmade shot in a list. One call rather than N, so a list of
   *  twenty is one decision with one outcome rather than twenty races. They
   *  run one at a time — the queue has a single running slot. */
  startShotListJob: (
    listId: string,
    kind: "image" | "video",
    /** Join each clip to the next by ending it on the following shot's
     *  opening picture. This is what makes twenty clips one episode. */
    continuous = true,
  ) => invoke<ShotRunStarted>("start_shot_list_job", { listId, kind, continuous }),
  /** Every picture in this room, as thumbnails to choose from. */
  storyPictures: () => invoke<RoomPicture[]>("story_pictures"),
  /** Every room file with text in it — the ones a script or a cast can come
   *  from. This is what stops the Story tab asking for a document the room is
   *  already holding to be typed in again. */
  storyDocuments: () => invoke<RoomDocument[]>("story_documents"),
  /** The WHOLE text of one room file. Never clamped — a clamp here is the
   *  `#minutes` bug again, where 6 KB of an hour-long transcript passed for
   *  the whole thing. */
  storyTextFromFile: (fileId: string) =>
    invoke<string>("story_text_from_file", { fileId }),
  /** Read a character sheet. Nothing is written — the people come back to be
   *  looked at and edited first. */
  storyReadCastFile: (fileId: string) =>
    invoke<CastFromFile>("story_read_cast_file", { fileId }),
  /** Keep the people that survived the preview. */
  storyAddCastMany: (members: ParsedMember[]) =>
    invoke<number>("story_add_cast_many", { members }),
  storyBoard: (listId?: string | null) =>
    invoke<StoryBoard>("story_board", { listId: listId ?? null }),
  storyAddCast: (name: string, description: string, story: string) =>
    invoke<CastMember>("story_add_cast", { name, description, story }),
  storyUpdateCast: (id: string, name: string, description: string, story: string) =>
    invoke<void>("story_update_cast", { id, name, description, story }),
  storySetFace: (id: string, fileId: string | null) =>
    invoke<void>("story_set_face", { id, fileId }),
  storyRemoveCast: (id: string) => invoke<void>("story_remove_cast", { id }),
  storyCreateList: (title: string, logline: string) =>
    invoke<string>("story_create_list", { title, logline }),
  storyUpdateList: (id: string, title: string, logline: string) =>
    invoke<void>("story_update_list", { id, title, logline }),
  /** The frame shape and output size for a whole list. Separate from the
   *  title and logline, which are re-saved on every keystroke — the shape is
   *  picked from a menu and has no business being written that often. */
  storySetShape: (opts: {
    id: string;
    aspectRatio: string;
    stillResolution: string;
    clipResolution: string;
  }) => invoke<void>("story_set_shape", opts),
  storyDeleteList: (id: string) => invoke<void>("story_delete_list", { id }),
  storyAddShot: (listId: string, action: string) =>
    invoke<StoryShot>("story_add_shot", { listId, action }),
  storyUpdateShot: (opts: {
    id: string;
    action: string;
    castIds: string[];
    seconds: number | null;
    imageModel: string;
    videoModel: string;
  }) => invoke<void>("story_update_shot", opts),
  storyRemoveShot: (id: string) => invoke<void>("story_remove_shot", { id }),
  storyReorderShots: (listId: string, ids: string[]) =>
    invoke<void>("story_reorder_shots", { listId, ids }),
  /** Cut a script into shots of a fixed length. Pure local text work — no
   *  model, nothing leaves the Mac, and no word can go missing. */
  storyPlanSplit: (script: string, minutes: number, secondsEach: number) =>
    invoke<ShotPlan>("story_plan_split", { script, minutes, secondsEach }),
  /** Write a planned split into a list. APPENDS — it never deletes shots that
   *  may already have paid-for pictures against them. */
  storyApplySplit: (opts: {
    listId: string;
    shots: PlannedShot[];
    imageModel: string;
    videoModel: string;
  }) => invoke<number>("story_apply_split", opts),
  onBrowserJournal: (cb: (row: BrowseJournalRow) => void): Promise<UnlistenFn> =>
    listen<BrowseJournalRow>("browser-journal", (e) => cb(e.payload)),
  onBrowserNavigated: (cb: (url: string) => void): Promise<UnlistenFn> =>
    listen<string>("browser-navigated", (e) => cb(e.payload)),
  /** BROWSE-3c: the Browser AGENT searched (it called `browse_open` with plain
   *  words instead of an address). Carries the same results the address bar
   *  would have produced, so the user watches the agent search on the page they
   *  already know rather than being told about it afterwards. */
  onBrowserSearched: (
    cb: (result: BrowserSearchResult) => void,
  ): Promise<UnlistenFn> =>
    listen<BrowserSearchResult>("browser-searched", (e) => cb(e.payload)),
  /** A navigation was refused by the same guard `fetch_page` uses — a private
   *  or non-web address. Surfaced so a blocked click never looks like a
   *  page that simply failed to load. */
  onBrowserBlocked: (cb: (p: { url: string }) => void): Promise<UnlistenFn> =>
    listen<{ url: string }>("browser-blocked", (e) => cb(e.payload)),
  /** BROWSE-2 (D9): a file the page downloaded finished importing into the
   *  room (`ok`) or truthfully failed (`ok: false`, `error` says why). */
  onBrowserDownload: (
    cb: (p: { url: string; name: string; ok: boolean; error?: string }) => void,
  ): Promise<UnlistenFn> =>
    listen<{ url: string; name: string; ok: boolean; error?: string }>(
      "browser-download",
      (e) => cb(e.payload),
    ),
  /** AUDIT 169: a download that has already grown past the size a room file may
   *  be, reported WHILE it runs. The size used to be checked only after the
   *  whole file had arrived, so a 20 GB click filled the disk and was then
   *  thrown away with an error. Its own event, never `browser-download`: that
   *  one means the transfer is over. Nothing here can cancel a download in
   *  flight — tauri's `DownloadEvent` has no such hook — so this warns, and
   *  says as much rather than implying it stopped anything. */
  onBrowserDownloadOversize: (
    cb: (p: { url: string; name: string; bytes: number; detail: string }) => void,
  ): Promise<UnlistenFn> =>
    listen<{ url: string; name: string; bytes: number; detail: string }>(
      "browser-download-oversize",
      (e) => cb(e.payload),
    ),
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
  // Connectors → "Run connector tools without asking": read/flip standing
  // consent so the agent's run_mcp_tool never stalls on a card. This one grants
  // permission to RUN and nothing else.
  getMcpAutoApprove: () => invoke<boolean>("get_mcp_auto_approve"),
  setMcpAutoApprove: (on: boolean) =>
    invoke<void>("set_mcp_auto_approve", { on }),
  // Connectors → "Send remote connectors real values": read/flip outbound
  // unmasking at the privacy door. Separate from the switch above (owner's
  // split, 2026-08-03) because "run this unattended" and "send this the room's
  // real data" are different risks; both default off.
  getMcpOutboundUnmask: () => invoke<boolean>("get_mcp_outbound_unmask"),
  setMcpOutboundUnmask: (on: boolean) =>
    invoke<void>("set_mcp_outbound_unmask", { on }),
  // Connectors → the per-connector answers that override the two switches
  // above, `{server: {auto_approve?, outbound_unmask?}}`. A power missing for a
  // connector means "follow the switch"; that is also what every connector says
  // on an install upgrading from the global-only pair, so nothing is granted by
  // the upgrade itself.
  mcpGetConnectorPowers: async (): Promise<ConnectorPowers> =>
    JSON.parse(await invoke<string>("get_mcp_connector_powers")) as ConnectorPowers,
  // `value: null` clears the override back to the switch above. Returns the new
  // map so the UI shows what was stored, not what it hoped for.
  mcpSetConnectorPower: async (
    server: string,
    power: "auto_approve" | "outbound_unmask",
    value: boolean | null,
  ): Promise<ConnectorPowers> =>
    JSON.parse(
      await invoke<string>("set_mcp_connector_power", { server, power, value }),
    ) as ConnectorPowers,
  // Marketplace: search the live MCP registry (opt-in gated). Errors when
  // browsing is off so the UI can show the opt-in gate.
  mcpRegistrySearch: (query?: string, limit?: number) =>
    invoke<CatalogEntry[]>("mcp_registry_search", { query, limit }),
  /** Can this connector's command run, and would one download fix it? */
  mcpRuntimeForCommand: (command: string) =>
    invoke<RuntimeStatus>("mcp_runtime_for_command", { command }),
  /** Fetch a runtime ("uv" | "node") once. Progress via `onRuntimeProgress`. */
  mcpProvisionRuntime: (kind: string) =>
    invoke<void>("mcp_provision_runtime", { kind }),
  onRuntimeProgress: (
    cb: (p: { kind: string; phase: string; got: number; total: number }) => void,
  ): Promise<UnlistenFn> =>
    listen<{ kind: string; phase: string; got: number; total: number }>(
      "runtime-progress",
      (e) => cb(e.payload),
    ),
  mcpRegistryOptinStatus: () =>
    invoke<boolean>("mcp_registry_optin_status"),
  setMcpRegistryOptin: (enabled: boolean) =>
    invoke<void>("set_mcp_registry_optin", { enabled }),
  // OAuth for a remote connector (opens the system browser). Returns the fresh
  // statuses once the token is stored and the connector reconnects.
  mcpOauthAuthorize: (server: string) =>
    invoke<McpServerStatus[]>("mcp_oauth_authorize", { server }),
  mcpOauthStatus: (server: string) =>
    invoke<boolean>("mcp_oauth_status", { server }),
  mcpOauthSignOut: (server: string) =>
    invoke<McpServerStatus[]>("mcp_oauth_sign_out", { server }),
  // Fires when an OAuth sign-in reaches the browser step, carrying the authorize
  // URL — the UI shows it as a manual "open / copy" fallback if the system
  // browser doesn't open on its own.
  onMcpOauthUrl: (
    cb: (p: { server: string; url: string }) => void,
  ): Promise<UnlistenFn> =>
    listen<{ server: string; url: string }>("mcp-oauth-url", (e) => cb(e.payload)),
  // Turn a connector on/off (keeps it in the config) or remove it entirely.
  mcpSetServerEnabled: (server: string, enabled: boolean) =>
    invoke<McpServerStatus[]>("mcp_set_server_enabled", { server, enabled }),
  mcpRemoveServer: (server: string) =>
    invoke<McpServerStatus[]>("mcp_remove_server", { server }),
  // Per-connector tool opt-outs: `{ server: [disabled tool names] }`. Toggling a
  // tool off keeps the connector but hides that tool from the assistant.
  // Both REJECT when the backend (or the JSON) fails. They used to answer `{}`,
  // which reads as "nothing is turned off" — so a failed toggle redrew every
  // switched-off tool as ON while the file on disk still said otherwise.
  mcpGetToolPrefs: async (): Promise<Record<string, string[]>> =>
    JSON.parse(await invoke<string>("mcp_get_tool_prefs")) as Record<
      string,
      string[]
    >,
  mcpSetToolEnabled: async (
    server: string,
    tool: string,
    enabled: boolean,
  ): Promise<Record<string, string[]>> =>
    JSON.parse(
      await invoke<string>("mcp_set_tool_enabled", { server, tool, enabled }),
    ) as Record<string, string[]>,
  // Wave 2 (Idea 6): answer a diff-preview approval ("once" | "turn" | "deny").
  resolveEditApproval: (id: string, decision: "once" | "turn" | "deny") =>
    invoke<void>("resolve_edit_approval", { id, decision }),
  // ADD-12: fetch a web page and save it as a readable room file.
  importLink: (url: string) => invoke<FileMeta>("import_link", { url }),
  // ---- ADD-30: durable background jobs (the sidebar jobs panel) ----
  listJobs: () => invoke<Job[]>("list_jobs"),
  /** Start the room deep-summary job; returns its id. Progress → job-progress. */
  startDeepSummary: () => invoke<string>("start_deep_summary"),
  /** Start a Studio artifact (flashcards / mindmap / podcast) as a background
   *  job; returns its id. The finished HTML opens itself via the terminal
   *  job-progress event's fileId. `scope` = a file id (else whole room);
   *  `refs` = @-mentioned file ids. */
  startStudioJob: (
    kind: "flashcards" | "mindmap" | "podcast",
    scope?: string,
    instructions?: string,
    refs?: string[],
  ) => invoke<string>("start_studio_job", { kind, scope, instructions, refs }),
  // ---- Podcast voices ----
  /** The script attached to a file, or null when it has none — which is the
   * ordinary answer for any file that is not a podcast, and also for a script
   * page generated before scripts were stored as data. */
  getPodcast: (fileId: string) =>
    invoke<Podcast | null>("get_podcast", { fileId }),
  /** Re-cast: voices, names and prosody. Renaming a host rewrites its turns, so
   * the lines follow the name. Returns the script as it now stands. */
  setPodcastCast: (fileId: string, cast: PodcastHost[]) =>
    invoke<Podcast>("set_podcast_cast", { fileId, cast }),
  /** Speak one line in one host's voice — base64 WAV, same shape and the same
   * privacy door as `speakTextNeural`. */
  previewPodcastVoice: (
    text: string,
    voice: string,
    rate: string,
    pitch: string,
  ) =>
    invoke<string>("preview_podcast_voice", { text, voice, rate, pitch }),
  /** Record the whole episode as a background job; returns the job id. Progress
   * and the finished file arrive on the sidebar job card like every other long
   * build. */
  startPodcastAudioJob: (scriptFileId: string) =>
    invoke<string>("start_podcast_audio_job", { scriptFileId }),
  /** Pause a running job — it checkpoints and parks as 'paused'. */
  cancelJob: (id: string) => invoke<void>("cancel_job", { id }),
  /** Continue a paused/errored job from its checkpoint. */
  resumeJob: (id: string) => invoke<void>("resume_job", { id }),
  deleteJob: (id: string) => invoke<void>("delete_job", { id }),
  // ---- Wave 4a (Idea 2): LLM graph workflows ----
  listWorkflows: () => invoke<Workflow[]>("list_workflows"),
  getWorkflowSchedule: (id: string) =>
    invoke<Schedule | null>("get_workflow_schedule", { id }),
  workflowTemplates: () => invoke<WorkflowTemplate[]>("workflow_templates"),
  saveWorkflow: (w: {
    name: string;
    description?: string;
    emoji?: string;
    definition: unknown;
    binding?: unknown;
    createdBy?: string;
    schedule?: ScheduleArg;
  }) => invoke<string>("save_workflow", w),
  updateWorkflow: (w: {
    id: string;
    name?: string;
    description?: string;
    emoji?: string;
    definition?: unknown;
    binding?: unknown;
    schedule?: ScheduleArg;
  }) => invoke<void>("update_workflow", w),
  deleteWorkflow: (id: string) => invoke<void>("delete_workflow", { id }),
  setWorkflowStatus: (id: string, status: "active" | "draft") =>
    invoke<void>("set_workflow_status", { id, status }),
  setWorkflowPinned: (id: string, pinned: boolean) =>
    invoke<void>("set_workflow_pinned", { id, pinned }),
  setWorkflowSchedule: (id: string, schedule: ScheduleArg) =>
    invoke<void>("set_workflow_schedule", { id, schedule }),
  /** Validate a definition WITHOUT saving — the canvas round-trips edits here. */
  validateWorkflow: (definition: unknown, binding?: unknown) =>
    invoke<string[]>("validate_workflow", { definition, binding }),
  /** Compose a workflow from a plain-language description on any engine (the
   * model returns JSON as text; the backend validates + saves a draft). Returns
   * the new workflow's id. */
  composeWorkflow: (description: string) =>
    invoke<string>("compose_workflow", { description }),
  getWorkflowRuns: (id: string) =>
    invoke<WorkflowRun[]>("get_workflow_runs", { id }),
  getJobStepArtifact: (jobId: string, stepId: number) =>
    invoke<string | null>("get_job_step_artifact", { jobId, stepId }),
  /** Run a workflow now; `fileId` for a file-scoped (Actions-menu) run. */
  runWorkflow: (id: string, fileId?: string) =>
    invoke<string>("run_workflow", { id, fileId }),
  // ---- Wave 5 (Idea 13): runnable & schedulable scripts ----
  /** Every `.py`/`.js` room file as a script, with status/last-run/schedule. */
  listScripts: () => invoke<ScriptInfo[]>("list_scripts"),
  /** Run a script now. May raise a consent card first; returns the job id.
   *  Progress arrives via job-progress; the run is a hidden auto-workflow. */
  runScript: (fileId: string) => invoke<string>("run_script", { fileId }),
  /** Schedule (or clear, kind="") a script. Requires the script to be approved. */
  setScriptSchedule: (
    fileId: string,
    kind: string,
    param: string,
    enabled: boolean,
  ) => invoke<void>("set_script_schedule", { fileId, kind, param, enabled }),
  /** Answer a script-run consent card ("once" | "always" | "deny"). */
  resolveScriptRun: (id: string, decision: "once" | "always" | "deny") =>
    invoke<void>("resolve_script_run", { id, decision }),
  // ---- Portable Agent Skills (separate from ordinary room files) ----
  listSkills: () => invoke<SkillSummary[]>("list_skills"),
  getSkill: (id: string) => invoke<SkillBundle>("get_skill", { id }),
  /** `agent` binds the skill to one domain agent (`SkillBundle.skill.agent`);
   *  "" or omitted = general, offered to every agent. It must be a real agent id
   *  (the SKILL_AGENT_IDS list — "files.read", "chat.web", …), never free text:
   *  an id nobody answers to binds the skill to no agent at all, so it lists and
   *  enables and is then offered to nobody. Any picker wired up here has to send
   *  an id from that list. */
  createSkill: (
    name: string,
    description: string,
    instructions: string,
    agent?: string,
  ) =>
    invoke<string>("create_skill", {
      name,
      description,
      instructions,
      agent: agent ?? null,
    }),
  /** Omitting `agent` leaves the existing binding alone — pass "" to clear it. */
  updateSkill: (
    id: string,
    name: string,
    description: string,
    instructions: string,
    agent?: string,
  ) =>
    invoke<void>("update_skill", {
      id,
      name,
      description,
      instructions,
      agent: agent ?? null,
    }),
  setSkillEnabled: (id: string, enabled: boolean) =>
    invoke<void>("set_skill_enabled", { id, enabled }),
  deleteSkill: (id: string) => invoke<void>("delete_skill", { id }),
  getSkillResource: (skillId: string, path: string) =>
    invoke<SkillResourceContent>("get_skill_resource", { skillId, path }),
  saveSkillResource: (
    skillId: string,
    path: string,
    content: { text?: string; dataB64?: string },
  ) =>
    invoke<void>("save_skill_resource", {
      skillId,
      path,
      text: content.text ?? null,
      dataB64: content.dataB64 ?? null,
    }),
  deleteSkillResource: (skillId: string, path: string) =>
    invoke<void>("delete_skill_resource", { skillId, path }),
  /** `replace` re-imports OVER the skill of that name, keeping its id and its
   *  enabled state. Omitted, a name clash is still refused. */
  importSkillFolder: (path: string, replace = false) =>
    invoke<string>("import_skill_folder", { path, replace }),
  /** The name of the skill this folder would clash with, or null. Ask before
   *  importing so the clash can offer Replace instead of failing. */
  skillImportConflict: (path: string) =>
    invoke<string | null>("skill_import_conflict", { path }),
  /** Every owner a skill may be bound to ("" — general — is not in the list).
   *  The host's own roster, so a picker can never offer an id it would reject. */
  skillAgentIds: () => invoke<string[]>("skill_agent_ids"),
  exportSkillFolder: (id: string, destination: string) =>
    invoke<string>("export_skill_folder", { id, destination }),
  composeSkill: (description: string, fileIds: string[] = []) =>
    invoke<string>("compose_skill", { description, fileIds }),
  aiStatus: () => invoke<AiStatus>("ai_status"),
  /** ADD-22: tool/vision abilities per installed model, for Settings badges. */
  modelCapabilities: () => invoke<ModelCaps[]>("model_capabilities"),
  /** The OPEN room's engine, as ONE declared capability record.
   *
   *  It is NOT yet the single source it was written to be, and saying otherwise
   *  here would be a claim this file cannot keep: the trust chip still answers
   *  the locality half from `markup.ts`'s own `isExternalEngine` id list, so a
   *  new provider has to be added in both places or the chip calls a remote
   *  room local. Wiring the chip to this record is what would close that. */
  engineCapabilities: () => invoke<EngineCapabilities>("engine_capabilities"),
  /** PREFLIGHT: can the room's engine do this, asked BEFORE the run so the user
   *  gets one plain sentence instead of a stream that dies halfway. */
  enginePreflight: (capability: Capability) =>
    invoke<EnginePreflight>("engine_preflight", { capability }),
  /** The published provider × agent matrix, DERIVED from the capability records
   *  and the sidecar's own agent registry — never hand-maintained. */
  engineSupportMatrix: () => invoke<SupportMatrix>("engine_support_matrix"),
  /**
   * Which model would mark an image for the open room, or null when nothing
   * can. The ONE source of truth for "can this room see?" — the same pick the
   * grounding call itself makes, capability-asked rather than name-matched.
   * Screens used to re-derive it from the local Ollama list, so a room on a
   * cloud vision model was told to download a local one it had no use for.
   */
  groundingModelForRoom: () => invoke<string | null>("grounding_model_for_room"),
  /** Models available for a detected cloud engine ("claude-cli"/"codex-cli"),
   *  for the Cloud picker's second level. */
  listEngineModels: (engine: string) =>
    invoke<ExternalModelInfo[]>("list_engine_models", { engine }),
  listAiProviders: () => invoke<AiProviderStatus[]>("list_ai_providers"),
  connectAiProvider: (provider: string, apiKey: string) =>
    invoke<number>("connect_ai_provider", { provider, apiKey }),
  disconnectAiProvider: (provider: string) =>
    invoke<void>("disconnect_ai_provider", { provider }),
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
  // PRIV-1: `privacyBypass` is the confirmed "send real details this once".
  /** `viewing` is the NAME of the file open in the viewer as the question is
   *  sent, so "summarize this" can mean what the user is pointing at. Names
   *  only — the content still travels only through the paperclip. */
  ask: (
    chatId: string,
    question: string,
    attachments: string[],
    askId: string,
    viewing?: string | null,
    privacyBypass?: boolean,
  ) =>
    invoke<Message>("ask", {
      chatId,
      question,
      attachments,
      askId,
      viewing: viewing ?? null,
      privacyBypass: privacyBypass ?? null,
    }),
  /** Stop this run — and everything it had started. Answers with what it
   *  actually stopped (see `StopReport`), so the UI can say so instead of
   *  leaving the user to guess from a screen that went quiet. */
  cancelAsk: (askId: string) => invoke<StopReport>("cancel_ask", { askId }),
  // Context handoff: summarize the chat so far and insert a marker message —
  // every future turn's history then starts from that marker.
  handoffContext: (chatId: string) => invoke<Message>("handoff_chat", { chatId }),
  /** Run a prebuilt "#name" workflow. `refs` are @-pinned file ids; `raw` is
   *  the full line the user typed (saved verbatim as the user message). Streams
   *  the same ask-delta/ask-step events as `ask`. */
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
  /** The specialists this room can dispatch to, for the composer's "*" menu.
   *  Rejects (rather than returning []) when the sidecar cannot be reached —
   *  "no specialists" and "we could not find out" are different answers. */
  listSpecialists: () => invoke<Specialist[]>("list_specialists"),
  // ADD-8: import a pasted image (base64) as a room file.
  importImageBytes: (name: string, b64: string) =>
    invoke<FileMeta>("import_image_bytes", { name, b64 }),
  // ADD-18: store an in-room voice note; transcribes in the background.
  importAudioBytes: (name: string, b64: string) =>
    invoke<FileMeta>("import_audio_bytes", { name, b64 }),
  /** Ask the vision model where `query` is in an image; boxes come back in
   *  0-1000 coordinates, so nothing here depends on the on-screen size.
   *  The measured `imgWidth`/`imgHeight` are GONE from both sides — the command
   *  is `locate_in_image(fileId, query)` (vision.rs) and the sidecar stretches
   *  the original bytes itself. The two legacy parameters lingered here as
   *  ignored placeholders while the last caller still measured the element to
   *  fill them; it no longer does, so there is nothing left to keep. */
  locateInImage: (fileId: string, query: string) =>
    invoke<ImageBox[]>("locate_in_image", { fileId, query }),
  // ---- ADD-18: on-device dictation & transcription (Whisper built in) ----
  sttStatus: () => invoke<SttStatus>("stt_status"),
  sttDownloadModel: () => invoke<void>("stt_download_model"),
  /** Stop a voice-model download in progress. Answers whether there WAS one to
   *  stop — false means nothing was downloading, and the caller must not claim
   *  it stopped anything. The download itself then fails with "Download
   *  stopped." and its part-file is removed. */
  sttCancelDownload: () => invoke<boolean>("stt_cancel_download"),
  sttDeleteModel: () => invoke<void>("stt_delete_model"),
  /** Re-run on-device transcription for a stored audio/video file, replacing its
   *  transcript. Queues on the same STT lane as import; progress arrives via the
   *  usual `stt-progress` events. Rejects for non-media files. */
  retranscribeFile: (fileId: string) =>
    invoke<void>("retranscribe_file", { fileId }),
  /** Post-process dictated text on the LOCAL model (alfred's pipeline):
   *  optional translate-to-English + an intent rewrite (raw/email/message/
   *  commit/notes/prompt). mode="off" && !translate returns text unchanged. */
  shapeText: (text: string, translate: boolean, mode: string) =>
    invoke<string>("shape_text", { text, translate, mode }),
  // ---- Streaming dictation (Metal wave): partials while you speak ----
  /** Open a streaming dictation session. Rejects with STT_MODEL_MISSING
   *  before any audio flows when the voice model isn't installed. */
  dictStart: () => invoke<DictSessionInfo>("dict_start"),
  /** ~250ms of mic samples, same wire format as recPushAudio. */
  dictPushAudio: (rate: number, dataB64: string) =>
    invoke<void>("dict_push_audio", { rate, dataB64 }),
  /** Close the session: one final whole-utterance decode (may be ""). */
  dictStop: () => invoke<string>("dict_stop"),
  /** Abandon the session without a final decode (setup failed mid-way). */
  dictCancel: () => invoke<void>("dict_cancel"),
  /** The rolling partial transcript — the FULL text so far, repainted. */
  onDictPartial: (cb: (text: string) => void): Promise<UnlistenFn> =>
    listen<string>("dict-partial", (e) => cb(e.payload)),

  // ---- Idea 3: supernatural voice (neural synthesis via the sidecar) ----
  /** The spoken voice: one sentence-sized chunk (≤1,000 chars) via the
   *  sidecar's Edge TTS seam — normalized WAV, base64. `voice` picks from
   *  the curated multilingual roster (null = Andrew, the product default).
   *  Fails when offline; the caller skips that sentence (there is no
   *  on-device fallback voice). */
  speakTextNeural: (text: string, voice: string | null) =>
    invoke<string>("speak_text_neural", { text, voice }),
  /** The service's LIVE voice catalog for the Settings picker — nothing is
   *  bundled; new service voices appear without an app update. Fails when
   *  offline (and the sidecar has no last-good copy); the picker then keeps
   *  the saved voice and says the list couldn't load. */
  listNeuralVoices: () => invoke<NeuralVoiceInfo[]>("list_neural_voices"),

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
      /** This run's id, so `cancelAsk(opId)` can Stop it — the same registry
       *  chat's Stop and a Studio build use. */
      opId?: string | null;
    },
  ) =>
    invoke<FileMeta>("ai_action", {
      action,
      scope: opts.scope ?? null,
      refs: opts.refs ?? null,
      instructions: opts.instructions ?? null,
      question: opts.question ?? null,
      opId: opts.opId ?? null,
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
  /** AUDIT 262: background OCR of a scanned page or image: [fileName, phase],
   *  phase one of started | done | none. The host emitted this from the first
   *  build and nothing listened, so a scan that runs for minutes on a local
   *  vision model showed no sign of activity anywhere in the app. */
  onOcrProgress: (cb: (p: [string, string]) => void): Promise<UnlistenFn> =>
    listen<[string, string]>("ocr-progress", (e) => cb(e.payload)),
  onOpenRoomFile: (cb: (path: string) => void): Promise<UnlistenFn> =>
    listen<string>("open-room-file", (e) => cb(e.payload)),
  // Idea 9: the room was rolled back to a checkpoint — the whole workspace
  // remounts against the swapped DB. Payload is the reopened room's info.
  onRoomRolledBack: (cb: (info: RoomInfo) => void): Promise<UnlistenFn> =>
    listen<RoomInfo>("room-rolled-back", (e) => cb(e.payload)),
  // ---- turn events -----------------------------------------------------
  //
  // Owner replacement #4 (2026-08-03): every `ask-*` event now arrives in an
  // identity envelope — `{ runId, chatId, v }` — because a window event is a
  // broadcast and the listener used to infer ownership from what was mounted.
  // `askEvent` unwraps `v` and hands the ids alongside it, so every listener
  // below has the same shape: `(payload, turn)`. The ids can be null: an
  // emitter that belongs to no conversation says so rather than borrowing one
  // (crate::turn::emit_unowned).
  onAskDelta: (
    cb: (delta: string, turn: AskTurn) => void,
  ): Promise<UnlistenFn> => askEvent<string>("ask-delta", cb),
  // CHG-5: structured turn events. `ask-step` fires when a tool runs;
  // `ask-round` fires when a new model round starts (clear the live text).
  // Two payload shapes reach this event: the sidecar sends {label, node} so a
  // step can be attributed to the agent that ran it, while the many other
  // emitters (chat commands, ai_actions, the native agent paths) send a bare
  // string. Normalised here so no consumer has to know which one fired.
  // The Sketch page. Loading and saving a drawing ride updateFileContent, so
  // starting one and flattening one to SVG are all the page needs of its own.
  createSketch: (name: string): Promise<FileMeta> =>
    invoke<FileMeta>("create_sketch", { name }),
  // Drawings autosave several times a minute, so they do NOT go through
  // updateFileContent: that snapshots a version, reindexes and broadcasts
  // room-files-changed on every call. `snapshot` is true once per editing
  // session, which is where version history actually belongs.
  saveSketch: (id: string, doc: string, snapshot: boolean): Promise<void> =>
    invoke<void>("save_sketch", { id, doc, snapshot }),
  exportSketchSvg: (id: string): Promise<FileMeta> =>
    invoke<FileMeta>("export_sketch_svg", { id }),
  /** …and as a flat picture, for everywhere that will not take a vector. */
  exportSketchPng: (id: string): Promise<FileMeta> =>
    invoke<FileMeta>("export_sketch_png", { id }),
  // The drawing agent finished a `draw` call. Carries the WHOLE document, so
  // an open editor can fold it in without a re-read — the window between a
  // write and a read is exactly when a user's un-autosaved stroke goes missing.
  onSketchDrawn: (cb: (e: SketchDrawn) => void): Promise<UnlistenFn> =>
    listen<SketchDrawn>("sketch-drawn", (e) => cb(e.payload)),
  onAskStep: (
    cb: (step: AskStep, turn: AskTurn) => void,
  ): Promise<UnlistenFn> =>
    askEvent<string | AskStep>("ask-step", (v, turn) =>
      cb(
        typeof v === "string"
          ? { label: v, node: null }
          : { label: v.label, node: v.node ?? null },
        turn,
      ),
    ),
  // ADD-22: the deterministic router's chosen lane ("Answering", "Working on
  // your files", …), shown as a subtle label so an odd answer is explainable.
  onAskLane: (
    cb: (label: string, turn: AskTurn) => void,
  ): Promise<UnlistenFn> => askEvent<string>("ask-lane", cb),
  // Dispatch-first agent visibility: the roster of domain agents handling
  // this ask (once, before work starts) and the currently active one.
  onAskPlan: (
    cb: (plan: AskPlanStep[], turn: AskTurn) => void,
  ): Promise<UnlistenFn> => askEvent<AskPlanStep[]>("ask-plan", cb),
  onAskAgent: (
    cb: (agent: AskActiveAgent, turn: AskTurn) => void,
  ): Promise<UnlistenFn> => askEvent<AskActiveAgent>("ask-agent", cb),
  // ADD-22: outcome of the most recent tool step, so a failed chip reads failed.
  // `node` (when present) says WHOSE most-recent step this resolves — with
  // parallel children "the most recent step" is ambiguous without it.
  onAskStepStatus: (
    cb: (p: { ok: boolean; node?: string | null }, turn: AskTurn) => void,
  ): Promise<UnlistenFn> =>
    askEvent<{ ok: boolean; node?: string | null }>("ask-step-status", cb),
  onAskRound: (cb: (turn: AskTurn) => void): Promise<UnlistenFn> =>
    askEvent<unknown>("ask-round", (_v, turn) => cb(turn)),
  /** What a specialist reported back, stamped with its graph slot — the
   * durable copy of words the live area shows once and then clears. */
  onAskReport: (
    cb: (r: AskReport, turn: AskTurn) => void,
  ): Promise<UnlistenFn> => askEvent<AskReport>("ask-report", cb),
  // PRIV-1: what the privacy door did on this turn ("N details hidden"), or
  // { bypassed: true } when the user shared real details this once.
  onAskPrivacy: (
    cb: (p: AskPrivacy, turn: AskTurn) => void,
  ): Promise<UnlistenFn> => askEvent<AskPrivacy>("ask-privacy", cb),
  // Token-budget bar: one live usage snapshot per completed model round.
  onAskTokenUsage: (
    cb: (p: AskTokenUsage, turn: AskTurn) => void,
  ): Promise<UnlistenFn> => askEvent<AskTokenUsage>("ask-token-usage", cb),
  // PRIV-2: background privacy-scan progress for the Settings section.
  onPrivacyScan: (cb: (p: PrivacyScanProgress) => void): Promise<UnlistenFn> =>
    listen<PrivacyScanProgress>("privacy-scan", (e) => cb(e.payload)),
  // ADD-31: named stage while a Studio (flashcards/mindmap/podcast) runs.
  // `local` says whether this stage keeps the room's content on the Mac. It
  // travels WITH the words so the pane can style a privacy consequence
  // differently from a progress aside without matching English against the
  // sentence — see studios.rs, where the flag comes from the model's declared
  // capabilities rather than from its name.
  onStudioStep: (cb: (p: StudioStep) => void): Promise<UnlistenFn> =>
    listen<StudioStep>("studio-step", (e) => cb(e.payload)),
  // ADD-30: live progress of a background job, plus its terminal flags.
  onJobProgress: (cb: (p: JobProgress) => void): Promise<UnlistenFn> =>
    listen<JobProgress>("job-progress", (e) => cb(e.payload)),
  // Wave 4a: a workflow node's live status during a run (drives the pipeline
  // animation) and any workflow save/update/delete (refresh the library).
  onWorkflowNode: (cb: (e: WorkflowNodeEvent) => void): Promise<UnlistenFn> =>
    listen<WorkflowNodeEvent>("workflow-node", (e) => cb(e.payload)),
  onWorkflowsChanged: (cb: () => void): Promise<UnlistenFn> =>
    listen("workflows-changed", () => cb()),
  onSkillsChanged: (cb: () => void): Promise<UnlistenFn> =>
    listen("skills-changed", () => cb()),
  /** The agent added, corrected or forgot a memory. Emitted by every writer,
   * including the ones with no chat turn to end (workflow nodes, scheduled
   * runs, an outside agent on the room bridge). */
  onMemoriesChanged: (cb: () => void): Promise<UnlistenFn> =>
    listen("memories-changed", () => cb()),
  // Wave 5 (Idea 13): the backend is about to run a script from this room and
  // needs the user's consent (SEC-1 — the card is data-agent-blocked).
  onScriptApproveRequest: (
    cb: (req: ScriptApproveRequest) => void,
  ): Promise<UnlistenFn> =>
    listen<ScriptApproveRequest>("script-approve-request", (e) => cb(e.payload)),
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
  /** The assistant changed what the Library shows. A different fact from
   *  `room-files-changed`, which only says the list is stale: this one names
   *  the object and says which way it went, so Activity can record it. */
  onAssistantOrganized: (
    cb: (change: OrganizedChange) => void,
  ): Promise<UnlistenFn> =>
    listen<OrganizedChange>("assistant-organized", (e) => cb(e.payload)),
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
  /** …and the other half of editing: RETYPE what a span says. Deleting was the
   *  only edit there was, so a misheard name meant leaving it wrong or losing
   *  the sentence. The audio is untouched — this is not a cut. */
  recCorrectRange: (id: string, t0: number, t1: number, text: string) =>
    invoke<RecMeta>("rec_correct_range", { id, t0, t1, text }),
  /** GH #5: name a speaker after transcribing ("Speaker 2" → "Dana"). Renames
   * every line they said at once; an empty name restores the machine label.
   *
   * Also teaches the ROOM this voice, so the next recording recognises them
   * without being asked again — and, when it is correcting a guess, teaches it
   * that the name it guessed belongs to somebody else. */
  recSetSpeakerName: (id: string, speaker: string, name: string) =>
    invoke<RecMeta>("rec_set_speaker_name", { id, speaker, name }),
  /** "Read this recording" / "Read again": have the room read a recording and
   * write its chapters, highlights and notes. The same job the room starts by
   * itself when a recording stops — this is the button for when it did not (no
   * model then, the room was busy, an old recording, or a transcript you have
   * since corrected). Resolves to the job id; watch it via the job events. */
  recReadStart: (id: string) => invoke<string>("rec_read_start", { id }),
  /** The reading finished — reload the recording so the tabs fill in. */
  onRecReadDone: (cb: (p: { fileId: string }) => void): Promise<UnlistenFn> =>
    listen("rec-read-done", (e) => cb(e.payload as never)),
  /** Your own note at a moment. Works while a recording is running. */
  recNoteAdd: (id: string, t0: number, kind: NoteKind, text: string, who?: string) =>
    invoke<RecMeta>("rec_note_add", { id, t0, kind, text, who }),
  /** Retype a note. Correcting one the ROOM wrote makes it yours, and the next
   * reading leaves it alone. */
  recNoteSet: (id: string, noteId: string, text: string) =>
    invoke<RecMeta>("rec_note_set", { id, noteId, text }),
  /** Name a section starting at `t0`. */
  recChapterAdd: (id: string, t0: number, title: string) =>
    invoke<RecMeta>("rec_chapter_add", { id, t0, title }),
  /** Rename a chapter — and make it yours. */
  recChapterSet: (id: string, chapterId: string, title: string) =>
    invoke<RecMeta>("rec_chapter_set", { id, chapterId, title }),
  /** Mark a span worth coming back to. Works while recording. */
  recHighlightAdd: (id: string, t0: number, t1: number) =>
    invoke<RecMeta>("rec_highlight_add", { id, t0, t1 }),
  /** Remove one item ("note" | "chapter" | "highlight"). */
  recItemDelete: (id: string, kind: "note" | "chapter" | "highlight", itemId: string) =>
    invoke<RecMeta>("rec_item_delete", { id, kind, itemId }),
  /** The voices this room can recognise. */
  voicesList: () => invoke<SavedVoice[]>("voices_list"),
  /** Forget a saved voice — transcripts already written keep the names they
   * show. Returns the remaining voices. */
  voiceForget: (name: string) => invoke<SavedVoice[]>("voice_forget", { name }),
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
  /** Speakers sorting themselves out mid-meeting. Carries the name overlay as
   * well as the labels: a pass can change what a voice is CALLED without
   * moving a single label (a saved voice recognised as the meeting grows). */
  onRecRelabel: (
    cb: (p: {
      fileId: string;
      labels: { id: string; speaker: string }[];
      speakerNames?: Record<string, string>;
      recognized?: string[];
    }) => void,
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
  /** Show the folder holding the app's two log files in Finder, and return its
   *  path so it can be named on screen. The logs hold ids, counts, durations
   *  and error kinds — never anything from a room — so they are safe to attach
   *  to a bug report. */
  revealLogs: () => invoke<string>("reveal_logs"),

  /** Tell Rust whether the open editor holds edits a quit would throw away.
   *  ⌘Q raises no window close request on macOS, so the window's own guard
   *  never sees it — the event-loop handler that does is synchronous and
   *  cannot ask anything, which is why this is pushed rather than pulled. */
  setUnsavedEdits: (on: boolean) => invoke<void>("set_unsaved_edits", { on }),
  /** Answered the quit question with "no": re-arm the door, buffer still dirty. */
  quitGuardRearm: () => invoke<void>("quit_guard_rearm"),
  quitGuardConfirm: () => invoke<void>("quit_guard_confirm"),
  /** Rust held a ⌘Q so this window can ask about those edits. Whoever listens
   *  OWNS finishing the quit — Rust will not hold the next one. */
  onQuitRequested: (cb: () => void): Promise<UnlistenFn> =>
    listen("quit-requested", () => cb()),

  /** A row of the native View menu was chosen; the payload is its id.
   *  One event for the whole menu — see src-tauri/src/menu.rs. */
  onMenuAction: (cb: (id: string) => void): Promise<UnlistenFn> =>
    listen<string>("menu-action", (e) => cb(e.payload)),
  /** What the native View menu should be showing. Sent whole rather than a
   *  tick at a time so the menu is never caught halfway through a layout
   *  change, and once more with `enabled: false` when the room closes — the
   *  menu bar outlives the room, and a row that cannot act must not look
   *  like it can. Cosmetic by design: it never rejects into the UI. */
  syncViewMenu: (view: ViewMenuState) => invoke<void>("menu_sync", { view }),

  /** ADD-26 / BROWSE-2: download a video or audio page into the room via
   *  yt-dlp (fetched on first use), YouTube included. Emits ytdlp-progress.
   *  `maxHeight` caps the resolution (the modal's quality pick); omitted =
   *  best available. */
  importMediaUrl: (url: string, maxHeight?: number) =>
    invoke<ImportReport>("import_media_url", { url, maxHeight }),
  /** The qualities a video actually offers, best first — feeds the modal's
   *  picker. A metadata-only probe, but still an outbound reach (same web
   *  gating as the download). */
  listMediaFormats: (url: string) =>
    invoke<MediaQualityOption[]>("list_media_formats", { url }),
  /** Abandon the video download running now. The command itself then rejects
   *  with "Stopped." — a download you started by mistake used to have no way
   *  out short of quitting the app. */
  cancelMediaDownload: () => invoke<void>("cancel_media_download"),
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
  onHarnessEvent: (cb: (event: HarnessEvent) => void): Promise<UnlistenFn> =>
    listen<HarnessEvent>("harness-event", (e) => cb(e.payload)),
  /** Scan/copy/validate progress shared by migration, packages, checkpoints,
   * and the protected baseline made before a write-enabled agent starts. */
  onWorkspaceOperationProgress: (
    cb: (event: WorkspaceOperationProgressEvent) => void,
  ): Promise<UnlistenFn> =>
    listen<WorkspaceOperationProgressEvent>(
      "workspace-operation-progress",
      (e) => cb(e.payload),
    ),
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
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "note";
  // .xls / .ods / .tsv were missing here, so a legacy workbook listed as
  // "File" right beside an .xlsx listed as "Sheet".
  if ([".csv", ".tsv", ".xlsx", ".xls", ".ods"].some((e) => lower.endsWith(e))) {
    return "sheet";
  }
  if (lower.endsWith(".py") || lower.endsWith(".js")) return "script";
  if (lower.endsWith(".docx") || lower.endsWith(".doc")) return "document";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "HTML";
  // The formats that gained real viewers: a deck listed as "File" next to a
  // PDF listed as "PDF" reads as "we don't handle this one".
  if (lower.endsWith(".pptx") || lower.endsWith(".ppt")) return "presentation";
  if (lower.endsWith(".epub")) return "book";
  if (lower.endsWith(".zip")) return "archive";
  if (lower.endsWith(".ipynb")) return "notebook";
  if (lower.endsWith(".eml")) return "message";
  if (lower.endsWith(".srt") || lower.endsWith(".vtt")) return "subtitles";
  if (lower.endsWith(".svg")) return "drawing";
  if (lower.endsWith(".json") || lower.endsWith(".jsonl")) return "data";
  if (lower.endsWith(".log")) return "log";
  if (lower.endsWith(".txt")) return "text";
  return "file";
}

export function fileKind(f: FileMeta): FileKind {
  if (f.mimeType.startsWith("image/")) return "image";
  // Live recordings AND imported audio/video share the recording icon.
  if (isRecordingFile(f)) return "recording";
  if (f.source === "generated") return "generated";
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (["doc", "docx"].includes(ext)) return "docx";
  if (["xls", "xlsx", "ods", "csv", "tsv"].includes(ext)) return "sheet";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (["txt", "log", "eml", "srt", "vtt"].includes(ext)) return "text";
  if (["html", "htm", "svg"].includes(ext)) return "web";
  // Decks, books and notebooks now have real viewers, so they get the
  // document glyph rather than the blank "unknown file" one. There is no
  // dedicated icon for each; a document mark is closer than nothing, and the
  // ROW's label (fileKindLabel) names the format exactly.
  if (["pptx", "ppt", "epub", "ipynb"].includes(ext)) return "docx";
  return "file";
}
