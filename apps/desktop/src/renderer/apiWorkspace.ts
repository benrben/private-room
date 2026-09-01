import { invoke } from "./platform";
import type { CreateCatalog, RoomInfo, ImportReport, FileMeta, TrashedFile, BulkReport, FileContent, DecodedFileText, AudioPeaks, MediaMeta, QuickLookPreview, SlideImage, BrowserInfo, BrowserPageSelection, BrowserPageText, BrowserSearchResult, ResultPreview, BrowseClearScope, BrowseJournalRow, FileVersion, Provenance, VersionContent, CheckpointMeta, RecentRoom, Memory, Folder, SearchResults, PrivacyEntity, PrivacyPreview, PrivacyStatus, BrowserTab, HarnessApprovalDecision, HarnessCapabilities, HarnessPrivacyMode, HarnessProvider, HarnessRollbackResult, HarnessHistoryRun } from "./apiTypes";
import type { RoomStorageUsage, SealedPackageInspection, WorkspaceWatcherStatus } from "./api";

export const apiWorkspace = {
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
  inspectSealedPackage: (packagePath: string, password: string) =>
    invoke<SealedPackageInspection>("inspect_sealed_package", { packagePath, password }),
  extractSealedFiles: (
    packagePath: string,
    password: string,
    fileIds: string[],
    destinationPath: string,
  ) => invoke<{ destinationPath: string; fileCount: number }>(
    "extract_sealed_files",
    { packagePath, password, fileIds, destinationPath },
  ),
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
};
