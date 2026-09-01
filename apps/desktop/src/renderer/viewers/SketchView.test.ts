import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fileUpdated: undefined as ((id: string) => void) | undefined,
  reducedMotion: false,
  sketchDrawn: undefined as
    | ((event: {
        fileId: string;
        doc: string;
        added: string[];
        removed: string[];
      }) => void)
    | undefined,
  unlisten: vi.fn(),
  api: {
    onFileUpdated: vi.fn(),
    onSketchDrawn: vi.fn(),
    saveSketch: vi.fn(),
  },
}));

vi.mock("../api", () => ({ api: mocks.api }));
vi.mock("../rooms/helpers", () => ({
  prefersReducedMotion: () => mocks.reducedMotion,
}));
vi.mock("../workspace/sketchFocus", () => ({ setSketchFocus: vi.fn() }));

const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "DOMPoint",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type SketchProps = { fileId?: string; text?: string };
type View = Awaited<ReturnType<typeof renderSketch>>;

beforeEach(() => {
  mocks.fileUpdated = undefined;
  mocks.reducedMotion = false;
  mocks.sketchDrawn = undefined;
  mocks.unlisten.mockReset();
  mocks.api.saveSketch.mockReset().mockResolvedValue(undefined);
  mocks.api.onFileUpdated.mockReset().mockImplementation(async (listener) => {
    mocks.fileUpdated = listener;
    return mocks.unlisten;
  });
  mocks.api.onSketchDrawn.mockReset().mockImplementation(async (listener) => {
    mocks.sketchDrawn = listener;
    return mocks.unlisten;
  });
});

