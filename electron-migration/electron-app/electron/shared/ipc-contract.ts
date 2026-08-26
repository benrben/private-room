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
  Job,
  Podcast,
  PodcastHost,
  Workflow,
  Schedule,
  ScheduleArg,
  WorkflowTemplate,
  WorkflowRun,
  ScriptInfo,
  SkillSummary,
  SkillBundle,
  SkillResourceContent,
  AiStatus,
  ModelCaps,
  EngineCapabilities,
  Capability,
  EnginePreflight,
  SupportMatrix,
  ExternalModelInfo,
  AiProviderStatus,
  Chat,
  Message,
  StopReport,
  ChatCommand,
  Specialist,
  ImageBox,
  SttStatus,
  DictSessionInfo,
  NeuralVoiceInfo,
  AiActionDef,
  RecStart,
  RecMeta,
  RecLive,
  RecFile,
  NoteKind,
  SavedVoice,
  FeedbackDraft,
  AppDiag,
  ViewMenuState,
  MediaQualityOption,
  RecommendedModels,
  RoomGraph,
  FrontPage,
  StudioPrompts,
  MemorySuggestion,
  FileMetaSuggestion,
  RoomServerStatus,
  RoomRole,
} from "./apiTypes.js";
import type { ApprovalDecision, PrivacyMode } from "./harnessTypes.js";

