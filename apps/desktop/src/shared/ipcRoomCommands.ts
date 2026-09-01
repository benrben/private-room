// Extracted from src/api.ts: every `invoke<ResultType>("cmd_name", {args})`
// call site (the `api.methodName` wrappers plus the ~19 standalone
// `export const` functions), as a byte-faithful type-level description of
// the wire contract. Entries are grouped in the SAME order as the 8 line-range
// chunks that were extracted from api.ts (chunk 1 first ... chunk 8 last) so a
// future diff against api.ts stays easy to eyeball. No renamed fields, no
// invented shapes — where a wrapper's own JS signature made an arg optional,
// the contract instead models the shape the invoke call itself actually sends.

import type {
  RoomInfo,
  ImportReport,
  FileMeta,
  FileContent,
  DecodedFileText,
  AudioPeaks,
  MediaMeta,
  QuickLookPreview,
  SlideImage,
  TrashedFile,
  BulkReport,
  FileVersion,
  Provenance,
  VersionContent,
  CheckpointMeta,
  RecentRoom,
  Memory,
  Folder,
  SearchResults,
  PrivacyStatus,
  PrivacyEntity,
  PrivacyPreview,
  BrowserTab,
  BrowserInfo,
  BrowseJournalRow,
  BrowseClearScope,
  BrowserPageText,
  BrowserPageSelection,
  BrowserSearchResult,
  ResultPreview,
  CreateCatalog,
  FilmPlan,
  ShotRunStarted,
  RoomPicture,
  RoomDocument,
  CastFromFile,
  ParsedMember,
  StoryBoard,
  CastMember,
  StoryShot,
  ShotPlan,
  PlannedShot,
  McpServerStatus,
  RuntimeStatus,
  CatalogEntry,
} from "./apiTypes.js";

