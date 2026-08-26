/**
 * Electron-builder configuration for local proofs and release packaging.
 * Use scripts/package.sh (or the package:dir/package:mac npm scripts) so the
 * native SQLCipher addon is rebuilt and verified against Electron's ABI.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import afterSign from "./scripts/afterSign.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)); // electron-migration/electron-app/
const repoRoot = path.resolve(here, "..", ".."); // repo root

/**
 * `envVarName` (real path to real staged data) wins when set; otherwise
 * falls back to small fixture data under `scripts/fixtures_a/`
 * and WARNS loudly that this is not a real bundle. This is what makes the
 * exact same config usable for a real future package build (point the env
 * vars at real artifacts) and for this batch's safety-rule-compliant
 * structural proof (small, obviously-fake fixture files, no 615MB download,
 * no `build-sidecar.sh` run needed).
 */
function resolveResourceDir(envVarName, fallbackFixtureRelPath, label) {
  const override = process.env[envVarName];
  if (override) return path.resolve(override);
  const fixture = path.join(here, fallbackFixtureRelPath);
  if (!existsSync(fixture)) {
    throw new Error(
      `electron-builder.config.mjs: ${label} -- neither $${envVarName} nor the fallback fixture ` +
        `(${fixture}) exists. Set ${envVarName} to a real staged directory, or restore the fixture.`,
    );
  }
  console.warn(
    `[electron-builder] $${envVarName} not set -- bundling FIXTURE data (${fixture}) for ` +
      `${label}. This is NOT a real release artifact. Set ${envVarName} for an actual package build.`,
  );
  return fixture;
}

const modelsDir = resolveResourceDir(
  "ARCELLE_MODELS_DIR",
  "scripts/fixtures_a/models",
  "bundled Whisper/TitaNet/Silero model weights (research doc section 2)",
);
const sidecarStageDir = resolveResourceDir(
  "ARCELLE_SIDECAR_STAGE_DIR",
  "scripts/fixtures_a/sidecar/arcelle-sidecar",
  "the built Python agent sidecar (PyInstaller onedir; sidecar/build-sidecar.sh's real output, out of this batch's scope)",
);

// Real, committed source-of-record assets -- READ-ONLY references (never
// copied, never edited) in this Electron package's assets/icons directory.
// not forbid reading. `document.icns` is required by both
// UTExportedTypeDeclarations and CFBundleDocumentTypes below, and shipped via
// extraResources per the research doc section 2's
// `Contents/Resources/document.icns` requirement.
const documentIcns = path.join(here, "assets", "icons", "document.icns");
const appIcon = path.join(here, "assets", "icons", "icon.icns");
for (const [label, p] of [
  ["document.icns", documentIcns],
  ["icon.icns", appIcon],
]) {
  if (!existsSync(p)) throw new Error(`electron-builder.config.mjs: expected ${label} at ${p}, not found`);
}

/**
 * electron-builder's own ad-hoc support (`mac.identity: "-"`) is real and
 * documented (macOptions.d.ts, confirmed against 26.15.3's own typings) --
 * but this batch's safety rules forbid this session from actually invoking
 * ANY codesign, ad-hoc included. Left UNSET (the default), electron-builder
 * searches the keychain for a real certificate and, finding none, SKIPS
 * signing entirely rather than falling back to ad-hoc automatically (its own
 * doc comment: "there is no automatic ad-hoc fallback") -- confirmed empty in
 * THIS sandbox via `security find-identity -v -p codesigning` (0 valid
 * identities) before this file's own `--dir` proof was run. So the default
 * here is the safe one for both this session AND a real future run on a
 * clean keychain. `ARCELLE_MAC_IDENTITY=-` opts a REAL future release
 * machine into ad-hoc explicitly (never set by anything in this batch).
 */
const wantsAdHoc = process.env.ARCELLE_MAC_IDENTITY === "-";
const unsignedProof = process.env.ARCELLE_PACKAGE_UNSIGNED_PROOF === "1";

