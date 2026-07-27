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
 *   SKIP_BUILD=1 CAPTURE_SMOKE=1 npm run capture   # a few shots, to check wiring
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "..", "..", "sidecar", "data", "vision");
const IMAGES = path.join(OUT, "images");
const MANIFEST = path.join(OUT, "_shots.jsonl");

const SMOKE = !!process.env.CAPTURE_SMOKE;

/** The eight product areas, by their stable `data-area` attribute. */
const AREAS = [
  ["home", "Room home"],
  ["map", "Room Map"],
  ["recordings", "Recordings"],
  ["workflows", "Workflows"],
  ["scripts", "Scripts"],
  ["skills", "Skills"],
  ["memory", "Memory & scratch pad"],
  ["connectors", "Connectors"],
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

let n = 0;
const shots = [];

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
  await browser.pause(state === "loading" ? 700 : 500);
}

async function shoot(meta) {
  const name = `${String(++n).padStart(4, "0")}.png`;
  await browser.saveScreenshot(path.join(IMAGES, name));
  shots.push({ image: `images/${name}`, ...meta });
}

async function goArea(area) {
  const btn = await $(`.rail-button[data-area="${area}"]`);
  if (!(await btn.isExisting())) return false;
  await btn.click();
  await browser.pause(350);
  return true;
}

