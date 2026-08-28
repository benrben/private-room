/**
 * The two-pass sidecar signing + designated-requirement reseal,
 * as a pure, injectable core (no `node:child_process`, no `electron-builder`
 * types) so it can be unit-tested without ever invoking a real `codesign`.
 * `afterSign.mjs` is the thin electron-builder hook that wires this to the
 * real `execFile` and the real `@electron/notarize`.
 *
 * Deliberately plain JS, not TypeScript: electron-builder's hook loader
 * (`app-builder-lib/out/util/resolve.js` -> `resolveModule` ->
 * `dynamicImportMaybe`) does a raw dynamic `import()`/`require()` of whatever
 * path the config's `afterSign` string names -- unlike the electron-builder
 * CONFIG FILE itself, which is allowed to be `.ts` because the config loader
 * routes `.ts` through `jiti`. A hook file gets no such compile step, so it
 * has to already be runnable JS. Keeping the core logic here in plain
 * `.mjs`, exercised directly by vitest (which handles `.mjs` test files
 * natively, no build step either), avoids coupling this file's freshness to
 * `tsconfig.package.json`'s output.
 *
 * ---------------------------------------------------------------------------
 * WHY BOTH THE SIDECAR RESIGN AND THE TOP-LEVEL RESEAL RUN ON *EVERY* IDENTITY
 * KIND (ad-hoc AND a real Developer ID cert) -- this reconciles two research-doc
 * passages that read as if they disagree:
 *
 *   Section 4 ("Entitlements + hardened runtime"): "let osx-sign do its pass,
 *   THEN in afterSign re-sign ... arcelle-sidecar with sidecar-entitlements.plist,
 *   THEN re-seal the app top level ... so Contents/_CodeSignature reflects the
 *   modified nested code." No identity-kind qualifier -- this is a plain
 *   structural fact: CPython under hardened runtime needs
 *   disable-library-validation / allow-unsigned-executable-memory /
 *   allow-dyld-environment-variables regardless of who holds the signing key,
 *   and osx-sign's own pass only ever gives it `entitlementsInherit` (never the
 *   sidecar's own entitlements, on ANY identity). And once the sidecar's
 *   signature changes, the OUTER bundle seal is stale on ANY identity -- that's
 *   what "Contents/_CodeSignature reflects the modified nested code" means.
 *   `release.sh`'s own Developer-ID branch already does exactly this
 *   unconditionally (its step 2 re-signs the sidecar with sidecar-entitlements
 *   even when `$DEV_ID` is a real certificate, then its step 3 reseals).
 *
 *   Section 5 ("Signing: what electron-builder can and cannot do"): "port
 *   macsign.sh as an afterSign hook ... It must keep macsign.sh's guard
 *   verbatim: if `codesign -dv` reports a TeamIdentifier, no-op." Read next to
 *   macsign.sh itself, that guard's actual job is narrower than "skip the whole
 *   hook" -- it protects the ONE thing macsign.sh does that a real certificate
 *   makes actively harmful: stamping an explicit
 *   `--requirements '=designated => identifier "..."'` over a certificate that
 *   already carries its own cert-anchored designated requirement (which
 *   survives notarization; ours does not). macsign.sh has no sidecar-signing
 *   step at all, so "verbatim" is about the requirements-injection behaviour,
 *   not a broader claim.
 *
 * The synthesis this file implements: `resignSidecarAndReseal` ALWAYS runs the
 * sidecar re-sign and ALWAYS reseals the top level (section 4's contract, on
 * both identity kinds, matching release.sh's own Dev-ID branch) -- but the
 * reseal's FLAGS branch on `isAdHoc` (section 5's actual, narrower guard): only
 * the ad-hoc branch adds the explicit `--requirements` string and
 * `--timestamp=none`; the real-certificate branch signs plainly with
 * `--timestamp`, exactly as `release.sh`'s Developer-ID branch already does,
 * and lets the certificate supply its own (better) designated requirement.
 *
 * `isAdHoc` is derived by INTROSPECTING the already-signed bundle
 * (`codesign -dv`), the same technique macsign.sh itself uses, rather than by
 * trusting a value threaded through electron-builder's hook context -- the
 * `AfterPackContext` electron-builder hands `afterSign` carries `appOutDir` /
 * `outDir` / `arch` / `targets` / `packager` / `electronPlatformName`, not the
 * resolved identity, so re-reading the bundle's own signature is the only
 * stable source of truth for what osx-sign just did to it.
 *
 * NOTARIZATION IS DELIBERATELY *NOT* electron-builder's built-in
 * `mac.notarize` -- see `electron-builder.config.mjs` for why. This module's job
 * stops at "the app is correctly signed"; `afterSign.mjs` calls
 * `@electron/notarize` itself, AFTER `resignSidecarAndReseal` returns, so
 * notarization covers the FINAL bytes rather than the pre-reseal ones.
 */

