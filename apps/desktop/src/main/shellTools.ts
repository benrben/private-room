/**
 * `arcelle.shell` — the real handlers behind `open_url` / `open_path` /
 * `reveal_item_in_dir`, over Electron's own `shell` module. The renderer-facing
 * surface is `preload/index.ts`'s `arcelle.shell`, which reproduces
 * `@tauri-apps/plugin-opener`'s `openUrl`/`openPath`/`revealItemInDir`.
 *
 * Same injected-Electron-primitive convention as `dialogTools.ts` — see that
 * file's own doc.
 *
 * ============================================================================
 * THE URL SCOPE IS A REAL SECURITY BOUNDARY, PORTED FROM THIS APP'S OWN
 * CAPABILITY FILE — NOT A DEFAULT COPIED OUT OF THE PLUGIN'S DOCS
 * ============================================================================
 * `shell.openExternal(url)` hands a string to the OS to dispatch: a scheme
 * decides which installed application is launched with it. Electron's own
 * security guidance is not to call it with content the app did not vet, and
 * Tauri did the vetting for the pre-migration build — `opener:default` validates
 * a URL against `^((mailto:\w+)|(tel:\w+)|(https?://\w+)).+` (the plugin's own
 * module doc states this), and `src-tauri/capabilities/default.json` grants
 * exactly ONE addition on top:
 *
 *     { "identifier": "opener:allow-open-url",
 *       "allow": [{ "url": "x-apple.systempreferences:*" }] }
 *
 * That addition is load-bearing, not decoration: `viewers/RecordingView.tsx`
 * opens `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`
 * to send the user to the Screen Recording pane. Shipping the plugin's default
 * regex ALONE — which one of this batch's two merge candidates did — silently
 * breaks that button the day the frontend is rewired, and the failure looks
 * like the app refusing its own help link. {@link isAllowedOpenUrl} is the
 * scope this app actually has, both halves.
 *
 * WHOEVER ADDS THE NEXT `openUrl` TARGET with a scheme outside http(s)/mailto/
 * tel edits {@link EXTRA_URL_SCHEMES} — the same edit they would have made to
 * `capabilities/default.json`. The scope is deliberately not a per-call
 * argument: in Tauri it was a build-time capability decision, and a boundary a
 * caller can widen from the renderer side is not a boundary.
 *
 * `open_path` gets NO such check, exactly as the plugin does not: its whole
 * contract is "open this file with its default app", and any URL-shaped test
 * would refuse every legitimate call.
 *
 * ============================================================================
 * `with` — THE ONE PLUGIN FEATURE ELECTRON'S `shell` CANNOT DO, BRIDGED
 * ============================================================================
 * `openUrl(url, openWith?)`/`openPath(path, openWith?)` let a caller name the
 * application to open with (the plugin's own example: `openPath('…', 'vlc')`).
 * Neither `shell.openExternal` nor `shell.openPath` takes such a parameter.
 * Rather than accept the argument and quietly ignore it — the caller asked for
 * VLC, got Preview, and nothing said so — {@link execFileOpenWithApp} shells
 * out to `/usr/bin/open -a <app> <target>`, the standard macOS mechanism for
 * exactly this, in the same fixed-path-system-binary shape `videoTools.ts`
 * (`/usr/bin/avconvert`) and `textUtil.ts` (`/usr/bin/textutil`) already use.
 * `execFile` with an argument ARRAY, never a shell string, so neither the app
 * name nor the target can be read as shell syntax. It is injected as a dep so
 * no test ever spawns a process.
 */

import { execFile } from "node:child_process";
import type { IpcMain, IpcMainInvokeEvent, Shell } from "electron";
import type { Commands } from "../shared/ipc-contract.js";

/** `opener:default`'s own validation regex — see the module doc. */
export const DEFAULT_URL_SCOPE = /^((mailto:\w+)|(tel:\w+)|(https?:\/\/\w+)).+/;

/** Every scheme `capabilities/default.json` additionally allows, as the exact
 * `scheme:` prefixes to accept. One entry today; see the module doc before
 * adding a second. */
export const EXTRA_URL_SCHEMES: readonly string[] = ["x-apple.systempreferences:"];

