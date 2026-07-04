import { useCallback, useEffect, useState } from "react";
import { api, RoomInfo } from "./api";
import Workspace from "./Workspace";
import { Logomark } from "./icons";
import "./App.css";

type Screen =
  | { kind: "start" }
  | { kind: "create"; path: string }
  | { kind: "unlock"; path: string }
  | { kind: "workspace"; info: RoomInfo };

const ROOM_FILTER = [{ name: "Private Room Project", extensions: ["roomai"] }];

function fileNameOf(path: string): string {
  return path.split("/").pop() ?? path;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "start" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [entering, setEntering] = useState(false);

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
    if (password.length < 4) {
      setError("Password must be at least 4 characters.");
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
    goTo({ kind: "start" });
  }

  if (screen.kind === "workspace") {
    return <Workspace info={screen.info} onLock={handleLock} />;
  }

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
              The password encrypts the whole file. There is no recovery if you
              forget it.
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
