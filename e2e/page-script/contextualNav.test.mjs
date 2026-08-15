/* THE CONTEXTUAL-NAVIGATION REDESIGN'S INVARIANTS.
 *
 * The two-level information architecture is mostly a claim about what CANNOT
 * happen: a destination cannot show another destination's items, a private
 * browser page cannot be written down, the second column cannot fall back to
 * Home's Library, ⌘T cannot open a browser page while you are somewhere else.
 * Every one of those regresses silently — the app still renders, it just
 * renders the wrong thing — so each gets a test here.
 *
 * The pure modules are transpiled and imported for real. The two that pull in
 * React or the Tauri bridge are SLICED first (same technique as
 * navRedesign.test.mjs and layoutKeys.test.mjs), so the functions under test
 * are the shipped ones rather than copies.
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

const DESTINATIONS = read("src/workspace/destinations.ts");
const VISIBILITY = read("src/workspace/fileVisibility.ts");
const PAGES = read("src/workspace/browserPages.ts");
const TABS = read("src/workspace/tabs.ts");
const TYPES = read("src/workspace/types.ts");
const SHELL = read("src/Workspace.tsx");
const SIDEBAR = read("src/workspace/Sidebar.tsx");
const LAYOUT = read("src/shell/useLayout.ts");
const SCHEMA = read("src-tauri/src/db/schema.rs");

/** Every destination the rail can reach, read out of the runtime list so this
 * file cannot fall behind the union. */
const AREAS = [...TYPES.matchAll(/^ {2}"(\w+)",$/gm)].map((m) => m[1]);

const dest = await load(DESTINATIONS);
const vis = await load(VISIBILITY);
// browserPages.ts imports React and the Tauri bridge; its pure half runs from
// the first exported helper up to the hook's own interface.
const pages = await load(
  PAGES.slice(PAGES.indexOf("export function pageHost"), PAGES.indexOf("export interface BrowserPagesApi")),
);

/* ---------- 1. the sidebar contract is total, and Library is Home's ---------- */

test("every destination declares what its second column is", () => {
  assert.ok(AREAS.length >= 12, `expected the full area list, got ${AREAS.length}`);
  for (const area of AREAS) {
    assert.ok(
      area in dest.SIDEBAR_TITLES,
      `${area} has no contextual sidebar declared — it would inherit Home's`,
    );
  }
});

test("only Home's column is called Library", () => {
  const named = AREAS.filter((a) => dest.SIDEBAR_TITLES[a] === "Library");
  assert.deepEqual(named.sort(), ["files", "home"]);
});

test("the second column is only announced as Home's in Home", () => {
  // Announcing "Library and sources" over a list of private browser pages is a
  // false statement made to exactly the readers who cannot check it.
  assert.equal(dest.sidebarRegionLabel("home"), "Library and sources");
  assert.equal(dest.sidebarRegionLabel("files"), "Library and sources");
  for (const area of AREAS.filter((a) => a !== "home" && a !== "files")) {
    assert.notEqual(
      dest.sidebarRegionLabel(area),
      "Library and sources",
      `${area} still announces itself as Home's library`,
    );
    assert.equal(dest.sidebarRegionLabel(area), dest.SIDEBAR_TITLES[area]);
  }
});

test("the shell names the region from the ACTIVE destination", () => {
  assert.match(SHELL, /aria-label=\{sidebarRegionLabel\(area\)\}/);
  assert.doesNotMatch(
    SHELL,
    /aria-label="Library and sources"/,
    "the hardcoded label is what made the browser announce itself as the library",
  );
});

test("a destination change remounts the column, so nothing stale can be revealed", () => {
  // Collapse/expand and focus mode can bring the column back after a switch;
  // without a keyed subtree the previous destination's rows paint first.
  assert.match(SHELL, /<LibraryPane\s+key=\{area\}/);
});

/* ---------- 2. ⌘T and ⌘W are scoped to the destination ---------- */

