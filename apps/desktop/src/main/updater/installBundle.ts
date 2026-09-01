/**
 * Install-time mechanics for the Tauri-compatible bridge updater: turning a
 * VERIFIED `Arcelle.app.tar.gz` into a running app. Ported behaviourally from
 * `tauri-plugin-updater` 2.10.1's `install_inner` (`updater.rs:1217-1310`), its
 * `extract_path` derivation (`updater.rs:1353-1381`), and `tauri` 2.11.5's
 * `restart_macos_app` (`process.rs:92-130`).
 *
 * Nothing in this file may run on unverified bytes. `tauriUpdater.ts` is the
 * only supported way to produce a payload for it, and that path cannot reach
 * here without `minisignVerify.ts` having accepted the download first.
 *
 * Every filesystem and process operation is an injected dependency
 * ({@link InstallDeps}) rather than a direct call, so the DECISIONS — where to
 * extract, when to escalate privileges, what to spawn on relaunch, and how to
 * put the old bundle back when something fails halfway — are unit-testable
 * without touching `/Applications` or shelling out.
 * {@link defaultInstallDeps} wires the real implementations.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { isUpdateAvailable } from "./updateManifest.js";

/**
 * The ONLY app this updater will install, from `src-tauri/tauri.conf.json`'s
 * `identifier` — deliberately unchanged across the Electron migration so the
 * bridge release keeps the same bundle identity (and with it the TCC grants and
 * Keychain items) as the Tauri build it replaces.
 *
 * It is checked against the Info.plist INSIDE the downloaded payload, which is
 * covered by the minisign signature. The manifest is not.
 */
export const ARCELLE_BUNDLE_IDENTIFIER = "com.benreich.privateroom";

export class InstallError extends Error {
  constructor(
    public readonly code:
      | "not_a_mac_app_bundle"
      | "extract_failed"
      | "extract_produced_no_bundle"
      | "permission_denied"
      | "cross_device"
      | "install_failed"
      | "plist_read_failed"
      | "bundle_identity_rejected",
    message: string,
    /** Set only for `permission_denied` — the exact AppleScript the real plugin
     * runs when moving the current app aside fails with `PermissionDenied`.
     * Handed back rather than executed so the UI layer decides when to prompt,
     * instead of this library popping an admin dialog mid-call. */
    public readonly privilegedMoveScript?: string,
  ) {
    super(message);
    this.name = "InstallError";
  }
}

/**
 * Derive `/Applications/Arcelle.app` from the RUNNING process's own executable
 * path — the same relationship `current_exe()` + "strip `Contents/MacOS`" gives
 * the real client.
 *
 * Deliberately independent of the executable's NAME. The shipped Tauri binary
 * is `arcelle` (lowercase, from `Cargo.toml`'s `name`) while the Electron
 * bundle's is `Arcelle`; only the directory SHAPE
 * (`X.app/Contents/MacOS/<anything>`) is checked, so the rename crosses over
 * cleanly.
 */
export function deriveAppBundlePath(execPath: string): string {
  const macOsDir = path.dirname(execPath);
  const contentsDir = path.dirname(macOsDir);
  const bundleDir = path.dirname(contentsDir);
  if (
    path.basename(macOsDir) !== "MacOS" ||
    path.basename(contentsDir) !== "Contents" ||
    !bundleDir.toLowerCase().endsWith(".app")
  ) {
    throw new InstallError(
      "not_a_mac_app_bundle",
      `execPath does not look like a macOS .app bundle executable (expected .../X.app/Contents/MacOS/exe): ${execPath}`,
    );
  }
  return bundleDir;
}

/** The slice of Node's process-spawning surface this module needs: one
 * run-to-completion call and one fire-and-forget detached spawn. Kept small so
 * a test double stays honest about what it stands in for. */
export interface ProcessRunner {
  /** Run to completion; resolve with trimmed stdout, reject with an Error
   * carrying stderr on a non-zero exit. */
  run(command: string, args: string[]): Promise<string>;
  /** Start detached (surviving this process's exit) and return immediately. */
  spawnDetached(command: string, args: string[]): void;
}

