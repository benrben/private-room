import { ReactNode } from "react";
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
 * verbatim from Workspace's deleteControl helper. */
export default function DeleteControl({
  k,
  trigger,
  onConfirm,
  title,
  confirmDelete,
  askConfirm,
  cancelConfirm,
}: DeleteControlProps) {
  if (confirmDelete === k) {
    return (
      // ADD-25: an armed destructive confirm is a consent surface — the agent
      // driver must not be able to click ✓ on a delete it didn't earn.
      <span className="confirm-del" data-agent-blocked>
        <span className="confirm-q">Delete?</span>
        <button
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
      className="chip-btn danger"
      title={title}
      onClick={() => askConfirm(k)}
    >
      {trigger}
    </button>
  );
}