/**
 * `src-tauri/Info.plist`'s two non-generated dict entries, ported verbatim
 * (see research doc section 3). electron-builder generates
 * `CFBundleIdentifier` / `CFBundleName` / `CFBundleDisplayName` /
 * `CFBundleExecutable` / `CFBundleIconFile` / `LSMinimumSystemVersion` /
 * `CFBundleShortVersionString` / `CFBundleVersion` itself
 * (`macPackager.js:354-405`) -- nothing below duplicates those.
 *
 * Deliberately does NOT use `mac.fileAssociations`: it *appends* to
 * `CFBundleDocumentTypes` rather than replacing it
 * (`electronMac.js:158-180`), so using both it and an `extendInfo`
 * `CFBundleDocumentTypes` would publish TWO document-type entries. This is
 * the single source for `CFBundleDocumentTypes`, matching the research doc's
 * explicit recommendation.
 */
const extendInfo = {
  // src-tauri/Info.plist:12, byte-for-byte -- this sentence is what the user
  // reads before granting mic access, and it has to match what the app
  // actually does (Whisper on-device; only TEXT, and only with a cloud
  // engine chosen, ever leaves the Mac).
  NSMicrophoneUsageDescription:
    "Arcelle uses the microphone to record meetings and for voice messages and dictation. Audio is transcribed on this Mac and the recording itself never leaves it; only text, and only if you choose a cloud AI engine, is ever sent anywhere.",

  // NEW for this migration (research doc section 3, item 2). The Tauri build
  // never declared this: WKWebView's getDisplayMedia ran through the WebKit
  // host process, not this app's own process. Electron's loopback-audio
  // capture (electron/renderer/loopbackTap.ts) rides the Screen & System
  // Audio Recording TCC grant on OUR process, so without this string the
  // permission prompt is malformed or suppressed outright.
  NSScreenCaptureUsageDescription:
    "Arcelle uses screen & system audio recording to capture the audio of other apps (like a video call) during meeting recording. Only audio is captured, and it is transcribed on this Mac; the recording itself never leaves this Mac unless you export it yourself.",

  // src-tauri/Info.plist:23-45, byte-for-byte. Modern Launch Services
  // matches documents by UTI, not extension; without this exported
  // declaration the Finder icon / "Open With" for .arcelle/.roomai files is
  // guesswork that regresses after an update or OS upgrade.
  UTExportedTypeDeclarations: [
    {
      UTTypeIdentifier: "com.benreich.privateroom.workspace",
      UTTypeDescription: "Arcelle Workspace",
      UTTypeConformsTo: ["public.data"],
      UTTypeIconFile: "document.icns",
      UTTypeTagSpecification: {
        "public.filename-extension": ["arcelle", "roomai"],
      },
    },
  ],

  // src-tauri/Info.plist:36-52, byte-for-byte. .roomai is the legacy
  // extension (project memory: "Arcelle rebrand" -- KEPT, do NOT drop).
  CFBundleDocumentTypes: [
    {
      LSItemContentTypes: ["com.benreich.privateroom.workspace"],
      CFBundleTypeExtensions: ["arcelle", "roomai"],
      CFBundleTypeName: "Arcelle Workspace",
      CFBundleTypeRole: "Editor",
      CFBundleTypeIconFile: "document.icns",
    },
  ],
};