export interface Commands {
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
    };
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

  // ---- chunk 5 --------------------------------------------------------
  mcp_set_server_enabled: {
    args: { server: string; enabled: boolean };
    result: McpServerStatus[];
  };
  mcp_remove_server: {
    args: { server: string };
    result: McpServerStatus[];
  };
  mcp_get_tool_prefs: {
    args: Record<string, never>;
    result: string;
  };
  mcp_set_tool_enabled: {
    args: { server: string; tool: string; enabled: boolean };
    result: string;
  };
  resolve_edit_approval: {
    args: { id: string; decision: "once" | "turn" | "deny" };
    result: void;
  };
  import_link: {
    args: { url: string };
    result: FileMeta;
  };
  list_jobs: {
    args: Record<string, never>;
    result: Job[];
  };
  start_deep_summary: {
    args: Record<string, never>;
    result: string;
  };
  start_studio_job: {
    args: {
      kind: "flashcards" | "mindmap" | "podcast";
      scope?: string;
      instructions?: string;
      refs?: string[];
    };
    result: string;
  };
  get_podcast: {
    args: { fileId: string };
    result: Podcast | null;
  };
  set_podcast_cast: {
    args: { fileId: string; cast: PodcastHost[] };
    result: Podcast;
  };
  preview_podcast_voice: {
    args: { text: string; voice: string; rate: string; pitch: string };
    result: string;
  };
  start_podcast_audio_job: {
    args: { scriptFileId: string };
    result: string;
  };
  cancel_job: {
    args: { id: string };
    result: void;
  };
  resume_job: {
    args: { id: string };
    result: void;
  };
  delete_job: {
    args: { id: string };
    result: void;
  };
  list_workflows: {
    args: Record<string, never>;
    result: Workflow[];
  };
  get_workflow_schedule: {
    args: { id: string };
    result: Schedule | null;
  };
  workflow_templates: {
    args: Record<string, never>;
    result: WorkflowTemplate[];
  };
  save_workflow: {
    args: {
      name: string;
      description?: string;
      emoji?: string;
      definition: unknown;
      binding?: unknown;
      createdBy?: string;
      schedule?: ScheduleArg;
    };
    result: string;
  };
  update_workflow: {
    args: {
      id: string;
      name?: string;
      description?: string;
      emoji?: string;
      definition?: unknown;
      binding?: unknown;
      schedule?: ScheduleArg;
    };
    result: void;
  };
  delete_workflow: {
    args: { id: string };
    result: void;
  };
  set_workflow_status: {
    args: { id: string; status: "active" | "draft" };
    result: void;
  };
  set_workflow_pinned: {
    args: { id: string; pinned: boolean };
    result: void;
  };
  set_workflow_schedule: {
    args: { id: string; schedule: ScheduleArg };
    result: void;
  };
  validate_workflow: {
    args: { definition: unknown; binding?: unknown };
    result: string[];
  };
  compose_workflow: {
    args: { description: string };
    result: string;
  };
  get_workflow_runs: {
    args: { id: string };
    result: WorkflowRun[];
  };
  get_job_step_artifact: {
    args: { jobId: string; stepId: number };
    result: string | null;
  };
  run_workflow: {
    args: { id: string; fileId?: string };
    result: string;
  };
  list_scripts: {
    args: Record<string, never>;
    result: ScriptInfo[];
  };
  run_script: {
    args: { fileId: string };
    result: string;
  };
  set_script_schedule: {
    args: {
      fileId: string;
      kind: string;
      param: string;
      enabled: boolean;
    };
    result: void;
  };
  resolve_script_run: {
    args: { id: string; decision: "once" | "always" | "deny" };
    result: void;
  };
  list_skills: {
    args: Record<string, never>;
    result: SkillSummary[];
  };
  get_skill: {
    args: { id: string };
    result: SkillBundle;
  };
  create_skill: {
    args: {
      name: string;
      description: string;
      instructions: string;
      agent: string | null;
    };
    result: string;
  };

  // ---- chunk 6 --------------------------------------------------------
  update_skill: {
    args: {
      id: string;
      name: string;
      description: string;
      instructions: string;
      agent: string | null;
    };
    result: void;
  };
  set_skill_enabled: { args: { id: string; enabled: boolean }; result: void };
  delete_skill: { args: { id: string }; result: void };
  get_skill_resource: {
    args: { skillId: string; path: string };
    result: SkillResourceContent;
  };
  save_skill_resource: {
    args: {
      skillId: string;
      path: string;
      text: string | null;
      dataB64: string | null;
    };
    result: void;
  };
  delete_skill_resource: {
    args: { skillId: string; path: string };
    result: void;
  };
  import_skill_folder: {
    args: { path: string; replace: boolean };
    result: string;
  };
  skill_import_conflict: { args: { path: string }; result: string | null };
  skill_agent_ids: { args: Record<string, never>; result: string[] };
  export_skill_folder: {
    args: { id: string; destination: string };
    result: string;
  };
  compose_skill: {
    args: { description: string; fileIds: string[] };
    result: string;
  };
  ai_status: { args: Record<string, never>; result: AiStatus };
  model_capabilities: { args: Record<string, never>; result: ModelCaps[] };
  engine_capabilities: {
    args: Record<string, never>;
    result: EngineCapabilities;
  };
  engine_preflight: {
    args: { capability: Capability };
    result: EnginePreflight;
  };
  engine_support_matrix: { args: Record<string, never>; result: SupportMatrix };
  grounding_model_for_room: {
    args: Record<string, never>;
    result: string | null;
  };
  list_engine_models: {
    args: { engine: string };
    result: ExternalModelInfo[];
  };
  list_ai_providers: { args: Record<string, never>; result: AiProviderStatus[] };
  connect_ai_provider: {
    args: { provider: string; apiKey: string };
    result: number;
  };
  disconnect_ai_provider: { args: { provider: string }; result: void };
  warm_model: { args: Record<string, never>; result: void };
  pull_model: { args: { name: string }; result: void };
  delete_model: { args: { name: string }; result: void };
  open_ollama: { args: Record<string, never>; result: void };
  list_chats: { args: Record<string, never>; result: Chat[] };
  create_chat: { args: Record<string, never>; result: Chat };
  delete_chat: { args: { id: string }; result: void };
  rename_chat: { args: { id: string; title: string }; result: void };
  get_messages: { args: { chatId: string }; result: Message[] };
  delete_message: { args: { id: string }; result: void };
  ask: {
    args: {
      chatId: string;
      question: string;
      attachments: string[];
      askId: string;
      viewing: string | null;
      privacyBypass: boolean | null;
    };
    result: Message;
  };
  cancel_ask: { args: { askId: string }; result: StopReport };
  handoff_chat: { args: { chatId: string }; result: Message };
  run_command: {
    args: {
      chatId: string;
      command: string;
      args: string;
      refs: string[];
      raw: string;
      askId: string;
    };
    result: Message;
  };
  list_chat_commands: { args: Record<string, never>; result: ChatCommand[] };
  list_specialists: { args: Record<string, never>; result: Specialist[] };

  // ---- chunk 7 --------------------------------------------------------
  import_image_bytes: { args: { name: string; b64: string }; result: FileMeta };
  import_audio_bytes: { args: { name: string; b64: string }; result: FileMeta };
  locate_in_image: { args: { fileId: string; query: string }; result: ImageBox[] };
  stt_status: { args: Record<string, never>; result: SttStatus };
  stt_download_model: { args: Record<string, never>; result: void };
  stt_cancel_download: { args: Record<string, never>; result: boolean };
  stt_delete_model: { args: Record<string, never>; result: void };
  retranscribe_file: { args: { fileId: string }; result: void };
  shape_text: {
    args: { text: string; translate: boolean; mode: string };
    result: string;
  };
  dict_start: { args: Record<string, never>; result: DictSessionInfo };
  dict_push_audio: { args: { rate: number; dataB64: string }; result: void };
  dict_stop: { args: Record<string, never>; result: string };
  dict_cancel: { args: Record<string, never>; result: void };
  speak_text_neural: {
    args: { text: string; voice: string | null };
    result: string;
  };
  list_neural_voices: { args: Record<string, never>; result: NeuralVoiceInfo[] };
  ai_action_prompts: { args: Record<string, never>; result: AiActionDef[] };
  ai_action: {
    args: {
      action: string;
      scope: string | null;
      refs: string[] | null;
      instructions: string | null;
      question: string | null;
      opId: string | null;
    };
    result: FileMeta;
  };
  create_sketch: { args: { name: string }; result: FileMeta };
  save_sketch: {
    args: { id: string; doc: string; snapshot: boolean };
    result: void;
  };
  export_sketch_svg: { args: { id: string }; result: FileMeta };
  export_sketch_png: { args: { id: string }; result: FileMeta };
  rec_start: {
    args: {
      fileId: string | null;
      systemAudio: boolean;
      liveTranslate: string | null;
    };
    result: RecStart;
  };
  rec_push_audio: { args: { rate: number; dataB64: string }; result: void };
  rec_pause: { args: Record<string, never>; result: void };
  rec_resume: { args: Record<string, never>; result: void };
  rec_stop: { args: Record<string, never>; result: RecMeta };
  rec_live_status: { args: Record<string, never>; result: RecLive | null };
  rec_set_live_translate: {
    args: { language: string | null };
    result: void;
  };
  rec_set_live_stt: { args: { on: boolean }; result: void };
  rec_get: { args: { id: string }; result: RecFile };
  rec_delete_range: {
    args: { id: string; t0: number; t1: number };
    result: RecMeta;
  };
  rec_correct_range: {
    args: { id: string; t0: number; t1: number; text: string };
    result: RecMeta;
  };
  rec_set_speaker_name: {
    args: { id: string; speaker: string; name: string };
    result: RecMeta;
  };
  rec_read_start: { args: { id: string }; result: string };
  rec_note_add: {
    args: { id: string; t0: number; kind: NoteKind; text: string; who?: string };
    result: RecMeta;
  };
  rec_note_set: {
    args: { id: string; noteId: string; text: string };
    result: RecMeta;
  };
  rec_chapter_add: {
    args: { id: string; t0: number; title: string };
    result: RecMeta;
  };

  // ---- chunk 8 --------------------------------------------------------
  rec_chapter_set: {
    args: { id: string; chapterId: string; title: string };
    result: RecMeta;
  };
  rec_highlight_add: {
    args: { id: string; t0: number; t1: number };
    result: RecMeta;
  };
  rec_item_delete: {
    args: { id: string; kind: "note" | "chapter" | "highlight"; itemId: string };
    result: RecMeta;
  };
  voices_list: { args: Record<string, never>; result: SavedVoice[] };
  voice_forget: { args: { name: string }; result: SavedVoice[] };
  rec_export_clean: { args: { id: string }; result: FileMeta };
  rec_translate: { args: { id: string; language: string }; result: FileMeta };
  rec_retranscribe: { args: { id: string }; result: RecMeta };
  feedback_draft: { args: { text: string }; result: FeedbackDraft };
  app_diag: { args: Record<string, never>; result: AppDiag };
  reveal_logs: { args: Record<string, never>; result: string };
  set_unsaved_edits: { args: { on: boolean }; result: void };
  quit_guard_rearm: { args: Record<string, never>; result: void };
  menu_sync: { args: { view: ViewMenuState }; result: void };
  import_media_url: {
    args: { url: string; maxHeight?: number };
    result: ImportReport;
  };
  list_media_formats: { args: { url: string }; result: MediaQualityOption[] };
  cancel_media_download: { args: Record<string, never>; result: void };
  resolve_agent_ui: { args: { id: string; payload: unknown }; result: void };
  recommended_models: { args: Record<string, never>; result: RecommendedModels };
  ensure_embed_model: { args: Record<string, never>; result: void };
  room_graph: { args: Record<string, never>; result: RoomGraph };
  front_page: { args: Record<string, never>; result: FrontPage };
  front_page_suggestions: { args: Record<string, never>; result: string[] };
  studio_prompts: { args: Record<string, never>; result: StudioPrompts };
  memory_suggestion: { args: { chatId: string }; result: MemorySuggestion };
  suggest_file_meta: { args: { fileId: string }; result: FileMetaSuggestion };
  generate_ui_text: {
    args: { kind: string; prompt: string; facts: unknown; maxWords: number };
    result: string | null;
  };
  room_server_status: { args: Record<string, never>; result: RoomServerStatus };
  set_room_server: {
    args: { enabled: boolean; allowCloud: boolean; scope: "files" | "full" };
    result: RoomServerStatus;
  };
  regenerate_leash_token: { args: Record<string, never>; result: RoomServerStatus };
  set_ollama_url: { args: { url: string }; result: void };
  test_ollama_url: { args: { url: string }; result: string };
  get_ollama_url: { args: Record<string, never>; result: string };
  list_roles: { args: Record<string, never>; result: RoomRole[] };
  write_recovery_key: { args: Record<string, never>; result: string };
  has_recovery_key: { args: { path: string }; result: boolean };
  open_room_with_recovery: { args: { path: string; code: string }; result: RoomInfo };

  // ---- the plugin surfaces (NOT from api.ts's invoke call sites) ---------
  // Everything above was extracted from an `invoke("name", …)` in api.ts.
  // These seven were not, and could not have been: under Tauri they were not
  // commands of ours at all. Six back the two Tauri PLUGINS the frontend calls
  // as plain JS imports (`@tauri-apps/plugin-dialog`,
  // `@tauri-apps/plugin-opener`), which the Electron port has to supply
  // itself; the seventh, `quit_guard_confirm`, is the one step of the quit door
  // the Tauri build answered with a third plugin (`plugin-process`'s
  // `exit(0)`). See the comment on each group below.
  //
  // SHAPES READ FROM THE REAL, INSTALLED PLUGIN SOURCE
  // (`node_modules/@tauri-apps/plugin-{dialog,opener}/dist-js/{index.js,index.d.ts}`),
  // never guessed — the field names, the defaults, and the result types below
  // all come from that reading, and `preload/index.ts` re-implements those
  // modules' own client-side functions on top of these channels so a renderer
  // port changes an import rather than a call shape.
  //
  // TWO DELIBERATE DEVIATIONS FROM THE LITERAL TAURI WIRE, both because these
  // are new channels of OURS rather than descriptions of an existing wire (the
  // header's "model the shape the invoke call actually sends" rule applies to
  // the extracted 296):
  //   1. `dialog_open`/`dialog_save` take their options FLAT, not nested under
  //      an `options` key as `invoke('plugin:dialog|open', { options })` does.
  //      Every other entry in this interface passes flat named args, and the
  //      renderer-facing `open(options)`/`save(options)` signature is identical
  //      either way.
  //   2. `dialog_message`'s `buttons` carries the plugin's own FRIENDLY union
  //      (`'YesNo'`, `{ok, cancel}`, …), not the tagged
  //      `{OkCancelCustom: [ok, cancel]}` shape its `buttonsToRust()` encodes
  //      to. That encoding exists to satisfy a Rust serde enum; re-encoding
  //      into it here only to decode it again in `dialogTools.ts` would carry a
  //      foreign engine's serialization artifact into a contract that has no
  //      Rust on either end.

  /** `plugin:dialog|open`. `null` on cancel; an array when `multiple` is set,
   * otherwise the single chosen path — mirroring `OpenDialogReturn<T>`, which
   * the caller can discriminate because it knows the args it sent.
   *
   * DROPPED from the real `OpenDialogOptions`, named rather than silently
   * omitted: `recursive`, `pickerMode` and `fileAccessMode`, each documented by
   * the plugin itself as "meant for mobile platforms (iOS and Android)". This
   * app is Mac-only and Electron's `showOpenDialog` has no counterpart for any
   * of the three. */
  dialog_open: {
    args: {
      title?: string;
      filters?: DialogFilter[];
      defaultPath?: string;
      multiple?: boolean;
      directory?: boolean;
      /** macOS room picker: allow either a workspace folder or a legacy room file. */
      room?: boolean;
      /** macOS-only in the real plugin too, and enabled by default there — so
       * only an explicit `false` turns it off. */
      canCreateDirectories?: boolean;
    };
    result: string | string[] | null;
  };
  /** `plugin:dialog|save` (`SaveDialogOptions`). `null` on cancel. */
  dialog_save: {
    args: {
      title?: string;
      filters?: DialogFilter[];
      defaultPath?: string;
      canCreateDirectories?: boolean;
    };
    result: string | null;
  };
  /** `plugin:dialog|message` — the ONE command behind the plugin's three JS
   * functions. `message`/`ask`/`confirm` are client-side sugar over it in the
   * real plugin (`index.js`'s `messageCommand`), and are client-side sugar over
   * it in `preload/index.ts` too, for the same reason: the difference between
   * them is which buttons they ask for and which answer counts as yes, not
   * which dialog is shown.
   *
   * `okLabel` is deliberately absent from `MessageDialogOptions` here: the real
   * plugin's own type marks it `@deprecated Use buttons instead` and folds it
   * into `buttons` before the command is ever called. A contract with no
   * back-compat callers starts at the recommended shape. */
  dialog_message: {
    args: {
      message: string;
      title?: string;
      kind?: MessageDialogKind;
      buttons?: MessageDialogButtons;
    };
    result: MessageDialogResult;
  };

  /** `plugin:opener|open_url`. The wire field really is named `with` (the JS
   * wrapper's `openWith` parameter is sent as `{ url, with: openWith }`), so it
   * is named `with` here. */
  open_url: { args: { url: string; with?: string }; result: void };
  /** `plugin:opener|open_path`, same `with` convention. */
  open_path: { args: { path: string; with?: string }; result: void };
  /** `plugin:opener|reveal_item_in_dir`. The plugin's JS wrapper normalizes its
   * `string | string[]` parameter into `{ paths }` before invoking; these args
   * are that already-normalized shape rather than the union the wrapper exists
   * to remove. */
  reveal_item_in_dir: { args: { paths: string[] }; result: void };

  /** THE QUIT DOOR'S THIRD ANSWER — "the user was asked about unsaved edits and
   * said go ahead; finish the quit now."
   *
   * `set_unsaved_edits` arms the door and `quit_guard_rearm` cancels a held
   * quit; until this channel there was no way to COMPLETE one. The Tauri build
   * did not need a command for it because the frontend could call
   * `@tauri-apps/plugin-process`'s bare `exit(0)`; an isolated Electron
   * renderer has no equivalent, so without this the user answering "Quit and
   * discard" left the app running until they pressed ⌘Q a second time.
   * See `quitDoor.ts`'s `confirmQuit` and `main/index.ts`'s host bridge. */
  quit_guard_confirm: { args: Record<string, never>; result: void };

  // ---- Electron host/update surface -----------------------------------
  /** The installed app version, supplied by Electron's `app.getVersion()`. */
  app_version: { args: Record<string, never>; result: string };
  /** Check the Tauri-compatible signed update feed without downloading. */
  updater_check: {
    args: Record<string, never>;
    result: { version: string; notes?: string } | null;
  };
  /** Download, verify, install and relaunch the update found by the feed. */
  updater_install: { args: Record<string, never>; result: void };

  // ---- unified provider-neutral agent harness ------------------------
  harness_capabilities: {
    args: Record<string, never>;
    result: {
      flags: Record<string, boolean>;
      roomFormat: "workspace-folder" | "sealed-db" | null;
      outsideWorkspaceIsolation: boolean;
      providers: Record<string, { enabled: boolean; installed: boolean; reason: string | null }>;
    };
  };
  harness_start: {
    args: {
      provider: "codex" | "claude";
      model: string;
      privacyMode: PrivacyMode;
      writeEnabled: boolean;
      text: string;
      threadId?: string;
      systemPrompt?: string;
    };
    result: { runId: string };
  };
  harness_approve: {
    args: { runId: string; requestId: string; decision: ApprovalDecision };
    result: void;
  };
  harness_cancel: { args: { runId: string }; result: void };
  harness_cloud_writeback: { args: { runId: string; approved: boolean }; result: void };
  harness_rollback: {
    args: { runId: string };
    result: { restored: string[]; removedCreated: string[]; conflicts: string[] };
  };
  harness_restore_baseline_copies: {
    args: { runId: string; relativePaths: string[] };
    result: string[];
  };
}

