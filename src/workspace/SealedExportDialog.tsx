import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api } from "../api";
import { DownloadIcon } from "../icons";
import { MIN_PASSWORD } from "../rooms/constants";
import { sealedExportPasswordProblem } from "../rooms/passwordChange";
import { useFocusTrap } from "../settings/useFocusTrap";

type PasswordMode = "room" | "alternate";

export default function SealedExportDialog({
  onClose,
  pushToast,
}: {
  onClose: () => void;
  pushToast: (kind: "success" | "error", message: string) => void;
}) {
  const [mode, setMode] = useState<PasswordMode>("room");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const decline = () => {
    if (!busy) onClose();
  };
  const { modalRef, onModalKeyDown } = useFocusTrap(decline);

  const create = async () => {
    if (busy) return;
    const alternate = mode === "alternate";
    const problem = alternate
      ? sealedExportPasswordProblem(password, repeat, MIN_PASSWORD)
      : null;
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const destination = await api.chooseSavePath({
        title: "Save sealed Arcelle backup",
        defaultPath: "Room Backup.arcelle",
        filters: [{ name: "Arcelle sealed backup", extensions: ["arcelle"] }],
      });
      if (!destination) {
        setBusy(false);
        return;
      }
      const info = await api.createSealedPackage(
        destination,
        alternate ? password : null,
      );
      pushToast(
        "success",
        `Sealed ${info.fileCount} file${info.fileCount === 1 ? "" : "s"} into the backup.`,
      );
      onClose();
    } catch (reason) {
      const message = String(reason);
      setError(message);
      pushToast("error", message);
      setBusy(false);
    }
  };

  return (
    <div className="approve-backdrop">
      <div
        ref={modalRef}
        className="approve-card sealed-export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sealed-export-title"
        tabIndex={-1}
        onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (event.key === "Escape") event.stopPropagation();
          onModalKeyDown(event);
        }}
      >
        <div className="approve-kind">
          <span className="nb-cat nb-sem-saved">Encrypted backup</span>
        </div>
        <div className="approve-title" id="sealed-export-title">
          <DownloadIcon size={16} /> Create sealed backup
        </div>
        <p className="approve-body">
          Save one encrypted <code>.arcelle</code> file containing the normal files and private room history.
        </p>
        <fieldset className="sealed-export-options" disabled={busy}>
          <legend>Password for this backup</legend>
          <label>
            <input
              type="radio"
              name="sealed-export-password-mode"
              checked={mode === "room"}
              onChange={() => { setMode("room"); setError(""); }}
            />
            Use this room&apos;s password
          </label>
          <label>
            <input
              type="radio"
              name="sealed-export-password-mode"
              checked={mode === "alternate"}
              onChange={() => { setMode("alternate"); setError(""); }}
            />
            Use a different password
          </label>
        </fieldset>
        {mode === "alternate" && (
          <div className="sealed-export-fields">
            <label htmlFor="sealed-export-password">Backup password</label>
            <input
              id="sealed-export-password"
              type="password"
              autoComplete="new-password"
              value={password}
              disabled={busy}
              onChange={(event) => { setPassword(event.target.value); setError(""); }}
            />
            <label htmlFor="sealed-export-repeat">Repeat backup password</label>
            <input
              id="sealed-export-repeat"
              type="password"
              autoComplete="new-password"
              value={repeat}
              disabled={busy}
              onChange={(event) => { setRepeat(event.target.value); setError(""); }}
            />
            <p className="approve-body caption">Use at least {MIN_PASSWORD} characters.</p>
          </div>
        )}
        {error && <div className="gate-error" role="alert">{error}</div>}
        <div className="approve-actions sealed-export-actions">
          <button className="primary" disabled={busy} onClick={() => void create()}>
            {busy ? "Creating backup…" : "Choose location and create"}
          </button>
          <button disabled={busy} onClick={decline}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
