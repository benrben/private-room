import { emitLocal } from "../platform";
import {
  createRecSessionClient,
  wireLoopbackTap,
  type RecSessionClient,
  type RecSessionEvent,
} from "../platform/recording/recSessionClient.js";
import { createLoopbackTap } from "../platform/recording/loopbackTap.js";
import { setRecordingAudioSink, stopMicTap } from "./liveRec";

const EVENT_CHANNELS: Record<string, string> = {
  level: "rec-level",
  partial: "rec-partial",
  final: "rec-segment",
  "segment-drop": "rec-segment-drop",
  relabel: "rec-relabel",
  "save-status": "rec-save-progress",
  "source-health": "rec-source",
  error: "rec-error",
  "live-translation": "rec-live-translation",
  state: "rec-state",
  stopped: "rec-state",
};

const loopback = createLoopbackTap({
  requestDisplayMedia: (constraints) => navigator.mediaDevices.getDisplayMedia(constraints),
});

let active: RecSessionClient | null = null;

function forward(event: RecSessionEvent): void {
  const channel = EVENT_CHANNELS[event.type];
  if (channel) emitLocal(channel, event.payload);
}

/** Own the direct recording socket and both renderer capture lanes. */
export function startRecordingTransport(sessionUrl: string, fileId: string): void {
  closeRecordingTransport();
  let client!: RecSessionClient;
  let terminalSeen = false;
  client = createRecSessionClient(sessionUrl, fileId, {
    onEvent: (event) => {
      if (event.type === "stopped") terminalSeen = true;
      forward(event);
    },
    onSysTapRequest: (request) => wireLoopbackTap(client, loopback)(request),
    onClose: () => {
      if (active !== client) return;
      active = null;
      setRecordingAudioSink(null);
      loopback.stop();
      stopMicTap();
      if (!terminalSeen) {
        emitLocal("rec-error", {
          fileId,
          message: "The live recording connection closed unexpectedly.",
        });
      }
    },
  });
  active = client;
  setRecordingAudioSink((rate, frame) => client.sendAudio("mic", rate, frame));
}

export function closeRecordingTransport(): void {
  setRecordingAudioSink(null);
  loopback.stop();
  const closing = active;
  active = null;
  closing?.close();
}
