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

// ADD-15 — Room templates.
// Plain frontend data: each template pre-fills the room's custom
// instructions, a couple of starter memories, and a Welcome.md note.
// Applied AFTER create_room succeeds using ordinary APIs, so everything
// a template makes is normal, editable content — no special machinery.
// "Blank" is the default and seeds nothing (a room exactly like today).
type RoomTemplate = {
  key: string;
  label: string;
  customInstructions: string;
  memories: string[];
  welcome: string;
};

const ROOM_TEMPLATES: RoomTemplate[] = [
  {
    key: "blank",
    label: "Blank",
    customInstructions: "",
    memories: [],
    welcome: "",
  },
  {
    key: "legal",
    label: "Legal",
    customInstructions:
      "This room holds legal documents and correspondence. Answer plainly " +
      "and cite the exact file and clause you are drawing from. Flag " +
      "deadlines, obligations, and anything that looks unusual. You are " +
      "not a lawyer and do not give legal advice — when something has real " +
      "consequences, say so and suggest checking with a professional.",
    memories: [
      "This room is for keeping and understanding legal paperwork.",
      "Prefer quoting the document over paraphrasing when wording matters.",
      "Always note dates, deadlines, and who is responsible for what.",
    ],
    welcome:
      "# Welcome to your Legal room\n\n" +
      "A quiet, private place for contracts, letters, and anything with " +
      "fine print. Nothing here leaves your computer.\n\n" +
      "## What to add here\n\n" +
      "- Contracts and agreements (leases, employment, services)\n" +
      "- Letters and notices you have sent or received\n" +
      "- Terms, policies, and any document you want to actually understand\n\n" +
      "## Three questions to try\n\n" +
      "1. What are my main obligations and deadlines in this contract?\n" +
      "2. Summarize this letter in plain language.\n" +
      "3. Are there any unusual or one-sided clauses I should notice?\n",
  },
  {
    key: "medical",
    label: "Medical",
    customInstructions:
      "This room holds personal medical records and notes. Explain terms " +
      "in plain, calm language and always point to the file a fact comes " +
      "from. Help track dates, results, and medications. You are not a " +
      "doctor and do not diagnose — for anything worrying, encourage the " +
      "person to speak with a clinician.",
    memories: [
      "This room is for personal health records and understanding them.",
      "Explain medical terms simply, without alarm.",
      "Keep track of test dates, results, and medications when they appear.",
    ],
    welcome:
      "# Welcome to your Medical room\n\n" +
      "A private place to keep and make sense of your health records. " +
      "Everything stays on this computer.\n\n" +
      "## What to add here\n\n" +
      "- Test and lab results, scans, and doctor's letters\n" +
      "- Medication lists and prescriptions\n" +
      "- Notes from appointments and questions for next time\n\n" +
      "## Three questions to try\n\n" +
      "1. What do the results in this report mean, in plain words?\n" +
      "2. List every medication mentioned across my files.\n" +
      "3. What questions should I bring to my next appointment?\n",
  },
  {
    key: "research",
    label: "Research",
    customInstructions:
      "This room is for research and reading. Help gather, compare, and " +
      "summarize sources, and always cite the file behind each claim. When " +
      "sources disagree, say so rather than smoothing it over. Keep a clear " +
      "line between what a source states and your own reasoning.",
    memories: [
      "This room is for collecting and thinking through research material.",
      "Cite the source file for every claim.",
      "When sources conflict, surface the disagreement plainly.",
    ],
    welcome:
      "# Welcome to your Research room\n\n" +
      "A calm workspace for papers, articles, and notes on a topic you " +
      "care about. Read, compare, and connect — all offline.\n\n" +
      "## What to add here\n\n" +
      "- Papers, PDFs, and saved web pages\n" +
      "- Your own notes, outlines, and questions\n" +
      "- Anything you want to compare, summarize, or cite later\n\n" +
      "## Three questions to try\n\n" +
      "1. Summarize the key findings across these documents.\n" +
      "2. Where do these sources agree, and where do they disagree?\n" +
      "3. What questions are still open based on what I have here?\n",
  },
  {
    key: "journal",
    label: "Journal",
    customInstructions:
      "This room is a personal journal. Be a warm, unhurried listener. " +
      "Help reflect, notice patterns over time, and find past entries when " +
      "asked. Never judge. Keep everything private and gentle in tone.",
    memories: [
      "This room is a private personal journal.",
      "Respond with warmth and without judgement.",
      "Help notice themes and patterns across entries over time.",
    ],
    welcome:
      "# Welcome to your Journal\n\n" +
      "A private space to write, reflect, and look back. No one else can " +
      "read this — it lives only on your computer.\n\n" +
      "## What to add here\n\n" +
      "- Daily or occasional entries, however long or short\n" +
      "- Thoughts, plans, gratitude, or things weighing on you\n" +
      "- Photos or notes you want to remember\n\n" +
      "## Three questions to try\n\n" +
      "1. What themes come up most often in my entries?\n" +
      "2. How was I feeling around last month?\n" +
      "3. Find the entry where I wrote about a particular day or event.\n",
  },
];

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
  const [templateKey, setTemplateKey] = useState("blank");
  // ADD-11: whether the room on the unlock screen has a Touch ID entry.
  const [canTouchId, setCanTouchId] = useState(false);

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
    setTemplateKey("blank");
    setCanTouchId(false);
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
      // The room is now open. Seed the chosen template through ordinary
      // APIs before entering. Blank seeds nothing (empty content array),
      // so this loop is skipped and the room stays exactly like today.
      const tpl = ROOM_TEMPLATES.find((t) => t.key === templateKey);
      if (tpl && tpl.key !== "blank") {
        // Best-effort: a failed template must never trap the user outside
        // their freshly created room. Surface a gentle note, still enter.
        try {
          await api.setSetting("custom_instructions", tpl.customInstructions);
          for (const memory of tpl.memories) {
            await api.addMemory(memory);
          }
          await api.saveGeneratedFile("Welcome.md", tpl.welcome);
        } catch (e) {
          console.error("Failed to apply room template", e);
          setError("Room created, but its starter content could not be added.");
        }
      }
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
            <div className="tpl-picker">
              <div className="tpl-label">Start from a template</div>
              <div className="tpl-chips">
                {ROOM_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.key}
                    type="button"
                    className={`tpl-chip${
                      templateKey === tpl.key ? " active" : ""
                    }`}
                    aria-pressed={templateKey === tpl.key}
                    onClick={() => setTemplateKey(tpl.key)}
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>
            </div>
            <input
              type="password"
              placeholder="Choose a password"
              value={password}
              autoFocus
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError("");
              }}
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
              onChange={(e) => {
                setConfirm(e.target.value);
                if (error) setError("");
              }}
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
            {canTouchId && (
              <button
                type="button"
                className="touchid-btn"
                disabled={busy}
                onClick={() => handleTouchId(screen.path)}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 10a2 2 0 0 0-2 2c0 1.5.1 3 .5 4.5" />
                  <path d="M8.5 8a5 5 0 0 1 7.5 4.3c0 1.4.1 2.8.4 4.2" />
                  <path d="M5 12a7 7 0 0 1 13-3.6" />
                  <path d="M6.2 16.5c-.4-1.5-.5-3-.5-4.5" />
                  <path d="M12 12v1.5c0 2 .2 4 .8 6" />
                </svg>
                Use Touch ID
              </button>
            )}
            <input
              type="password"
              placeholder="Password"
              value={password}
              autoFocus
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError("");
              }}
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
