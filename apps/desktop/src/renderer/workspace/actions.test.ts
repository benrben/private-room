import { describe, expect, it, vi } from "vitest";
import type { RoomInfo } from "../api";
import type { WSState } from "./state";

const factories = vi.hoisted(() => ({
  file: vi.fn(() => ({ viewFile: vi.fn(), fileAction: "files" })),
  misc: vi.fn(() => ({ changeModel: vi.fn(), playSealSound: vi.fn(), miscAction: "misc" })),
  recording: vi.fn(() => ({ openOllamaApp: vi.fn(), downloadModel: vi.fn(), refreshAi: vi.fn(), recordingAction: "recording" })),
  studio: vi.fn(() => ({ studioAction: "studio" })),
  chat: vi.fn(() => ({ chatAction: "chat" })),
  voice: vi.fn(() => ({ voiceAction: "voice" })),
  workflow: vi.fn(() => ({ workflowAction: "workflow" })),
  script: vi.fn(() => ({ scriptAction: "script" })),
  skill: vi.fn(() => ({ skillAction: "skill" })),
}));

vi.mock("./fileActions", () => ({ makeFileActions: factories.file }));
vi.mock("./miscActions", () => ({ makeMiscActions: factories.misc }));
vi.mock("./recordingActions", () => ({ makeRecordingActions: factories.recording }));
vi.mock("./studioActions", () => ({ makeStudioActions: factories.studio }));
vi.mock("./chatActions", () => ({ makeChatActions: factories.chat }));
vi.mock("./voiceActions", () => ({ makeVoiceActions: factories.voice }));
vi.mock("./workflowActions", () => ({ makeWorkflowActions: factories.workflow }));
vi.mock("./scriptActions", () => ({ makeScriptActions: factories.script }));
vi.mock("./skillActions", () => ({ makeSkillActions: factories.skill }));

import { useWorkspaceActions } from "./actions";

describe("useWorkspaceActions", () => {
  it("threads shared actions into every workspace action family and returns the complete surface", () => {
    const state = {} as WSState;
    const info = { name: "Fabricated room" } as RoomInfo;
    const onLock = vi.fn();

    const actions = useWorkspaceActions(state, info, onLock);
    const file = factories.file.mock.results[0]?.value;
    const misc = factories.misc.mock.results[0]?.value;
    const recording = factories.recording.mock.results[0]?.value;

    expect(factories.misc).toHaveBeenCalledWith(state, info, { viewFile: file.viewFile });
    expect(factories.recording).toHaveBeenCalledWith(state, {
      viewFile: file.viewFile,
      changeModel: misc.changeModel,
    });
    expect(factories.studio).toHaveBeenCalledWith(state, {
      viewFile: file.viewFile,
      openOllamaApp: recording.openOllamaApp,
    });
    expect(factories.chat).toHaveBeenCalledWith(state, onLock, {
      viewFile: file.viewFile,
      openOllamaApp: recording.openOllamaApp,
      downloadModel: recording.downloadModel,
      refreshAi: recording.refreshAi,
      playSealSound: misc.playSealSound,
    });
    expect(actions).toMatchObject({
      fileAction: "files",
      miscAction: "misc",
      recordingAction: "recording",
      studioAction: "studio",
      chatAction: "chat",
      voiceAction: "voice",
      workflowAction: "workflow",
      scriptAction: "script",
      skillAction: "skill",
    });
  });
});