// merged: 291 commands total (chunk 1: 37, chunk 2: 36, chunk 3: 36,
// chunk 4: 36, chunk 5: 36, chunk 6: 37, chunk 7: 37, chunk 8: 36).
// No command-name collisions were found across the 8 chunks (each of the
// 8 line-range extractions was disjoint and every top-level key across all
// chunks appears exactly once).
// (That count is of the api.ts extraction only, and predates later additions
// to this file; `channelAllowlist.ts`'s `ALL_COMMAND_NAMES.length` is the one
// number anything should ever compute from.)

// ============================================================================
// The dialog plugin's own option/result types
// ============================================================================
// Declared here rather than in `apiTypes.ts` because they belong to this
// contract, not to api.ts's type surface: the frontend imports them from
// `@tauri-apps/plugin-dialog` today, and will import them from the renderer's
// own bridge module after the cutover. Each mirrors the real plugin type of the
// same name.

/** `DialogFilter`. */
export interface DialogFilter {
  name: string;
  extensions: string[];
}

/** `MessageDialogOptions['kind']` — `'info'` when unset, per the plugin. */
export type MessageDialogKind = "info" | "warning" | "error";

/** `MessageDialogDefaultButtons`. */
export type MessageDialogDefaultButtons = "Ok" | "OkCancel" | "YesNo" | "YesNoCancel";

/** `MessageDialogCustomButtons` — the three custom shapes, kept as a union so
 * an object with, say, `yes` but no `cancel` cannot be passed. */
export type MessageDialogCustomButtons =
  | { ok: string }
  | { ok: string; cancel: string }
  | { yes: string; no: string; cancel: string };

/** `MessageDialogButtons`. */
export type MessageDialogButtons = MessageDialogDefaultButtons | MessageDialogCustomButtons;

/** `MessageDialogResult` — `'Yes' | 'No' | 'Ok' | 'Cancel' | (string & {})`:
 * one of the four named answers for a preset button set, or the clicked
 * button's own label for a custom one. Written with
 * `Record<never, never>` rather than the plugin's `{}` because this repo's lint
 * rules reject the bare `{}` type; the two mean the same thing here — "a string
 * that keeps its literal type in a union". */
export type MessageDialogResult = "Yes" | "No" | "Ok" | "Cancel" | (string & Record<never, never>);