/** @type {import("electron-builder").Configuration} */
const config = {
  appId: "com.benreich.privateroom",
  productName: "Arcelle",

  directories: {
    output: "release",
  },

  // dist_package/ contains the compiled main/preload code and the copied
  // production renderer. dist_boot/ remains test-only scratch output.
  files: ["package.json", "dist_package/**/*", "!dist_package/**/*.test.js", "!dist_package/**/*.test.js.map"],

  asar: true,
  // The wrapper immediately before electron-builder FORCE-rebuilds the exact
  // native binding for Electron and proves it opens a DB. Letting builder run
  // its generic install-app-deps pass afterward can replace that binary with
  // this package's Node-ABI prebuild while still logging "prepared". That is
  // the installed-only NODE_MODULE_VERSION 137-vs-148 crash. Preserve the
  // already-proven binding; package.sh also verifies it again from app.asar.
  npmRebuild: false,

  // `afterSign` is a TOP-LEVEL Configuration field, not a `mac`-specific one
  // (confirmed against `app-builder-lib/out/configuration.d.ts`, which is
  // where `Hook<AfterPackContext, void>` lives -- `macOptions.d.ts` has no
  // `afterSign` key at all, despite it only ever firing for a darwin pack in
  // this single-platform config). electron-builder's ajv-based config
  // validator (`app-builder-lib/scheme.json`) rejects `mac.afterSign`
  // outright with an unhelpfully generic "configuration.mac should be one of
  // these: null" -- caught by actually running this config through
  // `electron-builder --dir`, not by reading the docs page, which does not
  // make the top-level-vs-mac distinction obvious either.
  afterSign,

  mac: {
    ...(unsignedProof
      ? { identity: null }
      : wantsAdHoc
        ? { identity: "-", timestamp: "none" }
        : {}),

    icon: appIcon,
    entitlements: path.join(here, "scripts", "entitlements.mac.plist"),
    // electron-builder's OWN default template already includes the
    // equivalent grants (MacTargetHelper.js's own warning about ad-hoc +
    // hardenedRuntime needing disable-library-validation is what
    // entitlements.mac_a.plist's own doc comment cites) -- entitlementsInherit
    // is deliberately left UNSET here to use that bundled default rather than
    // inventing a second file this repo has to keep in sync: helpers get
    // Electron's own baseline, never Arcelle's mic/audio-input grant.
    hardenedRuntime: true,
    gatekeeperAssess: false,
    minimumSystemVersion: "12.0",

    // NOT electron-builder's built-in notarize integration -- see
    // scripts/afterSign.mjs's own module doc for exactly why: it runs
    // INSIDE the same signApp() pass that happens BEFORE afterSign fires
    // (confirmed against macPackager.js/platformPackager.js source), so
    // letting it run automatically would notarize the PRE-reseal bytes and
    // then invalidate that notarization the moment afterSign.mjs re-signs
    // the sidecar and reseals the top level. afterSign.mjs calls
    // @electron/notarize itself, after the reseal, over the FINAL bytes.
    notarize: false,

    // Pure waste avoidance (research doc section 4): osx-sign's own
    // `isbinaryfile` NUL-byte heuristic, not a Mach-O check, would otherwise
    // detect the ~615MB of model weights as "binary" and codesign each one
    // individually -- a full hash of that much data for signatures the tar
    // step then drops anyway (tar never reads xattrs). Deliberately does NOT
    // exclude Contents/Resources/sidecar/: this candidate uses the
    // "re-sign after" approach (let osx-sign sign the sidecar tree normally
    // with entitlementsInherit on its first pass, then afterSign.mjs
    // re-signs just the ONE sidecar executable with its own entitlements and
    // reseals) rather than "exclude and hand-sign the whole sidecar tree
    // ourselves" -- both are valid per the research doc, but re-sign-after
    // needs osx-sign to have touched the sidecar tree at all.
    signIgnore: ["Contents/Resources/models/"],

    // tar.gz deliberately NOT listed as a target -- see packTarGz_a.mjs's
    // own module doc for the full reasoning (asset name, 7zip download,
    // reusing release.sh's exact proven recipe instead of a second
    // implementation). dmg is the manual-download asset; dir is this file's
    // own safety-rule-compliant proof target (no installer, no signing
    // attempted beyond what a resolved identity would trigger, which this
    // sandbox has none of).
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "dir", arch: ["arm64"] },
    ],

    extraResources: [
      { from: modelsDir, to: "models" },
      { from: sidecarStageDir, to: "sidecar/arcelle-sidecar" },
      { from: documentIcns, to: "document.icns" },
    ],

    extendInfo,
  },

  dmg: {
    // Matches release.sh's `hdiutil create -volname "Arcelle"` (plain
    // volume name, no version suffix) and its `-format UDZO` (electron-builder's
    // own default anyway, made explicit here for parity-with-today rather
    // than relying on the default staying UDZO).
    title: "Arcelle",
    format: "UDZO",
    // release.sh:87's existing name, kept so README / release-notes links
    // stay valid rather than adopting electron-builder's own
    // `${productName}-${version}-${arch}.${ext}` default.
    artifactName: "Arcelle_${version}_aarch64.dmg",
  },
};

export default config;
