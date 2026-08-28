/* Capture the app's screens as PNGs for the vision dataset.
 *
 * COVERAGE IS THE JOB. The calibration set is read to decide which parts of the
 * model are genuinely unused, so a screen type missing from it looks like idle
 * machinery and gets pruned — and the loss only shows up later, on that screen,
 * in production. Breadth therefore beats polish everywhere below: a handful of
 * each area × state × theme × viewport, rather than many of the pretty ones.
 *
 * Writes `data/vision/images/*.png` plus `data/vision/_shots.jsonl`, one line
 * per shot carrying what it depicts. That manifest is what lets the question
 * generator ask something true about each image instead of guessing from
 * pixels, and what makes a coverage gap countable rather than a hunch.
 *
 *   npm run capture                  # the full matrix
 *   SKIP_BUILD=1 CAPTURE_SMOKE=1 npm run capture   # a slice, to check wiring
 *
 * CAPTURE_SMOKE narrows every list (two areas, one theme, one size, two files)
 * but still runs EVERY spec, because the wiring worth checking is the
 * selectors — a renamed button drops its screens silently, and a smoke run
 * that skipped seven of the eight specs could not see that. It prints the
 * coverage it did not reach instead of failing on it; the full run throws.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "..", "..", "sidecar", "data", "vision");
const IMAGES = path.join(OUT, "images");
const MANIFEST = path.join(OUT, "_shots.jsonl");

const SMOKE = !!process.env.CAPTURE_SMOKE;

/** The nine product areas, by their stable `data-area` attribute.
 *
 * The Browser was the missing ninth: the mock answered none of its commands,
 * so the area could not be walked at all and the dataset had no picture of it.
 * It contributes its `full` shot like any other area — its start screen is
 * static, so `empty`/`loading`/`error` are reported as unreached below for the
 * same reason the Recordings start screen is. Find — a tenth, added by the
 * notebook pass — was retired by P1-2: it was a whole page for a search that
 * now expands out of ⌘K instead, so there is no standalone area screen of it
 * left to capture (⌘K itself is a floating overlay, not an area).
 *
 * The labels here are the BREADCRUMB wording (`AREA_CRUMBS` in ViewerPane),
 * which is what names a place now that areas are no longer tabs. */
const AREAS = [
  ["home", "Home"],
  ["map", "Room Map"],
  ["recordings", "Recordings"],
  ["workflows", "Workflows"],
  ["scripts", "Scripts"],
  ["skills", "Skills"],
  ["memory", "Memory & scratch pad"],
  ["connectors", "Connectors"],
  ["create", "Create"],
  ["sketch", "Sketch"],
  ["browser", "Private browser"],
];

/** Every visual state a pane can be in — not just the stocked one. */
const STATES = ["full", "empty", "loading", "error"];

const THEMES = ["dark", "light"];

/** Window sizes the app actually runs at, so aspect ratios in the data match
 * the ones `view_screenshot` produces. */
const VIEWPORTS = [
  [1440, 900],
  [1280, 800],
  [1024, 768],
  [1680, 1050],
];

/** Fixture files, one per viewer kind — markdown, PDF, docx, CSV, code, audio. */
const FILES = [
  ["Arcelle UX direction.md", "markdown"],
  ["clean-code.pdf", "pdf"],
  ["review-sample.docx", "docx"],
  ["Apollo missions.csv", "spreadsheet"],
  ["prepare_release.py", "code"],
  ["Product review.m4a", "recording"],
];

/** Every Settings page, by the label the nav actually renders. */
const SETTINGS_PAGES = [
  "AI & behavior",
  "Voice",
  "Privacy & recovery",
  "Connections",
  "History & storage",
  "App",
];

/** Pane-layout shots: stable Layout-menu action id and what it depicts. */
const LAYOUT_TOGGLES = [
  ["layout-toggle-library", "library pane hidden"],
  ["layout-toggle-assistant", "AI pane hidden"],
  ["layout-toggle-focus", "focus mode"],
];

const PALETTE_DETAILS = ["command palette open", "command palette with results"];
const CHROME_DETAILS = ["rail collapsed", "rail expanded"];
const CHAT_DETAILS = ["agents starting", "agent running", "agents done"];

/** The room's stock content, by the name the mock always serves. A pane that
 * still lists these is a FULL pane — whatever state was asked for. */
const STOCK = FILES.map(([name]) => name.replace(/\.[^.]+$/, ""));

/** Trim a list down for the smoke run, which is about wiring, not breadth. */
const few = (list, n) => (SMOKE ? list.slice(0, n) : list);

