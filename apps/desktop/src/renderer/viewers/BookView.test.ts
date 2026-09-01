import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bytes: { bytes: null as Uint8Array | null, error: "", loading: false },
  unzip: vi.fn(),
  unzipSync: vi.fn(),
  parseEpub: vi.fn(),
  chapterHtml: vi.fn(),
  findEntry: vi.fn(),
  textOf: vi.fn(),
  stagePreviewHtml: vi.fn(),
  frameIsDark: vi.fn(),
  foliateProps: null as { name: string; bytes: Uint8Array } | null,
}));

vi.mock("fflate", () => ({ unzip: mocks.unzip, unzipSync: mocks.unzipSync }));
vi.mock("../api", () => ({ api: { stagePreviewHtml: mocks.stagePreviewHtml } }));
vi.mock("./epub", () => ({ parseEpub: mocks.parseEpub, chapterHtml: mocks.chapterHtml }));
vi.mock("./zipdoc", () => ({ findEntry: mocks.findEntry }));
vi.mock("./frameTheme", () => ({ frameIsDark: mocks.frameIsDark, useFrameTheme: () => "light" }));
vi.mock("./htmlText", () => ({ textOf: mocks.textOf }));
vi.mock("./useFileBytes", () => ({ useFileBytes: vi.fn(() => mocks.bytes) }));
vi.mock("./FoliateBookView", () => ({
  default: (props: { name: string; bytes: Uint8Array }) => {
    mocks.foliateProps = props;
    return null;
  },
}));

const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

const files = {
  "chapter-1.xhtml": new TextEncoder().encode("<p>First chapter</p>"),
  "chapter-2.xhtml": new TextEncoder().encode("<p>Second chapter</p>"),
};

const book = {
  title: "Team Notes",
  author: "Ada",
  cover: "data:image/png;base64,cover",
  chapters: [
    { path: "chapter-1.xhtml", title: "First" },
    { path: "chapter-2.xhtml", title: "Second" },
  ],
};

type Props = { dataB64?: string | null; mediaToken?: string | null; name?: string };
type View = Awaited<ReturnType<typeof renderBook>>;

