import { fileNameOf } from "../rooms/helpers";
import { RecoveryKeyIcon } from "./RecoveryKeyIcon";

type UnlockScreenProps = {
  path: string;
  recoveryMode: boolean;
  canTouchId: boolean;
  hasRecovery: boolean;
  busy: boolean;
  password: string;
  setPassword: (v: string) => void;
  recoveryInput: string;
  setRecoveryInput: (v: string) => void;
  error: string;
  setError: (v: string) => void;
  onUnlock: () => void;
  onRecoveryUnlock: () => void;
  onTouchId: () => void;
  onConvertLegacy: () => void;
  onInspectSealed: () => void;
  onEnterRecoveryMode: () => void;
  onExitRecoveryMode: () => void;
  onBack: () => void;
};

type PasswordProps = Pick<
  UnlockScreenProps,
  | "path"
  | "canTouchId"
  | "hasRecovery"
  | "busy"
  | "password"
  | "setPassword"
  | "error"
  | "setError"
  | "onUnlock"
  | "onTouchId"
  | "onConvertLegacy"
  | "onInspectSealed"
  | "onEnterRecoveryMode"
  | "onBack"
>;

type RecoveryProps = Pick<
  UnlockScreenProps,
  | "path"
  | "busy"
  | "recoveryInput"
  | "setRecoveryInput"
  | "error"
  | "setError"
  | "onRecoveryUnlock"
  | "onExitRecoveryMode"
>;

function isLegacyRoom(path: string) {
  return /\.(?:arcelle|roomai)$/i.test(path);
}

function isSealedBackup(path: string) {
  return path.toLocaleLowerCase().endsWith(".arcelle");
}

function clearError(error: string, setError: (value: string) => void) {
  if (error) setError("");
}

function UnlockError({ error }: Pick<UnlockScreenProps, "error">) {
  if (!error) return null;
  return (
    <div className="gate-error" role="alert">
      <span className="gate-error-ic" aria-hidden="true">
        !
      </span>
      {error}
    </div>
  );
}

function WorkspaceFileNote({ path }: Pick<UnlockScreenProps, "path">) {
  if (isLegacyRoom(path)) return null;
  return (
    <p className="gate-note">
      This password unlocks chats, memory, search, and history. The normal files
      in this workspace remain readable in Finder.
    </p>
  );
}

function TouchIdButton({
  canTouchId,
  busy,
  onTouchId,
}: Pick<UnlockScreenProps, "canTouchId" | "busy" | "onTouchId">) {
  if (!canTouchId) return null;
  return (
    <button
      type="button"
      className="touchid-btn"
      disabled={busy}
      onClick={() => onTouchId()}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 10a2 2 0 0 0-2 2c0 1.5.1 3 .5 4.5" />
        <path d="M8.5 8a5 5 0 0 1 7.5 4.3c0 1.4.1 2.8.4 4.2" />
        <path d="M5 12a7 7 0 0 1 13-3.6" />
        <path d="M6.2 16.5c-.4-1.5-.5-3-.5-4.5" />
        <path d="M12 12v1.5c0 2 .2 4 .8 6" />
      </svg>
      Use Touch ID
    </button>
  );
}

function PasswordInput({
  password,
  setPassword,
  error,
  setError,
}: Pick<UnlockScreenProps, "password" | "setPassword" | "error" | "setError">) {
  return (
    <input
      type="password"
      placeholder="Password"
      className={error ? "invalid" : undefined}
      aria-invalid={!!error}
      value={password}
      autoFocus
      onChange={(event) => {
        setPassword(event.target.value);
        clearError(error, setError);
      }}
    />
  );
}

function PasswordActions({
  busy,
  onBack,
}: Pick<UnlockScreenProps, "busy" | "onBack">) {
  return (
    <div className="gate-actions">
      <button className="primary" type="submit" disabled={busy}>
        {busy ? "Unlocking…" : "Unlock"}
      </button>
      <button type="button" onClick={onBack}>
        Back
      </button>
    </div>
  );
}

function RecoveryOption({
  hasRecovery,
  onEnterRecoveryMode,
}: Pick<UnlockScreenProps, "hasRecovery" | "onEnterRecoveryMode">) {
  if (!hasRecovery) return null;
  return (
    <button
      type="button"
      className="subtle recovery-forgot"
      onClick={() => onEnterRecoveryMode()}
    >
      <RecoveryKeyIcon size={14} /> Forgot password? Use a recovery code
    </button>
  );
}

