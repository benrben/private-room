import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("./platform", () => bridge);

import {
  api,
  ensureEmbedModel,
  frontPage,
  frontPageSuggestions,
  generateUiText,
  getOllamaUrl,
  hasRecoveryKey,
  listRoles,
  memorySuggestion,
  openRoomWithRecovery,
  recommendedModels,
  regenerateLeashToken,
  roomGraph,
  roomServerStatus,
  setOllamaUrl,
  setRoomServer,
  studioPrompts,
  suggestFileMeta,
  testOllamaUrl,
  writeRecoveryKey,
} from "./api";

type Listener = (event: { payload: unknown }) => void;

const listeners = new Map<string, Listener>();
const unlisten = vi.fn();

beforeEach(() => {
  listeners.clear();
  unlisten.mockReset();
  bridge.invoke.mockReset().mockResolvedValue(undefined);
  bridge.listen.mockReset().mockImplementation((channel: string, callback: Listener) => {
    listeners.set(channel, callback);
    return Promise.resolve(unlisten);
  });
});

describe("tail API IPC wrappers", () => {
  it("forwards fabricated feedback, diagnostics, quit, and menu payloads", async () => {
    const view = {
      enabled: true,
      library: true,
      assistant: false,
      focus: false,
      railLabels: true,
      railLabelsSettable: true,
      sidebar: "Fabricated library",
    };

    await Promise.all([
      api.feedbackDraft("Fabricated feedback"),
      api.appDiag(),
      api.revealLogs(),
      api.setUnsavedEdits(true),
      api.quitGuardRearm(),
      api.quitGuardConfirm(),
      api.syncViewMenu(view),
    ]);

    expect(bridge.invoke.mock.calls).toEqual([
      ["feedback_draft", { text: "Fabricated feedback" }],
      ["app_diag"],
      ["reveal_logs"],
      ["set_unsaved_edits", { on: true }],
      ["quit_guard_rearm"],
      ["quit_guard_confirm"],
      ["menu_sync", { view }],
    ]);
  });

  it("forwards fabricated media and agent-response payloads without starting them", async () => {
    await Promise.all([
      api.importMediaUrl("https://fabricated.invalid/media"),
      api.importMediaUrl("https://fabricated.invalid/limited", 720),
      api.listMediaFormats("https://fabricated.invalid/media"),
      api.cancelMediaDownload(),
      api.resolveAgentUi("request-1", { selected: "fabricated" }),
    ]);

    expect(bridge.invoke.mock.calls).toEqual([
      ["import_media_url", { url: "https://fabricated.invalid/media", maxHeight: undefined }],
      ["import_media_url", { url: "https://fabricated.invalid/limited", maxHeight: 720 }],
      ["list_media_formats", { url: "https://fabricated.invalid/media" }],
      ["cancel_media_download"],
      ["resolve_agent_ui", { id: "request-1", payload: { selected: "fabricated" } }],
    ]);
  });

  it("subscribes fabricated quit, menu, media, agent, harness, and workspace events", async () => {
    const quit = vi.fn();
    const menu = vi.fn();
    const media = vi.fn();
    const agent = vi.fn();
    const harness = vi.fn();
    const workspace = vi.fn();

    const subscriptions = await Promise.all([
      api.onQuitRequested(quit),
      api.onMenuAction(menu),
      api.onYtdlpProgress(media),
      api.onAgentUiRequest(agent),
      api.onHarnessEvent(harness),
      api.onWorkspaceOperationProgress(workspace),
    ]);

    listeners.get("quit-requested")?.({ payload: "ignored" });
    listeners.get("menu-action")?.({ payload: "toggle-library" });
    listeners.get("ytdlp-progress")?.({ payload: { status: "downloading", percent: 50 } });
    listeners.get("agent-ui-request")?.({ payload: { id: "agent-1", kind: "snapshot" } });
    listeners.get("harness-event")?.({ payload: { kind: "run-started", runId: "run-1" } });
    listeners.get("workspace-operation-progress")?.({ payload: { operation: "copy", done: 1, total: 2 } });

    expect(bridge.listen.mock.calls.map(([channel]) => channel)).toEqual([
      "quit-requested",
      "menu-action",
      "ytdlp-progress",
      "agent-ui-request",
      "harness-event",
      "workspace-operation-progress",
    ]);
    expect(subscriptions).toEqual([unlisten, unlisten, unlisten, unlisten, unlisten, unlisten]);
    expect(quit).toHaveBeenCalledWith();
    expect(menu).toHaveBeenCalledWith("toggle-library");
    expect(media).toHaveBeenCalledWith({ status: "downloading", percent: 50 });
    expect(agent).toHaveBeenCalledWith({ id: "agent-1", kind: "snapshot" });
    expect(harness).toHaveBeenCalledWith({ kind: "run-started", runId: "run-1" });
    expect(workspace).toHaveBeenCalledWith({ operation: "copy", done: 1, total: 2 });
  });

  it("keeps fabricated front-page and suggestion requests distinct", async () => {
    await Promise.all([
      recommendedModels(),
      ensureEmbedModel(),
      roomGraph(),
      frontPage(),
      frontPageSuggestions(),
      studioPrompts(),
      memorySuggestion("chat-1"),
      suggestFileMeta("file-1"),
      generateUiText("summary", "Use fabricated facts", { count: 2 }, 12),
    ]);

    expect(bridge.invoke.mock.calls).toEqual([
      ["recommended_models"],
      ["ensure_embed_model"],
      ["room_graph"],
      ["front_page"],
      ["front_page_suggestions"],
      ["studio_prompts"],
      ["memory_suggestion", { chatId: "chat-1" }],
      ["suggest_file_meta", { fileId: "file-1" }],
      ["generate_ui_text", { kind: "summary", prompt: "Use fabricated facts", facts: { count: 2 }, maxWords: 12 }],
    ]);
  });

  it("forwards fabricated room-server, Ollama-setting, role, and recovery requests", async () => {
    await Promise.all([
      roomServerStatus(),
      setRoomServer(true, false, "files"),
      regenerateLeashToken(),
      setOllamaUrl("http://fabricated.invalid:11434"),
      testOllamaUrl("http://fabricated.invalid:11434"),
      getOllamaUrl(),
      listRoles(),
      writeRecoveryKey(),
      hasRecoveryKey("/fabricated/room"),
      openRoomWithRecovery("/fabricated/room", "recovery-code"),
    ]);

    expect(bridge.invoke.mock.calls).toEqual([
      ["room_server_status"],
      ["set_room_server", { enabled: true, allowCloud: false, scope: "files" }],
      ["regenerate_leash_token"],
      ["set_ollama_url", { url: "http://fabricated.invalid:11434" }],
      ["test_ollama_url", { url: "http://fabricated.invalid:11434" }],
      ["get_ollama_url"],
      ["list_roles"],
      ["write_recovery_key"],
      ["has_recovery_key", { path: "/fabricated/room" }],
      ["open_room_with_recovery", { path: "/fabricated/room", code: "recovery-code" }],
    ]);
  });

  it("leaves a fabricated remote-setting failure observable without contacting it", async () => {
    const failure = new Error("fabricated remote setting failure");
    bridge.invoke.mockRejectedValueOnce(failure);

    await expect(testOllamaUrl("http://fabricated.invalid:11434")).rejects.toBe(failure);

    expect(bridge.invoke).toHaveBeenCalledWith("test_ollama_url", { url: "http://fabricated.invalid:11434" });
  });
});
