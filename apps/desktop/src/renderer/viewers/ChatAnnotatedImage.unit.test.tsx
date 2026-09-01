import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FileContent, ImageBox } from "../api";

const mocks = vi.hoisted(() => ({
  api: { getFileContent: vi.fn() },
  fileUrl: vi.fn(),
}));

vi.mock("../api", () => ({ api: mocks.api }));
vi.mock("./util", () => ({ BOX_COLORS: ["#f00", "#0f0"] }));
vi.mock("./useFileBytes", () => ({ fileUrl: mocks.fileUrl }));

import ChatAnnotatedImage from "./ChatAnnotatedImage";

const globalKeys = ["window", "document", "navigator", "HTMLElement", "HTMLImageElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

const boxes: ImageBox[] = [
  { label: "face", x1: 0.1, y1: 0.25, x2: 0.5, y2: 0.75 },
  { label: "sign", x1: 0, y1: 0, x2: 1, y2: 1 },
  { label: "tree", x1: 0.4, y1: 0.5, x2: 0.6, y2: 0.7 },
];

function image(overrides: Partial<FileContent> = {}): FileContent {
  return {
    kind: "image",
    name: "diagram.png",
    mime: "image/png",
    editable: false,
    text: null,
    dataB64: null,
    mediaToken: "image-token",
    mediaMeta: null,
    webMeta: null,
    ...overrides,
  };
}

async function flush(rounds = 8) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function render(input: React.ComponentProps<typeof ChatAnnotatedImage> = {
  fileId: "image-1",
  boxes,
}) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window, document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    HTMLImageElement: window.HTMLImageElement, Event: window.Event, React,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Reflect.set(globalThis, key, value);
  }
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const draw = async (next = input) => {
    await act(async () => root.render(createElement(ChatAnnotatedImage, next)));
    await flush();
  };
  await draw();
  return { draw, host, root };
}

function reactHandler(element: Element, name: string): (event: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error(`React prop ${name} missing`);
  return (element as unknown as Record<string, Record<string, (event: Record<string, unknown>) => void>>)[key]![name]!;
}

beforeEach(() => {
  mocks.api.getFileContent.mockReset().mockResolvedValue(image());
  mocks.fileUrl.mockReset().mockImplementation((token: string | null | undefined) =>
    token ? `roommedia://fake/${token}` : null,
  );
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("ChatAnnotatedImage with fabricated room-file API", () => {
  it("renders a legacy data image and wraps annotation colors and positions", async () => {
    mocks.api.getFileContent.mockResolvedValue(image({ dataB64: "AQI=", mediaToken: null }));
    const view = await render();

    const picture = view.host.querySelector("img");
    const annotations = view.host.querySelectorAll(".img-box");
    expect(picture?.getAttribute("src")).toBe("data:image/png;base64,AQI=");
    expect(picture?.getAttribute("alt")).toBe("diagram.png");
    expect(mocks.fileUrl).toHaveBeenCalledWith(undefined);
    expect(annotations).toHaveLength(3);
    expect((annotations[0] as HTMLElement).style.left).toBe("10%");
    expect((annotations[0] as HTMLElement).style.height).toBe("50%");
    expect((annotations[1] as HTMLElement).style.borderColor).toBe("#0f0");
    expect((annotations[2] as HTMLElement).style.borderColor).toBe("#f00");
    expect([...view.host.querySelectorAll(".img-box-label")].map((label) => label.textContent)).toEqual(["face", "sign", "tree"]);
    await act(async () => view.root.unmount());
  });

  it("uses the fabricated streaming URL", async () => {
    const view = await render();

    expect(view.host.querySelector("img")?.getAttribute("src")).toBe("roommedia://fake/image-token");
    expect(mocks.fileUrl).toHaveBeenCalledWith("image-token");
    await act(async () => view.root.unmount());
  });

  it("explains an image response with no readable bytes", async () => {
    mocks.api.getFileContent.mockResolvedValue(image({ mediaToken: null }));
    const view = await render({ fileId: "image-2", boxes: [] });

    expect(view.host.textContent).toContain("couldn’t be loaded from this room");
    await act(async () => view.root.unmount());
  });

  it("explains invalid and rejected file responses instead of silently omitting them", async () => {
    mocks.api.getFileContent
      .mockResolvedValueOnce(image({ kind: "text" }))
      .mockRejectedValueOnce(new Error("fake fetch failure"));
    const view = await render();

    expect(view.host.textContent).toContain("couldn’t be loaded from this room");
    await view.draw({ fileId: "image-2", boxes: [] });
    expect(view.host.textContent).toContain("couldn’t be loaded from this room");
    await act(async () => view.root.unmount());
  });

  it("shows the failure hint when the fabricated image element errors", async () => {
    const view = await render();
    const picture = view.host.querySelector("img");
    if (!picture) throw new Error("fake image missing");

    await act(async () => reactHandler(picture, "onError")({ currentTarget: picture, target: picture }));
    expect(view.host.textContent).toContain("couldn’t be loaded from this room");
    await act(async () => view.root.unmount());
  });

  it("does not revive an unmounted image from a late fabricated response", async () => {
    let resolve: (content: FileContent) => void = () => {};
    mocks.api.getFileContent.mockImplementationOnce(() => new Promise<FileContent>((done) => {
      resolve = done;
    }));
    const view = await render();

    await act(async () => view.root.unmount());
    await act(async () => resolve(image()));
    expect(view.host.innerHTML).toBe("");
  });
});
