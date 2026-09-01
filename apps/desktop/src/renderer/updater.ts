import { checkForUpdate, confirm, installUpdate, message } from "./platform";

/** Launch-time updates.
 *
 * Two preferences live here, both device-wide (like the theme) rather than
 * per room, because they are about this copy of the app and are read before
 * any room is open:
 *
 *  - `prUpdateCheck = "0"` — never contact GitHub on launch. This is one of
 *    the app's two unprompted outbound requests (the other is the connector
 *    catalogue, which is opt-in), and it fires before any room is unlocked, so
 *    it needs a switch a person can actually reach: Settings → Updates &
 *    version renders it (`settings/AboutSection.tsx`) and calls
 *    `setAutoUpdateCheck` below. Switching it off leaves the manual "Check for
 *    updates" button working — the objection is to the app reaching out on its
 *    own, not to updating.
 *  - `prSkippedUpdate = "<version>"` — a version the user said no to. Without
 *    it, declining meant being asked again on every single launch.
 */
const AUTO_KEY = "prUpdateCheck";
const SKIP_KEY = "prSkippedUpdate";

/** What the user said about an offered update — with "the dialog never opened"
 * kept apart from "no", because only one of the two is worth remembering. */
type Answer = "install" | "skip" | "unavailable";
type AvailableUpdate = NonNullable<Awaited<ReturnType<typeof checkForUpdate>>>;

/** Whether the app may check for updates on launch. On unless switched off. */
export function autoUpdateCheckEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Turn the launch check on or off. Returns what is now in force, which is not
 * always what was asked: with `localStorage` unavailable the write is lost, and
 * reporting the request back would leave the checkbox claiming a setting the
 * next launch will not honour. */
export function setAutoUpdateCheck(enabled: boolean): boolean {
  try {
    if (enabled) localStorage.removeItem(AUTO_KEY);
    else localStorage.setItem(AUTO_KEY, "0");
  } catch {
    /* private mode — fall through and answer with what actually reads back */
  }
  return autoUpdateCheckEnabled();
}

