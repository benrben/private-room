import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, RoomInfo, RecentRoom } from "./api";
import Workspace from "./Workspace";
import { Logomark, CloseIcon } from "./icons";
import "./App.css";

type Screen =
  | { kind: "start" }
  | { kind: "create"; path: string }
  | { kind: "unlock"; path: string }
  | { kind: "workspace"; info: RoomInfo };

const ROOM_FILTER = [{ name: "Private Room Project", extensions: ["roomai"] }];

const MIN_PASSWORD = 8;

function fileNameOf(path: string): string {
  return path.split("/").pop() ?? path;
}

type Strength = { score: 0 | 1 | 2 | 3; label: string; level: "weak" | "okay" | "strong" };

// Simple, library-free estimate: length plus the mix of character kinds
// (lowercase, uppercase, digit, symbol). Empty input scores nothing.
function passwordStrength(pw: string): Strength {
  if (!pw) return { score: 0, label: "", level: "weak" };
  let kinds = 0;
  if (/[a-z]/.test(pw)) kinds++;
  if (/[A-Z]/.test(pw)) kinds++;
  if (/[0-9]/.test(pw)) kinds++;
  if (/[^A-Za-z0-9]/.test(pw)) kinds++;

  let points = 0;
  if (pw.length >= 8) points++;
  if (pw.length >= 12) points++;
  if (kinds >= 2) points++;
  if (kinds >= 3) points++;

  if (pw.length < 8 || points <= 1) {
    return { score: 1, label: "Weak", level: "weak" };
  }
  if (points === 2 || points === 3) {
    return { score: 2, label: "Okay", level: "okay" };
  }
  return { score: 3, label: "Strong", level: "strong" };
}

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "start" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [entering, setEntering] = useState(false);
  const [recent, setRecent] = useState<RecentRoom[]>([]);

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

  async function removeRecent(path: string) {
    await api.removeRecent(path);
    loadRecent();
  }

  async function clearRecent() {
    await api.clearRecent();
    loadRecent();
  }

  async function chooseCreate() {
    const path = await api.chooseSavePath({
      title: "Create a new Private Room",
      defaultPath: "My Room.roomai",
      filters: ROOM_FILTER,
    });
    if (path) goTo({ kind: "create", path });
  }

  async function chooseOpen() {
    const path = await api.chooseOpenPath({
      title: "Open a Private Room",
      multiple: false,
      filters: ROOM_FILTER,
    });
    if (typeof path === "string") goTo({ kind: "unlock", path });
  }

  // Successful unlock plays a short "door opens" bloom on the gate
  // before the workspace appears.
  function enterRoom(info: RoomInfo) {
    setEntering(true);
    window.setTimeout(() => {
      setEntering(false);
      goTo({ kind: "workspace", info });
    }, 700);
  }

  async function handleCreate(path: string) {
    if (password.length < MIN_PASSWORD) {
      setError(`Please use at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const info = await api.createRoom(path, password);
      enterRoom(info);
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

  async function handleLock() {
    await api.closeRoom();
    // Drop the room name from the title bar once locked (CHG-9).
    getCurrentWindow().setTitle("Private Room").catch(() => {});
    goTo({ kind: "start" });
  }

  if (screen.kind === "workspace") {
    return <Workspace info={screen.info} onLock={handleLock} />;
  }

  const strength = passwordStrength(password);

  return (
    <div className={`gate${entering ? " entering" : ""}`}>
      <div className="gate-card">
        <div className="gate-logo">
          <Logomark size={56} />
        </div>
        <h1>Private Room</h1>

        {screen.kind === "start" && (
          <>
            <p className="gate-sub">
              Your files, links, chats and AI — sealed inside one encrypted
              file that never leaves this computer.
            </p>
            <div className="gate-actions">
              <button className="primary" onClick={chooseCreate}>
                Create New Room
              </button>
              <button onClick={chooseOpen}>Open Room…</button>
            </div>
            {recent.length > 0 && (
              <div className="recent">
                <div className="recent-label">Recent</div>
                <ul className="recent-list">
                  {recent.map((room) => (
                    <li key={room.path} className="recent-row">
                      <button
                        className="recent-open"
                        onClick={() =>
                          goTo({ kind: "unlock", path: room.path })
                        }
                      >
                        <span className="recent-name">{room.name}</span>
                        <span className="recent-path">{room.path}</span>
                      </button>
                      <button
                        className="recent-remove"
                        title="Remove from list"
                        aria-label="Remove from list"
                        onClick={() => removeRecent(room.path)}
                      >
                        <CloseIcon size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
                <button className="recent-clear" onClick={clearRecent}>
                  Clear list
                </button>
              </div>
            )}
          </>
        )}

        {screen.kind === "create" && (
          <form
            className="gate-form"
            onSubmit={(e) => {
              e.preventDefault();
              handleCreate(screen.path);
            }}
          >
            <p className="gate-sub">
              New room: <strong>{fileNameOf(screen.path)}</strong>
            </p>
            <input
              type="password"
              placeholder="Choose a password"
              value={password}
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
            />
            {password && (
              <div className={`pw-meter ${strength.level}`}>
                <div className="pw-meter-track">
                  <div className="pw-meter-fill" />
                </div>
                <span className="pw-meter-label">{strength.label}</span>
              </div>
            )}
            <input
              type="password"
              placeholder="Repeat password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {error && <div className="gate-error">{error}</div>}
            <div className="gate-actions">
              <button className="primary" type="submit" disabled={busy}>
                {busy ? "Creating…" : "Create & Enter"}
              </button>
              <button type="button" onClick={() => goTo({ kind: "start" })}>
                Back
              </button>
            </div>
            <p className="gate-note">
              Longer is stronger. There is no recovery if you forget it.
            </p>
          </form>
        )}

        {screen.kind === "unlock" && (
          <form
            className="gate-form"
            onSubmit={(e) => {
              e.preventDefault();
              handleUnlock(screen.path);
            }}
          >
            <p className="gate-sub">
              Unlock <strong>{fileNameOf(screen.path)}</strong>
            </p>
            <input
              type="password"
              placeholder="Password"
              value={password}
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <div className="gate-error">{error}</div>}
            <div className="gate-actions">
              <button className="primary" type="submit" disabled={busy}>
                {busy ? "Unlocking…" : "Unlock"}
              </button>
              <button type="button" onClick={() => goTo({ kind: "start" })}>
                Back
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