let n = 0;
const shots = [];
// The `after` hook still runs when the first navigation/render fails. Coverage
// is meaningful only after the app itself reached a rendered workspace; until
// then, report the readiness failure instead of masking it with hundreds of
// derivative "missing coverage" entries.
let appReady = false;
/** `state/area` pairs whose screenshot was NOT taken because the state never
 * reached the pane — deduplicated, since the same pair recurs once per theme
 * and window size. Reported at the end: a missing shot is recoverable, a
 * mislabelled one silently teaches the model the wrong thing. */
const unreached = new Set();

function ensureDirs() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(IMAGES, { recursive: true });
}

/** Load the app at a given mock state and theme, with layout reset.
 *
 * The theme is written BEFORE the load that renders: `initTheme` stamps
 * `data-theme` on <html> before first paint, so setting localStorage after the
 * page is up leaves the DOM on the previous palette and the screenshot lies
 * about which theme it shows. */
async function open({ state = "full", theme = "dark", wipe = true } = {}) {
  const url = `${browser.options.baseUrl}${state === "full" ? "" : `?qa_state=${state}`}`;
  await browser.url(url);
  await browser.execute(
    (t, w) => {
      localStorage.setItem("prTheme", t);
      if (w) {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith("prLayout:")) localStorage.removeItem(k);
        }
      }
    },
    theme,
    wipe,
  );
  await browser.url(url);
  // `loading` never settles by design, so the rail is the only thing that can
  // be waited on — the pane inside it is the subject of the screenshot.
  await $(".activity-rail").waitForExist({ timeout: 20_000 });
  appReady = true;
  await browser.pause(state === "loading" ? 700 : 500);
}

async function shoot(meta) {
  const name = `${String(++n).padStart(4, "0")}.png`;
  await browser.saveScreenshot(path.join(IMAGES, name));
  shots.push({ image: `images/${name}`, ...meta });
}

/** Reveal every destination, pinned or not.
 *
 * The sidebar shows a short pinned set and keeps the rest behind a "More
 * tools" disclosure, so a `data-area` button for an unpinned place does not
 * exist in the DOM until that is opened. Harnesses walk ALL the areas, so
 * they open it once up front rather than guessing which tier a place is in.
 * Safe to call repeatedly: it only clicks a disclosure that is closed. */
async function revealAllTools() {
  const more = await $('[data-testid="more-tools"]');
  if (!(await more.isExisting())) return;
  if ((await more.getAttribute("aria-expanded")) === "true") return;
  await more.click();
  await browser.pause(200);
}

async function goArea(area) {
  await revealAllTools();
  const btn = await $(`.rail-button[data-area="${area}"]`);
  if (!(await btn.isExisting())) return false;
  await btn.click();
  await browser.pause(350);
  return true;
}

/** The area's own pane — the subject of a `kind: "area"` shot — as text. */
async function paneText() {
  const pane = await $(".pane-center");
  if (!(await pane.isExisting())) return "";
  return (await pane.getText()).replace(/\s+/g, " ").trim();
}

/** Why this pane does NOT show the state that was asked for, or `null` if it
 * does.
 *
 * `?qa_state=` only reaches commands `qa/qa-mock.js` recognises as reads. It
 * used to recognise them by name prefix alone, so `front_page`, `room_graph`
 * and `mcp_status` sailed through and the pane came back fully stocked while
 * the manifest said "empty", "loading" or "error". A mislabelled screenshot is
 * worse than a missing one: the whole point of this dataset is that the
 * manifest line is true of the pixels. Both rules below are evidence, not
 * heuristics — an identical pane cannot have changed state, and a pane still
 * listing the room's files is not an empty, pending or failed one.
 *
 * A pane with no data of its own (the Recordings start screen, today) is
 * identical in all four states and is skipped for the same reason: there is no
 * such thing as a picture of it loading. */
function whyNotShowing(text, full) {
  if (text === full) return "the pane is identical to the full state";
  const stock = STOCK.filter((name) => text.includes(name));
  if (stock.length) return `the pane still lists ${stock.join(", ")}`;
  return null;
}

