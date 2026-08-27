/**
 * Builds the release's `latest.json`, the Static-form
 * manifest a legacy Tauri client's updater and this repo's own
 * `tauriUpdater.ts` both have to parse identically. Ports `release.sh`'s own
 * `node -e JSON.stringify(...)` construction (never string interpolation --
 * `notes` and the base64 `signature` both have to survive JSON escaping
 * intact), plus the two hard rules `updateManifest.ts`'s module doc calls
 * out explicitly:
 *
 *  - the platform key MUST be the plain `darwin-aarch64` (not
 *    `darwin-aarch64-app`) -- `selectPlatformEntry` tries the `-app` suffix
 *    FIRST, but the shipped manifest has always carried only the plain key,
 *    and it has to keep doing so for the whole bridge window or every client
 *    (old and new) finds no matching platform and silently reports "no
 *    update available".
 *  - `pub_date` must be strict RFC 3339 INCLUDING CALENDAR VALIDITY --
 *    `updateManifest.ts`'s own `isValidRfc3339` exists because `Date.parse`
 *    alone would accept `2026-02-30T00:00:00Z` (silently rolling it to March
 *    2nd) where the real Rust client's `OffsetDateTime::parse` rejects it
 *    outright, failing the WHOLE manifest for every client. This module
 *    self-checks with that exact function before writing anything, so the
 *    publish side and the parse side can never silently disagree about what
 *    counts as valid.
 */

// Vitest resolves the source-side `.js` specifiers to their TypeScript files.
// The standalone release CLI runs under plain Node after `build:main`, so it
// must load the emitted JavaScript instead. Keeping the choice here means the
// pure helpers remain unit-testable while the publishing path never depends on
// a test runner's TypeScript resolver.
const invokedAsCli = import.meta.url === `file://${process.argv[1]}`;
const updaterModuleBase = invokedAsCli
  ? "../dist_package/electron/main/updater"
  : "../electron/main/updater";
const { isValidRfc3339 } = await import(`${updaterModuleBase}/updateManifest.js`);
const { decodeOuterBase64, parseSignatureFile } = await import(`${updaterModuleBase}/minisignVerify.js`);

/** Decode and validate the one-line `.sig` written by `tauri signer sign`.
 *
 * The Tauri CLI writes manifest-ready outer base64. The standalone minisign
 * CLI writes the inner four-line document. The JSON builder continues to take
 * that inner document, so this boundary converts Tauri output exactly once and
 * prevents a release from silently publishing a double-encoded signature.
 */
export function decodeTauriSignatureFile(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("decodeTauriSignatureFile: signature file is empty");
  }
  const decoded = decodeOuterBase64(
    text.trim(),
    "malformed_signature",
    "Tauri signature file",
  );
  parseSignatureFile(decoded);
  return decoded;
}

/** `date -u +%Y-%m-%dT%H:%M:%SZ` equivalent -- always a real calendar
 * instant (it comes from `Date.now()`, not string-built), so this can never
 * itself produce a value `isValidRfc3339` would reject; the check in
 * {@link buildLatestManifestJson} is for a CALLER-SUPPLIED `pubDate`
 * (a re-run, a backdated release note, manual testing), not this helper. */
export function rfc3339Now(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * @param {object} opts
 * @param {string} opts.version - SemVer, no leading `v` (e.g. `"0.26.0"`).
 * @param {string} opts.notes
 * @param {string} [opts.pubDate] - RFC 3339; defaults to {@link rfc3339Now}.
 * @param {string} opts.signatureFileText - the WHOLE `.sig` file's text
 *   (all 4 lines, untrusted-comment through the global signature) -- NOT
 *   already base64-encoded; this function does that encoding, matching
 *   `minisignVerify.ts`'s `verifyManifestSignature` decoding it back out of
 *   the manifest the same way.
 * @param {string} [opts.repo] - defaults to `release.sh`'s own `benrben/private-room`.
 * @param {string} [opts.tag] - defaults to `v${version}`.
 * @returns {string} the `latest.json` text, `JSON.stringify(..., null, 2) + "\n"`.
 */
export function buildLatestManifestJson({
  version,
  notes,
  pubDate = rfc3339Now(),
  signatureFileText,
  repo = "benrben/private-room",
  tag,
}) {
  if (!version || typeof version !== "string") {
    throw new Error("buildLatestManifestJson: version is required");
  }
  if (!signatureFileText || typeof signatureFileText !== "string") {
    throw new Error("buildLatestManifestJson: signatureFileText is required (the whole .sig file's text)");
  }
  if (!isValidRfc3339(pubDate)) {
    throw new Error(
      `buildLatestManifestJson: pub_date ${JSON.stringify(pubDate)} is not valid RFC 3339 ` +
        `(checked with the SAME isValidRfc3339 the client uses to parse it) -- ` +
        `a bad pub_date fails the WHOLE manifest for every client, not just this field`,
    );
  }
  const resolvedTag = tag ?? `v${version}`;
  const manifest = {
    version,
    notes: notes ?? "",
    pub_date: pubDate,
    platforms: {
      // Plain key, deliberately -- see module doc. Do NOT add "-app".
      "darwin-aarch64": {
        signature: Buffer.from(signatureFileText, "utf8").toString("base64"),
        url: `https://github.com/${repo}/releases/download/${resolvedTag}/Arcelle.app.tar.gz`,
      },
    },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// CLI accepts exactly one signature form:
//   --tauri-sig-file: one-line outer base64 from `tauri signer sign` (release)
//   --sig-file: raw four-line minisign document (tool/test compatibility)
if (invokedAsCli) {
  const { readFile, writeFile } = await import("node:fs/promises");
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    flags[key] = args[i + 1];
  }
  const required = ["version", "notes", "out"];
  const missing = required.filter((k) => flags[k] === undefined);
  const signatureFlags = ["sig-file", "tauri-sig-file"].filter((k) => flags[k] !== undefined);
  if (missing.length > 0 || signatureFlags.length !== 1) {
    console.error(
      `usage: node buildLatestManifest.mjs --version X.Y.Z --notes "..." (--tauri-sig-file path.sig | --sig-file raw.sig) --out path/latest.json [--repo owner/name] [--tag vX.Y.Z] [--pub-date RFC3339]\n` +
        `missing: ${missing.join(", ") || "none"}; signature inputs supplied: ${signatureFlags.length}`,
    );
    process.exit(2);
  }
  const signatureFileText = flags["tauri-sig-file"] !== undefined
    ? decodeTauriSignatureFile(await readFile(flags["tauri-sig-file"], "utf8"))
    : await readFile(flags["sig-file"], "utf8");
  const json = buildLatestManifestJson({
    version: flags.version,
    notes: flags.notes,
    signatureFileText,
    repo: flags.repo,
    tag: flags.tag,
    pubDate: flags["pub-date"],
  });
  await writeFile(flags.out, json, "utf8");
  console.log(`wrote ${flags.out}`);
}
