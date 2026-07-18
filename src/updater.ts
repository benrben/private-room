import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { confirm } from "@tauri-apps/plugin-dialog";

/**
 * Quietly check GitHub Releases for a newer signed build on launch.
 *
 * Fire-and-forget: call once after mount. The updater IS configured (a real
 * `pubkey` + `endpoints` live in tauri.conf.json — see RELEASING.md), so
 * `check()` hits GitHub for real. We still stay VISUALLY silent on launch — the
 * update prompt is the only thing worth interrupting for; a failure here just
 * means offline, rate-limited, or no newer release yet. Outcomes are logged (not
 * shown) so "up to date", "update offered", and "check failed" are
 * distinguishable during support instead of one indistinguishable silent no-op.
 */
export async function checkForUpdatesQuietly(): Promise<void> {
  try {
    const update = await check();
    if (!update) {
      console.info("[updater] up to date.");
      return;
    }
    console.info(`[updater] version ${update.version} available.`);

    const ok = await confirm(
      `Version ${update.version} is available.\n\nInstall it now and relaunch Private Room?`,
      { title: "Update available — Install & relaunch", kind: "info" },
    );
    if (!ok) return;

    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    // Offline / rate-limited / no release yet — stay visually silent on launch,
    // but log distinguishably so a genuine failure isn't invisible.
    console.warn("[updater] check failed (offline or no release yet):", e);
  }
}
