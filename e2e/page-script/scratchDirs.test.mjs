/* Integration tests must not leave scratch directories behind on failure.
 *
 * Audit #458: `roomfile.rs` and `roomai_cli.rs` named their scratch directory
 * after the process id and deleted it on the test's LAST line, so any failure
 * left it there. `db::create_room` refuses to write over an existing file
 * ("A file already exists at this location"), so the next run — pids get
 * recycled — failed with an error about the leftover instead of about the code
 * under test.
 *
 * The contract has to be pinned somewhere a reviewer will see it: the tests
 * cannot assert their own cleanup (the guard runs after the last assertion),
 * so this is a source check, the same shape as `accuracyTests.test.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "../../", p), "utf8");

const FILES = ["src-tauri/tests/roomfile.rs", "src-tauri/tests/roomai_cli.rs"];

for (const f of FILES) {
  test(`${f} names its scratch dir uniquely per run`, () => {
    const src = read(f);
    assert.doesNotMatch(
      src,
      /std::process::id\(\)/,
      "a pid-named scratch dir collides with a leftover from an earlier failed run",
    );
    assert.match(src, /Scratch::new\(/, "scratch dirs are not created through the guard");
  });

  test(`${f} cleans up even when a test panics`, () => {
    const src = read(f);
    // A trailing `remove_dir_all` is exactly the pattern a panic skips.
    assert.doesNotMatch(
      src,
      /std::fs::remove_dir_all\(&dir\)/,
      "cleanup is still a plain last line, which a failing assertion jumps over",
    );
    assert.match(src, /impl Drop for Scratch/, "the guard has no Drop impl");
  });
}
