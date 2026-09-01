import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  return {
    invoke: vi.fn(),
    listen: vi.fn((event: string, listener: (value: { payload: unknown }) => void) => {
      listeners.set(event, listener);
      return Promise.resolve(vi.fn());
    }),
    listeners,
  };
});

vi.mock("./platform", () => ({ invoke: bridge.invoke, listen: bridge.listen }));

import { api } from "./api";

function expectInvokeCalls(expected: unknown[][]) {
  expect(bridge.invoke.mock.calls).toEqual(expected);
}

function dispatch(event: string, payload: unknown) {
  const listener = bridge.listeners.get(event);
  if (!listener) throw new Error(`Missing fabricated listener: ${event}`);
  listener({ payload });
}

beforeEach(() => {
  bridge.invoke.mockReset().mockResolvedValue(undefined);
  bridge.listen.mockClear();
  bridge.listeners.clear();
});

describe("browser and story API wrappers through a fabricated invoke boundary", () => {
  it("forwards browser controls, data reads, and imports without creating a browser", async () => {
    await Promise.all([
      api.browserNavigate("https://fake.test"),
      api.browserNewTab(""),
      api.browserSelectTab("tab-1"),
      api.browserCloseTab("tab-2"),
      api.browserTabs(),
      api.browserSetBounds(4, 8, 640, 480),
      api.browserInfo(),
      api.browserGo("reload"),
      api.browserSetTakeover(true),
      api.browserJournal(),
      api.browserJournal(25),
      api.browserClearJournal(),
      api.browserClearScope(),
      api.browserVerifyPrivate(),
      api.browserRetryProtection(),
      api.browserPageText("full", 120),
      api.browserPageSelection(),
      api.browserFocusApp(),
      api.browserSearch("fabricated query"),
      api.browserPreview(["https://one.test", "https://two.test"]),
      api.browserPeek("https://one.test"),
      api.browserSearchSummary("summarize fabricated results"),
      api.importSearchResult("https://one.test", "Fake result"),
      api.browserSavePage("selection"),
      api.startDownloadJob("https://media.test", "media"),
    ]);

    expectInvokeCalls([
      ["browser_navigate", { url: "https://fake.test" }],
      ["browser_new_tab", { url: "" }],
      ["browser_select_tab", { id: "tab-1" }],
      ["browser_close_tab", { id: "tab-2" }],
      ["browser_tabs"],
      ["browser_set_bounds", { x: 4, y: 8, width: 640, height: 480 }],
      ["browser_info"],
      ["browser_go", { action: "reload" }],
      ["browser_set_takeover", { on: true }],
      ["browser_journal", { limit: undefined }],
      ["browser_journal", { limit: 25 }],
      ["browser_clear_journal"],
      ["browser_clear_scope"],
      ["browser_verify_private"],
      ["browser_retry_protection"],
      ["browser_page_text", { mode: "full", offset: 120 }],
      ["browser_page_selection"],
      ["browser_focus_app"],
      ["browser_search", { query: "fabricated query" }],
      ["browser_preview", { urls: ["https://one.test", "https://two.test"] }],
      ["browser_peek", { url: "https://one.test" }],
      ["browser_search_summary", { query: "summarize fabricated results" }],
      ["import_search_result", { url: "https://one.test", title: "Fake result" }],
      ["browser_save_page", { what: "selection" }],
      ["start_download_job", { url: "https://media.test", engine: "media" }],
    ]);
  });

  it("preserves story/create payloads, null choices, and default continuity without requesting a model", async () => {
    const create = {
      prompt: "A fabricated landscape",
      model: "fake/image-model",
      kind: "image" as const,
      variations: 2,
      seconds: null,
      resolution: "1024x1024",
      aspectRatio: "1:1",
      referenceFileIds: ["file-1"],
      frameFileId: null,
      referencesAck: true,
      shotId: "shot-1",
    };
    const shot = {
      id: "shot-1",
      action: "A fabricated action",
      castIds: ["cast-1"],
      seconds: 8,
      imageModel: "fake/image-model",
      videoModel: "fake/video-model",
    };
    const split = {
      listId: "list-1",
      shots: [],
      imageModel: "fake/image-model",
      videoModel: "fake/video-model",
    };

    await Promise.all([
      api.listCreateModels(),
      api.startCreateJob(create),
      api.storyFilmPlan("list-1", "video"),
      api.storyFilmPlan("list-1", "image", false),
      api.startShotListJob("list-1", "video"),
      api.startShotListJob("list-1", "image", false),
      api.storyPictures(),
      api.storyDocuments(),
      api.storyTextFromFile("file-1"),
      api.storyReadCastFile("file-2"),
      api.storyAddCastMany([]),
      api.storyBoard(),
      api.storyBoard("list-1"),
      api.storyAddCast("Ada", "Fabricated scientist", "A fake biography"),
      api.storyUpdateCast("cast-1", "Ada", "Updated", "Updated biography"),
      api.storySetFace("cast-1", null),
      api.storyRemoveCast("cast-1"),
      api.storyCreateList("Fake list", "A fake logline"),
      api.storyUpdateList("list-1", "Updated list", "Updated logline"),
      api.storySetShape({ id: "list-1", aspectRatio: "16:9", stillResolution: "1024", clipResolution: "1080p" }),
      api.storyDeleteList("list-1"),
      api.storyAddShot("list-1", "Open on a fabricated scene"),
      api.storyUpdateShot(shot),
      api.storyRemoveShot("shot-1"),
      api.storyReorderShots("list-1", ["shot-2", "shot-1"]),
      api.storyPlanSplit("Fabricated script", 3, 12),
      api.storyApplySplit(split),
    ]);

    expectInvokeCalls([
      ["list_create_models"], ["start_create_job", create],
      ["story_film_plan", { listId: "list-1", kind: "video", continuous: true }],
      ["story_film_plan", { listId: "list-1", kind: "image", continuous: false }],
      ["start_shot_list_job", { listId: "list-1", kind: "video", continuous: true }],
      ["start_shot_list_job", { listId: "list-1", kind: "image", continuous: false }],
      ["story_pictures"], ["story_documents"], ["story_text_from_file", { fileId: "file-1" }],
      ["story_read_cast_file", { fileId: "file-2" }], ["story_add_cast_many", { members: [] }],
      ["story_board", { listId: null }], ["story_board", { listId: "list-1" }],
      ["story_add_cast", { name: "Ada", description: "Fabricated scientist", story: "A fake biography" }],
      ["story_update_cast", { id: "cast-1", name: "Ada", description: "Updated", story: "Updated biography" }],
      ["story_set_face", { id: "cast-1", fileId: null }], ["story_remove_cast", { id: "cast-1" }],
      ["story_create_list", { title: "Fake list", logline: "A fake logline" }],
      ["story_update_list", { id: "list-1", title: "Updated list", logline: "Updated logline" }],
      ["story_set_shape", { id: "list-1", aspectRatio: "16:9", stillResolution: "1024", clipResolution: "1080p" }],
      ["story_delete_list", { id: "list-1" }], ["story_add_shot", { listId: "list-1", action: "Open on a fabricated scene" }],
      ["story_update_shot", shot], ["story_remove_shot", { id: "shot-1" }],
      ["story_reorder_shots", { listId: "list-1", ids: ["shot-2", "shot-1"] }],
      ["story_plan_split", { script: "Fabricated script", minutes: 3, secondsEach: 12 }],
      ["story_apply_split", split],
    ]);
  });
});

