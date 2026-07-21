import { useEffect, useState } from "react";
import { RefreshIcon, SparklesIcon } from "../icons";
import MarkdownView from "../viewers/MarkdownView";
import { WSState } from "./state";
import { WSActions } from "./actions";
import type { AskTokenUsage, Message, TokenCategory } from "../apiTypes";

/** The 5 fixed breakdown categories, in legend/stacking order (tokens.css
 * --tok-* vars). Never reordered — a category's color is its identity. */
const CATEGORY_ORDER: { key: TokenCategory; label: string }[] = [
  { key: "system", label: "System prompt" },
  { key: "history", label: "Conversation history" },
  { key: "tools", label: "Tool results" },
  { key: "skills", label: "Skill-injected content" },
  { key: "files", label: "File reads & attachments" },
];

function formatTokenCount(n: number): string {
  return Math.round(n).toLocaleString();
}

/** near/at/over-budget signal on the bar's outer ring — a color-only glow,
 * never a width change (the fill width is always the real ratio). */
function thresholdClass(pct: number): "ok" | "warn" | "danger" {
  if (pct >= 92) return "danger";
  if (pct >= 75) return "warn";
  return "ok";
}

/** The chat's live token-budget bar: a segmented fill (colored by category)
 * showing how much of the model's context window this turn used, plus a
 * click-to-expand exact breakdown. Renders nothing until the first turn's
 * usage snapshot arrives. */
export default function TokenBudgetBar({ s, a }: { s: WSState; a: WSActions }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const usage: AskTokenUsage | null = s.tokenUsage;
  if (!usage) return null;

  const total = Math.max(usage.total_tokens, 0);
  const max = Math.max(usage.max_context, 1);
  const fillPct = Math.min(100, (total / max) * 100);
  const cls = thresholdClass(fillPct);

  return (
    <div className="token-bar-row">
      <div className="token-bar-wrap">
        <button
          type="button"
          className={`token-bar ${cls}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          title={`${formatTokenCount(total)} / ${formatTokenCount(max)} tokens used this turn — click for a breakdown`}
        >
          <span className="token-bar-track">
            <span className="token-bar-fill" style={{ width: `${fillPct}%` }}>
              {CATEGORY_ORDER.map(({ key, label }) => {
                const cat = usage.breakdown[key];
                const catTokens = cat?.tokens ?? 0;
                const segPct = total > 0 ? (catTokens / total) * 100 : 0;
                if (segPct <= 0) return null;
                return (
                  <span
                    key={key}
                    className={`token-bar-seg tok-${key}`}
                    style={{ width: `${segPct}%` }}
                    data-tip={`${label} · ${formatTokenCount(catTokens)} tokens`}
                  />
                );
              })}
            </span>
          </span>
          <span className="token-bar-label">
            {formatTokenCount(total)} / {formatTokenCount(max)}
            {usage.estimated && (
              <span
                className="token-bar-est"
                title="Estimated total — this engine reports no exact token count"
              >
                ~
              </span>
            )}
          </span>
        </button>
        {open && (
          <>
            <div className="menu-backdrop" onMouseDown={() => setOpen(false)} />
            <div className="pop-menu token-breakdown-pop" role="dialog">
              {CATEGORY_ORDER.map(({ key, label }) => {
                const cat = usage.breakdown[key];
                const catTokens = cat?.tokens ?? 0;
                const pct = total > 0 ? Math.round((catTokens / total) * 100) : 0;
                return (
                  <div className="token-breakdown-row" key={key}>
                    <span className={`token-breakdown-swatch tok-${key}`} />
                    <span className="token-breakdown-name">{label}</span>
                    <span className="token-breakdown-count">
                      {formatTokenCount(catTokens)}
                    </span>
                    <span className="token-breakdown-pct">{pct}%</span>
                  </div>
                );
              })}
              <div className="token-breakdown-total">
                <span>Total</span>
                <span>
                  {formatTokenCount(total)} / {formatTokenCount(max)} (
                  {Math.round(fillPct)}%)
                </span>
              </div>
              <div className="token-breakdown-note">
                Breakdown is estimated — categories are inferred from content
                length, scaled to the real total when the engine reports one.
                {usage.estimated &&
                  " The total shown is also estimated — this engine doesn't report exact usage."}
              </div>
            </div>
          </>
        )}
      </div>
      <button
        type="button"
        className={`tool-chip token-handoff-btn${s.handoffStarting ? " busy" : ""}`}
        title="Summarize this conversation and continue with a smaller context"
        disabled={s.handoffStarting || s.asking}
        onClick={() => void a.handoffContext()}
      >
        {s.handoffStarting ? (
          <RefreshIcon size={13} className="token-handoff-spin" />
        ) : (
          <SparklesIcon size={13} />
        )}
        {s.handoffStarting ? "Summarizing…" : "Hand off"}
      </button>
    </div>
  );
}

/** The "after" state of a handoff: a centered divider in the message list
 * (not a `.msg` bubble — a handoff event isn't a participant turn) with the
 * recap collapsed behind a native `<details>`, matching the collapsible
 * pattern already used for connector tool lists. */
export function HandoffMarker({ message }: { message: Message }) {
  return (
    <div className="handoff-marker">
      <div className="handoff-marker-line">
        <span>Context summarized, continuing</span>
      </div>
      <details className="handoff-marker-details">
        <summary>View summary</summary>
        <div className="handoff-marker-body">
          <MarkdownView text={message.content} />
        </div>
      </details>
    </div>
  );
}
