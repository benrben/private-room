// GH #4 — "voice recording effects teams meeting mic volume lowering it".
//
// Cause: the app asked for `autoGainControl: true`. On macOS that is not a
// filter — it rides the shared input device's real gain, so Teams, Zoom or Meet
// on the same microphone hear our level changes as their own volume dropping.
//
// The fix is a constraint change, so the test is a constraint assertion: the
// qa mock records every constraint set handed to getUserMedia, and these specs
// read it back. Echo cancellation is deliberately still ON by default (it keeps
// meeting audio out of the "You" lane); the new Settings toggle is what
// releases the device for headphone users.

import { openApp } from "./helpers.mjs";

/** Every `audio:` constraint object the app has asked for this page-load. */
const asked = () => browser.execute(() => window.__qaMicConstraints || []);

/** Click the composer's dictate button and wait for the mic request to land. */
async function dictate(nth = 1) {
  await (await $(".composer .mic-btn")).click();
  await browser.waitUntil(async () => (await asked()).length >= nth, {
    timeout: 10_000,
    timeoutMsg: `the app never asked for the microphone (want ${nth} request(s))`,
  });
  return (await asked())[nth - 1];
}

/** Settings → Voice, where the microphone toggle lives. */
async function openMicSettings() {
  await (await $('.activity-rail button[aria-label^="Open room settings"]')).click();
  await $(".settings-nav").waitForDisplayed({ timeout: 10_000 });
  await (await $(".settings-nav").$("button*=Voice")).click();
  const box = await $('[data-testid="mic-voice-processing"]');
  await box.waitForDisplayed({ timeout: 10_000 });
  return box;
}

async function closeSettings() {
  await browser.keys(["Escape"]);
  await $(".settings-nav").waitForDisplayed({ reverse: true, timeout: 10_000 });
}

describe("GH #4 — recording never touches the microphone's volume", () => {
  beforeEach(async () => {
    await openApp();
  });

  it("never asks for automatic gain control", async () => {
    const c = await dictate();
    // The whole bug in one assertion. `undefined` would also be safe (the
    // browser default is off), but we state it explicitly so a future
    // `audio: true` shorthand — which lets WebKit turn AGC back on — fails here.
    await expect(c.autoGainControl).toBe(false);
  });

  it("still asks for echo cancellation by default", async () => {
    // Not incidental: without it the meeting's voices come back through the
    // speakers into the mic lane and get attributed to "You", which breaks
    // speaker separation. Turning this off is a user decision, not our default.
    const c = await dictate();
    await expect(c.echoCancellation).toBe(true);
    await expect(c.noiseSuppression).toBe(true);
  });

  it("lets the user hand the device back, without ever re-enabling gain control", async () => {
    const box = await openMicSettings();
    await expect(await box.isSelected()).toBe(true); // on by default
    await box.click();
    await expect(await box.isSelected()).toBe(false);
    await closeSettings();

    const c = await dictate();
    await expect(c.echoCancellation).toBe(false);
    await expect(c.noiseSuppression).toBe(false);
    // The setting releases voice processing; it must NOT bring gain riding
    // back — that is the one thing other apps can hear.
    await expect(c.autoGainControl).toBe(false);
  });

  it("uses the same constraints on every microphone path", async () => {
    // Dictation used to pass a bare `audio: true`, which is how the bug could
    // still be triggered from the composer after recordings were fixed.
    await dictate(1);
    await (await $(".composer .mic-btn")).click(); // stop
    await dictate(2);
    const all = await asked();
    await expect(all.length).toBeGreaterThanOrEqual(2);
    for (const c of all) {
      await expect(c).not.toBe(true); // never the `audio: true` shorthand
      await expect(c.autoGainControl).toBe(false);
    }
  });
});