describe("MCP, workflow, and script API wrappers through fabricated platform calls", () => {
  it("forwards connector permissions and parses only the fake JSON returned by invoke", async () => {
    bridge.invoke.mockImplementation((command: string) => Promise.resolve({
      get_mcp_connector_powers: '{"calendar":{"auto_approve":true}}',
      set_mcp_connector_power: '{"calendar":{"outbound_unmask":false}}',
      mcp_get_tool_prefs: '{"calendar":["delete"]}',
      mcp_set_tool_enabled: '{"calendar":[]}',
    }[command]));

    const [powers, updatedPowers, prefs, updatedPrefs] = await Promise.all([
      api.mcpGetConnectorPowers(),
      api.mcpSetConnectorPower("calendar", "outbound_unmask", null),
      api.mcpGetToolPrefs(),
      api.mcpSetToolEnabled("calendar", "delete", true),
    ]);
    expect(powers).toEqual({ calendar: { auto_approve: true } });
    expect(updatedPowers).toEqual({ calendar: { outbound_unmask: false } });
    expect(prefs).toEqual({ calendar: ["delete"] });
    expect(updatedPrefs).toEqual({ calendar: [] });

    await Promise.all([
      api.setSetting("fake_setting", "on"),
      api.mcpGetConfig(), api.mcpApplyConfig('{"servers":[]}'), api.mcpStatus(), api.approveMcp("fingerprint-1"),
      api.resolveMcpCall("call-1", "always"), api.getMcpAutoApprove(), api.setMcpAutoApprove(true),
      api.getMcpOutboundUnmask(), api.setMcpOutboundUnmask(false), api.mcpRegistrySearch("calendar", 9),
      api.mcpRuntimeForCommand("uvx"), api.mcpProvisionRuntime("uv"), api.mcpRegistryOptinStatus(),
      api.setMcpRegistryOptin(true), api.mcpOauthAuthorize("calendar"), api.mcpOauthStatus("calendar"),
      api.mcpOauthSignOut("calendar"), api.mcpSetServerEnabled("calendar", false), api.mcpRemoveServer("calendar"),
      api.resolveEditApproval("edit-1", "turn"),
    ]);

    expectInvokeCalls([
      ["get_mcp_connector_powers"],
      ["set_mcp_connector_power", { server: "calendar", power: "outbound_unmask", value: null }],
      ["mcp_get_tool_prefs"], ["mcp_set_tool_enabled", { server: "calendar", tool: "delete", enabled: true }],
      ["set_setting", { key: "fake_setting", value: "on" }], ["mcp_get_config"],
      ["mcp_apply_config", { json: '{"servers":[]}' }], ["mcp_status"], ["approve_mcp", { fingerprint: "fingerprint-1" }],
      ["resolve_mcp_call", { id: "call-1", decision: "always" }], ["get_mcp_auto_approve"],
      ["set_mcp_auto_approve", { on: true }], ["get_mcp_outbound_unmask"], ["set_mcp_outbound_unmask", { on: false }],
      ["mcp_registry_search", { query: "calendar", limit: 9 }], ["mcp_runtime_for_command", { command: "uvx" }],
      ["mcp_provision_runtime", { kind: "uv" }], ["mcp_registry_optin_status"], ["set_mcp_registry_optin", { enabled: true }],
      ["mcp_oauth_authorize", { server: "calendar" }], ["mcp_oauth_status", { server: "calendar" }],
      ["mcp_oauth_sign_out", { server: "calendar" }], ["mcp_set_server_enabled", { server: "calendar", enabled: false }],
      ["mcp_remove_server", { server: "calendar" }], ["resolve_edit_approval", { id: "edit-1", decision: "turn" }],
    ]);
  });

  it("forwards workflow, job, podcast, and script contracts without running them", async () => {
    const schedule = { kind: "daily", param: "09:00", enabled: true, catchUp: false };
    const save = { name: "Fake workflow", description: "Fake", emoji: "🧪", definition: { nodes: [] }, binding: { scope: "general" }, schedule };
    const update = { id: "workflow-1", name: "Renamed", definition: { nodes: ["fake"] }, schedule: { kind: "" } };

    await Promise.all([
      api.importLink("https://fake.test/source"), api.listJobs(), api.startDeepSummary(),
      api.startStudioJob("podcast", "file-1", "Fabricated instructions", ["file-2"]),
      api.getPodcast("file-1"), api.setPodcastCast("file-1", []), api.previewPodcastVoice("hello", "voice", "1", "0"),
      api.startPodcastAudioJob("file-1"), api.cancelJob("job-1"), api.resumeJob("job-1"), api.deleteJob("job-1"),
      api.listWorkflows(), api.getWorkflowSchedule("workflow-1"), api.workflowTemplates(), api.saveWorkflow(save), api.updateWorkflow(update),
      api.deleteWorkflow("workflow-1"), api.setWorkflowStatus("workflow-1", "active"), api.setWorkflowPinned("workflow-1", true),
      api.setWorkflowSchedule("workflow-1", schedule), api.validateWorkflow({ nodes: [] }, { scope: "general" }), api.composeWorkflow("Fabricated workflow"),
      api.getWorkflowRuns("workflow-1"), api.getJobStepArtifact("job-1", 3), api.runWorkflow("workflow-1", "file-1"),
      api.listScripts(), api.runScript("script-file"), api.setScriptSchedule("script-file", "daily", "09:00", true), api.resolveScriptRun("script-approval", "once"),
    ]);

    expectInvokeCalls([
      ["import_link", { url: "https://fake.test/source" }], ["list_jobs"], ["start_deep_summary"],
      ["start_studio_job", { kind: "podcast", scope: "file-1", instructions: "Fabricated instructions", refs: ["file-2"] }],
      ["get_podcast", { fileId: "file-1" }], ["set_podcast_cast", { fileId: "file-1", cast: [] }],
      ["preview_podcast_voice", { text: "hello", voice: "voice", rate: "1", pitch: "0" }], ["start_podcast_audio_job", { scriptFileId: "file-1" }],
      ["cancel_job", { id: "job-1" }], ["resume_job", { id: "job-1" }], ["delete_job", { id: "job-1" }],
      ["list_workflows"], ["get_workflow_schedule", { id: "workflow-1" }], ["workflow_templates"], ["save_workflow", save], ["update_workflow", update],
      ["delete_workflow", { id: "workflow-1" }], ["set_workflow_status", { id: "workflow-1", status: "active" }], ["set_workflow_pinned", { id: "workflow-1", pinned: true }],
      ["set_workflow_schedule", { id: "workflow-1", schedule }], ["validate_workflow", { definition: { nodes: [] }, binding: { scope: "general" } }],
      ["compose_workflow", { description: "Fabricated workflow" }], ["get_workflow_runs", { id: "workflow-1" }], ["get_job_step_artifact", { jobId: "job-1", stepId: 3 }],
      ["run_workflow", { id: "workflow-1", fileId: "file-1" }], ["list_scripts"], ["run_script", { fileId: "script-file" }],
      ["set_script_schedule", { fileId: "script-file", kind: "daily", param: "09:00", enabled: true }], ["resolve_script_run", { id: "script-approval", decision: "once" }],
    ]);
  });

  it("delivers browser, runtime, and OAuth listener payloads through fabricated listeners", async () => {
    const seen: unknown[] = [];
    await Promise.all([
      api.onBrowserJournal((value) => seen.push(["journal", value])),
      api.onBrowserNavigated((value) => seen.push(["navigated", value])),
      api.onBrowserSearched((value) => seen.push(["searched", value])),
      api.onBrowserBlocked((value) => seen.push(["blocked", value])),
      api.onBrowserDownload((value) => seen.push(["download", value])),
      api.onBrowserDownloadOversize((value) => seen.push(["oversize", value])),
      api.onRuntimeProgress((value) => seen.push(["runtime", value])),
      api.onMcpOauthUrl((value) => seen.push(["oauth", value])),
    ]);

    dispatch("browser-journal", { kind: "search" });
    dispatch("browser-navigated", "https://fake.test");
    dispatch("browser-searched", { query: "fake" });
    dispatch("browser-blocked", { url: "file:///private" });
    dispatch("browser-download", { url: "https://fake.test", name: "fake.txt", ok: true });
    dispatch("browser-download-oversize", { url: "https://fake.test", name: "large.bin", bytes: 10, detail: "fabricated limit" });
    dispatch("runtime-progress", { kind: "uv", phase: "download", got: 3, total: 4 });
    dispatch("mcp-oauth-url", { server: "calendar", url: "https://oauth.fake.test" });

    expect(seen).toEqual([
      ["journal", { kind: "search" }], ["navigated", "https://fake.test"], ["searched", { query: "fake" }],
      ["blocked", { url: "file:///private" }], ["download", { url: "https://fake.test", name: "fake.txt", ok: true }],
      ["oversize", { url: "https://fake.test", name: "large.bin", bytes: 10, detail: "fabricated limit" }],
      ["runtime", { kind: "uv", phase: "download", got: 3, total: 4 }], ["oauth", { server: "calendar", url: "https://oauth.fake.test" }],
    ]);
  });
});
