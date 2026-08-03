/* Four Settings/start-screen gaps the audit found, pinned.
 *
 * Runs under `npm run test:page` (node --test). `duplicateFileName` is exercised
 * for real — `src/rooms/helpers.ts` imports nothing, so it type-strips and
 * imports from memory like localModel.test.mjs does. The other three are SOURCE
 * scans, the same way approveCardFocus.test.mjs pins the consent cards: each of
 * those lives inside a React section that needs the whole Tauri backend and a
 * settings state object before it renders one node, and what actually went
 * wrong in each case is a control that was never wired at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(here, "../../src", p), "utf8");

const JS = ts.transpileModule(src("rooms/helpers.ts"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { duplicateFileName } = await import(
  `data:text/javascript,${encodeURIComponent(JS)}`
);

test("a duplicate is suggested under the room's own name, not 'Copy of room'", () => {
  // The save sheet offered the same generic name for every room, so duplicating
  // two different rooms produced two identically-named files — while the app
  // had known both real names the whole time.
  assert.equal(duplicateFileName("Tax 2026"), "Copy of Tax 2026");
  // macOS renders `/` in a file name as `:` and vice versa, so neither may
  // reach the sheet or the suggestion is a name Finder shows differently.
  assert.equal(duplicateFileName("Q3/Q4 plan"), "Copy of Q3 Q4 plan");
  assert.equal(duplicateFileName("A:B"), "Copy of A B");
  // A room with no usable name keeps the old wording rather than suggesting an
  // empty file name.
  assert.equal(duplicateFileName(""), "Copy of room");
  assert.equal(duplicateFileName("   "), "Copy of room");
});

test("the start screen says when a recent room's file is gone", () => {
  // The backend has stat-ed every recents path for a while, but the TypeScript
  // type did not declare `missing` and no screen read it — so a moved or
  // deleted room still looked identical to a working one and you found out
  // only after typing the password.
  const types = src("apiTypes.ts");
  const start = src("screens/StartScreen.tsx");
  assert.match(types, /missing\?: boolean/, "RecentRoom must declare missing");
  assert.match(start, /room\.missing/, "the start screen must read it");
  assert.match(
    start,
    /File not found/,
    "and must say so in words, not just dim the row",
  );
});

test("search-result previews have a real switch in Settings", () => {
  // The results page told the user to turn previews off in Settings → Online
  // features. No such control existed, so every search silently opened the top
  // eight result pages and there was nothing to press.
  const section = src("settings/OnlineSection.tsx");
  const hook = src("settings/useOnlineSearch.ts");
  assert.match(section, /resultPreviews/, "the section must render the switch");
  assert.match(
    hook,
    /web_result_previews/,
    "and it must read/write the setting search.rs actually consults",
  );
  // Both directions: loaded on open, saved on Save.
  assert.match(hook, /getSetting\("web_result_previews"\)/);
  assert.match(hook, /setSetting\("web_result_previews"/);
});

test("a running model download can be stopped from every surface that starts one", () => {
  // The Rust half (a cancel flag filed under `pull:<model>`) was built and
  // tested; nothing called it, so a 3 GB helper could only be escaped by
  // quitting the app.
  const hook = src("settings/useModelManagement.ts");
  assert.match(
    hook,
    /cancelAsk\(`pull:\$\{name\}`\)/,
    "Stop must reach the pull cancel key the backend registers",
  );
  // A stopped download is not a failure and must not be reported as one.
  assert.match(hook, /wasStopped/, "a user-pressed Stop must not raise an error");
  for (const file of ["settings/ModelSection.tsx", "settings/HelpersSection.tsx"]) {
    assert.match(src(file), /stopPull/, `${file} must offer the Stop button`);
  }
  // The other two surfaces that start a pull. The chat pane's first-run "Pick a
  // model to download" card is the BIGGEST download most users ever start, and
  // it had no Stop at all; the image viewer's vision-helper offer is the 3 GB
  // one the finding was written about.
  assert.match(
    src("viewers/ImageView.tsx"),
    /cancelAsk\(`pull:\$\{name\}`\)/,
    "the image viewer's vision-helper offer must be stoppable",
  );
  assert.match(
    src("workspace/recordingActions.ts"),
    /cancelAsk\(`pull:\$\{name\}`\)/,
    "the chat pane's model-download card must be stoppable",
  );
  assert.match(
    src("workspace/ChatPane.tsx"),
    /stopModelPull/,
    "and the card must actually render the Stop button",
  );
  // A stop must not be painted red as a failure on that surface either.
  assert.match(
    src("workspace/recordingActions.ts"),
    /download was cancelled/,
    "a stopped download must not be reported as an error",
  );
});

test("changing a password gets the same guidance as choosing one", () => {
  // Create showed a strength bar and a live checklist; Change password and the
  // duplicate's password showed three blank boxes and an error AFTER the
  // button — the worst moment to learn a rule. The 8-character minimum was
  // also typed out by hand in both places instead of coming from MIN_PASSWORD.
  const section = src("settings/PrivacySection.tsx");
  const hook = src("settings/usePrivacy.ts");
  assert.match(section, /passwordStrength/, "the meter must be shown here too");
  assert.match(section, /passwordCriteria/, "and the checklist with it");
  assert.match(hook, /MIN_PASSWORD/, "the minimum must come from the one setting");
  assert.doesNotMatch(
    hook,
    /at least 8 characters/,
    "the minimum must not be typed out by hand",
  );
});
