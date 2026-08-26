import { useCallback, useEffect, useRef, useState } from "react";
// Aliased: this component already owns a `confirm` (the create screen's
// second password field), and the local name would shadow the import.
import { confirm as askConfirm, message, setWindowTitle } from "./platform";
import {
  api,
  RoomInfo,
  RecentRoom,
  listRoles,
  writeRecoveryKey,
  hasRecoveryKey,
  openRoomWithRecovery,
  type WorkspaceOperationProgressEvent,
} from "./api";
import Workspace from "./Workspace";
import { Logomark } from "./icons";
import {
  MIN_PASSWORD,
  ROOM_FILTER,
  ROOM_TEMPLATES,
  RoomRole,
  Screen,
  SEAL_LOCK_MS,
  SEAL_UNLOCK_MS,
} from "./rooms/constants";
import { prefersReducedMotion } from "./rooms/helpers";
import { forgetSavedLayout, forgetSavedLayouts } from "./shell/useLayout";
import { StartScreen } from "./screens/StartScreen";
import { CreateScreen } from "./screens/CreateScreen";
import { UnlockScreen } from "./screens/UnlockScreen";
import { RecoveryModal } from "./screens/RecoveryModal";
import { WorkspaceOperationProgress } from "./screens/WorkspaceOperationProgress";
import {
  SealLockingOverlay,
  SealUnlockingOverlay,
} from "./screens/SealOverlay";
import "./App.css";
import "./seal.css";
import {
  removeWorkspaceOperation,
  updateWorkspaceOperations,
} from "./workspaceOperationProgress";

/** What the unlock gate says when an open fails.
 *
 * Every unlock path funnels through here — typed password, Touch ID, and the
 * recovery code — because they used to disagree: the typed path turned
 * `WRONG_PASSWORD` into a sentence while Touch ID printed that bare internal
 * code straight onto the lock screen, and anything the host had not classified
 * (a damaged room, a read-only disk, a file another copy of the app holds
 * open) arrived as raw SQLite text.
 *
 * The pass-through rule is deliberate: the host's own messages are written as
 * sentences ("File not found.", "This file is not an Arcelle project.", the
 * classified first-read failures), and engine text is not — it is lower-case
 * and unpunctuated. So a message that reads like one of ours is shown as-is,
 * and anything else becomes a calm fallback with the detail left in the
 * console. A new host sentence therefore needs no change here; a new engine
 * error cannot leak. */
