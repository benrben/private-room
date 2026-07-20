import { useEffect, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { AlertIcon, CircleCheckIcon, DownloadIcon } from "../icons";

/** The update handle `check()` hands back (typed off the plugin so we don't
 * depend on an un-exported class name). */
type UpdateHandle = NonNullable<Awaited<ReturnType<typeof check>>>;

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

  useEffect(() => {
    getVersion().then(setCurrent).catch(() => setCurrent(""));
  }, []);

  async function runCheck() {
    setPhase("checking");
    setErr("");
    setUpdate(null);
    try {
      const u = await check();
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
      let total = 0;
      let got = 0;
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") {
          total = ev.data.contentLength ?? 0;
          setPct(0);
        } else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          setPct(total > 0 ? Math.min(99, Math.round((got / total) * 100)) : null);
        } else if (ev.event === "Finished") {
          setPct(100);
        }
      });
      // Installed on disk — relaunch into the new version (this never returns).
      await relaunch();
    } catch (e) {
      setErr(errText(e));
      setPhase("error");
    }
  }

  const busy = phase === "checking" || phase === "downloading";

  return (
    <section id="set-about">
      <h3>Updates &amp; version</h3>
      <p className="settings-hint">
        Private Room updates itself from its signed GitHub releases. It checks
        quietly on launch; use the button below to check right now and install
        the latest release in one click.
      </p>

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
