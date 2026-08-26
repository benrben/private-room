/* THE PRIVATE BROWSER'S TRUST INVARIANTS.
 *
 * A product audit of the installed build (2026-08-15) found the browser making
 * claims it had not checked and keeping claims after the thing they described
 * had gone. Both are silent failures — the app still renders, it just renders
 * something untrue — so each gets a test here.
 *
 * Two halves, deliberately:
 *
 *   • the pure modules (`browserPrivacy`, `browserChrome`, `browserJournal`)
 *     are transpiled and imported for real, and driven with the values the
 *     backend actually sends;
 *   • `BrowserView.tsx` itself needs React and the whole Tauri bridge before it
 *     renders a button, so it is SOURCE-SCANNED — the same technique
 *     contextualNav and navRedesign use. Those scans are what stop the modules
 *     from being correct and unused, which is the way this class of fix
 *     silently rots.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

const load = async (source) => {
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
};

const VIEW = read("src/workspace/BrowserView.tsx");
const READER = read("src/workspace/BrowserReader.tsx");
const CSS = read("src/styles/browser.css");

/* A COMPONENT module cannot be loaded the way the pure ones above are: its
 * react/api/icon specifiers do not resolve from a data: URL. Nothing runs at
 * module scope, so the imports are dropped and the JSX is emitted as
 * `React.createElement` calls inside functions this file never renders — which
 * leaves the page's pure exports callable for real. */
const loadPureExports = async (source) => {
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
    },
  }).outputText;
  return import(
    `data:text/javascript,${encodeURIComponent(js.replace(/^import[^;]*;$/gm, ""))}`
  );
};

const privacy = await load(read("src/workspace/browserPrivacy.ts"));
const chrome = await load(read("src/workspace/browserChrome.ts"));
const journal = await load(read("src/workspace/browserJournal.ts"));
const search = await loadPureExports(read("src/workspace/BrowserSearch.tsx"));

// --------------------------------------------------------------------------
// P0 — the shield must not claim protection it has not got
// --------------------------------------------------------------------------

test("a browser whose block list failed is never called Private", () => {
  // The exact shape the audit caught: storage IS ephemeral (the check the chip
  // was reading), while WebKit refused the rule list. The old code answered
  // "Private / Trackers blocked." to precisely this.
  const claim = privacy.privacyClaim(true, {
    state: "failed",
    reason: "WKErrorDomain error 6",
  });
  assert.equal(claim.tone, "degraded");
  assert.notEqual(claim.chip, "Private");
  assert.doesNotMatch(claim.detail, /trackers? blocked/i);
});

test("the failure names WebKit's own reason and offers no comfort", () => {
  const claim = privacy.privacyClaim(true, {
    state: "failed",
    reason: "WKErrorDomain error 6",
  });
  assert.match(claim.alert, /WKErrorDomain error 6/);
  assert.match(claim.alert, /OFF/);
});

test("a blocker that has not answered yet is not counted as working", () => {
  // The compile is asynchronous. "We have not heard back" must read as
  // unproven, never as proven good.
  const claim = privacy.privacyClaim(true, { state: "unknown" });
  assert.equal(claim.tone, "checking");
  assert.notEqual(claim.chip, "Private");
});

test("an older backend that sends no verdict at all is also unproven", () => {
  const claim = privacy.privacyClaim(true, undefined);
  assert.equal(claim.tone, "checking");
});

test("only both checks passing earns the word Private", () => {
  const claim = privacy.privacyClaim(true, { state: "active" });
  assert.equal(claim.tone, "verified");
  assert.equal(claim.chip, "Private");
  assert.equal(claim.alert, null);
});

test("non-ephemeral storage outranks every blocker verdict", () => {
  // The worse of the two facts sets the state, in both directions.
  for (const p of [{ state: "active" }, { state: "failed", reason: "x" }]) {
    const claim = privacy.privacyClaim(false, p);
    assert.equal(claim.tone, "breached");
    assert.equal(claim.chip, "Not private");
  }
});

