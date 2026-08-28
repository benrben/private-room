/* Does the release flow keep the updater signing key off every command line
 * and refuse to publish an ambiguous-signing or wrong-updater-key build?
 *
 * The Tauri updater private key is the one secret that, if copied, lets someone
 * publish a fake "Arcelle update" that every installed copy verifies and
 * installs. On macOS a process's argv is readable by anything else running as
 * you (`ps -ww`), and `npm run` echoes the command it is about to execute into
 * the terminal and into whatever log is capturing it — which is why the project
 * notes said to "scrub the key-bearing log immediately" after a release.
 *
 * `tauri signer sign` can read the private key FILE through
 * TAURI_SIGNING_PRIVATE_KEY_PATH. That is safer than putting the key's bytes in
 * argv or exporting them to every child process. This pins both the secure
 * handoff and the release gates around it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

// Flags that put the secret (or its password) into argv. Long and short forms.
const SECRET_FLAGS = /(^|\s)(--private-key|--password|-k|-p)(\s|=)/;

for (const rel of ["scripts/release.sh", "RELEASING.md"]) {
  test(`${rel} never passes the updater key on a command line`, () => {
    const lines = read(rel).split("\n");
    const offenders = lines
      .map((line, i) => [i + 1, line])
      // Only lines that are actually invoking the signer's flags with the key.
      .filter(
        ([, line]) =>
          // A `#` line is prose in both files — it runs nothing and copies
          // nothing; the WHY-comment explaining this rule lives on one.
          !line.trimStart().startsWith("#") &&
          SECRET_FLAGS.test(line) &&
          /TAURI_SIGNING_PRIVATE_KEY/.test(line),
      )
      .map(([n, line]) => `${rel}:${n}: ${line.trim()}`);
    assert.deepEqual(
      offenders,
      [],
      "the signing key must be handed over through the environment only",
    );
  });
}

test("release.sh signs with Tauri's key-path handoff, never generic minisign", () => {
  const sh = read("scripts/release.sh");
  const executableLines = sh
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.match(sh, /TAURI_SIGNING_PRIVATE_KEY_PATH="\$UPDATER_KEY_PATH"/, "the signer does not receive the key path");
  assert.match(sh, /"\$TAURI_CLI" signer sign "\$TAR"/, "the updater tar is no longer signed by Tauri CLI");
  assert.doesNotMatch(executableLines, /\bminisign\b/i, "generic minisign cannot consume the Tauri key of record safely");
  assert.match(sh, /unset TAURI_SIGNING_PRIVATE_KEY_PATH TAURI_SIGNING_PRIVATE_KEY_PASSWORD/,
    "key settings leak into unrelated build and test child processes");
  assert.match(sh, /\[\[ -z "\$\{TAURI_SIGNING_PRIVATE_KEY:-\}" \]\]/,
    "inline private-key bytes are not rejected");
});

test("release.sh validates every release identity before publishing", () => {
  const sh = read("scripts/release.sh");
  const line = (needle) => {
    const at = sh.split("\n").findIndex((row) => row.includes(needle));
    assert.notEqual(at, -1, `${needle} is missing from release.sh`);
    return at;
  };
  const build = line("npm run package:mac");
  const publish = line('gh release create "$TAG"');

  for (const prerequisite of [
    "no Developer ID identity is installed",
    "Developer ID mode needs complete notarization credentials",
    "updater key permissions are",
    "the Git worktree must be clean",
  ]) {
    assert.ok(line(prerequisite) < build, `${prerequisite} is checked only after the expensive build`);
  }

  for (const verification of [
    "codesign --verify --strict --deep",
    "TeamIdentifier=not set",
    "Authority=Developer ID Application:",
    'xcrun stapler validate "$APP"',
    'spctl --assess --type execute --verbose "$APP"',
    "verifyManifestSignature(",
  ]) {
    const at = line(verification);
    assert.ok(at > build, `${verification} does not verify the finished app/payload`);
    assert.ok(at < publish, `${verification} runs after publication`);
  }
});

test("the canonical release guide documents the compatible key and hard gates", () => {
  const doc = read("RELEASING.md");
  assert.match(doc, /Tauri CLI v2/);
  assert.match(doc, /chmod 600 ~\/\.tauri\/private-room\.key/);
  assert.match(doc, /Do not export the key contents as `TAURI_SIGNING_PRIVATE_KEY`/);
  assert.match(doc, /Developer ID Application/);
  assert.match(doc, /ad-hoc choice explicit when publishing/);
  assert.match(doc, /stable\s+designated requirement/);
  assert.match(doc, /verifies that signature through the same pinned public key/);
});
