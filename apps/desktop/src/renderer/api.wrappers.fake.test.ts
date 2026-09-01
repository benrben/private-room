import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("./platform", () => bridge);

import { api } from "./api";

type ApiWrapper = (...args: any[]) => Promise<unknown>;
const wrappers = api as unknown as Record<string, ApiWrapper>;

beforeEach(() => {
  bridge.invoke.mockReset().mockResolvedValue(undefined);
  bridge.listen.mockReset().mockResolvedValue(() => undefined);
});

describe("API wrappers", () => {
  it("forwards fabricated engine, chat, dictation, and speech requests unchanged", async () => {
    await Promise.all([
      wrappers.enginePreflight("vision"),
      wrappers.engineSupportMatrix(),
      wrappers.groundingModelForRoom(),
      wrappers.listEngineModels("cloud"),
      wrappers.validateEngineModel("cloud", "remote-model"),
      wrappers.listAiProviders(),
      wrappers.connectAiProvider("provider", "fake-key"),
      wrappers.disconnectAiProvider("provider"),
      wrappers.warmModel(),
      wrappers.pullModel("fake-model"),
      wrappers.deleteModel("fake-model"),
      wrappers.openOllama(),
      wrappers.listChats(),
      wrappers.createChat(),
      wrappers.deleteChat("chat-1"),
      wrappers.renameChat("chat-1", "Renamed"),
      wrappers.getMessages("chat-1"),
      wrappers.deleteMessage("message-1"),
      wrappers.ask("chat-1", "A fabricated question", ["file-1"], "ask-1", "open.md", true),
      wrappers.cancelAsk("ask-1"),
      wrappers.handoffContext("chat-1"),
      wrappers.runCommand("chat-1", "minutes", "", ["file-1"], "#minutes @notes", "ask-2"),
      wrappers.listChatCommands(),
      wrappers.listSpecialists(),
      wrappers.importImageBytes("image.png", "aW1hZ2U="),
      wrappers.importAudioBytes("voice.m4a", "YXVkaW8="),
      wrappers.locateInImage("image-1", "blue box"),
      wrappers.sttStatus(),
      wrappers.sttDownloadModel(),
      wrappers.sttCancelDownload(),
      wrappers.sttDeleteModel(),
      wrappers.retranscribeFile("audio-1"),
      wrappers.shapeText("raw words", true, "notes"),
      wrappers.dictStart(),
      wrappers.dictPushAudio(16_000, "cGNt"),
      wrappers.dictStop(),
      wrappers.dictCancel(),
      wrappers.speakTextNeural("Read this", "Andrew"),
      wrappers.listNeuralVoices(),
      wrappers.aiActionPrompts(),
      wrappers.aiAction("outline", {
        scope: "room",
        refs: ["file-1"],
        instructions: "Be brief",
        question: "What changed?",
        opId: "operation-1",
      }),
      wrappers.aiAction("outline", {}),
      wrappers.createSketch("diagram.arcelle-sketch"),
      wrappers.saveSketch("sketch-1", "{fake-doc}", true, "{previous-doc}"),
      wrappers.exportSketchSvg("sketch-1"),
      wrappers.exportSketchPng("sketch-1"),
    ]);

    expect(bridge.invoke.mock.calls).toEqual([
      ["engine_preflight", { capability: "vision" }],
      ["engine_support_matrix"],
      ["grounding_model_for_room"],
      ["list_engine_models", { engine: "cloud" }],
      ["validate_engine_model", { engine: "cloud", model: "remote-model" }],
      ["list_ai_providers"],
      ["connect_ai_provider", { provider: "provider", apiKey: "fake-key" }],
      ["disconnect_ai_provider", { provider: "provider" }],
      ["warm_model"],
      ["pull_model", { name: "fake-model" }],
      ["delete_model", { name: "fake-model" }],
      ["open_ollama"],
      ["list_chats"],
      ["create_chat"],
      ["delete_chat", { id: "chat-1" }],
      ["rename_chat", { id: "chat-1", title: "Renamed" }],
      ["get_messages", { chatId: "chat-1" }],
      ["delete_message", { id: "message-1" }],
      ["ask", {
        chatId: "chat-1",
        question: "A fabricated question",
        attachments: ["file-1"],
        askId: "ask-1",
        viewing: "open.md",
        privacyBypass: true,
      }],
      ["cancel_ask", { askId: "ask-1" }],
      ["handoff_chat", { chatId: "chat-1" }],
      ["run_command", {
        chatId: "chat-1",
        command: "minutes",
        args: "",
        refs: ["file-1"],
        raw: "#minutes @notes",
        askId: "ask-2",
      }],
      ["list_chat_commands"],
      ["list_specialists"],
      ["import_image_bytes", { name: "image.png", b64: "aW1hZ2U=" }],
      ["import_audio_bytes", { name: "voice.m4a", b64: "YXVkaW8=" }],
      ["locate_in_image", { fileId: "image-1", query: "blue box" }],
      ["stt_status"],
      ["stt_download_model"],
      ["stt_cancel_download"],
      ["stt_delete_model"],
      ["retranscribe_file", { fileId: "audio-1" }],
      ["shape_text", { text: "raw words", translate: true, mode: "notes" }],
      ["dict_start"],
      ["dict_push_audio", { rate: 16_000, dataB64: "cGNt" }],
      ["dict_stop"],
      ["dict_cancel"],
      ["speak_text_neural", { text: "Read this", voice: "Andrew" }],
      ["list_neural_voices"],
      ["ai_action_prompts"],
      ["ai_action", {
        action: "outline",
        scope: "room",
        refs: ["file-1"],
        instructions: "Be brief",
        question: "What changed?",
        opId: "operation-1",
      }],
      ["ai_action", {
        action: "outline",
        scope: null,
        refs: null,
        instructions: null,
        question: null,
        opId: null,
      }],
      ["create_sketch", { name: "diagram.arcelle-sketch" }],
      ["save_sketch", {
        id: "sketch-1",
        doc: "{fake-doc}",
        snapshot: true,
        expectedDoc: "{previous-doc}",
        editorAutosave: true,
      }],
      ["export_sketch_svg", { id: "sketch-1" }],
      ["export_sketch_png", { id: "sketch-1" }],
    ]);
  });

  it("forwards fabricated recording controls and optional recording fields", async () => {
    await Promise.all([
      wrappers.recStart({ systemAudio: true }),
      wrappers.recStart({ fileId: "recording-1", systemAudio: false, liveTranslate: "fr" }),
      wrappers.recPushAudio(48_000, "cGNt"),
      wrappers.recPause(),
      wrappers.recResume(),
      wrappers.recStop(),
      wrappers.recLiveStatus(),
      wrappers.recSetLiveTranslate("es"),
      wrappers.recSetLiveStt(false),
      wrappers.recGet("recording-1"),
      wrappers.recDeleteRange("recording-1", 12, 34),
      wrappers.recCorrectRange("recording-1", 12, 34, "corrected"),
      wrappers.recSetSpeakerName("recording-1", "Speaker 1", "Dana"),
      wrappers.recReadStart("recording-1"),
      wrappers.recNoteAdd("recording-1", 12, "note", "Follow up", "Dana"),
      wrappers.recNoteSet("recording-1", "note-1", "Updated"),
      wrappers.recChapterAdd("recording-1", 0, "Opening"),
      wrappers.recChapterSet("recording-1", "chapter-1", "Welcome"),
      wrappers.recHighlightAdd("recording-1", 12, 34),
      wrappers.recItemDelete("recording-1", "highlight", "highlight-1"),
      wrappers.voicesList(),
      wrappers.voiceForget("Dana"),
      wrappers.recExportClean("recording-1"),
      wrappers.recTranslate("recording-1", "fr"),
      wrappers.recRetranscribe("recording-1"),
    ]);

    expect(bridge.invoke.mock.calls).toEqual([
      ["rec_start", { fileId: null, systemAudio: true, liveTranslate: null }],
      ["rec_start", { fileId: "recording-1", systemAudio: false, liveTranslate: "fr" }],
      ["rec_push_audio", { rate: 48_000, dataB64: "cGNt" }],
      ["rec_pause"],
      ["rec_resume"],
      ["rec_stop"],
      ["rec_live_status"],
      ["rec_set_live_translate", { language: "es" }],
      ["rec_set_live_stt", { on: false }],
      ["rec_get", { id: "recording-1" }],
      ["rec_delete_range", { id: "recording-1", t0: 12, t1: 34 }],
      ["rec_correct_range", { id: "recording-1", t0: 12, t1: 34, text: "corrected" }],
      ["rec_set_speaker_name", { id: "recording-1", speaker: "Speaker 1", name: "Dana" }],
      ["rec_read_start", { id: "recording-1" }],
      ["rec_note_add", { id: "recording-1", t0: 12, kind: "note", text: "Follow up", who: "Dana" }],
      ["rec_note_set", { id: "recording-1", noteId: "note-1", text: "Updated" }],
      ["rec_chapter_add", { id: "recording-1", t0: 0, title: "Opening" }],
      ["rec_chapter_set", { id: "recording-1", chapterId: "chapter-1", title: "Welcome" }],
      ["rec_highlight_add", { id: "recording-1", t0: 12, t1: 34 }],
      ["rec_item_delete", { id: "recording-1", kind: "highlight", itemId: "highlight-1" }],
      ["voices_list"],
      ["voice_forget", { name: "Dana" }],
      ["rec_export_clean", { id: "recording-1" }],
      ["rec_translate", { id: "recording-1", language: "fr" }],
      ["rec_retranscribe", { id: "recording-1" }],
    ]);
  });

  it("relays fabricated non-turn events through their public listener wrappers", async () => {
    const deliveries: Array<{ channel: string; deliver: (event: { payload: unknown }) => void }> = [];
    bridge.listen.mockImplementation((channel, deliver) => {
      deliveries.push({ channel, deliver });
      return Promise.resolve(() => undefined);
    });
    const registrations = [
      ["onDictPartial", "dict-partial", "partial words"],
      ["onSttDownloadProgress", "stt-download-progress", { got: 1, total: 2, percent: 50 }],
      ["onSttProgress", "stt-progress", ["voice.m4a", "done"]],
      ["onOcrProgress", "ocr-progress", ["scan.png", "started"]],
      ["onOpenRoomFile", "open-room-file", "/fake/room.arcelle"],
      ["onRoomRolledBack", "room-rolled-back", { id: "room-1" }],
      ["onSketchDrawn", "sketch-drawn", { id: "sketch-1" }],
      ["onPrivacyScan", "privacy-scan", { phase: "scanning" }],
      ["onStudioStep", "studio-step", { label: "Drafting" }],
      ["onJobProgress", "job-progress", { id: "job-1" }],
      ["onWorkflowNode", "workflow-node", { id: "node-1" }],
      ["onWorkflowsChanged", "workflows-changed", null, true],
      ["onSkillsChanged", "skills-changed", null, true],
      ["onMemoriesChanged", "memories-changed", null, true],
      ["onScriptApproveRequest", "script-approve-request", { id: "approval-1" }],
      ["onImportProgress", "import-progress", { done: 1, total: 2, name: "note.md" }],
      ["onAgentOpenFile", "agent-open-file", { fileId: "file-1" }],
      ["onAgentAnnotate", "agent-annotate", { fileId: "file-1", note: "mark" }],
      ["onFileUpdated", "file-updated", "file-1"],
      ["onAssistantOrganized", "assistant-organized", { fileId: "file-1", action: "moved" }],
      ["onRoomFilesChanged", "room-files-changed", null, true],
      ["onMcpApproveRequest", "mcp-approve-request", { id: "mcp-1" }],
      ["onEditApproveRequest", "edit-approve-request", { id: "edit-1" }],
      ["onMcpStatus", "mcp-status", [{ id: "mcp-1" }]],
      ["onRecReadDone", "rec-read-done", { fileId: "recording-1" }],
      ["onRecPartial", "rec-partial", { fileId: "recording-1", source: "mic", t0: 1, text: "hello" }],
      ["onRecSegment", "rec-segment", { fileId: "recording-1", segment: { id: "segment-1" } }],
      ["onRecSegmentDrop", "rec-segment-drop", { fileId: "recording-1", id: "segment-1" }],
      ["onRecRelabel", "rec-relabel", { fileId: "recording-1", labels: [] }],
      ["onRecLevel", "rec-level", { fileId: "recording-1", mic: 1, sys: 2, durationCs: 3 }],
      ["onRecState", "rec-state", { fileId: "recording-1", status: "recording", durationCs: 3 }],
      ["onRecSaveProgress", "rec-save-progress", { fileId: "recording-1", stage: "writing", remaining: 1 }],
      ["onRecSource", "rec-source", { fileId: "recording-1", source: "mic", status: "on", message: "ready" }],
      ["onRecError", "rec-error", { fileId: "recording-1", message: "fake error" }],
      ["onRecLiveTranslation", "rec-live-translation", { fileId: "recording-1", segId: "segment-1", text: "bonjour" }],
      ["onRecTranslateProgress", "rec-translate-progress", { fileId: "recording-1", done: 1, total: 2 }],
      ["onRecRetranscribe", "rec-retranscribe", { fileId: "recording-1", doneCs: 1, totalCs: 2 }],
    ] as const;

    for (const [name, channel, payload, discardsPayload] of registrations) {
      const received = vi.fn();
      await wrappers[name](received);
      const registration = deliveries.at(-1);
      expect(registration?.channel).toBe(channel);
      registration?.deliver({ payload });
      if (discardsPayload) expect(received).toHaveBeenCalledWith();
      else expect(received).toHaveBeenCalledWith(payload);
    }
  });

  it("keeps fabricated ask-event envelopes paired with their turn metadata", async () => {
    const deliveries: Array<{ channel: string; deliver: (event: { payload: unknown }) => void }> = [];
    bridge.listen.mockImplementation((channel, deliver) => {
      deliveries.push({ channel, deliver });
      return Promise.resolve(() => undefined);
    });
    const cases = [
      ["onAskDelta", "ask-delta", "word"],
      ["onAskLane", "ask-lane", "Working"],
      ["onAskPlan", "ask-plan", [{ node: "research" }]],
      ["onAskAgent", "ask-agent", { id: "research" }],
      ["onAskStepStatus", "ask-step-status", { ok: true }],
      ["onAskReport", "ask-report", { node: "research", text: "done" }],
      ["onAskPrivacy", "ask-privacy", { hidden: 2 }],
      ["onAskTokenUsage", "ask-token-usage", { input: 1, output: 2 }],
    ] as const;

    for (const [name, channel, value] of cases) {
      const received = vi.fn();
      await wrappers[name](received);
      const registration = deliveries.at(-1);
      expect(registration?.channel).toBe(channel);
      registration?.deliver({ payload: { v: value, runId: "run-1", chatId: "chat-1" } });
      expect(received).toHaveBeenCalledWith(value, { runId: "run-1", chatId: "chat-1" });
    }

    const step = vi.fn();
    await wrappers.onAskStep(step);
    const stepRegistration = deliveries.at(-1);
    expect(stepRegistration?.channel).toBe("ask-step");
    stepRegistration?.deliver({ payload: { v: "Searching", runId: "run-1", chatId: "chat-1" } });
    expect(step).toHaveBeenCalledWith(
      { label: "Searching", node: null },
      { runId: "run-1", chatId: "chat-1" },
    );

    const round = vi.fn();
    await wrappers.onAskRound(round);
    const roundRegistration = deliveries.at(-1);
    expect(roundRegistration?.channel).toBe("ask-round");
    roundRegistration?.deliver({ payload: { v: null, runId: "run-2", chatId: "chat-2" } });
    expect(round).toHaveBeenCalledWith({ runId: "run-2", chatId: "chat-2" });
  });
});
