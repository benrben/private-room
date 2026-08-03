/* `scripts/accuracy-tests.sh` must stay in step with the code it tests.
 *
 * The 13 transcription-accuracy tests are `#[ignore]`d because the Whisper
 * model is a 574 MB download (audit #563), so `cargo test` skips them and the
 * only thing that runs them is that script. Two ways it could go quietly
 * useless, both of which this pins:
 *
 *   • the model file name / URL is re-pinned in `stt.rs` and the script keeps
 *     downloading the old one;
 *   • the ignored tests move out of the module paths the script filters on, so
 *     every run reports "0 passed" and looks green.
 *
 * The bundle-resources sibling test guards the same model for the shipped app.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "../../", p), "utf8");

const SCRIPT = read("scripts/accuracy-tests.sh");
const STT = read("src-tauri/src/stt.rs");

test("the script downloads the model stt.rs actually loads", () => {
  const file = /MODEL_FILE: &str = "([^"]+)"/.exec(STT)?.[1];
  const url = /MODEL_URL: &str =\s*\n?\s*"([^"]+)"/.exec(STT)?.[1];
  assert.ok(file, "MODEL_FILE not found in stt.rs");
  assert.ok(url, "MODEL_URL not found in stt.rs");
  assert.ok(
    SCRIPT.includes(`MODEL_FILE="${file}"`),
    `scripts/accuracy-tests.sh pins a different model file than stt.rs (${file})`,
  );
  assert.ok(
    SCRIPT.includes(`MODEL_URL="${url}"`),
    "scripts/accuracy-tests.sh pins a different model URL than stt.rs",
  );
});

test("every module the script filters on still holds ignored accuracy tests", () => {
  const filters = [...SCRIPT.matchAll(/^run ([a-z_:]+)$/gm)].map((m) => m[1]);
  assert.ok(filters.length >= 3, "the script stopped running any filters");
  const sources = {
    "recording::": "src-tauri/src/recording.rs",
    "stt::": "src-tauri/src/stt.rs",
    "commands::stt_cmds::": "src-tauri/src/commands/stt_cmds.rs",
  };
  for (const f of filters) {
    const path = sources[f];
    assert.ok(path, `the script filters on '${f}', which this test doesn't know`);
    const ignored = (read(path).match(/#\[ignore/g) ?? []).length;
    assert.ok(ignored > 0, `${path} has no #[ignore]d tests — '${f}' would run nothing`);
  }
});

test("a run where nothing executed is treated as a failure", () => {
  // The trap the script exists to avoid: `--ignored` with a filter matching
  // nothing exits 0 with "0 passed", which reads exactly like success.
  assert.ok(
    SCRIPT.includes("test result: ok\\. 0 passed"),
    "the empty-run guard is gone; a filter that matches nothing would pass",
  );
});
