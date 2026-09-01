import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: { slidePreview: vi.fn() },
  bytes: { bytes: null as Uint8Array | null, error: "", loading: false },
  parsePptx: vi.fn(),
  unzip: vi.fn(),
}));

vi.mock("fflate", () => ({ unzip: mocks.unzip }));
vi.mock("../api", () => ({ api: mocks.api }));
vi.mock("./pptx", () => ({ parsePptx: mocks.parsePptx }));
vi.mock("./useFileBytes", () => ({ useFileBytes: vi.fn(() => mocks.bytes) }));

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

type Props = {
  dataB64?: string | null;
  fileId?: string;
  mediaToken?: string | null;
  target?: { quote?: string };
};
type View = Awaited<ReturnType<typeof renderSlides>>;

beforeEach(() => {
  mocks.bytes = { bytes: null, error: "", loading: false };
  mocks.api.slidePreview
    .mockReset()
    .mockResolvedValue({ pngB64: "one", slides: 1 });
  mocks.parsePptx.mockReset().mockReturnValue({ aspect: 1, slides: [] });
  mocks.unzip.mockReset().mockImplementation((_bytes, done) => done(null, {}));
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

async function renderSlides(props: Props = {}) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") callback();
    return 1 as unknown as number;
  }) as typeof window.setTimeout;
  window.clearTimeout = vi.fn() as unknown as typeof window.clearTimeout;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLImageElement", window.HTMLImageElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

  const [{ createRoot }, { default: SlidesView }] = await Promise.all([
    import("react-dom/client"),
    import("./SlidesView"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const draw = async (next: Props = props) => {
    await act(async () => {
      root.render(
        createElement(SlidesView, {
          fileId: "deck-1",
          mediaToken: "media-1",
          ...next,
        }),
      );
      await Promise.resolve();
    });
  };
  await draw();
  return { close: async () => act(async () => root.unmount()), draw, host };
}

function handler(
  element: Element,
  name: string,
): (event: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) =>
    candidate.startsWith("__reactProps"),
  );
  if (!key) throw new Error(`React prop ${name} missing`);
  return (
    element as unknown as Record<
      string,
      Record<string, (event: Record<string, unknown>) => void>
    >
  )[key][name];
}

async function click(element: Element) {
  await act(async () => {
    handler(
      element,
      "onClick",
    )({ currentTarget: element, preventDefault: vi.fn(), target: element });
    await Promise.resolve();
  });
}

function button(view: View, text: string) {
  const found = [...view.host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!found) throw new Error(`button missing: ${text}`);
  return found;
}

describe("SlidesView", () => {
  it("renders parsed titles, image navigation, notes, rail selection, and prefetch", async () => {
    mocks.bytes = { bytes: new Uint8Array([1]), error: "", loading: false };
    mocks.parsePptx.mockReturnValue({
      aspect: 1,
      slides: [
        { notes: "First note", number: 1, text: "First title\nBody" },
        { notes: "Second note", number: 2, text: "Second title" },
      ],
    });
    mocks.api.slidePreview.mockImplementation((_id, at) =>
      Promise.resolve({ pngB64: at === 0 ? "one" : "two", slides: 2 }),
    );
    const view = await renderSlides();
    await flush();

    expect(view.host.textContent).toContain("Slide 1 of 2");
    expect(view.host.querySelector("img")?.getAttribute("alt")).toBe(
      "First title",
    );
    expect(mocks.api.slidePreview).toHaveBeenCalledWith("deck-1", 1);
    await click(button(view, "Speaker notes"));
    expect(view.host.textContent).toContain("First note");
    await click(button(view, "Next"));
    await flush();
    expect(view.host.textContent).toContain("Slide 2 of 2");
    expect(view.host.querySelector("img")?.getAttribute("alt")).toBe(
      "Second title",
    );
    await click(button(view, "Previous"));
    expect(view.host.textContent).toContain("Slide 1 of 2");
    await click(button(view, "First title"));
    expect(view.host.textContent).toContain("Slide 1 of 2");
    await view.close();
  });

  it("targets an AI quote by own slide number and reports outline-only parse errors", async () => {
    mocks.bytes = { bytes: new Uint8Array([2]), error: "", loading: false };
    mocks.parsePptx.mockReturnValue({
      aspect: 1,
      slides: [{ notes: "", number: 2, text: "Target quote in second" }],
    });
    mocks.api.slidePreview.mockImplementation((_id, at) =>
      Promise.resolve({ pngB64: `slide-${at}`, slides: 2 }),
    );
    const view = await renderSlides({ target: { quote: "target   quote" } });
    await flush();
    expect(view.host.textContent).toContain("Slide 2 of 2");
    await view.close();

    mocks.unzip.mockImplementation((_bytes, done) =>
      done(new Error("bad zip"), {}),
    );
    const badOutline = await renderSlides();
    await flush();
    expect(badOutline.host.textContent).toContain(
      "No slide titles or notes (bad zip)",
    );
    await badOutline.close();
  });

  it("keeps explicit read, render failure, and zero-slide messages distinct", async () => {
    mocks.bytes = { bytes: null, error: "", loading: true };
    const loading = await renderSlides();
    expect(loading.host.textContent).toContain("Opening presentation…");
    await loading.close();

    mocks.bytes = { bytes: null, error: "The room is locked.", loading: false };
    const unreadable = await renderSlides();
    expect(unreadable.host.textContent).toContain("The room is locked.");
    await unreadable.close();

    mocks.bytes = { bytes: null, error: "", loading: false };
    mocks.api.slidePreview.mockRejectedValue(new Error("Quick Look stopped"));
    const broken = await renderSlides();
    await flush();
    expect(broken.host.textContent).toContain(
      "could not be drawn (Error: Quick Look stopped)",
    );
    await broken.close();

    mocks.api.slidePreview.mockResolvedValue({ pngB64: "none", slides: 0 });
    const empty = await renderSlides();
    await flush();
    expect(empty.host.textContent).toContain(
      "No slides were found in this presentation",
    );
    await empty.close();

    mocks.api.slidePreview.mockResolvedValue(null);
    const unavailable = await renderSlides();
    await flush();
    expect(unavailable.host.textContent).toContain(
      "This Mac could not draw this slide.",
    );
    await unavailable.close();
  });

  it("keeps rendering when OOXML parsing throws after unzip succeeds", async () => {
    mocks.bytes = { bytes: new Uint8Array([3]), error: "", loading: false };
    mocks.parsePptx.mockImplementation(() => {
      throw new Error("broken outline");
    });
    const view = await renderSlides();
    await flush();
    expect(view.host.querySelector("img")?.getAttribute("src")).toContain(
      "one",
    );
    expect(view.host.querySelector(".sl-rail")?.textContent).toBe("1Slide 1");
    await view.close();
  });
});
