// A cloud-video refusal can happen before a frame is captured: Cloud Privacy
// removes view_media_frame from the served catalog, and the Sidecar reports one
// blocked image so the renderer can offer a human-controlled one-turn retry.
// This browser-hosted spec exercises the real ChatPane, chat action, and event
// ownership logic.  Only Electron/Sidecar are doubled.

import { openApp } from "./helpers.mjs";

describe("protected-cloud video privacy", () => {
  it("offers an image-only one-turn valve and retries the same request with bypass", async () => {
    await openApp();

    const question =
      "Inspect video.mp4 at 1:05 and describe only the visible frame.";

    await browser.execute(() => {
      const bridge = window.arcelle;
      const originalInvoke = bridge.invoke.bind(bridge);
      window.__qaTurnMs = 250;
      window.__qaPrivacyVideoCalls = [];
      let latestQuestion = "";
      let latestChatId = "";

      bridge.invoke = async (channel, args) => {
        if (channel === "ask") {
          latestQuestion = String(args?.question ?? "");
          latestChatId = String(args?.chatId ?? "");
          window.__qaPrivacyVideoCalls.push({ ...args });
          window.setTimeout(() => {
            window.__qaEmit("ask-privacy", {
              runId: args?.askId ?? null,
              chatId: args?.chatId ?? null,
              v: args?.privacyBypass
                ? { entities_hidden: 0, images_blocked: 0, bypassed: true }
                : { entities_hidden: 0, images_blocked: 1, bypassed: false },
            });
          }, 40);
        }

        const result = await originalInvoke(channel, args);
        // The stock visual fixture intentionally keeps a static conversation.
        // Preserve the just-sent question in its reload result so the valve's
        // real askAgainWithRealDetails() path can prove it retries THAT turn.
        if (
          channel === "get_messages" &&
          latestQuestion &&
          String(args?.chatId ?? "") === latestChatId &&
          Array.isArray(result)
        ) {
          return [
            ...result.filter((message) => !String(message?.id ?? "").startsWith("qa-video-")),
            {
              id: "qa-video-user",
              role: "user",
              content: latestQuestion,
              sources: [],
              createdAt: new Date().toISOString(),
              effects: null,
            },
            {
              id: "qa-video-assistant",
              role: "assistant",
              content: "The frame stayed on this Mac.",
              sources: [],
              createdAt: new Date().toISOString(),
              effects: null,
            },
          ];
        }
        return result;
      };
    });

    const composer = await $(".composer-card textarea.composer-input");
    await composer.setValue(question);
    await (await $('button[aria-label="Send"]')).click();

    const receipt = await $(".privacy-receipt");
    await receipt.waitForDisplayed({ timeout: 10_000 });
    expect(await receipt.getText()).toContain("1 image kept on this Mac");

    const retry = await receipt.$("button*=Ask again sharing blocked images");
    await retry.waitForDisplayed();
    await retry.click();
    expect(await receipt.getText()).toContain(
      "Send this question again with the blocked images?",
    );

    await (await receipt.$("button*=Yes, this once")).click();
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => window.__qaPrivacyVideoCalls.length)) === 2,
      {
        timeout: 10_000,
        timeoutMsg: "the image-only privacy valve did not dispatch its retry",
      },
    );

    const calls = await browser.execute(() => window.__qaPrivacyVideoCalls);
    expect(calls[0].privacyBypass ?? null).toBeNull();
    expect(calls[1].privacyBypass).toBe(true);
    expect(calls[1].question).toBe(question);

    await browser.waitUntil(async () => {
      const text = await receipt.getText();
      return text.includes("Real details were shared this once");
    });
  });
});
