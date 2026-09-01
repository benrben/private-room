import { openUrl } from "../platform";
import { api, FileTarget } from "../api";
import { fileToBase64 } from "./composer";
import {
  acquireMic,
  createPcmTap,
  micConstraints,
} from "./liveRec";
import { WSState } from "./state";
import { base64ToBytes } from "../viewers/util";
import { connectDictSession, type DictSession } from "./dictSession";
import { makeLiveRecordingActions } from "./recordingLiveActions";

/** Below this RMS (PCM samples in [-1, 1]) counts as silence for hands-free
 * auto-send — comfortably above the mic's noise floor (echoCancellation /
 * noiseSuppression are already on for dictation) but well under a speaking
 * voice. Tune here if it fires too eagerly or not eagerly enough. */
const SILENCE_RMS = 0.02;
/** How long the user has to stay quiet, AFTER having said something, before
 * hands-free treats the turn as finished and sends it — long enough to
 * survive a mid-sentence breath, short enough to still feel like a live
 * conversation.
 *
 * 900 ms, not 1,500: batches land ~250 ms apart (liveRec's makeSink), so the
 * real fire point is a granule later than whatever is written here, and the old
 * value put it at 1.5–1.75 s — roughly a second past where voice interfaces
 * end a turn. Not lower than 900 either: there is no semantic turn detector
 * here, only energy, so the pause inside "the thing is… it depends" has to
 * survive.
 *
 * What a premature cut costs, stated because it is not obvious from the call
 * site: `dictStreamRef` stops the mic tracks, so anything said after the cut is
 * never captured and never reported — the user simply finds half their sentence
 * in the composer.
 *
 * Coupled to `SILENCE_RMS` above, which is calibrated with WebKit's voice
 * processing ON (`liveRec.micConstraints`). A design that turns
 * `echoCancellation` off changes the noise floor this threshold sits above, and
 * the pair has to be re-measured together. */
const SILENCE_MS = 900;

function rms(floats: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < floats.length; i++) sum += floats[i] * floats[i];
  return Math.sqrt(sum / floats.length);
}

/** Wraps a dictation push callback with an energy-based "the user stopped
 * talking" watch: once real speech has been heard, SILENCE_MS of quiet
 * fires `onSilence` (once, ever, for this session). Batches land ~250ms
 * apart (liveRec's makeSink), so the real fire point is one granule past
 * SILENCE_MS — see its doc for what that costs.
 * Decoding the batch back out of base64 is wasteful-looking but avoids
 * threading a second callback through createPcmTap for one caller. */
function withSilenceGate(
  push: (rate: number, b64: string) => Promise<void>,
  onSilence: () => void,
): (rate: number, b64: string) => Promise<void> {
  let heardSpeech = false;
  let lastLoud = 0;
  let fired = false;
  return (rate, b64) => {
    if (!fired) {
      const bytes = base64ToBytes(b64);
      const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      const now = Date.now();
      if (rms(floats) >= SILENCE_RMS) {
        heardSpeech = true;
        lastLoud = now;
      } else if (heardSpeech && now - lastLoud >= SILENCE_MS) {
        fired = true;
        onSilence();
      }
    }
    return push(rate, b64);
  };
}

/** Dictation (one shared mic, several sinks) + model onboarding/status.
 * Cross-hook: `viewFile` (files) for talk-to-file; `changeModel` (misc) for the
 * first-run picker. */
