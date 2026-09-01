import type {
  FileMeta,
  McpServerStatus,
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
} from "./apiTypes.js";

export interface AutomationCommands {
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
  validate_engine_model: {
    args: { engine: string; model: string };
    result: import("./apiTypes.js").ModelSelectionValidation;
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

}
