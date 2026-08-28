/**
 * The electron-builder `afterSign` hook. Imported directly
 * (as a function, not a path string) by `electron-builder.config.mjs`'s top-level
 * `afterSign` field -- `afterSign` is a top-level `Configuration` key, not a
 * `mac`-specific one; see that file's own comment for how running the
 * config found that the hard way. electron-builder only
 * invokes this when `signApp` actually signed something (`didSign === true`)
 * -- see `app-builder-lib/out/platformPackager.js`'s `doSignAfterPack`, which
 * skips `emitAfterSign` entirely and logs a warning instead when no identity
 * was found. In THIS sandbox (`security find-identity -v -p codesigning`
 * reports 0 valid identities) that means this file's body does not run in an
 * unsigned proof build -- the proof for its
 * LOGIC is `afterSignCore_a.test.mjs`, which exercises every branch with a
 * scripted fake `exec` and asserts exact command shape, never touching a real
 * `codesign`.
 *
 * ---------------------------------------------------------------------------
 * WHY NOTARIZATION HAPPENS *HERE*, NOT VIA `mac.notarize`
 *
 * electron-builder's built-in notarize integration runs INSIDE the same
 * `sign()` call that does osx-sign's initial full-tree pass -- see
 * `macPackager.js`'s `signApp` -> `this.sign(...)` -> `doSign` (osx-sign) ->
 * `this.helper.notarizeIfProvided(appPath)`, all before `signApp` returns.
 * `doSignAfterPack` then calls `emitAfterSign` (this file) only AFTER
 * `signApp` -- i.e. strictly after electron-builder's own notarization would
 * already have happened. If `mac.notarize` were left to electron-builder,
 * Apple would notarize the PRE-reseal bytes (sidecar still carrying only
 * `entitlementsInherit`, outer signature not yet stamped with the stable
 * designated requirement), and then `resignSidecarAndReseal` below would
 * change the signed bytes again -- invalidating whatever ticket Apple issued,
 * the same way signing after packaging is already known to break things
 * (`release.sh`'s own rule 3, "never sign after packaging", is the same
 * hazard one layer up). So `electron-builder.config.mjs` sets `mac.notarize:
 * false`, and notarization is called manually below, AFTER the reseal, over
 * the bundle's FINAL bytes -- mirroring `release.sh`'s own order (sign ->
 * resign sidecar -> reseal top level -> notarize -> staple).
 *
 * `@electron/notarize`'s `notarize()` staples internally on success (its own
 * doc comment: "sends your app to Apple for notarization ... and staples a
 * successful notarization result"), so there is no separate
 * `xcrun stapler staple` call needed here the way `release.sh` has to do it
 * by hand.
 *
 * Never runs for an ad-hoc build: Apple does not notarize ad-hoc-signed
 * software, and none of the credential env vars below would plausibly be set
 * on a machine doing an ad-hoc dev build anyway.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resignSidecarAndReseal } from "./afterSignCore.mjs";

const execFileAsync = promisify(execFile);
const requireFromHook = createRequire(import.meta.url);

/** Resolve osx-sign through Node's package resolver so this works with both
 * app-local dependencies and a root-hoisted npm workspace installation. */
export function resolveOsxSignEntitlementsDirectory(
  resolvePackage = requireFromHook.resolve,
) {
  const packageJson = resolvePackage("@electron/osx-sign/package.json");
  return path.join(path.dirname(packageJson), "entitlements");
}

async function realExec(cmd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (e) {
    // execFile rejects with stdout/stderr attached to the error on a non-zero
    // exit; surface both so a codesign failure's actual diagnostic (not just
    // "Command failed") reaches electron-builder's own log.
    const err = /** @type {{stdout?: string, stderr?: string}} */ (e);
    throw new Error(
      `${cmd} ${args.join(" ")} failed: ${err.stderr || err.stdout || (e instanceof Error ? e.message : String(e))}`,
    );
  }
}

/** Build `NotaryToolCredentials` from environment, or `null` if nothing
 * usable is set (in which case notarization is skipped with a warning,
 * mirroring `release.sh`'s own "not notarized" branch rather than failing the
 * whole package step over it). Checked in the same preference order
 * `@electron/notarize`'s own docs list its three strategies. */
