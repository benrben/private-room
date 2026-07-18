import { RoomInfo } from "../api";
import { WSState } from "./state";
import { makeFileActions } from "./fileActions";
import { makeMiscActions } from "./miscActions";
import { makeRecordingActions } from "./recordingActions";
import { makeStudioActions } from "./studioActions";
import { makeChatActions } from "./chatActions";
import { makeVoiceActions } from "./voiceActions";

/** Build every Workspace handler, threading the cross-hook dependencies in the
 * one place that owns the wiring (files → misc → recording → studio → chat). */
export function useWorkspaceActions(
  s: WSState,
  info: RoomInfo,
  onLock: () => void | Promise<void>,
) {
  const files = makeFileActions(s);
  const misc = makeMiscActions(s, info, { viewFile: files.viewFile });
  const recording = makeRecordingActions(s, {
    viewFile: files.viewFile,
    changeModel: misc.changeModel,
  });
  const studio = makeStudioActions(s, {
    viewFile: files.viewFile,
    openOllamaApp: recording.openOllamaApp,
  });
  const chat = makeChatActions(s, onLock, {
    viewFile: files.viewFile,
    openOllamaApp: recording.openOllamaApp,
    downloadModel: recording.downloadModel,
    refreshAi: recording.refreshAi,
    playSealSound: misc.playSealSound,
  });
  const voice = makeVoiceActions(s);
  return { ...files, ...misc, ...recording, ...studio, ...chat, ...voice };
}

export type WSActions = ReturnType<typeof useWorkspaceActions>;
