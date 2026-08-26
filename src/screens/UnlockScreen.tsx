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
  onConvertLegacy,
  onInspectSealed,
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
          {/* The room's file name is set in the mono face (.gate-file): it is
              a file name, and which file you are about to open is the only
              question this screen asks. */}
          <p className="gate-sub">
            Unlock <strong className="gate-file">{fileNameOf(path)}</strong>
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
              onClick={() => onEnterRecoveryMode()}
            >
              <RecoveryKeyIcon size={14} /> Forgot password? Use a recovery
              code
            </button>
          )}
          {/\.(?:arcelle|roomai)$/i.test(path) && (
            <>
              <button
                type="button"
                className="subtle recovery-forgot"
                disabled={busy}
                onClick={() => onConvertLegacy()}
              >
                Convert legacy room to normal files…
              </button>
              {path.toLocaleLowerCase().endsWith(".arcelle") && (
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
            Unlock <strong className="gate-file">{fileNameOf(path)}</strong>{" "}
            with a recovery code
          </p>
          {/* A recovery code is data that has to be transcribed exactly, so
              the field it is typed into is the mono face — the same face the
              code was shown and printed in. Never the hand, and never the
              sans: an O and a 0 have to be told apart here. */}
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
          {/* A code can come from three places (setup, Settings → Recovery
              key, a password change), and each new one is written over the
              single `<room>.recovery` sidecar — so an older code is not a
              wrong code, it is a code that no longer exists. Using one does
              not consume it: open_room_with_recovery only unseals the
              password it already held. */}
          <p className="gate-note">
            The recovery code was shown once, when it was made — at setup, in
            Settings, or when the password was last changed. Only the newest
            one works. Unlocking with a code doesn't change the password, and
            the same code keeps working until you make a new one.
          </p>
        </form>
      )}
    </>
  );
}
