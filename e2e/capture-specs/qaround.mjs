/* The QA round-trip: drive the mock app to the surfaces the 2026-08-06 hands-on
 * report named, in BOTH themes, and write a PNG of each.
 *
 * Mostly a capture spec — its job is to put the reworked screens in front of a
 * reader. What it does assert is presence, because a screen that silently
 * failed to load must fail the run rather than file away a picture of an empty
 * pane; that is the trap the palette shot fell into on the previous round.
 *
 *   SKIP_BUILD=1 npx wdio run e2e/wdio.capture.conf.mjs --spec e2e/capture-specs/qaround.mjs
 */
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("qa-shots");
const THEMES = ["dark", "light"];

async function shot(name) {
  fs.mkdirSync(OUT, { recursive: true });
  await browser.saveScreenshot(path.join(OUT, `${name}.png`));
}

/** Same entry the dataset capture uses: the QA page opens straight into the
 * workspace, and the theme is a localStorage key read at boot. */
async function open(theme) {
  const url = browser.options.baseUrl;
  await browser.url(url);
  await browser.execute((t) => localStorage.setItem("prTheme", t), theme);
  await browser.url(url);
  await $(".activity-rail").waitForExist({ timeout: 20_000 });
  await browser.pause(500);
}

async function goArea(area) {
  const btn = await $(`.rail-button[data-area="${area}"]`);
  await btn.waitForExist({ timeout: 10_000 });
  await btn.click();
  await browser.pause(400);
}

async function openFile(name) {
  const row = await $(`.file-name[title="${name}"]`);
  await row.waitForExist({ timeout: 10_000 });
  await row.click();
  await browser.pause(1500);
}

