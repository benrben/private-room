import { RecoveryKeyIcon } from "./RecoveryKeyIcon";
import { CircleCheckIcon } from "../icons";

// Recovery-code reveal after create — shown once, then we enter.
export function RecoveryModal({
  recoveryCode,
  recoveryCopied,
  setRecoveryCopied,
  onDismiss,
}: {
  recoveryCode: string;
  recoveryCopied: boolean;
  setRecoveryCopied: (v: boolean) => void;
  onDismiss: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        zIndex: 100,
      }}
    >
      <div style={{ width: "min(420px, 100%)" }}>
        <div className="recovery-sheet">
          <div className="recovery-sheet-title">
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <RecoveryKeyIcon size={18} /> Your recovery code
            </span>
          </div>
          <div className="recovery-code">{recoveryCode}</div>
          <p className="recovery-sheet-note">
            Keep this somewhere safe. It's the only way back in if you forget
            your password. We can't recover it for you — it never leaves this
            Mac.
          </p>
          <div className="recovery-sheet-actions">
            <button
              type="button"
              className={recoveryCopied ? "primary btn-ic" : undefined}
              onClick={() => {
                if (!recoveryCode) return;
                setRecoveryCopied(true);
                try {
                  void navigator.clipboard.writeText(recoveryCode);
                } catch {
                  /* clipboard unavailable — the code is still on screen */
                }
              }}
            >
              {recoveryCopied ? (<><CircleCheckIcon size={13} /> Copied</>) : "Copy code"}
            </button>
            <button type="button" onClick={() => window.print()}>
              Print
            </button>
            <button type="button" className="primary" onClick={onDismiss}>
              I saved it
            </button>
          </div>
          <button type="button" className="subtle" onClick={onDismiss}>
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
