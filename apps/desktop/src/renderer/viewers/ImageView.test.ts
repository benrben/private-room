import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: {
    aiStatus: vi.fn(),
    cancelAsk: vi.fn(),
    groundingModelForRoom: vi.fn(),
    locateInImage: vi.fn(),
    pullModel: vi.fn(),
  },
  bytes: { bytes: null, error: "", loading: false },
  decoded: { error: "", loading: false, url: null },
  listen: vi.fn(),
  recommendedModels: vi.fn(),
}));

vi.mock("../api", () => ({
  api: mocks.api,
  recommendedModels: mocks.recommendedModels,
}));
vi.mock("../platform", () => ({ listen: mocks.listen }));
vi.mock("./util", () => ({
  BOX_COLORS: ["#f00", "#0f0"],
  ocrBody: (value: string | null | undefined) => value?.trim() || "",
}));
vi.mock("./useFileBytes", () => ({
  fileUrl: (token: string | null | undefined) =>
    token ? `roommedia://localhost/${token}` : null,
  useFileBytes: vi.fn(() => mocks.bytes),
}));
vi.mock("./useDecodedRaster", () => ({
  useDecodedRaster: vi.fn(() => mocks.decoded),
}));
vi.mock("./derivedPreviewStatus", () => ({
  derivedPreviewCaption: (status: { kind: string }) =>
    `Preview: ${status.kind}`,
}));

const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLImageElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type ImageProps = {
  dataB64?: string | null;
  derivedPreview?: {
    kind: "stored-snapshot" | "stored-preview";
    originalMime: string;
  };
  fileId?: string;
  mediaToken?: string | null;
  mime?: string;
  name?: string;
  text?: string | null;
};
type View = Awaited<ReturnType<typeof renderImage>>;

