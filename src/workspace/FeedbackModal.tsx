import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, AppDiag } from "../api";
import { SparklesIcon } from "../icons";
import { WSState } from "./state";

/** How long a prefilled new-issue link may be. GitHub answers 414 well before
 * this, and browsers have their own ceilings; staying under 6 KB keeps the
 * whole report intact on every path that does work. */
const MAX_ISSUE_URL = 6000;

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

  useEffect(() => {
    void api.appDiag().then(setDiag).catch(() => {});
  }, []);

  const diagLine = diag
    ? `Arcelle ${diag.version} · ${diag.os} (${diag.arch})`
    : "";
  const finalBody = includeDiag && diagLine ? `${body.trim()}\n\n---\n${diagLine}` : body.trim();
  const ready = title.trim().length > 0 && body.trim().length > 0;

  function close() {
    if (!drafting) s.setShowFeedback(false);
  }

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
        onClick={(e) => e.stopPropagation()}
      >
        <div className="studio-prompt-title">Send feedback</div>
        <p className="studio-prompt-hint">
          Found a bug, missing something? It becomes a GitHub issue — drafted here,
          opened in <strong>your</strong> browser. The app itself sends nothing.
        </p>

        <div className="feedback-raw">
          <textarea
            className="studio-prompt-input"
            placeholder="What happened, in your own words — any language…"
            rows={3}
            dir="auto"
            value={raw}
            disabled={drafting}
            autoFocus
            onChange={(e) => setRaw(e.target.value)}
          />
          <button
            className="subtle btn-ic"
            disabled={drafting || !raw.trim()}
            title="The local model turns your words into a clear issue title and body — nothing leaves this Mac"
            onClick={() => void draftWithAi()}
          >
            {drafting ? "Drafting…" : (<><SparklesIcon size={13} /> Draft it for me</>)}
          </button>
        </div>

        <input
          className="studio-prompt-question"
          placeholder="Issue title"
          dir="auto"
          value={title}
          disabled={drafting}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className="studio-prompt-input feedback-body"
          placeholder={"Issue body (Markdown)\n\n## What happened\n…"}
          rows={7}
          dir="auto"
          value={body}
          disabled={drafting}
          onChange={(e) => setBody(e.target.value)}
        />

        <label className="rec-opt feedback-diag">
          <input
            type="checkbox"
            checked={includeDiag}
            onChange={(e) => setIncludeDiag(e.target.checked)}
          />
          Append version info{diagLine ? ` — ${diagLine}` : ""}
        </label>

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
