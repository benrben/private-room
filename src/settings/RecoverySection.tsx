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
                    {recoveryCopied ? (<><CircleCheckIcon size={13} /> Copied</>) : "Copy code"}
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
              <div className="settings-actions">
                <button
                  className="primary"
                  disabled={recoveryBusy}
                  onClick={createRecoveryKey}
                >
                  {recoveryBusy ? "Creating…" : "Create a recovery key"}
                </button>
              </div>
            )}
            {recoveryErr && <div className="gate-error">{recoveryErr}</div>}
    </section>
  );
}