test("every privacy state carries its own word, not just its own colour", () => {
  const words = new Set(
    [
      privacy.privacyClaim(true, { state: "active" }),
      privacy.privacyClaim(true, { state: "unknown" }),
      privacy.privacyClaim(true, { state: "failed", reason: "x" }),
      privacy.privacyClaim(false, { state: "active" }),
    ].map((c) => c.chip),
  );
  assert.equal(words.size, 4, `states share a word: ${[...words].join(", ")}`);
});

test("the start screen stops promising blocking when blocking is off", () => {
  assert.match(privacy.startScreenCopy({ state: "active" }), /trackers are blocked/i);
  assert.doesNotMatch(
    privacy.startScreenCopy({ state: "failed", reason: "x" }),
    /trackers/i,
  );
});

test("the start screen does not make the same promise twice", () => {
  // It read "A browser that keeps nothing: no history, no cookies, no cache.
  // Page history, cookies and cache clear when the last private page closes."
  // — one promise, stated twice, in consecutive sentences. Only visible once
  // rendered, which is why it survived a green suite.
  const copy = privacy.startScreenCopy({ state: "active" });
  assert.equal(copy.match(/cookies/gi).length, 1, `"cookies" repeats: ${copy}`);
  assert.equal(copy.match(/cache/gi).length, 1, `"cache" repeats: ${copy}`);
});

test("with no page open the shield claims nothing and stops 'checking'", () => {
  // "Checking" is what an UNANSWERED check looks like. With nothing open there
  // is no check in flight, so the chip sat on that word forever.
  const claim = privacy.privacyClaim(null, undefined, false);
  assert.equal(claim.chip, "No page");
  assert.equal(claim.alert, null);
  assert.match(claim.detail, /No private page is open/);
});

test("privacy copy names both sides of the ephemeral/durable line", () => {
  // Browser session data is ephemeral. Saved files are normal workspace files,
  // while the private journal remains in the encrypted room database.
  assert.match(privacy.EPHEMERAL_VS_ROOM, /clear when the last private page closes/);
  assert.match(privacy.EPHEMERAL_VS_ROOM, /files you choose to save stay in the workspace/);
  assert.match(privacy.EPHEMERAL_VS_ROOM, /Journal stays in encrypted private room state/);
});

test("the browser never lets private be mistaken for anonymous", () => {
  assert.match(privacy.NOT_ANONYMOUS, /websites/);
  assert.match(privacy.NOT_ANONYMOUS, /network/);
  assert.match(privacy.NOT_ANONYMOUS, /AI provider/);
});

test("the view renders the derived claim, not a hardcoded boast", () => {
  // The old tooltip, in full. Matched as the whole sentence rather than on the
  // phrase alone: the comments that explain this fix quote the phrase, and a
  // test that forbids naming the bug forbids documenting it.
  assert.ok(
    !VIEW.includes("no history, cookies or cache. Trackers blocked."),
    "BrowserView still asserts the old unconditional shield sentence",
  );
  assert.ok(VIEW.includes("privacyClaim("), "BrowserView does not use privacyClaim");
  assert.ok(
    VIEW.includes("claim.alert"),
    "BrowserView never surfaces the protection alert",
  );
  assert.ok(
    VIEW.includes("browserRetryProtection"),
    "a failed blocker is reported with no way to retry it",
  );
});

test("the stylesheet has ink for all four privacy states", () => {
  for (const tone of ["checking", "degraded", "breached"]) {
    assert.ok(
      CSS.includes(`.browser-shield.${tone}`),
      `.browser-shield.${tone} has no rule, so it would render as verified green`,
    );
  }
});

