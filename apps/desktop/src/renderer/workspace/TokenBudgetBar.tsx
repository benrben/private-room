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

/** near/at/over-budget signal on the bar's outer ring — never a width change
 * (the fill width is always the real ratio). */
function thresholdClass(pct: number): "ok" | "warn" | "danger" {
  if (pct >= 92) return "danger";
  if (pct >= 75) return "warn";
  return "ok";
}

/** P1-6: the meter is a warning shape (a ring that goes amber, then red), so
 * showing it at 2% used — which it did, from the very first turn — read as
 * "watch this" about a number nobody needed to watch yet. It earns its place
 * once the window is actually filling up. Hand off does NOT share this gate:
 * it is a context-management action, reachable at any usage level, not a
 * consequence of the meter being visible. */
const TOKEN_METER_VISIBLE_PCT = 70;

/** …and the word that rides with it. The ring alone would be colour-only
 * status, and the five segment colours are already spoken for as CATEGORY
 * identity — so the budget signal is red, which no category uses, and it
 * always carries one of these. */
const THRESHOLD_WORD: Record<"ok" | "warn" | "danger", string> = {
  ok: "",
  warn: "Near limit",
  danger: "At limit",
};

/** The newest usage snapshot the transcript itself carries.
 *
 * `s.tokenUsage` only holds what THIS session's live `ask-token-usage` event
 * delivered, so a conversation reopened after a restart had no reading at all
 * — the meter went missing precisely when the window was fullest. The same
 * snapshot is persisted on the assistant row (`effects.usage`, written by
 * agent.rs), so the loaded messages restore it without another round trip. */
function persistedUsage(messages: Message[]): AskTokenUsage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const u = messages[i].effects?.usage;
    if (u) return u;
  }
  return null;
}

type Budget = {
  total: number;
  max: number;
  fillPct: number;
  cls: "ok" | "warn" | "danger";
};

function budgetOf(usage: AskTokenUsage): Budget {
  const total = Math.max(usage.total_tokens, 0);
  const max = Math.max(usage.max_context, 1);
  const fillPct = Math.min(100, (total / max) * 100);
  return { total, max, fillPct, cls: thresholdClass(fillPct) };
}

function useBreakdownEscape(open: boolean, setOpen: (value: boolean) => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]);
}

function TokenSegment({
  category,
  total,
}: {
  category: UsageCategory;
  total: number;
}) {
  const catTokens = category.usage?.tokens ?? 0;
  if (total <= 0 || catTokens <= 0) return null;
  const segPct = (catTokens / total) * 100;
  return (
    <span
      className={`token-bar-seg tok-${category.key}`}
      style={{ width: `${segPct}%` }}
      data-tip={`${category.label} · ${formatTokenCount(catTokens)} tokens`}
    />
  );
}

type UsageCategory = {
  key: TokenCategory;
  label: string;
  usage: { tokens: number; estimated: boolean } | undefined;
};

function usageCategories(usage: AskTokenUsage): UsageCategory[] {
  return CATEGORY_ORDER.map((category) => ({
    ...category,
    usage: usage.breakdown[category.key],
  }));
}

function TokenSegments({
  usage,
  total,
}: {
  usage: AskTokenUsage;
  total: number;
}) {
  return (
    <>
      {usageCategories(usage).map((category) => (
        <TokenSegment key={category.key} category={category} total={total} />
      ))}
    </>
  );
}

function BudgetLabel({
  total,
  max,
  estimated,
}: Pick<Budget, "total" | "max"> & { estimated: boolean }) {
  return (
    <span className="token-bar-label">
      {formatTokenCount(total)} / {formatTokenCount(max)}
      {estimated && (
        <span
          className="token-bar-est"
          title="Estimated total — this engine reports no exact token count"
        >
          ~
        </span>
      )}
    </span>
  );
}

function ThresholdFlag({ cls }: Pick<Budget, "cls">) {
  if (cls === "ok") return null;
  return (
    <span className="nb-tape nb-sem-urgent token-bar-flag">
      {THRESHOLD_WORD[cls]}
    </span>
  );
}

