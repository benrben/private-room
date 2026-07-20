import { CircleCheckIcon } from "../icons";

interface Props {
  autolock: string;
  changeAutolock: (value: string) => void;
  pwCurrent: string;
  setPwCurrent: (v: string) => void;
  pwNew: string;
  setPwNew: (v: string) => void;
  pwRepeat: string;
  setPwRepeat: (v: string) => void;
  pwError: string;
  pwSaved: boolean;
  changePassword: () => void;
  pwRecoveryCode: string | null;
  setPwRecoveryCode: (v: string | null) => void;
  pwRecoveryCopied: boolean;
  setPwRecoveryCopied: (v: boolean) => void;
  touchIdOn: boolean;
  toggleTouchId: () => void;
  touchIdErr: string;
  chooseDupDest: () => void;
  dupDest: string;
  dupPassword: string;
  setDupPassword: (v: string) => void;
  dupRepeat: string;
  setDupRepeat: (v: string) => void;
  dupError: string;
  duplicate: () => void;
  dupDone: boolean;
  compactMsg: string;
  compactArmed: boolean;
  setCompactArmed: (v: boolean) => void;
  compact: () => void;
  compacting: boolean;
  setCompactMsg: (v: string) => void;
  compactErr: string;
}

export default function PrivacySection({
  autolock,
  changeAutolock,
  pwCurrent,
  setPwCurrent,
  pwNew,
  setPwNew,
  pwRepeat,
  setPwRepeat,
  pwError,
  pwSaved,
  changePassword,
  pwRecoveryCode,
  setPwRecoveryCode,
  pwRecoveryCopied,
  setPwRecoveryCopied,
  touchIdOn,
  toggleTouchId,
  touchIdErr,
  chooseDupDest,
  dupDest,
  dupPassword,
  setDupPassword,
  dupRepeat,
  setDupRepeat,
  dupError,
  duplicate,
  dupDone,
  compactMsg,
  compactArmed,
  setCompactArmed,
  compact,
  compacting,
  setCompactMsg,
  compactErr,
}: Props) {
  return (
    <section id="set-privacy">
      <h3>Privacy</h3>

            {/* SEC-3 — auto-lock */}
            <label className="settings-label">Lock automatically after</label>
            <select
              value={autolock}
              onChange={(e) => changeAutolock(e.target.value)}
            >
              <option value="off">Off — never lock by itself</option>
              <option value="5">5 minutes</option>
              <option value="15">15 minutes</option>
              <option value="60">60 minutes</option>
            </select>
            <p className="settings-hint">
              An idle room locks itself and returns to the password screen.
            </p>

            {/* SEC-4 — change password */}
            <label className="settings-label">Change password</label>
            <div className="settings-form">
              <input
                type="password"
                placeholder="Current password"
                value={pwCurrent}
                onChange={(e) => setPwCurrent(e.target.value)}
              />
              <input
                type="password"
                placeholder="New password"
                value={pwNew}
                onChange={(e) => setPwNew(e.target.value)}
              />
              <input
                type="password"
                placeholder="Repeat new password"
                value={pwRepeat}
                onChange={(e) => setPwRepeat(e.target.value)}
              />
            </div>
            <p className="settings-hint">
              {/* One consistent story with the Recovery key section — a flat
                  "no recovery" here contradicted it and read as a threat. */}
              There is no password reset. A recovery key (Settings → Recovery
              key) is the only way back in if you forget it.
            </p>
            {pwError && <div className="gate-error">{pwError}</div>}
            <div className="settings-actions">
              <button className="primary btn-ic" onClick={changePassword}>
                {pwSaved ? (<><CircleCheckIcon size={13} /> Password changed</>) : "Change password"}
              </button>
            </div>
            {pwRecoveryCode && (
              // The old recovery key wrapped the old password, so changing it
              // re-issues the key. Same one-time sheet as the Recovery
              // section (the App.css print block keys off .recovery-sheet).
              <div className="recovery-sheet">
                <div className="recovery-sheet-title">
                  Your new recovery key
                </div>
                <div className="recovery-code">{pwRecoveryCode}</div>
                <div className="recovery-sheet-note">
                  Changing your password re-issued this room's recovery key —
                  the old one no longer works. This is shown only once; copy
                  or print it now, then store it away from this Mac.
                </div>
                <div className="recovery-sheet-actions">
                  <button
                    className="primary btn-ic"
                    onClick={() => {
                      setPwRecoveryCopied(true);
                      try {
                        void navigator.clipboard.writeText(pwRecoveryCode);
                      } catch {
                        /* clipboard unavailable — code is still on screen */
                      }
                    }}
                  >
                    {pwRecoveryCopied ? (<><CircleCheckIcon size={13} /> Copied</>) : "Copy code"}
                  </button>
                  <button className="subtle" onClick={() => window.print()}>
                    Print
                  </button>
                  <button
                    className="subtle"
                    onClick={() => setPwRecoveryCode(null)}
                  >
                    Done
                  </button>
                </div>
              </div>
            )}

            {/* ADD-11 — Touch ID unlock */}
            <label className="settings-label">Touch ID unlock</label>
            <div className="settings-toggle-row">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={touchIdOn}
                  onChange={toggleTouchId}
                />
                <span className="switch-track" aria-hidden="true">
                  <span className="switch-thumb" />
                </span>
              </label>
              <span>
                {touchIdOn
                  ? "This room can be unlocked with Touch ID."
                  : "Unlock this room with a fingerprint."}
              </span>
            </div>
            <p className="settings-hint">
              Your password is stored in the macOS Keychain, guarded by
              biometrics — never in the room file. Changing your password
              updates it automatically.
            </p>
            {touchIdErr && <div className="gate-error">{touchIdErr}</div>}

            {/* ADD-4 — duplicate room */}
            <label className="settings-label">Duplicate room</label>
            <p className="settings-hint">
              A full copy of this room as it is right now.
            </p>
            <div className="settings-form">
              <div className="settings-actions dup-dest-row">
                <button className="btn-ic" onClick={chooseDupDest}>
                  Choose destination…
                </button>
                {dupDest && (
                  <span className="dup-dest">{dupDest.split("/").pop()}</span>
                )}
              </div>
              <input
                type="password"
                placeholder="New password for the copy (optional)"
                value={dupPassword}
                onChange={(e) => setDupPassword(e.target.value)}
              />
              <input
                type="password"
                placeholder="Repeat new password"
                value={dupRepeat}
                onChange={(e) => setDupRepeat(e.target.value)}
              />
            </div>
            {dupError && <div className="gate-error">{dupError}</div>}
            <div className="settings-actions">
              <button className="primary btn-ic" onClick={duplicate}>
                {dupDone ? (<><CircleCheckIcon size={13} /> Duplicated</>) : "Duplicate"}
              </button>
            </div>

            {/* SEC-7 — compact room */}
            <label className="settings-label">Compact room</label>
            <p className="settings-hint">
              Reclaims space left by deleted files.
            </p>
            <div className="settings-actions">
              {compactMsg && (
                <span className="settings-confirm">{compactMsg}</span>
              )}
              {compactArmed ? (
                <>
                  <button
                    className="danger"
                    onClick={() => {
                      setCompactArmed(false);
                      compact();
                    }}
                    disabled={compacting}
                  >
                    {compacting ? "Compacting…" : "Confirm compact"}
                  </button>
                  <button
                    className="subtle"
                    onClick={() => setCompactArmed(false)}
                    disabled={compacting}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => {
                    setCompactMsg("");
                    setCompactArmed(true);
                  }}
                  disabled={compacting}
                >
                  Compact room now
                </button>
              )}
            </div>
            {compactErr && <div className="gate-error">{compactErr}</div>}
    </section>
  );
}
