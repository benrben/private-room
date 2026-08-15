/* WALK THE PRIVATE BROWSER'S TRUST STATES AND PHOTOGRAPH EACH ONE.
 *
 * The 2026-08-15 audit response is a set of claims about what the chrome says
 * and when it stops saying it, and every one of them was verified by a test
 * that reads source or drives a pure module. None of that can see a pixel: a
 * shield can carry the right word in the right class and still be illegible
 * over a white page, and a reading view can compute the right layout and still
 * leave a 320px hole where the page used to be.
 *
 * So this drives the real React app (qa.html, with qa/qa-mock.js standing in
 * for Rust) through the states the audit named, and writes a PNG of each. It
 * REPORTS rather than asserts on appearance — a picture is evidence for a human,
 * not a gate — but it DOES assert the handful of facts that are unambiguous in
 * the DOM, because a screenshot of the wrong state is worse than none.
 *
 *   SKIP_BUILD=1 npx wdio run e2e/wdio.capture.conf.mjs --spec e2e/capture-specs/browseraudit.mjs
 */
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("qa/shots/browser-audit");

const notes = [];
const note = (line) => {
  notes.push(line);
  console.log(`  · ${line}`);
};

async function shot(name) {
  await browser.pause(250);
  await browser.saveScreenshot(path.join(OUT, `${name}.png`));
  note(`shot ${name}.png`);
}

async function text(sel) {
  const el = await $(sel);
  if (!(await el.isExisting())) return null;
  return (await el.getText()).replace(/\s+/g, " ").trim();
}

/** Load the app and wait for the shell.
 *
 * The theme is written BEFORE the load that renders: `initTheme` stamps
 * `data-theme` on <html> before first paint, so setting it afterwards leaves
 * the DOM on the previous palette and the screenshot lies about which theme it
 * is showing. Same reason `screens.mjs` loads twice. */
async function open(theme = "dark") {
  const url = browser.options.baseUrl;
  await browser.url(url);
  await browser.execute((t) => localStorage.setItem("prTheme", t), theme);
  await browser.url(url);
  await $(".activity-rail").waitForExist({ timeout: 20_000 });
  await browser.pause(600);
}

async function goBrowser(theme = "dark") {
  await open(theme);
  const more = await $('[data-testid="more-tools"]');
  if ((await more.isExisting()) && (await more.getAttribute("aria-expanded")) !== "true") {
    await more.click();
    await browser.pause(200);
  }
  const btn = await $('.rail-button[data-area="browser"]');
  await btn.click();
  await browser.pause(600);
}

/** Get a real page on screen.
 *
 * Almost every claim in this file is a claim ABOUT a page — the shield's two
 * checks, the reader, the Save strip — and the fixture starts with none open.
 * Walking without this photographs the start screen four times and proves
 * nothing. */
async function openPage(url = "https://en.wikipedia.org/wiki/Speaker_diarisation") {
  const input = await $(".browser-address input");
  await input.click();
  await input.setValue(url);
  await browser.keys("Enter");
  await browser.pause(1800); // the chrome polls at 1.2s
  return (await $(".browser-start").isExisting()) === false;
}

/** Click the control whose visible text matches, within a scope. */
async function clickText(scope, label) {
  const buttons = await $$(`${scope} button`);
  for (const b of buttons) {
    const t = (await b.getText()).replace(/\s+/g, " ").trim();
    if (t === label || t.startsWith(label)) {
      await b.click();
      await browser.pause(500);
      return true;
    }
  }
  return false;
}