afterEach(() => {
  vi.useRealTimers();
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

async function renderSketch(props: SketchProps = {}) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  class Point {
    constructor(
      readonly x: number,
      readonly y: number,
    ) {}
    matrixTransform() {
      return this;
    }
  }
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "DOMPoint", Point);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  (window.HTMLElement.prototype as HTMLElement).scrollIntoView = vi.fn();

  const [{ createRoot }, { default: SketchView }] = await Promise.all([
    import("react-dom/client"),
    import("./SketchView"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const draw = async (next: SketchProps = props) => {
    await act(async () => {
      root.render(
        createElement(SketchView, { fileId: "sketch-1", text: "", ...next }),
      );
      await Promise.resolve();
    });
  };
  await draw();
  const svg = host.querySelector("svg.sk-canvas") as SVGSVGElement;
  svg.getScreenCTM = () => ({ inverse: () => ({}) }) as unknown as DOMMatrix;
  svg.setPointerCapture = vi.fn();
  svg.releasePointerCapture = vi.fn();
  const stage = host.querySelector(".sk-stage") as HTMLDivElement;
  stage.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
  return {
    close: async () => act(async () => root.unmount()),
    document,
    draw,
    host,
    svg,
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
  await act(async () => {
    const input = {
      button: 0,
      clientX: 100,
      clientY: 100,
      currentTarget: element,
      pointerId: 4,
      preventDefault: vi.fn(),
      shiftKey: false,
      stopPropagation: vi.fn(),
      target: element,
      ...event,
    };
    reactProp(
      element,
      name,
    )({
      ...input,
      nativeEvent: {
        clientX: input.clientX,
        clientY: input.clientY,
        ...(event.nativeEvent as Record<string, unknown>),
      },
    });
    await Promise.resolve();
  });
}

function button(view: View, label: string) {
  const found = [...view.host.querySelectorAll("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label ||
      candidate.textContent?.includes(label),
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

function keyEvent(key: string, options: Record<string, boolean> = {}) {
  const event = new Event("keydown", {
    bubbles: true,
    cancelable: true,
  }) as KeyboardEvent;
  Object.assign(event, { key, code: key, ...options });
  return event;
}

async function pressKey(
  view: View,
  key: string,
  options: Record<string, boolean> = {},
) {
  await act(async () => {
    view.window.dispatchEvent(keyEvent(key, options));
    await Promise.resolve();
  });
}

async function wheel(
  view: View,
  options: Record<string, number | boolean> = {},
) {
  await act(async () => {
    const event = new Event("wheel", { bubbles: true, cancelable: true });
    Object.assign(event, {
      clientX: 100,
      clientY: 100,
      deltaX: 3,
      deltaY: 8,
      ...options,
    });
    view.svg.dispatchEvent(event);
    await Promise.resolve();
  });
}

const richDocument = JSON.stringify({
  version: 1,
  width: 1600,
  height: 1000,
  seq: 6,
  elements: [
    {
      id: "e1",
      type: "rect",
      x: 80,
      y: 80,
      w: 160,
      h: 100,
      ink: "blue",
      fill: true,
      label: "Box",
    },
    {
      id: "e2",
      type: "ellipse",
      x: 320,
      y: 80,
      w: 160,
      h: 100,
      ink: "green",
      fill: true,
      label: "Oval",
    },
    {
      id: "e3",
      type: "text",
      x: 80,
      y: 320,
      text: "Note",
      size: 30,
      ink: "red",
    },
    {
      id: "e4",
      type: "arrow",
      points: [
        [240, 130],
        [320, 130],
      ],
      ink: "yellow",
      label: "Flow",
    },
    {
      id: "e5",
      type: "line",
      points: [
        [80, 480],
        [220, 480],
      ],
      ink: "pink",
      label: "Line",
    },
    {
      id: "e6",
      type: "pen",
      points: [
        [320, 440],
        [350, 470],
        [390, 450],
      ],
      ink: "blue",
      label: "Stroke",
    },
  ],
});

describe("SketchView", () => {
  it("renders every element and drives controls, object navigation, and keyboard commands", async () => {
    const view = await renderSketch({ text: richDocument });
    expect(view.host.textContent).toContain("Box");
    expect(view.host.textContent).toContain("Oval");
    expect(view.host.textContent).toContain("Stroke");
    expect(view.host.querySelectorAll(".sk-el")).toHaveLength(6);

    for (const label of [
      "Select",
      "Pen",
      "Box",
      "Ellipse",
      "Arrow",
      "Note",
      "Eraser",
    ]) {
      await invoke(button(view, label));
      await invoke(button(view, label), "onDoubleClick");
    }
    await invoke(button(view, "Select"));

    let currentInk = "blue";
    for (const ink of ["pink", "yellow", "green", "blue", "red"]) {
      await invoke(button(view, `Colour: ${currentInk}`));
      const swatch = view.host.querySelector(`[aria-label='${ink} ink']`);
      if (!swatch) throw new Error(`swatch not found: ${ink}`);
      await invoke(swatch);
      currentInk = ink;
    }
    await invoke(button(view, `Colour: ${currentInk}`));
    await invoke(button(view, "Fill shapes with a wash"));
    await invoke(button(view, "Snap to shapes and the grid"));

    const chips = [...view.host.querySelectorAll("[role='option']")];
    await invoke(chips[0]);
    await invoke(chips[1], "onClick", { shiftKey: true });
    await invoke(chips[2], "onClick", { shiftKey: true });
    for (const action of [
      "Left",
      "Centre",
      "Right",
      "Top",
      "Middle",
      "Bottom",
      "Across",
      "Down",
    ]) {
      await invoke(button(view, "Arrange"));
      await invoke(button(view, action));
    }
    for (const action of [
      "Bring to front",
      "Bring forward",
      "Send backward",
      "Send to back",
      "Duplicate",
      "Lock in place",
    ]) {
      await invoke(button(view, "Arrange"));
      await invoke(button(view, action));
    }

    await invoke(button(view, "Undo drawing change"));
    await invoke(button(view, "Redo drawing change"));
    for (const action of [
      "Zoom in",
      "Zoom out",
      "Zoom to selection",
      "Fit the page",
    ]) {
      await invoke(button(view, "%"));
      await invoke(button(view, action));
    }
    const list = view.host.querySelector("[role='listbox']") as Element;
    await invoke(list, "onKeyDown", { key: "ArrowRight", target: chips[0] });
    await invoke(list, "onKeyDown", { key: "Home", target: chips[1] });
    await invoke(list, "onKeyDown", { key: "End", target: chips[1] });
    const objectToggle = view.host.querySelector(".sk-objects-toggle");
    if (!objectToggle) throw new Error("object toggle missing");
    await invoke(objectToggle);

    await pressKey(view, "p");
    await pressKey(view, "ArrowRight", { shiftKey: true });
    await pressKey(view, "=", { metaKey: true });
    await pressKey(view, "-", { metaKey: true });
    await pressKey(view, "0", { metaKey: true });
    await pressKey(view, "a", { metaKey: true });
    await pressKey(view, "d", { metaKey: true });
    await pressKey(view, "]", { metaKey: true });
    await pressKey(view, "[", { metaKey: true, shiftKey: true });
    await pressKey(view, "z", { metaKey: true });
    await pressKey(view, "z", { metaKey: true, shiftKey: true });
    await pressKey(view, "Delete");
    await flush();
    await view.close();
  });

  it("handles canvas drawing, editing, pan/erase, external updates, and save failure", async () => {
    vi.useFakeTimers();
    const view = await renderSketch({ text: "{" });
    expect(view.host.textContent).toContain("Expected property");
    await invoke(button(view, "Start from a shape"));
    await invoke(button(view, "Pen"));
    await invoke(view.svg, "onPointerDown", { clientX: 20, clientY: 20 });
    await invoke(view.svg, "onPointerMove", { clientX: 60, clientY: 60 });
    await invoke(view.svg, "onPointerUp", { clientX: 80, clientY: 80 });
    await invoke(button(view, "Box"));
    await invoke(view.svg, "onPointerDown", { clientX: 500, clientY: 100 });
    await invoke(view.svg, "onPointerMove", { clientX: 650, clientY: 220 });
    await invoke(view.svg, "onPointerUp", { clientX: 650, clientY: 220 });
    await invoke(button(view, "Ellipse"));
    await invoke(view.svg, "onPointerDown", { clientX: 700, clientY: 100 });
    await invoke(view.svg, "onPointerMove", { clientX: 860, clientY: 230 });
    await invoke(view.svg, "onPointerCancel", { clientX: 860, clientY: 230 });
    await invoke(button(view, "Arrow"));
    await invoke(view.svg, "onPointerDown", { clientX: 500, clientY: 140 });
    await invoke(view.svg, "onPointerMove", { clientX: 700, clientY: 140 });
    await invoke(view.svg, "onPointerUp", { clientX: 700, clientY: 140 });
    await invoke(button(view, "Note"));
    await invoke(view.svg, "onPointerDown", { clientX: 120, clientY: 700 });
    const textInput = view.host.querySelector(
      "[aria-label='Note text']",
    ) as Element;
    await invoke(textInput, "onChange", { target: { value: "hello" } });
    await invoke(textInput, "onKeyDown", { key: "Enter" });
    await invoke(button(view, "Eraser"));
    await invoke(view.svg, "onPointerDown", { clientX: 120, clientY: 120 });
    await invoke(view.svg, "onPointerMove", { clientX: 340, clientY: 120 });
    await invoke(view.svg, "onPointerUp", { clientX: 340, clientY: 120 });
    await invoke(view.svg, "onPointerDown", {
      button: 1,
      clientX: 100,
      clientY: 100,
    });
    await invoke(view.svg, "onPointerMove", { clientX: 150, clientY: 160 });
    await invoke(view.svg, "onPointerUp", { clientX: 150, clientY: 160 });

    mocks.api.saveSketch.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(view.host.textContent).toContain("Not saved");
    expect(mocks.fileUpdated).toBeTypeOf("function");
    mocks.fileUpdated?.("sketch-1");
    mocks.sketchDrawn?.({
      fileId: "sketch-1",
      doc: "not json",
      added: ["agent"],
      removed: [],
    });
    mocks.reducedMotion = true;
    mocks.sketchDrawn?.({
      fileId: "sketch-1",
      doc: richDocument,
      added: ["e1"],
      removed: [],
    });
    await flush();
    await view.close();
  });

  it("covers select, resize, marquee, staged agent reveal, and save completion paths", async () => {
    vi.useFakeTimers();
    const view = await renderSketch({ text: richDocument });
    await invoke(view.svg, "onPointerDown", { clientX: 120, clientY: 120 });
    await invoke(view.svg, "onPointerUp", { clientX: 120, clientY: 120 });
    await invoke(view.svg, "onPointerDown", { clientX: 120, clientY: 120 });
    await invoke(view.svg, "onPointerMove", { clientX: 180, clientY: 160 });
    await invoke(view.svg, "onPointerUp", { clientX: 180, clientY: 160 });
    const grip = view.host.querySelector(".sk-grip") as Element;
    const x = Number(grip.getAttribute("x"));
    const y = Number(grip.getAttribute("y"));
    await invoke(view.svg, "onPointerDown", { clientX: x + 5, clientY: y + 5 });
    await invoke(view.svg, "onPointerMove", {
      clientX: x + 25,
      clientY: y + 25,
      shiftKey: true,
    });
    await invoke(view.svg, "onPointerUp", { clientX: x + 25, clientY: y + 25 });
    await invoke(view.svg, "onPointerDown", { clientX: 1000, clientY: 700 });
    await invoke(view.svg, "onPointerMove", { clientX: 1400, clientY: 900 });
    await invoke(view.svg, "onPointerUp", {
      clientX: 1400,
      clientY: 900,
      shiftKey: true,
    });
    await pressKey(view, "Space");
    await invoke(view.svg, "onPointerDown", { clientX: 400, clientY: 400 });
    await invoke(view.svg, "onPointerMove", { clientX: 430, clientY: 430 });
    await invoke(view.svg, "onPointerUp", { clientX: 430, clientY: 430 });
    await act(async () => {
      view.window.dispatchEvent(new Event("keyup"));
      view.window.dispatchEvent(new Event("blur"));
    });

    mocks.sketchDrawn?.({
      fileId: "other",
      doc: richDocument,
      added: ["e1"],
      removed: [],
    });
    mocks.reducedMotion = false;
    mocks.sketchDrawn?.({
      fileId: "sketch-1",
      doc: richDocument,
      added: ["e1", "e2"],
      removed: [],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await invoke(button(view, "Pen"));
    await invoke(view.svg, "onPointerDown", { clientX: 20, clientY: 20 });
    mocks.sketchDrawn?.({
      fileId: "sketch-1",
      doc: richDocument,
      added: ["e3"],
      removed: [],
    });
    await invoke(view.svg, "onPointerUp", { clientX: 20, clientY: 20 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(mocks.api.saveSketch).toHaveBeenCalled();
    await view.close();
  });

  it("covers keyboard, wheel, erase, label, and fallback gesture paths", async () => {
    const view = await renderSketch({ text: richDocument });
    await invoke(view.svg, "onPointerMove", { clientX: 4, clientY: 4 });
    await wheel(view);
    await wheel(view, { ctrlKey: true, deltaY: -12 });
    await invoke(view.svg, "onPointerDown", {
      clientX: 360,
      clientY: 120,
      shiftKey: true,
    });
    await invoke(view.svg, "onPointerUp", { clientX: 360, clientY: 120 });
    await invoke(view.svg, "onPointerDown", {
      clientX: 360,
      clientY: 120,
      shiftKey: true,
    });
    await invoke(view.svg, "onPointerUp", { clientX: 360, clientY: 120 });
    await invoke(button(view, "Eraser"));
    await invoke(view.svg, "onPointerDown", { clientX: 100, clientY: 100 });
    await invoke(view.svg, "onPointerUp", { clientX: 100, clientY: 100 });
    await invoke(button(view, "Pen"));
    await invoke(view.svg, "onPointerDown", { clientX: 30, clientY: 30 });
    await invoke(view.svg, "onPointerMove", {
      clientX: 80,
      clientY: 80,
      nativeEvent: {
        getCoalescedEvents: () => [
          { clientX: 45, clientY: 45 },
          { clientX: 80, clientY: 80 },
        ],
      },
    });
    view.svg.releasePointerCapture = vi.fn(() => {
      throw new Error("released");
    });
    await invoke(view.svg, "onPointerUp", { clientX: 80, clientY: 80 });
    const chip = view.host.querySelector("[role='option']") as Element;
    await invoke(chip);
    await invoke(chip, "onClick", { shiftKey: true });
    await invoke(chip, "onClick", { shiftKey: true });
    const label = view.host.querySelector(".sk-label-edit input") as Element;
    await invoke(label, "onChange", { target: { value: "renamed" } });
    Object.defineProperty(view.document, "activeElement", {
      configurable: true,
      value: label,
    });
    await pressKey(view, "p");
    Object.defineProperty(view.document, "activeElement", {
      configurable: true,
      value: view.document.body,
    });
    await invoke(label, "onKeyDown", { key: "Enter" });
    await invoke(label, "onBlur");
    const textChip = view.host.querySelector("button[data-id='e3']") as Element;
    await invoke(textChip);
    const textLabel = view.host.querySelector(
      ".sk-label-edit input",
    ) as Element;
    await invoke(textLabel, "onChange", { target: { value: "renamed note" } });
    await invoke(textLabel, "onBlur");
    const field = view.host.querySelector(
      ".sk-label-edit input",
    ) as HTMLInputElement;
    await act(async () => {
      field.dispatchEvent(new Event("focusin", { bubbles: true }));
      field.dispatchEvent(new Event("focusout", { bubbles: true }));
      await Promise.resolve();
    });
    await invoke(button(view, "Colour: blue"));
    const swatch = view.host.querySelector("[aria-label='red ink']") as Element;
    await invoke(swatch);
    await invoke(button(view, "Arrange"));
    await pressKey(view, "Escape");
    await pressKey(view, "Escape");
    await invoke(chip);
    await pressKey(view, "Delete");
    await invoke(button(view, "Note"));
    await invoke(view.svg, "onPointerDown", { clientX: 400, clientY: 600 });
    const note = view.host.querySelector("[aria-label='Note text']") as Element;
    await invoke(note, "onKeyDown", { key: "Escape" });
    (view.svg as unknown as { getScreenCTM: () => null }).getScreenCTM = () =>
      null;
    await wheel(view, { ctrlKey: true });
    const empty = await renderSketch();
    await invoke(button(empty, "Draw freely"));
    await empty.close();
    await view.close();
    const single = await renderSketch({
      text: JSON.stringify({
        version: 1,
        width: 1600,
        height: 1000,
        seq: 1,
        elements: [
          { id: "e1", type: "rect", x: 88, y: 88, w: 80, h: 80, ink: "blue" },
        ],
      }),
    });
    await invoke(single.svg, "onPointerDown", { clientX: 100, clientY: 100 });
    await invoke(single.svg, "onPointerMove", { clientX: 104, clientY: 100 });
    await invoke(single.svg, "onPointerUp", { clientX: 104, clientY: 100 });
    await invoke(
      single.host.querySelector("[role='listbox']") as Element,
      "onKeyDown",
      {
        key: "PageDown",
        target: single.host.querySelector("[role='option']") as Element,
      },
    );
    const capture = vi.fn();
    Object.defineProperty(single.svg, "setPointerCapture", {
      configurable: true,
      value: capture,
    });
    const release = vi.fn(() => {
      throw new Error("released");
    });
    Object.defineProperty(single.svg, "releasePointerCapture", {
      configurable: true,
      value: release,
    });
    await invoke(single.svg, "onPointerDown", {
      button: 1,
      clientX: 300,
      clientY: 300,
    });
    expect(capture).toHaveBeenCalled();
    await invoke(single.svg, "onPointerUp", { clientX: 360, clientY: 360 });
    expect(release).toHaveBeenCalled();
    await single.close();
  });
});