describe("capture the app's screens", () => {
  before(ensureDirs);

  after(() => {
    if (!appReady) {
      console.log("capture coverage skipped: the app never reached its ready workspace");
      return;
    }
    fs.writeFileSync(
      MANIFEST,
      shots.map((s) => JSON.stringify(s)).join("\n") + "\n",
      "utf-8",
    );
    const tally = (key) => {
      const out = {};
      for (const s of shots) if (s[key]) out[s[key]] = (out[s[key]] || 0) + 1;
      return out;
    };
    const kinds = tally("kind");
    const states = tally("state");
    const themes = tally("theme");
    const areas = tally("area");
    const viewers = tally("viewer");
    const details = tally("detail");
    console.log(`\ncaptured ${shots.length} shots -> ${OUT}`);
    for (const [name, t] of [
      ["kind", kinds],
      ["state", states],
      ["theme", themes],
      ["area", areas],
      ["viewer", viewers],
      ["detail", details],
    ]) {
      console.log(`${name}: ${JSON.stringify(t)}`);
    }
    if (unreached.size) {
      console.log(
        `\n${unreached.size} area/state combinations were NOT captured — the ` +
          `state never reached the pane, so the label would have contradicted ` +
          `the pixels:`,
      );
      for (const line of unreached) console.log(`  ${line}`);
      console.log(
        `  why: either that pane has no data of its own (a static start screen ` +
          `has no empty, pending or failed look), or its loader is not one ` +
          `qa/qa-mock.js counts as a read — see the EXTRA_READS set there, ` +
          `which is what ?qa_state= acts on.`,
      );
    }

    // THE COVERAGE CONTRACT. A capture that quietly comes up short is the
    // failure this whole file is guarding against: the first full run passed
    // green having captured ZERO viewers, because one selector matched nothing
    // and the loop moved on. Checking each expected bucket is non-empty catches
    // that class of gap, not just the instances someone remembered to guard.
    //
    // `detail` is in here for the same reason as `viewer`: every `continue` on
    // a missing selector above is a screen dropping silently out of the set,
    // and a renamed Settings page or layout toggle takes its shots with it.
    const missing = [];
    const want = {
      kind: ["area", "viewer", "settings", "overlay", "layout", "chrome", "chat"],
      state: STATES,
      theme: THEMES,
      area: AREAS.map(([k]) => k),
      viewer: FILES.map(([, v]) => v),
      detail: [
        ...SETTINGS_PAGES,
        ...PALETTE_DETAILS,
        ...LAYOUT_TOGGLES.map(([, d]) => d),
        ...CHROME_DETAILS,
        ...CHAT_DETAILS,
      ],
    };
    const got = {
      kind: kinds,
      state: states,
      theme: themes,
      area: areas,
      viewer: viewers,
      detail: details,
    };
    for (const [dim, expected] of Object.entries(want)) {
      for (const key of expected) if (!got[dim][key]) missing.push(`${dim}=${key}`);
    }
    if (!missing.length) return;
    const complaint =
      `capture is missing coverage for: ${missing.join(", ")} — ` +
      `a calibration set with these gaps reports that machinery as unused`;
    // The smoke run captures a deliberate slice of the matrix, so the contract
    // cannot hold there — but printing it keeps the smoke honest about what it
    // did NOT look at, instead of failing the documented command every time.
    if (SMOKE) console.log(`\n[smoke] ${complaint}`);
    else throw new Error(complaint);
  });

  it("every area, in every state, in both themes, at three window sizes", async () => {
    const areas = few(AREAS, 2);
    // Every STATE, even in the smoke run: the wiring most likely to be broken
    // is the `?qa_state=` plumbing itself, and a pass that never asks for
    // `loading` or `error` cannot see it.
    const themes = few(THEMES, 1);
    const sizes = few(VIEWPORTS.slice(0, 3), 1);
    /** area -> its pane in the `full` state, to tell a real empty/loading/
     *  error pane from one the state never reached. STATES[0] is "full", so
     *  this is always filled in before it is read. */
    const stocked = new Map();
    for (const [w, h] of sizes) {
      await browser.setWindowSize(w, h);
      for (const theme of themes) {
        for (const state of STATES) {
          for (const [area, label] of areas) {
            await open({ state, theme });
            if (!(await goArea(area))) continue;
            const text = await paneText();
            if (state === "full") {
              stocked.set(area, text);
            } else {
              const why = whyNotShowing(text, stocked.get(area));
              if (why) {
                unreached.add(`${state} never reached ${area} — ${why}`);
                continue;
              }
            }
            await shoot({ kind: "area", area, label, state, theme, w, h });
          }
        }
      }
    }
    await browser.setWindowSize(1440, 900);
  });

  it("settings, every page, both themes", async () => {
    for (const theme of few(THEMES, 1)) {
      await open({ theme });
      const gear = await $('button[aria-label="Open room settings (⌘,)"]');
      if (!(await gear.isExisting())) continue;
      await gear.click();
      await browser.pause(500);
      for (const page of few(SETTINGS_PAGES, 2)) {
        const tab = await $(".settings-nav").$(`button*=${page}`);
        if (!(await tab.isExisting())) continue;
        await tab.click();
        await browser.pause(350);
        await shoot({ kind: "settings", detail: page, state: "full", theme, w: 1440, h: 900 });
      }
    }
  });

  it("the command palette, open and typed into", async () => {
    const [openDetail, resultsDetail] = PALETTE_DETAILS;
    for (const theme of few(THEMES, 1)) {
      await open({ theme });
      // Matched on the CLASS, not on an accessible name. The name is the
      // button's own visible text now that the aria-label is gone (which is
      // the better answer — WCAG 2.5.3 wants the two to agree), and pinning a
      // capture selector to user-facing wording means the wording cannot be
      // edited without silently emptying this shot.
      const search = await $(".command-button");
      // NOT `continue`. A capture spec that quietly skips is worse than one
      // that fails: it reports green while teaching the calibration set that
      // the palette does not exist. The coverage check at the end of this file
      // caught it once; this makes the failure land where the cause is.
      await search.waitForExist({
        timeout: 10_000,
        timeoutMsg: "the ⌘K palette trigger is gone from the top bar",
      });
      await search.click();
      await browser.pause(400);
      await shoot({ kind: "overlay", detail: openDetail, state: "empty", theme, w: 1440, h: 900 });
      await browser.keys("apollo".split(""));
      await browser.pause(500);
      await shoot({ kind: "overlay", detail: resultsDetail, state: "full", theme, w: 1440, h: 900 });
    }
  });

  it("the pane layouts — library only, focus, all three", async () => {
    for (const theme of few(THEMES, 1)) {
      for (const [testId, detail] of LAYOUT_TOGGLES) {
        await open({ theme });
        const menu = await $('[data-testid="layout-menu"]');
        await menu.waitForExist({
          timeout: 10_000,
          timeoutMsg: `cannot capture ${detail}: the toolbar Layout menu is missing`,
        });
        await menu.click();
        const btn = await $(`[data-testid="${testId}"]`);
        await btn.waitForExist({
          timeout: 5_000,
          timeoutMsg: `cannot capture ${detail}: Layout action ${testId} is missing`,
        });
        await btn.click();
        await browser.pause(400);
        await shoot({ kind: "layout", detail, state: "full", theme, w: 1440, h: 900 });
      }
    }
  });

  it("each viewer kind, both themes, at two window sizes", async () => {
    // Select on `title`, not on text: the row LABEL is `displayName(f.name)`,
    // which strips the extension, so `.file-name=clean-code.pdf` matches
    // nothing. It silently matched nothing on the first full run — the spec
    // passed and captured zero viewers, which is the worst outcome available
    // here: a calibration set missing every document viewer reports that
    // machinery as unused. Hence the throw below rather than a `continue`.
    for (const [w, h] of few([VIEWPORTS[0], VIEWPORTS[3]], 1)) {
      await browser.setWindowSize(w, h);
      for (const theme of few(THEMES, 1)) {
        for (const [file, viewer] of few(FILES, 2)) {
          await open({ theme });
          const row = await $(`.file-name[title="${file}"]`);
          if (!(await row.isExisting())) {
            throw new Error(
              `no library row for ${file} — the viewer coverage would be silently missing`,
            );
          }
          await row.click();
          await browser.pause(1500); // PDF/docx/audio render asynchronously
          await shoot({ kind: "viewer", viewer, file, state: "full", theme, w, h });
        }
      }
    }
    await browser.setWindowSize(1440, 900);
  });

  it("the widest window, every area", async () => {
    const [w, h] = VIEWPORTS[3];
    await browser.setWindowSize(w, h);
    for (const theme of few(THEMES, 1)) {
      for (const [area, label] of few(AREAS, 2)) {
        await open({ theme });
        if (!(await goArea(area))) continue;
        await shoot({ kind: "area", area, label, state: "full", theme, w, h });
      }
    }
    await browser.setWindowSize(1440, 900);
  });

  it("the rail expanded and collapsed", async () => {
    const [collapsed, expanded] = CHROME_DETAILS;
    for (const theme of few(THEMES, 1)) {
      await open({ theme });
      // A new room now opens EXPANDED, so the first shot is the wide rail and
      // the toggle goes the other way. Both details are still captured.
      await shoot({ kind: "chrome", detail: expanded, state: "full", theme, w: 1440, h: 900 });
      const exp = await $('[data-testid="rail-expander"]');
      if (await exp.isExisting()) {
        await exp.click();
        await browser.pause(400);
        await shoot({ kind: "chrome", detail: collapsed, state: "full", theme, w: 1440, h: 900 });
      }
    }
  });

  it("the assistant answering, with its agent strip", async () => {
    for (const theme of few(THEMES, 1)) {
      await open({ theme });
      const box = await $("textarea");
      if (!(await box.isExisting())) continue;
      await box.setValue("translate the whole book and send it to slack");
      await browser.keys(["Enter"]);
      // The mock walks the roster over ~1.2s; three shots catch the strip
      // mid-walk, which is the state a user actually stares at.
      for (const [ms, detail] of [
        [200, CHAT_DETAILS[0]],
        [700, CHAT_DETAILS[1]],
        [1600, CHAT_DETAILS[2]],
      ]) {
        await browser.pause(ms === 200 ? 200 : 500);
        await shoot({ kind: "chat", detail, state: "full", theme, w: 1440, h: 900 });
      }
    }
  });
});