/** Is this URL inside the scope this app actually grants? */
export function isAllowedOpenUrl(url: string): boolean {
  if (DEFAULT_URL_SCOPE.test(url)) {
    return true;
  }
  return EXTRA_URL_SCHEMES.some((scheme) => url.startsWith(scheme) && url.length > scheme.length);
}

export interface ShellDeps {
  /** Electron's real `shell`, narrowed to what this file calls. */
  shell: Pick<Shell, "openExternal" | "openPath" | "showItemInFolder" | "trashItem">;
  /** `/usr/bin/open -a <app> <target>` — see the module doc's `with` section.
   * Production wires {@link execFileOpenWithApp}. */
  openWithApp: (app: string, target: string) => Promise<void>;
}

/** The real {@link ShellDeps.openWithApp}. REJECTS on a non-zero exit (an app
 * name macOS cannot resolve, a target `open` refuses) rather than swallowing
 * it, so the caller's `await` fails the way every other command's does. */
export function execFileOpenWithApp(
  app: string,
  target: string,
  runExecFile: typeof execFile = execFile,
): Promise<void> {
  return new Promise((resolve, reject) => {
    runExecFile("/usr/bin/open", ["-a", app, target], (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function openUrl(deps: ShellDeps, args: Commands["open_url"]["args"]): Promise<void> {
  if (typeof args.url !== "string" || args.url === "") {
    throw new Error("open_url needs a non-empty `url`.");
  }
  if (!isAllowedOpenUrl(args.url)) {
    throw new Error(
      `open_url refused "${args.url}" — outside the app's URL scope ` +
        "(http(s), mailto, tel, and the settings panes listed in shellTools.ts)."
    );
  }
  if (args.with !== undefined) {
    await deps.openWithApp(args.with, args.url);
    return;
  }
  await deps.shell.openExternal(args.url);
}

export async function openPath(deps: ShellDeps, args: Commands["open_path"]["args"]): Promise<void> {
  if (typeof args.path !== "string" || args.path === "") {
    throw new Error("open_path needs a non-empty `path`.");
  }
  if (args.with !== undefined) {
    await deps.openWithApp(args.with, args.path);
    return;
  }
  // `shell.openPath`'s own documented failure shape: it never rejects — it
  // RESOLVES with an error-message string, `""` on success. Reading that and
  // throwing is what makes this command fail like every other one (a caller
  // awaits and catches, rather than awaiting and then checking a sentinel), and
  // matches the real plugin's `openPath`, which rejects.
  const failure = await deps.shell.openPath(args.path);
  if (failure !== "") {
    throw new Error(`open_path: ${failure}`);
  }
}

function revealPaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("reveal_item_in_dir needs a non-empty `paths` array.");
  }
  return paths.map(revealPath);
}

function revealPath(target: unknown): string {
  if (typeof target !== "string" || target === "") {
    throw new Error("reveal_item_in_dir: every path must be a non-empty string.");
  }
  return target;
}

export function revealItemInDir(
  deps: ShellDeps,
  args: Commands["reveal_item_in_dir"]["args"]
): void {
  // Checked in full BEFORE revealing any of them: `showItemInFolder` is
  // synchronous and takes one path, so a bad entry halfway through a list would
  // otherwise leave the first half revealed and the call rejected.
  for (const target of revealPaths(args.paths)) {
    deps.shell.showItemInFolder(target);
  }
}

export function registerShellIpc(ipcMain: Pick<IpcMain, "handle">, deps: ShellDeps): void {
  ipcMain.handle("open_url", (_event: IpcMainInvokeEvent, args: unknown) =>
    openUrl(deps, {
      url: readString(args, "url") ?? "",
      with: readString(args, "with"),
    })
  );

  ipcMain.handle("open_path", (_event: IpcMainInvokeEvent, args: unknown) =>
    openPath(deps, {
      path: readString(args, "path") ?? "",
      with: readString(args, "with"),
    })
  );

  ipcMain.handle("reveal_item_in_dir", (_event: IpcMainInvokeEvent, args: unknown): void => {
    const raw = typeof args === "object" && args !== null ? (args as { paths?: unknown }) : {};
    revealItemInDir(deps, { paths: Array.isArray(raw.paths) ? (raw.paths as string[]) : [] });
  });
}

/** One fixed, literal key off a renderer-supplied payload — never a key the
 * payload itself chose. */
function readString(args: unknown, key: "url" | "path" | "with"): string | undefined {
  if (typeof args !== "object" || args === null) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
