import { api } from "../api";
import {
  acquireMic,
  attachMicTap,
  noteLiveStt,
  stopMicTap,
} from "./liveRec";
import { closeRecordingTransport, startRecordingTransport } from "./recordingTransport";
import type { WSState } from "./state";

interface LiveRecordingDeps {
  viewFile: (id: string) => Promise<void>;
  isMissingSttModel: (error: unknown) => boolean;
  showMissingSttModelToast: () => void;
}

/** The workspace-wide live recording lifecycle. It is separate from batch
 * dictation because the backend session survives switching files and owns its
 * own microphone and transport teardown. */
export function makeLiveRecordingActions(s: WSState, deps: LiveRecordingDeps) {
  const { viewFile, isMissingSttModel, showMissingSttModelToast } = deps;

  async function startLiveRecording(
    fileId?: string,
    opts?: { systemAudio?: boolean; liveTranslate?: string | null },
  ) {
    if (await isViewingLiveRecording()) return;
    // Open the microphone before rec_start while the initiating click is still
    // active; WebKit may otherwise reject an already-authorised device.
    const withSystem = opts?.systemAudio ?? true;
    const micAttempt = await liveRecordingMic();
    const res = await startRecordingEngine(
      micAttempt.mic,
      fileId,
      withSystem,
      opts?.liveTranslate ?? null,
    );
    if (!res) return;
    await finishLiveRecordingStart(res, micAttempt, withSystem);
  }

  async function finishLiveRecordingStart(
    res: Awaited<ReturnType<typeof api.recStart>>,
    micAttempt: MicAttempt,
    withSystem: boolean,
  ) {
    // Past this line the engine is recording. Later UI refresh failures must
    // not be reported as a failure to start or tear the microphone down.
    startLiveTransport(res.sessionUrl, res.fileId);
    if (micAttempt.error) await reportStartMicFailure(micAttempt.error, withSystem);
    if (micAttempt.mic) await attachLiveMic(micAttempt.mic);
    await refreshStartedRecording(res.fileId);
  }

  async function isViewingLiveRecording(): Promise<boolean> {
    if (!s.recLive) return false;
    s.pushToast("info", "A recording is already running.");
    await viewFile(s.recLive.fileId);
    return true;
  }

  interface MicAttempt {
    mic: MediaStream | null;
    error: string | null;
  }

  async function liveRecordingMic(): Promise<MicAttempt> {
    try {
      return { mic: await acquireMic(), error: null };
    } catch (e) {
      return { mic: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async function startRecordingEngine(
    mic: MediaStream | null,
    fileId: string | undefined,
    systemAudio: boolean,
    liveTranslate: string | null,
  ) {
    try {
      return await api.recStart({ fileId: fileId ?? null, systemAudio, liveTranslate });
    } catch (e) {
      mic?.getTracks().forEach((track) => track.stop());
      if (isMissingSttModel(e)) showMissingSttModelToast();
      else s.pushToast("error", String(e));
      return null;
    }
  }

  function startLiveTransport(sessionUrl: string, fileId: string) {
    startRecordingTransport(sessionUrl, fileId);
    noteLiveStt(true);
    s.setRecLive({ fileId, status: "recording" });
  }

  async function reportStartMicFailure(micError: string, withSystem: boolean) {
    // The system-audio lane starts asynchronously. Only an explicit error, or
    // a lane that was not requested, proves the failed mic leaves no capture.
    const live = await api.recLiveStatus().catch(() => null);
    const nothingCaptured = !withSystem || live?.sys?.[0] === "error";
    const remedy = withSystem
      ? ""
      : ' Stop, then start again with "Include the Mac\'s audio" ticked.';
    s.pushToast(
      "error",
      nothingCaptured
        ? `${micError} — and the Mac's audio is not being recorded, so nothing at all is being captured.${remedy}`
        : `${micError} (the Mac's audio keeps recording)`,
    );
  }

  async function attachLiveMic(mic: MediaStream) {
    try {
      await attachMicTap(mic);
    } catch (e) {
      mic.getTracks().forEach((track) => track.stop());
      s.pushToast(
        "error",
        `The recording started, but your microphone could not be attached, so your voice is not being captured: ${e}`,
      );
    }
  }

  async function refreshStartedRecording(fileId: string) {
    try {
      s.setFiles(await api.listFiles());
      await viewFile(fileId);
    } catch (e) {
      s.pushToast("error", `The recording started, but the room could not be refreshed: ${e}`);
    }
  }

  async function pauseLiveRecording() {
    stopMicTap();
    try {
      await api.recPause();
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  async function resumeLiveRecording() {
    // Same rule as start: acquire the microphone while the click still counts.
    const mic = await resumeMic();
    try {
      await api.recResume();
      if (mic) await attachMicTap(mic);
    } catch (e) {
      mic?.getTracks().forEach((track) => track.stop());
      s.pushToast("error", String(e instanceof Error ? e.message : e));
    }
  }

  async function resumeMic(): Promise<MediaStream | null> {
    try {
      return await acquireMic();
    } catch (e) {
      await reportResumeMicFailure(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  async function reportResumeMicFailure(message: string) {
    const live = await api.recLiveStatus().catch(() => null);
    s.pushToast(
      "error",
      live?.sys?.[0] === "on"
        ? `${message} (the Mac's audio keeps recording)`
        : `${message} — and the Mac's audio is not being recorded, so nothing at all is being captured.`,
    );
  }

  async function stopLiveRecording() {
    stopMicTap();
    const fileId = s.recLive?.fileId;
    s.setRecLive((recording) =>
      recording ? { ...recording, status: "saving" } : recording,
    );
    await stopRecordingEngine(fileId);
    s.setRecLive(null);
    await refreshStoppedRecording(fileId);
  }

  async function stopRecordingEngine(fileId: string | undefined) {
    try {
      const meta = await api.recStop();
      s.pushToast(
        "success",
        stoppedRecordingMessage(meta.segments.length),
        fileId ? { label: "Open", run: () => void viewFile(fileId) } : undefined,
      );
    } catch (e) {
      s.pushToast("error", String(e));
    } finally {
      closeRecordingTransport();
    }
  }

  function stoppedRecordingMessage(segmentCount: number): string {
    return segmentCount > 0
      ? "Recording saved — transcript included."
      : "Recording saved. No transcript was written — use Re-transcribe to build one.";
  }

  async function refreshStoppedRecording(fileId: string | undefined) {
    try {
      s.setFiles(await api.listFiles());
      if (fileId && s.openFileRef.current?.id === fileId) await viewFile(fileId);
    } catch (e) {
      // Callers intentionally fire-and-forget stopLiveRecording; keep refresh
      // failures visible instead of allowing an unhandled rejection.
      s.pushToast("error", `The recording was saved, but the room could not be refreshed: ${e}`);
    }
  }

  return {
    startLiveRecording,
    pauseLiveRecording,
    resumeLiveRecording,
    stopLiveRecording,
  };
}