export interface RoomCommands {
  // ---- chunk 1 --------------------------------------------------------
  create_room: {
    args: {
      path: string;
      password: string;
      name: string | null;
      format?: "sealed-db" | "workspace-folder";
    };
    result: RoomInfo;
  };
  convert_legacy_room: {
    args: { sourcePath: string; password: string; destinationPath: string };
    result: {
      sourcePath: string;
      destinationPath: string;
      roomId: string;
      convertedFiles: number;
      renamed: Array<{ fileId: string; originalPath: string; convertedPath: string }>;
      skipped: Array<{ fileId: string; name: string; reason: string }>;
      resumed: boolean;
    };
  };
  create_sealed_package: {
    args: { destinationPath: string; exportPassword: string | null; purpose?: string };
    result: {
      version: number;
      purpose: string;
      createdAt: string;
      roomId: string;
      fileCount: number;
      objectCount: number;
    };
  };
  inspect_sealed_package: {
    args: { packagePath: string; password: string };
    result: {
      version: number;
      purpose: string;
      createdAt: string;
      roomId: string;
      fileCount: number;
      objectCount: number;
      files: Array<{
        fileId: string;
        relativePath: string;
        sizeBytes: number;
        sha256: string;
      }>;
    };
  };
  extract_sealed_files: {
    args: {
      packagePath: string;
      password: string;
      fileIds: string[];
      destinationPath: string;
    };
    result: { destinationPath: string; fileCount: number };
  };
  import_sealed_package: {
    args: {
      packagePath: string;
      packagePassword: string;
      destinationPath: string;
      workspacePassword: string | null;
    };
    result: { destinationPath: string; roomId: string; fileCount: number; objectCount: number };
  };
  open_room: { args: { path: string; password: string }; result: RoomInfo };
  close_room: { args: Record<string, never>; result: void };
  touchid_has: { args: { path: string }; result: boolean };
  touchid_enable: { args: Record<string, never>; result: void };
  touchid_disable: { args: { path: string }; result: void };
  touchid_open: { args: { path: string }; result: RoomInfo };
  room_info: { args: Record<string, never>; result: RoomInfo | null };
  room_storage_usage: {
    args: Record<string, never>;
    result: {
      kind: "legacy" | "workspace";
      liveFileBytes: number;
      databaseBytes: number;
      privateHistoryBytes: number;
      totalOnDiskBytes: number;
    };
  };
  workspace_watcher_status: {
    args: Record<string, never>;
    result: {
      state: "starting" | "healthy" | "error";
      lastReconciledAt: string | null;
      lastError: string | null;
      polling: boolean;
    } | null;
  };
  rescan_workspace_room: {
    args: Record<string, never>;
    result: {
      state: "starting" | "healthy" | "error";
      lastReconciledAt: string | null;
      lastError: string | null;
      polling: boolean;
    };
  };
  set_workspace_watcher_polling: {
    args: { enabled: boolean };
    result: {
      state: "starting" | "healthy" | "error";
      lastReconciledAt: string | null;
      lastError: string | null;
      polling: boolean;
    };
  };
  rename_room: { args: { name: string }; result: RoomInfo };
  register_workspace_copy: { args: Record<string, never>; result: RoomInfo };
  take_pending_open: { args: Record<string, never>; result: string | null };
  take_rec_recovery_error: { args: Record<string, never>; result: string | null };
  import_files: { args: { paths: string[] }; result: ImportReport };
  list_files: { args: Record<string, never>; result: FileMeta[] };
  get_file_content: { args: { id: string }; result: FileContent };
  decode_file_text: { args: { id: string; encoding: string | null }; result: DecodedFileText };
  audio_peaks: { args: { id: string; buckets: number | null }; result: AudioPeaks };
  probe_video_meta: { args: { id: string }; result: MediaMeta | null };
  video_trim: { args: { id: string; startSecs: number; endSecs: number }; result: FileMeta };
  save_video_frame: { args: { id: string; pngB64: string; atSecs: number }; result: FileMeta };
  quicklook_preview: { args: { id: string }; result: QuickLookPreview | null };
  slide_preview: { args: { id: string; index: number }; result: SlideImage | null };
  office_html: { args: { id: string }; result: string | null };
  update_file_content: { args: { id: string; content: string }; result: FileMeta };
  update_docx_text: { args: { id: string; content: string }; result: FileMeta };
  set_cell: { args: { id: string; sheet: string | null; cell: string; value: string }; result: void };
  trash_file: { args: { id: string }; result: void };
  list_trashed_files: { args: Record<string, never>; result: TrashedFile[] };
  restore_file: { args: { id: string }; result: FileMeta };
  set_file_in_library: { args: { id: string; linked: boolean }; result: FileMeta };
  delete_file_permanently: { args: { id: string }; result: void };
  empty_trash: { args: Record<string, never>; result: number };
  trash_files: { args: { ids: string[] }; result: BulkReport };
  move_files_to_folder: { args: { fileIds: string[]; folderId: string | null }; result: BulkReport };
  restore_files: { args: { ids: string[] }; result: BulkReport };
  delete_files_permanently: { args: { ids: string[] }; result: BulkReport };
  list_file_versions: { args: { id: string }; result: FileVersion[] };
  get_file_provenance: { args: { id: string }; result: Provenance | null };