describe("post-QA round", () => {
  for (const theme of THEMES) {
    it(`the recordings landing page — ${theme}`, async () => {
      await open(theme);
      await goArea("recordings");
      await $(".rec-home").waitForExist({ timeout: 10_000 });
      await shot(`recordings-home-${theme}`);
    });

    it(`the conversation, with every handwriting branch — ${theme}`, async () => {
      await open(theme);
      await $(".msg").waitForExist({ timeout: 15_000 });
      // The conversation is the subject, so give it the window. At the default
      // three-pane width a chat column is ~300px and a screenshot of it says
      // more about the splitter than about the messages.
      const wide = await $('button[aria-label="Give the AI pane the full width"]');
      await wide.click();
      await browser.pause(500);
      // Top of the log: the short exchanges that should be in the hand.
      await browser.execute(() => {
        const el = document.querySelector(".msg")?.parentElement;
        if (el) el.scrollTop = 0;
      });
      await browser.pause(300);
      await shot(`chat-messages-top-${theme}`);
      // The middle: the URL message and the Hebrew one, both of which must
      // have fallen back to the printed face.
      await browser.execute(() => {
        const el = document.querySelector(".msg")?.parentElement;
        if (el) el.scrollTop = Math.round(el.scrollHeight * 0.42);
      });
      await browser.pause(300);
      await shot(`chat-messages-mid-${theme}`);
      // …and the tail: the long answer, its table, its code and its link.
      await browser.execute(() => {
        const el = document.querySelector(".msg")?.parentElement;
        if (el) el.scrollTop = el.scrollHeight;
      });
      await browser.pause(300);
      await shot(`chat-messages-tail-${theme}`);
    });

    it(`a code file opens on its first line — ${theme}`, async () => {
      await open(theme);
      await openFile("prepare_release.py");
      await $(".editor-host").waitForExist({ timeout: 15_000 });
      await browser.pause(1200);
      // The gutter must start at 1. Monaco renders the numbers it can see, so
      // the smallest one on screen IS the top visible line.
      const first = await browser.execute(() => {
        const nums = Array.from(
          document.querySelectorAll(".monaco-editor .line-numbers"),
        )
          .map((n) => parseInt(n.textContent || "", 10))
          .filter((v) => Number.isFinite(v));
        return nums.length ? Math.min(...nums) : null;
      });
      if (first !== 1) {
        throw new Error(`code opened scrolled: gutter starts at ${first}, not 1`);
      }
      await shot(`code-first-line-${theme}`);
    });

    it(`a Word document gets the reader shell — ${theme}`, async () => {
      await open(theme);
      await openFile("review-sample.docx");
      await $(".doc-source").waitForExist({ timeout: 15_000 });
      await $(".doc-progress").waitForExist({ timeout: 5_000 });
      await shot(`docx-reader-${theme}`);
    });
  }

  it("a file opened from the browser does not claim browser context", async () => {
    await open("dark");
    // The reader's own route: a file is open, they step into the browser, then
    // come back to the document's tab. Activating a file tab deliberately does
    // NOT change the area (Workspace.tsx), so the browser stays the place —
    // which is precisely the state that used to mislabel the document.
    await openFile("Ideas.md");
    await goArea("browser");
    await $(".tab").waitForExist({ timeout: 10_000 });
    // ⌥⌘1 rather than a click: this asserts the CONTEXT, and a click also
    // exercises the strip's hit targets, which the tab-width test owns.
    await browser.keys(["Alt", "Meta", "1"]);
    await browser.pause(1200);
    const crumb = await $(".editor-breadcrumb");
    await crumb.waitForExist({ timeout: 10_000 });
    const trail = (await crumb.getText()).replace(/\s+/g, " ");
    if (/private browser/i.test(trail)) {
      throw new Error(`the trail still claims the browser: ${trail}`);
    }
    // The left pane must be the library again, not the browser's navigator.
    const heading = await $(".pane-heading");
    const where = await heading.getText();
    if (/private browser/i.test(where)) {
      throw new Error(`the left pane still says: ${where}`);
    }
    // …and the way back has to be on screen, since Escape is the only other one.
    const back = await $(".crumb-back");
    if (!(await back.isExisting())) {
      throw new Error("no way back to the browser is drawn");
    }
    await shot("file-from-browser-dark");
  });

  it("many open tabs stay individually readable", async () => {
    await open("dark");
    for (const f of [
      "Arcelle UX direction.md",
      "Ideas.md",
      "Issues.md",
      "prepare_release.py",
      "review-sample.docx",
      "Apollo missions.csv",
    ]) {
      const row = await $(`.file-name[title="${f}"]`);
      if (await row.isExisting()) {
        await row.click();
        await browser.pause(500);
      }
    }
    const geom = await browser.execute(() =>
      Array.from(document.querySelectorAll(".tab")).map((n) => {
        const r = n.getBoundingClientRect();
        const c = n.querySelector(".tab-close")?.getBoundingClientRect();
        return {
          w: Math.round(r.width),
          // How far Close's right edge is from the tab's. It belongs at the
          // edge; a short title used to leave it stranded mid-tab, where the
          // centre of the tab — and so an ordinary click at the title — landed
          // on it and closed the file.
          gap: c ? Math.round(r.right - c.right) : null,
        };
      }),
    );
    const tight = geom.filter((g) => g.w < 120);
    if (tight.length) {
      throw new Error(`tabs squeezed below a readable width: ${geom.map((g) => g.w).join(", ")}`);
    }
    // The title is drawn in two boxes so the distinguishing tail survives
    // truncation, and the seam between them can fall on a space. Whitespace at
    // a box boundary is collapsed unless the box preserves it, which is how
    // "Arcelle UX direction" once rendered as "Arcelle UXdirection".
    const seams = await browser.execute(() =>
      Array.from(document.querySelectorAll(".tab")).map((n) => {
        const head = n.querySelector(".tab-title-head");
        const tail = n.querySelector(".tab-title-tail");
        const joined = (head?.textContent ?? "") + (tail?.textContent ?? "");
        return {
          joined,
          title: n.getAttribute("title"),
          keepsSpace:
            !/\s$/.test(head?.textContent ?? "") ||
            ["pre", "pre-wrap"].includes(getComputedStyle(head).whiteSpace),
        };
      }),
    );
    const broken = seams.filter((s) => s.joined !== s.title || !s.keepsSpace);
    if (broken.length) {
      throw new Error(`tab titles lose their seam: ${JSON.stringify(broken)}`);
    }
    const stranded = geom.filter((g) => g.gap == null || g.gap > 12);
    if (stranded.length) {
      throw new Error(
        `close button is not at the tab's right edge: ${geom.map((g) => g.gap).join(", ")}`,
      );
    }
    await shot("tab-strip-many-dark");
  });
});