// --------------------------------------------------------------------------
// P0 — the results page's own privacy sentence
//
// The toolbar's claim has twelve tests above it. The sentence under the search
// heading — the other place this feature says what left the Mac — had none, and
// it is the harder one: previews are ON by default and read the top result
// pages from their own origins, INCLUDING on a cache hit, because only the
// search itself is cached.
// --------------------------------------------------------------------------

test("a cache hit does not claim nothing left the Mac while previews are on", () => {
  // The defect this wording replaced: "no network touched", printed beside a
  // pass that had just fetched six result pages.
  const line = search.searchPrivacyLine({
    cached: true,
    previewsEnabled: true,
    previewCount: 6,
  });
  assert.doesNotMatch(line.text, /nothing left this Mac/);
  assert.match(line.text, /6 result pages/);
});

test("previews off plus a cache hit is the one state that contacted nobody", () => {
  const line = search.searchPrivacyLine({
    cached: false,
    previewsEnabled: false,
    previewCount: 6,
  });
  assert.equal(line.text, "only your query left this Mac");
  assert.equal(
    search.searchPrivacyLine({ cached: true, previewsEnabled: false, previewCount: 6 })
      .text,
    "nothing left this Mac",
  );
});

test("a live search with previews names the query AND the pages", () => {
  const line = search.searchPrivacyLine({
    cached: false,
    previewsEnabled: true,
    previewCount: 4,
  });
  assert.match(line.text, /your query/);
  assert.match(line.text, /4 result pages/);
  assert.match(line.title, /Online features/, "no way back to the setting");
});

test("previews on with nothing to preview promises no preview", () => {
  // An empty result set enriches nothing, so the sentence must not describe a
  // request that will never be made.
  const line = search.searchPrivacyLine({
    cached: false,
    previewsEnabled: true,
    previewCount: 0,
  });
  assert.equal(line.text, "only your query left this Mac");
});

test("one result page is not one result pages", () => {
  const line = search.searchPrivacyLine({
    cached: false,
    previewsEnabled: true,
    previewCount: 1,
  });
  assert.match(line.text, /result page/);
  assert.doesNotMatch(line.text, /result pages/);
});

// --------------------------------------------------------------------------
// P0 — closing the last page must clear everything that described it
// --------------------------------------------------------------------------

const VIEW_OPEN = {
  parked: false,
  blank: false,
  searchOpen: false,
  readerHasTheFloor: false,
};

test("with no page open, nothing page-scoped is offered", () => {
  const can = chrome.chromeAbilities({ open: false }, VIEW_OPEN);
  assert.deepEqual(can, {
    navigate: false,
    save: false,
    read: false,
    takeover: false,
  });
});

test("a blank new tab can be navigated but has nothing to save or read", () => {
  const can = chrome.chromeAbilities({ open: true }, { ...VIEW_OPEN, blank: true });
  assert.equal(can.navigate, true);
  assert.equal(can.save, false);
  assert.equal(can.read, false);
});

test("the results page parks the webview, so the page cannot be read from", () => {
  // Rust refuses to read a page parked at 1×1 rather than return the fragment
  // a one-pixel layout viewport produces.
  const can = chrome.chromeAbilities(
    { open: true, url: "https://x.test" },
    { ...VIEW_OPEN, searchOpen: true },
  );
  assert.equal(can.read, false);
  assert.equal(can.save, false);
});

test("every way of parking the page is one definition, not four", () => {
  // The bounds pusher, the ability list and the chat scope each used to decide
  // this for themselves, and the reading view — added last — reached only the
  // first of them.
  assert.equal(chrome.pageIsParked(VIEW_OPEN), false);
  for (const cause of ["parked", "blank", "searchOpen", "readerHasTheFloor"]) {
    assert.equal(
      chrome.pageIsParked({ ...VIEW_OPEN, [cause]: true }),
      true,
      `${cause} does not park the page`,
    );
  }
});

