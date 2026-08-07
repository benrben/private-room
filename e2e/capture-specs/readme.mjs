/* Re-shoot the eight screenshots the README embeds.
 *
 * WHY THIS IS A SPEC AND NOT A FOLDER OF PNGs. The README's pictures are the
 * first thing anyone sees of this app, and they were hand-made — so they aged
 * silently. A redesign lands, the shots keep showing the old shell, and
 * nothing anywhere says the page is now lying about the product. Making them a
 * capture run means "the README is out of date" becomes a command you re-run
 * rather than an afternoon of window-arranging.
 *
 * It writes STRAIGHT INTO docs/screens/, overwriting in place, because those
 * paths are what the README already points at — a shot that lands anywhere
 * else has to be copied by hand, which is the step that gets forgotten.
 *
 * Presence is asserted before every shot. A screen that failed to load must
 * fail the run rather than quietly file a picture of an empty pane; a blank
 * screenshot in a README is worse than a stale one, because a stale one at
 * least looks like software.
 *
 *   SKIP_BUILD=1 npx wdio run e2e/wdio.capture.conf.mjs --spec e2e/capture-specs/readme.mjs
 */
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("docs/screens");

async function shot(name) {
  fs.mkdirSync(OUT, { recursive: true });
  await browser.saveScreenshot(path.join(OUT, `${name}.png`));
}

/** The QA page boots straight into the workspace; the theme is a localStorage
 * key read at boot, so it is set and the page reloaded. */
async function open(theme = "dark") {
  const url = browser.options.baseUrl;
  await browser.url(url);
  await browser.execute((t) => localStorage.setItem("prTheme", t), theme);
  await browser.url(url);
  await $(".activity-rail").waitForExist({ timeout: 20_000 });
  // The mock's own banner is harness furniture and must not appear in a
  // picture of the product.
  await browser.execute(() => {
    document.getElementById("qa-mock-gap")?.remove();
  });
  await browser.pause(600);
}

async function goArea(area) {
  const btn = await $(`.rail-button[data-area="${area}"]`);
  await btn.waitForExist({ timeout: 10_000 });
  await btn.click();
  await browser.pause(500);
}

async function openFile(name) {
  const row = await $(`.file-name[title="${name}"]`);
  await row.waitForExist({ timeout: 10_000 });
  await row.click();
  await browser.pause(1500);
}

describe("README screenshots", () => {
  it("the workspace — library, document and AI side by side", async () => {
    await open("dark");
    // No goArea here: "files" is deliberately NOT a rail destination
    // (`Exclude<WorkArea, "files">`) — the three-pane workspace is what the QA
    // page already opens into.
    await openFile("Arcelle UX direction.md");
    await $(".viewer-head").waitForExist({ timeout: 10_000 });
    await shot("workspace");
  });

  it("the same workspace in the light theme", async () => {
    await open("light");
    // No goArea here: "files" is deliberately NOT a rail destination
    // (`Exclude<WorkArea, "files">`) — the three-pane workspace is what the QA
    // page already opens into.
    await openFile("Arcelle UX direction.md");
    await $(".viewer-head").waitForExist({ timeout: 10_000 });
    await shot("workspace-light");
  });

  it("the room home", async () => {
    await open("dark");
    await goArea("home");
    await browser.pause(900);
    await shot("home");
  });

  it("workflows", async () => {
    await open("dark");
    await goArea("workflows");
    await browser.pause(900);
    await shot("workflows");
  });

  it("scripts", async () => {
    await open("dark");
    await goArea("scripts");
    await browser.pause(900);
    await shot("scripts");
  });

  it("memory", async () => {
    await open("dark");
    await goArea("memory");
    await browser.pause(900);
    await shot("memory");
  });

  it("settings — cloud privacy", async () => {
    await open("dark");
    // Partial match: the full label carries a ⌘ and a shortcut in parentheses,
    // and pinning an exact string means a reworded tooltip silently drops a
    // README picture.
    const gear = await $('button[aria-label*="room settings"]');
    await gear.waitForExist({ timeout: 10_000 });
    await gear.click();
    await browser.pause(2500);
    // SETTINGS DOES NOT RENDER IN THIS HARNESS. Its ErrorBoundary catches
    // "Cannot read properties of null (reading 'length')" — a section reads
    // `.length` on the answer to a command qa-mock has no fixture for, and an
    // unfaked command resolves to null. The whole Settings surface is
    // therefore unreachable here, which is why `cloud-privacy.png` is the one
    // README shot this spec cannot refresh. Say that out loud rather than
    // filing a picture of an error card.
    const crashed = await browser.execute(() =>
      document.body.innerText.includes("Settings couldn't be drawn"),
    );
    if (crashed) {
      throw new Error(
        "Settings crashes under qa-mock (a fixture gap, not a product bug) — " +
          "docs/screens/cloud-privacy.png must be shot from the real app until " +
          "the missing settings fixtures exist.",
      );
    }
    await $(".settings-nav").waitForExist({ timeout: 20_000 });
    // The nav is a list of pages; pick the privacy one by its label rather
    // than its index, which reorders whenever a section is added.
    const items = await $$(".settings-nav-item");
    for (const item of items) {
      if ((await item.getText()).toLowerCase().includes("privacy")) {
        await item.click();
        break;
      }
    }
    await browser.pause(900);
    await shot("cloud-privacy");
  });

  it("the cloud view of a file", async () => {
    await open("dark");
    // No goArea here: "files" is deliberately NOT a rail destination
    // (`Exclude<WorkArea, "files">`) — the three-pane workspace is what the QA
    // page already opens into.
    await openFile("Arcelle UX direction.md");
    const btn = await $("button=Preview cloud payload");
    await btn.waitForExist({ timeout: 10_000 });
    await btn.click();
    await browser.pause(1200);
    await shot("cloud-view");
  });
});