  // ---- chunk 2 --------------------------------------------------------
  restore_file_version: { args: { versionId: string }; result: void };
  file_versions_kept: { args: Record<string, never>; result: number };
  pin_file_version: {
    args: { versionId: string; pinned: boolean };
    result: void;
  };
  delete_file_version: { args: { versionId: string }; result: void };
  get_file_version: { args: { versionId: string }; result: VersionContent };
  create_room_checkpoint: { args: { name: string }; result: CheckpointMeta };
  list_room_checkpoints: {
    args: Record<string, never>;
    result: { entries: CheckpointMeta[]; totalBytes: number };
  };
  delete_room_checkpoint: { args: { id: string }; result: void };
  rollback_room_checkpoint: { args: { id: string }; result: RoomInfo };
  list_stranded_checkpoints: {
    args: Record<string, never>;
    result: string[];
  };
  export_file: { args: { id: string; destPath: string }; result: void };
  export_all: { args: { destDir: string }; result: number };
  change_password: {
    args: { current: string; newPassword: string };
    result: string | null;
  };
  duplicate_room: {
    args: { destPath: string; newPassword: string | null };
    result: void;
  };
  compact_room: { args: Record<string, never>; result: string };
  list_recent: { args: Record<string, never>; result: RecentRoom[] };
  remove_recent: { args: { path: string }; result: void };
  clear_recent: { args: Record<string, never>; result: void };
  trash_room: { args: { path: string }; result: void };
  save_generated_file: {
    args: { name: string; content: string };
    result: FileMeta;
  };
  open_html_in_browser: {
    args: { name: string; html: string };
    result: string;
  };
  stage_preview_html: { args: { html: string }; result: string };
  add_memory: {
    args: { content: string; category: string | null };
    result: Memory;
  };
  list_memories: { args: Record<string, never>; result: Memory[] };
  delete_memory: { args: { id: string }; result: void };
  update_memory: {
    args: { id: string; content: string; category: string | null };
    result: void;
  };
  open_scratch_pad: { args: Record<string, never>; result: FileMeta };
  list_folders: { args: Record<string, never>; result: Folder[] };
  create_folder: { args: { name: string }; result: Folder };
  rename_folder: { args: { id: string; name: string }; result: void };
  delete_folder: { args: { id: string }; result: void };
  rename_file: { args: { id: string; name: string }; result: void };
  move_file_to_folder: {
    args: { fileId: string; folderId: string | null };
    result: void;
  };
  search_all: { args: { query: string }; result: SearchResults };
  get_setting: { args: { key: string }; result: string | null };
  privacy_status: { args: Record<string, never>; result: PrivacyStatus };
  set_privacy_room: {
    args: { mode: "on" | "off" | "default" };
    result: void;
  };
  set_privacy_global: { args: { on: boolean }; result: void };

  // ---- chunk 3 --------------------------------------------------------
  add_privacy_block: { args: { text: string; category: string }; result: PrivacyEntity };
  remove_privacy_entity: { args: { id: string }; result: void };
  set_privacy_concepts: { args: { concepts: string[] }; result: void };
  privacy_preview: { args: { fileId: string }; result: PrivacyPreview };
  start_privacy_scan: { args: Record<string, never>; result: void };
  web_search_test: { args: Record<string, never>; result: string };

  browser_navigate: { args: { url: string }; result: string };
  browser_new_tab: { args: { url: string }; result: string };
  browser_select_tab: { args: { id: string }; result: void };
  browser_close_tab: { args: { id: string }; result: void };
  browser_tabs: { args: Record<string, never>; result: BrowserTab[] };
  browser_set_bounds: { args: { x: number; y: number; width: number; height: number }; result: void };
  browser_info: { args: Record<string, never>; result: BrowserInfo };
  browser_go: { args: { action: "back" | "forward" | "reload" | "stop" }; result: void };
  browser_set_takeover: { args: { on: boolean }; result: void };
  browser_journal: { args: { limit?: number }; result: BrowseJournalRow[] };
  browser_clear_journal: { args: Record<string, never>; result: void };
  browser_clear_scope: { args: Record<string, never>; result: BrowseClearScope };
  browser_verify_private: { args: Record<string, never>; result: boolean };
  browser_retry_protection: { args: Record<string, never>; result: void };
  browser_page_text: { args: { mode: "main" | "full"; offset: number }; result: BrowserPageText };
  browser_page_selection: { args: Record<string, never>; result: BrowserPageSelection };
  browser_focus_app: { args: Record<string, never>; result: void };
  browser_search: { args: { query: string }; result: BrowserSearchResult };
  browser_preview: { args: { urls: string[] }; result: ResultPreview[] };
  browser_peek: { args: { url: string }; result: string };
  browser_search_summary: { args: { query: string }; result: string };
  import_search_result: { args: { url: string; title: string }; result: FileMeta };
  browser_save_page: { args: { what: "page" | "selection" }; result: string };
  start_download_job: { args: { url: string; engine: "fetch" | "media" }; result: string };

