/* AUDIT 440 + the Touch ID sibling: what the unlock gate says when an open
 * fails.
 *
 * Two bugs, one funnel. The typed-password path turned the host's
 * `WRONG_PASSWORD` sentinel into a sentence but printed anything else
 * word-for-word — so a damaged room, a read-only disk or a file another copy of
 * the app holds open greeted the user with raw SQLite text. And the Touch ID
 * path did not even do that much: it printed the bare `WRONG_PASSWORD` code.
 *
 * Extracted with a regex rather than imported: src/App.tsx pulls in React and
 * the Tauri bridge at module load, neither of which exists under node.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const APP = readFileSync(join(root, "src/App.tsx"), "utf8");
const UNLOCK = readFileSync(join(root, "src/screens/UnlockScreen.tsx"), "utf8");
const fn = APP.slice(
  APP.indexOf("export function unlockMessage"),
  APP.indexOf("export default function App"),
);
const JS = ts.transpileModule(fn, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { unlockMessage } = await import(
  `data:text/javascript,${encodeURIComponent(JS)}`
);

test("the wrong-password sentinel never reaches the screen", () => {
  const msg = unlockMessage("WRONG_PASSWORD");
  assert.ok(!msg.includes("WRONG_PASSWORD"), msg);
  assert.match(msg, /password/i);
  // The Touch ID path funnels through the same function, so the same input
  // from `touchid_open` cannot print the raw code any more.
  assert.equal(unlockMessage("Error: WRONG_PASSWORD"), msg);
});

test("raw engine text is replaced, not echoed", () => {
  for (const raw of [
    "unable to open database file",
    "database disk image is malformed",
    "attempt to write a readonly database",
    "database is locked",
  ]) {
    const msg = unlockMessage(raw);
    assert.ok(!msg.includes(raw), `leaked engine text for ${raw}: ${msg}`);
    assert.match(msg, /[.!?]$/);
    assert.match(msg, /^[A-Z]/);
  }
});

test("the host's own sentences still come through unchanged", () => {
  // These are written by the app for the person standing at the door; turning
  // them into a generic fallback would be a regression in the other direction.
  for (const ours of [
    "File not found.",
    "This file is not an Arcelle project.",
    "This room file could not be read (Busy) — the password may be fine. Check that the file is on a connected drive.",
  ]) {
    assert.equal(unlockMessage(ours), ours);
  }
  // The one exception is deliberate: the host's read-only classification is
  // rewritten into the sentence that says what to DO about it.
  const readOnly = unlockMessage(
    "This room file could not be read (ReadOnly) — the password may be fine.",
  );
  assert.match(readOnly, /read-only/i);
  assert.match(readOnly, /copy it/i);
});

test("something unrecognisable is calm, not blank and not raw", () => {
  const msg = unlockMessage("some_internal_code_47");
  assert.ok(msg.length > 20, msg);
  assert.ok(!msg.includes("some_internal_code_47"), msg);
});

test("both unlock paths actually call it", () => {
  // The funnel only works if the handlers use it. `setError(String(e))` in
  // either path is the bug coming back.
  const handlers = APP.slice(APP.indexOf("async function handleUnlock"));
  assert.ok(
    !/catch \(e\) \{\s*setError\(String\(e\)\);/.test(handlers),
    "an unlock handler is printing the raw error again",
  );
  assert.ok(
    (APP.match(/setError\(unlockMessage\(/g) ?? []).length >= 2,
    "both the typed-password and Touch ID paths must go through unlockMessage",
  );
});

test("a workspace unlock explains what the password does and does not protect", () => {
  assert.match(UNLOCK, /password unlocks chats, memory, search, and history/i);
  assert.match(UNLOCK, /normal files[^.]*remain readable in Finder/i);
  assert.match(UNLOCK, /!\/\\\.\(\?:arcelle\|roomai\)/);
});
