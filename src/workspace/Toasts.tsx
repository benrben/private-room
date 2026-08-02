import { CloseIcon } from "../icons";
import { Toast } from "./types";

interface ToastsProps {
  toasts: Toast[];
  dismissToast: (id: number) => void;
}

/** The toast stack shown above the composer. Presentational only — the shell
 * owns the toast list and its lifecycle.
 *
 * These are the app's only report that something failed, so they are ANNOUNCED:
 * the stack is a live region, and an error is an `alert` (interrupting) while
 * successes and notices are polite `status` messages. Without this a blind user
 * was told nothing at all when an action failed. */
export default function Toasts({ toasts, dismissToast }: ToastsProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.kind}`}
          role={t.kind === "error" ? "alert" : "status"}
        >
          <span className="toast-text">{t.text}</span>
          {t.action && (
            <button
              className="subtle accent toast-action"
              onClick={() => {
                t.action?.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button
            className="toast-close"
            title="Dismiss"
            aria-label="Dismiss this message"
            onClick={() => dismissToast(t.id)}
          >
            <CloseIcon size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
