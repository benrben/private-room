import { CloseIcon } from "../icons";
import { Toast } from "./types";

interface ToastsProps {
  toasts: Toast[];
  dismissToast: (id: number) => void;
}

/** The word each kind of toast carries, and the marker that rides with it.
 *
 * A toast used to say what it was with a coloured left edge and nothing else,
 * which is the one thing the product's rules forbid: colour is never the only
 * carrier of a status. Now every toast opens with a strip of marker tape
 * bearing the word, so "this failed" survives being read in greyscale, by
 * someone who cannot separate red from green, or out loud — the tape is inside
 * the live region, so the word is announced before the message it labels.
 *
 * The marker MEANINGS are product-wide (tokens.css): red is failure, green is
 * complete, blue is informational. They are set here through the semantic
 * classes rather than by hue, so the mapping is the stylesheet's fact rather
 * than a convention this file happens to follow. */
const TOAST_WORD: Record<Toast["kind"], string> = {
  success: "Done",
  error: "Failed",
  info: "Note",
};
const TOAST_MARK: Record<Toast["kind"], string> = {
  success: "nb-sem-done",
  error: "nb-sem-urgent",
  info: "nb-sem-linked",
};

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
          <span className={`nb-tape toast-mark ${TOAST_MARK[t.kind]}`}>
            {TOAST_WORD[t.kind]}
          </span>
          <span className="toast-text">{t.text}</span>
          {t.action && (
            <button
              // .nb-btn-go hangs the system's drawn arrow off the label. This
              // is the only control on a toast that goes somewhere — the other
              // one dismisses it — so it is the only one that gets the mark.
              className="subtle accent toast-action nb-btn-go"
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
