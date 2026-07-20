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
  onEnterRecoveryMode: () => void;
  onExitRecoveryMode: () => void;
  onBack: () => void;
};

export function UnlockScreen({
  path,
  recoveryMode,
  canTouchId,
  hasRecovery,
  busy,
  password,
  setPassword,
  recoveryInput,
  setRecoveryInput,
  error,
  setError,
  onUnlock,
  onRecoveryUnlock,
  onTouchId,
  onEnterRecoveryMode,
  onExitRecoveryMode,
  onBack,
}: UnlockScreenProps) {
  return (
    <>
      {!recoveryMode && (
        <form
          className="gate-form"
          onSubmit={(e) => {
            e.preventDefault();
            onUnlock();
          }}
        >
          <p className="gate-sub">
            Unlock <strong>{fileNameOf(path)}</strong>
          </p>
          {canTouchId && (
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
          )}
          <input
            type="password"
            placeholder="Password"
            className={error ? "invalid" : undefined}
            aria-invalid={!!error}
            value={password}
            autoFocus
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError("");
            }}
          />
          {error && (
            <div className="gate-error" role="alert">
              <span className="gate-error-ic" aria-hidden="true">!</span>
              {error}
            </div>
          )}
          {!canTouchId && (
            <p className="gate-hint">
              Tip: enable fingerprint unlock in Settings → Privacy.
            </p>
          )}
          <div className="gate-actions">
            <button className="primary" type="submit" disabled={busy}>
              {busy ? "Unlocking…" : "Unlock"}
            </button>
            <button type="button" onClick={onBack}>
              Back
            </button>
          </div>
          {/* Recovery affordance — only when this room has a recovery
              sidecar. Password stays the primary path above. */}
          {hasRecovery && (
            <button
              type="button"
              className="subtle recovery-forgot"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
              onClick={() => onEnterRecoveryMode()}
            >
              <RecoveryKeyIcon size={14} /> Forgot password? Use a recovery
              code
            </button>
          )}
        </form>
      )}

      {recoveryMode && (
        <form
          className="gate-form"
          onSubmit={(e) => {
            e.preventDefault();
            onRecoveryUnlock();
          }}
        >
          <p className="gate-sub">
            Unlock <strong>{fileNameOf(path)}</strong> with a recovery
            code
          </p>
          <input
            type="text"
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            className={error ? "invalid" : undefined}
            aria-invalid={!!error}
            value={recoveryInput}
            autoFocus
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => {
              // The code is all-uppercase (see RECOVERY_ALPHABET). The
              // `autoCapitalize` attribute only acts on soft keyboards, so a
              // desktop WKWebView left lowercase typing lowercase — uppercase
              // it here so the field matches the shown XXXX-XXXX format.
              // Length-preserving, so the caret doesn't jump.
              setRecoveryInput(e.target.value.toUpperCase());
              if (error) setError("");
            }}
          />
          {error && (
            <div className="gate-error" role="alert">
              <span className="gate-error-ic" aria-hidden="true">!</span>
              {error}
            </div>
          )}
          <div className="gate-actions">
            <button
              className="primary"
              type="submit"
              disabled={busy || !recoveryInput.trim()}
            >
              {busy ? "Unlocking…" : "Unlock with code"}
            </button>
            <button
              type="button"
              onClick={() => onExitRecoveryMode()}
            >
              Use password instead
            </button>
          </div>
          <p className="gate-note">
            The recovery code was shown once, when this room was created.
          </p>
        </form>
      )}
    </>
  );
}
