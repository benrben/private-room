/* A look at the Create page, as pixels.
 *
 * Not an assertion suite — a camera. Layout regressions are the class of bug
 * that every green test in this repo is blind to: a panel can be the right
 * width, carry the right text and still be unusable because it fills the page.
 * The model shelf was exactly that, so the fix gets checked the same way it
 * was diagnosed — by looking.
 *
 *   npm run e2e:qa -- --spec e2e/qa-specs/create-look.e2e.mjs
 *
 * Writes PNGs to qa/shots/.
 */
import fs from "node:fs";
import { openApp } from "./helpers.mjs";

const OUT = "qa/shots";

async function shoot(name) {
  fs.mkdirSync(OUT, { recursive: true });
  await browser.saveScreenshot(`${OUT}/${name}.png`);
}

async function openCreate() {
  await openApp();
  await (await $('.rail-button[data-area="create"]')).click();
  const crumb = await $(".editor-breadcrumb .crumb-title");
  await browser.waitUntil(async () => (await crumb.getText()) === "Create", {
    timeout: 10_000,
  });
}

describe("the Create page's shape", () => {
  it("shows the workspace, not a wall of model cards", async () => {
    await openCreate();
    await browser.pause(700);
    await shoot("create-images");

    // The model is one control now. If this is ever a grid again, the page
    // has regressed to spending itself on a once-per-session decision.
    const picker = await $("#cr-model");
    expect(await picker.isExisting()).toBe(true);
  });

  it("draws the Video tab with the lengths the model actually allows", async () => {
    await openCreate();
    const video = await $(".cr-tab*=Video");
    await video.click();
    await browser.pause(700);
    await shoot("create-video");
  });

  it("draws the Story tab: a cast and a shot list", async () => {
    await openCreate();
    const story = await $(".cr-tab*=Story");
    await story.click();
    await browser.pause(900);
    await shoot("create-story");
  });

  it("cuts a script into shots, and shows the arithmetic before charging", async () => {
    // Five minutes is twenty paid generations. The count, the length and the
    // runtime all have to be on screen BEFORE the button, or the button is
    // asking for a decision the reader cannot make.
    await openCreate();
    await (await $(".cr-tab*=Story")).click();
    await browser.pause(600);

    const opener = await $(".cr-split-open");
    await opener.scrollIntoView();
    await opener.click();

    const box = await $(".cr-split textarea");
    await box.setValue(
      "The harbour is empty. Mira walks the quay. A light comes on. " +
        "Doran is already there. He does not turn around. She asks about the boat. " +
        "He says nothing. The tide turns. The rope goes slack. They both run.",
    );
    await browser.pause(700);

    const sum = await $(".cr-split-sum");
    expect(await sum.isExisting()).toBe(true);
    await sum.scrollIntoView();
    await shoot("create-split");
  });

  it("takes a script that marks its own chunks at its word", async () => {
    // The reported failure: a script ALREADY broken into timestamped beats
    // came back as one 15-second shot. Its own marks must win, with their
    // own lengths — including the beats that are not 15 seconds.
    await openCreate();
    await (await $(".cr-tab*=Story")).click();
    await browser.pause(600);

    const opener = await $(".cr-split-open");
    await opener.scrollIntoView();
    await opener.click();

    const box = await $(".cr-split textarea");
    await box.setValue(
      [
        "## COLD OPEN — EXT. LUMINA — MARKET DISTRICT — DAY",
        "",
        "**00:00–00:15** — Establishing Lumina. Noa weaves through the market stalls.",
        "",
        "**00:15–00:30** — A fruit-seller's hand closes on empty air.",
        "",
        "### INT. THE VAULT — ANTECHAMBER",
        "",
        "**00:30–00:40** — Noa jolts back into her own body, gasping.",
      ].join("\n"),
    );
    await browser.pause(800);

    const sum = await $(".cr-split-sum");
    await sum.scrollIntoView();
    const text = await sum.getText();
    // Three beats, 0:40 — not one shot, and not three equal ones.
    expect(text).toContain("3");
    expect(text).toContain("0:40");
    await shoot("create-split-chunks");
  });

  it("shows every part before it charges for any of them", async () => {
    // A list of twenty is twenty billed calls, and this sheet is the last
    // place the whole run can be read. What has to be on it: how many are
    // going, what each one is actually SENT, and which picture each clip
    // opens and closes on — the join is a picture, so it can be looked at.
    await openCreate();
    await (await $(".cr-tab*=Story")).click();
    await browser.pause(700);

    // A bare `selector*=text`: wdio's partial-text form takes a SIMPLE
    // selector, so a descendant combinator in front of it is an invalid
    // selector rather than a narrower one.
    const film = await $("button*=Film them");
    await film.scrollIntoView();
    await film.click();
    await browser.pause(800);

    const sheet = await $(".cr-review");
    expect(await sheet.isExisting()).toBe(true);

    // One row per shot in the list — including any that will be skipped,
    // because a row missing from the review is a row nobody can ask about.
    const rows = await $$(".cr-review-row");
    expect(rows.length).toBeGreaterThan(0);

    // The button names the number it is about to spend.
    const go = await $(".cr-review .nb-btn-primary");
    expect(await go.getText()).toMatch(/Send all \d+|Nothing to film/);

    await shoot("create-review");
  });

  it("reads the script out of a file the room already holds", async () => {
    // The complaint this answers: the script is already a file in the Library,
    // and the panel was asking for it to be pasted in by hand.
    await openCreate();
    await (await $(".cr-tab*=Story")).click();
    await browser.pause(600);

    const opener = await $(".cr-split-open");
    await opener.scrollIntoView();
    await opener.click();

    const fromFile = await $("button*=Use a file from this room");
    await fromFile.scrollIntoView();
    await fromFile.click();
    await browser.pause(500);

    // The picker lists files by name AND opening line — a room with four
    // scripts in it cannot be navigated by filename alone.
    const doc = await $(".cr-doc");
    expect(await doc.isExisting()).toBe(true);
    await shoot("create-doc-picker");
    await doc.click();
    await browser.pause(800);

    // Its own timestamps won, and the panel says where the text came from.
    const sum = await $(".cr-split-sum");
    await sum.scrollIntoView();
    expect(await sum.getText()).toContain("3");
    await shoot("create-script-from-file");
  });

  it("reads a character sheet, and shows who it found before adding anyone", async () => {
    await openCreate();
    await (await $(".cr-tab*=Story")).click();
    await browser.pause(600);

    const read = await $("button*=Read them from a file");
    await read.scrollIntoView();
    await read.click();
    await browser.pause(500);

    // The second fixture file is the character sheet.
    const docs = await $$(".cr-doc");
    await docs[1].click();
    await browser.pause(700);

    const sheet = await $(".cr-sheet");
    expect(await sheet.isExisting()).toBe(true);
    // WHICH reader produced these. The model and the pattern fallback are not
    // equally good on a messy sheet, so "why did it split this wrong" needs
    // an answer on screen.
    expect(await sheet.getText()).toContain("qwen3.5:4b");
    // Nothing is written until this is agreed to — the button says how many.
    const keep = await $(".cr-sheet .nb-btn-primary");
    expect(await keep.getText()).toContain("Add 2 people");
    await sheet.scrollIntoView();
    await shoot("create-cast-from-file");
  });

  it("says the bench makes one clip when handed a whole script", async () => {
    // The reported failure, from the other end: a five-minute script pasted
    // into a bench that makes exactly one thing, and "it only made 15 sec".
    // Nothing was broken — but silently using the first chunk of a script and
    // discarding the rest is not the truth about what happened.
    await openCreate();
    await (await $(".cr-tab*=Video")).click();
    await browser.pause(500);

    const prompt = await $("#cr-prompt");
    await prompt.scrollIntoView();
    // Real clock times. `00:60` is not a timestamp, and a fixture full of
    // them tests the parser's rejection rather than the notice.
    const at = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    const beats = [];
    for (let i = 0; i < 12; i++) {
      beats.push(
        `**${at(i * 15)}–${at((i + 1) * 15)}** — Noa crosses the market, and the light changes.`,
      );
    }
    await prompt.setValue(beats.join("\n\n"));
    await browser.pause(900);

    const note = await $(".cr-script-note");
    expect(await note.isExisting()).toBe(true);
    // All twelve beats, and the runtime they add up to — the numbers come
    // from the same local splitter Story uses, so they are the real ones.
    expect(await note.getText()).toContain("12 chunks");
    expect(await note.getText()).toContain("3:00");
    await note.scrollIntoView();
    await shoot("create-one-clip-warning");
  });
});
