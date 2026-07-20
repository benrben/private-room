import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  api,
  RoomInfo,
  RecentRoom,
  listRoles,
  writeRecoveryKey,
  hasRecoveryKey,
  openRoomWithRecovery,
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
import { StartScreen } from "./screens/StartScreen";
import { CreateScreen } from "./screens/CreateScreen";
import { UnlockScreen } from "./screens/UnlockScreen";
import { RecoveryModal } from "./screens/RecoveryModal";
import {
  SealLockingOverlay,
  SealUnlockingOverlay,
} from "./screens/SealOverlay";
import "./App.css";
import "./seal.css";

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
    loadRecent();
  }

  async function clearRecent() {
    await api.clearRecent();
    loadRecent();
  }

  // Start the branded create flow immediately — the user names the room and
  // sets a password in-app; the native file panel is deferred to the final
  // "Create & Enter", and only to choose where the one encrypted file lands.
  function chooseCreate() {
    goTo({ kind: "create", path: "" });
  }

  async function chooseOpen() {
    const path = await api.chooseOpenPath({
      title: "Open a Arcelle",
      multiple: false,
      filters: ROOM_FILTER,
    });
    if (typeof path === "string") goTo({ kind: "unlock", path });
  }

  // "Try a demo room": jump straight into the create flow with the bundled
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
    // Defer to the native panel only now, to pick where the file is saved.
    const suggested = (roomName.trim() || "My Room").replace(/[/\\:]/g, "-");
    const path = await api.chooseSavePath({
      title: "Choose where to save this room",
      defaultPath: `${suggested}.arcelle`,
      filters: ROOM_FILTER,
    });
    if (!path) return; // cancelled the location picker; stay in the branded flow
    if (navEpochRef.current !== epoch) return; // gate moved on — create nothing
    setBusy(true);
    try {
      const info = await api.createRoom(path, password);
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
      setError(
        msg.includes("WRONG_PASSWORD")
          ? "That password didn't work. Try again."
          : /PRAGMA|sqlcipher|rekey|ATTACH/i.test(msg)
            ? "This room couldn't be unlocked. Check the password and try again."
            : msg,
      );
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
    } catch {
      setError("That recovery code didn't work. Check it and try again.");
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
      setError(String(e));
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
      getCurrentWindow().setTitle("Arcelle").catch(() => {});
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
    try {
      await api.closeRoom();
    } catch (e) {
      setLocking(false);
      throw e;
    }
    // Drop the room name from the title bar once locked (CHG-9).
    getCurrentWindow().setTitle("Arcelle").catch(() => {});
    window.setTimeout(() => {
      setLocking(false);
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
        />
        {locking && <SealLockingOverlay />}
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
            onOpenRecent={(path) => goTo({ kind: "unlock", path })}
            onRemoveRecent={removeRecent}
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
