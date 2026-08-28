// GH #3 — "Feedback modal isn't clearing itself after publishing issue".
//
// The modal used to be mounted for the whole session and merely render null
// while closed, so React kept its text-box state and the NEXT issue opened
// prefilled with the previous one. The fix mounts it only while open, so
// closing throws the draft away.
//
// The regression this guards is invisible from the outside unless you reopen
// the modal — which is exactly what these tests do.

import { buttonIn, openApp, roomMenu } from "./helpers.mjs";

const MODAL = '[data-testid="feedback-modal"]';
const TITLE = `${MODAL} .studio-prompt-question`;
const BODY = `${MODAL} .feedback-body`;
const RAW = `${MODAL} .feedback-raw textarea`;

async function openFeedback() {
  await roomMenu("Send feedback");
  await $(MODAL).waitForDisplayed({ timeout: 10_000 });
}

async function fillDraft({ raw, title, body }) {
  await (await $(RAW)).setValue(raw);
  await (await $(TITLE)).setValue(title);
  await (await $(BODY)).setValue(body);
}

describe("GH #3 — the feedback modal starts empty every time", () => {
  beforeEach(async () => {
    await openApp();
  });

  it("clears the draft after publishing an issue", async () => {
    await openFeedback();
    await fillDraft({
      raw: "the sidebar will not expand",
      title: "Sidebar will not expand",
      body: "## What happened\n\nIt stays narrow.",
    });

    // Publish. `openUrl` goes through the opener plugin, which the mock
    // answers with null — the modal treats that as success and closes.
    await (await buttonIn(MODAL, "Open GitHub issue")).click();
    await $(MODAL).waitForExist({ reverse: true, timeout: 10_000 });

    // Reopen: every field must be empty, not the issue we just filed.
    await openFeedback();
    await expect(await $(TITLE)).toHaveValue("");
    await expect(await $(BODY)).toHaveValue("");
    await expect(await $(RAW)).toHaveValue("");
  });

  it("clears the draft after cancelling too", async () => {
    await openFeedback();
    await fillDraft({
      raw: "abandoned thought",
      title: "Abandoned",
      body: "Never mind.",
    });
    await (await buttonIn(MODAL, "Cancel")).click();
    await $(MODAL).waitForExist({ reverse: true, timeout: 10_000 });

    await openFeedback();
    await expect(await $(TITLE)).toHaveValue("");
    await expect(await $(BODY)).toHaveValue("");
    await expect(await $(RAW)).toHaveValue("");
  });

  it("reopens with its publish button disabled again", async () => {
    // Deliberately NOT a DOM-presence check. The old bug was a mounted
    // component rendering null, which leaves no element behind either — so
    // "is it in the DOM while closed?" cannot tell the two apart. What the
    // retained state DID leak is a live "Open GitHub issue" button on a modal
    // the user has not typed into yet, and that is observable.
    await openFeedback();
    const publish = await buttonIn(MODAL, "Open GitHub issue");
    await expect(await publish.isEnabled()).toBe(false);

    await fillDraft({ raw: "x", title: "Something", body: "Some detail." });
    await expect(await (await buttonIn(MODAL, "Open GitHub issue")).isEnabled()).toBe(true);
    await (await buttonIn(MODAL, "Cancel")).click();
    await $(MODAL).waitForExist({ reverse: true, timeout: 10_000 });

    await openFeedback();
    await expect(await (await buttonIn(MODAL, "Open GitHub issue")).isEnabled()).toBe(false);
  });
});
