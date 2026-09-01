import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";

const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

type View = Awaited<ReturnType<typeof renderLog>>;

async function renderLog(text: string) {
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

  const [{ createRoot }, { default: LogView }] = await Promise.all([
    import("react-dom/client"),
    import("./LogView"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(LogView, { text }));
    await Promise.resolve();
  });
  return { host, close: async () => act(async () => root.unmount()) };
}

function reactProp(element: Element, name: string): (event: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error(`React prop ${name} was not attached`);
  return (element as unknown as Record<string, Record<string, (event: Record<string, unknown>) => void>>)[key][name];
}

async function invoke(element: Element, name = "onClick", event: Record<string, unknown> = {}) {
  await act(async () => {
    reactProp(element, name)({ currentTarget: element, target: element, ...event });
    await Promise.resolve();
  });
}

function button(view: View, label: string): HTMLButtonElement {
  const result = [...view.host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
  if (!result) throw new Error(`button not found: ${label}`);
  return result as HTMLButtonElement;
}

function shownText(view: View): string[] {
  return [...view.host.querySelectorAll(".log-text")].map((element) => element.textContent ?? "");
}

describe("LogView", () => {
  it("classifies severities, filters a selected level, and shows the empty search state", async () => {
    const view = await renderLog("INFO started\nWARN nearly full\nERROR failed\nplain line\n");
    try {
      expect(view.host.textContent).toContain("All 4");
      expect(view.host.textContent).toContain("warn 1");
      expect(view.host.textContent).toContain("error 1");

      await invoke(button(view, "warn"));
      expect(shownText(view)).toEqual(["WARN nearly full"]);
      await invoke(button(view, "warn"));
      expect(shownText(view)).toHaveLength(4);

      const search = view.host.querySelector("input");
      if (!search) throw new Error("search input missing");
      await invoke(search, "onChange", { target: { value: "missing" } });
      await act(async () => { await Promise.resolve(); });
      expect(view.host.textContent).toContain("No lines match this filter.");
    } finally {
      await view.close();
    }
  });

  it("renders the tail first and reveals earlier lines when requested", async () => {
    const text = Array.from({ length: 2_002 }, (_, index) => `row-${index + 1}`).join("\n");
    const view = await renderLog(text);
    try {
      expect(shownText(view)).toHaveLength(2_000);
      expect(shownText(view).at(0)).toBe("row-3");
      expect(shownText(view).at(-1)).toBe("row-2002");

      await invoke(button(view, "Show earlier lines"));
      expect(shownText(view)).toHaveLength(2_002);
      expect(shownText(view).at(0)).toBe("row-1");
    } finally {
      await view.close();
    }
  });
});
