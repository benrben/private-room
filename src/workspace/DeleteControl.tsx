import { ReactNode } from "react";

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
      <span className="confirm-del">
        <span className="confirm-q">Delete?</span>
        <button
          className="chip-btn confirm-yes"
          title="Confirm delete"
          onClick={() => {
            cancelConfirm();
            onConfirm();
          }}
        >
          ✓
        </button>
        <button className="chip-btn confirm-no" title="Keep" onClick={cancelConfirm}>
          ✕
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
