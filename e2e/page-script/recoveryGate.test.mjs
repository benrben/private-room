/* The two places the "there is no way back in" fact has to be told.
 *
 * Audit #484: "Skip for now" was byte-for-byte "I saved it" — one click and the
 * only code that reopens the room without the password was gone, with no
 * "are you sure", and the panel was not announced as a dialog, did not close on
 * Escape, and let Tab wander to the start screen behind it.
 *
 * Audit #485: while choosing the password that seals the room forever, the only
 * note was "longer is stronger"; the no-reset warning lived one screen later,
 * next to that same skippable button.
 *
 * Both are copy/markup facts, so they are pinned as source assertions the way
 * `unlockMessage.test.mjs` pins the unlock gate's wording.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "../../", p), "utf8");

const MODAL = read("src/screens/RecoveryModal.tsx");
const CREATE = read("src/screens/CreateScreen.tsx");

test("skipping the recovery code asks first, and copying it is what waives that", () => {
  assert.match(MODAL, /askConfirm\(/, "Skip for now still dismisses with no confirmation");
  // The guarded path — not `onDismiss` — is what the Skip button runs.
  const skipBtn = /className="subtle" onClick=\{([^}]*)\}/.exec(MODAL)?.[1] ?? "";
  assert.match(skipBtn, /skip\(\)/, `Skip for now is wired to ${skipBtn || "nothing"}`);
  assert.doesNotMatch(skipBtn, /onDismiss/, "Skip for now still calls onDismiss directly");
  // "I saved it" stays a single click.
  assert.match(MODAL, /className="primary" onClick=\{onDismiss\}/);
  // Having copied it IS having saved it, so the guard doesn't nag needlessly.
  assert.match(MODAL, /if \(recoveryCopied\)/);
});

test("the recovery panel is a real modal dialog", () => {
  assert.match(MODAL, /role="dialog"/, "not announced as a dialog");
  assert.match(MODAL, /aria-modal="true"/, "not announced as modal");
  assert.match(MODAL, /aria-labelledby="recovery-modal-title"/, "dialog has no accessible name");
  assert.match(MODAL, /id="recovery-modal-title"/, "the labelling id is not on the title");
  // Escape + Tab containment both come from the shared trap.
  assert.match(MODAL, /useFocusTrap/, "keyboard focus can still leave the panel");
  assert.match(MODAL, /onKeyDown=\{onModalKeyDown\}/, "the trap is imported but not wired");
});

test("the password screen itself says there is no reset", () => {
  const note = /<p className="gate-note">([\s\S]*?)<\/p>/.exec(CREATE)?.[1] ?? "";
  assert.ok(note, "the create screen lost its password note entirely");
  assert.match(note, /no password reset/i, `the note still only says: ${note.trim()}`);
  assert.match(note, /recover/i, "the note does not say nobody can recover it");
});
