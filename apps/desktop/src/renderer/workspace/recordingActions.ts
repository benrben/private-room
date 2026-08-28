import { openUrl } from "../platform";
import { api, FileTarget } from "../api";
import { fileToBase64 } from "./composer";
import {
  acquireMic,
  attachMicTap,
  createPcmTap,
  micConstraints,
  noteLiveStt,
  stopMicTap,
} from "./liveRec";
import { closeRecordingTransport, startRecordingTransport } from "./recordingTransport";
import { WSState } from "./state";
import { base64ToBytes } from "../viewers/util";
import { connectDictSession, type DictSession } from "./dictSession";

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
    if (s.dictState === "busy" || s.dictState === "preparing") return;
    if (s.dictState === "recording") {
      if (s.dictOwner === owner) s.recorderRef.current?.stop();
      return;
    }
    // Own the state BEFORE asking for the microphone: the permission dialog
    // or a slow device can take seconds, and the capture dock must already be
    // saying "Preparing microphone…" instead of the click doing nothing.
    s.setDictOwner(owner);
    s.setDictState("preparing");
    let stream: MediaStream;
    try {
      // Same constraints as a recording: `audio: true` lets WebKit turn on
      // voice processing (and its gain riding) by default, which other apps on
      // the same microphone hear as their volume dropping (GH #4).
      stream = await navigator.mediaDevices.getUserMedia({
        audio: micConstraints(),
      });
    } catch (e) {
      s.setDictState("idle");
      s.setDictOwner(null);
      const name = (e as { name?: string })?.name || "";
      const msg =
        name === "NotFoundError" || name === "OverconstrainedError"
          ? "No microphone found — plug one in or check your input device."
          : name === "NotReadableError" || name === "AbortError"
            ? "The microphone is busy in another app — close it and try again."
            : "Microphone blocked — allow Arcelle in System Settings → Privacy & Security → Microphone, then reopen the app.";
      s.pushToast("error", msg);
      return;
    }
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
    void (async () => {
      const fail = (msg: string) => {
        s.setDictState("idle");
        s.setDictOwner(null);
        s.pushToast("error", msg);
      };
      let mic: MediaStream;
      try {
        mic = await acquireMic();
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
        return;
      }
      let session: DictSession | null = null;
      let tapDown: (() => Promise<void>) | null = null;
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
        tapDown = await createPcmTap(
          mic,
          autoSend ? withSilenceGate(push, () => s.dictStreamRef.current?.()) : push,
        );
      } catch (e) {
        mic.getTracks().forEach((t) => t.stop());
        session?.cancel();
        if (String(e).includes("STT_MODEL_MISSING")) {
          s.setDictState("idle");
          s.setDictOwner(null);
          s.pushToast(
            "error",
            "Download the voice model first, in Settings → Model → Dictation.",
            { label: "Open Settings", run: () => s.setShowSettings(true) },
          );
        } else {
          fail(`Dictation failed: ${e}`);
        }
        return;
      }
      s.setDictState("recording");
      s.dictStreamRef.current = () => {
        s.dictStreamRef.current = null;
        s.setDictState("busy");
        void (async () => {
          try {
            // Teardown AWAITS the final flush, so the socket's Stop message is
            // ordered after the last samples and the closing word is not clipped.
            await tapDown!();
            mic.getTracks().forEach((t) => t.stop());
            const raw = (await session!.stop()).trim();
            if (!raw) {
              onPartial?.(""); // wipe any painted partials
              s.pushToast("info", "No speech detected.");
              return;
            }
            let text = raw;
            try {
              const [translate, mode] = await Promise.all([
                api.getSetting("dict_translate"),
                api.getSetting("dict_mode"),
              ]);
              if (translate === "on" || (mode && mode !== "off")) {
                text =
                  (await api.shapeText(raw, translate === "on", mode || "off")).trim() || raw;
              }
            } catch (e) {
              s.pushToast("info", `Kept the exact transcript — ${e}`);
            }
            await sink(text);
          } catch (e) {
            onPartial?.("");
            s.pushToast("error", `Dictation failed: ${e}`);
          } finally {
            s.setDictPartial("");
            s.setDictState("idle");
            s.setDictOwner(null);
          }
        })();
      };
    })();
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

  // ---- ADD-27: the live Recording file ----------------------------------
  // The session is workspace-wide (it must survive switching files), so its
  // lifecycle lives here, not in the view: backend engine via rec_* commands
  // + the module-level mic tap (liveRec.ts).

  async function startLiveRecording(
    fileId?: string,
    opts?: { systemAudio?: boolean; liveTranslate?: string | null },
  ) {
    if (s.recLive) {
      s.pushToast("info", "A recording is already running.");
      await viewFile(s.recLive.fileId);
      return;
    }
    // Open the microphone BEFORE anything else: WebKit grants capture only
    // while the click that triggered this is still "active", and rec_start
    // below costs several IPC round-trips. Asking afterwards fails with
    // NotAllowedError even though permission was granted long ago.
    const withSystem = opts?.systemAudio ?? true;
    let mic: MediaStream | null = null;
    // Held, not announced: what a dead microphone COSTS depends on whether the
    // Mac's audio lane actually comes up, and no lane exists until rec_start
    // has run. Announcing it here promised a recording that a denied Screen
    // Recording permission (or a failed start) never made.
    let micError: string | null = null;
    try {
      mic = await acquireMic();
    } catch (e) {
      micError = e instanceof Error ? e.message : String(e);
    }
    let res;
    try {
      res = await api.recStart({
        fileId: fileId ?? null,
        systemAudio: withSystem,
        liveTranslate: opts?.liveTranslate ?? null,
      });
    } catch (e) {
      mic?.getTracks().forEach((t) => t.stop());
      if (String(e).includes("STT_MODEL_MISSING")) {
        s.pushToast(
          "error",
          "Download the voice model first, in Settings → Model → Dictation.",
          { label: "Open Settings", run: () => s.setShowSettings(true) },
        );
      } else {
        s.pushToast("error", String(e));
      }
      return;
    }
    // Past this line the engine IS recording. Nothing below may report itself
    // as a failure to start, and nothing below may tear the microphone down.
    // The engine always starts with live transcription ON — sync the
    // session-scoped UI mirror (a previous session may have turned it off).
    startRecordingTransport(res.sessionUrl, res.fileId);
    noteLiveStt(true);
    s.setRecLive({ fileId: res.fileId, status: "recording" });
    if (micError) {
      // The meeting-audio tap is brought up on a helper thread and takes
      // SECONDS to land (recording.rs `sys_tap_starting`); its lane reads
      // "off" until then. So "on" is not yet a fact here and its absence
      // proves nothing — only a lane that has already errored, or one that
      // was never asked for, means nothing at all is being captured.
      // `resumeLiveRecording` asks the same question of a session whose lanes
      // are long since settled, which is why it can read the lane directly.
      const live = await api.recLiveStatus().catch(() => null);
      const nothingCaptured = !withSystem || live?.sys?.[0] === "error";
      // The remedy belongs only to the case it actually fixes. With the box
      // ticked there is nothing left to tick: the lane was asked for and did
      // not come up (in practice the Screen Recording permission), which
      // RecordingView's own banner names, with the settings button beside it.
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
    if (mic) {
      try {
        await attachMicTap(mic);
      } catch (e) {
        mic.getTracks().forEach((t) => t.stop());
        s.pushToast(
          "error",
          `The recording started, but your microphone could not be attached, so your voice is not being captured: ${e}`,
        );
      }
    }
    try {
      s.setFiles(await api.listFiles());
      await viewFile(res.fileId);
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
    // Same rule as start: the microphone first, while the click still counts.
    let mic: MediaStream | null = null;
    try {
      mic = await acquireMic();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Ask the live session whether the Mac's audio lane is actually on
      // ("on" | "error" | "off") rather than assuming it — with it off, a dead
      // microphone means nothing is being captured at all.
      const live = await api.recLiveStatus().catch(() => null);
      s.pushToast(
        "error",
        live?.sys?.[0] === "on"
          ? `${msg} (the Mac's audio keeps recording)`
          : `${msg} — and the Mac's audio is not being recorded, so nothing at all is being captured.`,
      );
    }
    try {
      await api.recResume();
      if (mic) await attachMicTap(mic);
    } catch (e) {
      mic?.getTracks().forEach((t) => t.stop());
      s.pushToast("error", String(e instanceof Error ? e.message : e));
    }
  }

  async function stopLiveRecording() {
    stopMicTap();
    const fileId = s.recLive?.fileId;
    s.setRecLive((r) => (r ? { ...r, status: "saving" } : r));
    try {
      // What was actually written decides the sentence: live transcription can
      // be switched off mid-session, and a session where nobody spoke has no
      // segments either. Claiming a transcript that isn't in the file is the
      // one thing this receipt must not do.
      const meta = await api.recStop();
      // The receipt carries a direct way to the output — success must never
      // require hunting the sidebar for a new row.
      s.pushToast(
        "success",
        meta.segments.length > 0
          ? "Recording saved — transcript included."
          : "Recording saved. No transcript was written — use Re-transcribe to build one.",
        fileId ? { label: "Open", run: () => void viewFile(fileId) } : undefined,
      );
    } catch (e) {
      s.pushToast("error", String(e));
    } finally {
      closeRecordingTransport();
    }
    s.setRecLive(null);
    try {
      s.setFiles(await api.listFiles());
      // Refresh the open view so the player gets the freshly written audio.
      if (fileId && s.openFileRef.current?.id === fileId) await viewFile(fileId);
    } catch (e) {
      // Every caller runs this as `void stopLiveRecording()`, so an escaping
      // rejection here would be an unhandled one — with a success toast already
      // on screen and a sidebar that never gained the row.
      s.pushToast("error", `The recording was saved, but the room could not be refreshed: ${e}`);
    }
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

  return {
    refreshAi, beginRecording, dictateTo, micState, recordVoiceNote,
    dictateJournal, dictateIntoFile, downloadModel, pickAndDownload, stopModelPull,
    getOllama, openOllamaApp,
    startLiveRecording, pauseLiveRecording, resumeLiveRecording, stopLiveRecording,
  };
}