function BudgetButton({
  usage,
  budget,
  open,
  setOpen,
}: {
  usage: AskTokenUsage;
  budget: Budget;
  open: boolean;
  setOpen: (updater: (current: boolean) => boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`token-bar ${budget.cls}`}
      aria-expanded={open}
      onClick={() => setOpen((current) => !current)}
      title={`${formatTokenCount(budget.total)} / ${formatTokenCount(budget.max)} tokens in the last answer — click for a breakdown`}
    >
      <span className="token-bar-track">
        <span
          className="token-bar-fill"
          style={{ width: `${budget.fillPct}%` }}
        >
          <TokenSegments usage={usage} total={budget.total} />
        </span>
      </span>
      <BudgetLabel
        total={budget.total}
        max={budget.max}
        estimated={usage.estimated}
      />
      <ThresholdFlag cls={budget.cls} />
    </button>
  );
}

function BreakdownRow({
  category,
  total,
}: {
  category: UsageCategory;
  total: number;
}) {
  const catTokens = category.usage?.tokens ?? 0;
  const pct = Math.round((catTokens / total) * 100);
  return (
    <div className="token-breakdown-row">
      <span className={`token-breakdown-swatch tok-${category.key}`} />
      <span className="token-breakdown-name">{category.label}</span>
      <span className="token-breakdown-count">
        {formatTokenCount(catTokens)}
      </span>
      <span className="token-breakdown-pct">{pct}%</span>
    </div>
  );
}

function TokenBreakdown({
  usage,
  budget,
  onClose,
}: {
  usage: AskTokenUsage;
  budget: Budget;
  onClose: () => void;
}) {
  return (
    <>
      <div className="menu-backdrop" onMouseDown={onClose} />
      <div className="pop-menu token-breakdown-pop">
        {usageCategories(usage).map((category) => (
          <BreakdownRow
            key={category.key}
            category={category}
            total={budget.total}
          />
        ))}
        <div className="token-breakdown-total">
          <span>Total</span>
          <span>
            {formatTokenCount(budget.total)} / {formatTokenCount(budget.max)} (
            {Math.round(budget.fillPct)}%)
          </span>
        </div>
        <div className="token-breakdown-note">
          Breakdown is estimated — categories are inferred from content length,
          scaled to the real total when the engine reports one.
          {usage.estimated &&
            " The total shown is also estimated — this engine doesn't report exact usage."}
        </div>
      </div>
    </>
  );
}

function TokenMeter({
  usage,
  open,
  setOpen,
}: {
  usage: AskTokenUsage | null;
  open: boolean;
  setOpen: (updater: (current: boolean) => boolean) => void;
}) {
  if (!usage) return null;
  const budget = budgetOf(usage);
  if (budget.fillPct < TOKEN_METER_VISIBLE_PCT) return null;
  return (
    <div className="token-bar-wrap">
      <BudgetButton
        usage={usage}
        budget={budget}
        open={open}
        setOpen={setOpen}
      />
      {open && (
        <TokenBreakdown
          usage={usage}
          budget={budget}
          onClose={() => setOpen(() => false)}
        />
      )}
    </div>
  );
}

function HandoffButton({ s, a }: { s: WSState; a: WSActions }) {
  return (
    <button
      type="button"
      className={`tool-chip token-handoff-btn${s.handoffStarting ? " busy" : ""}`}
      title="Summarize this conversation and continue with a smaller context"
      disabled={s.handoffStarting || s.asking}
      onClick={() => void a.handoffContext()}
    >
      {s.handoffStarting ? (
        <RefreshIcon size={14} className="token-handoff-spin" />
      ) : (
        <SparklesIcon size={14} />
      )}
      {s.handoffStarting ? "Summarizing…" : "Hand off"}
    </button>
  );
}

/** The chat's live token-budget bar: a segmented fill (colored by category)
 * showing how much of the model's context window this turn used, plus a
 * click-to-expand exact breakdown. Renders nothing on an empty conversation,
 * and the meter itself stays out of the row below TOKEN_METER_VISIBLE_PCT —
 * Hand off still renders regardless, including on a chat whose only usage
 * snapshot is the persisted one. */
export default function TokenBudgetBar({ s, a }: { s: WSState; a: WSActions }) {
  const [open, setOpen] = useState(false);
  useBreakdownEscape(open, setOpen);
  const usage: AskTokenUsage | null =
    s.tokenUsage ?? persistedUsage(s.messages);
  if (!usage && s.messages.length === 0) return null;
  return (
    <div className="token-bar-row">
      <TokenMeter usage={usage} open={open} setOpen={setOpen} />
      <HandoffButton s={s} a={a} />
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
