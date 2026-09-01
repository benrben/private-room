import { Dispatch, SetStateAction } from "react";
import { AiActionDef, api, FileTarget, studioPrompts } from "../api";
import { resolveRefs } from "./composer";
import { runGuarded, tryToast } from "./guard";
import { WSState } from "./state";

type AiActionPrompt = NonNullable<WSState["aiPrompt"]>;

function aiActionQuestionIsReady(prompt: AiActionPrompt): boolean {
  const needsAnswer = prompt.def.needsQuestion || prompt.def.needsLanguage;
  return !needsAnswer || Boolean(prompt.question.trim());
}

function canRunAiAction(
  prompt: AiActionPrompt | null,
  isBusy: boolean,
): prompt is AiActionPrompt {
  return prompt !== null && !isBusy && aiActionQuestionIsReady(prompt);
}

function uniqueAiActionRefs(
  savedRefs: string[] | null,
  mentionedRefs: string[],
): string[] | null {
  const refs = Array.from(new Set([...(savedRefs ?? []), ...mentionedRefs]));
  return refs.length ? refs : null;
}

function aiActionQuestion(prompt: AiActionPrompt): string | null {
  return prompt.def.needsQuestion || prompt.def.needsLanguage
    ? prompt.question
    : null;
}

function aiActionOptions(
  prompt: AiActionPrompt,
  files: WSState["files"],
  folders: WSState["folders"],
  opId: string,
): Parameters<typeof api.aiAction>[1] {
  const { refIds } = resolveRefs(prompt.text, files, folders);
  return {
    scope: prompt.scope,
    refs: uniqueAiActionRefs(prompt.refs, refIds),
    instructions: prompt.text,
    question: aiActionQuestion(prompt),
    opId,
  };
}

function aiActionOpId(): string {
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

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

  // ---- ADD-30: durable background jobs (the cards in Activity) ----

  /** Reload the cards: EVERY job, finished ones included.
   *
   * Finished jobs used to be dropped here, which meant Activity could only ever
   * be a live manager — the moment work completed it vanished, and the room kept
   * no visible record that it had ever run. Decision #12 asks for both, so the
   * finished rows come through and `groupActivity` files them under history.
   * Callers that mean "is something in flight" must say so; see
   * `startDeepSummary` below, and `runningJobCount`. */
  async function refreshJobs() {
    try {
      s.setJobs(await api.listJobs());
    } catch {
      /* room closing — the panel just stays as it was */
    }
  }

  /** Kick off the room deep-summary as a background job. Its card in the
   *  assistant pane's Activity shows progress — the Library sidebar lists
   *  `create` jobs only, so no summary ever appears there. The finished summary
   *  opens itself. The optimistic `summaryStarting` flag makes the click
   *  acknowledge instantly even when the backend takes seconds to resolve on a
   *  cold local model. */
  async function startDeepSummary() {
    if (s.summaryStarting) return;
    // Never a silent no-op: if a summary job already exists, act on it instead
    // of ignoring the click. An in-flight one is surfaced; a paused/errored one
    // is resumed rather than duplicated.
    // Only an UNFINISHED summary job is a reason not to start a new one. Now
    // that `refreshJobs` keeps history, a summary that finished last week is in
    // this list too — resuming that instead of summarizing would be a click
    // that appears to do nothing.
    const existing = s.jobs.find(
      (j) => j.kind === "deep_summary" && j.status !== "done",
    );
    if (existing) {
      if (existing.status === "running" || existing.status === "queued") {
        s.pushToast("info", "Already summarizing — it's in Activity.");
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
   *  card in Activity shows progress and the finished HTML opens itself via the
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
    const p = s.aiPrompt;
    if (!canRunAiAction(p, s.aiBusy)) return;
    // The id Stop will use. Minted here, like a Studio build's, so the host can
    // register the run's cancel flag under it before the model call starts.
    const opId = aiActionOpId();
    const options = aiActionOptions(p, s.files, s.folders, opId);
    await runGuarded(
      s,
      async () => {
        await api.aiAction(p.def.id, options);
        s.setFiles(await api.listFiles());
        s.setAiPrompt(null);
      },
      {
        begin: () => {
          s.setAiBusy(true);
          s.setAiOpId(opId);
          s.setAiStopping(false);
        },
        finish: () => {
          s.setAiBusy(false);
          s.setAiOpId(null);
          s.setAiStopping(false);
        },
        openOllamaApp,
      },
    );
  }

  /** Stop a running AI action. The host drops the request, which is what
   *  actually ends the generation (the AI service abandons the work when its
   *  caller disconnects), and nothing is saved. The run's own error path closes
   *  the modal, so this only marks the button as pressed. */
  async function stopAiAction() {
    const opId = s.aiOpId;
    if (!opId || s.aiStopping) return;
    s.setAiStopping(true);
    try {
      await api.cancelAsk(opId);
    } catch (e) {
      // A Stop that did not land must not look like one that did.
      s.setAiStopping(false);
      s.pushToast("error", `Couldn't stop it: ${String(e)}`);
    }
  }

  return {
    openStudioPrompt, runStudio, studioAcItems,
    acceptMention, runStudioFromModal, loadAiActions, openAiAction,
    runAiActionFromModal, stopAiAction,
    refreshJobs, startDeepSummary, pauseJob, resumeJob, dismissJob,
  };
}