test("a page the reading view has replaced cannot be saved from either", () => {
  // Rust would extract from a 1×1 layout viewport, or stall into its parked
  // refusal — the reader has the page, so nothing else may claim it.
  const can = chrome.chromeAbilities(
    { open: true, url: "https://x.test" },
    { ...VIEW_OPEN, readerHasTheFloor: true },
  );
  assert.equal(can.save, false);
});

test("an extraction hands the page back, so it is not parked then", () => {
  assert.equal(
    chrome.pageIsParked({ ...VIEW_OPEN, readerHasTheFloor: false }),
    false,
  );
});

test("the Save strip's own buttons ask the same question as the Save button", () => {
  // THE DEFECT: the four rows inside the strip were gated on `saving` alone, so
  // with zero pages open they stayed clickable and failed down in Rust.
  const strip = VIEW.slice(
    VIEW.indexOf("browser-save-row"),
    VIEW.indexOf("browser-save-hint"),
  );
  const gates = strip.match(/disabled=\{[^}]*\}/g) ?? [];
  assert.equal(gates.length, 4, "expected four Save rows to gate themselves");
  for (const gate of gates) {
    assert.match(gate, /can\.save/, `a Save row is still gated on ${gate}`);
  }
});

test("no chrome control derives its own enablement from info.open any more", () => {
  assert.ok(
    !/disabled=\{!info\.open/.test(VIEW),
    "a control still reads info.open directly instead of the ability list",
  );
});

test("the address bar is cleared by the same move that closes the page", () => {
  // `if (!editing && next.url) setAddress(next.url)` could never clear it: a
  // report with no page has no URL. The reset is what fixes that, so it must
  // exist and it must be called.
  assert.equal(chrome.CLOSED_VIEW.address, "");
  assert.equal(chrome.CLOSED_VIEW.saveOpen, false);
  assert.equal(chrome.CLOSED_VIEW.readerOpen, false);
  assert.equal(chrome.CLOSED_VIEW.search, null);
  assert.ok(VIEW.includes("forgetThePage"), "BrowserView has no last-page reset");
  assert.match(
    VIEW,
    /if \(wasOpenRef\.current && !next\.open\) forgetThePage\(editing\)/,
    "the reset is never triggered by the poll that learns the page closed",
  );
});

test("the reset never takes the address the user is in the middle of typing", () => {
  // The close is learned up to a poll late, and typing a new address is the
  // natural next move after closing the last page. Every OTHER page-scoped
  // claim still goes.
  const reset = VIEW.slice(
    VIEW.indexOf("const forgetThePage"),
    VIEW.indexOf("const refresh"),
  );
  assert.match(reset, /if \(!typing\) \{/, "the address is cleared unconditionally");
  assert.match(reset, /setSaveOpen\(CLOSED_VIEW\.saveOpen\)/);
});

test("the closed view names every page-scoped field, including the new ones", () => {
  // Two places used to have to be kept in step by hand; only one of them was.
  for (const field of ["comparing", "extracting", "ephemeral"]) {
    assert.ok(
      field in chrome.CLOSED_VIEW,
      `${field} is page-scoped but is not in CLOSED_VIEW`,
    );
  }
});

test("the poll threshold is stated once, not once per reader", () => {
  assert.equal(chrome.MISSES_BEFORE_CLOSED, 2);
  assert.ok(
    VIEW.includes("MISSES_BEFORE_CLOSED"),
    "BrowserView hardcodes the threshold beside the module that exports it",
  );
});

test("a browser that stops answering stops being described as open", () => {
  // One dropped round trip is a hiccup; the old bare `catch {}` made it
  // permanent, freezing a padlock and an armed Save strip over nothing.
  const live = { open: true, url: "https://x.test" };
  assert.deepEqual(chrome.infoAfterMissedPoll(live, 1), live);
  assert.deepEqual(chrome.infoAfterMissedPoll(live, 2), { open: false });
});

// --------------------------------------------------------------------------
// P1 — the journal is a record, not a dump
// --------------------------------------------------------------------------

const row = (id, kind, detail, session, url = "") => ({
  id,
  at: `2026-08-15T10:00:${String(id).padStart(2, "0")}Z`,
  kind,
  url,
  detail,
  session,
});

test("repeated identical entries collapse to one line with a count", () => {
  // The blocker journals once per page created, so one broken block list wrote
  // the same sentence dozens of times and buried the rest of the sitting.
  const rows = [
    row(5, "blocker", "Content blocking FAILED to load: e", "s1"),
    row(4, "blocker", "Content blocking FAILED to load: e", "s1"),
    row(3, "blocker", "Content blocking FAILED to load: e", "s1"),
    row(2, "open", "Opened a page", "s1", "https://a.test"),
  ];
  const lines = journal.coalesce(rows);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].runs, 3);
  assert.equal(lines[1].runs, 1);
});

