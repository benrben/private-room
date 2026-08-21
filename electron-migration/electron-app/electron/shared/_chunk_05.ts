import type {
  McpServerStatus,
  FileMeta,
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
} from "./apiTypes.js";

export type Chunk5 = {
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
};

// extracted: mcp_set_server_enabled, mcp_remove_server, mcp_get_tool_prefs, mcp_set_tool_enabled, resolve_edit_approval, import_link, list_jobs, start_deep_summary, start_studio_job, get_podcast, set_podcast_cast, preview_podcast_voice, start_podcast_audio_job, cancel_job, resume_job, delete_job, list_workflows, get_workflow_schedule, workflow_templates, save_workflow, update_workflow, delete_workflow, set_workflow_status, set_workflow_pinned, set_workflow_schedule, validate_workflow, compose_workflow, get_workflow_runs, get_job_step_artifact, run_workflow, list_scripts, run_script, set_script_schedule, resolve_script_run, list_skills, get_skill, create_skill
