import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilmPlan, ShotPreview } from "../../api";

const bridge = vi.hoisted(() => ({
  storyFilmPlan: vi.fn(),
  storyPictures: vi.fn(),
}));
vi.mock("../../api", () => ({ api: bridge }));
vi.mock("../../icons", () => ({ LockIcon: () => null }));

import { FilmReview } from "./FilmReview";

const { act, createElement } = React;
const globals = [
  "document",
  "window",
  "navigator",
  "Node",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const saved = Object.fromEntries(
  globals.map((key) => [key, Reflect.get(globalThis, key)]),
);

function shot(overrides: Partial<ShotPreview> = {}): ShotPreview {
  return {
    shotId: "one",
    n: 1,
    action: "act",
    prompt: "A prompt",
    seconds: 4,
    model: "model",
    startFileId: null,
    endFileId: null,
    referenceFileIds: [],
    cast: [],
    faceless: [],
    joinDropped: null,
    startsOnPrevious: false,
    skip: null,
    ...overrides,
  };
}
function plan(overrides: Partial<FilmPlan> = {}): FilmPlan {
  return {
    kind: "video",
    shots: [shot()],
    sending: 1,
    skipped: 0,
    totalSeconds: 4,
    joined: 0,
    overCap: false,
    joinBlockedBy: null,
    faceless: [],
    ...overrides,
  };
}
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}
async function render(
  next: Partial<React.ComponentProps<typeof FilmReview>> = {},
) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    document,
    window,
    navigator: window.navigator,
    Node: window.Node,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const props = {
    listId: "list",
    kind: "video" as const,
    continuous: true,
    busy: false,
    onClose: vi.fn(),
    onSend: vi.fn(),
    ...next,
  };
  await act(async () => root.render(createElement(FilmReview, props)));
  await flush();
  return { host, root, props, window };
}
async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () =>
    node.dispatchEvent(
      new window.Event("click", { bubbles: true, cancelable: true }),
    ),
  );
  await flush();
}
beforeEach(() => {
  bridge.storyFilmPlan.mockReset();
  bridge.storyPictures.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("FilmReview", () => {
  it("shows loading and plan errors while keeping the dialog closeable", async () => {
    bridge.storyFilmPlan.mockRejectedValue(new Error("offline"));
    const view = await render();
    expect(view.host.textContent).toContain("offline");
    expect(bridge.storyPictures).toHaveBeenCalledOnce();
    await click(
      view.host.querySelector("button[aria-label='Close']")!,
      view.window,
    );
    expect(view.props.onClose).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });
  it("renders all video receipts, row branches, thumbnails, prompt expansion, and send controls", async () => {
    bridge.storyFilmPlan.mockResolvedValue(
      plan({
        sending: 2,
        skipped: 1,
        totalSeconds: 12,
        joined: 1,
        joinBlockedBy: "Model",
        overCap: true,
        faceless: ["Mira", "Noah"],
        shots: [
          shot({
            prompt: "x".repeat(200),
            cast: ["Mira"],
            faceless: ["Noah"],
            startFileId: "start",
            endFileId: "end",
          }),
          shot({
            shotId: "two",
            n: 2,
            startsOnPrevious: true,
            skip: "no model",
          }),
        ],
      }),
    );
    bridge.storyPictures.mockResolvedValue([
      { fileId: "start", thumbB64: "AAA" },
    ]);
    const view = await render();
    expect(view.host.textContent).toContain("one at a time");
    expect(view.host.textContent).toContain("exact final frame");
    expect(view.host.textContent).toContain("Mira, Noah");
    expect(view.host.textContent).toContain("more than this room");
    expect(view.host.querySelector("img")?.getAttribute("src")).toContain(
      "AAA",
    );
    expect(view.host.textContent).toContain("a picture from this room");
    expect(view.host.textContent).toContain("Not being sent — no model.");
    const promptButton = view.host.querySelector(".cr-review-prompt")!;
    expect(promptButton.textContent?.length).toBeLessThan(200);
    await click(promptButton, view.window);
    expect(promptButton.textContent).toHaveLength(200);
    const send = view.host.querySelector<HTMLButtonElement>(".nb-btn-primary")!;
    expect(send.disabled).toBe(true);
    await click(view.host.querySelector(".cr-form-acts .nb-btn")!, view.window);
    expect(view.props.onClose).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });
  it("renders image warnings, reference frames, singular/count and active send", async () => {
    bridge.storyFilmPlan.mockResolvedValue(
      plan({
        kind: "image",
        sending: 1,
        skipped: 1,
        totalSeconds: 0,
        faceless: ["Mira"],
        shots: [
          shot({
            seconds: null,
            model: "",
            referenceFileIds: ["ref"],
            faceless: ["Mira"],
          }),
          shot({ shotId: "skip", n: 2, skip: "later" }),
        ],
      }),
    );
    bridge.storyPictures.mockResolvedValue([
      { fileId: "ref", thumbB64: "REF" },
    ]);
    const view = await render({ kind: "image", continuous: false });
    expect(view.host.textContent).toContain("1 picture to pay for");
    expect(view.host.textContent).toContain("Mira has no picture");
    expect(view.host.textContent).toContain("nobody in this shot");
    expect(view.host.querySelector("img")?.getAttribute("src")).toContain(
      "REF",
    );
    const send = view.host.querySelector<HTMLButtonElement>(".nb-btn-primary")!;
    expect(send.disabled).toBe(false);
    await click(send, view.window);
    expect(view.props.onSend).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });
  it("keeps zero-send and missing-frame fallbacks explicit", async () => {
    bridge.storyFilmPlan.mockResolvedValue(
      plan({
        sending: 2,
        skipped: 2,
        joined: 0,
        shots: [
          shot({ startsOnPrevious: true }),
          shot({ shotId: "empty", n: 2, referenceFileIds: [""] }),
        ],
      }),
    );
    const view = await render();
    expect(view.host.textContent).toContain("Send all 2 — film them");
    expect(view.host.textContent).toContain("None of these will run on");
    expect(view.host.textContent).toContain("captured when it lands");
    await act(async () => view.root.unmount());
  });
  it("labels an all-skipped plan as having nothing to send", async () => {
    bridge.storyFilmPlan.mockResolvedValue(
      plan({ sending: 0, skipped: 1, shots: [shot({ skip: "later" })] }),
    );
    const view = await render();
    expect(view.host.textContent).toContain("Nothing to film");
    await act(async () => view.root.unmount());
  });
  it("omits image frames without a reference or a usable id", async () => {
    bridge.storyFilmPlan.mockResolvedValue(
      plan({
        kind: "image",
        shots: [
          shot({ referenceFileIds: [] }),
          shot({ shotId: "empty", n: 2, referenceFileIds: [""] }),
        ],
      }),
    );
    const view = await render({ kind: "image", continuous: false });
    expect(view.host.querySelectorAll(".cr-review-frames")).toHaveLength(1);
    await act(async () => view.root.unmount());
  });
});
