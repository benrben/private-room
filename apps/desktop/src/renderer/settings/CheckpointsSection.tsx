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
  changingPolling: boolean;
  setWatcherPolling: (enabled: boolean) => void;
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

type CheckpointActions = Pick<
  Props,
  "busy" | "deleteCheckpoint" | "rollback" | "rollingBack" | "setConfirmRollback"
>;

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
export default function CheckpointsSection(props: Props) {
  // A checkpoint is a full copy of the room and Delete does NOT go to the
  // Trash — it is often the only way back after a mistake, and it used to fire
  // on one click while "Roll back", which is reversible, asked first. Same
  // inline question as the rollback arm, so the two destructive acts in this
  // list behave the same way round.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  return (
    <section id="set-checkpoints">
      <h3>Room storage</h3>
      <StorageUsagePanel
        changingPolling={props.changingPolling}
        rescanning={props.rescanning}
        rescanRoom={props.rescanRoom}
        setWatcherPolling={props.setWatcherPolling}
        storageUsage={props.storageUsage}
        watcherStatus={props.watcherStatus}
      />
      <CheckpointIntroduction />
      <CheckpointCreator
        ckName={props.ckName}
        createCheckpoint={props.createCheckpoint}
        creating={props.creating}
        rollingBack={props.rollingBack}
        setCkName={props.setCkName}
      />
      <CheckpointMessages error={props.ckError} notice={props.ckNotice} />
      <CheckpointList
        {...checkpointActions(props)}
        checkpoints={props.checkpoints}
        confirmDelete={confirmDelete}
        confirmRollback={props.confirmRollback}
        setConfirmDelete={setConfirmDelete}
        totalBytes={props.totalBytes}
      />
      <RollingBackStatus rollingBack={props.rollingBack} />
    </section>
  );
}

function checkpointActions(props: Props): CheckpointActions {
  return {
    busy: props.busy,
    deleteCheckpoint: props.deleteCheckpoint,
    rollback: props.rollback,
    rollingBack: props.rollingBack,
    setConfirmRollback: props.setConfirmRollback,
  };
}

function StorageUsagePanel({
  changingPolling,
  rescanning,
  rescanRoom,
  setWatcherPolling,
  storageUsage,
  watcherStatus,
}: Pick<Props, "changingPolling" | "rescanning" | "rescanRoom" | "setWatcherPolling" | "storageUsage" | "watcherStatus">) {
  if (!storageUsage) return null;
  return (
    <div className="ckpt-list">
      <StorageUsageTotals storageUsage={storageUsage} />
      <StorageUsageDescription storageUsage={storageUsage} />
      <WatcherControls
        changingPolling={changingPolling}
        rescanning={rescanning}
        rescanRoom={rescanRoom}
        setWatcherPolling={setWatcherPolling}
        watcherStatus={watcherStatus}
      />
    </div>
  );
}

function StorageUsageTotals({ storageUsage }: { storageUsage: RoomStorageUsage }) {
  return (
    <>
      <div className="ckpt-total">Current files · {formatSize(storageUsage.liveFileBytes)}</div>
      <div className="ckpt-total">Encrypted Arcelle database · {formatSize(storageUsage.databaseBytes)}</div>
      <div className="ckpt-total">Private encrypted history · {formatSize(storageUsage.privateHistoryBytes)}</div>
    </>
  );
}

function StorageUsageDescription({ storageUsage }: { storageUsage: RoomStorageUsage }) {
  const description = storageUsage.kind === "workspace"
    ? `Total managed disk use is ${formatSize(storageUsage.totalOnDiskBytes)}. Current files are normal files; chats, indexes, metadata and history stay private.`
    : `This legacy room uses ${formatSize(storageUsage.totalOnDiskBytes)} in one encrypted database file. Current files and history are included inside it.`;
  return <p className="settings-hint">{description}</p>;
}

function WatcherControls({
  changingPolling,
  rescanning,
  rescanRoom,
  setWatcherPolling,
  watcherStatus,
}: Pick<Props, "changingPolling" | "rescanning" | "rescanRoom" | "setWatcherPolling" | "watcherStatus">) {
  if (!watcherStatus) return null;
  const statusClass = watcherStatus.state === "error" ? "gate-error" : "settings-hint";
  const lastError = watcherStatus.lastError ? ` — ${watcherStatus.lastError}` : "";
  return (
    <>
      <div className="settings-form">
        <span className={statusClass}>
          File watcher: {watcherStatus.state}
          {lastError}
        </span>
        <button className="subtle" disabled={rescanning} onClick={rescanRoom}>
          {rescanning ? "Rescanning…" : "Rescan room"}
        </button>
      </div>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={watcherStatus.polling}
          disabled={changingPolling}
          onChange={(event) => setWatcherPolling(event.target.checked)}
        />
        <span>
          Use polling for synced or network folders
          <small>Uses more disk checks, but is safer when native file notifications are unreliable.</small>
        </span>
      </label>
    </>
  );
}