function credentialsFromEnv(env) {
  // Compatibility shim: RELEASING.md / release.sh call this var
  // APPLE_NOTARY_PROFILE (it is the `xcrun notarytool store-credentials`
  // profile name); @electron/notarize's own field is `keychainProfile`, read
  // here from APPLE_KEYCHAIN_PROFILE first (electron-builder's own
  // convention) and falling back to the existing RELEASING.md name so today's
  // documented setup keeps working without RELEASING.md itself needing an
  // edit in this batch.
  const keychainProfile = env.APPLE_KEYCHAIN_PROFILE || env.APPLE_NOTARY_PROFILE;
  if (keychainProfile) {
    return { keychainProfile, ...(env.APPLE_KEYCHAIN ? { keychain: env.APPLE_KEYCHAIN } : {}) };
  }
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    return {
      appleId: env.APPLE_ID,
      appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: env.APPLE_TEAM_ID,
    };
  }
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
    return {
      appleApiKey: env.APPLE_API_KEY,
      appleApiKeyId: env.APPLE_API_KEY_ID,
      appleApiIssuer: env.APPLE_API_ISSUER,
    };
  }
  return null;
}

/** @param {import("electron-builder").AfterPackContext} context */
export default async function afterSign(context) {
  // electron-builder may emit afterSign even when identity:null caused its
  // own signing pass to do nothing. Proof builds must never turn that into an
  // accidental ad-hoc signing pass here.
  if (process.env.ARCELLE_PACKAGE_UNSIGNED_PROOF === "1") {
    console.log("[afterSign] unsigned proof mode — skipping codesign and notarization");
    return;
  }
  if (context.electronPlatformName !== "darwin") return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const sidecarExecutablePath = path.join(
    appPath,
    "Contents",
    "Resources",
    "sidecar",
    "arcelle-sidecar",
    "arcelle-sidecar",
  );
  const hasSidecar = await fs
    .access(sidecarExecutablePath)
    .then(() => true)
    .catch(() => false);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const appEntitlementsPath = path.join(here, "entitlements.mac.plist");
  const osxSignEntitlements = resolveOsxSignEntitlementsDirectory();
  const helperSpecs = [
    ["", "default.darwin.plist"],
    [" (GPU)", "default.darwin.gpu.plist"],
    [" (Plugin)", "default.darwin.plugin.plist"],
    [" (Renderer)", "default.darwin.renderer.plist"],
  ];
  const adHocHelpers = [];
  for (const [suffix, entitlements] of helperSpecs) {
    const helperPath = path.join(appPath, "Contents", "Frameworks", `${context.packager.appInfo.productFilename} Helper${suffix}.app`);
    if (await fs.access(helperPath).then(() => true).catch(() => false)) {
      adHocHelpers.push({ path: helperPath, entitlementsPath: path.join(osxSignEntitlements, entitlements) });
    }
  }
  const adHocFrameworks = [];
  for (const name of [
    "Electron Framework.framework",
    "Mantle.framework",
    "ReactiveObjC.framework",
    "Squirrel.framework",
  ]) {
    const frameworkPath = path.join(appPath, "Contents", "Frameworks", name);
    if (await fs.access(frameworkPath).then(() => true).catch(() => false)) {
      adHocFrameworks.push(frameworkPath);
    }
  }
  // services/agent-sidecar/sidecar-entitlements.plist is committed and load-bearing.
  // source -- read-only reference, never copied or edited by this candidate.
  const sidecarEntitlementsPath = path.resolve(
    here,
    "..",
    "..",
    "..",
    "services",
    "agent-sidecar",
    "sidecar-entitlements.plist",
  );

  const { isAdHoc } = await resignSidecarAndReseal({
    appPath,
    sidecarExecutablePath: hasSidecar ? sidecarExecutablePath : null,
    sidecarEntitlementsPath,
    appEntitlementsPath,
    adHocFrameworks,
    adHocHelpers,
    exec: realExec,
    log: (msg) => console.log(msg),
  });

  if (isAdHoc) {
    console.log("[afterSign_a] ad-hoc signature -- Apple does not notarize ad-hoc builds, skipping notarization.");
    return;
  }

  const credentials = credentialsFromEnv(process.env);
  if (!credentials) {
    console.warn(
      "[afterSign_a] signed with a real identity but no notarization credentials found in the environment " +
        "(APPLE_KEYCHAIN_PROFILE / APPLE_NOTARY_PROFILE, or APPLE_ID+APPLE_APP_SPECIFIC_PASSWORD+APPLE_TEAM_ID, " +
        "or APPLE_API_KEY+APPLE_API_KEY_ID+APPLE_API_ISSUER) -- signed but NOT notarized. Gatekeeper will warn on " +
        "first download. Set one of those up (see RELEASING.md) and re-run to notarize.",
    );
    return;
  }

  console.log("[afterSign_a] notarizing (this can take several minutes)...");
  const { notarize } = await import("@electron/notarize");
  await notarize({ appPath, ...credentials });
  console.log("[afterSign_a] notarized and stapled.");
}