export interface FsOps {
  mkdtemp(prefix: string): Promise<string>;
  rm(targetPath: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  pathExists(targetPath: string): Promise<boolean>;
  /** Bump mtime, matching `install_inner`'s closing `touch` — it nudges Launch
   * Services to re-read the replaced bundle. Failure is ignored there and here. */
  touch(targetPath: string): Promise<void>;
}

export interface InstallDeps {
  fs: FsOps;
  proc: ProcessRunner;
  /** Called by {@link installAndRelaunch} right after the replacement instance
   * has been spawned. Production wires this to Electron's `app.quit()`; without
   * it the old process keeps running alongside the new one. */
  quit?: () => void;
}

/** Real production wiring. Kept as a factory rather than module-level imports
 * of `node:fs` so every test constructs its own fakes instead of this module
 * reaching around them. */
export function defaultInstallDeps(quit?: () => void): InstallDeps {
  return {
    quit,
    fs: {
      async mkdtemp(prefix) {
        const { mkdtemp } = await import("node:fs/promises");
        const os = await import("node:os");
        return mkdtemp(path.join(os.tmpdir(), prefix));
      },
      async rm(targetPath, options) {
        const { rm } = await import("node:fs/promises");
        await rm(targetPath, options);
      },
      async rename(from, to) {
        const { rename } = await import("node:fs/promises");
        await rename(from, to);
      },
      async pathExists(targetPath) {
        const { access } = await import("node:fs/promises");
        try {
          await access(targetPath);
          return true;
        } catch {
          return false;
        }
      },
      async touch(targetPath) {
        const { utimes } = await import("node:fs/promises");
        const now = new Date();
        await utimes(targetPath, now, now);
      },
    },
    proc: {
      run(command, args) {
        return new Promise((resolve, reject) => {
          const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
          let stdout = "";
          let stderr = "";
          child.stdout?.on("data", (d) => (stdout += d.toString("utf8")));
          child.stderr?.on("data", (d) => (stderr += d.toString("utf8")));
          child.on("error", reject);
          child.on("close", (code) => {
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
          });
        });
      },
      spawnDetached(command, args) {
        const child = spawn(command, args, { detached: true, stdio: "ignore" });
        child.unref();
      },
    },
  };
}

function errnoOf(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e
    ? (e as NodeJS.ErrnoException).code
    : undefined;
}

function isPermissionError(e: unknown): boolean {
  const code = errnoOf(e);
  return code === "EACCES" || code === "EPERM";
}

/**
 * Extract `tarGzPath` into a fresh temp directory, dropping the archive's
 * single top-level path component — the shell analogue of the real client's
 * per-entry `entry.path()?.iter().skip(1).collect()`.
 *
 * Uses the system `bsdtar` at `/usr/bin/tar` rather than a hand-rolled tar
 * reader. That is deliberate: the payload is ~640MB, and the OS extractor
 * streams it while preserving the permission bits, symlinks and hard links a
 * codesigned `.app` depends on — where an in-process reader would hold the
 * whole decompressed bundle in memory and have to re-implement every one of
 * those cases correctly to avoid producing a bundle that no longer validates.
 *
 * `--strip-components=1` also SKIPS entries that reduce to an empty path, so an
 * AppleDouble `._Arcelle.app` sibling (what bsdtar writes when the release
 * script forgets `COPYFILE_DISABLE=1`) is dropped here rather than being
 * unpacked over the extraction root the way Tauri's own extractor does. That is
 * a happier failure than Tauri's, but it is NOT a licence to drop
 * `COPYFILE_DISABLE=1` from packaging: a Tauri client extracting the same
 * archive still dies on it. The post-condition below is what actually
 * establishes we got an app bundle rather than something shaped like one.
 */
export async function extractTarGz(
  deps: InstallDeps,
  tarGzPath: string,
  tarBinary = "/usr/bin/tar",
): Promise<string> {
  const destDir = await deps.fs.mkdtemp("arcelle-update-");
  try {
    await deps.proc.run(tarBinary, ["-xzf", tarGzPath, "-C", destDir, "--strip-components=1"]);
  } catch (e) {
    await discard(deps, destDir);
    throw new InstallError("extract_failed", `tar extraction failed: ${(e as Error).message}`);
  }
  // A real macOS app bundle always has Contents/MacOS. Checking for it (rather
  // than merely "the directory is non-empty") is what catches an archive whose
  // top-level shape is wrong -- one built with an extra wrapping directory, or
  // one whose only top-level member was AppleDouble noise that got skipped.
  if (!(await deps.fs.pathExists(path.join(destDir, "Contents", "MacOS")))) {
    await discard(deps, destDir);
    throw new InstallError(
      "extract_produced_no_bundle",
      `${tarGzPath} did not extract to a macOS app bundle: no Contents/MacOS after stripping the ` +
        `archive's top-level directory. The payload must be a gzipped tar with EXACTLY one ` +
        `top-level directory (the .app), packed with COPYFILE_DISABLE=1.`,
    );
  }
  return destDir;
}

async function discard(deps: InstallDeps, dir: string): Promise<void> {
  try {
    await deps.fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of our own temp dir; never mask the real failure.
  }
}

function currentBundleMoveFailure(error: unknown, extractedDir: string, appBundlePath: string): InstallError {
  if (isPermissionError(error)) {
    return new InstallError(
      "permission_denied",
      `cannot replace ${appBundlePath} without elevated privileges`,
      buildPrivilegedMoveScript(extractedDir, appBundlePath),
    );
  }
  return new InstallError(
    "install_failed",
    `could not move the current app aside: ${(error as Error).message}`,
  );
}

async function moveCurrentBundleAside(
  deps: InstallDeps,
  extractedDir: string,
  appBundlePath: string,
  backupPath: string,
  backupParent: string,
): Promise<boolean> {
  if (!(await deps.fs.pathExists(appBundlePath))) return false;
  try {
    await deps.fs.rename(appBundlePath, backupPath);
    return true;
  } catch (error) {
    await discard(deps, backupParent);
    throw currentBundleMoveFailure(error, extractedDir, appBundlePath);
  }
}

async function installFailureOutcome(
  deps: InstallDeps,
  movedAside: boolean,
  backupPath: string,
  appBundlePath: string,
  backupParent: string,
): Promise<string> {
  if (!movedAside) {
    await discard(deps, backupParent);
    return "";
  }
  try {
    await deps.fs.rename(backupPath, appBundlePath);
    await discard(deps, backupParent);
    return " The previous version was restored.";
  } catch {
    // Deliberately NOT discarded: it now holds the only copy of the app.
    return ` The previous version is at ${backupPath}.`;
  }
}

function newBundleMoveFailure(error: unknown, appBundlePath: string, outcome: string): InstallError {
  return new InstallError(
    errnoOf(error) === "EXDEV" ? "cross_device" : "install_failed",
    `could not move the new app into ${appBundlePath}: ${(error as Error).message}.${outcome}`,
  );
}

/**
 * Move an extracted bundle into place at `appBundlePath`.
 *
 * The ORDER here is load-bearing and copied from `install_inner`: the current
 * app is RENAMED ASIDE into a temp backup first, and only then is the new
 * bundle renamed into the vacated path. Two things fall out of that:
 *
 *  - the rename doubles as the permission probe. It fails cleanly with
 *    `EPERM`/`EACCES` having changed nothing, which is when the real plugin
 *    escalates to `do shell script … with administrator privileges`.
 *  - there is no window in which the old app has been deleted and the new one
 *    is not yet in place. Deleting first and renaming second — which is what a
 *    naive `rm -rf && mv` does — leaves a user with NO app if the second step
 *    fails. If the second rename fails here, the backup is renamed back.
 *
 * The backup is discarded only after the new bundle is in place.
 */
export async function installExtractedBundle(
  deps: InstallDeps,
  extractedDir: string,
  appBundlePath: string,
): Promise<void> {
  const backupParent = await deps.fs.mkdtemp("arcelle-update-backup-");
  const backupPath = path.join(backupParent, "current_app");

  const movedAside = await moveCurrentBundleAside(
    deps,
    extractedDir,
    appBundlePath,
    backupPath,
    backupParent,
  );

  try {
    await deps.fs.rename(extractedDir, appBundlePath);
  } catch (error) {
    const outcome = await installFailureOutcome(deps, movedAside, backupPath, appBundlePath, backupParent);
    throw newBundleMoveFailure(error, appBundlePath, outcome);
  }

  try {
    await deps.fs.touch(appBundlePath);
  } catch {
    // `install_inner` ignores the result of its own `touch` too.
  }
  await discard(deps, backupParent);
}

/**
 * The AppleScript the real plugin runs when moving the current app aside hits
 * `PermissionDenied`. Both paths are shell-quoted and then AppleScript-quoted,
 * because the string is a shell command nested inside an AppleScript string
 * literal — two layers, each with its own escaping. The paths come from
 * OS-derived locations (an `mkdtemp` result, `/Applications/Arcelle.app`) and
 * never from the manifest, but quoting costs nothing.
 */
export function buildPrivilegedMoveScript(extractedDir: string, appBundlePath: string): string {
  const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const appleScriptQuote = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const shellCmd = `rm -rf ${shellQuote(appBundlePath)} && mv -f ${shellQuote(extractedDir)} ${shellQuote(appBundlePath)}`;
  return `do shell script "${appleScriptQuote(shellCmd)}" with administrator privileges`;
}

/**
 * Read `CFBundleExecutable` from the NEWLY INSTALLED bundle's `Info.plist` via
 * `/usr/bin/plutil` (ships on every Mac, so no plist dependency).
 *
 * This is the single riskiest line in the bridge. `restart_macos_app` re-reads
 * this exact field from the new bundle before spawning it, which is what makes
 * the `arcelle` → `Arcelle` executable rename survive the cutover — but only if
 * the Electron bundle's `CFBundleExecutable` matches the real file under
 * `Contents/MacOS/`. Reading it fresh here (rather than reusing the running
 * process's own executable name) is what keeps this side honest too.
 */
export async function readInfoPlistString(
  deps: InstallDeps,
  appBundlePath: string,
  key: string,
  plutilBinary = "/usr/bin/plutil",
): Promise<string> {
  const infoPlist = path.join(appBundlePath, "Contents", "Info.plist");
  let value: string;
  try {
    const out = await deps.proc.run(plutilBinary, ["-extract", key, "raw", "-o", "-", infoPlist]);
    value = out.trim();
  } catch (e) {
    // A MISSING key exits non-zero here, and that is a rejection rather than a
    // shrug: every key this module reads is one the payload must prove about
    // itself, so "the payload declined to say" cannot mean "go ahead".
    throw new InstallError(
      "plist_read_failed",
      `could not read ${key} from ${infoPlist}: ${(e as Error).message}`,
    );
  }
  if (value.length === 0) {
    throw new InstallError("plist_read_failed", `${infoPlist} has an empty ${key}`);
  }
  return value;
}

export async function readCFBundleExecutable(
  deps: InstallDeps,
  appBundlePath: string,
  plutilBinary = "/usr/bin/plutil",
): Promise<string> {
  const infoPlist = path.join(appBundlePath, "Contents", "Info.plist");
  const name = await readInfoPlistString(deps, appBundlePath, "CFBundleExecutable", plutilBinary);
  // The value names a file inside Contents/MacOS; a path separator would make it
  // name something else entirely.
  if (name.includes("/") || name === "." || name === "..") {
    throw new InstallError(
      "plist_read_failed",
      `${infoPlist} has a CFBundleExecutable that is not a plain file name: ${JSON.stringify(name)}`,
    );
  }
  return name;
}

/** What the payload must prove about itself before it is allowed to replace the
 * running app. */
export interface BundleIdentityPolicy {
  /** The version this process is currently running, e.g. `app.getVersion()`.
   * The extracted bundle's own version must be strictly greater. */
  currentVersion: string;
  /** Defaults to {@link ARCELLE_BUNDLE_IDENTIFIER}. */
  expectedIdentifier?: string;
  plutilBinary?: string;
}

/**
 * Gate an EXTRACTED bundle on the identity it declares in its own `Info.plist`,
 * before anything is moved into place.
 *
 * ## Why this exists — the manifest is not authenticated
 *
 * `latest.json` is fetched over TLS and nothing more; no field in it is covered
 * by any signature. Only the payload BYTES are signed. So the manifest's
 * `version` is an unauthenticated claim, and two attacks follow that every check
 * upstream of this one passes:
 *
 *  1. **Downgrade by replay.** Anyone who can influence the manifest — a
 *     tampered response, a rolled-back or compromised release — can pair
 *     `"version": "9.9.9"` with the URL of a GENUINELY SIGNED OLD release. The
 *     minisign check succeeds, because that payload really was signed by the
 *     real key. The user is silently rolled back onto a build whose known bugs
 *     were since fixed. No private key is needed for this.
 *  2. **A different app entirely.** Nothing else in the flow ties the payload to
 *     Arcelle. The signed trusted comment happens to carry
 *     `file:Arcelle.app.tar.gz`, but neither `tauri-plugin-updater` nor this
 *     port compares that name to anything, so it binds nothing.
 *
 * The fix is to move the decision onto evidence that IS signed. `Info.plist`
 * lives inside the tarball, so `CFBundleIdentifier` and
 * `CFBundleShortVersionString` are covered by the same signature that
 * authenticates the payload — they are the artifact's own statement of what it
 * is, not the manifest's claim about it. Requiring the SIGNED version to beat
 * the running version is what closes the replay hole; requiring the SIGNED
 * identifier to match is what stops a mis-published or substituted artifact from
 * being installed as Arcelle.
 *
 * This is purely client-side and changes nothing about what a release publishes,
 * so it cannot desynchronise the bridge: a legacy Tauri client is unaffected,
 * and every real Arcelle release satisfies both conditions by construction.
 *
 * Note this is NOT a defence against a compromised signing key — someone holding
 * the key can sign an artifact with any identifier and version they like. It
 * closes the downgrade hole, which needs no key at all, and it catches a
 * release-process mistake that ships the wrong artifact.
 */
export async function assertBundleIdentity(
  deps: InstallDeps,
  bundlePath: string,
  policy: BundleIdentityPolicy,
): Promise<{ identifier: string; version: string }> {
  const expected = policy.expectedIdentifier ?? ARCELLE_BUNDLE_IDENTIFIER;
  const identifier = await readInfoPlistString(
    deps,
    bundlePath,
    "CFBundleIdentifier",
    policy.plutilBinary,
  );
  if (identifier !== expected) {
    throw new InstallError(
      "bundle_identity_rejected",
      `refusing to install: the signed payload declares CFBundleIdentifier ` +
        `${JSON.stringify(identifier)}, expected ${JSON.stringify(expected)}`,
    );
  }

  const version = await readInfoPlistString(
    deps,
    bundlePath,
    "CFBundleShortVersionString",
    policy.plutilBinary,
  );
  // Reuses the manifest's own comparison so there is ONE definition of "newer"
  // in this codebase rather than two that can drift apart.
  let newer: boolean;
  try {
    newer = isUpdateAvailable(version, policy.currentVersion);
  } catch (e) {
    throw new InstallError(
      "bundle_identity_rejected",
      `refusing to install: the signed payload's CFBundleShortVersionString ` +
        `${JSON.stringify(version)} is not comparable to the running version ` +
        `${JSON.stringify(policy.currentVersion)}: ${(e as Error).message}`,
    );
  }
  if (!newer) {
    throw new InstallError(
      "bundle_identity_rejected",
      `refusing to install: the signed payload is version ${JSON.stringify(version)}, ` +
        `which is not newer than the running ${JSON.stringify(policy.currentVersion)}. ` +
        `The manifest's version claim is NOT signed, so a valid signature over an old ` +
        `release can be replayed under a manifest claiming a new one.`,
    );
  }
  return { identifier, version };
}

/**
 * Spawn `appBundlePath/Contents/MacOS/<CFBundleExecutable>` detached, mirroring
 * `restart_macos_app`'s own spawn-and-exit shape rather than `open -a`, which
 * goes through Launch Services and can serve a cached bundle-info lookup for an
 * app that was just replaced on disk.
 */
export function relaunchApp(deps: InstallDeps, appBundlePath: string, executableName: string): void {
  deps.proc.spawnDetached(path.join(appBundlePath, "Contents", "MacOS", executableName), []);
}

/**
 * Full install orchestration: extract → CHECK THE SIGNED BUNDLE'S IDENTITY →
 * move into place → read the NEW bundle's executable name → relaunch → quit
 * this instance.
 *
 * The identity check runs against the EXTRACTED directory, before
 * `installExtractedBundle` touches anything, so a rejected payload leaves the
 * running app exactly where it was — only a temp directory is discarded.
 *
 * `policy` is required rather than optional on purpose: an optional policy would
 * default to "no check", and every caller that forgot it would silently lose the
 * downgrade protection while still looking correct at the call site.
 *
 * The steps are exported individually so a caller that wants to confirm with
 * the user between "installed" and "relaunching" can drive them itself — such a
 * caller MUST still run {@link assertBundleIdentity} before installing.
 */
export async function installAndRelaunch(
  deps: InstallDeps,
  tarGzPath: string,
  execPath: string,
  policy: BundleIdentityPolicy,
): Promise<void> {
  const appBundlePath = deriveAppBundlePath(execPath);
  const extractedDir = await extractTarGz(deps, tarGzPath);
  try {
    await assertBundleIdentity(deps, extractedDir, policy);
  } catch (e) {
    await discard(deps, extractedDir);
    throw e;
  }
  await installExtractedBundle(deps, extractedDir, appBundlePath);
  const executableName = await readCFBundleExecutable(deps, appBundlePath);
  relaunchApp(deps, appBundlePath, executableName);
  deps.quit?.();
}
