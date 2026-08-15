/* The navigation redesign's invariants — the ones that are true of the CODE
 * rather than of a screenshot, and that would each fail silently.
 *
 * Five of these guard a specific way the work could regress into a bug that
 * looks like nothing at all:
 *
 *   • a sidebar preference outliving the build that wrote it (a retired area
 *     rendering a row that navigates nowhere; a NEW area invisible to everyone
 *     who ever opened the customize sheet);
 *   • the automatic narrow-window collapse reaching storage, which costs the
 *     reader their labels permanently on every window at every width;
 *   • a stored `hidden.center: true` reopening a room with no workspace and no
 *     control able to bring it back;
 *   • an area existing in the sidebar and not in ⌘K, which is unreachable for
 *     the embodiment loop and hard to find for everyone else;
 *   • `setAiTab` without `showPane`, which switches a tab behind a shut column.
 *
 * The pure functions are extracted and transpiled rather than imported:
 * navPrefs.tsx pulls in React and JSX icons, which do not resolve under a bare
 * node test. Same technique as layoutKeys.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

const NAV = read("src/shell/navPrefs.tsx");
const LAYOUT = read("src/shell/useLayout.ts");
const TYPES = read("src/workspace/types.ts");
const RAIL = read("src/shell/ActivityRail.tsx");
const OVERLAYS = read("src/workspace/Overlays.tsx");
const MISC = read("src/workspace/miscActions.ts");
const TOPBAR = read("src/workspace/TopBar.tsx");

/* ---------- the catalog, read out of the source ---------- */