  list_create_models: { args: Record<string, never>; result: CreateCatalog };
  start_create_job: {
    args: {
      prompt: string;
      model: string;
      kind: "image" | "video";
      variations?: number;
      seconds?: number | null;
      resolution?: string;
      aspectRatio?: string;
      referenceFileIds?: string[];
      frameFileId?: string | null;
      referencesAck?: boolean;
      shotId?: string | null;
    };
    result: string;
  };
  story_film_plan: { args: { listId: string; kind: "image" | "video"; continuous: boolean }; result: FilmPlan };
  start_shot_list_job: { args: { listId: string; kind: "image" | "video"; continuous: boolean }; result: ShotRunStarted };
  story_pictures: { args: Record<string, never>; result: RoomPicture[] };
  story_documents: { args: Record<string, never>; result: RoomDocument[] };
  story_text_from_file: { args: { fileId: string }; result: string };

  // ---- chunk 4 --------------------------------------------------------
  story_read_cast_file: { args: { fileId: string }; result: CastFromFile };
  story_add_cast_many: { args: { members: ParsedMember[] }; result: number };
  story_board: { args: { listId: string | null }; result: StoryBoard };
  story_add_cast: {
    args: { name: string; description: string; story: string };
    result: CastMember;
  };
  story_update_cast: {
    args: { id: string; name: string; description: string; story: string };
    result: void;
  };
  story_set_face: { args: { id: string; fileId: string | null }; result: void };
  story_remove_cast: { args: { id: string }; result: void };
  story_create_list: { args: { title: string; logline: string }; result: string };
  story_update_list: {
    args: { id: string; title: string; logline: string };
    result: void;
  };
  story_set_shape: {
    args: {
      id: string;
      aspectRatio: string;
      stillResolution: string;
      clipResolution: string;
    };
    result: void;
  };
  story_delete_list: { args: { id: string }; result: void };
  story_add_shot: { args: { listId: string; action: string }; result: StoryShot };
  story_update_shot: {
    args: {
      id: string;
      action: string;
      castIds: string[];
      seconds: number | null;
      imageModel: string;
      videoModel: string;
    };
    result: void;
  };
  story_remove_shot: { args: { id: string }; result: void };
  story_reorder_shots: { args: { listId: string; ids: string[] }; result: void };
  story_plan_split: {
    args: { script: string; minutes: number; secondsEach: number };
    result: ShotPlan;
  };
  story_apply_split: {
    args: {
      listId: string;
      shots: PlannedShot[];
      imageModel: string;
      videoModel: string;
    };
    result: number;
  };
  set_setting: { args: { key: string; value: string }; result: void };
  mcp_get_config: { args: Record<string, never>; result: string };
  mcp_apply_config: { args: { json: string }; result: McpServerStatus[] };
  mcp_status: { args: Record<string, never>; result: McpServerStatus[] };
  approve_mcp: { args: { fingerprint: string }; result: McpServerStatus[] };
  resolve_mcp_call: {
    args: { id: string; decision: "once" | "always" | "deny" };
    result: void;
  };
  get_mcp_auto_approve: { args: Record<string, never>; result: boolean };
  set_mcp_auto_approve: { args: { on: boolean }; result: void };
  get_mcp_outbound_unmask: { args: Record<string, never>; result: boolean };
  set_mcp_outbound_unmask: { args: { on: boolean }; result: void };
  get_mcp_connector_powers: { args: Record<string, never>; result: string };
  set_mcp_connector_power: {
    args: {
      server: string;
      power: "auto_approve" | "outbound_unmask";
      value: boolean | null;
    };
    result: string;
  };
  mcp_registry_search: {
    args: { query?: string; limit?: number };
    result: CatalogEntry[];
  };
  mcp_runtime_for_command: { args: { command: string }; result: RuntimeStatus };
  mcp_provision_runtime: { args: { kind: string }; result: void };
  mcp_registry_optin_status: { args: Record<string, never>; result: boolean };
  set_mcp_registry_optin: { args: { enabled: boolean }; result: void };
  mcp_oauth_authorize: { args: { server: string }; result: McpServerStatus[] };
  mcp_oauth_status: { args: { server: string }; result: boolean };
  mcp_oauth_sign_out: { args: { server: string }; result: McpServerStatus[] };

}
