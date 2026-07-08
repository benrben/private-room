import { CloseIcon } from "../icons";
import { Toast } from "./types";

interface ToastsProps {
  toasts: Toast[];
  dismissToast: (id: number) => void;
}

/** The transient toast stack shown above the composer. Presentational only —
 * the shell owns the toast list and its lifecycle. */
export default function Toasts({ toasts, dismissToast }: ToastsProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
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
            onClick={() => dismissToast(t.id)}
          >
            <CloseIcon size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
