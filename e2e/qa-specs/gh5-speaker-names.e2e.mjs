// GH #5 — "voice recording speaker names, let me update it post transcribing".
//
// There was no way to rename a speaker at all: the label was drawn as read-only
// text and no backend command existed to change it. Names are now an overlay
// keyed by the machine label ("Speaker 2" -> "Dana"), so ONE edit renames every
// line that person said and the transcript keeps the label underneath — which
// is what lets the name survive the engine re-clustering the meeting.
//
// The Rust half of the same contract (the overlay does not touch `segments`,
// and legacy recordings without the field still load) is covered by
// recording::tests::speaker_names_* — this spec covers the UI and the round trip.

import { openApp, openFile } from "./helpers.mjs";

const CHIP = '[data-testid="speaker-chip"]';
const INPUT = '[data-testid="speaker-input"]';
// The library shows names without their extension.
const RECORDING = "Product review";

/** The speaker chip of every turn, top to bottom. Read in one round trip: the
 * point of most assertions here is the WHOLE column at once (one rename, every
 * line), so fetching them individually would race a re-render mid-read. */
const chipNames = () =>
  browser.execute(
    (sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent),
    CHIP,
  );

async function openRecording() {
  await openFile(RECORDING);
  await $(CHIP).waitForDisplayed({ timeout: 15_000 });
}

/** Click the nth chip, type a name, commit with `key`. */
async function rename(nth, name, key = "Enter") {
  await (await $$(CHIP))[nth].click();
  const input = await $(INPUT);
  await input.waitForDisplayed({ timeout: 5_000 });
  await input.setValue(name);
  await browser.keys([key]);
  await $(INPUT).waitForExist({ reverse: true, timeout: 5_000 });
}

describe("GH #5 — naming a speaker after the recording is transcribed", () => {
  beforeEach(async () => {
    await openApp();
    await openRecording();
  });

  it("starts from the engine's labels, which are clickable", async () => {
    // The fixture is two voices over three turns, with Speaker 1 talking twice.
    await expect(await chipNames()).toEqual(["Speaker 1", "Speaker 2", "Speaker 1"]);
    // Read-only text was the bug; these have to be real controls.
    await expect(await $(CHIP).getTagName()).toBe("button");
  });

  it("renames every line that speaker said, and nobody else's", async () => {
    await rename(0, "Dana");
    await browser.waitUntil(async () => (await chipNames())[0] === "Dana", {
      timeout: 5_000,
      timeoutMsg: "the chip never took the new name",
    });
    // Turn 3 is the same voice — one edit, both lines. Turn 2 is untouched.
    await expect(await chipNames()).toEqual(["Dana", "Speaker 2", "Dana"]);
  });

  it("keeps the name after leaving and reopening the recording", async () => {
    await rename(0, "Dana");
    await browser.waitUntil(async () => (await chipNames())[0] === "Dana");

    // Away to another file and back — the name must come from storage, not
    // from component state that happens to still be mounted.
    await openFile("Ideas");
    await $(CHIP).waitForExist({ reverse: true, timeout: 10_000 });
    await openRecording();
    await expect(await chipNames()).toEqual(["Dana", "Speaker 2", "Dana"]);
  });

  it("can name a second speaker without disturbing the first", async () => {
    await rename(0, "Dana");
    await browser.waitUntil(async () => (await chipNames())[0] === "Dana");
    await rename(1, "Yotam");
    await browser.waitUntil(async () => (await chipNames())[1] === "Yotam");
    await expect(await chipNames()).toEqual(["Dana", "Yotam", "Dana"]);
  });

  it("clears back to the engine's label when the name is emptied", async () => {
    await rename(0, "Dana");
    await browser.waitUntil(async () => (await chipNames())[0] === "Dana");

    await (await $$(CHIP))[0].click();
    const input = await $(INPUT);
    await input.waitForDisplayed();
    // Backspaces, not clearValue(): WebDriver's clear sets .value directly and
    // React's controlled-input tracker can miss it, so the component would
    // still be holding "Dana" when we commit.
    for (let i = 0; i < 10; i++) await browser.keys(["Backspace"]);
    await expect(await input.getValue()).toBe("");
    await browser.keys(["Enter"]);

    await browser.waitUntil(async () => (await chipNames())[0] === "Speaker 1", {
      timeout: 5_000,
      timeoutMsg: "emptying the name did not restore the machine label",
    });
    await expect(await chipNames()).toEqual(["Speaker 1", "Speaker 2", "Speaker 1"]);
  });

  it("abandons the edit on Escape", async () => {
    await (await $$(CHIP))[1].click();
    const input = await $(INPUT);
    await input.waitForDisplayed();
    await input.setValue("Typed by mistake");
    await browser.keys(["Escape"]);

    await $(INPUT).waitForExist({ reverse: true, timeout: 5_000 });
    await expect(await chipNames()).toEqual(["Speaker 1", "Speaker 2", "Speaker 1"]);
  });
});