test("a run is only collapsed when the record really is adjacent", () => {
  // Coalescing AFTER filtering merged two identical rows that a filtered-out
  // row sat between, and printed "×2" for an adjacency the record does not
  // have — a fabrication in the one artefact whose value is being exactly what
  // happened.
  const rows = [
    row(3, "blocker", "same", "s1"),
    row(2, "save", "something else", "s1"),
    row(1, "blocker", "same", "s1"),
  ];
  const [only] = journal.groupSessions(rows, "s1", ["protection"]);
  assert.equal(only.lines.length, 2);
  assert.deepEqual(only.lines.map((l) => l.runs), [1, 1]);
});

test("the same sentence about two different pages stays two facts", () => {
  const lines = journal.coalesce([
    row(2, "blocked", "Refused", "s1", "https://a.test"),
    row(1, "blocked", "Refused", "s1", "https://b.test"),
  ]);
  assert.equal(lines.length, 2);
});

test("the record splits into sittings and knows which one is live", () => {
  const sessions = journal.groupSessions(
    [row(3, "open", "a", "s2"), row(2, "open", "b", "s1"), row(1, "open", "c", "s1")],
    "s2",
    [],
  );
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].current, true);
  assert.equal(sessions[1].current, false);
  assert.equal(sessions[1].lines.length, 2);
});

test("rows written before sittings existed are never shown as the live one", () => {
  const sessions = journal.groupSessions([row(1, "open", "a", "")], "", []);
  assert.equal(sessions[0].current, false);
});

test("no filter chosen shows everything, rather than nothing", () => {
  const rows = [row(2, "open", "a", "s1"), row(1, "save", "b", "s1")];
  assert.equal(journal.groupSessions(rows, "s1", [])[0].lines.length, 2);
});

test("a filter keeps its own facet and drops the others", () => {
  const rows = [
    row(3, "open", "a", "s1"),
    row(2, "blocker", "b", "s1"),
    row(1, "save", "c", "s1"),
  ];
  const [only] = journal.groupSessions(rows, "s1", ["protection"]);
  assert.deepEqual(
    only.lines.map((l) => l.row.kind),
    ["blocker"],
  );
});

test("a kind no filter knows about survives filtering", () => {
  // Kinds are free-form string literals at each Rust call site. A filter that
  // silently drops what it does not recognise is how an audit trail loses the
  // row that mattered.
  const rows = [row(2, "open", "a", "s1"), row(1, "teleport", "?", "s1")];
  const [only] = journal.groupSessions(rows, "s1", ["protection"]);
  assert.ok(only.lines.some((l) => l.row.kind === "teleport"));
});

test("the sitting's summary counts the sitting, not the filtered view", () => {
  const rows = [
    row(3, "search", "q", "s1"),
    row(2, "open", "a", "s1"),
    row(1, "save", "c", "s1"),
  ];
  const [session] = journal.groupSessions(rows, "s1", ["protection"]);
  assert.equal(session.lines.length, 0);
  assert.match(session.summary, /1 search/);
  assert.match(session.summary, /1 page opened/);
  assert.match(session.summary, /1 item saved/);
});

