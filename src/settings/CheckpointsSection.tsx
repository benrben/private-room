import { useState } from "react";
import { formatSize } from "../api";
import type { CheckpointMeta, RoomStorageUsage, WorkspaceWatcherStatus } from "../api";
import { formatWhen } from "../workspace/composer";

interface Props {
  checkpoints: CheckpointMeta[];
  totalBytes: number;
  storageUsage: RoomStorageUsage | null;
  watcherStatus: WorkspaceWatcherStatus | null;
  rescanning: boolean;
  rescanRoom: () => void;
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

/** Checkpoints written before room_checkpoints.rs switched to ISO carry
 * SQLite's zone-less "YYYY-MM-DD HH:MM:SS", and the manifest on disk is never
 * rewritten — so those rows still arrive that way and would otherwise be read
 * as LOCAL time and shown in the wrong hour. Repair only the shape; the
 * formatting itself is the app's one `composer.formatWhen`, not a second
 * near-identical copy of it living here. */
function asIso(t: string): string {
  return t.includes("T") ? t : t.replace(" ", "T") + "Z";
}

const ONE_GB = 1024 * 1024 * 1024;

/** Idea 9: create/list/delete room checkpoints and roll back to one. Cribs the
 * Time Machine popover's row anatomy and lives with the other whole-room safety
 * ops (duplicate/compact) in Settings → Privacy neighborhood. */
export default function CheckpointsSection({
  checkpoints,
  totalBytes,
  storageUsage,
  watcherStatus,
  rescanning,
  rescanRoom,
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
  // A checkpoint is a full copy of the room and Delete does NOT go to the
  // Trash — it is often the only way back after a mistake, and it used to fire
  // on one click while "Roll back", which is reversible, asked first. Same
  // inline question as the rollback arm, so the two destructive acts in this
  // list behave the same way round.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  return (
    <section id="set-checkpoints">
      <h3>Room storage</h3>
      {storageUsage && (
        <div className="ckpt-list">
          <div className="ckpt-total">
            Current files · {formatSize(storageUsage.liveFileBytes)}
          </div>
          <div className="ckpt-total">
            Encrypted Arcelle database · {formatSize(storageUsage.databaseBytes)}
          </div>
          <div className="ckpt-total">
            Private encrypted history · {formatSize(storageUsage.privateHistoryBytes)}
          </div>
          <p className="settings-hint">
            {storageUsage.kind === "workspace"
              ? `Total managed disk use is ${formatSize(storageUsage.totalOnDiskBytes)}. Current files are normal files; chats, indexes, metadata and history stay private.`
              : `This legacy room uses ${formatSize(storageUsage.totalOnDiskBytes)} in one encrypted database file. Current files and history are included inside it.`}
          </p>
          {watcherStatus && (
            <div className="settings-form">
              <span className={watcherStatus.state === "error" ? "gate-error" : "settings-hint"}>
                File watcher: {watcherStatus.state}
                {watcherStatus.lastError ? ` — ${watcherStatus.lastError}` : ""}
              </span>
              <button className="subtle" disabled={rescanning} onClick={rescanRoom}>
                {rescanning ? "Rescanning…" : "Rescan room"}
              </button>
            </div>
          )}
        </div>
      )}

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
            {checkpoints.length === 1 ? "" : "s"} · {formatSize(totalBytes)} on
            disk
          </div>
          {totalBytes > ONE_GB && (
            <p className="ckpt-warn set-note set-note--flag nb-sem-pending">
              Each checkpoint is a full copy of this room, including recordings —
              these are using a lot of disk. Delete old ones you don't need.
            </p>
          )}
          <div className="ckpt-list">
            {checkpoints.map((c) =>
              confirmDelete === c.id ? (
                <div key={c.id} className="ckpt-confirm" data-agent-blocked>
                  <span className="ckpt-confirm-q">
                    Delete “{c.name}” ({formatSize(c.sizeBytes)})? This copy of
                    the room is erased for good — it does not go to the Trash.
                  </span>
                  <div className="ckpt-confirm-actions">
                    <button
                      className="primary"
                      onClick={() => {
                        setConfirmDelete(null);
                        deleteCheckpoint(c.id);
                      }}
                    >
                      Delete
                    </button>
                    <button className="subtle" onClick={() => setConfirmDelete(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : confirmRollback === c.id ? (
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
                      {formatWhen(asIso(c.createdAt))} · {formatSize(c.sizeBytes)}
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
                      onClick={() => setConfirmDelete(c.id)}
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
