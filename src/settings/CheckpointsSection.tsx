import type { CheckpointMeta } from "../api";

interface Props {
  checkpoints: CheckpointMeta[];
  totalBytes: number;
  ckName: string;
  setCkName: (v: string) => void;
  creating: boolean;
  ckError: string;
  ckNotice: string;
  confirmRollback: string | null;
  setConfirmRollback: (v: string | null) => void;
  rollingBack: boolean;
  createCheckpoint: () => void;
  deleteCheckpoint: (id: string) => void;
  rollback: (id: string) => void;
  /** True when a job is running/queued, a recording is live, or an answer is
   * streaming — rolling back mid-write is refused by the backend too, but the
   * disabled button explains why up front (Idea 9 amendment: threaded from the
   * workspace since Settings itself has no access to that state). */
  busy: boolean;
}

function formatBytes(n: number): string {
  if (n <= 0) return "0 MB";
  const mb = n / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function formatWhen(iso: string): string {
  // Checkpoint timestamps are UTC "YYYY-MM-DD HH:MM:SS" (SQLite style); append
  // Z so they render in the viewer's local zone.
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const ONE_GB = 1024 * 1024 * 1024;

/** Idea 9: create/list/delete room checkpoints and roll back to one. Cribs the
 * Time Machine popover's row anatomy and lives with the other whole-room safety
 * ops (duplicate/compact) in Settings → Privacy neighborhood. */
export default function CheckpointsSection({
  checkpoints,
  totalBytes,
  ckName,
  setCkName,
  creating,
  ckError,
  ckNotice,
  confirmRollback,
  setConfirmRollback,
  rollingBack,
  createCheckpoint,
  deleteCheckpoint,
  rollback,
  busy,
}: Props) {
  return (
    <section id="set-checkpoints">
      <h3>Checkpoints</h3>
      <p className="settings-hint">
        A checkpoint is a full, encrypted copy of this whole room — like a git
        commit you can roll back to. Creating one is safe and non-destructive;
        rolling back replaces the room's current state (a “Before rollback” copy
        is taken first).
      </p>

      <label className="settings-label">Create a checkpoint</label>
      <div className="settings-form ckpt-create">
        <input
          type="text"
          placeholder="Name (optional) — e.g. before cleanup"
          value={ckName}
          disabled={creating || rollingBack}
          onChange={(e) => setCkName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !creating) createCheckpoint();
          }}
        />
        <button
          className="primary"
          disabled={creating || rollingBack}
          onClick={createCheckpoint}
        >
          {creating ? "Saving…" : "Create checkpoint"}
        </button>
      </div>
      {ckNotice && <div className="ckpt-notice">{ckNotice}</div>}
      {ckError && <div className="gate-error">{ckError}</div>}

      {checkpoints.length > 0 && (
        <>
          <div className="ckpt-total">
            {checkpoints.length} checkpoint
            {checkpoints.length === 1 ? "" : "s"} · {formatBytes(totalBytes)} on
            disk
          </div>
          {totalBytes > ONE_GB && (
            <p className="settings-hint ckpt-warn">
              Each checkpoint is a full copy of this room, including recordings —
              these are using a lot of disk. Delete old ones you don't need.
            </p>
          )}
          <div className="ckpt-list">
            {checkpoints.map((c) =>
              confirmRollback === c.id ? (
                <div key={c.id} className="ckpt-confirm" data-agent-blocked>
                  <span className="ckpt-confirm-q">
                    Roll the whole room back to “{c.name}”? Everything since is
                    replaced (a “Before rollback” copy is saved first).
                  </span>
                  <div className="ckpt-confirm-actions">
                    <button
                      className="primary"
                      onClick={() => rollback(c.id)}
                    >
                      Roll back
                    </button>
                    <button
                      className="subtle"
                      onClick={() => setConfirmRollback(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div key={c.id} className="ckpt-row">
                  <span
                    className={`ckpt-dot${c.auto ? " auto" : ""}`}
                    title={c.auto ? "Automatic pre-rollback copy" : "Checkpoint"}
                  />
                  <span className="ckpt-meta">
                    <span className="ckpt-name" dir="auto">
                      {c.name}
                    </span>
                    <span className="ckpt-sub">
                      {formatWhen(c.createdAt)} · {formatBytes(c.sizeBytes)}
                    </span>
                  </span>
                  <span className="ckpt-actions">
                    <button
                      className="subtle ckpt-action"
                      title={
                        busy
                          ? "Finish or stop running work first"
                          : "Replace the room with this checkpoint"
                      }
                      disabled={busy || rollingBack}
                      onClick={() => setConfirmRollback(c.id)}
                    >
                      Roll back
                    </button>
                    <button
                      className="subtle ckpt-action"
                      title="Delete this checkpoint and free its disk space"
                      disabled={rollingBack}
                      onClick={() => deleteCheckpoint(c.id)}
                    >
                      Delete
                    </button>
                  </span>
                </div>
              ),
            )}
          </div>
        </>
      )}
      {rollingBack && (
        <div className="settings-hint">Rolling back — reopening the room…</div>
      )}
    </section>
  );
}