test("a summary never reports a zero it did not check", () => {
  const [session] = journal.groupSessions([row(1, "open", "a", "s1")], "s1", []);
  assert.doesNotMatch(session.summary, /\b0\b/);
});

test("a working blocker is not counted as a protection warning", () => {
  const [session] = journal.groupSessions(
    [row(1, "blocker", "Content blocking active.", "s1")],
    "s1",
    [],
  );
  assert.doesNotMatch(session.summary, /protection warning/);
});

test("the summary's idea of a healthy blocker matches what Rust writes", () => {
  // `summarise` decides a blocker row is a WARNING by not matching the success
  // sentence. That is a string match across the FFI boundary: reword the Rust
  // literal and every successful attach starts being counted as a protection
  // warning, silently, in the one place a user goes to check.
  const HOST = read("electron-migration/electron-app/electron/main/browser/browser.ts");
  const SUCCESS = "Content blocking active";
  assert.ok(
    HOST.includes(`"${SUCCESS}.`) || HOST.includes(`${SUCCESS}.`),
    `browser.ts no longer journals "${SUCCESS}." — browserJournal.summarise still keys off it`,
  );
  const [ok] = journal.groupSessions(
    [row(1, "blocker", `${SUCCESS}.`, "s1")],
    "s1",
    [],
  );
  assert.doesNotMatch(ok.summary, /protection warning/);
  const [bad] = journal.groupSessions(
    [row(1, "blocker", "Content blocking FAILED to load: e", "s1")],
    "s1",
    [],
  );
  assert.match(bad.summary, /1 protection warning/);
});

test("Clear names the web cache it also erases", () => {
  // The button said "Erase this record?" while the command behind it emptied
  // the room's cached searches, page text and previews too.
  const said = journal.clearWarning({
    journal: 12,
    searches: 3,
    pages: 4,
    images: 1,
  });
  assert.match(said, /12 entries/);
  assert.match(said, /8 cached items/);
  assert.match(said, /searches, page text and previews/);
});

test("an unreportable clear scope still admits the cache is included", () => {
  assert.match(journal.clearWarning(null), /cached pages, searches and previews/);
});

test("the journal panel opens on this sitting, not on the whole history", () => {
  assert.ok(
    VIEW.includes("groupSessions("),
    "the panel does not group the record into sittings",
  );
  assert.match(
    VIEW,
    /showEarlier \? allSessions : allSessions\.slice\(0, 1\)/,
    "the panel still renders every sitting by default",
  );
});

// --------------------------------------------------------------------------
// P2 — the reading view replaces the page rather than halving the pane
// --------------------------------------------------------------------------

