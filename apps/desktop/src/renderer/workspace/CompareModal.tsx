import { useEffect, useState, type ReactNode } from "react";
import { formatWhen } from "./composer";
import { WSState } from "./state";
import { WSActions } from "./actions";
import DiffView, { isRtlDominant } from "../viewers/DiffView";
import { useFocusTrap } from "../settings/useFocusTrap";

type Compare = Exclude<WSState["compare"], null>;

interface ComparePresentation {
  bothText: boolean;
  rtl: boolean;
}

/** Idea 11: a read-only side-by-side diff of one saved version against the
 * file's current text. Cribs the house modal pattern (ApproveCard): backdrop
 * div, role="dialog" aria-modal, a focus trap, backdrop click closes.
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

  if (!compare) return null;

  const presentation = comparePresentation(compare);
  const close = () => s.setCompare(null);
  const restore = () => {
    setArmed(false);
    void a.restoreVersion(compare.versionId);
    close();
  };

  return (
    <div className="compare-backdrop" onClick={close}>
      <ComparePanel label={`Compare — ${compare.fileName}`} onClose={close}>
        <CompareHeader
          armed={armed}
          compare={compare}
          onClose={close}
          onRestore={restore}
          plain={plain}
          setArmed={setArmed}
          setPlain={setPlain}
          showViewToggle={presentation.bothText}
        />
        <CompareBody compare={compare} plain={plain} presentation={presentation} />
      </ComparePanel>
    </div>
  );
}

function comparePresentation(compare: Compare): ComparePresentation {
  return {
    bothText: compare.versionText !== null && compare.currentText !== null,
    rtl: isRtlDominant((compare.versionText ?? "") + (compare.currentText ?? "")),
  };
}

function CompareHeader({
  armed,
  compare,
  onClose,
  onRestore,
  plain,
  setArmed,
  setPlain,
  showViewToggle,
}: {
  armed: boolean;
  compare: Compare;
  onClose: () => void;
  onRestore: () => void;
  plain: boolean;
  setArmed: (armed: boolean) => void;
  setPlain: (next: (plain: boolean) => boolean) => void;
  showViewToggle: boolean;
}) {
  return (
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
        <CompareViewToggle plain={plain} setPlain={setPlain} visible={showViewToggle} />
        <RestoreControls
          armed={armed}
          onArm={() => setArmed(true)}
          onCancel={() => setArmed(false)}
          onRestore={onRestore}
        />
        <button className="subtle" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function CompareViewToggle({
  plain,
  setPlain,
  visible,
}: {
  plain: boolean;
  setPlain: (next: (plain: boolean) => boolean) => void;
  visible: boolean;
}) {
  if (!visible) return null;
  const title = plain
    ? "Show the side-by-side diff"
    : "Show plain scrollable panes (better for Hebrew/Arabic)";
  return (
    <button
      className="subtle"
      title={title}
      onClick={() => setPlain((current) => !current)}
    >
      {plain ? "Diff view" : "Plain view"}
    </button>
  );
}

function RestoreControls({
  armed,
  onArm,
  onCancel,
  onRestore,
}: {
  armed: boolean;
  onArm: () => void;
  onCancel: () => void;
  onRestore: () => void;
}) {
  if (!armed) {
    return (
      <button className="subtle" data-agent-blocked onClick={onArm}>
        Restore this version
      </button>
    );
  }
  return (
    <span className="compare-confirm" data-agent-blocked>
      <button className="primary" onClick={onRestore}>
        Restore
      </button>
      <button className="subtle" onClick={onCancel}>
        Cancel
      </button>
    </span>
  );
}

function CompareBody({
  compare,
  plain,
  presentation,
}: {
  compare: Compare;
  plain: boolean;
  presentation: ComparePresentation;
}) {
  return (
    <div className="compare-body">
      <CompareContent bothText={presentation.bothText} compare={compare} plain={plain} />
      <CompareRtlHint bothText={presentation.bothText} plain={plain} rtl={presentation.rtl} />
    </div>
  );
}

function CompareContent({
  bothText,
  compare,
  plain,
}: {
  bothText: boolean;
  compare: Compare;
  plain: boolean;
}) {
  if (!bothText) {
    return <div className="compare-empty">This version has no text to compare.</div>;
  }
  if (plain) {
    return (
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
    );
  }
  return (
    <DiffView
      key={compare.versionId}
      original={compare.versionText!}
      modified={compare.currentText!}
      fileName={compare.fileName}
    />
  );
}

function CompareRtlHint({
  bothText,
  plain,
  rtl,
}: {
  bothText: boolean;
  plain: boolean;
  rtl: boolean;
}) {
  if (plain || !bothText || !rtl) return null;
  return (
    <div className="compare-rtl-hint">
      Right-to-left text — try “Plain view” if the diff reads awkwardly.
    </div>
  );
}

/** The trapped panel. A component of its own so `useFocusTrap`'s mount and
 * unmount effects line up with the dialog opening and closing — the outer
 * component stays mounted for the whole session with `compare` null. */
function ComparePanel({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { modalRef, onModalKeyDown } = useFocusTrap(onClose);
  return (
    <div
      ref={modalRef}
      tabIndex={-1}
      // Escape is answered in the CAPTURE phase, unlike the app's other trapped
      // dialogs, because this one hosts Monaco: the diff editor consumes the key
      // whenever it has a selection or an open find widget and stops it there,
      // so a bubble-phase handler would never see it. Stopping it here also
      // keeps it off the app-level Escape (effects.ts), which closes the open
      // FILE this dialog is drawn over.
      onKeyDownCapture={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onKeyDown={onModalKeyDown}
      className="compare-modal"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}
