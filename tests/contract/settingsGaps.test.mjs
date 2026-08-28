/* Settings/start-screen gaps the audit found, pinned, and the sentences a
 * password change owes the user when only half of it worked.
 *
 * Runs under `npm run test:page` (node --test). `duplicateFileName` and
 * `src/rooms/passwordChange.ts` are exercised for real — both import nothing,
 * so they type-strip and import from memory like localModel.test.mjs does. The
 * rest are SOURCE scans, the same way approveCardFocus.test.mjs pins the
 * consent cards: each of those lives inside a React section that needs the
 * whole Tauri backend and a settings state object before it renders one node,
 * and what actually went wrong in each case is a control that was never wired
 * at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(here, "../../apps/desktop/src/renderer", p), "utf8");

const load = async (file) => {
  const js = ts.transpileModule(src(file), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
};
const { duplicateDestinationSuggestion, duplicateFileName } = await load("rooms/helpers.ts");
const {
  newPasswordProblem,
  revokedRecoveryWarning,
  sealedExportPasswordProblem,
  strandedCheckpointWarning,
  touchIdLostWarning,
} = await load("rooms/passwordChange.ts");

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

test("workspace duplicates are suggested as folders, not sealed .arcelle files", () => {
  assert.deepEqual(duplicateDestinationSuggestion("Tax 2026", "workspace"), {
    title: "Choose destination workspace folder",
    defaultPath: "Copy of Tax 2026",
  });
  assert.deepEqual(duplicateDestinationSuggestion("Tax 2026", "legacy"), {
    title: "Save duplicated Arcelle room",
    defaultPath: "Copy of Tax 2026.arcelle",
  });
  const privacy = src("settings/usePrivacy.ts");
  assert.match(privacy, /roomStorageUsage\(\)/, "the picker must ask for the actual storage format");
  assert.match(privacy, /kind === "legacy" \? \{ filters: ROOM_FILTER \} : \{\}/,
    "the .arcelle filter must only apply to legacy database copies");
});

test("sealed exports offer the current password or a validated alternate password", () => {
  assert.equal(sealedExportPasswordProblem("different password", "different password", 8), null);
  assert.equal(
    sealedExportPasswordProblem("different password", "not the same", 8),
    "The backup passwords do not match.",
  );
  assert.equal(
    sealedExportPasswordProblem("short", "short", 8),
    "Backup password must be at least 8 characters.",
  );
  const dialog = src("workspace/SealedExportDialog.tsx");
  assert.match(dialog, /useState<PasswordMode>\("room"\)/,
    "the safe default must reuse the current room password");
  assert.match(dialog, /Use this room&apos;s password/);
  assert.match(dialog, /Use a different password/);
  assert.match(dialog, /alternate \? password : null/,
    "the renderer must send null for the backend-held room password and only send an explicit alternate");
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /useFocusTrap/);
});

test("the start screen says when a recent room's file is gone", () => {
  // The backend has stat-ed every recents path for a while, but the TypeScript
  // type did not declare `missing` and no screen read it — so a moved or
  // deleted room still looked identical to a working one and you found out
  // only after typing the password.
  const types = readFileSync(
    join(here, "../../apps/desktop/src/shared/apiTypes.ts"),
    "utf8",
  );
  const start = src("screens/StartScreen.tsx");
  assert.match(types, /missing\?: boolean/, "RecentRoom must declare missing");
  assert.match(start, /room\.missing/, "the start screen must read it");
  assert.match(
    start,
    /(?:File|Room) not found/,
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

test("a new password is refused for the reason it was refused", () => {
  assert.equal(newPasswordProblem("hunter2hunter2", "hunter2hunter2", 8), null);
  assert.equal(
    newPasswordProblem("hunter2hunter2", "hunter2hunter", 8),
    "The new passwords do not match.",
  );
  // Mismatch is checked first: telling someone their typo is too short sends
  // them to fix the wrong box.
  assert.equal(newPasswordProblem("abc", "xyz", 8), "The new passwords do not match.");
  assert.equal(
    newPasswordProblem("abc", "abc", 8),
    "New password must be at least 8 characters.",
  );
  assert.equal(
    newPasswordProblem("abcdefghij", "abcdefghij", 12),
    "New password must be at least 12 characters.",
  );
});

test("a password change that half-worked says which half", () => {
  // `change_password` returns null for a room that never had a recovery key
  // AND for one whose key could not be re-wrapped. Only the second is a
  // credential the user has permanently lost, and only the second is said.
  assert.match(revokedRecoveryWarning(true, null), /revoked/);
  assert.equal(revokedRecoveryWarning(false, null), null);
  assert.equal(revokedRecoveryWarning(true, "ABCD-EFGH"), null);

  // A stranded restore point still opens — with the OLD password. Saying so
  // now is the difference between keeping that password and losing the data.
  assert.equal(strandedCheckpointWarning([]), null);
  const one = strandedCheckpointWarning(["Before the import"]);
  assert.match(one, /^1 restore point could not be re-locked/);
  assert.match(one, /\(Before the import\)/);
  assert.match(one, /PREVIOUS password/);
  assert.match(
    strandedCheckpointWarning(["a", "b"]),
    /^2 restore points could not be re-locked with the new password \(a, b\)\./,
  );

  // The Keychain drops the entry rather than keep a stale password in it, so
  // the switch has to stop claiming the room is biometric-unlockable.
  assert.match(touchIdLostWarning(true, false), /Touch ID unlock was turned off/);
  assert.equal(touchIdLostWarning(true, true), null);
  assert.equal(touchIdLostWarning(false, false), null);
  assert.equal(touchIdLostWarning(false, true), null);
});

test("a partial failure is said ALONGSIDE the success, never instead of it", () => {
  // That the two warnings share an accumulator rather than one string slot is
  // pinned by settingsClaims.test.mjs; what is pinned here is the other half —
  // the password DID change, and a warning must not read as a failed change.
  const hook = src("settings/usePrivacy.ts");
  const saved = hook.indexOf("setPwSaved(true)");
  assert.ok(saved > 0, "the change must still report itself as saved");
  assert.ok(
    saved < hook.indexOf("const warnings"),
    "the saved state is set before the warnings are gathered, so both show",
  );
  const section = src("settings/PrivacySection.tsx");
  assert.match(section, /\{pwError && /, "the panel must render the warning");
  assert.match(section, /pwSaved \?/, "and the changed state at the same time");
});