test("⌘T makes a browser page in the browser and nowhere else", () => {
  assert.equal(dest.newItemOf("browser"), "page");
  for (const area of AREAS.filter((a) => a !== "browser")) {
    assert.notEqual(
      dest.newItemOf(area),
      "page",
      `⌘T in ${area} would navigate the reader out of ${area}`,
    );
  }
});

test("the destinations that make something say what", () => {
  assert.equal(dest.newItemOf("sketch"), "sketch");
  assert.equal(dest.newItemOf("create"), "creation");
  assert.equal(dest.newItemOf("home"), "note");
  assert.equal(dest.newItemOf("files"), "note");
  // A destination with nothing to make must return null rather than a verb, so
  // the shell can leave the keypress alone instead of swallowing it.
  assert.equal(dest.newItemOf("skills"), null);
  assert.equal(dest.newItemOf("memory"), null);
  assert.equal(dest.newItemLabel("skills"), null);
});

test("⌘T is not claimed where the destination makes nothing", () => {
  const block = SHELL.slice(SHELL.indexOf("const newItemHere = useCallback"));
  const body = block.slice(0, block.indexOf("}, ["));
  assert.match(body, /if \(!kind \|\| \(kind === "page" && !s\.webOn\)\) return;/);
});

test("⌘T and ⌘W have ONE owner, and it is the native menu", () => {
  // macOS hands a key equivalent to the menu bar before the key window sees
  // it — and the private browser's page is a native child webview whose focus
  // a window `keydown` listener here never hears from, which is why a
  // React-only ⌘T did nothing in the very destination that needs it. Two
  // owners for one key means the press is handled twice.
  const MENU = read("src-tauri/src/menu.rs");
  assert.match(MENU, /id: "file\.new-item",[\s\S]{0,80}accel: Some\("CmdOrCtrl\+T"\)/);
  assert.match(MENU, /id: "file\.close-item",[\s\S]{0,80}accel: Some\("CmdOrCtrl\+W"\)/);
  // The predefined Close Window row owns ⌘W unconditionally and closes the
  // WINDOW — in a single-window app, that is ⌘W quitting Arcelle mid-page.
  assert.doesNotMatch(MENU, /Row::Platform\(Platform::CloseWindow\)/);
  const keys = SHELL.slice(SHELL.indexOf("function onKey"));
  const handler = keys.slice(0, keys.indexOf("window.addEventListener"));
  assert.doesNotMatch(handler, /e\.key === "w"/);
  assert.doesNotMatch(handler, /e\.key === "t" &&/);
  const NATIVE = read("src/shell/useNativeMenu.ts");
  assert.match(NATIVE, /"file\.new-item": \(r\) => r\.newItem\(\)/);
  assert.match(NATIVE, /"file\.close-item": \(r\) => r\.closeItem\(\)/);
});

test("⌘W closes an item, and only closes the window as a last resort", () => {
  const block = SHELL.slice(SHELL.indexOf("const closeItemHere = useCallback"));
  const body = block.slice(0, block.indexOf("}, ["));
  // In the reader's order: the page on screen, then the open document, and
  // only with nothing to close does the window itself go — which is what ⌘W
  // does on a Mac, now as the last case rather than the only one.
  const order = [
    body.indexOf('area === "browser" && pages.activeId'),
    body.indexOf("tabsRef.current.activeId"),
    body.indexOf("s.openFileRef.current"),
    body.indexOf("getCurrentWindow().close()"),
  ];
  assert.ok(order.every((at) => at >= 0), "every case must be handled");
  assert.deepEqual(order, [...order].sort((x, y) => x - y), "…in that order");
  assert.match(body, /guardLeave\("Closing this file"/, "unsaved edits are still asked about");
});

/* ---------- 3. browser pages are their own state, and never written down --- */

test("the document tab list has no page kind left to abuse", () => {
  assert.match(TABS, /export type TabKind = "file" \| "area";/);
  assert.doesNotMatch(TABS, /t\.kind === "page"/);
  // The validator is the boundary a saved setting comes back through.
  const validator = TABS.slice(TABS.indexOf("function isTab"));
  assert.doesNotMatch(validator, /"page"/);
});

test("nothing about the open pages is persisted", () => {
  // The browser's whole claim is that it writes no history. A list of pages you
  // were reading is a browsing history whatever it is called.
  //
  // Comments are stripped first: this module EXPLAINS at length that it writes
  // to none of these, and a test that read the explanation as the offence would
  // fail on the very prose that documents the rule.
  const code = PAGES.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const store of [/localStorage/, /sessionStorage/, /setSetting/, /indexedDB/]) {
    assert.doesNotMatch(code, store);
  }
});

