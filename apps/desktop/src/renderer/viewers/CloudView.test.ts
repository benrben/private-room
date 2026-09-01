import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivacyPreview } from "../apiTypes";

const mocks = vi.hoisted(() => ({
  formatSize: vi.fn((bytes: number) => `${bytes} bytes`),
  privacyPreview: vi.fn(),
  privacyStatus: vi.fn(),
}));

vi.mock("../api", () => ({
  api: {
    privacyPreview: mocks.privacyPreview,
    privacyStatus: mocks.privacyStatus,
  },
  formatSize: mocks.formatSize,
}));

const { act, createElement } = React;
const globalKeys = [
  "document",
  "window",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

function preview(overrides: Partial<PrivacyPreview> = {}): PrivacyPreview {
  return {
    text: "safe text",
    entitiesHidden: 0,
    replacements: 0,
    present: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void;
  let reject: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject: reject!, resolve: resolve! };
}

async function flush(rounds = 5) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function renderCloud(fileId = "file-1") {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const [{ createRoot }, { default: CloudView }] = await Promise.all([
    import("react-dom/client"),
    import("./CloudView"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const draw = async (nextFileId = fileId) => {
    await act(async () => {
      root.render(createElement(CloudView, { fileId: nextFileId }));
      await Promise.resolve();
    });
  };
  await draw();
  return { close: async () => act(async () => root.unmount()), draw, host };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.formatSize.mockImplementation((bytes) => `${bytes} bytes`);
  mocks.privacyPreview.mockResolvedValue(preview());
  mocks.privacyStatus.mockResolvedValue({ effectiveOn: true });
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("CloudView", () => {
  it("ignores stale preview and status completions after the file changes", async () => {
    const oldPreview = deferred<PrivacyPreview>();
    const oldStatus = deferred<{ effectiveOn: boolean }>();
    const nextPreview = deferred<PrivacyPreview>();
    const nextStatus = deferred<{ effectiveOn: boolean }>();
    mocks.privacyPreview
      .mockReturnValueOnce(oldPreview.promise)
      .mockReturnValueOnce(nextPreview.promise);
    mocks.privacyStatus
      .mockReturnValueOnce(oldStatus.promise)
      .mockReturnValueOnce(nextStatus.promise);
    const view = await renderCloud("old-file");
    expect(view.host.textContent).toContain("Preparing the cloud view");
    await view.draw("new-file");
    oldPreview.resolve(preview({ text: "old cloud text" }));
    oldStatus.resolve({ effectiveOn: false });
    await flush();
    expect(view.host.textContent).toContain("Preparing the cloud view");
    nextPreview.resolve(preview({ text: "new cloud text" }));
    nextStatus.resolve({ effectiveOn: true });
    await flush();
    expect(mocks.privacyPreview).toHaveBeenNthCalledWith(1, "old-file");
    expect(mocks.privacyPreview).toHaveBeenNthCalledWith(2, "new-file");
    expect(view.host.textContent).toContain("new cloud text");
    expect(view.host.textContent).not.toContain("old cloud text");
    expect(view.host.querySelector(".cloudview-raw")).toBeNull();
    await view.close();
  });

  it("shows protected payload text with UTF-8 sizing and longest escaped placeholders", async () => {
    const text = "אב [Person AB] [Person A] [A.*]";
    mocks.privacyPreview.mockResolvedValue(preview({
      text,
      entitiesHidden: 2,
      replacements: 3,
      present: ["[Person A]", "[A.*]", "[Person AB]"],
    }));
    const view = await renderCloud();
    await flush();
    const encoded = new TextEncoder().encode(text).length;
    expect(encoded).not.toBe(text.length);
    expect(mocks.formatSize).toHaveBeenCalledWith(encoded);
    expect(view.host.querySelector(".cloudview-size")?.textContent).toBe(`~${encoded} bytes`);
    expect(view.host.querySelector(".cloudview")?.className).toBe("cloudview");
    expect(view.host.querySelector(".cloudview-badge")?.textContent).toBe("Protected cloud payload");
    expect(view.host.querySelector(".cloudview-ribbon")?.textContent).toContain("3 mentions of 2 private details stay on this Mac.");
    expect([...view.host.querySelectorAll("mark")].map((item) => item.textContent)).toEqual([
      "[Person AB]",
      "[Person A]",
      "[A.*]",
    ]);
    expect(view.host.querySelector("mark")?.className).toBe("cloudview-mark");
    expect(view.host.querySelector(".cloudview-text")?.textContent).toBe(text);
    await view.close();
  });

  it("keeps status failures independent while giving preview failures their own error", async () => {
    mocks.privacyPreview.mockResolvedValue(preview({ text: "unmarked" }));
    mocks.privacyStatus.mockRejectedValue(new Error("status unavailable"));
    const statusFailure = await renderCloud();
    await flush();
    expect(statusFailure.host.textContent).toContain("unmarked");
    expect(statusFailure.host.textContent).toContain("nothing here is marked private");
    expect(statusFailure.host.querySelector(".cloudview-badge")?.textContent).toBe("Protected cloud payload");
    await statusFailure.close();

    mocks.privacyPreview.mockRejectedValue(new Error("preview unavailable"));
    mocks.privacyStatus.mockResolvedValue({ effectiveOn: true });
    const previewFailure = await renderCloud();
    await flush();
    expect(previewFailure.host.textContent).toContain("Could not build the cloud view: Error: preview unavailable");
    await previewFailure.close();
  });

  it("labels raw payloads as exposed and keeps singular or empty protection copy exact", async () => {
    mocks.privacyPreview.mockResolvedValue(preview({
      text: "Before [Secret] after",
      entitiesHidden: 1,
      replacements: 1,
      present: ["[Secret]"],
    }));
    mocks.privacyStatus.mockResolvedValue({ effectiveOn: false });
    const view = await renderCloud();
    await flush();
    expect(view.host.querySelector(".cloudview")?.className).toBe("cloudview cloudview-raw");
    expect(view.host.querySelector(".cloudview-badge")?.textContent).toBe("Raw cloud payload");
    expect(view.host.querySelector("mark")?.className).toBe("cloudview-mark exposed");
    expect(view.host.querySelector(".cloudview-ribbon")?.textContent).toContain("privacy door is OFF");
    expect(view.host.querySelector(".cloudview-ribbon")?.textContent).toContain("The 1 highlighted item below");
    expect(view.host.querySelector(".cloudview-text")?.textContent).toBe("Before [Secret] after");
    await view.close();

    mocks.privacyStatus.mockResolvedValue({ effectiveOn: true });
    const protectedSingular = await renderCloud();
    await flush();
    expect(protectedSingular.host.querySelector(".cloudview-badge")?.textContent).toBe("Protected cloud payload");
    expect(protectedSingular.host.querySelector("mark")?.className).toBe("cloudview-mark");
    expect(protectedSingular.host.querySelector(".cloudview-ribbon")?.textContent).toContain("1 mention of 1 private detail stays on this Mac.");
    await protectedSingular.close();

    mocks.privacyPreview.mockResolvedValue(preview({ text: "raw without highlights" }));
    mocks.privacyStatus.mockResolvedValue({ effectiveOn: false });
    const rawWithoutReplacements = await renderCloud();
    await flush();
    expect(rawWithoutReplacements.host.querySelector(".cloudview-ribbon")?.textContent).toContain("privacy door is OFF");
    expect(rawWithoutReplacements.host.querySelector(".cloudview-ribbon")?.textContent).not.toContain("highlighted item");
    await rawWithoutReplacements.close();

    mocks.privacyPreview.mockResolvedValue(preview({
      text: "[Secret one] [Secret two]",
      entitiesHidden: 2,
      replacements: 1,
      present: ["[Secret one]"],
    }));
    const rawPlural = await renderCloud();
    await flush();
    expect(rawPlural.host.querySelector(".cloudview-ribbon")?.textContent).toContain("The 2 highlighted items below");
    await rawPlural.close();
  });
});