function CheckpointIntroduction() {
  return (
    <>
      <h3>Checkpoints</h3>
      <p className="settings-hint">
        A checkpoint is a full, encrypted copy of this whole room — like a git
        commit you can roll back to. Creating one is safe and non-destructive;
        rolling back replaces the room's current state (a “Before rollback” copy
        is taken first).
      </p>
      <label className="settings-label">Create a checkpoint</label>
    </>
  );
}

function CheckpointCreator({
  ckName,
  createCheckpoint,
  creating,
  rollingBack,
  setCkName,
}: Pick<Props, "ckName" | "createCheckpoint" | "creating" | "rollingBack" | "setCkName">) {
  const disabled = creating || rollingBack;
  return (
    <div className="settings-form ckpt-create">
      <input
        type="text"
        placeholder="Name (optional) — e.g. before cleanup"
        value={ckName}
        disabled={disabled}
        onChange={(event) => setCkName(event.target.value)}
        onKeyDown={(event) => createCheckpointOnEnter(event.key, creating, createCheckpoint)}
      />
      <button className="primary" disabled={disabled} onClick={createCheckpoint}>
        {creating ? "Saving…" : "Create checkpoint"}
      </button>
    </div>
  );
}

function createCheckpointOnEnter(key: string, creating: boolean, createCheckpoint: () => void) {
  if (key === "Enter" && !creating) createCheckpoint();
}

function CheckpointMessages({ error, notice }: { error: string; notice: string }) {
  return (
    <>
      {notice && <div className="ckpt-notice">{notice}</div>}
      {error && <div className="gate-error">{error}</div>}
    </>
  );
}

function CheckpointList({
  checkpoints,
  confirmDelete,
  confirmRollback,
  setConfirmDelete,
  totalBytes,
  ...actions
}: CheckpointActions & {
  checkpoints: CheckpointMeta[];
  confirmDelete: string | null;
  confirmRollback: string | null;
  setConfirmDelete: (id: string | null) => void;
  totalBytes: number;
}) {
  if (checkpoints.length === 0) return null;
  return (
    <>
      <CheckpointStorageTotal count={checkpoints.length} totalBytes={totalBytes} />
      <CheckpointSizeWarning totalBytes={totalBytes} />
      <div className="ckpt-list">
        {checkpoints.map((checkpoint) => (
          <CheckpointRow
            {...actions}
            checkpoint={checkpoint}
            confirmDelete={confirmDelete}
            confirmRollback={confirmRollback}
            key={checkpoint.id}
            setConfirmDelete={setConfirmDelete}
          />
        ))}
      </div>
    </>
  );
}

function CheckpointStorageTotal({ count, totalBytes }: { count: number; totalBytes: number }) {
  return (
    <div className="ckpt-total">
      {count} checkpoint{count === 1 ? "" : "s"} · {formatSize(totalBytes)} on disk
    </div>
  );
}

function CheckpointSizeWarning({ totalBytes }: { totalBytes: number }) {
  if (totalBytes <= ONE_GB) return null;
  return (
    <p className="ckpt-warn set-note set-note--flag nb-sem-pending">
      Each checkpoint is a full copy of this room, including recordings —
      these are using a lot of disk. Delete old ones you don't need.
    </p>
  );
}

function CheckpointRow({
  checkpoint,
  confirmDelete,
  confirmRollback,
  setConfirmDelete,
  ...actions
}: CheckpointActions & {
  checkpoint: CheckpointMeta;
  confirmDelete: string | null;
  confirmRollback: string | null;
  setConfirmDelete: (id: string | null) => void;
}) {
  if (confirmDelete === checkpoint.id) {
    return <DeleteCheckpointConfirm checkpoint={checkpoint} onDelete={actions.deleteCheckpoint} setConfirmDelete={setConfirmDelete} />;
  }
  if (confirmRollback === checkpoint.id) {
    return <RollbackCheckpointConfirm checkpoint={checkpoint} rollback={actions.rollback} setConfirmRollback={actions.setConfirmRollback} />;
  }
  return <CheckpointDetails {...actions} checkpoint={checkpoint} setConfirmDelete={setConfirmDelete} />;
}