test("closing a page selects a predictable neighbour", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  // The one to the right, else the one to the left.
  assert.equal(pages.heirAfterClose(list, "b", "b"), "c");
  assert.equal(pages.heirAfterClose(list, "c", "c"), "b");
  // Closing something you were not looking at never moves the selection.
  assert.equal(pages.heirAfterClose(list, "a", "c"), "c");
  // Closing the last one shows the destination's empty state, not a stale row.
  assert.equal(pages.heirAfterClose([{ id: "a" }], "a", "a"), "");
});

test("a page the assistant opened does not steal the reader's selection", () => {
  const now = [{ id: "a" }, { id: "b" }];
  assert.equal(pages.selectionAfterSync(now, "a"), "a");
});

test("a selection whose page is gone moves, rather than pointing at nothing", () => {
  assert.equal(pages.selectionAfterSync([{ id: "b" }], "a"), "b");
  assert.equal(pages.selectionAfterSync([], "a"), "");
});

test("returning to the browser with nothing selected shows a page", () => {
  assert.equal(pages.selectionAfterSync([{ id: "a" }, { id: "b" }], ""), "a");
});

test("reconciling keeps order, follows titles, and drops closed pages", () => {
  const prev = [
    { id: "a", title: "One", url: "https://one.test/" },
    { id: "b", title: "Two", url: "https://two.test/" },
  ];
  const next = pages.reconcilePages(prev, [
    { id: "b", title: "Two renamed", url: "https://two.test/x", active: true },
    { id: "c", title: "Three", url: "https://three.test/", active: false },
  ]);
  assert.deepEqual(
    next.map((p) => p.id),
    ["b", "c"],
    "surviving pages keep their place; new ones are appended",
  );
  assert.equal(next[0].title, "Two renamed", "titles follow navigation");
});

test("reconciling is a no-op when nothing changed, so React does not churn", () => {
  const prev = [{ id: "a", title: "One", url: "https://one.test/" }];
  const live = [{ id: "a", title: "One", url: "https://one.test/", active: true }];
  assert.equal(pages.reconcilePages(prev, live), prev);
});

test("Rust showing a different page than the sidebar highlights is corrected", () => {
  const live = [
    { id: "a", title: "", url: "", active: false },
    { id: "b", title: "", url: "", active: true },
  ];
  assert.equal(pages.pageToReassert(live, "a"), "a");
  // Agreement needs no correction, and a page Rust no longer has is the
  // reconciliation's business rather than this one's.
  assert.equal(pages.pageToReassert(live, "b"), "");
  assert.equal(pages.pageToReassert(live, "gone"), "");
  assert.equal(pages.pageToReassert([], "a"), "");
});

test("two pages with the same title stay tellable apart", () => {
  const one = { id: "1", title: "Results", url: "https://alpha.test/s?q=1" };
  const two = { id: "2", title: "Results", url: "https://www.beta.test/s?q=1" };
  assert.equal(pages.pageAccessibleName(one), "Results — alpha.test");
  assert.equal(pages.pageAccessibleName(two), "Results — beta.test");
  // A page whose title already names its site is not made to say it twice.
  assert.equal(
    pages.pageAccessibleName({ id: "3", title: "alpha.test", url: "https://alpha.test/" }),
    "alpha.test",
  );
});

test("a page with no address yet is named the way Rust names it", () => {
  assert.equal(pages.pageLabel({ id: "1", title: "", url: "" }), "New page");
  assert.equal(pages.pageLabel({ id: "1", title: "  ", url: "https://x.test/a" }), "x.test");
  // …and the same words on both sides, so a row does not rename itself the
  // moment the first reconciliation lands.
  assert.match(read("src-tauri/src/browser.rs"), /unwrap_or_else\(\|\| "New page"\.to_string\(\)\)/);
});

