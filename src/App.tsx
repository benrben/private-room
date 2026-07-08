import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { api, RoomInfo, RecentRoom } from "./api";
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

// CONTRACT-NOTE: the API agent is adding typed api.ts wrappers for
// write_recovery_key / has_recovery_key / open_room_with_recovery / list_roles
// (and icons.RecoveryIcon) in parallel. Until they land, this file calls the
// backend commands directly (names + shapes per BACKEND-ACTUALS) so it builds
// standalone. Integration can fold these into src/api.ts and swap the icon.
const writeRecoveryKey = () => invoke<string>("write_recovery_key");
const hasRecoveryKey = (path: string) =>
  invoke<boolean>("has_recovery_key", { path });
const openRoomWithRecovery = (path: string, code: string) =>
  invoke<RoomInfo>("open_room_with_recovery", { path, code });
const listRoles = () => invoke<RoomRole[]>("list_roles");

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "start" });
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

  const loadRecent = useCallback(() => {
    api
      .listRecent()
      .then(setRecent)
      .catch(() => setRecent([]));
  }, []);

  const goTo = useCallback((next: Screen) => {
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

  // A .roomai file double-clicked in Finder lands here, either at launch
  // (pending open) or while the app is already running (event).
  useEffect(() => {
    api.takePendingOpen().then((path) => {
      if (path) goTo({ kind: "unlock", path });
    });
    const unlisten = api.onOpenRoomFile((path) => {
      goTo({ kind: "unlock", path });
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
      title: "Open a Private Room",
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
    setEntering(true);
    window.setTimeout(() => {
      setEntering(false);
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
    // Defer to the native panel only now, to pick where the file is saved.
    const suggested = (roomName.trim() || "My Room").replace(/[/\\:]/g, "-");
    const path = await api.chooseSavePath({
      title: "Choose where to save this room",
      defaultPath: `${suggested}.roomai`,
      filters: ROOM_FILTER,
    });
    if (!path) return; // cancelled the location picker; stay in the branded flow
    setBusy(true);
    try {
      const info = await api.createRoom(path, password);
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
        setPendingInfo(info);
        setRecoveryCopied(false);
        setRecoveryCode(code);
      } catch (e) {
        console.error("Could not create a recovery code", e);
        enterRoom(info);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlock(path: string) {
    setBusy(true);
    try {
      const info = await api.openRoom(path, password);
      enterRoom(info);
    } catch (e) {
      const msg = String(e);
      setError(
        msg.includes("WRONG_PASSWORD") ? "Wrong password. Try again." : msg,
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
    try {
      const info = await openRoomWithRecovery(path, code);
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
    try {
      const info = await api.touchIdOpen(path);
      enterRoom(info);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleLock() {
    // Reduced motion: close and return to the gate instantly, no ritual.
    if (prefersReducedMotion()) {
      await api.closeRoom();
      // Drop the room name from the title bar once locked (CHG-9).
      getCurrentWindow().setTitle("Private Room").catch(() => {});
      goTo({ kind: "start" });
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
    getCurrentWindow().setTitle("Private Room").catch(() => {});
    window.setTimeout(() => {
      setLocking(false);
      goTo({ kind: "start" });
    }, SEAL_LOCK_MS);
  }

  if (screen.kind === "workspace") {
    return (
      <>
        <Workspace info={screen.info} onLock={handleLock} />
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
        <h1>Private Room</h1>

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
