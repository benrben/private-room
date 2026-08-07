// The room reads a recording: Notes, Highlights and Chapters.
//
// These three tabs used to be placeholders that said "nothing here" — three
// dead buttons in a four-tab row. The room now reads every recording by itself
// (on Stop, and in the background for recordings it already had) and fills
// them in; the button is for when it did not, or when the transcript changed.
//
// THE CLAIM THIS SPEC EXISTS FOR. The room is sometimes wrong, and an invented
// action item with a real colleague's name on it must never be indistinguishable
// from a note the user wrote. So every item says who put it there, and an item
// the ROOM wrote is drawn differently and carries "?" in TEXT — a difference
// that survives a screenshot, a colourblind reader and a screen reader.
//
// WHAT THIS SPEC CANNOT SEE. `qa/qa-mock.js` stands in for the backend, so the
// reading itself — windowing every part of a long meeting, dropping a turn
// number the model invented, the retry — is not exercised here and cannot be.
// That half is covered by `commands::jobs::rec_read::tests` (coverage, the
// hallucinated-number guard, the re-read rule) and
// `sidecar/tests/test_rec_read.py` (the prompt, the retry, the skipped window).

import { openApp, openFile } from "./helpers.mjs";

const TAB = (name) => `.rec-tabs .rec-tab*=${name}`;
const FOUND = '[data-testid="rec-found"]';
const READ_BTN = '[data-testid="rec-read-btn"]';
const EMPTY = '[data-testid="rec-read-empty"]';

const READ = "Monday standup"; // arrives already read
const UNREAD = "Product review"; // nobody has read this one

async function openRecording(name) {
  await openFile(name);
  await $(".rec-tabs").waitForDisplayed({ timeout: 15_000 });
}

async function tab(name) {
  const t = await $(".rec-tabs").$(`.rec-tab*=${name}`);
  await t.waitForDisplayed({ timeout: 10_000 });
  await t.click();
}

/** Every item in the open panel: its text, and whether the ROOM wrote it. */
const items = () =>
  browser.execute(
    (sel) =>
      [...document.querySelectorAll(sel)].map((e) => ({
        text: e.textContent ?? "",
        by: e.dataset.by,
        marked: !!e.querySelector(".rec-found-mark"),
      })),
    FOUND,
  );

