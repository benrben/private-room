/* Does the release flow keep the updater signing key off every command line?
 *
 * `MINISIGN_SECRET_KEY` is the one secret that, if copied, lets someone
 * publish a fake "Arcelle update" that every installed copy verifies and
 * installs. On macOS a process's argv is readable by anything else running as
 * you (`ps -ww`), and `npm run` echoes the command it is about to execute into
 * the terminal and into whatever log is capturing it — which is why the project
 * notes said to "scrub the key-bearing log immediately" after a release.
 *
 * `tauri signer sign` reads --private-key from TAURI_SIGNING_PRIVATE_KEY and
 * --password from TAURI_SIGNING_PRIVATE_KEY_PASSWORD (`tauri signer sign
 * --help`), so the environment is the only handover that should ever appear
 * here — in the script AND in the doc, because the DMG-first section is copied
 * by hand. This pins that: no `--private-key` / `-k` / `--password` / `-p`
 * flag, in either file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

// Flags that put the secret (or its password) into argv. Long and short forms.
// Minisign's `-s` takes a key FILE path, not the secret key bytes; that path
// is safe in argv. Flags that inline key material or a password are not.
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
          /MINISIGN_SECRET_KEY/.test(line),
      )
      .map(([n, line]) => `${rel}:${n}: ${line.trim()}`);
    assert.deepEqual(
      offenders,
      [],
      "the signing key must be handed over through the environment only",
    );
  });
}

test("release.sh still signs the updater payload", () => {
  // The fix above removes flags; it must not have removed the signing step.
  const sh = read("scripts/release.sh");
  assert.match(sh, /minisign -S/, "the updater tar is no longer signed");
  assert.match(sh, /MINISIGN_SECRET_KEY is required/, "a missing signing key must fail fast");
});
