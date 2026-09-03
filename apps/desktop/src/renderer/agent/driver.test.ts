import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAgentUiRequest } from "./driver";

const mocks = vi.hoisted(() => ({
  drawToPngB64: vi.fn<(source: CanvasImageSource, width: number, height: number, maxWidth: number) => string>(),
  grabFrame: vi.fn(),
}));

vi.mock("../viewers/frameGrab", () => ({
  drawToPngB64: mocks.drawToPngB64,
  grabFrame: mocks.grabFrame,
}));

const globalKeys = [
  "document",
  "window",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "HTMLCanvasElement",
  "HTMLImageElement",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "getComputedStyle",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type DriverRequest = Parameters<typeof handleAgentUiRequest>[0];
type Snapshot = {
  count: number;
  summary: string;
  elements: Array<{ mark: number; role: string; label: string; state?: string; region: string }>;
};

function request(
  kind: DriverRequest["kind"],
  args: Record<string, unknown> = {},
): DriverRequest {
  return { id: "test", kind, args };
}

function installDom(markup = "<html><body></body></html>") {
  const parsed = parseHTML(markup);
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Object.defineProperties(window, {
    innerHeight: { configurable: true, value: 800 },
    innerWidth: { configurable: true, value: 1200 },
  });
  window.setTimeout = (() => 1) as unknown as typeof window.setTimeout;
  window.clearTimeout = vi.fn() as unknown as typeof window.clearTimeout;
  for (const key of globalKeys) {
    if (key === "getComputedStyle") continue;
    Reflect.set(globalThis, key, Reflect.get(window, key));
  }
  class FakeMouseEvent extends window.Event {
    readonly clientX: number;
    readonly clientY: number;
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
      this.clientX = init?.clientX ?? 0;
      this.clientY = init?.clientY ?? 0;
    }
  }
  Reflect.set(globalThis, "MouseEvent", FakeMouseEvent);
  Reflect.set(globalThis, "PointerEvent", FakeMouseEvent);
  Reflect.set(globalThis, "getComputedStyle", (el: Element) => ({
    display: el.getAttribute("data-display") ?? "block",
    visibility: el.getAttribute("data-visibility") ?? "visible",
    overflowY: el.getAttribute("data-overflow-y") ?? "visible",
  }));
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(window.HTMLOptionElement.prototype, "text", {
    configurable: true,
    get() {
      return this.textContent ?? "";
    },
  });
  Object.defineProperty(window.HTMLSelectElement.prototype, "selectedOptions", {
    configurable: true,
    get() {
      return this.options.length > 0 ? [this.options[0]] : [];
    },
  });
  Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
    configurable: true,
    get() {
      return this.getAttribute("data-selected-value") ?? this.options[0]?.value ?? "";
    },
    set(value: string) {
      this.setAttribute("data-selected-value", value);
    },
  });
  return { document, window };
}

function setRect(
  el: Element,
  values: Partial<{ left: number; top: number; right: number; bottom: number; width: number; height: number }> = {},
) {
  const left = values.left ?? 10;
  const top = values.top ?? 10;
  const width = values.width ?? 100;
  const height = values.height ?? 30;
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left,
      top,
      width,
      height,
      right: values.right ?? left + width,
      bottom: values.bottom ?? top + height,
    }),
  });
}

function visible(document: Document, selector: string): Element {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`missing ${selector}`);
  setRect(el);
  return el;
}

async function snapshot(): Promise<Snapshot> {
  return (await handleAgentUiRequest(request("ui_snapshot"))) as unknown as Snapshot;
}

