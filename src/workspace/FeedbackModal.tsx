import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, AppDiag } from "../api";
import { SparklesIcon } from "../icons";
import { WSState } from "./state";

/** ADD-28: feedback → GitHub issue.
 *
 * Write it yourself, or let the LOCAL model shape your words into a title +
 * body (feedback never goes to a cloud engine). Nothing is ever sent by the
 * app: "Open GitHub issue" opens the user's own browser on a prefilled
 * new-issue page, and posting stays their explicit action there. */
export default function FeedbackModal({ s }: { s: WSState }) {
  const [raw, setRaw] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [diag, setDiag] = useState<AppDiag | null>(null);
  const [includeDiag, setIncludeDiag] = useState(true);

  useEffect(() => {
    if (s.showFeedback) void api.appDiag().then(setDiag).catch(() => {});
  }, [s.showFeedback]);

  if (!s.showFeedback) return null;

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
    const url =
      `https://github.com/${diag.repo}/issues/new` +
      `?title=${encodeURIComponent(title.trim())}` +
      `&body=${encodeURIComponent(finalBody)}`;
    try {
      await openUrl(url);
      s.pushToast("success", "Opened GitHub in your browser — press Submit there to file it.");
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
      <div className="studio-prompt feedback-modal" onClick={(e) => e.stopPropagation()}>
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
