import { useEffect, useState } from "react";
import { checkForUpdate, getVersion, installUpdate, type AvailableUpdate } from "../platform";
import {
  AlertIcon,
  CircleCheckIcon,
  DownloadIcon,
  FolderIcon,
  Logomark,
  Wordmark,
} from "../icons";
import { api } from "../api";
import { autoUpdateCheckEnabled, setAutoUpdateCheck } from "../updater";

/** The update handle `check()` hands back (typed off the plugin so we don't
 * depend on an un-exported class name). */
type UpdateHandle = AvailableUpdate;

type Phase = "idle" | "checking" | "available" | "downloading" | "uptodate" | "error";

/**
 * Updates & version — the manual counterpart to the silent launch check.
 *
 * One button drives the whole flow and, unlike the quiet launch check, makes
 * every outcome visible: Check → (up to date | vX available) → Download &
 * install → relaunch. The updater is really configured (signed `latest.json`
 * on GitHub Releases; pubkey + endpoint in tauri.conf.json), so `check()` and
 * `downloadAndInstall()` hit the real release. Installing replaces the app on
 * disk and relaunches it.
 */
export default function AboutSection() {
  const [current, setCurrent] = useState<string>("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [update, setUpdate] = useState<UpdateHandle | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState<string>("");
  // The log folder, shown only once the reveal actually succeeded — naming a
  // path we failed to open would be the same small lie the logs exist to catch.
  const [logDir, setLogDir] = useState<string>("");
  const [logErr, setLogErr] = useState<string>("");
  // Read once from the same preference the launch check reads, so the box
  // shows what is actually in force rather than a fresh-install default.
  const [autoCheck, setAutoCheck] = useState<boolean>(() => autoUpdateCheckEnabled());

  useEffect(() => {
    getVersion().then(setCurrent).catch(() => setCurrent(""));
  }, []);

  async function runCheck() {
    setPhase("checking");
    setErr("");
    setUpdate(null);
    try {
      const u = await checkForUpdate();
      if (!u) {
        setPhase("uptodate");
        return;
      }
      setUpdate(u);
      setPhase("available");
    } catch (e) {
      setErr(errText(e));
      setPhase("error");
    }
  }

  async function runInstall() {
    if (!update) return;
    setPhase("downloading");
    setPct(0);
    setErr("");
    try {
      setPct(null);
      // The main process downloads, verifies the minisign payload, installs it
      // and relaunches. A successful call normally never returns to this page.
      await installUpdate();
    } catch (e) {
      setErr(errText(e));
      setPhase("error");
    }
  }

  async function showLogs() {
    setLogErr("");
    try {
      setLogDir(await api.revealLogs());
    } catch (e) {
      setLogDir("");
      setLogErr(typeof e === "string" ? e : "The logs folder could not be opened.");
    }
  }

  const busy = phase === "checking" || phase === "downloading";

  return (
    <section id="set-about">
      {/* The brand lockup: the mark large enough for the folds to read, and
          the handwritten wordmark beside it. This is the only screen in the
          product that shows the brand at rest rather than as a 26px chip in a
          toolbar, so it is worth the room. The version deliberately is NOT
          repeated here — it already has a functional row of its own directly
          below, next to the button that acts on it.

          Inline styles rather than a class because this file already styles
          its one-off rows that way and the settings stylesheet is not this
          component's to grow. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 22,
          lineHeight: 0,
        }}
      >
        <Logomark size={64} />
        <Wordmark size={38} />
      </div>

      <h3>Updates &amp; version</h3>
      <p className="settings-hint">
        Arcelle updates itself from its signed GitHub releases.{" "}
        {autoCheck
          ? "It checks quietly on launch;"
          : "The launch check is switched off, so nothing is contacted until you ask;"}{" "}
        use the button below to check right now and install the latest release
        in one click.
      </p>

      {/* The launch check reaches GitHub before any room is unlocked, which
          makes it one of only two things this app sends anywhere on its own.
          The preference has existed since the check did; until now nothing
          wrote it, so the only way to switch it off was to edit localStorage
          by hand — a promise the README made on the app's behalf that the app
          itself did not keep. `data-agent-blocked` for the same reason every
          other outbound-network switch is: it is the user's decision, not an
          agent's. */}
      <div className="settings-toggle-row" data-agent-blocked="true">
        <label className="switch">
          <input
            type="checkbox"
            checked={autoCheck}
            aria-label="Check for updates automatically on launch"
            onChange={(e) => setAutoCheck(setAutoUpdateCheck(e.target.checked))}
          />
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
        </label>
        <span>
          {autoCheck
            ? "Check for updates on launch — Arcelle contacts GitHub each time it starts."
            : "OFF — Arcelle never contacts GitHub on its own. Checking here still works."}
        </span>
      </div>

      <div className="model-row" style={{ justifyContent: "space-between" }}>
        <span>
          Current version <strong>{current ? `v${current}` : "…"}</strong>
        </span>

        {phase === "available" && update ? (
          <button className="primary btn-ic" onClick={() => void runInstall()}>
            <DownloadIcon size={14} /> Download &amp; install v{update.version}
          </button>
        ) : (
          <button className="subtle btn-ic" disabled={busy} onClick={() => void runCheck()}>
            <DownloadIcon size={14} />{" "}
            {phase === "checking" ? "Checking…" : "Check for updates"}
          </button>
        )}
      </div>

      {phase === "uptodate" && (
        <div className="settings-hint btn-ic" style={{ marginTop: 8, color: "var(--ok, var(--accent))" }}>
          <CircleCheckIcon size={14} /> You're on the latest version.
        </div>
      )}

      {phase === "available" && update && (
        <div className="settings-hint" style={{ marginTop: 8 }}>
          Version <strong>v{update.version}</strong> is available. Installing
          replaces this app and relaunches it — save your work first.
        </div>
      )}

      {phase === "downloading" && (
        <div className="pull-progress" style={{ marginTop: 8 }}>
          <div className="pull-bar">
            <div
              className="pull-bar-fill"
              style={{ width: `${pct ?? 0}%`, ...(pct == null ? { opacity: 0.6 } : null) }}
            />
          </div>
          <span>
            {pct != null && pct >= 100
              ? "Installing… the app will relaunch."
              : `Downloading the update…${pct != null ? ` ${pct}%` : ""}`}
          </span>
        </div>
      )}

      {phase === "error" && (
        <div className="gate-error btn-ic" style={{ marginTop: 8 }}>
          <AlertIcon size={14} className="warn-ic" /> {err}
        </div>
      )}

      <h3 style={{ marginTop: 24 }}>Logs</h3>
      <p className="settings-hint">
        Arcelle keeps two small log files — one for the app and one for its AI
        service. They record what the app <em>did</em>: which tools an agent was
        given, which model answered, how long it took, whether a Stop landed.
        Nothing from a room goes in them — no messages, no file contents, not
        even file names — so they're safe to attach to a bug report.
      </p>

      <div className="model-row" style={{ justifyContent: "space-between" }}>
        <span>Show the log files in Finder</span>
        <button className="subtle btn-ic" onClick={() => void showLogs()}>
          <FolderIcon size={14} /> Reveal logs
        </button>
      </div>

      {logDir && (
        <div className="settings-hint" style={{ marginTop: 8 }}>
          Opened <code>{logDir}</code> — look for{" "}
          <code>arcelle-host.log</code> and <code>arcelle-sidecar.log</code>.
        </div>
      )}

      {logErr && (
        <div className="gate-error btn-ic" style={{ marginTop: 8 }}>
          <AlertIcon size={14} className="warn-ic" /> {logErr}
        </div>
      )}
    </section>
  );
}

/** A short, human message for a caught updater error (offline, no release, etc.). */
function errText(e: unknown): string {
  const raw = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  if (/network|timeout|dns|connection|offline|failed to fetch/i.test(raw)) {
    return "Couldn't reach the release server — check your connection and try again.";
  }
  return raw || "The update check failed. Please try again.";
}