describe("the room reads a recording", () => {
  beforeEach(async () => {
    await openApp();
  });

  it("fills the three tabs by itself, with no button pressed", async () => {
    await openRecording(READ);
    await tab("Chapters");
    await expect((await items()).length).toBeGreaterThan(0);
    await tab("Highlights");
    await expect((await items()).length).toBeGreaterThan(0);
    await tab("Notes");
    const notes = await items();
    await expect(notes.length).toBeGreaterThan(0);
    // Notes read in the order a person opens a finished meeting to find:
    // what was settled, what somebody owes, what is open, then the summary.
    await expect(notes[0].text).toContain("Decided");
  });

  it("says which items it wrote and which are yours", async () => {
    await openRecording(READ);
    await tab("Notes");
    const notes = await items();
    const room = notes.filter((n) => n.by === "room");
    const mine = notes.filter((n) => n.by === "you");
    await expect(room.length).toBeGreaterThan(0);
    await expect(mine.length).toBeGreaterThan(0);
    // The mark is in TEXT, not colour alone — the one difference that may
    // never be missed.
    await expect(room.every((n) => n.marked)).toBe(true);
    await expect(mine.some((n) => n.marked)).toBe(false);
  });

  it("names who owes an action, when the transcript said", async () => {
    await openRecording(READ);
    await tab("Notes");
    const text = (await items()).map((n) => n.text).join(" ");
    await expect(text).toContain("To do");
    await expect(text).toContain("Dana");
  });

  it("counts what it found on the tab itself", async () => {
    // The tab row used to carry an "empty" flag because three tabs could never
    // hold anything. What a reader needs now is how much is in each.
    await openRecording(READ);
    const counts = await browser.execute(() =>
      [...document.querySelectorAll(".rec-tabs .rec-tab")].map((e) => ({
        label: e.textContent ?? "",
        badge: e.querySelector(".rec-tab-count")?.textContent ?? "",
      })),
    );
    const notes = counts.find((c) => c.label.startsWith("Notes"));
    await expect(notes.badge).not.toBe("");
  });

  it("offers to read a recording nobody has read, instead of apologising", async () => {
    await openRecording(UNREAD);
    await tab("Notes");
    const empty = await $(EMPTY);
    await empty.waitForDisplayed({ timeout: 10_000 });
    await expect(await empty.getText()).toContain("Not read yet");
    await expect(await $(READ_BTN).isDisplayed()).toBe(true);
  });

  it("reads it when you press the button, and keeps what you wrote", async () => {
    await openRecording(READ);
    await tab("Notes");
    const before = await items();
    const mine = before.find((n) => n.by === "you");
    await expect(mine).toBeDefined();

    await (await $(READ_BTN)).click();
    await browser.waitUntil(
      async () => (await items()).some((n) => n.text.includes("Ship search on Thursday")),
      { timeout: 10_000, timeoutMsg: "the reading never landed" },
    );
    // The room's own previous findings are replaced; the user's note is not.
    const after = await items();
    await expect(after.some((n) => n.text === mine.text)).toBe(true);
    await expect(after.filter((n) => n.by === "you").length).toBe(
      before.filter((n) => n.by === "you").length,
    );
  });

  it("lets you mark a stretch you selected", async () => {
    await openRecording(READ);
    await tab("Highlights");
    const before = (await items()).length;

    // Select words in the transcript, then Mark. Not an edit: no cut, no
    // rewrite — which is why it sits before the two buttons that do change the
    // transcript.
    await tab("Transcript");
    await browser.execute(() => {
      const words = document.querySelectorAll(".rec-word");
      if (words.length < 2) return;
      const r = document.createRange();
      r.setStartBefore(words[0]);
      r.setEndAfter(words[1]);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      document.dispatchEvent(new Event("selectionchange"));
    });
    const mark = await $('[data-testid="mark-selection"]');
    await mark.waitForDisplayed({ timeout: 10_000 });
    await mark.click();

    await tab("Highlights");
    await browser.waitUntil(async () => (await items()).length === before + 1, {
      timeout: 10_000,
      timeoutMsg: "the mark never appeared in Highlights",
    });
    // Yours, so the next reading leaves it alone — and no "?" on it.
    const added = (await items()).filter((i) => i.by === "you");
    await expect(added.length).toBeGreaterThan(0);
    await expect(added.every((i) => !i.marked)).toBe(true);
  });

  it("lets you name a section yourself", async () => {
    await openRecording(READ);
    await tab("Chapters");
    const before = (await items()).length;
    await (await $('[data-testid="add-chapter"]')).click();
    const input = await $('[data-testid="chapter-input"]');
    await input.waitForDisplayed({ timeout: 5_000 });
    await input.addValue("My own section");
    await browser.keys(["Enter"]);
    await browser.waitUntil(
      async () => (await items()).some((i) => i.text.includes("My own section")),
      { timeout: 10_000, timeoutMsg: "the chapter was never added" },
    );
    await expect((await items()).length).toBe(before + 1);
    const mine = (await items()).find((i) => i.text.includes("My own section"));
    await expect(mine.by).toBe("you");
    await expect(mine.marked).toBe(false);
  });

  it("lets you remove something it found", async () => {
    await openRecording(READ);
    await tab("Chapters");
    const before = (await items()).length;
    await (await $('[data-testid="rec-found-remove"]')).click();
    await browser.waitUntil(async () => (await items()).length === before - 1, {
      timeout: 10_000,
      timeoutMsg: "the item was never removed",
    });
  });

  it("jumps to the moment an item came from", async () => {
    await openRecording(READ);
    await tab("Highlights");
    await (await $(`${FOUND} .rec-found-at`)).click();
    // Seeking is the audio element's business; what this asserts is that the
    // control is a real button wired to a time, not decoration.
    await expect(await $(`${FOUND} .rec-found-at`).getTagName()).toBe("button");
  });
});