function skippedVersion(): string {
  try {
    return localStorage.getItem(SKIP_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberSkipped(version: string): void {
  try {
    localStorage.setItem(SKIP_KEY, version);
  } catch {
    /* private mode — we'll simply ask again next launch */
  }
}

/**
 * Quietly check GitHub Releases for a newer signed build on launch.
 *
 * Fire-and-forget: call once after mount. The updater IS configured (a real
 * `pubkey` + `endpoints` live in tauri.conf.json — see RELEASING.md), so
 * `check()` hits GitHub for real. The CHECK stays visually silent: a failure
 * there just means offline, rate-limited, or no newer release yet, and it is
 * logged rather than shown. Once the user says yes, though, nothing is silent
 * any more — the download shows its progress, and a failed install says so
 * instead of leaving them waiting for an update that never arrives.
 */
async function availableUpdate(): Promise<AvailableUpdate | null> {
  if (!autoUpdateCheckEnabled()) {
    console.info("[updater] launch check is switched off (prUpdateCheck=0).");
    return null;
  }

  let update: AvailableUpdate | null = null;
  try {
    update = await checkForUpdate();
  } catch (e) {
    // Offline / rate-limited / no release yet — stay visually silent on launch,
    // but log distinguishably so a genuine failure isn't invisible.
    console.warn("[updater] check failed (offline or no release yet):", e);
    return null;
  }
  if (!update) {
    console.info("[updater] up to date.");
    return null;
  }
  if (skippedVersion() === update.version) {
    console.info(`[updater] version ${update.version} was skipped by the user.`);
    return null;
  }
  console.info(`[updater] version ${update.version} available.`);
  return update;
}

function askAboutUpdate(version: string): Promise<Answer> {
  // "Skip this version" and "the dialog never opened" are different answers.
  // A skip is remembered for that exact version and nothing in the app clears
  // it, so collapsing the two would let a dialog that failed to open — this
  // runs from main.tsx at launch, before any UI has settled — bury that
  // release for good. Only a real "no" is remembered.
  return confirm(
    // The download says so up front because it cannot be taken back:
    // `downloadAndInstall` is awaited with no abort handle and no backend
    // cancel exists, so the banner it draws has no Stop button to offer.
    `Version ${version} is available.\n\nInstall it now and relaunch Arcelle? ` +
      `The download can't be stopped once it starts.`,
    {
      title: "Update available",
      kind: "info",
      okLabel: "Install & relaunch",
      cancelLabel: "Skip this version",
    },
  )
    .then((ok): Answer => (ok ? "install" : "skip"))
    .catch((e): Answer => {
      console.warn("[updater] couldn't ask about the update:", e);
      return "unavailable";
    });
}

async function installAvailableUpdate(version: string): Promise<void> {
  const progress = showDownloadProgress(version);
  try {
    progress.set(null);
    await installUpdate();
  } catch (e) {
    console.error("[updater] install failed:", e);
    await message(
      `Version ${version} couldn't be installed.\n\n${String(e)}\n\n` +
        "Arcelle is still running on the version you had. You can try again " +
        "from Settings → Updates & version.",
      { title: "Update failed", kind: "error" },
    ).catch(() => {});
  } finally {
    progress.done();
  }
}

export async function checkForUpdatesQuietly(): Promise<void> {
  const update = await availableUpdate();
  if (!update) return;
  const answer = await askAboutUpdate(update.version);
  if (answer === "unavailable") return;
  if (answer === "skip") {
    // Remembered by exact version, so the NEXT release still asks.
    rememberSkipped(update.version);
    return;
  }
  await installAvailableUpdate(update.version);
}

/** A small live banner for the launch download.
 *
 * Built straight into the DOM rather than in React: this runs beside the app
 * (the user may still be at the gate, or deep in a room) and must not depend
 * on any screen being mounted. Styling comes from the theme tokens, so it
 * matches whichever theme is on. */
function showDownloadProgress(version: string): {
  set: (pct: number | null) => void;
  done: () => void;
  } {
  let host: HTMLDivElement | null = null;
  let fill: HTMLElement | null = null;
  let track: HTMLElement | null = null;
  let label: HTMLElement | null = null;
  try {
    host = document.createElement("div");
    host.className = "update-progress";
    host.setAttribute("role", "status");
    host.innerHTML =
      '<span class="update-progress-text"></span>' +
      '<span class="update-progress-track"><span class="update-progress-fill"></span></span>';
    label = host.querySelector(".update-progress-text");
    track = host.querySelector(".update-progress-track");
    fill = host.querySelector(".update-progress-fill");
    if (label) label.textContent = `Downloading Arcelle ${version}…`;
    document.body.appendChild(host);
  } catch {
    /* no DOM to draw on — the console log is still the record */
  }
  return {
    set(pct) {
      setProgressLabel(label, version, pct);
      // A server that sends no `Content-Length` leaves the share unknowable.
      // An empty track that never moves reads as a stalled download rather
      // than an unmeasured one, so the label stands alone — the same choice
      // ModelSection and jobProgress already make for "running, position
      // unknown".
      setProgressTrack(track, pct);
      setProgressFill(fill, pct);
    },
    done() {
      host?.remove();
    },
  };
}

function progressLabel(version: string, pct: number | null): string {
  // The installer boundary currently exposes no byte-progress callback, so its
  // only caller passes null. Keep the label honest until that boundary can
  // supply a measured percentage.
  void pct;
  return `Downloading Arcelle ${version}…`;
}

function setProgressLabel(label: HTMLElement | null, version: string, pct: number | null): void {
  if (label) label.textContent = progressLabel(version, pct);
}

function setProgressTrack(track: HTMLElement | null, pct: number | null): void {
  if (track) track.style.display = pct === null ? "none" : "";
}

function setProgressFill(fill: HTMLElement | null, pct: number | null): void {
  if (fill) fill.style.width = `${pct ?? 0}%`;
}