function LegacyActions({
  path,
  busy,
  onConvertLegacy,
  onInspectSealed,
}: Pick<
  UnlockScreenProps,
  "path" | "busy" | "onConvertLegacy" | "onInspectSealed"
>) {
  if (!isLegacyRoom(path)) return null;
  return (
    <>
      <button
        type="button"
        className="subtle recovery-forgot"
        disabled={busy}
        onClick={() => onConvertLegacy()}
      >
        Convert legacy room to normal files…
      </button>
      {isSealedBackup(path) && (
        <button
          type="button"
          className="subtle recovery-forgot"
          disabled={busy}
          onClick={() => onInspectSealed()}
        >
          Inspect sealed backup…
        </button>
      )}
    </>
  );
}

function PasswordUnlockForm({
  path,
  canTouchId,
  hasRecovery,
  busy,
  password,
  setPassword,
  error,
  setError,
  onUnlock,
  onTouchId,
  onConvertLegacy,
  onInspectSealed,
  onEnterRecoveryMode,
  onBack,
}: PasswordProps) {
  return (
    <form
      className="gate-form"
      onSubmit={(e) => {
        e.preventDefault();
        onUnlock();
      }}
    >
      <p className="gate-sub">
        Unlock <strong className="gate-file">{fileNameOf(path)}</strong>
      </p>
      <WorkspaceFileNote path={path} />
      <TouchIdButton
        canTouchId={canTouchId}
        busy={busy}
        onTouchId={onTouchId}
      />
      <PasswordInput
        password={password}
        setPassword={setPassword}
        error={error}
        setError={setError}
      />
      <UnlockError error={error} />
      <PasswordActions busy={busy} onBack={onBack} />
      <RecoveryOption
        hasRecovery={hasRecovery}
        onEnterRecoveryMode={onEnterRecoveryMode}
      />
      <LegacyActions
        path={path}
        busy={busy}
        onConvertLegacy={onConvertLegacy}
        onInspectSealed={onInspectSealed}
      />
    </form>
  );
}

function RecoveryCodeInput({
  recoveryInput,
  setRecoveryInput,
  error,
  setError,
}: Pick<
  UnlockScreenProps,
  "recoveryInput" | "setRecoveryInput" | "error" | "setError"
>) {
  return (
    <input
      type="text"
      placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
      className={`gate-code-input${error ? " invalid" : ""}`}
      aria-invalid={!!error}
      value={recoveryInput}
      autoFocus
      autoCapitalize="characters"
      autoCorrect="off"
      spellCheck={false}
      onChange={(event) => {
        setRecoveryInput(event.target.value.toUpperCase());
        clearError(error, setError);
      }}
    />
  );
}

function RecoveryActions({
  busy,
  recoveryInput,
  onExitRecoveryMode,
}: Pick<UnlockScreenProps, "busy" | "recoveryInput" | "onExitRecoveryMode">) {
  return (
    <div className="gate-actions">
      <button
        className="primary"
        type="submit"
        disabled={busy || !recoveryInput.trim()}
      >
        {busy ? "Unlocking…" : "Unlock with code"}
      </button>
      <button type="button" onClick={() => onExitRecoveryMode()}>
        Use password instead
      </button>
    </div>
  );
}

function RecoveryHelp() {
  return (
    <p className="gate-note">
      The recovery code was shown once, when it was made — at setup, in
      Settings, or when the password was last changed. Only the newest one
      works. Unlocking with a code doesn't change the password, and the same
      code keeps working until you make a new one.
    </p>
  );
}

function RecoveryUnlockForm({
  path,
  busy,
  recoveryInput,
  setRecoveryInput,
  error,
  setError,
  onRecoveryUnlock,
  onExitRecoveryMode,
}: RecoveryProps) {
  return (
    <form
      className="gate-form"
      onSubmit={(event) => {
        event.preventDefault();
        onRecoveryUnlock();
      }}
    >
      <p className="gate-sub">
        Unlock <strong className="gate-file">{fileNameOf(path)}</strong> with a
        recovery code
      </p>
      <RecoveryCodeInput
        recoveryInput={recoveryInput}
        setRecoveryInput={setRecoveryInput}
        error={error}
        setError={setError}
      />
      <UnlockError error={error} />
      <RecoveryActions
        busy={busy}
        recoveryInput={recoveryInput}
        onExitRecoveryMode={onExitRecoveryMode}
      />
      <RecoveryHelp />
    </form>
  );
}

export function UnlockScreen(props: UnlockScreenProps) {
  if (props.recoveryMode) return <RecoveryUnlockForm {...props} />;
  return <PasswordUnlockForm {...props} />;
}