function DeleteCheckpointConfirm({
  checkpoint,
  onDelete,
  setConfirmDelete,
}: {
  checkpoint: CheckpointMeta;
  onDelete: (id: string) => void;
  setConfirmDelete: (id: string | null) => void;
}) {
  return (
    <div className="ckpt-confirm" data-agent-blocked>
      <span className="ckpt-confirm-q">
        Delete “{checkpoint.name}” ({formatSize(checkpoint.sizeBytes)})? This copy of
        the room is erased for good — it does not go to the Trash.
      </span>
      <div className="ckpt-confirm-actions">
        <button className="primary" onClick={() => deleteCheckpointAfterClear(checkpoint.id, onDelete, setConfirmDelete)}>
          Delete
        </button>
        <button className="subtle" onClick={() => setConfirmDelete(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function deleteCheckpointAfterClear(
  id: string,
  onDelete: (id: string) => void,
  setConfirmDelete: (id: string | null) => void,
) {
  setConfirmDelete(null);
  onDelete(id);
}

function RollbackCheckpointConfirm({
  checkpoint,
  rollback,
  setConfirmRollback,
}: {
  checkpoint: CheckpointMeta;
  rollback: (id: string) => void;
  setConfirmRollback: (id: string | null) => void;
}) {
  return (
    <div className="ckpt-confirm" data-agent-blocked>
      <span className="ckpt-confirm-q">
        Roll the whole room back to “{checkpoint.name}”? Everything since is
        replaced (a “Before rollback” copy is saved first).
      </span>
      <div className="ckpt-confirm-actions">
        <button className="primary" onClick={() => rollback(checkpoint.id)}>
          Roll back
        </button>
        <button className="subtle" onClick={() => setConfirmRollback(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function CheckpointDetails({
  checkpoint,
  busy,
  rollingBack,
  setConfirmDelete,
  setConfirmRollback,
}: CheckpointActions & {
  checkpoint: CheckpointMeta;
  setConfirmDelete: (id: string | null) => void;
}) {
  return (
    <div className="ckpt-row">
      <CheckpointDot auto={checkpoint.auto} />
      <CheckpointMetadata checkpoint={checkpoint} />
      <CheckpointRowActions
        busy={busy}
        checkpoint={checkpoint}
        rollingBack={rollingBack}
        setConfirmDelete={setConfirmDelete}
        setConfirmRollback={setConfirmRollback}
      />
    </div>
  );
}

function CheckpointDot({ auto }: { auto: boolean }) {
  return <span className={`ckpt-dot${auto ? " auto" : ""}`} title={auto ? "Automatic pre-rollback copy" : "Checkpoint"} />;
}

function CheckpointMetadata({ checkpoint }: { checkpoint: CheckpointMeta }) {
  return (
    <span className="ckpt-meta">
      <span className="ckpt-name" dir="auto">{checkpoint.name}</span>
      <span className="ckpt-sub">{formatWhen(asIso(checkpoint.createdAt))} · {formatSize(checkpoint.sizeBytes)}</span>
    </span>
  );
}

function CheckpointRowActions({
  busy,
  checkpoint,
  rollingBack,
  setConfirmDelete,
  setConfirmRollback,
}: Omit<CheckpointActions, "deleteCheckpoint" | "rollback"> & {
  checkpoint: CheckpointMeta;
  setConfirmDelete: (id: string | null) => void;
}) {
  const rollbackTitle = busy
    ? "Finish or stop running work first"
    : "Replace the room with this checkpoint";
  return (
    <span className="ckpt-actions">
      <button
        className="subtle ckpt-action"
        title={rollbackTitle}
        disabled={busy || rollingBack}
        onClick={() => setConfirmRollback(checkpoint.id)}
      >
        Roll back
      </button>
      <button
        className="subtle ckpt-action"
        title="Delete this checkpoint and free its disk space"
        disabled={rollingBack}
        onClick={() => setConfirmDelete(checkpoint.id)}
      >
        Delete
      </button>
    </span>
  );
}

function RollingBackStatus({ rollingBack }: { rollingBack: boolean }) {
  if (!rollingBack) return null;
  return <div className="settings-hint">Rolling back — reopening the room…</div>;
}
