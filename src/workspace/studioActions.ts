import {
  AiActionDef,
  api,
  FileTarget,
  generatePodcastScript,
  studioFlashcards,
  studioMindmap,
  studioPrompts,
} from "../api";
import { isOllamaDown, resolveRefs } from "./composer";
import { WSState } from "./state";

/** Studio Shelf + whole-room AI actions + room summary. Cross-hook: `viewFile`
 * (files) opens the generated file; `openOllamaApp` (recording) is the "model is
 * down" remediation. */
export function makeStudioActions(
  s: WSState,
  deps: {
    viewFile: (id: string, target?: FileTarget) => Promise<void>;
    openOllamaApp: () => Promise<void>;
  },
) {
  const { viewFile, openOllamaApp } = deps;

  async function summarizeRoom() {
    if (s.summarizing) return;
    s.setSummarizing(true);
    s.setSummarizeProgress("");
    try {
      const result = await api.summarizeRoom();
      s.setFiles(await api.listFiles());
      viewFile(result.id);
      s.pushToast("success", "Room summary is ready.");
    } catch (e) {
      const msg = String(e);
      if (isOllamaDown(msg)) {
        s.pushToast(
          "error",
          "Ollama is not running. Start the Ollama app, then try again.",
          { label: "Open Ollama", run: openOllamaApp },
        );
      } else {
        s.pushToast("error", msg);
      }
    } finally {
      s.setSummarizing(false);
      s.setSummarizeProgress("");
    }
  }

  // ---- ADD-30: durable background jobs (the sidebar cards) ----

  /** Reload the cards: every job that isn't finished. */
  async function refreshJobs() {
    try {
      const all = await api.listJobs();
      s.setJobs(all.filter((j) => j.status !== "done"));
    } catch {
      /* room closing — the panel just stays as it was */
    }
  }

  /** Kick off the room deep-summary as a background job. The sidebar card
   *  shows progress; the finished summary opens itself. The optimistic
   *  `summaryStarting` flag makes the click acknowledge instantly even when the
   *  backend takes seconds to resolve on a cold local model. */
  async function startDeepSummary() {
    if (s.summaryStarting) return;
    // Never a silent no-op: if a summary job already exists, act on it instead
    // of ignoring the click. An in-flight one is surfaced; a paused/errored one
    // is resumed rather than duplicated.
    const existing = s.jobs.find((j) => j.kind === "deep_summary");
    if (existing) {
      if (existing.status === "running" || existing.status === "queued") {
        s.pushToast("info", "Already summarizing — see the card in the sidebar.");
        return;
      }
      await resumeJob(existing.id);
      s.pushToast("info", "Resuming the room summary…");
      return;
    }
    s.setSummaryStarting(true);
    try {
      await api.startDeepSummary();
      await refreshJobs();
      s.pushToast(
        "info",
        "Summarizing in the background — you can keep working.",
      );
    } catch (e) {
      const msg = String(e);
      if (isOllamaDown(msg)) {
        s.pushToast(
          "error",
          "Ollama is not running. Start the Ollama app, then try again.",
          { label: "Open Ollama", run: openOllamaApp },
        );
      } else {
        s.pushToast("error", msg);
      }
      await refreshJobs();
    } finally {
      s.setSummaryStarting(false);
    }
  }

  /** Pause a running job — it checkpoints and the card offers Resume. */
  async function pauseJob(id: string) {
    try {
      await api.cancelJob(id);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  /** Continue a paused/errored job from its checkpoint. */
  async function resumeJob(id: string) {
    try {
      await api.resumeJob(id);
      await refreshJobs();
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  /** Remove a job card (stops it first if it happens to be running). */
  async function dismissJob(id: string) {
    try {
      await api.deleteJob(id);
    } catch (e) {
      s.pushToast("error", String(e));
    }
    s.setJobProgress((p) => {
      const next = { ...p };
      delete next[id];
      return next;
    });
    await refreshJobs();
  }

  async function openStudioPrompt(
    kind: "flashcards" | "mindmap" | "podcast",
    scope?: string,
  ) {
    if (s.studioBusy) return;
    let d = s.studioDefaults;
    if (!d) {
      try {
        d = await studioPrompts();
        s.setStudioDefaults(d);
      } catch {
        d = null;
      }
    }
    s.setStudioAc(null);
    s.setStudioPrompt({ kind, scope, text: d ? d[kind] : "" });
  }

  async function runStudio(
    kind: "flashcards" | "mindmap" | "podcast",
    scope?: string,
    instructions?: string,
    refs?: string[],
  ) {
    if (s.studioBusy) return;
    // ADD-31: register a stoppable operation — the modal's Stop button flips
    // this id's cancel flag through the same channel as chat's Stop.
    const opId = crypto.randomUUID();
    s.setStudioOpId(opId);
    s.setStudioStep(null);
    s.setStudioBusy(kind);
    try {
      const meta =
        kind === "flashcards"
          ? await studioFlashcards(scope, instructions, refs, opId)
          : kind === "mindmap"
            ? await studioMindmap(scope, instructions, refs, opId)
            : await generatePodcastScript(scope, instructions, refs, opId);
      s.setFiles(await api.listFiles());
      viewFile(meta.id);
      s.pushToast("success", `Created "${meta.name}".`);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("Stopped.")) {
        s.pushToast("info", "Stopped — nothing was saved.");
      } else if (isOllamaDown(msg)) {
        s.pushToast(
          "error",
          "Ollama is not running. Start the Ollama app, then try again.",
          { label: "Open Ollama", run: openOllamaApp },
        );
      } else {
        s.pushToast("error", msg);
      }
    } finally {
      s.setStudioBusy(null);
      s.setStudioOpId(null);
      s.setStudioStep(null);
    }
  }

  /** ADD-31: stop the running Studio generation (keeps the prompt for retry). */
  function stopStudio() {
    if (s.studioOpId) void api.cancelAsk(s.studioOpId);
  }

  function studioAcItems() {
    if (!s.studioAc) return [];
    const q = s.studioAc.query;
    const folderItems = s.folders
      .filter((f) => f.name.toLowerCase().includes(q))
      .map((f) => ({
        key: `fo-${f.id}`,
        label: `@${f.name}/`,
        hint: "folder",
        insert: `@${f.name}/ `,
      }));
    const fileItems = s.files
      .filter((f) => f.name.toLowerCase().includes(q))
      .slice(0, 8)
      .map((f) => ({
        key: `fi-${f.id}`,
        label: `@${f.name}`,
        hint: f.mimeType,
        insert: `@${f.name} `,
      }));
    return [...folderItems, ...fileItems].slice(0, 10);
  }

  function acceptStudioMention(insert: string) {
    const el = s.studioPromptRef.current;
    const caret = el ? el.selectionStart : (s.studioPrompt?.text.length ?? 0);
    const start = s.studioAc ? s.studioAc.start : caret;
    s.setStudioPrompt((p) =>
      p
        ? { ...p, text: p.text.slice(0, start) + insert + p.text.slice(caret) }
        : p,
    );
    s.setStudioAc(null);
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        const pos = start + insert.length;
        el.setSelectionRange(pos, pos);
      }
    });
  }

  async function runStudioFromModal() {
    if (!s.studioPrompt || s.studioBusy) return;
    const p = s.studioPrompt;
    const { refIds } = resolveRefs(p.text, s.files, s.folders);
    await runStudio(p.kind, p.scope, p.text, refIds);
    s.setStudioPrompt(null);
  }

  async function loadAiActions(): Promise<AiActionDef[]> {
    if (s.aiActionDefs) return s.aiActionDefs;
    try {
      const defs = await api.aiActionPrompts();
      s.setAiActionDefs(defs);
      return defs;
    } catch (e) {
      s.pushToast("error", String(e));
      return [];
    }
  }

  function openAiAction(
    def: AiActionDef,
    scope: string | null,
    refs: string[] | null,
  ) {
    if (s.aiBusy) return;
    s.setStudioAc(null);
    s.setAiPrompt({ def, scope, refs, text: def.defaultPrompt, question: "" });
  }

  function acceptAiMention(insert: string) {
    const el = s.studioPromptRef.current;
    const caret = el ? el.selectionStart : (s.aiPrompt?.text.length ?? 0);
    const start = s.studioAc ? s.studioAc.start : caret;
    s.setAiPrompt((p) =>
      p
        ? { ...p, text: p.text.slice(0, start) + insert + p.text.slice(caret) }
        : p,
    );
    s.setStudioAc(null);
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        const pos = start + insert.length;
        el.setSelectionRange(pos, pos);
      }
    });
  }

  async function runAiActionFromModal() {
    if (!s.aiPrompt || s.aiBusy) return;
    const p = s.aiPrompt;
    // ADD-27: "translate" carries the target language in the question field.
    if ((p.def.needsQuestion || p.def.needsLanguage) && !p.question.trim()) return;
    const { refIds } = resolveRefs(p.text, s.files, s.folders);
    const combined = [...(p.refs ?? []), ...refIds];
    const refs = combined.length ? Array.from(new Set(combined)) : null;
    s.setAiBusy(true);
    try {
      await api.aiAction(p.def.id, {
        scope: p.scope,
        refs,
        instructions: p.text,
        question: p.def.needsQuestion || p.def.needsLanguage ? p.question : null,
      });
      s.setFiles(await api.listFiles());
      s.setAiPrompt(null);
    } catch (e) {
      const msg = String(e);
      if (isOllamaDown(msg)) {
        s.pushToast(
          "error",
          "Ollama is not running. Start the Ollama app, then try again.",
          { label: "Open Ollama", run: openOllamaApp },
        );
      } else {
        s.pushToast("error", msg);
      }
    } finally {
      s.setAiBusy(false);
    }
  }

  return {
    summarizeRoom, openStudioPrompt, runStudio, stopStudio, studioAcItems,
    acceptStudioMention, runStudioFromModal, loadAiActions, openAiAction,
    acceptAiMention, runAiActionFromModal,
    refreshJobs, startDeepSummary, pauseJob, resumeJob, dismissJob,
  };
}
