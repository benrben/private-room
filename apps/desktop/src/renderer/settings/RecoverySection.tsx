import { CircleCheckIcon } from "../icons";

interface Props {
  recoveryCode: string | null;
  recoveryCopied: boolean;
  setRecoveryCopied: (v: boolean) => void;
  setRecoveryCode: (v: string | null) => void;
  recoveryBusy: boolean;
  createRecoveryKey: () => void;
  recoveryErr: string;
}

export default function RecoverySection({
  recoveryCode,
  recoveryCopied,
  setRecoveryCopied,
  setRecoveryCode,
  recoveryBusy,
  createRecoveryKey,
  recoveryErr,
}: Props) {
  return (
    // RECOVERY — a one-time code that can reopen this room.
    <section id="set-recovery">
      <h3>Recovery key</h3>
            <p className="settings-hint">
              A one-time code that can reopen this room if you ever forget its
              password. Print it and keep it somewhere safe — it's the only way
              back in.
            </p>
            {recoveryCode ? (
              // The print block in App.css keeps a settings-backdrop that holds
              // a .recovery-sheet visible when printing; Copy is the reliable
              // capture path since the Tauri webview's window.print() can be a
              // no-op.
              <div className="recovery-sheet">
                <div className="recovery-sheet-title">Your recovery key</div>
                <div className="recovery-code">{recoveryCode}</div>
                <div className="recovery-sheet-note">
                  This is shown only once. We can't show it again — copy or
                  print it now, then store it away from this Mac.
                </div>
                <div className="recovery-sheet-actions">
                  <button
                    className="primary btn-ic"
                    onClick={() => {
                      setRecoveryCopied(true);
                      try {
                        void navigator.clipboard.writeText(recoveryCode);
                      } catch {
                        /* clipboard unavailable — code is still on screen */
                      }
                    }}
                  >
                    {recoveryCopied ? (<><CircleCheckIcon size={14} /> Copied</>) : "Copy code"}
                  </button>
                  <button className="subtle" onClick={() => window.print()}>
                    Print
                  </button>
                  <button
                    className="subtle"
                    onClick={() => setRecoveryCode(null)}
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* `write_recovery_key` renames a fresh sidecar over the old
                    one, and every room made through the create screen already
                    got a code there — so this button is a REPLACEMENT far more
                    often than a first issue, and the printed page in the
                    drawer stops working the moment it is pressed. Same flag
                    tape the password section uses for the same consequence. */}
                <p className="set-note set-note--flag nb-sem-pending">
                  <span className="nb-tape set-note-tag">
                    A new key ends the old one
                  </span>
                  . Making one replaces any key this room already has —
                  including the code it was given when it was created — so a
                  code you printed earlier stops working.
                </p>
                <div className="settings-actions">
                  <button
                    className="primary"
                    disabled={recoveryBusy}
                    onClick={createRecoveryKey}
                  >
                    {recoveryBusy ? "Creating…" : "Make a new recovery key"}
                  </button>
                </div>
              </>
            )}
            {recoveryErr && <div className="gate-error">{recoveryErr}</div>}
    </section>
  );
}
