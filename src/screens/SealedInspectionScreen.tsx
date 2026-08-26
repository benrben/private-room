import { formatSize, type SealedPackageInspection } from "../api";
import { fileNameOf } from "../rooms/helpers";
import { useMemo, useState } from "react";

function createdLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function SealedInspectionScreen({
  path,
  inspection,
  busy,
  error,
  onExtract,
  onImport,
  onBack,
}: {
  path: string;
  inspection: SealedPackageInspection;
  busy: boolean;
  error: string;
  onExtract: (fileIds: string[]) => void;
  onImport: () => void;
  onBack: () => void;
}) {
  const allIds = useMemo(() => inspection.files.map((file) => file.fileId), [inspection.files]);
  const [selected, setSelected] = useState(() => new Set(allIds));
  const allSelected = selected.size === allIds.length && allIds.length > 0;
  const toggle = (fileId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  };

  return (
    <section className="sealed-inspection" aria-labelledby="sealed-inspection-title">
      <p className="gate-sub">Read-only sealed backup</p>
      <h2 id="sealed-inspection-title" className="sealed-inspection-title">
        {fileNameOf(path)}
      </h2>
      <dl className="sealed-inspection-meta">
        <div><dt>Created</dt><dd>{createdLabel(inspection.createdAt)}</dd></div>
        <div><dt>Purpose</dt><dd>{inspection.purpose}</dd></div>
        <div><dt>Files</dt><dd>{inspection.fileCount}</dd></div>
        <div><dt>Private history objects</dt><dd>{inspection.objectCount}</dd></div>
      </dl>
      <p className="gate-note">
        Inspection does not edit the backup. Extract copies only the selected normal files;
        importing creates a complete workspace with its private history.
      </p>
      <div className="sealed-inspection-toolbar">
        <strong>Files in this backup</strong>
        <button
          type="button"
          className="subtle"
          disabled={busy || allIds.length === 0}
          onClick={() => setSelected(allSelected ? new Set() : new Set(allIds))}
        >
          {allSelected ? "Clear selection" : "Select all"}
        </button>
      </div>
      {inspection.files.length === 0 ? (
        <p className="gate-note">This backup contains no normal files.</p>
      ) : (
        <ul className="sealed-file-list" aria-label="Files in sealed backup">
          {inspection.files.map((file) => (
            <li key={file.fileId}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.has(file.fileId)}
                  disabled={busy}
                  onChange={() => toggle(file.fileId)}
                />
                <span className="sealed-file-path">{file.relativePath}</span>
                <span className="sealed-file-size">{formatSize(file.sizeBytes)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {error && <div className="gate-error" role="alert">{error}</div>}
      <div className="gate-actions sealed-inspection-actions">
        <button
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => onExtract([...selected])}
        >
          {busy ? "Working…" : `Extract selected (${selected.size})…`}
        </button>
        <button type="button" className="primary" disabled={busy} onClick={onImport}>
          {busy ? "Working…" : "Import as workspace…"}
        </button>
        <button type="button" disabled={busy} onClick={onBack}>Back</button>
      </div>
    </section>
  );
}