/** Every destination key in NAV_AREAS, in catalog order. */
const CATALOG = [...NAV.matchAll(/\{ key: "(\w+)", label:/g)].map((m) => m[1]);
/** The WorkArea runtime list, minus the default lens. */
const AREAS = [...TYPES.matchAll(/^\s{2}"(\w+)",$/gm)].map((m) => m[1]).filter((k) => k !== "files");

/* ---------- transpile the pure half of navPrefs ---------- */

const slice = NAV.slice(
  NAV.indexOf("export const DEFAULT_PINNED"),
  NAV.indexOf("export interface NavPrefsApi"),
);
const PRELUDE = `
const WORK_AREAS = ${JSON.stringify(["files", ...AREAS])};
const CANONICAL = ${JSON.stringify(CATALOG)};
`;
const JS = ts.transpileModule(PRELUDE + slice, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

/** A throwaway localStorage, so each case starts from a known store. */
function withStore(raw) {
  const map = new Map();
  if (raw !== undefined) map.set("prNav:v1", raw);
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
  return map;
}

withStore(undefined);
const nav = await import(`data:text/javascript,${encodeURIComponent(JS)}`);

/* ---------- and the real PRESETS object, so it is asserted, not grepped ---- */

const PRESET_JS = ts.transpileModule(
  LAYOUT.slice(LAYOUT.indexOf("export type PresetName"), LAYOUT.indexOf("type Persisted")),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
const { PRESETS } = await import(`data:text/javascript,${encodeURIComponent(PRESET_JS)}`);

/* ================================================================ catalog */

test("the sidebar catalog covers every area, and only real areas", () => {
  assert.deepEqual(
    [...CATALOG].sort(),
    [...AREAS].sort(),
    "NAV_AREAS and WORK_AREAS disagree — areaDef() throws at runtime for a " +
      "union member with no catalog row, and an extra row navigates nowhere",
  );
  // The Library is a PANE. A row for it here would be a mode wearing a
  // destination's clothes, which is the confusion the redesign removed.
  assert.ok(!CATALOG.includes("library"), "the Library is not a destination");
  assert.ok(!CATALOG.includes("files"), "'files' is the default lens, not a place");
});

test("the shipped sidebar pins four and holds the rest back", () => {
  const { pinned, more } = nav.splitPrefs(nav.defaultPrefs());
  assert.deepEqual(pinned, ["home", "recordings", "browser", "sketch"]);
  assert.equal(pinned.length + more.length, CATALOG.length, "a destination went missing");
  assert.ok(more.includes("create"), "Create belongs under More tools");
});

/* ============================================== stored-preference survival */

test("a stored order survives, and a NEW area still appears", () => {
  // A record written by a build that had never heard of Sketch.
  const older = CATALOG.filter((k) => k !== "sketch");
  withStore(JSON.stringify({ pinned: ["home"], order: older }));
  const prefs = nav.loadPrefs();
  assert.ok(
    prefs.order.includes("sketch"),
    "an area this build has and the record does not must appear, or a new " +
      "feature is invisible to everyone who ever customized their sidebar",
  );
  assert.deepEqual(
    prefs.order.filter((k) => k !== "sketch"),
    older,
    "the reader's own order was not preserved",
  );
});

test("a RETIRED area is dropped rather than round-tripped", () => {
  withStore(JSON.stringify({ pinned: ["home", "wormhole"], order: ["wormhole", ...CATALOG] }));
  const prefs = nav.loadPrefs();
  assert.ok(!prefs.order.includes("wormhole"), "a dead key would render a row navigating nowhere");
  assert.ok(!prefs.pinned.includes("wormhole"));
});

test("an EMPTY pinned list is a real choice; an ABSENT one is not", () => {
  withStore(JSON.stringify({ pinned: [], order: CATALOG }));
  assert.deepEqual(nav.loadPrefs().pinned, [], "everything-under-More-tools is allowed");

  withStore(JSON.stringify({ order: CATALOG }));
  assert.deepEqual(
    nav.loadPrefs().pinned,
    ["home", "recordings", "browser", "sketch"],
    "no pinned key at all means never customized — take the defaults",
  );
});

test("junk in storage falls back rather than throwing", () => {
  for (const raw of ["not json", "null", "[]", '"nope"', "7"]) {
    withStore(raw);
    assert.deepEqual(nav.loadPrefs(), nav.defaultPrefs(), `bad record: ${raw}`);
  }
});

/* ============================================================ reordering */

test("a row moves within its own group and never across it", () => {
  const prefs = nav.defaultPrefs();
  const before = nav.splitPrefs(prefs);

  // Recordings is pinned and second. Down one → it swaps with Private browser,
  // and the More tools group is untouched.
  const moved = nav.moveWithin(prefs, "recordings", 1);
  const after = nav.splitPrefs(moved);
  assert.deepEqual(after.pinned, ["home", "browser", "recordings", "sketch"]);
  assert.deepEqual(after.more, before.more, "the other group moved");

  // Same for a row inside More tools: Room Map up one steps past Create,
  // which is the row above it IN ITS GROUP — not in the underlying order.
  const m = nav.splitPrefs(nav.moveWithin(prefs, "map", -1));
  assert.deepEqual(m.more.slice(0, 2), ["map", "create"]);
  assert.deepEqual(m.pinned, before.pinned, "the pinned group moved");
});

test("a move at the end of a group is a no-op, by identity", () => {
  const prefs = nav.defaultPrefs();
  assert.equal(nav.moveWithin(prefs, "home", -1), prefs, "must not re-render subscribers");
  assert.equal(nav.moveWithin(prefs, "sketch", 1), prefs);
  assert.equal(nav.moveWithin(prefs, "memory", 1), prefs);
});

/* ================================================================= layout */

test("the only ⌘-key this file still claims is the ⌘3 alias", () => {
  // ⌘1 and ⌘2 moved to the native View menu, which macOS consults BEFORE the
  // key window — a listener here would be a second owner for the same press,
  // and a pane toggled twice never moves. The other half of this invariant
  // (that the menu declares them) is menu.rs's
  // `the_pane_keys_are_declared_once_each`, and nativeMenu.test.mjs is what
  // holds the two files to the same story.
  const map = /export const PANE_KEYS[^=]*=\s*\{([^}]*)\}/.exec(LAYOUT)?.[1];
  assert.ok(map, "PANE_KEYS not found");
  assert.match(map, /"3":\s*"ai"/, "⌘3 has always meant the assistant — keep it");
  assert.ok(!/"1":/.test(map), "⌘1 belongs to the View menu now");
  assert.ok(!/"2":/.test(map), "⌘2 belongs to the View menu now");
  assert.ok(!/"\d":\s*"center"/.test(map), "no key may hide the workspace");
});

test("togglePane cannot be handed the workspace", () => {
  assert.match(
    LAYOUT,
    /const togglePane = useCallback\(\s*\(key: SidePane\)/,
    "the centre must be excluded by the TYPE, not by a runtime check that a " +
      "caller can forget",
  );
  assert.match(LAYOUT, /export type SidePane = Exclude<PaneKey, "center">/);
});

test("a stored hidden.center is read as false", () => {
  // A record written before the workspace became permanent would otherwise
  // reopen the room with an empty middle column and no way back.
  const init = LAYOUT.slice(
    LAYOUT.indexOf("const [hidden, setHidden]"),
    LAYOUT.indexOf("const [focusPane"),
  );
  assert.ok(
    /center:\s*false,/.test(init),
    "hidden.center must be pinned false in the initialiser",
  );
  assert.ok(
    !/center:\s*persisted\.hidden\?\.center/.test(init),
    "the stored value is still being read",
  );
});

test("every preset fully states the layout it means", () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    // FULLY stated, both maps, all three panes. A preset that omitted a value
    // would inherit whatever the splitters were last dragged to, so applying
    // the same one twice would land in two different places — which is the
    // one thing a named layout must never do.
    assert.deepEqual(
      Object.keys(p.hidden).sort(),
      ["ai", "center", "library"],
      `${name}: hidden is not fully stated`,
    );
    assert.deepEqual(
      Object.keys(p.ratios).sort(),
      ["ai", "center", "library"],
      `${name}: ratios are not fully stated`,
    );
    assert.equal(p.hidden.center, false, `${name} hides the workspace, which is not a thing`);
    const sum = p.ratios.library + p.ratios.center + p.ratios.ai;
    assert.ok(Math.abs(sum - 1) < 0.001, `${name}: ratios sum to ${sum}, not 1`);
    assert.ok(p.label && p.hint, `${name} needs a name and a one-line reason`);
  }
  assert.deepEqual(Object.keys(PRESETS), ["focus", "research", "review"]);
  // Research is the shape a new wide room opens in, so it must hide nothing —
  // the assistant staying open by default is what keeps Chat, Studio, Activity
  // and the approvals queue as discoverable as they were.
  assert.deepEqual(PRESETS.research.hidden, { library: false, center: false, ai: false });
});

test("the narrow-window collapse never reaches storage", () => {
  // THE TRAP: the persist effect below writes on every change, so an
  // auto-collapse assigned to `railExpanded` is indistinguishable from the
  // reader choosing the icon strip — and the labels never come back.
  const persist = LAYOUT.slice(
    LAYOUT.indexOf("localStorage.setItem("),
    LAYOUT.indexOf("/** What is actually collapsed right now"),
  );
  assert.match(persist, /railExpanded/, "the preference is what gets stored");
  assert.ok(
    !persist.includes("railAutoCollapsed"),
    "the derived collapse must never be serialised",
  );
  // ...and nothing may assign it either.
  assert.ok(
    !/setRailExpanded\((?:true|false)\)/.test(
      LAYOUT.slice(LAYOUT.indexOf("RAIL_NARROW_QUERY"), LAYOUT.indexOf("const gridRef")),
    ),
    "the media-query listener must write its own state, not the preference",
  );
  // The rail reads the derived value; only the expander knows the preference.
  assert.match(LAYOUT, /railExpanded: railExpanded && !railAutoCollapsed/);
  assert.match(RAIL, /!layout\.railAutoCollapsed && \(/, "the expander must hide while forced");
});

/* ============================================ reachability + pane reveals */

test("⌘K lists every destination the sidebar can hold", () => {
  // This is what pays for the More tools disclosure: unpinned areas are not in
  // the DOM, so the palette is the only complete route — and the only one the
  // embodiment loop has.
  const palette = OVERLAYS.slice(
    OVERLAYS.indexOf("const acts: PaletteAction[]"),
    OVERLAYS.indexOf("if (!layout)"),
  );
  const missing = CATALOG.filter((k) => {
    // map/memory/browser/workflows/scripts route through named actions rather
    // than a setArea call, so match on the row id instead of the area string.
    const id = k === "map" ? "go-map" : `go-${k}`;
    return !palette.includes(`id: "${id}"`);
  });
  assert.deepEqual(missing, [], `areas with no ⌘K row: ${missing.join(", ")}`);
});

test("picking a chat message out of ⌘K reveals the pane it lives in", () => {
  const fn = MISC.slice(
    MISC.indexOf("function activateResult"),
    MISC.indexOf("s.setShowSearch(false)"),
  );
  assert.match(fn, /s\.setAiTab\("chat"\)/);
  assert.match(
    fn,
    /layout\?\.showPane\("ai"\)/,
    "switching the tab without showing the pane selects a chat behind a " +
      "closed column, which looks exactly like the click doing nothing",
  );
});

test("the Assistant's marks appear only while its pane is shut", () => {
  assert.match(TOPBAR, /const aiShowing = layout\.visible\.includes\("ai"\)/,
    "must track what is ON SCREEN — in narrow mode the pane can be un-hidden and still not visible");
  assert.match(TOPBAR, /\{!aiShowing && approvals > 0 &&/);
  assert.match(TOPBAR, /\{!aiShowing && approvals === 0 && running > 0 &&/,
    "the two marks are different facts and must not be summed into one number");
});

test("the toolbar keeps one popover slot, not a flag per menu", () => {
  for (const stale of ["modelMenuOpen", "roomMenuOpen", "qaMenuOpen", "scriptMenuOpen"]) {
    assert.ok(!TOPBAR.includes(stale), `${stale} survived — the exclusion is hand-maintained again`);
  }
  assert.match(TOPBAR, /s\.openMenu === "layout"/);
  assert.match(TOPBAR, /s\.openMenu === "scripts"/, "the scripts menu used to stack over the model picker");
});
