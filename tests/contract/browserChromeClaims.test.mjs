/* The browser chrome, and the things it may not say.
 *
 * Eight verified defects in `BrowserView.tsx`, every one of them a claim the
 * toolbar or the journal panel made without grounds — an address for a page
 * that is not on screen, a clean history for a record nobody could read, a
 * confirmation the user did not arm, an erase that failed in silence.
 *
 * SOURCE-LEVEL, and deliberately so: the component drives a NATIVE child
 * webview that no DOM harness in this repo can mount, and there is no React
 * test runner here. These pin the shape of each fix so a later edit cannot
 * quietly undo it; they are not a substitute for driving the app.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "../../apps/desktop/src/renderer/workspace/BrowserView.tsx"), "utf8");

/** A named declaration, from its `const <name>` to the next one at indent 2. */
function decl(name) {
  const at = SRC.indexOf(`const ${name}`);
  assert.notEqual(at, -1, `${name} has been renamed — re-point this test`);
  const rest = SRC.slice(at + 6);
  const end = rest.search(/\n  (?:const|async function|function|\/\*\*|\/\/ ---)/);
  return rest.slice(0, end === -1 ? rest.length : end);
}

test("the poll does not rename the address box while the results are in front", () => {
  // THE DEFECT: a search left the query in the box for one poll and then the
  // URL of the page parked at 1x1 behind the results took its place — an
  // address for a page not on screen, and Enter went there instead of
  // searching again.
  assert.match(
    decl("refresh"),
    /if \(!editing && !searchOpenRef\.current && next\.url\) setAddress\(next\.url\)/,
    "the poll writes the parked page's URL over the query again",
  );
  // Through a REF: `refresh` is what the four native event subscriptions hang
  // off, so taking `searchOpen` as a dependency would re-register them on
  // every results toggle.
  assert.match(SRC, /searchOpenRef\.current = searchOpen;/, "the mirror is never written");
});

test("a privacy check that did not come back does not count as one that did", () => {
  // The shield latched on "Checking" for the rest of that page's life: the
  // page had been marked as verified before the answer arrived, so nothing
  // ever asked again.
  const refresh = decl("refresh");
  assert.match(refresh, /if \(answer === null\) verifiedForRef\.current = null;/);
  assert.ok(
    !/setEphemeral\(await api\.browserVerifyPrivate/.test(refresh),
    "the claim is still latched before the answer is known",
  );
});

test("a failed result-open only restores results the user can have come from", () => {
  const body = decl("openResult");
  assert.match(
    body,
    /if \(search && !readerOpen\) setSearchOpen\(true\)/,
    "a failed link click from the reading view still parks the page behind a list that is not there",
  );
  // …and drops the previous failure's recovery button with it: it offered to
  // broadcast a hostname typed minutes earlier to seven search engines.
  assert.match(body, /setFailedInput\(null\)/, "openResult keeps the old retry query");
  assert.match(
    decl("openResultInNewTab"),
    /setFailedInput\(null\)/,
    "openResultInNewTab keeps the old retry query",
  );
});

test("one notice, one timer", () => {
  // An earlier notice's timeout went on running against the shared state, so a
  // save confirmation could be erased a second after it appeared.
  assert.match(SRC, /window\.clearTimeout\(noticeTimer\.current\)/);
  assert.match(SRC, /setNotice\("Opened in a new tab\.", 4000\)/);
  assert.ok(
    !/window\.setTimeout\(\(\) => setNotice\(null\)/.test(SRC),
    "a notice still arms its own timer beside the shared one",
  );
});

test("a journal read that failed is not rendered as a clean history", () => {
  assert.ok(
    !/browserJournal\(300\)\.catch\(\(\) => \[\]\)/.test(SRC),
    "a failed read is still stood down to an empty record",
  );
  assert.match(decl("loadJournal"), /setJournalError\(String\(e\)\)/);
  assert.match(SRC, /The record could not be read/, "the failure is never shown");
  assert.match(SRC, /journalError \? null : \(/, '"Nothing yet." still speaks for a failed read');
});

test("Erase says what happened, and re-reads either way", () => {
  const at = SRC.indexOf("browserClearJournal()");
  assert.notEqual(at, -1, "the erase call has been renamed — re-point this test");
  const call = SRC.slice(at, at + 800);
  assert.match(call, /\.catch\(\(e\) => \{/, "the rejection is still unhandled");
  assert.match(call, /setError\(String\(e\)\)/, "a failed erase is still silent");
  assert.match(call, /void loadJournal\(\);/, "the panel never re-reads what actually survived");
  assert.match(call, /void loadClearScope\(\);/, "Clear keeps the counts from before the erase");
  // The error banner is shared with the address bar, and so is the recovery
  // button hanging off it: an erase failure shown over "Search the web for
  // <a hostname typed minutes ago>" offers to broadcast it from a panel that
  // has nothing to do with searching.
  assert.match(call, /setFailedInput\(null\);/, "a failed erase inherits the address bar's retry query");
});

test("Clear is gated on everything it erases, not on the journal alone", () => {
  // The assistant's chat-side web_search fills the room's web cache and writes
  // no journal row, so an empty record is no evidence there is nothing to
  // erase — and this button is the only control in the app that empties it.
  assert.ok(
    !/disabled=\{journal\.length === 0\}/.test(SRC),
    "Clear is still disabled by an empty journal alone",
  );
  assert.match(
    SRC,
    /const nothingToErase = journal\.length === 0 && cached === 0;/,
    "the gate no longer counts the cached searches, pages and previews",
  );
  assert.match(SRC, /disabled=\{nothingToErase\}/);
});

test("closing the journal disarms the confirmation it was left on", () => {
  const at = SRC.indexOf("if (!journalOpen) {");
  assert.notEqual(at, -1, "the journal effect no longer handles the closed case");
  const closed = SRC.slice(at, at + 400);
  assert.match(closed, /setConfirmClear\(false\)/, "reopening lands on an armed Erase again");
  assert.match(closed, /setClearScope\(null\)/, "…beside the counts from the previous visit");
});