test("a row's second line never repeats its first", () => {
  // The installed build drew "Loading…" under a title that also read
  // "Loading…" — one fact stated twice, and the row's second line wasted.
  assert.equal(pages.pageSubtitle({ id: "1", title: "", url: "" }), "");
  assert.equal(pages.pageSubtitle({ id: "1", title: "", url: "https://x.test/a" }), "");
  assert.equal(
    pages.pageSubtitle({ id: "1", title: "Results", url: "https://x.test/a" }),
    "x.test",
  );
});

/* ---------- 4. the mixed top strip is gone from every tool destination ----- */

test("the document strip is Home's alone", () => {
  assert.equal(dest.showsDocumentTabs("home"), true);
  assert.equal(dest.showsDocumentTabs("files"), true);
  for (const area of AREAS.filter((a) => a !== "home" && a !== "files")) {
    assert.equal(
      dest.showsDocumentTabs(area),
      false,
      `${area} would draw room documents above its own workspace`,
    );
  }
});

test("the shell gates the strip on that rule rather than on its own copy", () => {
  assert.match(SHELL, /\{showsDocumentTabs\(area\) && \(\s*<TabStrip/);
});

test("a section-only object never earns a place in Home's strip", () => {
  const block = SHELL.slice(SHELL.indexOf("tabbedFileRef"));
  assert.match(block, /libraryVisibility === "sectionOnly"/);
});

/* ---------- 5. one object, two independent facts about it ---------- */

const file = (over = {}) => ({
  id: "f1",
  name: "Portfolio map.sketch",
  mimeType: "application/json",
  originDestination: "sketch",
  libraryVisibility: "sectionOnly",
  ...over,
});

test("everything a room already held stays visible in Home", () => {
  // The migration is the column default. A row written before this existed
  // comes back as library/linked, which is what those rooms mean.
  assert.match(SCHEMA, /origin_destination TEXT NOT NULL DEFAULT 'library'/);
  assert.match(SCHEMA, /library_visibility TEXT NOT NULL DEFAULT 'linked'/);
  assert.match(
    SCHEMA,
    /ALTER TABLE files ADD COLUMN library_visibility TEXT NOT NULL DEFAULT 'linked'/,
    "existing rooms must take the same default, or their files would vanish",
  );
});

test("section-only hides an object from Home and from nowhere else", () => {
  assert.equal(vis.isLibraryVisible(file()), false);
  assert.equal(vis.isLibraryVisible(file({ libraryVisibility: "linked" })), true);
  const all = [file({ id: "a" }), file({ id: "b", libraryVisibility: "linked" })];
  assert.deepEqual(vis.libraryFiles(all).map((f) => f.id), ["b"]);
});

test("a value the app has never seen is treated as visible, not as hidden", () => {
  // Being wrong in the direction of showing a file is recoverable; hiding
  // somebody's document because a string drifted is not.
  assert.equal(vis.isLibraryVisible(file({ libraryVisibility: "" })), true);
  assert.equal(vis.isLibraryVisible(file({ libraryVisibility: undefined })), true);
});

test("only objects made inside a destination carry a placement chip", () => {
  assert.equal(vis.libraryStatus(file({ originDestination: "library" })), null);
  assert.deepEqual(vis.libraryStatus(file()), {
    linked: false,
    label: "Section only",
    where: "Sketches",
  });
  assert.deepEqual(vis.libraryStatus(file({ libraryVisibility: "linked" })), {
    linked: true,
    label: "In Library",
    where: "Sketches",
  });
});

test("the section is named the way the rail names it", () => {
  assert.equal(vis.sectionLabel("sketch"), "Sketches");
  assert.equal(vis.sectionLabel("create"), "Creations");
  assert.equal(vis.sectionLabel("recordings"), "Recordings");
});

test("promotion states the value instead of toggling it, so it is idempotent", () => {
  const actions = read("src/workspace/fileActions.ts");
  assert.match(actions, /api\.setFileInLibrary\(id, linked\)/);
  assert.doesNotMatch(actions, /setFileInLibrary\(id, !/, "a toggle would race the agent");
  const rust = read("src-tauri/src/db/files.rs");
  assert.match(rust, /SET library_visibility = \?2/, "the value is stated");
  // Removing the Home reference must never touch the object itself.
  assert.doesNotMatch(rust, /set_library_visibility[\s\S]{0,400}DELETE/);
});

test("removing from the Library says, in the UI, that it does not delete", () => {
  const viewer = read("src/workspace/ViewerPane.tsx");
  assert.match(viewer, /Remove from Library/);
  assert.match(viewer, /this does not delete it/);
  assert.match(viewer, /no duplicate/, "the Add dialog must rule out a copy");
});

test("the agent may promote, but is told not to do it on its own", () => {
  const agent = read("src-tauri/src/commands/agent.rs");
  const spec = agent.slice(agent.indexOf('"name": "set_in_library"'));
  const description = spec.slice(0, spec.indexOf('"parameters"'));
  assert.match(description, /never automatically/);
  assert.match(description, /nothing is exported or copied/i);
  // …and the act is reported, like any other room write.
  const arm = agent.slice(agent.indexOf('"set_in_library" => {'));
  assert.match(arm.slice(0, 1200), /effects\.wrote = true/);
  assert.match(arm.slice(0, 1200), /no copy was made/);
});

test("the agent can tell a section-only object from a Library one", () => {
  assert.match(read("src-tauri/src/db/files.rs"), /section only — in \{origin\}/);
});

/* ---------- 5b. demotion changes one list, and nothing else ---------- */

// tabs.ts is a React hook; its selection rules are the pure half above it.
const tabRules = await load(
  TABS.slice(
    TABS.indexOf("export function selectionAfterDrop"),
    TABS.indexOf("/** The workspace's open tabs"),
  ),
);
const strip = [
  { id: "file:a", kind: "file", ref: "a", title: "A" },
  { id: "file:b", kind: "file", ref: "b", title: "B" },
];

test("removing the open document from the Library leaves it on screen", () => {
  // The reported defect: demoting the sketch being drawn elected the next tab
  // and the apply effect opened it, so "stop listing this in Home" read as
  // "close this and open something else".
  assert.equal(
    tabRules.selectionAfterDrop(strip, "file:demoted", tabRules.heirOfNothing),
    "",
  );
});

test("a trashed document still hands the pane to a neighbour", () => {
  assert.equal(
    tabRules.selectionAfterDrop(strip, "file:gone", tabRules.heirOfLast),
    "file:b",
  );
});

test("a selection that survived the drop is never disturbed", () => {
  for (const heir of [tabRules.heirOfLast, tabRules.heirOfNothing]) {
    assert.equal(tabRules.selectionAfterDrop(strip, "file:a", heir), "file:a");
    assert.equal(tabRules.selectionAfterDrop(strip, "", heir), "");
  }
});

test("the Library-visibility drop is the one that cannot navigate", () => {
  // Which verb this effect calls IS the fix; the two differ only in whether
  // they may move the reader, so a silent swap back would regress it.
  const effect = SHELL.slice(SHELL.indexOf("const shown = new Set(libraryFiles"));
  assert.match(effect.slice(0, 200), /tabs\.unlist\(/);
  assert.doesNotMatch(effect.slice(0, 200), /tabs\.prune\(/);
});

/* ---------- 5c. a confirmation does not become wallpaper ---------- */

const toasts = await load(read("src/workspace/toastStack.ts"));
const say = (over = {}) => ({ id: 1, kind: "success", text: "t", ...over });
const undo = { label: "Undo", run: () => {} };

test("changing your mind about one object leaves one message, not five", () => {
  // The live report: promote/demote a sketch a few times and five undismissed
  // confirmations sit over the workspace, each offering to undo a different
  // moment in the past.
  let stack = [];
  for (let i = 0; i < 5; i++) {
    stack = toasts.stackToast(stack, say({ id: i, about: "library:f1" }));
  }
  assert.equal(stack.length, 1);
  assert.equal(stack[0].id, 4, "the surviving message must be the true one");
});

test("messages about different objects still stack", () => {
  const stack = toasts.stackToast(
    toasts.stackToast([], say({ id: 1, about: "library:f1" })),
    say({ id: 2, about: "library:f2" }),
  );
  assert.equal(stack.length, 2);
});

test("a confirmation with an Undo on it still expires", () => {
  // The old rule — an action means it waits forever — is what left them there.
  assert.equal(toasts.toastLifeMs(say({ about: "library:f1", action: undo })), 12000);
  assert.equal(toasts.toastLifeMs(say({ about: "library:f1" })), 5000);
});

test("an error, and an offer that is the only route to something, still wait", () => {
  assert.equal(toasts.toastLifeMs(say({ kind: "error" })), null);
  assert.equal(toasts.toastLifeMs(say({ action: undo })), null);
  assert.equal(
    toasts.toastLifeMs(say({ kind: "error", about: "library:f1" })),
    null,
    "an object key must never shorten a failure's life",
  );
});

test("a burst of confirmations can never push a failure off the screen", () => {
  let stack = [toasts.stackToast([], say({ id: 0, kind: "error" }))[0]];
  for (let i = 1; i <= 8; i++) stack = toasts.stackToast(stack, say({ id: i }));
  assert.ok(stack.length <= toasts.MAX_TOASTS);
  assert.ok(stack.some((t) => t.kind === "error"), "the error was evicted");
});

test("a failure that has stopped being true is retired, not left on screen", () => {
  // "Could not open that file" sat over the workspace indefinitely — including
  // over the very file it named, after a second click opened it. Errors still
  // never expire on a timer; succeeding at the act one describes retires it.
  const stack = [
    say({ id: 1, kind: "error", about: "open:f1" }),
    say({ id: 2, kind: "error", about: "open:f2" }),
    say({ id: 3 }),
  ];
  const after = toasts.clearToastsAbout(stack, "open:f1");
  assert.deepEqual(after.map((t) => t.id), [2, 3]);
});

test("a second attempt replaces the first failure rather than stacking on it", () => {
  let stack = toasts.stackToast([], say({ id: 1, kind: "error", about: "open:f1" }));
  stack = toasts.stackToast(stack, say({ id: 2, kind: "error", about: "open:f1" }));
  assert.equal(stack.length, 1);
  assert.equal(stack[0].id, 2);
});

test("opening a file names it, offers the way back, and clears on success", () => {
  const src = read("src/workspace/fileActions.ts");
  const fn = src.slice(src.indexOf("async function viewFile("));
  const body = fn.slice(0, fn.indexOf("\n  }"));
  // Unanswerable in a room of two hundred: the click that failed is over, and
  // the message outlives the selection that would have said which file it was.
  assert.match(body, /Could not open \$\{what\}/);
  assert.match(body, /displayName\(known\.name\)/);
  assert.match(body, /label: "Try again"/);
  assert.match(body, /s\.forgetToastsAbout\(about\)/);
  // Retired only after the read succeeded — the early return is above it.
  assert.ok(
    body.indexOf("s.forgetToastsAbout(about)") > body.indexOf("return;"),
    "a failure must not clear itself",
  );
});

/* ---------- 6. a document always appears in the destination that owns it --- */

test("the destinations that hold their own documents say which", () => {
  const fn = TYPES.slice(TYPES.indexOf("export function areaHoldsFile"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  for (const [area, test_] of [
    ["recordings", /isRecordingFile/],
    ["scripts", /scripts\.some/],
    ["sketch", /isSketchFile/],
    ["create", /isCreationFile/],
  ]) {
    assert.match(body, new RegExp(`area === "${area}"`), `${area} must answer`);
    assert.match(body, test_);
  }
  assert.match(body, /return false;\s*$/, "anything else holds no files");
});

test("a creation is identified by where it came from, never by its pixels", () => {
  // Matching on mime type would sweep in every imported photo and every saved
  // screenshot — things nobody asked Creations to list, and whose rows would
  // offer to re-render them.
  const fn = TYPES.slice(TYPES.indexOf("export function isCreationFile"));
  assert.match(fn.slice(0, 200), /originDestination === "create"/);
  assert.doesNotMatch(fn.slice(0, 200), /mimeType/);
});

test("a foreign document moves the app Home in one commit", () => {
  const block = SHELL.slice(SHELL.indexOf("A DOCUMENT ALWAYS APPEARS"));
  const body = block.slice(0, block.indexOf("}, [s.openFile?.id"));
  assert.match(body, /areaHoldsFile\(area, open\.id, s\.files, s\.scripts\)/);
  assert.match(body, /s\.setArea\("files"\)/);
  // …and never on the strength of a file list that has not caught up, which
  // would throw the reader out of the destination they are working in.
  assert.match(body, /const known = s\.files\.some/);
});

test("each destination remembers its own selection", () => {
  assert.match(SHELL, /const lastFileRef = useRef<Partial<Record<WorkArea, string>>>/);
  const block = SHELL.slice(SHELL.indexOf("const openArea = useCallback"));
  const body = block.slice(0, block.indexOf("[showArea, guardLeave"));
  assert.match(body, /lastFileRef\.current\[area\] =/, "remember on the way out");
  assert.match(body, /lastFileRef\.current\[next\]/, "restore on the way in");
  assert.match(body, /s\.files\.some\(\(f\) => f\.id === want\)/, "never reopen a deleted file");
});

/* ---------- 7. the column itself ---------- */

test("no destination can render a blank column headed Library", () => {
  // The heading comes from the contract, and a destination that declares none
  // renders no column at all rather than an empty one.
  assert.match(SIDEBAR, /const heading = SIDEBAR_TITLES\[area\];/);
  assert.match(SIDEBAR, /if \(heading === null\) return null;/);
  assert.doesNotMatch(SIDEBAR, /AREA_HEADINGS/, "the old local map is gone");
});

test("the browser's column lists pages and no longer explains where they are", () => {
  assert.match(SIDEBAR, /aria-label="Open private pages"/);
  assert.doesNotMatch(SIDEBAR, /Open pages live in the tab strip/);
  assert.match(SIDEBAR, /keeps no history, cookies or cache between/);
});

test("a page row can be closed without a pointer", () => {
  const nav = SIDEBAR.slice(SIDEBAR.indexOf("function PagesNav"));
  const body = nav.slice(0, nav.indexOf("\n/* ----------"));
  assert.match(body, /e\.key === "Backspace" \|\| e\.key === "Delete"/);
  assert.match(body, /aria-label=\{`Close \$\{pageAccessibleName\(p\)\}`\}/);
  assert.match(body, /tabIndex=\{current \? 0 : -1\}/, "a tablist owes roving focus");
  assert.match(body, /ArrowDown|ArrowUp/);
});

test("the map's column is the map's, not the room's file list", () => {
  const nav = SIDEBAR.slice(SIDEBAR.indexOf("function MapNav"));
  assert.doesNotMatch(nav.slice(0, 3000), /FileRow/);
  assert.equal(dest.SIDEBAR_TITLES.map, "Map");
});

test("instructional paragraphs stand down once a destination has content", () => {
  for (const guard of [
    /\{workflows\.length === 0 && \(\s*<p className="area-nav-intro">/,
    /\{s\.scripts\.length === 0 && \(\s*<p className="area-nav-intro">/,
    /\{s\.skills\.length === 0 && \(\s*<p className="area-nav-intro">/,
    /\{s\.memories\.length === 0 && \(\s*<p className="area-nav-intro">/,
  ]) {
    assert.match(SIDEBAR, guard);
  }
});

/* ---------- 8. layout stays deterministic ---------- */

test("a narrow window collapses the sidebar before it crushes the workspace", () => {
  const block = LAYOUT.slice(LAYOUT.indexOf("if (isNarrow)"));
  assert.match(
    block.slice(0, 400),
    /\["center", "ai", "library"\]/,
    "the workspace is picked first, so the sidebar is what gives way",
  );
});