function markFor(snapshotResult: Snapshot, label: string): number {
  const entry = snapshotResult.elements.find((element) => element.label === label);
  if (!entry) throw new Error(`missing mark for ${label}`);
  return entry.mark;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("agent UI driver", () => {
  it("snapshots accessible roles, labels, state, blocked elements, and the mark cap", async () => {
    const { document } = installDom(`
      <html><body><main>
        <a href="#">Open</a>
        <button aria-label="Send"><span aria-hidden="true">decorative</span>real text</button>
        <input id="check" type="checkbox" checked />
        <input id="search" value="draft" placeholder="Search files" />
        <input id="value-only" value="Value-derived label" />
        <select id="sort"><option>Newest</option></select>
        <div class="prompt-chip active">Pinned</div>
        <div contenteditable="true" class="source-chip">Notes</div>
        <div data-agent-blocked><button>Never shown</button></div>
        <button disabled>Disabled</button>
        <button data-display="none">Hidden</button>
      </main></body></html>
    `);
    for (const el of Array.from(document.querySelectorAll("a, button, input, select, div"))) {
      setRect(el);
    }
    const send = document.querySelector('[aria-label="Send"]');
    if (!send) throw new Error("send button missing");
    const checkVisibility = vi.fn(() => true);
    Object.assign(send, { checkVisibility });
    const checkbox = visible(document, "#check") as HTMLInputElement;
    Object.defineProperty(checkbox, "checked", { configurable: true, value: true });
    const select = visible(document, "#sort") as HTMLSelectElement;
    const option = select.querySelector("option");
    Object.defineProperty(select, "selectedOptions", { configurable: true, value: option ? [option] : [] });

    const result = await snapshot();
    if (!result.elements) throw new Error(JSON.stringify(result));

    expect(result.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "link", label: "Open", region: "chat" }),
      expect.objectContaining({ role: "button", label: "Send" }),
      expect.objectContaining({ role: "checkbox", label: "(unlabeled)", state: "checked" }),
      expect.objectContaining({ role: "textbox", label: "Search files", state: "draft" }),
      expect.objectContaining({ role: "textbox", label: "Value-derived label", state: "Value-derived label" }),
      expect.objectContaining({ role: "combobox", label: "Newest", state: "Newest" }),
      expect.objectContaining({ role: "item", label: "Pinned", state: "selected" }),
      expect.objectContaining({ role: "textbox", label: "Notes" }),
    ]));
    expect(checkVisibility).toHaveBeenCalledWith({ checkVisibilityCSS: true });
    expect(result.elements.map((entry) => entry.label)).not.toContain("Never shown");
    expect(result.elements.map((entry) => entry.label)).not.toContain("Disabled");
    expect(result.elements.map((entry) => entry.label)).not.toContain("Hidden");

    for (let index = 0; index < 81; index += 1) {
      const button = document.createElement("button");
      button.textContent = `extra ${index}`;
      setRect(button, { top: 100 + index });
      document.body.appendChild(button);
    }
    const capped = await snapshot();
    expect(capped.count).toBe(80);
    expect(capped.summary).toContain("…and 9 more (scroll to reveal)");
  });

  it("acts through marked controls while preserving validation, selection, editable, scroll, stale, and consent errors", async () => {
    const { document } = installDom(`
      <html><body><main>
        <input aria-label="Search" value="draft" />
        <textarea aria-label="Notes field">before</textarea>
        <select aria-label="Sort"><option value="new">Newest</option><option value="old">Oldest</option></select>
        <div contenteditable="true" class="prompt-chip" aria-label="Editor">start</div>
        <button aria-label="Click me">Click me</button>
        <button aria-label="No text">No text</button>
        <button aria-label="Scroll target">Scroll target</button>
        <button aria-label="Page scroll">Page scroll</button>
      </main></body></html>
    `);
    for (const el of Array.from(document.querySelectorAll("input, textarea, select, div, button"))) {
      setRect(el);
    }
    const editor = visible(document, "[contenteditable]") as HTMLElement;
    Object.defineProperty(editor, "isContentEditable", { configurable: true, value: true });
    const scrollTarget = visible(document, '[aria-label="Scroll target"]');
    const scroller = document.createElement("div");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 300 },
      scrollBy: { configurable: true, value: vi.fn() },
    });
    scroller.setAttribute("data-overflow-y", "auto");
    scrollTarget.parentElement?.appendChild(scroller);
    scroller.appendChild(scrollTarget);
    setRect(scroller);
    setRect(scrollTarget);
    const input = visible(document, "input") as HTMLInputElement;
    const textarea = visible(document, "textarea") as HTMLTextAreaElement;
    Object.defineProperty(window.HTMLTextAreaElement.prototype, "value", {
      configurable: true,
      value: "",
      writable: true,
    });
    const select = visible(document, "select") as HTMLSelectElement;
    const click = visible(document, '[aria-label="Click me"]');
    const noText = visible(document, '[aria-label="No text"]');
    visible(document, '[aria-label="Page scroll"]');
    const pageScrollBy = vi.fn();
    Object.defineProperty(document.documentElement, "scrollBy", {
      configurable: true,
      value: pageScrollBy,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: 700,
    });
    const clicked = vi.fn();
    const pointerPosition = vi.fn();
    click.addEventListener("click", clicked);
    click.addEventListener("pointerdown", (event) => pointerPosition((event as PointerEvent).clientX, (event as PointerEvent).clientY));

    const boundaryScroller = document.createElement("div");
    Object.defineProperties(boundaryScroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 100 },
      scrollBy: { configurable: true, value: vi.fn() },
    });
    boundaryScroller.setAttribute("data-overflow-y", "auto");
    const pageScroll = document.querySelector('[aria-label="Page scroll"]');
    pageScroll?.parentElement?.appendChild(boundaryScroller);
    if (pageScroll) boundaryScroller.appendChild(pageScroll);

    const result = await snapshot();
    if (!result.elements) throw new Error(JSON.stringify(result));
    const searchMark = markFor(result, "Search");
    const notesMark = markFor(result, "Notes field");
    const sortMark = markFor(result, "Sort");
    const editorMark = markFor(result, "Editor");
    const clickMark = markFor(result, "Click me");
    const noTextMark = markFor(result, "No text");
    const scrollMark = markFor(result, "Scroll target");
    const pageScrollMark = markFor(result, "Page scroll");

    await expect(handleAgentUiRequest(request("ui_act", { mark: searchMark, action: "type", text: " now" })))
      .resolves.toEqual(expect.objectContaining({ done: true, description: expect.stringContaining("Typed") }));
    expect(input.value).toBe("draft now");
    await expect(handleAgentUiRequest(request("ui_act", { mark: notesMark, action: "set", text: "replacement" })))
      .resolves.toEqual(expect.objectContaining({ done: true, description: expect.stringContaining("Set") }));
    expect(textarea.value).toBe("replacement");
    await expect(handleAgentUiRequest(request("ui_act", { mark: sortMark, action: "set", text: "oldest" })))
      .resolves.toEqual(expect.objectContaining({ done: true, description: expect.stringContaining("Oldest") }));
    expect(select.value).toBe("old");
    await expect(handleAgentUiRequest(request("ui_act", { mark: editorMark, action: "type", text: " text" })))
      .resolves.toEqual(expect.objectContaining({ done: true }));
    expect(editor.textContent).toBe("start text");
    await expect(handleAgentUiRequest(request("ui_act", { mark: clickMark, action: "click" })))
      .resolves.toEqual(expect.objectContaining({ done: true }));
    expect(clicked).toHaveBeenCalledOnce();
    expect(pointerPosition).toHaveBeenCalledWith(60, 25);
    await expect(handleAgentUiRequest(request("ui_act", { mark: scrollMark, action: "scroll", text: "up" })))
      .resolves.toEqual(expect.objectContaining({ done: true, description: expect.stringContaining("Scrolled up") }));
    expect(scroller.scrollBy).toHaveBeenCalledWith({ top: -80, behavior: "auto" });
    await expect(handleAgentUiRequest(request("ui_act", { mark: pageScrollMark, action: "scroll", text: "down" })))
      .resolves.toEqual(expect.objectContaining({ done: true, description: expect.stringContaining("Scrolled down") }));
    expect(pageScrollBy).toHaveBeenCalledWith({ top: 560, behavior: "auto" });
    expect(boundaryScroller.scrollBy).not.toHaveBeenCalled();
    await expect(handleAgentUiRequest(request("ui_act", { mark: searchMark, action: "set" })))
      .resolves.toEqual({ error: 'Action "set" needs a "text" argument.' });
    await expect(handleAgentUiRequest(request("ui_act", { mark: sortMark, action: "set", text: "missing" })))
      .resolves.toEqual({ error: '"missing" is not an option of "Sort".' });
    await expect(handleAgentUiRequest(request("ui_act", { mark: noTextMark, action: "type", text: "x" })))
      .resolves.toEqual({ error: '"No text" doesn\'t accept text — it\'s a button.' });
    await expect(handleAgentUiRequest(request("ui_act", { mark: noTextMark, action: "unsupported" })))
      .resolves.toEqual({ error: 'Unknown action "unsupported" — use click, type, set, or scroll.' });

    const fence = document.createElement("div");
    fence.setAttribute("data-agent-blocked", "");
    noText.parentElement?.appendChild(fence);
    fence.appendChild(noText);
    await expect(handleAgentUiRequest(request("ui_act", { mark: noTextMark, action: "click" })))
      .resolves.toEqual(expect.objectContaining({ error: expect.stringContaining("consent surface") }));
    click.remove();
    await expect(handleAgentUiRequest(request("ui_act", { mark: clickMark, action: "click" })))
      .resolves.toEqual({ error: "That element is gone — take a fresh ui_snapshot." });
  });

  it("returns viewer image or canvas captures and isolates export and media-frame failures", async () => {
    const { document } = installDom("<html><body><main></main></body></html>");
    mocks.drawToPngB64.mockReturnValue("image-data");
    mocks.grabFrame.mockResolvedValue({ imageB64: "frame-data" });

    await expect(handleAgentUiRequest(request("view_screenshot")))
      .resolves.toEqual(expect.objectContaining({ error: expect.stringContaining("No visual content") }));
    const pane = document.createElement("div");
    pane.className = "viewer";
    const image = document.createElement("img");
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 400 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 300 });
    setRect(image);
    pane.appendChild(image);
    document.body.appendChild(pane);
    await expect(handleAgentUiRequest(request("view_screenshot")))
      .resolves.toEqual(expect.objectContaining({ imageB64: "image-data" }));

    const firstCanvas = document.createElement("canvas");
    const secondCanvas = document.createElement("canvas");
    Object.defineProperties(firstCanvas, { width: { configurable: true, value: 100 }, height: { configurable: true, value: 80 } });
    Object.defineProperties(secondCanvas, { width: { configurable: true, value: 200 }, height: { configurable: true, value: 120 } });
    setRect(firstCanvas, { left: 1190, right: 1210, top: 790, bottom: 810, width: 20, height: 20 });
    setRect(secondCanvas, { width: 40, height: 40 });
    pane.append(firstCanvas, secondCanvas);
    await handleAgentUiRequest(request("view_screenshot"));
    expect(mocks.drawToPngB64).toHaveBeenLastCalledWith(secondCanvas, 200, 120, 1280);
    mocks.drawToPngB64.mockImplementationOnce(() => {
      throw new Error("tainted");
    });
    await expect(handleAgentUiRequest(request("view_screenshot")))
      .resolves.toEqual(expect.objectContaining({ error: expect.stringContaining("couldn't be exported") }));
    await expect(handleAgentUiRequest(request("media_frame")))
      .resolves.toEqual({ error: "media_frame needs a media token." });
    await expect(handleAgentUiRequest(request("media_frame", { token: "token", mime: "video/mp4", seconds: 4 })))
      .resolves.toEqual({ imageB64: "frame-data" });
    mocks.grabFrame.mockRejectedValueOnce(new Error("frame failed"));
    await expect(handleAgentUiRequest(request("media_frame", { token: "token" })))
      .resolves.toEqual({ error: "frame failed" });
    await expect(handleAgentUiRequest(request("skin_validate")))
      .resolves.toMatchObject({ valid: true, revision: expect.any(Number) });
    await expect(handleAgentUiRequest(request("browse_consent")))
      .resolves.toEqual({ error: 'Unknown agent UI request kind "browse_consent".' });
  });
});
