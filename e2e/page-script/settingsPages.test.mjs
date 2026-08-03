/* Two things Settings owes the user, neither of which any render test saw.
 *
 * 1. LIGHT MODE IS FINDABLE. The theme could only be changed from an unlabelled
 *    top-bar icon or by typing into the command palette; Settings → App held
 *    the version number and nothing else, so looking in the obvious place said
 *    this app has no light mode.
 * 2. OPENING SETTINGS SENDS NOTHING. Settings mounts every page at once (they
 *    are `hidden`, not unmounted), so the voice hook fetched the live voice
 *    catalog — a request that leaves the Mac — on every single open, for people
 *    who never touch the Voice page.
 *
 * These are source-level assertions on purpose: both defects are about WHERE a
 * call is wired, and both survived every behavioural test in the tree precisely
 * because nothing renders the modal. Same tactic as bundle-resources.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const settings = read("src/Settings.tsx");
const appearance = read("src/settings/AppearanceSection.tsx");
const voiceHook = read("src/settings/useVoiceSettings.ts");

test("the App page carries a theme control, not just the version number", () => {
  assert.match(settings, /import AppearanceSection from/);
  // Rendered on the App page — the page the rail's "App" button opens.
  const appPage = settings.match(
    /hidden=\{activeGroup !== "app"\}>([\s\S]*?)<\/div>/,
  );
  assert.ok(appPage, "the App page block moved — this test is out of date");
  assert.match(appPage[1], /<AppearanceSection \/>/);
  // And routable: a deep-link to the section has to know which page owns it.
  assert.match(settings, /"set-appearance"/);
  assert.match(appearance, /id="set-appearance"/);
});

test("the theme control offers all three states theme.ts can be in", () => {
  // Two-way is what the top bar already has, and it can only land on
  // "follow the Mac" by coincidence. Settings is where the third one lives.
  for (const value of ["system", "light", "dark"]) {
    assert.match(
      appearance,
      new RegExp(`value: "${value}"`),
      `the theme picker cannot select "${value}"`,
    );
  }
  assert.match(appearance, /setTheme\(next\)/, "picking a theme must apply it");
});

test("the voice catalog is fetched only once the Voice page is shown", () => {
  // The hook must take the flag…
  assert.match(voiceHook, /export function useVoiceSettings\(visible: boolean\)/);
  // …the fetch must be behind it and behind a once-guard…
  const gated = voiceHook.match(
    /if \(!visible && ?[\s\S]{0,80}?\)[\s\S]{0,400}?listNeuralVoices|if \(!visible \|\| [\s\S]{0,120}?\)[\s\S]{0,400}?listNeuralVoices/,
  );
  assert.ok(
    gated,
    "listNeuralVoices is not gated on the page being visible — opening the gear " +
      "would contact the voice provider again",
  );
  // …and Settings must pass the real page state, not `true`.
  assert.match(settings, /useVoiceSettings\(activeGroup === "voice"\)/);
});

test("closing Settings with unsaved work asks first", () => {
  /* Custom instructions, the creativity slider, the voice choice, the
   * remote-AI address and the internet section only apply on Save, but Escape
   * and a click on the backdrop closed the modal instantly and silently. */
  // Every Save-button section has to contribute a dirty signal…
  for (const flag of ["tuningDirty", "voiceDirty", "webDirty", "closetDirty"]) {
    assert.match(
      settings,
      new RegExp(`\\b${flag}\\b`),
      `${flag} is not part of the unsaved check — that section's work can still vanish`,
    );
  }
  assert.match(
    read("src/settings/useBehaviorSettings.ts"),
    /tuningDirty:/,
    "the instructions/creativity fields report no dirty state",
  );
  assert.match(read("src/settings/useVoiceSettings.ts"), /voiceDirty:/);
  assert.match(read("src/settings/useRemoteAi.ts"), /closetDirty:/);

  // …and BOTH silent exits must go through the guard, not straight to onClose.
  assert.match(settings, /className="settings-backdrop"[^>]*onClick=\{requestClose\}/);
  assert.match(settings, /useFocusTrap\(requestClose\)/, "Escape still closes unguarded");
  // The guard must offer a way out that keeps the work.
  assert.match(settings, /Keep editing/);
});