beforeEach(() => {
  mocks.bytes = { bytes: null, error: "", loading: false };
  mocks.decoded = { error: "", loading: false, url: null };
  mocks.api.aiStatus.mockReset().mockResolvedValue({ running: false });
  mocks.api.cancelAsk.mockReset().mockResolvedValue(undefined);
  mocks.api.groundingModelForRoom
    .mockReset()
    .mockResolvedValue("existing-vision");
  mocks.api.locateInImage.mockReset();
  mocks.api.pullModel.mockReset().mockResolvedValue(undefined);
  mocks.listen.mockReset().mockResolvedValue(vi.fn());
  mocks.recommendedModels.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

async function flush(rounds = 5) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function renderImage(props: ImageProps = {}) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLImageElement", window.HTMLImageElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

  const [{ createRoot }, { default: ImageView }] = await Promise.all([
    import("react-dom/client"),
    import("./ImageView"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const draw = async (next: ImageProps = props) => {
    await act(async () => {
      root.render(
        createElement(ImageView, {
          fileId: "image-1",
          name: "photo.png",
          mime: "image/png",
          mediaToken: "media-token",
          ...next,
        }),
      );
      await Promise.resolve();
    });
  };
  await draw();
  return {
    close: async () => act(async () => root.unmount()),
    document,
    draw,
    host,
    window,
  };
}

function reactProp(
  element: Element,
  name: string,
): (event: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) =>
    candidate.startsWith("__reactProps"),
  );
  if (!key) throw new Error(`React props missing for ${name}`);
  return (
    element as unknown as Record<
      string,
      Record<string, (event: Record<string, unknown>) => void>
    >
  )[key][name];
}

async function invoke(
  element: Element,
  name = "onClick",
  event: Record<string, unknown> = {},
) {
  await act(async () =>
    reactProp(
      element,
      name,
    )({
      currentTarget: element,
      preventDefault: vi.fn(),
      target: element,
      ...event,
    }),
  );
}

async function setValue(element: Element, value: string) {
  await invoke(element, "onChange", { target: { value } });
}

function button(view: View, text: string) {
  const result = [...view.host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!result) throw new Error(`button not found: ${text}`);
  return result;
}

function image(view: View) {
  const result = view.host.querySelector("img");
  if (!result) throw new Error("image not found");
  return result as HTMLImageElement;
}

async function invokeDetached(
  element: Element,
  name = "onClick",
  event: Record<string, unknown> = {},
) {
  await act(async () => {
    void reactProp(
      element,
      name,
    )({
      currentTarget: element,
      preventDefault: vi.fn(),
      target: element,
      ...event,
    });
    await Promise.resolve();
  });
}

describe("ImageView", () => {
  it("renders streamed/base64 pictures, OCR and provenance while preserving zoom and pan", async () => {
    const view = await renderImage({
      dataB64: "ZGF0YQ==",
      derivedPreview: { kind: "stored-snapshot", originalMime: "image/heic" },
      name: " photo.PNG ",
      text: "  read text  ",
    });
    const picture = image(view);
    Object.defineProperty(picture, "clientWidth", {
      configurable: true,
      value: 100,
    });
    Object.defineProperty(picture, "naturalWidth", {
      configurable: true,
      value: 200,
    });
    await invoke(picture, "onLoad", { currentTarget: picture });
    expect(picture.getAttribute("src")).toBe("data:image/png;base64,ZGF0YQ==");
    expect(picture.getAttribute("alt")).toBe("photo.PNG");
    expect(view.host.textContent).toContain("Preview: stored-snapshot");
    expect(view.host.textContent).toContain("Text read from this picture");
    expect(view.host.textContent).toContain("read text");

    await invoke(button(view, "+"));
    expect(view.host.textContent).toContain("75%");
    await invoke(button(view, "−"));
    expect(view.host.textContent).toContain("50%");
    await invoke(button(view, "100%"));
    expect(view.host.textContent).toContain("100%");
    await invoke(button(view, "+"));
    expect(view.host.textContent).toContain("125%");
    expect(
      view.host.querySelector(".img-wrap")?.getAttribute("style"),
    ).toContain("width:250px");

    const scroll = view.host.querySelector(".img-scroll") as HTMLDivElement;
    scroll.setPointerCapture = vi.fn();
    scroll.releasePointerCapture = vi.fn();
    scroll.scrollLeft = 30;
    scroll.scrollTop = 40;
    await invoke(scroll, "onPointerDown", {
      clientX: 50,
      clientY: 60,
      pointerId: 7,
    });
    await invoke(scroll, "onPointerMove", {
      clientX: 40,
      clientY: 45,
      pointerId: 7,
    });
    expect(scroll.scrollLeft).toBe(40);
    expect(scroll.scrollTop).toBe(55);
    await invoke(scroll, "onPointerUp", { pointerId: 7 });
    expect(scroll.releasePointerCapture).toHaveBeenCalledWith(7);
    await invoke(button(view, "Fit"));
    expect(view.host.textContent).toContain("Fit");
    await view.close();
  });

  it("marks images, displays boxes, clears them, and reports model/setup errors honestly", async () => {
    const view = await renderImage();
    const ask = view.host.querySelector(".locate-bar input");
    const form = view.host.querySelector("form");
    if (!ask || !form) throw new Error("locate controls missing");
    let finishLocate:
      | ((boxes: Array<Record<string, unknown>>) => void)
      | undefined;
    mocks.api.locateInImage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLocate = resolve;
        }),
    );
    await setValue(ask, " red button ");
    await invokeDetached(form, "onSubmit");
    expect(button(view, "…").hasAttribute("disabled")).toBe(true);
    finishLocate?.([{ label: "button", x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.5 }]);
    await flush();
    expect(mocks.api.locateInImage).toHaveBeenCalledWith(
      "image-1",
      "red button",
    );
    expect(view.host.textContent).toContain("Found 1 match.");
    expect(view.host.querySelector(".img-box-label")?.textContent).toBe(
      "button",
    );
    await invoke(button(view, "Clear"));
    expect(view.host.querySelector(".img-box")).toBeNull();

    mocks.api.locateInImage.mockResolvedValueOnce([]);
    await invoke(form, "onSubmit");
    await flush();
    expect(view.host.textContent).toContain("could not locate");
    mocks.api.locateInImage.mockResolvedValueOnce([
      { label: "first", x1: 0, y1: 0, x2: 0.1, y2: 0.1 },
      { label: "second", x1: 0.2, y1: 0.2, x2: 0.3, y2: 0.3 },
    ]);
    await invoke(form, "onSubmit");
    await flush();
    expect(view.host.textContent).toContain("Found 2 matches.");
    mocks.api.locateInImage.mockRejectedValueOnce(new Error("network down"));
    await invoke(form, "onSubmit");
    await flush();
    expect(view.host.textContent).toContain("Error: network down");

    mocks.recommendedModels.mockResolvedValueOnce({ vision: "llava:latest" });
    mocks.api.locateInImage.mockRejectedValueOnce(new Error("NO_VISION_MODEL"));
    await invoke(form, "onSubmit");
    await flush();
    expect(view.host.textContent).toContain(
      "Marking needs a model that can see images",
    );
    expect(view.host.textContent).toContain("llava:latest");
    await view.close();
  });

  it("offers, tracks, stops, completes, and reports vision-helper downloads", async () => {
    mocks.api.groundingModelForRoom.mockResolvedValue(null);
    mocks.api.aiStatus.mockResolvedValue({ running: true });
    mocks.recommendedModels.mockResolvedValue({ vision: "llava:latest" });
    let progress:
      | ((event: {
          payload: { status: string; percent: number | null };
        }) => void)
      | undefined;
    const unlisten = vi.fn();
    mocks.listen.mockImplementation(
      async (_event: string, handler: typeof progress) => {
        progress = handler;
        return unlisten;
      },
    );
    let finishPull: (() => void) | undefined;
    mocks.api.pullModel.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishPull = resolve;
        }),
    );
    const view = await renderImage();
    await flush();
    expect(view.host.textContent).toContain("llava:latest");
    await invokeDetached(button(view, "Download"));
    await flush();
    expect(view.host.textContent).toContain("Downloading…");
    if (!progress) throw new Error("progress listener missing");
    await act(async () =>
      progress?.({ payload: { status: "pulling", percent: 52.4 } }),
    );
    expect(view.host.textContent).toContain("pulling — 52%");
    await invoke(button(view, "Stop"));
    expect(mocks.api.cancelAsk).toHaveBeenCalledWith("pull:llava:latest");
    finishPull?.();
    await flush();
    expect(unlisten).toHaveBeenCalled();
    expect(view.host.textContent).toContain("Vision helper ready");
    await view.close();

    mocks.api.groundingModelForRoom.mockResolvedValue(null);
    mocks.api.aiStatus.mockResolvedValue({ running: true });
    mocks.recommendedModels.mockResolvedValue({ vision: "cancel-me" });
    mocks.api.pullModel.mockRejectedValue(
      new Error("The download was cancelled"),
    );
    const cancelled = await renderImage();
    await flush();
    await invoke(button(cancelled, "Download"));
    await flush();
    expect(cancelled.host.textContent).toContain(
      "Download stopped. Nothing was installed.",
    );
    await cancelled.close();

    mocks.api.groundingModelForRoom.mockResolvedValue(null);
    mocks.api.aiStatus.mockResolvedValue({ running: true });
    mocks.recommendedModels.mockResolvedValue({ vision: "broken-helper" });
    mocks.api.pullModel.mockRejectedValue(new Error("disk full"));
    const failed = await renderImage();
    await flush();
    await invoke(button(failed, "Download"));
    await flush();
    expect(failed.host.textContent).toContain("Error: disk full");
    await failed.close();
  });

  it("renders loading and unavailable states instead of live image controls", async () => {
    mocks.bytes = { bytes: null, error: "", loading: true };
    const loading = await renderImage({ name: "scan.TIFF" });
    expect(loading.host.textContent).toContain("Drawing TIFF preview…");
    await loading.close();

    mocks.bytes = { bytes: null, error: "room read failed", loading: false };
    const brokenRaster = await renderImage({ name: "scan.tif" });
    await flush();
    expect(brokenRaster.host.textContent).toContain("room read failed");
    expect(brokenRaster.host.querySelector(".locate-bar")).toBeNull();
    await brokenRaster.close();

    mocks.bytes = { bytes: null, error: "", loading: false };
    mocks.decoded = { error: "decoder failed", loading: false, url: null };
    const decodeFailure = await renderImage({ name: "art.jxl" });
    await flush();
    expect(decodeFailure.host.textContent).toContain("decoder failed");
    await decodeFailure.close();

    mocks.decoded = { error: "", loading: false, url: null };
    const empty = await renderImage({
      dataB64: null,
      mediaToken: null,
      name: "",
    });
    await flush();
    expect(empty.host.textContent).toContain("file appears to be empty");
    await empty.close();
  });

  it("handles image errors, blank names, and unsupported vision availability without false offers", async () => {
    const view = await renderImage({ name: "   ", mediaToken: "token" });
    const picture = image(view);
    expect(picture.getAttribute("alt")).toBe("Image preview");
    expect(picture.getAttribute("src")).toBe("roommedia://localhost/token");
    await invoke(picture, "onError");
    expect(view.host.textContent).toContain("file appears to be empty");
    await view.close();

    mocks.api.groundingModelForRoom.mockResolvedValue(null);
    mocks.api.aiStatus.mockResolvedValue({ running: false });
    const noHelper = await renderImage();
    await flush();
    expect(noHelper.host.textContent).not.toContain(
      "Nothing here can mark images yet",
    );
    await noHelper.close();

    mocks.api.groundingModelForRoom.mockRejectedValue(new Error("offline"));
    const offline = await renderImage();
    await flush();
    expect(offline.host.textContent).not.toContain(
      "Nothing here can mark images yet",
    );
    await offline.close();
  });
});