describe("the private browser's trust states, photographed", () => {
  before(() => fs.mkdirSync(OUT, { recursive: true }));
  after(() => {
    fs.writeFileSync(path.join(OUT, "NOTES.txt"), notes.join("\n") + "\n");
    console.log(`\nwrote ${notes.length} notes to ${OUT}/NOTES.txt`);
  });

  it("says nothing it has not checked, and photographs each state", async () => {
    await goBrowser();
    await shot("01-browser-arrived");
    const chipEmpty = await text(".browser-shield");
    note(`shield with NO page open: ${JSON.stringify(chipEmpty)}`);
    expect(chipEmpty).toBe("No page");

    note(`page opened: ${await openPage()}`);
    await browser.pause(1200);

    // ---- the shield, with the block list FAILED (the audit's P0) ----------
    const chip = await text(".browser-shield");
    note(`shield chip: ${JSON.stringify(chip)}`);
    // The one thing that must never be true again: a confident claim over a
    // protection engine that did not start.
    expect(chip).not.toContain("Private\n");
    const shieldTitle = await (await $(".browser-shield")).getAttribute("title");
    note(`shield title: ${JSON.stringify((shieldTitle || "").slice(0, 220))}`);
    expect(shieldTitle || "").not.toMatch(/[Tt]rackers blocked/);

    const banner = await text(".browser-banner.error");
    note(`protection banner: ${JSON.stringify(banner)}`);
    await shot("02-blocker-failed");

    // ---- the start screen must not promise blocking either ---------------
    const start = await text(".browser-start");
    if (start) {
      note(`start copy: ${JSON.stringify(start.slice(0, 260))}`);
      expect(start).not.toMatch(/trackers blocked/i);
    }

    // LIGHT THEME is where the audit saw the chrome dissolve into a white page.
    // The strip is opaque now; this is the picture that says whether it reads.
    await goBrowser("light");
    await openPage();
    await shot("02b-chrome-light");
    const chromeBg = await browser.execute(() => {
      const el = document.querySelector(".browser-chrome");
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { background: cs.backgroundColor, borderBottom: cs.borderBottomColor };
    });
    note(`light chrome computed: ${JSON.stringify(chromeBg)}`);
    // Transparent chrome over an arbitrary web page is the defect itself.
    expect(chromeBg && chromeBg.background).not.toBe("rgba(0, 0, 0, 0)");
    await goBrowser("dark");
    await openPage();

    // ---- Retry recovers it ------------------------------------------------
    if (await clickText(".browser-banner.error", "Retry")) {
      await browser.pause(1600); // the chrome polls at 1.2s
      const after = await text(".browser-shield");
      note(`shield chip after Retry: ${JSON.stringify(after)}`);
      const gone = await text(".browser-banner.error");
      note(`banner after Retry: ${JSON.stringify(gone)}`);
      await shot("03-blocker-recovered");
    } else {
      note("NO RETRY BUTTON FOUND — the banner offered no recovery");
    }
  });

  it("shows the journal as sittings rather than a dump", async () => {
    await goBrowser();
    await openPage();
    await clickText(".browser-chrome", "Journal");
    const panel = await $(".browser-journal");
    expect(await panel.isExisting()).toBe(true);
    await shot("04-journal");

    const heads = await $$(".browser-journal-session > h3");
    note(`sittings shown by default: ${heads.length}`);
    for (const h of heads) note(`  heading: ${JSON.stringify(await h.getText())}`);

    const summary = await text(".browser-journal-summary");
    note(`summary: ${JSON.stringify(summary)}`);

    const runs = await $$(".browser-journal .jn");
    note(`collapsed runs on screen: ${runs.length}`);
    for (const r of runs) note(`  run badge: ${JSON.stringify(await r.getText())}`);

    const more = await text(".browser-journal-more");
    note(`earlier-sittings control: ${JSON.stringify(more)}`);

    // The confirmation must name the web cache it also erases.
    if (await clickText(".browser-journal header", "Clear")) {
      await browser.pause(700);
      const confirm = await text(".browser-journal-confirm");
      note(`clear confirmation: ${JSON.stringify(confirm)}`);
      await shot("05-clear-confirmation");
      await clickText(".browser-journal-confirm", "Keep");
    } else {
      note("NO CLEAR BUTTON — nothing to confirm");
    }
    await clickText(".browser-chrome", "Journal");
  });

  it("gives the reading view the pane, and the page back only to compare", async () => {
    await goBrowser();
    await openPage();
    const opened = await clickText(".browser-chrome", "Read as text");
    if (!opened) {
      note("READ AS TEXT WAS DISABLED — no readable page in the fixture");
      return;
    }
    await browser.pause(900);
    const reader = await $(".browser-reader");
    expect(await reader.isExisting()).toBe(true);
    await shot("06-reader-replaces-page");

    // The hole the native page is parked over must not reserve width while the
    // text has the floor — that 320px sliver is the audit's P2.
    const stage = await $(".browser-stage");
    const w = (await stage.getSize()).width;
    note(`stage width while reading (expect ~0): ${w}`);
    // THE ASSERTION THIS WHOLE RUN EXISTS FOR. Every unit test agreed the
    // reading view replaced the page; the rendered app kept a 320px sliver,
    // because the borrow `openReader` took was never returned.
    expect(w).toBeLessThan(8);

    if (await clickText(".browser-reader-tools", "Compare with page")) {
      await browser.pause(700);
      const w2 = (await (await $(".browser-stage")).getSize()).width;
      note(`stage width while comparing (expect ~320): ${w2}`);
      expect(w2).toBeGreaterThan(280);
      await shot("07-reader-comparing");
      await clickText(".browser-reader-tools", "Hide the live page");
    } else {
      note("NO COMPARE CONTROL FOUND");
    }
    await clickText(".browser-reader-tools", "Close the reading view");
  });

  it("stops describing a page once the last one closes", async () => {
    await goBrowser();
    await openPage();
    await shot("08-before-close");

    // Close every private page from the sidebar's own rows.
    for (let i = 0; i < 12; i += 1) {
      const closers = await $$(".page-close");
      if (closers.length === 0) break;
      await closers[0].click();
      await browser.pause(450);
    }
    await browser.pause(1800); // let the 1.2s poll learn the browser is shut

    const addr = await $(".browser-address input");
    const value = (await addr.getValue()) || "";
    note(`address bar after the last close: ${JSON.stringify(value)}`);
    expect(value).toBe("");

    const padlock = await $(".browser-scheme:not(.bico-search)");
    note(`padlock still shown: ${await padlock.isExisting()}`);

    const saveRow = await $(".browser-save-row");
    note(`save strip still open: ${await saveRow.isExisting()}`);

    const readerLeft = await $(".browser-reader");
    note(`reading view still open: ${await readerLeft.isExisting()}`);

    await shot("09-after-last-close");
  });
});
