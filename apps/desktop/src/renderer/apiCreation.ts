import { invoke, listen, type UnlistenFn } from "./platform";
import type { CastMember, RoomPicture, PlannedShot, ShotPlan, FilmPlan, ShotRunStarted, RoomDocument, ParsedMember, CastFromFile, StoryBoard, StoryShot, FileMeta, Podcast, PodcastHost, Job, Workflow, WorkflowRun, Schedule, ScheduleArg, WorkflowTemplate, ScriptInfo, SkillSummary, SkillBundle, SkillResourceContent, BrowserSearchResult, BrowseJournalRow, McpServerStatus, ConnectorPowers, CatalogEntry, RuntimeStatus } from "./apiTypes";

export const apiCreation = {
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
};
