// Cross-recording speaker recognition — "when a voice is heard once and named,
// every later recording checks whether it has heard that voice before".
//
// GH #5 made a name an overlay on one recording. This is the half that outlives
// it: naming a speaker saves their VOICE in the room, and the next recording
// puts the name back on them. A voice the room isn't sure about stays
// "Speaker N" — which is the whole safety property, because the alternative is
// a real person's name on somebody else's words.
//
// The claim under test here is the one only the UI can make: a name the app
// GUESSED must never be indistinguishable from a name the user typed. If it
// were, a wrong guess would be wearing the user's own authority, and nothing
// downstream re-checks it.
//
// WHAT THIS SPEC CANNOT SEE. `qa/qa-mock.js` stands in for the backend, so
// whether a real voice actually clears the recognition threshold is not tested
// here and cannot be — that is measured on real audio by
// `src-tauri/tests/diar_bench.rs::voice_id_threshold_sweep`, and the matching
// rules (one name per group, ambiguity, corrections) by
// `recording::diarize::tests`. Everything below is a clause the mock mirrors
// faithfully.

import { openApp, openFile } from "./helpers.mjs";

const CHIP = '[data-testid="speaker-chip"]';
const INPUT = '[data-testid="speaker-input"]';
const VOICES = '[data-testid="saved-voices"]';
// The library shows names without their extension.
const RECOGNISED = "Monday standup";
const UNNAMED = "Product review";

const chips = () =>
  browser.execute(
    (sel) =>
      [...document.querySelectorAll(sel)].map((e) => ({
        // The "?" mark is a child span, so the NAME is the chip's own text.
        name: e.firstChild?.textContent ?? "",
        guessed: e.dataset.guessed === "true",
        title: e.title,
      })),
    CHIP,
  );

async function openRecording(name) {
  await openFile(name);
  await $(CHIP).waitForDisplayed({ timeout: 15_000 });
}

/** Click the nth chip, type a name, commit. */
async function rename(nth, name) {
  await (await $$(CHIP))[nth].click();
  const input = await $(INPUT);
  await input.waitForDisplayed({ timeout: 5_000 });
  // Backspaces rather than clearValue(): WebDriver's clear writes `.value`
  // directly and React's controlled-input tracker can miss it, which would
  // leave the recognised name in front of the correction.
  const held = (await input.getValue()).length;
  for (let i = 0; i < held; i++) await browser.keys(["Backspace"]);
  if (name) await input.addValue(name);
  await browser.keys(["Enter"]);
  await $(INPUT).waitForExist({ reverse: true, timeout: 5_000 });
}

async function openSavedVoices() {
  await (await $('button[aria-label^="Open room settings"]')).click();
  // Chained, not a descendant combinator: WebDriver's text selector has to BE
  // the whole selector, it can't be the tail of one (same reason `roomMenu` in
  // helpers.mjs chains).
  const tab = await $(".settings-nav").$(".settings-nav-item*=Voice");
  await tab.waitForDisplayed({ timeout: 10_000 });
  await tab.click();
  await $("#set-voice-ids").waitForDisplayed({ timeout: 10_000 });
}

describe("recognising a voice the room has been told the name of", () => {
  beforeEach(async () => {
    await openApp();
  });

  it("names a returning voice by itself, and says that it is guessing", async () => {
    await openRecording(RECOGNISED);
    const [first, second] = await chips();
    // Nobody has touched this transcript, and one speaker already has a name.
    await expect(second.name).toBe("Dana");
    await expect(second.guessed).toBe(true);
    // A voice it does not know stays a number. That is the honest answer, and
    // it is the one that must not regress into a confident wrong guess.
    await expect(first.name).toBe("Speaker 1");
    await expect(first.guessed).toBe(false);
  });

  it("says on hover that the name is a guess, and how to disagree", async () => {
    await openRecording(RECOGNISED);
    const [, second] = await chips();
    await expect(second.title).toMatch(/recognised from a voice you named before/i);
    await expect(second.title).toContain("Dana");
  });

  it("marks a guess in text, not colour alone", async () => {
    // A colourblind reader, a screenshot pasted into a ticket and a screen
    // reader all lose a styling difference. This is the one mark in the
    // transcript that may never be missed.
    await openRecording(RECOGNISED);
    const marks = await browser.execute(
      (sel) => [...document.querySelectorAll(`${sel} .rec-speaker-guess-mark`)].map((e) => e.textContent),
      CHIP,
    );
    await expect(marks).toEqual(["?"]);
  });

  it("stops being a guess once the user confirms the name themselves", async () => {
    await openRecording(RECOGNISED);
    // Typing the SAME name is not a no-op here — it turns the app's guess into
    // the user's assertion, and the mark has to go.
    await rename(1, "Dana");
    await browser.waitUntil(async () => !(await chips())[1].guessed, {
      timeout: 5_000,
      timeoutMsg: "the app kept calling the user's own name a guess",
    });
    await expect((await chips())[1].name).toBe("Dana");
  });

  it("takes a correction, and drops the name it had guessed", async () => {
    await openRecording(RECOGNISED);
    await rename(1, "Michal");
    await browser.waitUntil(async () => (await chips())[1].name === "Michal", {
      timeout: 5_000,
      timeoutMsg: "the correction never landed",
    });
    await expect((await chips())[1].guessed).toBe(false);
  });

  it("leaves a transcript nobody has named alone", async () => {
    // The feature must not invent names where the room has nothing to go on.
    await openRecording(UNNAMED);
    await expect((await chips()).map((c) => c.name)).toEqual([
      "Speaker 1",
      "Speaker 2",
      "Speaker 1",
    ]);
    await expect((await chips()).some((c) => c.guessed)).toBe(false);
  });

  it("lists what it has learned, with the evidence, and can forget it", async () => {
    // A store of voiceprints nobody can see is a store nobody can correct or
    // delete — so the list is part of the feature, not a nicety.
    await openSavedVoices();
    const rows = await $$(`${VOICES} .ckpt-row`);
    await expect(rows.length).toBeGreaterThan(0);
    const text = await (await $(VOICES)).getText();
    await expect(text).toContain("Dana");
    await expect(text).toMatch(/seconds? of speech|s of speech/i);

    await (await $(`${VOICES} [data-voice="Dana"] button`)).click();
    const confirm = await $(".ckpt-confirm");
    await confirm.waitForDisplayed({ timeout: 5_000 });
    // Forgetting a voice must not read as retracting what was said.
    await expect(await confirm.getText()).toMatch(/keep their names/i);
    await (await $(".ckpt-confirm .primary")).click();

    await browser.waitUntil(
      async () => !(await (await $(VOICES)).isExisting()) || !(await (await $(VOICES)).getText()).includes("Dana"),
      { timeout: 5_000, timeoutMsg: "the voice was never forgotten" },
    );
  });
});
