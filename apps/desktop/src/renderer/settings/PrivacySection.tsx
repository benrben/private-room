import { CircleCheckIcon } from "../icons";
import { passwordCriteria, passwordStrength } from "../rooms/helpers";
import { MIN_PASSWORD } from "../rooms/constants";

/** The Create screen's strength meter + checklist, reused verbatim here.
 *
 * Creating a room showed a live meter and a checklist; CHANGING a password —
 * and setting one on a duplicate — showed three blank boxes and then an error
 * after the button, which is the worst moment to learn a rule. Same component
 * both places so the guidance cannot drift, and the minimum comes from
 * `MIN_PASSWORD` rather than being typed out by hand a third and fourth time. */
function PasswordFeedback({ password }: { password: string }) {
  const strength = passwordStrength(password);
  return (
    // Always mounted (like CreateScreen's) so it does not shove the field
    // below it down on the first keystroke.
    <div
      className={`pw-feedback${password ? "" : " reserved"}`}
      aria-hidden={!password}
    >
      <div className={`pw-meter ${strength.level}`}>
        <div className="pw-meter-track">
          <div className="pw-meter-fill" />
        </div>
        <span className="pw-meter-label">{strength.label}</span>
      </div>
      <ul className="pw-criteria">
        {passwordCriteria(password).map((c) => (
          <li key={c.label} className={c.met ? "met" : undefined}>
            {c.met ? "\u2713" : "\u25cb"} {c.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

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

function GateError({ message }: { message: string }) {
  if (!message) return null;
  return <div className="gate-error">{message}</div>;
}

function AutoLockControl({
  autolock,
  changeAutolock,
}: Pick<Props, "autolock" | "changeAutolock">) {
  return (
    <>
      <label className="settings-label">Lock automatically after</label>
      <select
        value={autolock}
        onChange={(event) => changeAutolock(event.target.value)}
      >
        <option value="off">Off — never lock by itself</option>
        <option value="5">5 minutes</option>
        <option value="15">15 minutes</option>
        <option value="60">60 minutes</option>
      </select>
      <p className="settings-hint">
        An idle room locks itself and returns to the password screen.
      </p>
    </>
  );
}

function PasswordChangeButton({
  pwSaved,
  changePassword,
}: Pick<Props, "pwSaved" | "changePassword">) {
  return (
    <button className="primary btn-ic" onClick={changePassword}>
      {pwSaved ? (
        <>
          <CircleCheckIcon size={14} /> Password changed
        </>
      ) : (
        "Change password"
      )}
    </button>
  );
}

function PasswordChangeControls({
  pwCurrent,
  setPwCurrent,
  pwNew,
  setPwNew,
  pwRepeat,
  setPwRepeat,
  pwError,
  pwSaved,
  changePassword,
}: Pick<
  Props,
  | "pwCurrent"
  | "setPwCurrent"
  | "pwNew"
  | "setPwNew"
  | "pwRepeat"
  | "setPwRepeat"
  | "pwError"
  | "pwSaved"
  | "changePassword"
>) {
  return (
    <>
      <label className="settings-label">Change password</label>
      <div className="settings-form">
        <input
          type="password"
          placeholder="Current password"
          value={pwCurrent}
          onChange={(event) => setPwCurrent(event.target.value)}
        />
        <input
          type="password"
          placeholder={`New password (at least ${MIN_PASSWORD} characters)`}
          value={pwNew}
          onChange={(event) => setPwNew(event.target.value)}
        />
        <PasswordFeedback password={pwNew} />
        <input
          type="password"
          placeholder="Repeat new password"
          value={pwRepeat}
          onChange={(event) => setPwRepeat(event.target.value)}
        />
      </div>
      <p className="set-note set-note--flag nb-sem-pending">
        <span className="nb-tape set-note-tag">There is no password reset</span>
        . A recovery key (Settings → Recovery key) is the only way back in if
        you forget it.
      </p>
      <GateError message={pwError} />
      <div className="settings-actions">
        <PasswordChangeButton
          pwSaved={pwSaved}
          changePassword={changePassword}
        />
      </div>
    </>
  );
}

function copyRecoveryCode(code: string, setCopied: (value: boolean) => void) {
  setCopied(true);
  try {
    void navigator.clipboard.writeText(code);
  } catch {
    /* clipboard unavailable — code is still on screen */
  }
}

function PasswordRecoverySheet({
  pwRecoveryCode,
  setPwRecoveryCode,
  pwRecoveryCopied,
  setPwRecoveryCopied,
}: Pick<
  Props,
  | "pwRecoveryCode"
  | "setPwRecoveryCode"
  | "pwRecoveryCopied"
  | "setPwRecoveryCopied"
>) {
  if (!pwRecoveryCode) return null;
  return (
    <div className="recovery-sheet">
      <div className="recovery-sheet-title">Your new recovery key</div>
      <div className="recovery-code">{pwRecoveryCode}</div>
      <div className="recovery-sheet-note">
        Changing your password re-issued this room's recovery key — the old one
        no longer works. This is shown only once; copy or print it now, then
        store it away from this Mac.
      </div>
      <div className="recovery-sheet-actions">
        <button
          className="primary btn-ic"
          onClick={() => copyRecoveryCode(pwRecoveryCode, setPwRecoveryCopied)}
        >
          {pwRecoveryCopied ? (
            <>
              <CircleCheckIcon size={14} /> Copied
            </>
          ) : (
            "Copy code"
          )}
        </button>
        <button className="subtle" onClick={() => window.print()}>
          Print
        </button>
        <button className="subtle" onClick={() => setPwRecoveryCode(null)}>
          Done
        </button>
      </div>
    </div>
  );
}

function TouchIdControls({
  touchIdOn,
  toggleTouchId,
  touchIdErr,
}: Pick<Props, "touchIdOn" | "toggleTouchId" | "touchIdErr">) {
  return (
    <>
      <label className="settings-label">Touch ID unlock</label>
      <div className="settings-toggle-row">
        <label className="switch">
          <input type="checkbox" checked={touchIdOn} onChange={toggleTouchId} />
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
      <p className="set-note">
        Your password is stored in the macOS Keychain, guarded by biometrics —
        never in the room file. Changing your password updates it automatically.
      </p>
      <GateError message={touchIdErr} />
    </>
  );
}

function DuplicateDestination({ dest }: { dest: string }) {
  if (!dest) return null;
  return <span className="dup-dest">{dest.split("/").pop()}</span>;
}

function DuplicatePasswordFeedback({ password }: { password: string }) {
  if (!password) return null;
  return <PasswordFeedback password={password} />;
}

function DuplicateButton({
  dupDone,
  duplicate,
}: Pick<Props, "dupDone" | "duplicate">) {
  return (
    <button className="primary btn-ic" onClick={duplicate}>
      {dupDone ? (
        <>
          <CircleCheckIcon size={14} /> Duplicated
        </>
      ) : (
        "Duplicate"
      )}
    </button>
  );
}

function DuplicateControls({
  chooseDupDest,
  dupDest,
  dupPassword,
  setDupPassword,
  dupRepeat,
  setDupRepeat,
  dupError,
  duplicate,
  dupDone,
}: Pick<
  Props,
  | "chooseDupDest"
  | "dupDest"
  | "dupPassword"
  | "setDupPassword"
  | "dupRepeat"
  | "setDupRepeat"
  | "dupError"
  | "duplicate"
  | "dupDone"
>) {
  return (
    <>
      <label className="settings-label">Duplicate room</label>
      <p className="settings-hint">
        A full copy of this room as it is right now.
      </p>
      <div className="settings-form">
        <div className="settings-actions dup-dest-row">
          <button className="btn-ic" onClick={chooseDupDest}>
            Choose destination…
          </button>
          <DuplicateDestination dest={dupDest} />
        </div>
        <input
          type="password"
          placeholder={`New password for the copy (optional, at least ${MIN_PASSWORD} characters)`}
          value={dupPassword}
          onChange={(event) => setDupPassword(event.target.value)}
        />
        <DuplicatePasswordFeedback password={dupPassword} />
        <input
          type="password"
          placeholder="Repeat new password"
          value={dupRepeat}
          onChange={(event) => setDupRepeat(event.target.value)}
        />
      </div>
      <GateError message={dupError} />
      <div className="settings-actions">
        <DuplicateButton dupDone={dupDone} duplicate={duplicate} />
      </div>
    </>
  );
}

function CompactMessage({ message }: { message: string }) {
  if (!message) return null;
  return <span className="settings-confirm">{message}</span>;
}

function CompactConfirmation({
  compacting,
  setCompactArmed,
  compact,
}: Pick<Props, "compacting" | "setCompactArmed" | "compact">) {
  const confirm = () => {
    setCompactArmed(false);
    compact();
  };
  return (
    <>
      <button className="danger" onClick={confirm} disabled={compacting}>
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
  );
}

function CompactStart({
  compacting,
  setCompactMsg,
  setCompactArmed,
}: Pick<Props, "compacting" | "setCompactMsg" | "setCompactArmed">) {
  const arm = () => {
    setCompactMsg("");
    setCompactArmed(true);
  };
  return (
    <button onClick={arm} disabled={compacting}>
      Compact room now
    </button>
  );
}

function CompactActions(
  props: Pick<
    Props,
    | "compactArmed"
    | "compacting"
    | "setCompactMsg"
    | "setCompactArmed"
    | "compact"
  >,
) {
  if (props.compactArmed) {
    return (
      <CompactConfirmation
        compacting={props.compacting}
        setCompactArmed={props.setCompactArmed}
        compact={props.compact}
      />
    );
  }
  return (
    <CompactStart
      compacting={props.compacting}
      setCompactMsg={props.setCompactMsg}
      setCompactArmed={props.setCompactArmed}
    />
  );
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

      <AutoLockControl autolock={autolock} changeAutolock={changeAutolock} />

      <PasswordChangeControls
        pwCurrent={pwCurrent}
        setPwCurrent={setPwCurrent}
        pwNew={pwNew}
        setPwNew={setPwNew}
        pwRepeat={pwRepeat}
        setPwRepeat={setPwRepeat}
        pwError={pwError}
        pwSaved={pwSaved}
        changePassword={changePassword}
      />
      <PasswordRecoverySheet
        pwRecoveryCode={pwRecoveryCode}
        setPwRecoveryCode={setPwRecoveryCode}
        pwRecoveryCopied={pwRecoveryCopied}
        setPwRecoveryCopied={setPwRecoveryCopied}
      />

      <TouchIdControls
        touchIdOn={touchIdOn}
        toggleTouchId={toggleTouchId}
        touchIdErr={touchIdErr}
      />

      <DuplicateControls
        chooseDupDest={chooseDupDest}
        dupDest={dupDest}
        dupPassword={dupPassword}
        setDupPassword={setDupPassword}
        dupRepeat={dupRepeat}
        setDupRepeat={setDupRepeat}
        dupError={dupError}
        duplicate={duplicate}
        dupDone={dupDone}
      />

      <label className="settings-label">Compact room</label>
      <p className="settings-hint">
        Rewrites the room file so the space deleted files were using is
        released. Nothing still in the room is touched, but the remains of
        deleted files are gone for good afterwards, and this cannot be undone.
      </p>
      <div className="settings-actions">
        <CompactMessage message={compactMsg} />
        <CompactActions
          compactArmed={compactArmed}
          compacting={compacting}
          setCompactMsg={setCompactMsg}
          setCompactArmed={setCompactArmed}
          compact={compact}
        />
      </div>
      <GateError message={compactErr} />
    </section>
  );
}
