import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { confirm } from "@tauri-apps/plugin-dialog";

/**
 * Quietly check GitHub Releases for a newer signed build on launch.
 *
 * Fire-and-forget: call once after mount. All failures are swallowed on
 * purpose — until a real updater `pubkey` + `endpoints` are configured in
 * tauri.conf.json (see RELEASING.md), `check()` no-ops or errors, and the
 * app must not surface anything to the user.
 */
export async function checkForUpdatesQuietly(): Promise<void> {
  try {
    const update = await check();
    if (!update) return;

    const ok = await confirm(
      `Version ${update.version} is available.\n\nInstall it now and relaunch Private Room?`,
      { title: "Update available — Install & relaunch", kind: "info" },
    );
    if (!ok) return;

    await update.downloadAndInstall();
    await relaunch();
  } catch {
    // Placeholder endpoint / no update / offline — stay silent.
  }
}