test("the stage keeps no width while the text has the floor", () => {
  assert.match(
    CSS,
    /\.browser-body\.reading \.browser-stage \{\s*flex: 0 0 0;/,
    "the reading view still reserves a permanent sliver for the live page",
  );
  assert.ok(
    CSS.includes(".browser-body.reading.split .browser-stage"),
    "there is no split state, so comparing has nowhere to put the page",
  );
});

test("the page is parked while it is being read instead of looked at", () => {
  assert.ok(
    VIEW.includes("readerHasTheFloor"),
    "the native page is not parked when the reading view replaces it",
  );
  assert.match(
    VIEW,
    /readerOpen && !comparing && extracting === 0/,
    "the park condition does not spare the extraction window",
  );
});

test("two overlapping extractions cannot revoke each other's viewport", () => {
  // A boolean let the first to finish park the page while the second was still
  // reading it: Rust then either stalled into its parked refusal or measured
  // the page at one CSS pixel and returned that reflow as the whole page.
  assert.match(
    VIEW,
    /setExtracting\(\(n\) => Math\.max\(0, n \+ \(on \? 1 : -1\)\)\)/,
    "the extraction borrow is not reference-counted",
  );
});

test("every control that can start an extraction waits for the last one", () => {
  const tools = READER.slice(
    READER.indexOf("browser-reader-tools"),
    READER.indexOf("</header>"),
  );
  const buttons = tools.split("<button").slice(1);
  const starters = buttons.filter((b) => /setMode|load\(mode\)/.test(b));
  assert.ok(starters.length >= 2, "expected the mode toggle and the re-read");
  for (const b of starters) {
    assert.match(b, /disabled=\{busy\}/, "an extraction starter is ungated");
  }
});

test("the reading view's own toggle stays usable while it is open", () => {
  // It went disabled with aria-pressed still true when the results list
  // appeared beneath it — a control the user could not un-press.
  assert.ok(
    !/disabled=\{!can\.read\}\s*\n\s*aria-pressed=\{readerOpen\}/.test(VIEW),
    "a reader toggle can go disabled while pressed",
  );
});

test("Retry only appears beside the failure it can actually act on", () => {
  // A non-ephemeral store and a failed block list can be true at once; the
  // storage warning outranks, and Retry recompiles the tracker list.
  assert.match(
    VIEW,
    /claim\.alert === protectionAlert\(info\.protection\)/,
    "Retry is offered under a banner it cannot address",
  );
  const breached = privacy.privacyClaim(false, { state: "failed", reason: "x" });
  assert.notEqual(breached.alert, privacy.protectionAlert({ state: "failed", reason: "x" }));
});

test("an extraction always hands the viewport back, even when it fails", () => {
  // Rust refuses to read a page parked at 1×1, so a refusal that left the page
  // parked would strand the reader beside a page it could never re-read.
  const finallies = READER.match(/\} finally \{[\s\S]*?\n {4}\}/g) ?? [];
  assert.ok(finallies.length >= 2, "expected both load paths to have a finally");
  for (const block of finallies) {
    assert.match(
      block,
      /onExtracting\(false\)/,
      "an extraction path can leave the page holding the stage",
    );
  }
});

test("the double-Escape instruction only appears when a page can trap focus", () => {
  assert.match(
    READER,
    /comparing\s*\?[\s\S]*?Escape twice/,
    "the reader tells the user to escape a page that is not on screen",
  );
});

test("one reading view, one control that toggles it", () => {
  // Two differently-worded buttons opened the same view and only one of them
  // could close it.
  assert.ok(!VIEW.includes("Read this page as text"), "the old second name survives");
  const at = VIEW.indexOf('className="browser-skip"');
  const skip = VIEW.slice(at, VIEW.indexOf("</button>", at));
  assert.match(skip, /aria-pressed=\{readerOpen\}/, "the skip control is not a toggle");
  assert.match(skip, /closeReader\(\)/, "the skip control can only ever open");
});

// --------------------------------------------------------------------------
// The live region — the only channel a screen-reader user has here
// --------------------------------------------------------------------------

const announce = await load(read("src/workspace/browserAnnounce.ts"));

const page = (extra = {}) => ({
  open: true,
  url: "https://example.test/a",
  title: "A",
  ready: "complete",
  ...extra,
});

test("a blocker that fails after the page settled is still announced", () => {
  // Without `protection` in the identity this is "nothing changed" — the poll
  // would suppress the one sentence that matters most.
  const said = announce.announcement(page(), page({ protection: { state: "failed", reason: "e" } }));
  assert.match(said, /Tracker blocking is off/);
});

test("a blocker still compiling is not narrated on every navigation", () => {
  const said = announce.announcement(null, page({ protection: { state: "unknown" } }));
  assert.doesNotMatch(said, /Tracker blocking/);
});

test("a working blocker adds nothing to the sentence", () => {
  assert.equal(announce.guardClause(page({ protection: { state: "active" } })), "");
});

test("closing the last page announces that the session was cleared", () => {
  const said = announce.announcement(page(), { open: false });
  assert.match(said, /cleared/);
  assert.match(said, /cookies/);
});