beforeEach(() => {
  mocks.bytes = { bytes: new Uint8Array([1]), error: "", loading: false };
  mocks.unzip.mockReset().mockImplementation((_bytes, done) => done(null, files));
  mocks.unzipSync.mockReset().mockReturnValue(files);
  mocks.parseEpub.mockReset().mockReturnValue(book);
  mocks.chapterHtml.mockReset().mockImplementation((_files, path, fontSize, dark) => `${path}:${fontSize}:${dark}`);
  mocks.findEntry.mockReset().mockImplementation((entries, path) => entries[path]);
  mocks.textOf.mockReset().mockImplementation((html) => String(html).replace(/<[^>]+>/g, ""));
  mocks.stagePreviewHtml.mockReset().mockResolvedValue("chapter-token");
  mocks.frameIsDark.mockReset().mockReturnValue(false);
  mocks.foliateProps = null;
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

async function flush(rounds = 6) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function renderBook(props: Props = {}) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

  const [{ createRoot }, { default: BookView }] = await Promise.all([
    import("react-dom/client"),
    import("./BookView"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const draw = async (next: Props = props) => {
    await act(async () => {
      root.render(createElement(BookView, { name: "team.epub", mediaToken: "book-token", ...next }));
      await Promise.resolve();
    });
  };
  await draw();
  return { close: async () => act(async () => root.unmount()), document, draw, host };
}

function reactHandler(element: Element, name: string): (event: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error(`React prop ${name} missing`);
  return (element as unknown as Record<string, Record<string, (event: Record<string, unknown>) => void>>)[key][name];
}

function button(view: View, label: string) {
  const found = [...view.host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
  if (!found) throw new Error(`button missing: ${label}`);
  return found;
}

async function click(view: View, label: string) {
  const target = button(view, label);
  await act(async () => {
    reactHandler(target, "onClick")({ currentTarget: target, target });
    await Promise.resolve();
  });
  return target;
}

describe("BookView", () => {
  it("stages fake EPUB chapters and keeps reader navigation, contents, text, and font controls aligned", async () => {
    const view = await renderBook();
    await flush();

    expect(mocks.unzip).toHaveBeenCalledWith(new Uint8Array([1]), expect.any(Function));
    expect(mocks.parseEpub).toHaveBeenCalledWith(files);
    expect(mocks.chapterHtml).toHaveBeenCalledWith(files, "chapter-1.xhtml", 1, false);
    expect(view.host.querySelector("iframe")?.getAttribute("src")).toBe("roomdoc://localhost/chapter-token");
    expect(view.host.textContent).toContain("First · 1 of 2");
    expect(view.host.querySelector(".book-progress")?.getAttribute("style")).toContain("0%");

    await click(view, "Contents");
    expect(view.host.querySelector(".book-cover")?.getAttribute("src")).toBe(book.cover);
    expect(view.host.querySelector(".book-toc")?.textContent).toContain("Ada");
    await click(view, "Second");
    await flush();
    expect(view.host.textContent).toContain("Second · 2 of 2");
    expect(button(view, "Next ›").hasAttribute("disabled")).toBe(true);
    expect(mocks.chapterHtml).toHaveBeenLastCalledWith(files, "chapter-2.xhtml", 1, false);

    await click(view, "Text");
    expect(view.host.querySelector(".book-text")?.textContent).toContain("Second chapter");
    await click(view, "Page");
    await click(view, "A+");
    await flush();
    expect(mocks.chapterHtml).toHaveBeenLastCalledWith(files, "chapter-2.xhtml", 1.15, false);
    await click(view, "A−");
    await click(view, "‹ Previous");
    await flush();
    expect(view.host.textContent).toContain("First · 1 of 2");
    await click(view, "Next ›");
    await flush();
    expect(view.host.textContent).toContain("Second · 2 of 2");

    const reader = view.host.querySelector(".book-view");
    if (!reader) throw new Error("reader missing");
    await act(async () => {
      reactHandler(reader, "onKeyDown")({ key: "ArrowLeft" });
      await Promise.resolve();
    });
    await flush();
    expect(view.host.textContent).toContain("First · 1 of 2");
    await view.close();
  });

  it("preserves EPUB failure states, including fflate's synchronous-worker fallback", async () => {
    mocks.bytes = { bytes: null, error: "", loading: true };
    const view = await renderBook();
    expect(view.host.textContent).toContain("Opening book…");

    mocks.bytes = { bytes: null, error: "The staged book expired.", loading: false };
    await view.draw();
    expect(view.host.textContent).toContain("The staged book expired.");

    mocks.bytes = { bytes: null, error: "", loading: false };
    await view.draw();
    expect(view.host.textContent).toContain("Reading book…");

    mocks.bytes = { bytes: new Uint8Array([2]), error: "", loading: false };
    mocks.unzip.mockImplementationOnce((_bytes, done) => done(new Error("bad archive"), {}));
    await view.draw();
    await flush();
    expect(view.host.textContent).toContain("This book could not be read: bad archive");

    mocks.bytes = { bytes: new Uint8Array([3]), error: "", loading: false };
    mocks.unzip.mockImplementationOnce(() => { throw new Error("worker blocked"); });
    await view.draw();
    await flush();
    expect(mocks.unzipSync).toHaveBeenCalledWith(new Uint8Array([3]));
    expect(view.host.querySelector("iframe")?.getAttribute("src")).toBe("roomdoc://localhost/chapter-token");

    mocks.bytes = { bytes: new Uint8Array([4]), error: "", loading: false };
    mocks.parseEpub.mockReturnValueOnce(null);
    await view.draw();
    await flush();
    expect(view.host.textContent).toContain("No chapters could be read from this book.");

    mocks.bytes = { bytes: new Uint8Array([5]), error: "", loading: false };
    mocks.parseEpub.mockImplementationOnce(() => { throw new Error("bad contents"); });
    await view.draw();
    await flush();
    expect(view.host.textContent).toContain("This book could not be read: Error: bad contents");

    mocks.bytes = { bytes: new Uint8Array([6]), error: "", loading: false };
    mocks.unzip.mockImplementationOnce(() => { throw new Error("worker blocked again"); });
    mocks.unzipSync.mockImplementationOnce(() => { throw new Error("sync blocked"); });
    await view.draw();
    await flush();
    expect(view.host.textContent).toContain("This book could not be read: Error: sync blocked");
    await view.close();
  });

  it("reports chapter staging and selectable-text failures while still routing alternate book formats to Foliate", async () => {
    mocks.stagePreviewHtml.mockRejectedValueOnce(new Error("staging unavailable"));
    const brokenStage = await renderBook();
    await flush();
    expect(brokenStage.host.textContent).toContain("This chapter could not be shown: Error: staging unavailable");
    await brokenStage.close();

    mocks.findEntry.mockReturnValueOnce(undefined);
    const noText = await renderBook();
    await flush();
    await click(noText, "Text");
    expect(noText.host.textContent).toContain("This chapter has no text of its own");
    await noText.close();

    mocks.textOf.mockImplementationOnce(() => { throw new Error("not HTML"); });
    const invalidText = await renderBook();
    await flush();
    await click(invalidText, "Text");
    expect(invalidText.host.textContent).toContain("This chapter has no text of its own");
    await invalidText.close();

    const bytes = new Uint8Array([7, 8]);
    mocks.bytes = { bytes, error: "", loading: false };
    const alternate = await renderBook({ name: "comic.cbz" });
    expect(mocks.foliateProps).toEqual({ name: "comic.cbz", bytes });
    await alternate.close();
  });
});