/** `src-tauri/tauri.conf.json` `identifier`, `installBundle.ts`'s
 * `ARCELLE_BUNDLE_IDENTIFIER` -- verbatim, load-bearing for TCC/Keychain. */
export const APP_IDENTIFIER = "com.benreich.privateroom";

/** `macsign.sh:60`, ported verbatim. */
export const DESIGNATED_REQUIREMENT = `=designated => identifier "${APP_IDENTIFIER}"`;

/**
 * Parse `codesign -dv <bundle> 2>&1` output (codesign writes this to stderr,
 * so callers should merge stdout+stderr before passing it in here).
 *
 * `TeamIdentifier=` is followed by the 10-character Team ID
 * (`[A-Z0-9]+`, e.g. `ABCDE12345`) for a real certificate, or the literal
 * string `not set` for an ad-hoc signature -- `not set` starts with a
 * lowercase letter, so the same `[A-Z0-9]+`-anchored match macsign.sh's
 * `grep -q "TeamIdentifier=[A-Z0-9]"` uses also correctly rejects it here.
 *
 * `identity` is the first `Authority=` line verbatim (codesign's own
 * common-name string, e.g. `Developer ID Application: Name (TEAMID)`), which
 * `codesign --sign` accepts as an identity specifier just as readily as a
 * SHA-1 hash -- so a real-cert re-sign can reuse the exact identity osx-sign
 * already resolved without this module needing to duplicate
 * electron-builder's own keychain search. `null` when ad-hoc (no certificate
 * chain, so no `Authority=` line at all).
 */
