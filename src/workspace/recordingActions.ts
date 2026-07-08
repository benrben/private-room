import { openUrl } from "@tauri-apps/plugin-opener";
import { api, FileTarget } from "../api";
import { fileToBase64 } from "./composer";
import { WSState } from "./state";

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
    if (s.dictState === "busy") return;
    if (s.dictState === "recording") {
      if (s.dictOwner === owner) s.recorderRef.current?.stop();
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const name = (e as { name?: string })?.name || "";
      const msg =
        name === "NotFoundError" || name === "OverconstrainedError"
          ? "No microphone found — plug one in or check your input device."
          : name === "NotReadableError" || name === "AbortError"
            ? "The microphone is busy in another app — close it and try again."
            : "Microphone blocked — allow Private Room in System Settings → Privacy & Security → Microphone, then reopen the app.";
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

  function dictateTo(owner: string, sink: (text: string) => void | Promise<void>) {
    void beginRecording(owner, async (blob, ext) => {
      const b64 = await fileToBase64(new File([blob], `dictation.${ext}`));
      let text = (await api.transcribeAudio(b64, ext, false)).trim();
      if (!text) {
        s.pushToast("info", "No speech detected.");
        return;
      }
      try {
        const [translate, mode] = await Promise.all([
          api.getSetting("dict_translate"),
          api.getSetting("dict_mode"),
        ]);
        if (translate === "on" || (mode && mode !== "off")) {
          text = (await api.shapeText(text, translate === "on", mode || "off")).trim() || text;
        }
      } catch (e) {
        s.pushToast("info", `Kept the exact transcript — ${e}`);
      }
      await sink(text);
    });
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
    const current = s.openFile.content.text ?? "";
    dictateTo("file", async (text) => {
      await api.updateFileContent(
        id,
        current ? `${current.replace(/\s+$/, "")}\n\n${text}\n` : `${text}\n`,
      );
      await viewFile(id);
      s.pushToast("success", "Added your words to the file.");
    });
  }

  async function downloadModel(name: string) {
    if (s.pullingModel) return;
    s.setPullingModel(true);
    s.setPullError("");
    s.setPullStatus("starting…");
    s.setPullPercent(null);
    try {
      await api.pullModel(name);
      refreshAi();
    } catch (e) {
      s.setPullError(String(e));
    } finally {
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
    let tries = 0;
    s.recheckTimer.current = window.setInterval(async () => {
      tries++;
      try {
        const st = await api.aiStatus();
        s.setAi(st);
        s.setModel((current) => current || st.defaultModel);
        if (st.running || tries >= 6) window.clearInterval(s.recheckTimer.current);
      } catch {
        if (tries >= 6) window.clearInterval(s.recheckTimer.current);
      }
    }, 1500);
  }

  return {
    refreshAi, beginRecording, dictateTo, micState, recordVoiceNote,
    dictateJournal, dictateIntoFile, downloadModel, pickAndDownload,
    getOllama, openOllamaApp,
  };
}
