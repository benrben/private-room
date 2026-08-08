// GH #2 — "the left sidebar should be expandable".
//
// The report is ambiguous: there are two things on the left. Both were fixed,
// so both are tested.
//
//   1. The activity rail (the icon strip) genuinely could not expand — it was
//      nailed to 74px, which is why its labels had to be abbreviated to ≤9
//      characters ("Connectors" showed as "Connect"). It now toggles between an
//      84px icon column and a 192px column with full labels, and the choice is
//      remembered.
//
//      The notebook pass INVERTED the default: the rail is the app's one
//      primary navigation, and navigation you have to hover to identify is not
//      navigation, so full labels are what a new room opens with. The toggle
//      and the persistence are still the thing under test — they are just
//      exercised starting from the other end.
//
//      A later design-review pass (2026-08-08) replaced the abbreviated-text
//      collapsed state with icon-only rows plus a native `title` tooltip
//      carrying the FULL, un-abbreviated label — a shrunken "Connect" was
//      judged less legible than no visible text at all. The abbreviation
//      itself is gone; what's under test now is that collapsing clears the
//      visible label and moves the full name to `title`, not that it shrinks.
//
//   2. The Library pane always resized, but you could not tell: the handle was
//      a 5px line whose grip only appeared on hover, and it refused to go past
//      32% of the window. The grip is now visible at rest and the ceiling is
//      higher — with the trade fixed so the center pane's floor actually holds.

import { openApp, widthOf } from "./helpers.mjs";

const RAIL = ".activity-rail";
const EXPANDER = '[data-testid="rail-expander"]';
const SPLIT_A = '[aria-label="Resize the Library pane"]';

/** The persisted per-room layout the shell writes to localStorage. */
const saved = () =>
  browser.execute(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith("prLayout:"));
    return k ? JSON.parse(localStorage.getItem(k)) : null;
  });

/** Focus the splitter for keyboard resizing. NOT a click: `startDrag`
 * preventDefault()s the pointerdown (so a drag doesn't select text), and that
 * also suppresses the focus a click would otherwise give it. */
async function focusSplitter(sel) {
  await browser.execute((s) => document.querySelector(s).focus(), sel);
  await expect(
    await browser.execute((s) => document.activeElement === document.querySelector(s), sel),
  ).toBe(true);
}

/** Hold a splitter key n times. */
async function press(key, n) {
  for (let i = 0; i < n; i++) await browser.keys(["Shift", key]);
}

describe("GH #2a — the activity rail expands", () => {
  beforeEach(async () => {
    await openApp();
  });

  it("narrows to icons and back", async () => {
    // A new room opens with the readable labels.
    await expect(await widthOf(RAIL)).toBeGreaterThan(150);
    await expect(await $(RAIL).$('[data-area="connectors"]').getText()).toBe("Connectors");
    await expect(await $(RAIL).$('[data-area="recordings"]').getText()).toBe("Recordings");

    await (await $(EXPANDER)).click();
    await browser.waitUntil(async () => (await widthOf(RAIL)) < 100, {
      timeout: 5_000,
      timeoutMsg: "the rail never narrowed",
    });
    // Icon-only while narrow — no shrunken abbreviation, the full name only
    // survives as a `title` tooltip.
    await expect(await $(RAIL).$('[data-area="connectors"]').getText()).toBe("");
    await expect(
      await $(RAIL).$('[data-area="connectors"]').getAttribute("title"),
    ).toBe("Connectors");

    await (await $(EXPANDER)).click();
    await browser.waitUntil(async () => (await widthOf(RAIL)) > 150, {
      timeout: 5_000,
      timeoutMsg: "the rail never widened again",
    });
  });

  it("remembers the choice across a reload", async () => {
    // Choose AGAINST the default, which is the only choice a stored value has
    // to survive: keeping the default needs no storage to look right.
    await (await $(EXPANDER)).click();
    await browser.waitUntil(async () => (await widthOf(RAIL)) < 100);
    await expect((await saved()).railExpanded).toBe(false);

    // Reload WITHOUT wiping the layout — that is the point of the test.
    await openApp({ wipe: false });
    await expect(await widthOf(RAIL)).toBeLessThan(100);
    await expect(await $(EXPANDER).getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps every rail destination reachable while expanded", async () => {
    await browser.waitUntil(async () => (await widthOf(RAIL)) > 150);
    // A wider rail must not push its own buttons out of the viewport.
    for (const area of ["map", "recordings", "workflows", "memory", "connectors"]) {
      await expect(await $(RAIL).$(`[data-area="${area}"]`)).toBeDisplayed();
    }
  });
});

describe("GH #2b — the Library pane can actually be widened", () => {
  beforeEach(async () => {
    await openApp();
  });

  it("shows its resize grip without needing a hover first", async () => {
    // The old grip was opacity:0 until hover, so the splitter read as a border
    // and the pane looked fixed-width.
    const opacity = await browser.execute((sel) => {
      const el = document.querySelector(sel);
      return getComputedStyle(el, "::after").opacity;
    }, SPLIT_A);
    await expect(Number(opacity)).toBeGreaterThan(0);
  });

  it("has a grab area wide enough to actually hit", async () => {
    // Live QA on the real app could not land a drag on the 5px line at all —
    // the pointer-down fell through and selected transcript text instead. The
    // hit area overflows into both neighbours via ::before, so measure that,
    // not the laid-out width.
    const target = await browser.execute((sel) => {
      const el = document.querySelector(sel);
      const before = getComputedStyle(el, "::before");
      const bleed = (p) => Math.abs(parseFloat(p) || 0);
      return el.getBoundingClientRect().width + bleed(before.left) + bleed(before.right);
    }, SPLIT_A);
    await expect(target).toBeGreaterThanOrEqual(14);
  });

  it("widens past the old 32% ceiling", async () => {
    await focusSplitter(SPLIT_A);
    const before = (await saved()).ratios.library;
    await press("ArrowRight", 12);
    const { ratios } = await saved();

    // It moved at all (guards against a silently dead keyboard path)...
    await expect(ratios.library).toBeGreaterThan(before);
    // ...and past where the old clamp stopped it dead.
    await expect(ratios.library).toBeGreaterThan(0.32);
  });

  it("never squeezes the center pane below its floor, in either direction", async () => {
    // The clamp raise exposed the real defect: the panes were clamped
    // independently, so the ratios could sum past 1 and the center quietly
    // shrank under its minimum. They now trade, holding the sum at 1.
    await focusSplitter(SPLIT_A);
    await press("ArrowRight", 20);

    let { ratios } = await saved();
    // Pushed all the way, so the floor is genuinely under load.
    await expect(ratios.library).toBeGreaterThan(0.3);
    await expect(ratios.center).toBeGreaterThanOrEqual(0.4 - 1e-9);
    await expect(Math.abs(ratios.library + ratios.center + ratios.ai - 1)).toBeLessThan(1e-6);

    await press("ArrowLeft", 30);
    ({ ratios } = await saved());
    await expect(ratios.library).toBeGreaterThanOrEqual(0.13 - 1e-9);
    await expect(Math.abs(ratios.library + ratios.center + ratios.ai - 1)).toBeLessThan(1e-6);
  });

  it("survives a reload at its new width", async () => {
    await focusSplitter(SPLIT_A);
    await press("ArrowRight", 8);
    const before = (await saved()).ratios.library;
    await expect(before).toBeGreaterThan(0.18); // it really did widen

    await openApp({ wipe: false });
    const after = (await saved()).ratios.library;
    await expect(Math.abs(after - before)).toBeLessThan(1e-6);
  });
});