export function makeRecordingActions(
  s: WSState,
  deps: {
    viewFile: (id: string, target?: FileTarget) => Promise<void>;
    changeModel: (value: string) => Promise<void>;
  },
) {
  const { viewFile, changeModel } = deps;

  async function refreshAi() {
    const status = await api.aiStatus();
    s.setAi(status);
    s.setModel((current) => current || status.defaultModel);
  }

  async function beginRecording(
    owner: string,
    onDone: (blob: Blob, ext: string) => Promise<void>,
  ) {
    if (shouldSkipRecordingStart(owner)) return;
    // Own the state BEFORE asking for the microphone: the permission dialog
    // or a slow device can take seconds, and the capture dock must already be
    // saying "Preparing microphone…" instead of the click doing nothing.
    s.setDictOwner(owner);
    s.setDictState("preparing");
    const stream = await recordingMic();
    if (!stream) return;
    startBatchRecording(stream, owner, onDone);
  }

  function shouldSkipRecordingStart(owner: string): boolean {
    if (s.dictState === "busy" || s.dictState === "preparing") return true;
    if (s.dictState !== "recording") return false;
    if (s.dictOwner === owner) s.recorderRef.current?.stop();
    return true;
  }

  async function recordingMic(): Promise<MediaStream | null> {
    try {
      // Same constraints as a recording: `audio: true` lets WebKit turn on
      // voice processing (and its gain riding) by default, which other apps on
      // the same microphone hear as their volume dropping (GH #4).
      return await navigator.mediaDevices.getUserMedia({
        audio: micConstraints(),
      });
    } catch (e) {
      s.setDictState("idle");
      s.setDictOwner(null);
      s.pushToast("error", recordingMicMessage(e));
      return null;
    }
  }

  function recordingMicMessage(error: unknown): string {
    const name = (error as { name?: string })?.name || "";
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      return "No microphone found — plug one in or check your input device.";
    }
    if (name === "NotReadableError" || name === "AbortError") {
      return "The microphone is busy in another app — close it and try again.";
    }
    return "Microphone blocked — allow Arcelle in System Settings → Privacy & Security → Microphone, then reopen the app.";
  }

  function startBatchRecording(
    stream: MediaStream,
    owner: string,
    onDone: (blob: Blob, ext: string) => Promise<void>,
  ) {
    const mime = MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    s.dictChunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) s.dictChunksRef.current.push(e.data);
    };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      s.setDictState("busy");
      try {
        const blob = new Blob(s.dictChunksRef.current, {
          type: rec.mimeType || "audio/mp4",
        });
        const ext = (rec.mimeType || "").includes("webm") ? "webm" : "m4a";
        await onDone(blob, ext);
      } catch (e) {
        if (String(e).includes("STT_MODEL_MISSING")) {
          s.pushToast(
            "error",
            "Download the voice model first, in Settings → Model → Dictation.",
            { label: "Open Settings", run: () => s.setShowSettings(true) },
          );
        } else {
          s.pushToast("error", `Dictation failed: ${e}`);
        }
      } finally {
        s.setDictState("idle");
        s.setDictOwner(null);
      }
    };
    rec.start();
    s.recorderRef.current = rec;
    s.setDictOwner(owner);
    s.setDictState("recording");
  }

  /** Streaming dictation (Metal wave): raw PCM flows to the Rust session
   * WHILE the user speaks, and rolling whole-utterance partials stream back
   * as `dict-partial` events — the composer paints them live, so the wait
   * that used to start at Stop overlaps the speaking instead. The final text
   * is still one whole-buffer decode at Stop (same quality as the old batch
   * path), then the usual local-only shaping. `onPartial` is optional:
   * journal/file/memory sinks and hands-free just get the faster final. */
  function dictateTo(
    owner: string,
    sink: (text: string) => void | Promise<void>,
    onPartial?: (text: string) => void,
  ) {
    if (s.dictState === "busy" || s.dictState === "preparing") return;
    if (s.dictState === "recording") {
      if (s.dictOwner === owner) s.dictStreamRef.current?.();
      return;
    }
    // Own the state BEFORE asking for the microphone (same doctrine as
    // beginRecording): the permission dialog can take seconds, and the
    // capture dock must already be saying "Preparing microphone…".
    s.setDictOwner(owner);
    s.setDictState("preparing");
    void launchDictation(owner, sink, onPartial);
  }

  async function launchDictation(
    owner: string,
    sink: (text: string) => void | Promise<void>,
    onPartial?: (text: string) => void,
  ) {
    const mic = await dictationMic();
    if (!mic) return;
    const resources = await dictationResources(mic, owner, onPartial);
    if (!resources) return;
    s.setDictState("recording");
    s.dictStreamRef.current = () => stopDictation(resources, sink, onPartial);
  }

  async function dictationMic(): Promise<MediaStream | null> {
    try {
      return await acquireMic();
    } catch (e) {
      failDictation(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  interface DictationResources {
    mic: MediaStream;
    session: DictSession;
    tapDown: () => Promise<void>;
  }

  async function dictationResources(
    mic: MediaStream,
    owner: string,
    onPartial?: (text: string) => void,
  ): Promise<DictationResources | null> {
    let session: DictSession | null = null;
    try {
      const info = await api.dictStart(); // model check + authenticated WS URL
      session = await connectDictSession(info, (text) => {
        s.setDictPartial(text);
        onPartial?.(text);
      });
      const push = (rate: number, b64: string) => session!.push(rate, b64);
      // Hands-free: once you've said something, going quiet for a beat
      // ends your turn and sends it — the same "stop and send" the mic
      // button/capture dock already do, just triggered by silence instead
      // of a click. Scoped to the composer (never journal/file/note/memory
      // dictation, where a mid-thought pause must not auto-cut you off).
      const autoSend = owner === "composer" && s.handsFree;
      const tapDown = await createPcmTap(
        mic,
        autoSend ? withSilenceGate(push, () => s.dictStreamRef.current?.()) : push,
      );
      return { mic, session, tapDown };
    } catch (e) {
      mic.getTracks().forEach((t) => t.stop());
      session?.cancel();
      reportDictationSetupFailure(e);
      return null;
    }
  }

  function reportDictationSetupFailure(error: unknown) {
    if (isMissingSttModel(error)) {
      s.setDictState("idle");
      s.setDictOwner(null);
      showMissingSttModelToast();
      return;
    }
    failDictation(`Dictation failed: ${error}`);
  }

  function isMissingSttModel(error: unknown): boolean {
    return String(error).includes("STT_MODEL_MISSING");
  }

  function showMissingSttModelToast() {
    s.pushToast(
      "error",
      "Download the voice model first, in Settings → Model → Dictation.",
      { label: "Open Settings", run: () => s.setShowSettings(true) },
    );
  }

  function failDictation(message: string) {
    s.setDictState("idle");
    s.setDictOwner(null);
    s.pushToast("error", message);
  }

  function stopDictation(
    resources: DictationResources,
    sink: (text: string) => void | Promise<void>,
    onPartial?: (text: string) => void,
  ) {
    s.dictStreamRef.current = null;
    s.setDictState("busy");
    void finishDictation(resources, sink, onPartial);
  }

  async function finishDictation(
    { mic, session, tapDown }: DictationResources,
    sink: (text: string) => void | Promise<void>,
    onPartial?: (text: string) => void,
  ) {
    try {
      // Teardown AWAITS the final flush, so the socket's Stop message is
      // ordered after the last samples and the closing word is not clipped.
      await tapDown();
      mic.getTracks().forEach((t) => t.stop());
      const raw = (await session.stop()).trim();
      if (!raw) {
        onPartial?.(""); // wipe any painted partials
        s.pushToast("info", "No speech detected.");
        return;
      }
      await sink(await shapedDictation(raw));
    } catch (e) {
      onPartial?.("");
      s.pushToast("error", `Dictation failed: ${e}`);
    } finally {
      s.setDictPartial("");
      s.setDictState("idle");
      s.setDictOwner(null);
    }
  }

  async function shapedDictation(raw: string): Promise<string> {
    try {
      const [translate, mode] = await Promise.all([
        api.getSetting("dict_translate"),
        api.getSetting("dict_mode"),
      ]);
      if (!shouldShapeDictation(translate, mode)) return raw;
      return shapedTranscript(raw, translate, mode);
    } catch (e) {
      s.pushToast("info", `Kept the exact transcript — ${e}`);
      return raw;
    }
  }

  function shouldShapeDictation(
    translate: string | null,
    mode: string | null,
  ): boolean {
    return translate === "on" || Boolean(mode && mode !== "off");
  }

  async function shapedTranscript(
    raw: string,
    translate: string | null,
    mode: string | null,
  ): Promise<string> {
    return (await api.shapeText(raw, translate === "on", mode || "off")).trim() || raw;
  }

  function micState(owner: string) {
    const active = s.dictOwner === owner ? s.dictState : "idle";
    return {
      cls: active,
      title:
        active === "recording"
          ? "Stop recording"
          : active === "busy"
            ? "Transcribing…"
            : active === "preparing"
              ? "Preparing the microphone…"
              : "Dictate (transcribed on this Mac)",
      disabled: s.dictState !== "idle" && s.dictOwner !== owner,
    };
  }

  function recordVoiceNote() {
    void beginRecording("note", async (blob, ext) => {
      const stamp = new Date()
        .toLocaleString([], { dateStyle: "short", timeStyle: "short" })
        .replace(/[/:]/g, ".");
      const b64 = await fileToBase64(new File([blob], `note.${ext}`));
      await api.importAudioBytes(`Voice note ${stamp}.${ext}`, b64);
      s.setFiles(await api.listFiles());
      s.pushToast("success", "Voice note saved — transcript is being written…");
    });
  }

  function dictateJournal() {
    dictateTo("journal", async (text) => {
      const today = new Date().toISOString().slice(0, 10);
      const name = `Journal ${today}.md`;
      const existing = s.files.find((f) => f.name === name);
      if (existing) {
        const c = await api.getFileContent(existing.id);
        await api.updateFileContent(
          existing.id,
          `${(c.text ?? "").replace(/\s+$/, "")}\n\n${text}\n`,
        );
      } else {
        const meta = await api.saveGeneratedFile(
          name,
          `# Journal — ${today}\n\n${text}\n`,
        );
        let folder = s.folders.find((f) => f.name === "Journal");
        if (!folder) folder = await api.createFolder("Journal");
        await api.moveFileToFolder(meta.id, folder.id);
        s.setFolders(await api.listFolders());
      }
      s.setFiles(await api.listFiles());
      s.pushToast("success", "Journal updated.");
    });
  }

  function dictateIntoFile() {
    if (!s.openFile) return;
    const id = s.openFile.id;
    dictateTo("file", async (text) => {
      // Re-read at WRITE time, never the snapshot taken when the microphone
      // opened: speaking takes seconds, and anything the user, the AI, a
      // workflow or a script wrote to the file meanwhile would otherwise be
      // rolled back by our write (same doctrine as dictateJournal).
      const current = (await api.getFileContent(id)).text ?? "";
      await api.updateFileContent(
        id,
        current ? `${current.replace(/\s+$/, "")}\n\n${text}\n` : `${text}\n`,
      );
      await viewFile(id);
      s.pushToast("success", "Added your words to the file.");
    });
  }

  /** Abandon the running model download. `pull_model` registers its cancel flag
   *  under `pull:<model name>` in the SAME registry chat's Stop uses, so this is
   *  the whole wiring. Without it the chat pane's first-run "Pick a model to
   *  download" card — the biggest download most users ever start here — could
   *  only be escaped by quitting the app. */
  async function stopModelPull() {
    const name = s.pullingModelRef.current;
    if (!name) return;
    s.setPullStatus("stopping…");
    try {
      await api.cancelAsk(`pull:${name}`);
    } catch {
      // Nothing to stop (it just finished, or the flag is already gone). The
      // pull's own result is the honest answer either way.
    }
  }

  async function downloadModel(name: string) {
    if (s.pullingModel) return;
    s.setPullingModel(true);
    s.pullingModelRef.current = name;
    s.setPullError("");
    s.setPullStatus("starting…");
    s.setPullPercent(null);
    try {
      await api.pullModel(name);
      refreshAi();
    } catch (e) {
      // A download YOU stopped is not a failure and must not be shown in red as
      // one. `ollama::PULL_CANCELLED` is a sentence, so match its wording.
      const msg = String(e);
      if (msg.includes("download was cancelled")) {
        s.setPullStatus("Download stopped. Nothing was installed.");
      } else {
        s.setPullError(msg);
        s.setPullStatus("");
      }
    } finally {
      s.pullingModelRef.current = null;
      s.setPullingModel(false);
      s.setPullPercent(null);
    }
  }

  async function pickAndDownload(name: string) {
    if (s.pullingModel) return;
    await changeModel(name);
    await downloadModel(name);
  }

  async function getOllama() {
    try {
      await openUrl("https://ollama.com/download");
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  async function openOllamaApp() {
    try {
      await api.openOllama();
    } catch (e) {
      s.pushToast("error", String(e));
      return;
    }
    window.clearInterval(s.recheckTimer.current);
    // Ollama's first launch loads a model server and can take well over the 9
    // seconds this used to allow. Worse, it gave up in SILENCE: the banner went
    // on saying "not running" with nothing to explain that the app had simply
    // stopped looking, so the only cure was clicking the same button again.
    // Wait long enough for a genuine cold start, then SAY that we stopped.
    const MAX_TRIES = 20; // × 1500ms = 30s
    let tries = 0;
    const stop = (message?: string) => {
      window.clearInterval(s.recheckTimer.current);
      if (message) s.pushToast("info", message);
    };
    s.recheckTimer.current = window.setInterval(async () => {
      tries++;
      try {
        const st = await api.aiStatus();
        s.setAi(st);
        s.setModel((current) => current || st.defaultModel);
        if (st.running) stop();
        else if (tries >= MAX_TRIES)
          stop(
            "Ollama still isn't answering after 30 seconds. It may still be starting — press Open Ollama again to keep checking.",
          );
      } catch {
        if (tries >= MAX_TRIES)
          stop(
            "Couldn't tell whether Ollama started. Press Open Ollama again to check.",
          );
      }
    }, 1500);
  }

  const {
    startLiveRecording,
    pauseLiveRecording,
    resumeLiveRecording,
    stopLiveRecording,
  } = makeLiveRecordingActions(s, {
    viewFile,
    isMissingSttModel,
    showMissingSttModelToast,
  });

  return {
    refreshAi, beginRecording, dictateTo, micState, recordVoiceNote,
    dictateJournal, dictateIntoFile, downloadModel, pickAndDownload, stopModelPull,
    getOllama, openOllamaApp,
    startLiveRecording, pauseLiveRecording, resumeLiveRecording, stopLiveRecording,
  };
}
