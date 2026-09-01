import { useEffect, useState } from "react";
import { openUrl } from "../platform";
import { api, AppDiag } from "../api";
import { SparklesIcon } from "../icons";
import { useFocusTrap } from "../settings/useFocusTrap";
import { WSState } from "./state";

/** How long a prefilled new-issue link may be. GitHub answers 414 well before
 * this, and browsers have their own ceilings; staying under 6 KB keeps the
 * whole report intact on every path that does work. */
const MAX_ISSUE_URL = 6000;

interface FeedbackDraftFields {
  raw: string;
  title: string;
  body: string;
  drafting: boolean;
  setRaw(value: string): void;
  setTitle(value: string): void;
  setBody(value: string): void;
  draftWithAi(): void;
}

function diagnosticLine(diag: AppDiag | null): string {
  return diag === null ? "" : `Arcelle ${diag.version} · ${diag.os} (${diag.arch})`;
}

function errorBlock(includeErrors: boolean, recentErrors: readonly { at: string; text: string }[]): string {
  if (!includeErrors || recentErrors.length === 0) return "";
  const entries = recentErrors.map((error) => `- \`${error.at}\` ${error.text}`).join("\n");
  return `\n\n### Error messages shown as pop-ups this session\n\n${entries}`;
}

function issueBody(body: string, includeDiag: boolean, diagLine: string, errors: string): string {
  const draft = body.trim();
  if (!includeDiag || !diagLine) return draft + errors;
  return `${draft}\n\n---\n${diagLine}${errors}`;
}

function readyToOpen(title: string, body: string): boolean {
  return title.trim().length > 0 && body.trim().length > 0;
}

function FeedbackDraftInput(fields: FeedbackDraftFields) {
  return (
    <div className="feedback-raw">
      <textarea
        className="studio-prompt-input"
        placeholder="What happened, in your own words — any language…"
        rows={3}
        dir="auto"
        value={fields.raw}
        disabled={fields.drafting}
        // No `autoFocus`: React applies it during commit, BEFORE the trap's
        // effect reads `document.activeElement`, so the trap remembered this
        // textarea as the trigger and had nothing to hand focus back to on close.
        onChange={(event) => fields.setRaw(event.target.value)}
      />
      <button
        className="subtle btn-ic"
        disabled={fields.drafting || !fields.raw.trim()}
        title="The local model turns your words into a clear issue title and body — nothing leaves this Mac"
        onClick={fields.draftWithAi}
      >
        {fields.drafting ? "Drafting…" : (<><SparklesIcon size={14} /> Draft it for me</>)}
      </button>
    </div>
  );
}

function FeedbackIssueFields(fields: FeedbackDraftFields) {
  return (
    <>
      <input
        className="studio-prompt-question"
        placeholder="Issue title"
        dir="auto"
        value={fields.title}
        disabled={fields.drafting}
        onChange={(event) => fields.setTitle(event.target.value)}
      />
      <textarea
        className="studio-prompt-input feedback-body"
        placeholder={"Issue body (Markdown)\n\n## What happened\n…"}
        rows={7}
        dir="auto"
        value={fields.body}
        disabled={fields.drafting}
        onChange={(event) => fields.setBody(event.target.value)}
      />
    </>
  );
}

function DiagnosticOption({
  checked,
  diagLine,
  onChange,
}: {
  checked: boolean;
  diagLine: string;
  onChange(value: boolean): void;
}) {
  return (
    <label className="rec-opt feedback-diag">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      Append version info{diagLine ? ` — ${diagLine}` : ""}
    </label>
  );
}

function ErrorLogOption({
  errors,
  includeErrors,
  onChange,
}: {
  errors: readonly { at: string; text: string }[];
  includeErrors: boolean;
  onChange(value: boolean): void;
}) {
  if (errors.length === 0) return null;
  const plural = errors.length === 1 ? "" : "s";
  return (
    <>
      <label className="rec-opt feedback-diag">
        <input type="checkbox" checked={includeErrors} onChange={(event) => onChange(event.target.checked)} />
        Append the {errors.length} error message{plural} shown as pop-ups this session
      </label>
      <p className="studio-prompt-hint">
        Read them first — an error can name one of your files, and this report goes to a public issue tracker.
      </p>
      <ul className="feedback-errors" data-testid="feedback-errors">
        {errors.map((error) => <li key={error.at + error.text} dir="auto">{error.text}</li>)}
      </ul>
    </>
  );
}

/** ADD-28: feedback → GitHub issue.
 *
 * Write it yourself, or let the LOCAL model shape your words into a title +
 * body (feedback never goes to a cloud engine). Nothing is ever sent by the
 * app: "Open GitHub issue" opens the user's own browser on a prefilled
 * new-issue page, and posting stays their explicit action there.
 *
 * MOUNTED ONLY WHILE OPEN (see Workspace.tsx). The draft lives in local state,
 * so unmounting is what empties it — rendering `null` while open would keep the
 * previous issue's text around for the next one (GH #3). Don't reintroduce an
 * internal "if (!showFeedback) return null" guard: it silently restores the bug. */
