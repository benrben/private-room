import { confirm as askConfirm } from "@tauri-apps/plugin-dialog";
import { RecoveryKeyIcon } from "./RecoveryKeyIcon";
import { CircleCheckIcon } from "../icons";
import { useFocusTrap } from "../settings/useFocusTrap";

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
  /** "Skip for now" used to be byte-for-byte "I saved it": one click and the
   * only way back into this room without the password was gone, with nothing
   * said. The code is shown ONCE — there is no reset and no second reveal — so
   * leaving without it has to be a deliberate second answer. Copying (or
   * printing) counts as saving it, so the guard only stands in the way of the
   * user who genuinely has nothing written down. */
  async function skip() {
    if (recoveryCopied) {
      onDismiss();
      return;
    }
    const ok = await askConfirm(
      "This code is shown once and never again. Without it, forgetting the " +
        "password means the room can never be opened — not by us, not by anyone. " +
        "Continue without saving it?",
      { title: "Skip the recovery code", kind: "warning", okLabel: "Skip anyway" },
    ).catch(() => false);
    if (ok) onDismiss();
  }

  // Escape is a skip, so it goes through the same guard rather than dismissing
  // a one-time reveal outright. The trap also keeps Tab inside the panel — it
  // renders over the start screen, whose buttons were reachable behind it.
  const { modalRef, onModalKeyDown } = useFocusTrap(() => void skip());

  return (
    /* The one genuinely floating surface on the gate, so the one thing that
       is allowed to be opaque: it has to occlude the code shown behind it.
       The veil and the sheet's lift live in gate.css; `.recovery-sheet`
       itself is shared with Settings and styled in misc-moonshot-cards.css. */
    <div className="gate-backdrop">
      <div
        ref={modalRef}
        tabIndex={-1}
        onKeyDown={onModalKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-modal-title"
        className="gate-backdrop-panel"
      >
        <div className="recovery-sheet nb-float nb-float-draw">
          <div className="recovery-sheet-title" id="recovery-modal-title">
            <span className="gate-sheet-title">
              <RecoveryKeyIcon size={16} /> Your recovery code
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
              {recoveryCopied ? (<><CircleCheckIcon size={14} /> Copied</>) : "Copy code"}
            </button>
            <button type="button" onClick={() => window.print()}>
              Print
            </button>
            <button type="button" className="primary" onClick={onDismiss}>
              I saved it
            </button>
          </div>
          <button type="button" className="subtle" onClick={() => void skip()}>
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
