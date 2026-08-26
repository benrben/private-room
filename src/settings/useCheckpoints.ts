import { useCallback, useEffect, useState } from "react";
import {
  api,
  CheckpointMeta,
  type RoomStorageUsage,
  type WorkspaceWatcherStatus,
} from "../api";

/** Idea 9: whole-room checkpoints — create named copies of the room, delete
 * them, and roll the room back to one. Mirrors the `usePrivacy` shape (the
 * other whole-room safety ops live beside it in Settings). Rollback success is
 * handled by App's `onRoomRolledBack` listener (it remounts the workspace and
 * closes Settings), so this hook only surfaces errors. */
export function useCheckpoints() {
  const [checkpoints, setCheckpoints] = useState<CheckpointMeta[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [storageUsage, setStorageUsage] = useState<RoomStorageUsage | null>(null);
  const [watcherStatus, setWatcherStatus] = useState<WorkspaceWatcherStatus | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [changingPolling, setChangingPolling] = useState(false);
  const [ckName, setCkName] = useState("");
  const [creating, setCreating] = useState(false);
  const [ckError, setCkError] = useState("");
  const [ckNotice, setCkNotice] = useState("");
  // Armed rollback confirm (its checkpoint id) — the destructive step is
  // two-step and data-agent-blocked, like the Time Machine restore.
  const [confirmRollback, setConfirmRollback] = useState<string | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [list, usage, watcher] = await Promise.all([
        api.listRoomCheckpoints(),
        api.roomStorageUsage(),
        api.workspaceWatcherStatus(),
      ]);
      setCheckpoints(list.entries);
      setTotalBytes(list.totalBytes);
      setStorageUsage(usage);
      setWatcherStatus(watcher);
    } catch {
      /* room may be locked/closed — leave the last list */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createCheckpoint() {
    setCkError("");
    setCkNotice("");
    setCreating(true);
    try {
      const meta = await api.createRoomCheckpoint(ckName.trim());
      setCkName("");
      setCkNotice(`Saved checkpoint “${meta.name}”.`);
      window.setTimeout(() => setCkNotice(""), 3000);
      await refresh();
    } catch (e) {
      setCkError(String(e));
    } finally {
      setCreating(false);
    }
  }

  async function deleteCheckpoint(id: string) {
    setCkError("");
    try {
      await api.deleteRoomCheckpoint(id);
      await refresh();
    } catch (e) {
      setCkError(String(e));
    }
  }

  async function rollback(id: string) {
    setCkError("");
    setConfirmRollback(null);
    setRollingBack(true);
    try {
      // On success the room-rolled-back event remounts the workspace and closes
      // Settings, so this component unmounts — nothing to reset here.
      await api.rollbackRoomCheckpoint(id);
    } catch (e) {
      setCkError(String(e));
      setRollingBack(false);
    }
  }

  async function rescanRoom() {
    setCkError("");
    setRescanning(true);
    try {
      setWatcherStatus(await api.rescanWorkspaceRoom());
      setStorageUsage(await api.roomStorageUsage());
      setCkNotice("Room files were rescanned.");
      window.setTimeout(() => setCkNotice(""), 3000);
    } catch (e) {
      setCkError(String(e));
      try { setWatcherStatus(await api.workspaceWatcherStatus()); } catch { /* room closed */ }
    } finally {
      setRescanning(false);
    }
  }

  async function setWatcherPolling(enabled: boolean) {
    setCkError("");
    setChangingPolling(true);
    try {
      setWatcherStatus(await api.setWorkspaceWatcherPolling(enabled));
      setCkNotice(enabled ? "Polling mode is on." : "Polling mode is off.");
      window.setTimeout(() => setCkNotice(""), 3000);
    } catch (e) {
      setCkError(String(e));
    } finally {
      setChangingPolling(false);
    }
  }

  return {
    checkpoints,
    totalBytes,
    storageUsage,
    watcherStatus,
    rescanning,
    changingPolling,
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
    rescanRoom,
    setWatcherPolling,
    refresh,
  };
}