export function parseCodesignInfo(dvOutput) {
  const teamMatch = /^TeamIdentifier=([A-Z0-9]+)$/m.exec(dvOutput);
  const authorityMatch = /^Authority=(.+)$/m.exec(dvOutput);
  const isAdHoc = teamMatch === null;
  return {
    isAdHoc,
    teamIdentifier: teamMatch ? teamMatch[1] : null,
    identity: isAdHoc ? "-" : authorityMatch ? authorityMatch[1].trim() : null,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.appPath - absolute path to the built `Arcelle.app`.
 * @param {string|null} opts.sidecarExecutablePath - absolute path to
 *   `Contents/Resources/sidecar/arcelle-sidecar/arcelle-sidecar`, or `null`
 *   when this build has no bundled sidecar (e.g. a `--dir` proof run over
 *   fixture data that omitted it) -- in which case the sidecar step is
 *   skipped rather than failing the whole hook.
 * @param {string} opts.sidecarEntitlementsPath - `services/agent-sidecar/sidecar-entitlements.plist`.
 * @param {string} opts.appEntitlementsPath - this candidate's `entitlements.mac_a.plist`.
 * @param {{path: string, entitlementsPath: string}[]} [opts.adHocHelpers] -
 *   Electron helper app bundles that arrive only linker-signed in ad-hoc
 *   builds and therefore need a real bundle resource seal.
 * @param {string[]} [opts.adHocFrameworks] - Electron framework bundles with
 *   the same linker-signature-only problem in ad-hoc builds.
 * @param {(cmd: string, args: string[]) => Promise<{stdout: string, stderr: string}>} opts.exec
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{isAdHoc: boolean, identity: string}>}
 */
export async function resignSidecarAndReseal(opts) {
  const {
    appPath,
    sidecarExecutablePath,
    sidecarEntitlementsPath,
    appEntitlementsPath,
    adHocFrameworks = [],
    adHocHelpers = [],
    exec,
    log = () => {},
  } = opts;

  // Introspect what osx-sign's OWN pass just did, rather than trust a value
  // threaded through hook context (see module doc). `codesign -dv` exits 0 on
  // a signed bundle; run it first, unconditionally, before mutating anything.
  const initial = await exec("codesign", ["-dv", appPath]);
  const { isAdHoc, identity } = parseCodesignInfo(`${initial.stdout}\n${initial.stderr}`);
  const signAs = isAdHoc ? "-" : identity;
  if (!isAdHoc && !identity) {
    throw new Error(
      `codesign -dv reported a TeamIdentifier but no Authority= line for ${appPath}; ` +
        `cannot determine which identity to re-sign the sidecar/top level with`,
    );
  }

  // electron-builder 26 + Electron 43 can leave helper .app directories with
  // only the Mach-O's linker signature. `codesign -dv` then reports
  // `Sealed Resources=none`, and the outer bundle cannot be verified strictly.
  // Seal each helper as a BUNDLE before changing the sidecar or the top level,
  // preserving osx-sign's role-specific entitlements.
  if (isAdHoc) {
    for (const frameworkPath of adHocFrameworks) {
      log(`[afterSign_a] sealing framework bundle (ad-hoc): ${frameworkPath}`);
      await exec("codesign", [
        "--force",
        "--sign",
        "-",
        "--timestamp=none",
        frameworkPath,
      ]);
    }
    for (const helper of adHocHelpers) {
      log(`[afterSign_a] sealing helper bundle (ad-hoc): ${helper.path}`);
      await exec("codesign", [
        "--force",
        "--entitlements",
        helper.entitlementsPath,
        "--sign",
        "-",
        "--timestamp=none",
        helper.path,
      ]);
    }
  }

  if (sidecarExecutablePath) {
    log(`[afterSign_a] resigning sidecar executable (${isAdHoc ? "ad-hoc" : identity}): ${sidecarExecutablePath}`);
    const sidecarArgs = [
      "--force",
      "--entitlements",
      sidecarEntitlementsPath,
      "--sign",
      signAs,
    ];
    if (!isAdHoc) sidecarArgs.splice(1, 0, "--options", "runtime");
    // Ad-hoc signatures cannot be timestamped -- the call would reach Apple's
    // TSA and, per the research doc's still-open verification item #2, either
    // fail or silently no-op; `--timestamp=none` is the documented escape and
    // costs nothing on a real certificate path either, but we only pay for a
    // real timestamp lookup when there's a real identity to anchor it to.
    sidecarArgs.push(isAdHoc ? "--timestamp=none" : "--timestamp");
    sidecarArgs.push(sidecarExecutablePath);
    await exec("codesign", sidecarArgs);
  } else {
    log(`[afterSign_a] no sidecar executable in this build -- skipping the sidecar resign step`);
  }

  log(`[afterSign_a] resealing top level (${isAdHoc ? "ad-hoc, stable DR" : identity}): ${appPath}`);
  const topArgs = [
    "--force",
    "--sign",
    signAs,
    "--identifier",
    APP_IDENTIFIER,
    "--entitlements",
    appEntitlementsPath,
  ];
  if (isAdHoc) {
    // Only the ad-hoc path gets the explicit designated requirement: a real
    // certificate already carries its own cert-anchored DR, and overwriting it
    // with this identifier-only one would be a strict downgrade (section 5).
    topArgs.push("--requirements", DESIGNATED_REQUIREMENT);
    topArgs.push("--timestamp=none");
  } else {
    topArgs.splice(5, 0, "--options", "runtime");
    topArgs.push("--timestamp");
  }
  // Deliberately NO --deep here: the nested sidecar code was just given its
  // own correct signature above, and --deep would blindly re-sign it again
  // with entitlementsInherit, undoing that. This is the same reasoning
  // macsign.sh documents at its own top-level codesign call.
  topArgs.push(appPath);
  await exec("codesign", topArgs);

  // --deep on the VERIFY (not the sign) is fine and wanted: it walks the
  // whole tree read-only and would catch a broken nested signature that would
  // otherwise only surface as macOS refusing to launch the app.
  await exec("codesign", ["--verify", "--strict", "--deep", appPath]);

  if (isAdHoc) {
    const { stdout, stderr } = await exec("codesign", ["-d", "-r-", appPath]);
    if (!`${stdout}\n${stderr}`.includes(`identifier "${APP_IDENTIFIER}"`)) {
      throw new Error(`designated requirement not embedded in ${appPath} after resealing`);
    }
  }

  return { isAdHoc, identity: signAs };
}