describe("capture the app's screens", () => {
  before(ensureDirs);

  after(() => {
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
    console.log(`\ncaptured ${shots.length} shots -> ${OUT}`);
    for (const [name, t] of [
      ["kind", kinds],
      ["state", states],
      ["theme", themes],
      ["area", areas],
      ["viewer", viewers],
    ]) {
      console.log(`${name}: ${JSON.stringify(t)}`);
    }

    // THE COVERAGE CONTRACT. A capture that quietly comes up short is the
    // failure this whole file is guarding against: the first full run passed
    // green having captured ZERO viewers, because one selector matched nothing
    // and the loop moved on. Checking each expected bucket is non-empty catches
    // that class of gap, not just the instances someone remembered to guard.
    const missing = [];
    const want = {
      kind: ["area", "viewer", "settings", "overlay", "layout", "chrome", "chat"],
      state: STATES,
      theme: THEMES,
      area: AREAS.map(([k]) => k),
      viewer: FILES.map(([, v]) => v),
    };
    const got = { kind: kinds, state: states, theme: themes, area: areas, viewer: viewers };
    for (const [dim, expected] of Object.entries(want)) {
      for (const key of expected) if (!got[dim][key]) missing.push(`${dim}=${key}`);
    }
    if (missing.length) {
      throw new Error(
        `capture is missing coverage for: ${missing.join(", ")} — ` +
          `a calibration set with these gaps reports that machinery as unused`,
      );
    }
  });

  it("every area, in every state, in both themes, at three window sizes", async () => {
    const areas = SMOKE ? AREAS.slice(0, 2) : AREAS;
    const states = SMOKE ? ["full", "empty"] : STATES;
    const themes = SMOKE ? ["dark"] : THEMES;
    const sizes = SMOKE ? [VIEWPORTS[0]] : VIEWPORTS.slice(0, 3);
    for (const [w, h] of sizes) {
      await browser.setWindowSize(w, h);
      for (const theme of themes) {
        for (const state of states) {
          for (const [area, label] of areas) {
            await open({ state, theme });
            if (!(await goArea(area))) continue;
            await shoot({ kind: "area", area, label, state, theme, w, h });
          }
        }
      }
    }
    await browser.setWindowSize(1440, 900);
  });

  it("settings, every page, both themes", async () => {
    if (SMOKE) return;
    for (const theme of THEMES) {
      await open({ theme });
      const gear = await $('button[aria-label="Open room settings (⌘,)"]');
      if (!(await gear.isExisting())) continue;
      await gear.click();
      await browser.pause(500);
      for (const page of ["AI & behavior", "Voice", "Privacy & recovery", "Connections"]) {
        const tab = await $(".settings-nav").$(`button*=${page}`);
        if (!(await tab.isExisting())) continue;
        await tab.click();
        await browser.pause(350);
        await shoot({ kind: "settings", detail: page, state: "full", theme, w: 1440, h: 900 });
      }
    }
  });

  it("the command palette, open and typed into", async () => {
    if (SMOKE) return;
    for (const theme of THEMES) {
      await open({ theme });
      const search = await $('button[aria-label="Search this room or run a command (⌘K)"]');
      if (!(await search.isExisting())) continue;
      await search.click();
      await browser.pause(400);
      await shoot({ kind: "overlay", detail: "command palette open", state: "empty", theme, w: 1440, h: 900 });
      await browser.keys("apollo".split(""));
      await browser.pause(500);
      await shoot({ kind: "overlay", detail: "command palette with results", state: "full", theme, w: 1440, h: 900 });
    }
  });

  it("the pane layouts — library only, focus, all three", async () => {
    if (SMOKE) return;
    const toggles = [
      ['button[aria-label="Toggle the Library pane (⌘1)"]', "library pane hidden"],
      ['button[aria-label="Toggle the AI and Studio pane (⌘3)"]', "AI pane hidden"],
      ['button[aria-label="Focus the editor — hide both side panes"]', "focus mode"],
    ];
    for (const theme of THEMES) {
      for (const [sel, detail] of toggles) {
        await open({ theme });
        const btn = await $(sel);
        if (!(await btn.isExisting())) continue;
        await btn.click();
        await browser.pause(400);
        await shoot({ kind: "layout", detail, state: "full", theme, w: 1440, h: 900 });
      }
    }
  });

  it("each viewer kind, both themes, at two window sizes", async () => {
    if (SMOKE) return;
    // Select on `title`, not on text: the row LABEL is `displayName(f.name)`,
    // which strips the extension, so `.file-name=clean-code.pdf` matches
    // nothing. It silently matched nothing on the first full run — the spec
    // passed and captured zero viewers, which is the worst outcome available
    // here: a calibration set missing every document viewer reports that
    // machinery as unused. Hence the throw below rather than a `continue`.
    for (const [w, h] of [VIEWPORTS[0], VIEWPORTS[3]]) {
      await browser.setWindowSize(w, h);
      for (const theme of THEMES) {
        for (const [file, viewer] of FILES) {
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
    if (SMOKE) return;
    const [w, h] = VIEWPORTS[3];
    await browser.setWindowSize(w, h);
    for (const theme of THEMES) {
      for (const [area, label] of AREAS) {
        await open({ theme });
        if (!(await goArea(area))) continue;
        await shoot({ kind: "area", area, label, state: "full", theme, w, h });
      }
    }
    await browser.setWindowSize(1440, 900);
  });

  it("the rail collapsed and expanded", async () => {
    if (SMOKE) return;
    for (const theme of THEMES) {
      await open({ theme });
      await shoot({ kind: "chrome", detail: "rail collapsed", state: "full", theme, w: 1440, h: 900 });
      const exp = await $('[data-testid="rail-expander"]');
      if (await exp.isExisting()) {
        await exp.click();
        await browser.pause(400);
        await shoot({ kind: "chrome", detail: "rail expanded", state: "full", theme, w: 1440, h: 900 });
      }
    }
  });

  it("the assistant answering, with its agent strip", async () => {
    if (SMOKE) return;
    for (const theme of THEMES) {
      await open({ theme });
      const box = await $("textarea");
      if (!(await box.isExisting())) continue;
      await box.setValue("translate the whole book and send it to slack");
      await browser.keys(["Enter"]);
      // The mock walks the roster over ~1.2s; three shots catch the strip
      // mid-walk, which is the state a user actually stares at.
      for (const [ms, detail] of [
        [200, "agents starting"],
        [700, "agent running"],
        [1600, "agents done"],
      ]) {
        await browser.pause(ms === 200 ? 200 : 500);
        await shoot({ kind: "chat", detail, state: "full", theme, w: 1440, h: 900 });
      }
    }
  });
});
