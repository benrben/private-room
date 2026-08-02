import { ReactNode, useEffect, useRef } from "react";
import { CheckIcon, CloseIcon } from "../icons";

interface DeleteControlProps {
  k: string;
  trigger: ReactNode;
  onConfirm: () => void;
  title: string;
  confirmDelete: string | null;
  askConfirm: (key: string) => void;
  cancelConfirm: () => void;
}

/** A trash/× button that first asks "Delete? ✓ ✕" before firing. Extracted
 * verbatim from Workspace's deleteControl helper.
 *
 * The swap used to be silent and invisible to anyone not looking at it: the
 * trigger unmounted, so keyboard focus fell to the body and a screen reader
 * announced nothing at all — the button simply stopped existing mid-press.
 * The armed prompt therefore announces itself AND takes the focus the trigger
 * just lost, and hands it back when the question is dismissed. */
export default function DeleteControl({
  k,
  trigger,
  onConfirm,
  title,
  confirmDelete,
  askConfirm,
  cancelConfirm,
}: DeleteControlProps) {
  const armed = confirmDelete === k;
  const yesRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const wasArmed = useRef(false);
  useEffect(() => {
    if (armed) {
      yesRef.current?.focus();
    } else if (wasArmed.current) {
      // Only when the prompt itself was holding the focus. Disarming happens
      // for other reasons too (opening the row's context menu clears it), and
      // yanking focus back out of whatever opened would be its own bug.
      const active = document.activeElement;
      if (!active || active === document.body) triggerRef.current?.focus();
    }
    wasArmed.current = armed;
  }, [armed]);

  if (armed) {
    return (
      // ADD-25: an armed destructive confirm is a consent surface — the agent
      // driver must not be able to click ✓ on a delete it didn't earn.
      <span className="confirm-del" data-agent-blocked role="alert">
        <span className="confirm-q">Delete?</span>
        <button
          ref={yesRef}
          className="chip-btn confirm-yes"
          title="Confirm delete"
          aria-label="Confirm delete"
          onClick={() => {
            cancelConfirm();
            onConfirm();
          }}
        >
          <CheckIcon size={13} />
        </button>
        <button className="chip-btn confirm-no" title="Keep" aria-label="Keep" onClick={cancelConfirm}>
          <CloseIcon size={13} />
        </button>
      </span>
    );
  }
  return (
    <button
      ref={triggerRef}
      className="chip-btn danger"
      title={title}
      aria-label={title}
      onClick={() => askConfirm(k)}
    >
      {trigger}
    </button>
  );
}
