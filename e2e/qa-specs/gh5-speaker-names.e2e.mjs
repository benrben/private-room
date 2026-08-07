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
//
// WHAT THIS SPEC CANNOT SEE. `qa/qa-mock.js` stands in for the backend, so the
// refusals `rec_set_speaker_name` makes on data the UI cannot produce — an
// empty `speaker`, and a recording with no transcript yet — are not exercised
// here and need a Rust test of their own. Everything below is a clause the
// mock mirrors faithfully, so a green run means the same thing on both sides.

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
  // Backspaces rather than setValue()'s clear: a chip that already HAS a name
  // opens with that name as the draft, and WebDriver's clear writes `.value`
  // directly — React's controlled-input tracker can miss it, which would leave
  // the old name in front of the new one.
  const held = (await input.getValue()).length;
  for (let i = 0; i < held; i++) await browser.keys(["Backspace"]);
  if (name) await input.addValue(name);
  await browser.keys([key]);
  await $(INPUT).waitForExist({ reverse: true, timeout: 5_000 });
}

/** Whether ANY speaker still carries a user-given name.
 *
 * The chips cannot answer this: a name equal to the machine label renders
 * exactly like no name at all. The re-transcribe confirmation can — it warns
 * about re-numbering only while the overlay is non-empty, which is the one
 * place "cleared" and "stored an entry that shadows itself" look different. */
async function warnsAboutNames() {
  // Re-transcribe lives in the "Export & rebuild" drawer now — §13 of the
  // notebook pass moved export and technical actions out of the reading line,
  // so the button is in the DOM with a real rect but unpainted while the
  // drawer is shut, and a click on it reports "did not become interactable".
  // Open the drawer first; it stays open for the rest of the turn, so this is
  // a no-op on every later call.
  const drawer = await $(".rec-drawer");
  if (await drawer.isExisting()) {
    const open = await drawer.getAttribute("open");
    if (open === null) {
      await (await $(".rec-drawer-head")).click();
      await browser.pause(150);
    }
  }
  await (await $('button[title^="Rebuild the transcript"]')).click();
  const confirm = await $(".rec-retrans-confirm");
  await confirm.waitForDisplayed({ timeout: 5_000 });
  const text = await confirm.getText();
  // Cancel — the notebook pass restyled the confirmation's two buttons from
  // `.subtle` to the paper controls (`.nb-btn-danger` / `.nb-btn-quiet`), so
  // ask for the one that says Cancel rather than for a class.
  await (await $(".rec-retrans-confirm .nb-btn-quiet")).click();
  await confirm.waitForDisplayed({ reverse: true, timeout: 5_000 });
  return /check the names you gave them/i.test(text);
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

  it("treats the engine's own label as clearing the name, not as a new one", async () => {
    // `rec_set_speaker_name` deletes the overlay when the name equals the
    // machine label, rather than storing an entry that shadows itself — so
    // typing "Speaker 1" over "Dana" has to end up back where it started.
    await rename(0, "Dana");
    await browser.waitUntil(async () => (await chipNames())[0] === "Dana");
    await expect(await warnsAboutNames()).toBe(true);

    await rename(0, "Speaker 1");
    await browser.waitUntil(async () => (await chipNames())[0] === "Speaker 1", {
      timeout: 5_000,
      timeoutMsg: "naming a speaker after their own label did not clear the name",
    });
    await expect(await chipNames()).toEqual(["Speaker 1", "Speaker 2", "Speaker 1"]);
    // …and the overlay is GONE, not holding "Speaker 1" -> "Speaker 1".
    await expect(await warnsAboutNames()).toBe(false);
  });

  it("caps a pasted essay at the 60 characters the backend keeps", async () => {
    // A name long enough to blow out the transcript's speaker prefix is a paste
    // accident; the backend takes the first 60 characters, and the field must
    // not let more than that through in the first place.
    const essay = "Dana".repeat(50);
    await (await $$(CHIP))[0].click();
    const input = await $(INPUT);
    await input.waitForDisplayed({ timeout: 5_000 });
    await input.addValue(essay);
    await expect(await input.getValue()).toBe(essay.slice(0, 60));

    await browser.keys(["Enter"]);
    await browser.waitUntil(async () => (await chipNames())[0] === essay.slice(0, 60), {
      timeout: 5_000,
      timeoutMsg: "the committed name was not the first 60 characters",
    });
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