export default function FeedbackModal({ s }: { s: WSState }) {
  const [raw, setRaw] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [diag, setDiag] = useState<AppDiag | null>(null);
  const [includeDiag, setIncludeDiag] = useState(true);
  /** AUDIT #548: the error messages this session actually showed.
   *
   * Error pop-ups are the app's only failure report and they vanish when
   * dismissed, so a report could carry the version and nothing else — "it said
   * something about the model, I think". Captured live by `pushToast`, read
   * once here so the list can't shift under the checkbox while it is open.
   *
   * OFF by default and printed in full below, because an error message can name
   * a file, and a file name is room content. Nothing about this is automatic:
   * the user reads the exact lines and decides. */
  const [recentErrors] = useState(() => [...s.errorLogRef.current].reverse());
  const [includeErrors, setIncludeErrors] = useState(false);

  useEffect(() => {
    void api.appDiag().then(setDiag).catch(() => {});
  }, []);

  const diagLine = diagnosticLine(diag);
  const finalBody = issueBody(body, includeDiag, diagLine, errorBlock(includeErrors, recentErrors));
  const ready = readyToOpen(title, body);

  function close() {
    if (!drafting) s.setShowFeedback(false);
  }

  /* Escape, capture-phase, the way every sibling sheet does it (CompareModal,
   * StudioModal). Without it the key reached the app-level listener instead:
   * its typing guard meant Escape did nothing at all while a field had focus,
   * and closed the FILE BEHIND this dialog once focus had left the fields.
   * No dependency array — the handler reads `drafting` through `close`, and a
   * listener registered once would keep answering with the value it captured. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // Tab containment, so `aria-modal` describes something the component does.
  // Its own Escape path is bubble-phase and does not stop propagation, which
  // is why the capture listener above is still the one that closes this.
  const { modalRef, onModalKeyDown } = useFocusTrap(close);

  async function draftWithAi() {
    if (drafting || !raw.trim()) return;
    setDrafting(true);
    try {
      const d = await api.feedbackDraft(raw);
      setTitle(d.title);
      setBody(d.body);
    } catch (e) {
      s.pushToast("error", String(e));
    } finally {
      setDrafting(false);
    }
  }

  async function openIssue() {
    if (!ready || !diag) return;
    const base = `https://github.com/${diag.repo}/issues/new`;
    const url =
      `${base}?title=${encodeURIComponent(title.trim())}` +
      `&body=${encodeURIComponent(finalBody)}`;
    // A web address has a length limit, and "Draft it for me" happily writes a
    // report past it — the link then arrives truncated or is refused outright.
    // Over the limit the body travels on the clipboard instead, and the toast
    // says so rather than claiming the report was carried across.
    const tooLong = url.length > MAX_ISSUE_URL;
    try {
      if (tooLong) {
        await navigator.clipboard.writeText(finalBody);
        await openUrl(`${base}?title=${encodeURIComponent(title.trim())}`);
        s.pushToast(
          "info",
          "This report is too long to travel in a link — it's on your clipboard. Paste it into the issue body, then press Submit.",
        );
      } else {
        await openUrl(url);
        s.pushToast("success", "Opened GitHub in your browser — press Submit there to file it.");
      }
      s.setShowFeedback(false);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  async function copyIssue() {
    try {
      await navigator.clipboard.writeText(`${title.trim()}\n\n${finalBody}`);
      s.pushToast("success", "Copied — paste it anywhere.");
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  return (
    <div className="studio-prompt-backdrop" data-agent-blocked onClick={close}>
      <div
        className="studio-prompt feedback-modal"
        data-testid="feedback-modal"
        ref={modalRef}
        tabIndex={-1}
        onKeyDown={onModalKeyDown}
        // Named and announced as a dialog, the way every other sheet in the
        // app already is (AiActionModal, CompareModal, the consent cards). It
        // was the one modal that arrived as an anonymous div, so a screen
        // reader had no way to say what had just opened. `aria-busy` is the
        // same fact the disabled fields state visually while the local model
        // is drafting.
        role="dialog"
        aria-modal="true"
        aria-label="Send feedback"
        aria-busy={drafting}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="studio-prompt-title">Send feedback</div>
        <p className="studio-prompt-hint">
          Found a bug, missing something? It becomes a GitHub issue — drafted here,
          opened in <strong>your</strong> browser. The app itself sends nothing.
        </p>

        <FeedbackDraftInput
          raw={raw}
          title={title}
          body={body}
          drafting={drafting}
          setRaw={setRaw}
          setTitle={setTitle}
          setBody={setBody}
          draftWithAi={() => void draftWithAi()}
        />
        <FeedbackIssueFields
          raw={raw}
          title={title}
          body={body}
          drafting={drafting}
          setRaw={setRaw}
          setTitle={setTitle}
          setBody={setBody}
          draftWithAi={() => void draftWithAi()}
        />
        <DiagnosticOption checked={includeDiag} diagLine={diagLine} onChange={setIncludeDiag} />
        <ErrorLogOption errors={recentErrors} includeErrors={includeErrors} onChange={setIncludeErrors} />

        <div className="studio-prompt-actions">
          <button className="subtle" disabled={drafting} onClick={close}>
            Cancel
          </button>
          <button className="subtle" disabled={!ready} onClick={() => void copyIssue()}>
            Copy
          </button>
          <button className="primary" disabled={!ready || !diag} onClick={() => void openIssue()}>
            Open GitHub issue
          </button>
        </div>
      </div>
    </div>
  );
}
