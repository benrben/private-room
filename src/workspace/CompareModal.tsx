import { useEffect, useState } from "react";
import { formatWhen } from "./composer";
import { WSState } from "./state";
import { WSActions } from "./actions";
import DiffView, { isRtlDominant } from "../viewers/DiffView";

/** Idea 11: a read-only side-by-side diff of one saved version against the
 * file's current text. Cribs the house modal pattern (StudioModal): backdrop
 * div, role="dialog" aria-modal, capture-phase Escape, backdrop click closes.
 * Restore stays reachable from here behind an armed, data-agent-blocked confirm
 * (the agent driver must not restore what it didn't earn). */
export default function CompareModal({
  s,
  a,
}: {
  s: WSState;
  a: WSActions;
}) {
  const compare = s.compare;
  // "Plain view": two dir=auto panes for right-to-left documents Monaco lays
  // out left-to-right. Default is the Monaco diff (bidi-correct per line).
  const [plain, setPlain] = useState(false);
  const [armed, setArmed] = useState(false);

  const open = compare !== null;
  useEffect(() => {
    if (!open) return;
    // Reset the local view state each time a new compare opens.
    setPlain(false);
    setArmed(false);
  }, [open, compare?.versionId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Capture-phase + stopPropagation so the app-level Escape (which closes
      // the file viewer) never fires underneath this dialog.
      e.stopPropagation();
      s.setCompare(null);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!compare) return null;

  const bothText =
    compare.versionText !== null && compare.currentText !== null;
  const rtl = isRtlDominant(
    (compare.versionText ?? "") + (compare.currentText ?? ""),
  );

  return (
    <div className="compare-backdrop" onClick={() => s.setCompare(null)}>
      <div
        className="compare-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Compare — ${compare.fileName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="compare-head">
          <div className="compare-title">
            <span className="compare-name" dir="auto">
              {compare.fileName}
            </span>
            <span className="compare-sub">
              {compare.cause} · {formatWhen(compare.savedAt)} vs. now
            </span>
          </div>
          <div className="compare-head-actions">
            {bothText && (
              <button
                className="subtle"
                title={
                  plain
                    ? "Show the side-by-side diff"
                    : "Show plain scrollable panes (better for Hebrew/Arabic)"
                }
                onClick={() => setPlain((p) => !p)}
              >
                {plain ? "Diff view" : "Plain view"}
              </button>
            )}
            {/* The modal's own Restore — armed, and data-agent-blocked so the
                agent driver can never confirm it (parity with the popover). */}
            {!armed ? (
              <button
                className="subtle"
                data-agent-blocked
                onClick={() => setArmed(true)}
              >
                Restore this version
              </button>
            ) : (
              <span className="compare-confirm" data-agent-blocked>
                <button
                  className="primary"
                  onClick={() => {
                    setArmed(false);
                    void a.restoreVersion(compare.versionId);
                    s.setCompare(null);
                  }}
                >
                  Restore
                </button>
                <button className="subtle" onClick={() => setArmed(false)}>
                  Cancel
                </button>
              </span>
            )}
            <button className="subtle" onClick={() => s.setCompare(null)}>
              Close
            </button>
          </div>
        </div>
        <div className="compare-body">
          {!bothText ? (
            <div className="compare-empty">
              This version has no text to compare.
            </div>
          ) : plain ? (
            <div className="compare-plain">
              <pre className="compare-pane" dir="auto">
                <div className="compare-pane-label">This version</div>
                {compare.versionText}
              </pre>
              <pre className="compare-pane" dir="auto">
                <div className="compare-pane-label">Now</div>
                {compare.currentText}
              </pre>
            </div>
          ) : (
            <DiffView
              key={compare.versionId}
              original={compare.versionText ?? ""}
              modified={compare.currentText ?? ""}
              fileName={compare.fileName}
            />
          )}
          {rtl && !plain && bothText && (
            <div className="compare-rtl-hint">
              Right-to-left text — try “Plain view” if the diff reads awkwardly.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
