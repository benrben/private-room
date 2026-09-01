import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WSActions } from "./actions";
import type { WSState } from "./state";

const mocks = vi.hoisted(() => ({
  formatWhen: vi.fn((when: string) => `when ${when}`),
  isRtlDominant: vi.fn(() => false),
  onModalKeyDown: vi.fn(),
}));

vi.mock("./composer", () => ({ formatWhen: mocks.formatWhen }));
vi.mock("../viewers/DiffView", () => ({
  default: ({ original, modified, fileName }: { original: string; modified: string; fileName: string }) => (
    <div data-original={original} data-modified={modified} data-testid="diff-view">
      Diff for {fileName}
    </div>
  ),
  isRtlDominant: mocks.isRtlDominant,
}));
vi.mock("../settings/useFocusTrap", () => ({
  useFocusTrap: () => ({ modalRef: { current: null }, onModalKeyDown: mocks.onModalKeyDown }),
}));

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

type Compare = {
  versionId: string;
  cause: string;
  savedAt: string;
  versionText: string | null;
  currentText: string | null;
  fileName: string;
};

function compare(overrides: Partial<Compare> = {}): Compare {
  return {
    versionId: "version-1",
    cause: "Saved version",
    savedAt: "2026-08-31T12:00:00Z",
    versionText: "before",
    currentText: "after",
    fileName: "notes.md",
    ...overrides,
  };
}

function state(value: Compare | null, events: string[] = []): WSState {
  return {
    compare: value,
    setCompare: vi.fn((next) => events.push(next === null ? "close" : "open")),
  } as unknown as WSState;
}

function actions(events: string[] = []): WSActions {
  return {
    restoreVersion: vi.fn((versionId: string) => events.push(`restore:${versionId}`)),
  } as unknown as WSActions;
}

type View = Awaited<ReturnType<typeof renderModal>>;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderModal({
  a = actions(),
  s = state(compare()),
}: {
  a?: WSActions;
  s?: WSState;
} = {}) {
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
  const [{ createRoot }, { default: CompareModal }] = await Promise.all([
    import("react-dom/client"),
    import("./CompareModal"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const update = async () => {
    await act(async () => {
      root.render(createElement(CompareModal, { s, a }));
      await Promise.resolve();
    });
    await flush();
  };
  await update();
  return {
    a,
    close: async () => act(async () => root.unmount()),
    host,
    root,
    s,
    update,
  };
}

function reactProp(
  element: Element,
  name: string,
): (event: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error(`React props missing for ${name}`);
  return (
    element as unknown as Record<string, Record<string, (event: Record<string, unknown>) => void>>
  )[key][name];
}

async function invoke(
  element: Element,
  name = "onClick",
  event: Record<string, unknown> = {},
) {
  await act(async () => {
    reactProp(element, name)({
      currentTarget: element,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      target: element,
      ...event,
    });
    await Promise.resolve();
  });
  await flush();
}

function button(view: View, text: string) {
  const element = [...view.host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim() === text,
  );
  if (!element) throw new Error(`button not found: ${text}`);
  return element;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.formatWhen.mockImplementation((when) => `when ${when}`);
  mocks.isRtlDominant.mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("CompareModal", () => {
  it("renders nothing while comparison data is closed", async () => {
    const view = await renderModal({ s: state(null) });
    expect(view.host.textContent).toBe("");
    await view.close();
  });

  it("shows the unavailable-text explanation without diff controls", async () => {
    const view = await renderModal({
      s: state(compare({ currentText: null, fileName: "report.pdf", versionText: null })),
    });
    expect(view.host.querySelector("[role=dialog]")?.getAttribute("aria-label")).toBe("Compare — report.pdf");
    expect(view.host.textContent).toContain("Saved version · when 2026-08-31T12:00:00Z vs. now");
    expect(view.host.textContent).toContain("This version has no text to compare.");
    expect(view.host.textContent).not.toContain("Plain view");
    expect(view.host.querySelector("[data-testid=diff-view]")).toBeNull();
    await view.close();
  });

  it("toggles between the diff and plain RTL-friendly panes", async () => {
    mocks.isRtlDominant.mockReturnValue(true);
    const view = await renderModal();
    const diff = view.host.querySelector("[data-testid=diff-view]");
    expect(diff?.getAttribute("data-original")).toBe("before");
    expect(diff?.getAttribute("data-modified")).toBe("after");
    expect(view.host.querySelector(".compare-rtl-hint")).not.toBeNull();
    await invoke(button(view, "Plain view"));
    expect(view.host.querySelector("[data-testid=diff-view]")).toBeNull();
    expect(view.host.querySelectorAll(".compare-pane")).toHaveLength(2);
    expect(view.host.textContent).toContain("This versionbeforeNowafter");
    expect(view.host.querySelector(".compare-rtl-hint")).toBeNull();
    await invoke(button(view, "Diff view"));
    expect(view.host.querySelector("[data-testid=diff-view]")).not.toBeNull();
    expect(view.host.querySelector(".compare-rtl-hint")).not.toBeNull();
    await view.close();
  });

  it("arms restore, permits cancellation, resets for a new version, and restores before closing", async () => {
    const events: string[] = [];
    const s = state(compare(), events);
    const a = actions(events);
    const view = await renderModal({ a, s });
    await invoke(button(view, "Restore this version"));
    expect(view.host.textContent).toContain("Cancel");
    await invoke(button(view, "Cancel"));
    expect(view.host.textContent).toContain("Restore this version");
    await invoke(button(view, "Plain view"));
    await invoke(button(view, "Restore this version"));
    (s as unknown as { compare: Compare }).compare = compare({ versionId: "version-2" });
    await view.update();
    expect(view.host.querySelector("[data-testid=diff-view]")).not.toBeNull();
    expect(view.host.textContent).toContain("Restore this version");
    await invoke(button(view, "Restore this version"));
    await invoke(button(view, "Restore"));
    expect(a.restoreVersion).toHaveBeenCalledWith("version-2");
    expect(events).toEqual(["restore:version-2", "close"]);
    await view.close();
  });

  it("keeps panel clicks inside, while backdrop, close, and captured Escape close it", async () => {
    const events: string[] = [];
    const view = await renderModal({ s: state(compare(), events) });
    const panel = view.host.querySelector(".compare-modal");
    const backdrop = view.host.querySelector(".compare-backdrop");
    if (!panel || !backdrop) throw new Error("modal structure missing");
    const stopPropagation = vi.fn();
    await invoke(panel, "onClick", { stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
    await invoke(button(view, "Close"));
    await invoke(backdrop);
    const preventDefault = vi.fn();
    const escapeStop = vi.fn();
    await invoke(panel, "onKeyDownCapture", {
      key: "Escape",
      preventDefault,
      stopPropagation: escapeStop,
    });
    await invoke(panel, "onKeyDownCapture", { key: "Enter" });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(escapeStop).toHaveBeenCalledOnce();
    expect(events).toEqual(["close", "close", "close"]);
    await view.close();
  });
});
