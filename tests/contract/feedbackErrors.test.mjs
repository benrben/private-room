/* AUDIT #548: the bug-report sheet could attach the version number and nothing
 * else. Error pop-ups are this app's only failure report and they disappear
 * when dismissed, so "what did it say?" was answerable from memory alone.
 *
 * The session's error messages are now captured where they are raised
 * (`pushToast`) and offered by the sheet. Three properties matter, and all
 * three are checked here because getting any of them wrong turns a help
 * feature into a leak:
 *
 *   • the box is OFF by default (an error can name a file — room content);
 *   • the exact lines are rendered, so the user reads what they attach;
 *   • the log is in-memory only — never persisted, never logged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

const STATE = read("apps/desktop/src/renderer/workspace/state.ts");
const MODAL = read("apps/desktop/src/renderer/workspace/FeedbackModal.tsx");

test("errors are captured where they are raised, and capped", () => {
  assert.match(STATE, /errorLogRef = useRef<\{ at: string; text: string \}\[\]>\(\[\]\)/);
  assert.ok(
    /if \(kind === "error"\) \{\s*\n\s*errorLogRef\.current = \[/.test(STATE),
    "pushToast no longer records error messages",
  );
  assert.match(STATE, /slice\(-MAX_ERROR_LOG\)/, "the log is uncapped");
  assert.match(STATE, /errorLogRef,/, "errorLogRef is not handed to the sheet");
});

test("nothing writes the error log anywhere outside memory", () => {
  // Room content: an error can name a file. The ONLY copies are the ref and
  // whatever the user explicitly ticks into the issue body.
  assert.ok(!/localStorage[^\n]*error/i.test(STATE));
  assert.ok(
    !/errorLogRef[^\n]*(localStorage|invoke|writeText|api\.)/.test(STATE),
    "the error log is being persisted or sent somewhere",
  );
});

test("the sheet offers them, off by default, and shows exactly what it would send", () => {
  assert.match(MODAL, /const \[includeErrors, setIncludeErrors\] = useState\(false\)/);
  assert.match(MODAL, /s\.errorLogRef\.current/);
  // The body only grows when the box is ticked.
  assert.match(MODAL, /includeErrors && recentErrors\.length > 0/);
  assert.match(MODAL, /finalBody[\s\S]{0,200}errorBlock/);
  // …and the lines themselves are on screen to be read first.
  assert.match(MODAL, /data-testid="feedback-errors"/);
  assert.match(MODAL, /recentErrors\.map\(\(e\) => \(/);
  assert.match(MODAL, /an error can name one of your files/);
});