export function unlockMessage(raw: string): string {
  const msg = raw.replace(/^Error:\s*/, "").trim();
  if (msg.includes("WRONG_PASSWORD")) return "That password didn't work. Try again.";
  if (/readonly|read-only/i.test(msg))
    return "This room is on a read-only disk, so it can't be opened. Copy it somewhere you can write to and try again.";
  if (/malformed|not a database|corrupt/i.test(msg))
    return "This room file looks damaged. Try a checkpoint or a backup copy of it.";
  if (/database is locked|unable to open database/i.test(msg))
    return "This room couldn't be opened. Check that it's on a connected drive and not already open in another copy of Arcelle.";
  if (/PRAGMA|sqlcipher|rekey|ATTACH/i.test(msg))
    return "This room couldn't be unlocked. Check the password and try again.";
  // One of the app's own sentences, or something we don't recognise at all.
  const looksLikeOurs = /^[A-Z"“]/.test(msg) && /[.!?]$/.test(msg);
  return looksLikeOurs && msg.length < 300
    ? msg
    : "This room couldn't be opened. Check that the file is on a connected drive and not damaged.";
}

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "start" });
  // Idea 9: bumped on a checkpoint rollback so the Workspace remounts against
  // the swapped DB — every pane (files, chats, open file, jobs, front page) is
  // rebuilt, and the Settings modal closes, which is correct after a rollback.
  const [roomEpoch, setRoomEpoch] = useState(0);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [entering, setEntering] = useState(false);
  // Mirrors `entering`: true while the "sealing shut" lock ritual plays over
  // the workspace, before the gate returns.
  const [locking, setLocking] = useState(false);
  // True once the seal animation has finished and the close is STILL running.
  const [lockSlow, setLockSlow] = useState(false);
  const [recent, setRecent] = useState<RecentRoom[]>([]);
  const [roomName, setRoomName] = useState("");
  const [templateKey, setTemplateKey] = useState("blank");
  // ADD-11: whether the room on the unlock screen has a Touch ID entry.
  const [canTouchId, setCanTouchId] = useState(false);
  // Roles (create flow): the catalog and the chosen role. Default = "default".
  const [roles, setRoles] = useState<RoomRole[]>([]);
  const [roleId, setRoleId] = useState("default");
  // Recovery reveal (create): the one-time code to show once, and the room to
  // enter once the user dismisses the sheet.
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [pendingInfo, setPendingInfo] = useState<RoomInfo | null>(null);
  // Recovery unlock (gate): whether the selected room has a recovery sidecar,
  // and the "use a code instead" input state.
  const [hasRecovery, setHasRecovery] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState("");
  const [recoveryCopied, setRecoveryCopied] = useState(false);
  const [workspaceOperations, setWorkspaceOperations] = useState<
    WorkspaceOperationProgressEvent[]
  >([]);
  const workspaceOperationTimers = useRef(new Map<string, number>());

  // Navigation epoch: bumped on every goTo. In-flight unlock/create
  // continuations (an awaited openRoom, a pending seal timer) capture it and
  // abort if it moved — so a gate shown for room B can never be replaced by a
  // stale "enter room A" continuation mounting a workspace over a closed room.
  const navEpochRef = useRef(0);
  // The pending seal-unlock timer, so goTo can cancel a ritual in flight.
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
    setScreen(next);
  }, []);

  // Session restore: if the WebKit content process was reloaded (frontend
  // state lost), the Rust side still holds the unlocked room — landing on the
  // start screen would read as a scary crash-to-locked. Ask the backend and
  // jump straight back into the workspace instead. A real quit/lock clears
  // the backend room, so this never bypasses the password.
  useEffect(() => {
    const epoch = navEpochRef.current;
    api
      .roomInfo()
      .then((info) => {
        // A gate navigation (e.g. a launch-time .roomai open) beat us — the
        // room this restore saw may already be closed behind that gate.
        if (info && navEpochRef.current === epoch)
          goTo({ kind: "workspace", info });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A .roomai file double-clicked in Finder lands here, either at launch
  // (pending open) or while the app is already running (event).
  useEffect(() => {
    // Showing another room's gate must never leave the current room unlocked
    // behind it — close it first (a safe no-op when none is open).
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

  // Idea 9: a checkpoint rollback reopened the room against the swapped DB.
  // Remount the workspace (new key) and land on it — safer than piecemeal
  // refresh, and it closes any open modal (Settings).
  useEffect(() => {
    const unlisten = api.onRoomRolledBack((info) => {
      setRoomEpoch((e) => e + 1);
      goTo({ kind: "workspace", info });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [goTo]);

  // Storage work can begin on the unlock gate (conversion/import) or inside
  // a room (backup/checkpoint/agent baseline), so the listener belongs above
  // both screens. Terminal rows remain briefly so completion is perceptible;
  // the existing success/error toast or gate message remains the durable result.
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

  // Refresh the recent-rooms list every time we land on the start screen,
  // so it reflects rooms opened since the app launched.
  useEffect(() => {
    if (screen.kind === "start") loadRecent();
  }, [screen.kind, loadRecent]);

  // ADD-11: when the unlock screen appears, ask (without prompting) whether a
  // Touch ID entry exists for this room, so we can offer the button.
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

  // Load the role catalog when the create screen opens, so the picker can
  // offer them. Failure just leaves the default role and hides the picker.
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

  // When the unlock screen appears, ask (without prompting) whether this room
  // has a recovery sidecar, so we can offer the "use a code" affordance.
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
    // The room's saved pane layout is the other thing this Mac remembers about
    // it, outside the room's encrypted private state. Forgetting the shortcut
    // forgets that too.
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

  // One click used to wipe every shortcut with no confirmation, no undo and
  // nothing said if it failed — and a room in a folder you don't remember then
  // has to be hunted down by hand.
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
      // Nothing used to clear the per-room saved layouts, so "forget all recent
      // rooms" left a list of them behind on this Mac.
      forgetSavedLayouts();
    } catch (e) {
      await message(`The recent list couldn't be cleared.\n\n${String(e)}`, {
        title: "Clear the recent list",
        kind: "error",
      }).catch(() => {});
    }
    loadRecent();
  }

  // Start the branded create flow immediately — the user names the room and
  // sets a password in-app; the native file panel is deferred to the final
  // "Create & Enter", and only to choose where the workspace folder lands.
  function chooseCreate() {
    goTo({ kind: "create", path: "" });
  }

  async function chooseOpen() {
    const path = await api.chooseOpenPath({
      title: "Open an Arcelle Room",
      multiple: false,
      room: true,
      filters: ROOM_FILTER,
    });
    if (typeof path === "string") goTo({ kind: "unlock", path });
  }

  // "Create a demo room": jump straight into the create flow with the bundled
  // demo template pre-selected, so the user only sets a password. goTo resets
  // the picker to blank; the setters below run in the same batch and win.
  function chooseDemo() {
    goTo({ kind: "create", path: "" });
    setTemplateKey("demo");
    setRoomName("Demo Room");
  }

  // Successful unlock plays the seal ritual (the keyhole blooms open, ~520ms)
  // on the gate before the workspace appears. Reduced motion skips straight in
  // with no bloom, so the end-state change is instant.
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
      // A navigation during the ritual (goTo clears this timer, but belt and
      // braces) invalidates the entry — the room may no longer be open.
      if (navEpochRef.current !== epoch) return;
      goTo({ kind: "workspace", info });
    }, SEAL_UNLOCK_MS);
  }

  // The recovery sheet after create: dismissing it (saved or skipped) enters
  // the room with the just-set password, playing the seal on the way in.
  function dismissRecovery() {
    const info = pendingInfo;
    setRecoveryCode(null);
    setPendingInfo(null);
    if (info) enterRoom(info);
  }

  async function handleCreate() {
    if (password.length < MIN_PASSWORD) {
      setError(`Please use at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    // If the gate navigates while a step below is in flight (a .roomai
    // double-clicked in Finder closes the room and shows the other room's
    // gate), this create flow is stale — it must not create/enter a room
    // behind the new gate.
    const epoch = navEpochRef.current;
    // Defer to the native panel only now, to pick the new workspace folder.
    const suggested = (roomName.trim() || "My Room").replace(/[/\\:]/g, "-");
    const path = await api.chooseSavePath({
      title: "Choose where to create this workspace folder",
      defaultPath: suggested,
    });
    if (!path) return; // cancelled the location picker; stay in the branded flow
    if (navEpochRef.current !== epoch) return; // gate moved on — create nothing
    setBusy(true);
    try {
      // The typed name is the room's name, not just a filename suggestion —
      // saving "Journal" as "stuff.arcelle" used to leave the room called
      // "stuff" everywhere. Blank still falls back to the file's name.
      const info = await api.createRoom(
        path,
        password,
        roomName.trim() || undefined,
        "workspace-folder",
      );
      if (navEpochRef.current !== epoch) return; // stale: don't seed or enter
      // The room is now open. Seed the chosen template and role through
      // ordinary APIs before entering. Everything created here is normal,
      // editable content — no special machinery. Blank + default seed nothing.
      const tpl = ROOM_TEMPLATES.find((t) => t.key === templateKey);
      const role = roles.find((r) => r.id === roleId);
      // Best-effort: a failed template/role must never trap the user outside
      // their freshly created room. Surface a gentle note, still continue.
      try {
        // Custom instructions = the template's plus the chosen role's guidance
        // (either may be empty). Roles fold into the same setting.
        const instructions = [
          tpl?.customInstructions,
          role && role.id !== "default" ? role.instructions : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        if (instructions) {
          await api.setSetting("custom_instructions", instructions);
        }
        // Remember the chosen role so Settings/Workspace can reflect it.
        if (role && role.id !== "default") {
          await api.setSetting("room_role", role.id);
        }
        // Starter memories, Welcome.md, and any sample files.
        if (tpl && tpl.key !== "blank") {
          for (const memory of tpl.memories) {
            await api.addMemory(memory);
          }
          if (tpl.welcome) {
            await api.saveGeneratedFile("Welcome.md", tpl.welcome);
          }
          for (const f of tpl.files ?? []) {
            await api.saveGeneratedFile(f.name, f.content);
          }
        }
      } catch (e) {
        console.error("Failed to apply room template", e);
        setError("Room created, but its starter content could not be added.");
      }
      // One-time recovery code: generate it now (the room is open with the
      // just-set password) and reveal it once before entering. Recovery is
      // additive and optional — if it can't be written, quietly enter anyway.
      try {
        const code = await writeRecoveryKey();
        if (navEpochRef.current !== epoch) return; // stale: gate moved on
        setPendingInfo(info);
        setRecoveryCopied(false);
        setRecoveryCode(code);
      } catch (e) {
        console.error("Could not create a recovery code", e);
        if (navEpochRef.current !== epoch) return; // stale: gate moved on
        // The create screen has just promised, unconditionally, that a
        // one-time code on the next screen is the only way back into a room
        // whose password is forgotten. Entering quietly would leave that
        // promise broken with nothing but a console line to show for it.
        await message(
          "The room was created, but its recovery code could not be written. " +
            "As it stands, this room can only ever be opened with its " +
            "password. You can make a recovery key in Settings → " +
            "Privacy & recovery.",
          { title: "No recovery code was made", kind: "warning" },
        ).catch(() => {});
        if (navEpochRef.current !== epoch) return; // stale: gate moved on
        enterRoom(info);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlock(path: string) {
    // An empty submit never reaches the backend — SQLCipher's PRAGMA-key
    // error text has no place on the gate.
    if (!password) {
      setError("Enter your password to unlock this room.");
      return;
    }
    setBusy(true);
    const epoch = navEpochRef.current;
    try {
      const info = await api.openRoom(path, password);
      // The gate navigated while the unlock was in flight (another room's
      // file was double-clicked) — don't mount a workspace the new gate
      // replaced. The backend tears any leftover room down on the next open.
      if (navEpochRef.current !== epoch) return;
      enterRoom(info);
    } catch (e) {
      const msg = String(e);
      // The gate speaks plainly; the raw engine error goes to the console
      // for debugging, never to the person standing at the door.
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
    const sourceName = sourcePath.split(/[\\/]/).pop()?.replace(/\.(?:arcelle|roomai)$/i, "") || "Converted Room";
    const destinationPath = await api.chooseSavePath({
      title: "Choose the new normal-files workspace folder",
      defaultPath: `${sourceName} Workspace`,
    });
    if (!destinationPath) return;
    setBusy(true);
    setError("");
    const epoch = navEpochRef.current;
    try {
      const report = await api.convertLegacyRoom(sourcePath, password, destinationPath);
      if (navEpochRef.current !== epoch) return;
      if (report.renamed.length > 0 || report.skipped.length > 0) {
        const details = [
          `${report.convertedFiles} file${report.convertedFiles === 1 ? "" : "s"} converted.`,
          report.renamed.length > 0
            ? `${report.renamed.length} path${report.renamed.length === 1 ? " was" : "s were"} safely renamed.`
            : "",
          report.skipped.length > 0
            ? `${report.skipped.length} legacy row${report.skipped.length === 1 ? " had" : "s had"} no current bytes and stayed in private state.`
            : "",
        ].filter(Boolean).join("\n");
        await message(details, { title: "Conversion complete", kind: "info" });
      }
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

  async function handleImportSealed(packagePath: string) {
    if (!password) {
      setError("Enter the sealed backup password before importing it.");
      return;
    }
    setBusy(true);
    setError("");
    const epoch = navEpochRef.current;
    try {
      const packageInfo = await api.inspectSealedPackage(packagePath, password);
      const sourceName = packagePath.split(/[\\/]/).pop()?.replace(/\.arcelle$/i, "") || "Imported Room";
      const destinationPath = await api.chooseSavePath({
        title: "Choose the new workspace folder",
        defaultPath: `${sourceName} Workspace`,
      });
      if (!destinationPath || navEpochRef.current !== epoch) return;
      await api.importSealedPackage(packagePath, password, destinationPath);
      if (navEpochRef.current !== epoch) return;
      const info = await api.openRoom(destinationPath, password);
      if (navEpochRef.current !== epoch) return;
      await message(
        `Imported ${packageInfo.fileCount} file${packageInfo.fileCount === 1 ? "" : "s"} and private history into a new workspace.`,
        { title: "Sealed backup imported", kind: "info" },
      ).catch(() => {});
      enterRoom(info);
    } catch (e) {
      console.error("sealed import failed:", e);
      setError(unlockMessage(String(e)));
    } finally {
      setBusy(false);
    }
  }

  // Unlock using a one-time recovery code instead of the password. Same
  // success handling as a normal open; any failure surfaces a calm message.
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
      // A recovery unlock recovers the password and then runs the FULL open,
      // so a disconnected drive or a damaged file arrives in this catch too.
      // Only a verdict on the code itself may blame the code — the one
      // credential this user has left.
      setError(
        /recovery code/i.test(msg)
          ? "That recovery code didn't work. Check it and try again."
          : unlockMessage(msg),
      );
    } finally {
      setBusy(false);
    }
  }

  // ADD-11: unlock with a fingerprint. Any failure (cancel, no match) just
  // surfaces a message; the password field below stays available as fallback.
  async function handleTouchId(path: string) {
    setError("");
    setBusy(true);
    const epoch = navEpochRef.current;
    try {
      const info = await api.touchIdOpen(path);
      if (navEpochRef.current !== epoch) return; // stale: the gate moved on
      enterRoom(info);
    } catch (e) {
      // Same funnel as the typed password: this path used to print the bare
      // `WRONG_PASSWORD` sentinel (a stale Keychain entry) onto the gate.
      console.error("touch id unlock failed:", String(e));
      setError(unlockMessage(String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function handleLock() {
    const epoch = navEpochRef.current;
    // Reduced motion: close and return to the gate instantly, no ritual.
    if (prefersReducedMotion()) {
      await api.closeRoom();
      // Drop the room name from the title bar once locked (CHG-9).
      setWindowTitle("Arcelle").catch(() => {});
      // Another navigation (e.g. a .roomai opened mid-close showed its gate)
      // wins over the default return to the start screen.
      if (navEpochRef.current === epoch) goTo({ kind: "start" });
      return;
    }
    // Play the "sealing shut" ritual over the workspace. The room is closed
    // for real right away; only the visual swap to the gate is delayed by the
    // animation duration (~460ms). A failed close abandons the ritual and
    // leaves the user in the room, exactly as before.
    setLocking(true);
    // The close is not instant: it stops recordings, waits for running jobs and
    // may compact the room file. On a big room that outlasts the ritual, and
    // the veil says nothing — so once the animation is over and we are still
    // waiting, the overlay explains itself instead of reading as a freeze.
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
    // Drop the room name from the title bar once locked (CHG-9).
    setWindowTitle("Arcelle").catch(() => {});
    window.setTimeout(() => {
      setLocking(false);
      setLockSlow(false);
      // As above: a navigation during the ritual (another room's gate) wins.
      if (navEpochRef.current === epoch) goTo({ kind: "start" });
    }, SEAL_LOCK_MS);
  }

  if (screen.kind === "workspace") {
    return (
      <>
        <Workspace
          key={`${screen.info.path}:${roomEpoch}`}
          info={screen.info}
          onLock={handleLock}
          // A rename hands back the refreshed record. Swapped in place rather
          // than through `goTo`, which resets the gate's fields and would be a
          // navigation — the path is unchanged, so the workspace keeps its key
          // and nothing remounts.
          onRenamed={(info) => setScreen({ kind: "workspace", info })}
        />
        <WorkspaceOperationProgress operations={workspaceOperations} />
        {locking && <SealLockingOverlay slow={lockSlow} />}
      </>
    );
  }

  return (
    <div className={`gate${entering ? " entering" : ""}`}>
      <div className="gate-card">
        <div className="gate-logo">
          <Logomark size={56} />
        </div>
        <h1>Arcelle</h1>

        {screen.kind === "start" && (
          <StartScreen
            recent={recent}
            onCreate={chooseCreate}
            onOpen={chooseOpen}
            onDemo={chooseDemo}
            onOpenRecent={(path) => {
              // The row already knows the file is gone, so asking for its
              // password authenticates against nothing. The picker is the
              // thing that can be told where the room moved to.
              if (recent.find((r) => r.path === path)?.missing) void chooseOpen();
              else goTo({ kind: "unlock", path });
            }}
            onRemoveRecent={removeRecent}
            onTrashRoom={(room) => void trashRoom(room)}
            onClearRecent={clearRecent}
          />
        )}

        {screen.kind === "create" && (
          <CreateScreen
            roomName={roomName}
            setRoomName={setRoomName}
            templateKey={templateKey}
            setTemplateKey={setTemplateKey}
            roles={roles}
            roleId={roleId}
            setRoleId={setRoleId}
            password={password}
            setPassword={setPassword}
            confirm={confirm}
            setConfirm={setConfirm}
            error={error}
            setError={setError}
            busy={busy}
            onSubmit={handleCreate}
            onBack={() => goTo({ kind: "start" })}
          />
        )}

        {screen.kind === "unlock" && (
          <UnlockScreen
            path={screen.path}
            recoveryMode={recoveryMode}
            canTouchId={canTouchId}
            hasRecovery={hasRecovery}
            busy={busy}
            password={password}
            setPassword={setPassword}
            recoveryInput={recoveryInput}
            setRecoveryInput={setRecoveryInput}
            error={error}
            setError={setError}
            onUnlock={() => handleUnlock(screen.path)}
            onRecoveryUnlock={() => handleRecoveryUnlock(screen.path)}
            onTouchId={() => handleTouchId(screen.path)}
            onConvertLegacy={() => handleConvertLegacy(screen.path)}
            onImportSealed={() => handleImportSealed(screen.path)}
            onEnterRecoveryMode={() => {
              setRecoveryMode(true);
              setPassword("");
              setError("");
            }}
            onExitRecoveryMode={() => {
              setRecoveryMode(false);
              setRecoveryInput("");
              setError("");
            }}
            onBack={() => goTo({ kind: "start" })}
          />
        )}
      </div>
      <WorkspaceOperationProgress operations={workspaceOperations} />
      {entering && <SealUnlockingOverlay />}
      {recoveryCode && (
        <RecoveryModal
          recoveryCode={recoveryCode}
          recoveryCopied={recoveryCopied}
          setRecoveryCopied={setRecoveryCopied}
          onDismiss={dismissRecovery}
        />
      )}
    </div>
  );
}
