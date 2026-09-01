import { useCallback, useEffect, useRef, useState } from "react";
import { confirm as askConfirm, message, setWindowTitle } from "./platform";
import { api, listRoles, hasRecoveryKey, openRoomWithRecovery, type RoomInfo, type RecentRoom, type WorkspaceOperationProgressEvent, type SealedPackageInspection } from "./api";
import { ROOM_FILTER, type RoomRole, type Screen, SEAL_LOCK_MS, SEAL_UNLOCK_MS } from "./rooms/constants";
import { prefersReducedMotion } from "./rooms/helpers";
import { forgetSavedLayout, forgetSavedLayouts } from "./shell/useLayout";
import { GateContent, GateShell, OpenWorkspace } from "./appGates";
import { chooseSealedDestination, createAndPrepareRoom, createValidationError, importSealedRoom, legacyDestinationName, selectedRole, selectedTemplate, showConversionNotice, suggestedRoomFolder, unlockMessage, usableCreatePath } from "./appOperations";
import "./App.css";
import "./seal.css";
import { removeWorkspaceOperation, updateWorkspaceOperations } from "./workspaceOperationProgress";

export { unlockMessage };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "start" });
  const [roomEpoch, setRoomEpoch] = useState(0);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [entering, setEntering] = useState(false);
  const [locking, setLocking] = useState(false);
  const [lockSlow, setLockSlow] = useState(false);
  const [recent, setRecent] = useState<RecentRoom[]>([]);
  const [roomName, setRoomName] = useState("");
  const [templateKey, setTemplateKey] = useState("blank");
  const [canTouchId, setCanTouchId] = useState(false);
  const [roles, setRoles] = useState<RoomRole[]>([]);
  const [roleId, setRoleId] = useState("default");
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [pendingInfo, setPendingInfo] = useState<RoomInfo | null>(null);
  const [hasRecovery, setHasRecovery] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState("");
  const [recoveryCopied, setRecoveryCopied] = useState(false);
  const [workspaceOperations, setWorkspaceOperations] = useState<
    WorkspaceOperationProgressEvent[]
  >([]);
  const [sealedInspection, setSealedInspection] = useState<SealedPackageInspection | null>(null);
  const workspaceOperationTimers = useRef(new Map<string, number>());
  const navEpochRef = useRef(0);
  const sealTimerRef = useRef<number | null>(null);
  const loadRecent = useCallback(() => {
    api
      .listRecent()
      .then(setRecent)
      .catch(() => setRecent([]));
  }, []);
  const goTo = useCallback((next: Screen) => {
    navEpochRef.current += 1;
    if (sealTimerRef.current !== null) {
      window.clearTimeout(sealTimerRef.current);
      sealTimerRef.current = null;
      setEntering(false);
    }
    setPassword("");
    setConfirm("");
    setError("");
    setRoomName("");
    setTemplateKey("blank");
    setCanTouchId(false);
    setRoleId("default");
    setRecoveryCode(null);
    setPendingInfo(null);
    setHasRecovery(false);
    setRecoveryMode(false);
    setRecoveryInput("");
    setSealedInspection(null);
    setScreen(next);
  }, []);
  useEffect(() => {
    const epoch = navEpochRef.current;
    api
      .roomInfo()
      .then((info) => {
        if (info && navEpochRef.current === epoch)
          goTo({ kind: "workspace", info });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const gateTo = async (path: string) => {
      await api.closeRoom().catch(() => {});
      goTo({ kind: "unlock", path });
    };
    api.takePendingOpen().then((path) => {
      if (path) gateTo(path);
    });
    const unlisten = api.onOpenRoomFile((path) => {
      gateTo(path);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [goTo]);
  useEffect(() => {
    const unlisten = api.onRoomRolledBack((info) => {
      setRoomEpoch((e) => e + 1);
      goTo({ kind: "workspace", info });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [goTo]);
  useEffect(() => {
    const unlisten = api.onWorkspaceOperationProgress((event) => {
      const priorTimer = workspaceOperationTimers.current.get(event.operationId);
      if (priorTimer !== undefined) window.clearTimeout(priorTimer);
      workspaceOperationTimers.current.delete(event.operationId);
      setWorkspaceOperations((current) => updateWorkspaceOperations(current, event));
      if (event.status === "completed" || event.status === "failed") {
        const timer = window.setTimeout(() => {
          setWorkspaceOperations((current) =>
            removeWorkspaceOperation(current, event.operationId),
          );
          workspaceOperationTimers.current.delete(event.operationId);
        }, 1800);
        workspaceOperationTimers.current.set(event.operationId, timer);
      }
    });
    return () => {
      unlisten.then((stop) => stop());
      for (const timer of workspaceOperationTimers.current.values()) {
        window.clearTimeout(timer);
      }
      workspaceOperationTimers.current.clear();
    };
  }, []);
  useEffect(() => {
    if (screen.kind === "start") loadRecent();
  }, [screen.kind, loadRecent]);
  useEffect(() => {
    if (screen.kind !== "unlock") return;
    let live = true;
    api
      .touchIdHas(screen.path)
      .then((yes) => {
        if (live) setCanTouchId(yes);
      })
      .catch(() => {
        if (live) setCanTouchId(false);
      });
    return () => {
      live = false;
    };
  }, [screen]);
  useEffect(() => {
    if (screen.kind !== "create") return;
    let live = true;
    listRoles()
      .then((r) => {
        if (live) setRoles(r);
      })
      .catch(() => {
        if (live) setRoles([]);
      });
    return () => {
      live = false;
    };
  }, [screen.kind]);
  useEffect(() => {
    if (screen.kind !== "unlock") return;
    let live = true;
    hasRecoveryKey(screen.path)
      .then((yes) => {
        if (live) setHasRecovery(yes);
      })
      .catch(() => {
        if (live) setHasRecovery(false);
      });
    return () => {
      live = false;
    };
  }, [screen]);
  async function removeRecent(path: string) {
    await api.removeRecent(path);
    forgetSavedLayout(path);
    loadRecent();
  }
  async function trashRoom(room: RecentRoom) {
    const ok = await askConfirm(
      `Move “${room.name}” to the macOS Trash? This moves the complete room — its normal files and encrypted private state. You can recover it from Trash until Trash is emptied.`,
      { title: "Move room to Trash", kind: "warning", okLabel: "Move to Trash" },
    ).catch(() => false);
    if (!ok) return;
    try {
      await api.trashRoom(room.path);
      forgetSavedLayout(room.path);
      await loadRecent();
    } catch (e) {
      await message(`The room couldn't be moved to Trash.\n\n${String(e)}`, {
        title: "Move room to Trash",
        kind: "error",
      }).catch(() => {});
    }
  }
  async function clearRecent() {
    const ok = await askConfirm(
      `Forget all ${recent.length} recent room${recent.length === 1 ? "" : "s"}? ` +
        "This clears the shortcuts on this screen and the pane layouts saved for " +
        "them — every room folder or legacy room file stays exactly where it is, and you can open one " +
        "again with “Open Room…”.",
      { title: "Clear the recent list", kind: "warning", okLabel: "Clear list" },
    ).catch(() => false);
    if (!ok) return;
    try {
      await api.clearRecent();
      forgetSavedLayouts();
    } catch (e) {
      await message(`The recent list couldn't be cleared.\n\n${String(e)}`, {
        title: "Clear the recent list",
        kind: "error",
      }).catch(() => {});
    }
    loadRecent();
  }
  function chooseCreate() {
    goTo({ kind: "create", path: "" });
  }
  async function chooseOpen() {
    const path = await api.chooseOpenPath({
      title: "Open an Arcelle Room",
      message: "Select the Arcelle workspace folder, then click Open Room. Double-clicking browses into the folder.",
      buttonLabel: "Open Room",
      multiple: false,
      room: true,
      filters: ROOM_FILTER,
    });
    if (typeof path === "string") goTo({ kind: "unlock", path });
  }
  function chooseDemo() {
    goTo({ kind: "create", path: "" });
    setTemplateKey("demo");
    setRoomName("Demo Room");
  }
  function enterRoom(info: RoomInfo) {
    if (prefersReducedMotion()) {
      goTo({ kind: "workspace", info });
      return;
    }
    const epoch = navEpochRef.current;
    setEntering(true);
    sealTimerRef.current = window.setTimeout(() => {
      sealTimerRef.current = null;
      setEntering(false);
      if (navEpochRef.current !== epoch) return;
      goTo({ kind: "workspace", info });
    }, SEAL_UNLOCK_MS);
  }
  function dismissRecovery() {
    const info = pendingInfo;
    setRecoveryCode(null);
    setPendingInfo(null);
    if (info) enterRoom(info);
  }
  async function handleCreate() {
    const validationError = createValidationError(password, confirm);
    if (validationError) {
      setError(validationError);
      return;
    }
    const epoch = navEpochRef.current;
    const path = await api.chooseSavePath({
      title: "Choose where to create this workspace folder",
      defaultPath: suggestedRoomFolder(roomName),
    });
    if (!usableCreatePath(path, () => navEpochRef.current === epoch)) return;
    setBusy(true);
    try {
      await createAndPrepareRoom({
        path,
        password,
        roomName,
        template: selectedTemplate(templateKey),
        role: selectedRole(roles, roleId),
        isCurrent: () => navEpochRef.current === epoch,
        setError,
        recovery: {
          setPendingInfo,
          setRecoveryCopied,
          setRecoveryCode,
          enterRoom,
        },
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function handleUnlock(path: string) {
    if (!password) {
      setError("Enter your password to unlock this room.");
      return;
    }
    setBusy(true);
    const epoch = navEpochRef.current;
    try {
      const info = await api.openRoom(path, password);
      if (navEpochRef.current !== epoch) return;
      enterRoom(info);
    } catch (e) {
      const msg = String(e);
      console.error("unlock failed:", msg);
      setError(unlockMessage(msg));
    } finally {
      setBusy(false);
    }
  }
  async function handleConvertLegacy(sourcePath: string) {
    if (!password) {
      setError("Enter the room password before converting it.");
      return;
    }
    const destinationPath = await api.chooseSavePath({
      title: "Choose the new normal-files workspace folder",
      defaultPath: legacyDestinationName(sourcePath, "Workspace", "Converted Room"),
    });
    if (!destinationPath) return;
    setBusy(true);
    setError("");
    const epoch = navEpochRef.current;
    try {
      const report = await api.convertLegacyRoom(sourcePath, password, destinationPath);
      if (navEpochRef.current !== epoch) return;
      await showConversionNotice(report);
      const info = await api.openRoom(destinationPath, password);
      if (navEpochRef.current !== epoch) return;
      enterRoom(info);
    } catch (e) {
      console.error("legacy conversion failed:", e);
      setError(unlockMessage(String(e)));
    } finally {
      setBusy(false);
    }
  }
  async function handleInspectSealed(packagePath: string) {
    if (!password) {
      setError("Enter the sealed backup password before inspecting it.");
      return;
    }
    setBusy(true);
    setError("");
    const epoch = navEpochRef.current;
    try {
      const packageInfo = await api.inspectSealedPackage(packagePath, password);
      if (navEpochRef.current !== epoch) return;
      setSealedInspection(packageInfo);
    } catch (e) {
      console.error("sealed inspection failed:", e);
      setError(unlockMessage(String(e)));
    } finally {
      setBusy(false);
    }
  }
  async function handleExtractSealed(packagePath: string, fileIds: string[]) {
    const destinationPath = await chooseSealedDestination({
      title: "Choose a new folder for the extracted files",
      defaultPath: legacyDestinationName(packagePath, "Extracted Files", "Backup"),
    }, setError);
    if (!destinationPath) return;
    setBusy(true);
    setError("");
    const epoch = navEpochRef.current;
    try {
      const result = await api.extractSealedFiles(packagePath, password, fileIds, destinationPath);
      if (navEpochRef.current !== epoch) return;
      await message(
        `Extracted ${result.fileCount} file${result.fileCount === 1 ? "" : "s"} into a new normal folder.`,
        { title: "Files extracted", kind: "info" },
      ).catch(() => {});
    } catch (e) {
      console.error("sealed extraction failed:", e);
      setError(unlockMessage(String(e)));
    } finally {
      setBusy(false);
    }
  }
  async function handleImportSealed(packagePath: string) {
    const destinationPath = await chooseSealedDestination({
      title: "Choose the new workspace folder",
      defaultPath: legacyDestinationName(packagePath, "Workspace", "Imported Room"),
    }, setError);
    if (!destinationPath) return;
    setBusy(true);
    setError("");
    const epoch = navEpochRef.current;
    try {
      await importSealedRoom({
        packagePath,
        password,
        destinationPath,
        fileCount: sealedInspection?.fileCount ?? 0,
        isCurrent: () => navEpochRef.current === epoch,
        enterRoom,
      });
    } catch (e) {
      console.error("sealed import failed:", e);
      setError(unlockMessage(String(e)));
    } finally {
      setBusy(false);
    }
  }
  async function handleRecoveryUnlock(path: string) {
    const code = recoveryInput.trim();
    if (!code) return;
    setError("");
    setBusy(true);
    const epoch = navEpochRef.current;
    try {
      const info = await openRoomWithRecovery(path, code);
      if (navEpochRef.current !== epoch) return; // stale: the gate moved on
      enterRoom(info);
    } catch (e) {
      const msg = String(e);
      console.error("recovery unlock failed:", msg);
      setError(
        /recovery code/i.test(msg)
          ? "That recovery code didn't work. Check it and try again."
          : unlockMessage(msg),
      );
    } finally {
      setBusy(false);
    }
  }
  async function handleTouchId(path: string) {
    setError("");
    setBusy(true);
    const epoch = navEpochRef.current;
    try {
      const info = await api.touchIdOpen(path);
      if (navEpochRef.current !== epoch) return; // stale: the gate moved on
      enterRoom(info);
    } catch (e) {
      console.error("touch id unlock failed:", String(e));
      setError(unlockMessage(String(e)));
    } finally {
      setBusy(false);
    }
  }
  async function handleLock() {
    const epoch = navEpochRef.current;
    if (prefersReducedMotion()) {
      await api.closeRoom();
      setWindowTitle("Arcelle").catch(() => {});
      if (navEpochRef.current === epoch) goTo({ kind: "start" });
      return;
    }
    setLocking(true);
    setLockSlow(false);
    const slowTimer = window.setTimeout(() => setLockSlow(true), SEAL_LOCK_MS);
    try {
      await api.closeRoom();
    } catch (e) {
      window.clearTimeout(slowTimer);
      setLockSlow(false);
      setLocking(false);
      throw e;
    }
    window.clearTimeout(slowTimer);
    setWindowTitle("Arcelle").catch(() => {});
    window.setTimeout(() => {
      setLocking(false);
      setLockSlow(false);
      if (navEpochRef.current === epoch) goTo({ kind: "start" });
    }, SEAL_LOCK_MS);
  }
  if (screen.kind === "workspace") {
    return (
      <OpenWorkspace
        info={screen.info}
        roomEpoch={roomEpoch}
        operations={workspaceOperations}
        locking={locking}
        lockSlow={lockSlow}
        onLock={handleLock}
        onRename={(info) => setScreen({ kind: "workspace", info })}
      />
    );
  }
  const unlockPath = screen.kind === "unlock" ? screen.path : "";
  return (
    <GateShell
      entering={entering}
      operations={workspaceOperations}
      recoveryCode={recoveryCode}
      recoveryCopied={recoveryCopied}
      setRecoveryCopied={setRecoveryCopied}
      onDismissRecovery={dismissRecovery}
    >
      <GateContent
        screen={screen}
        start={{
          recent,
          onCreate: chooseCreate,
          onOpen: chooseOpen,
          onDemo: chooseDemo,
          onOpenRecent: (path) => {
            if (recent.find((room) => room.path === path)?.missing) void chooseOpen();
            else goTo({ kind: "unlock", path });
          },
          onRemoveRecent: removeRecent,
          onTrashRoom: (room) => void trashRoom(room),
          onClearRecent: clearRecent,
        }}
        create={{
          roomName,
          setRoomName,
          templateKey,
          setTemplateKey,
          roles,
          roleId,
          setRoleId,
          password,
          setPassword,
          confirm,
          setConfirm,
          error,
          setError,
          busy,
          onSubmit: handleCreate,
          onBack: () => goTo({ kind: "start" }),
        }}
        unlock={{
          path: "",
          sealedInspection,
          busy,
          error,
          setError,
          recoveryMode,
          canTouchId,
          hasRecovery,
          password,
          setPassword,
          recoveryInput,
          setRecoveryInput,
          onUnlock: () => handleUnlock(unlockPath),
          onRecoveryUnlock: () => handleRecoveryUnlock(unlockPath),
          onTouchId: () => handleTouchId(unlockPath),
          onConvertLegacy: () => handleConvertLegacy(unlockPath),
          onInspectSealed: () => handleInspectSealed(unlockPath),
          onExtract: (fileIds) => void handleExtractSealed(unlockPath, fileIds),
          onImport: () => void handleImportSealed(unlockPath),
          onEnterRecoveryMode: () => {
            setRecoveryMode(true);
            setPassword("");
            setError("");
          },
          onExitRecoveryMode: () => {
            setRecoveryMode(false);
            setRecoveryInput("");
            setError("");
          },
          onBack: () => goTo({ kind: "start" }),
          onDismissInspection: () => {
            setSealedInspection(null);
            setError("");
          },
        }}
      />
    </GateShell>
  );
}
