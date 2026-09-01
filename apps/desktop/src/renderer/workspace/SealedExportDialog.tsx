import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api } from "../api";
import { DownloadIcon } from "../icons";
import { MIN_PASSWORD } from "../rooms/constants";
import { sealedExportPasswordProblem } from "../rooms/passwordChange";
import { useFocusTrap } from "../settings/useFocusTrap";

type PasswordMode = "room" | "alternate";
type Toast = (kind: "success" | "error", message: string) => void;

async function saveSealedBackup(password: string | null) {
  const destination = await api.chooseSavePath({
    title: "Save sealed Arcelle backup",
    defaultPath: "Room Backup.arcelle",
    filters: [{ name: "Arcelle sealed backup", extensions: ["arcelle"] }],
  });
  if (!destination) return null;
  return api.createSealedPackage(destination, password);
}

function sealedExportSuccess(fileCount: number): string {
  return `Sealed ${fileCount} file${fileCount === 1 ? "" : "s"} into the backup.`;
}

function backupPassword(mode: PasswordMode, password: string): string | null {
  return mode === "alternate" ? password : null;
}

function alternatePasswordProblem(mode: PasswordMode, password: string, repeat: string): string | null {
  if (mode !== "alternate") return null;
  return sealedExportPasswordProblem(password, repeat, MIN_PASSWORD);
}

export default function SealedExportDialog({
  onClose,
  pushToast,
}: {
  onClose: () => void;
  pushToast: Toast;
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
    const problem = alternatePasswordProblem(mode, password, repeat);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const info = await saveSealedBackup(backupPassword(mode, password));
      if (!info) {
        setBusy(false);
        return;
      }
      pushToast("success", sealedExportSuccess(info.fileCount));
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
