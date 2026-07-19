import { Dispatch, SetStateAction } from "react";
import { AiActionDef, api, FileTarget, studioPrompts } from "../api";
import { resolveRefs } from "./composer";
import { runGuarded, tryToast } from "./guard";
import { WSState } from "./state";

/** Studio Shelf + whole-room AI actions + room summary. Studio/summary results
 * now open themselves via the terminal job-progress event, so this only needs
 * `openOllamaApp` (recording) as the "model is down" remediation. */
export function makeStudioActions(
  s: WSState,
  deps: {
    viewFile: (id: string, target?: FileTarget) => Promise<void>;
    openOllamaApp: () => Promise<void>;
  },
) {
  const { openOllamaApp } = deps;

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
    await runGuarded(
      s,
      async () => {
        await api.startDeepSummary();
        await refreshJobs();
        s.pushToast(
          "info",
          "Summarizing in the background — you can keep working.",
        );
      },
      {
        begin: () => s.setSummaryStarting(true),
        finish: () => s.setSummaryStarting(false),
        onError: refreshJobs,
        openOllamaApp,
      },
    );
  }

  /** Pause a running job — it checkpoints and the card offers Resume. */
  async function pauseJob(id: string) {
    await tryToast(s, () => api.cancelJob(id));
  }

  /** Continue a paused/errored job from its checkpoint. */
  async function resumeJob(id: string) {
    await tryToast(s, () => api.resumeJob(id), refreshJobs);
  }

  /** Remove a job card (stops it first if it happens to be running). */
  async function dismissJob(id: string) {
    await tryToast(s, () => api.deleteJob(id));
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

  /** Kick off a Studio artifact as a background job (like the room summary): the
   *  sidebar card shows progress and the finished HTML opens itself via the
   *  terminal job-progress event. Stop/Resume live on the card, so there's no
   *  in-modal running state anymore. */
  async function runStudio(
    kind: "flashcards" | "mindmap" | "podcast",
    scope?: string,
    instructions?: string,
    refs?: string[],
  ) {
    await runGuarded(
      s,
      async () => {
        await api.startStudioJob(kind, scope, instructions, refs);
        await refreshJobs();
        s.pushToast("info", "Generating in the background — you can keep working.");
      },
      { onError: refreshJobs, openOllamaApp },
    );
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

  /** Drop an @-mention into a prompt modal's textarea at the caret. The Studio
   *  and AI-action modals share one textarea ref and one autocomplete — they
   *  differ only in which prompt they are editing. */
  function acceptMention<T extends { text: string }>(
    insert: string,
    prompt: T | null,
    setPrompt: Dispatch<SetStateAction<T | null>>,
  ) {
    const el = s.studioPromptRef.current;
    const caret = el ? el.selectionStart : (prompt?.text.length ?? 0);
    const start = s.studioAc ? s.studioAc.start : caret;
    setPrompt((p) =>
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
    if (!s.studioPrompt) return;
    const p = s.studioPrompt;
    const { refIds } = resolveRefs(p.text, s.files, s.folders);
    // Close the modal immediately — it's a background job now; the sidebar card
    // takes over and the finished file opens itself.
    s.setStudioPrompt(null);
    await runStudio(p.kind, p.scope, p.text, refIds);
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

  async function runAiActionFromModal() {
    if (!s.aiPrompt || s.aiBusy) return;
    const p = s.aiPrompt;
    // ADD-27: "translate" carries the target language in the question field.
    if ((p.def.needsQuestion || p.def.needsLanguage) && !p.question.trim()) return;
    const { refIds } = resolveRefs(p.text, s.files, s.folders);
    const combined = [...(p.refs ?? []), ...refIds];
    const refs = combined.length ? Array.from(new Set(combined)) : null;
    await runGuarded(
      s,
      async () => {
        await api.aiAction(p.def.id, {
          scope: p.scope,
          refs,
          instructions: p.text,
          question: p.def.needsQuestion || p.def.needsLanguage ? p.question : null,
        });
        s.setFiles(await api.listFiles());
        s.setAiPrompt(null);
      },
      {
        begin: () => s.setAiBusy(true),
        finish: () => s.setAiBusy(false),
        openOllamaApp,
      },
    );
  }

  return {
    openStudioPrompt, runStudio, studioAcItems,
    acceptMention, runStudioFromModal, loadAiActions, openAiAction,
    runAiActionFromModal,
    refreshJobs, startDeepSummary, pauseJob, resumeJob, dismissJob,
  };
}
