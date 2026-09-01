import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

import ErrorBoundary from "./ErrorBoundary";

const { act, createElement } = React;
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

async function render(element: React.ReactElement) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  const reload = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { reload },
  });
  for (const [key, value] of Object.entries({
    window, document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    Event: window.Event, React, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Reflect.set(globalThis, key, value);
  }
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(element));
  return { host, root, reload };
}

function reactClick(element: Element): () => unknown {
  const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React click handler missing");
  return (element as unknown as Record<string, Record<string, () => unknown>>)[key]!.onClick!;
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("ErrorBoundary with an in-memory React DOM", () => {
  it("passes healthy content through untouched", async () => {
    const view = await render(
      createElement(ErrorBoundary, {
        scope: "Preview",
        children: createElement("span", null, "healthy fake content"),
      }),
    );
    expect(view.host.textContent).toBe("healthy fake content");
    expect(view.host.querySelector("[role='alert']")).toBeNull();
    await act(async () => view.root.unmount());
  });

  it("keeps a pane failure local and retries it once the fabricated child recovers", async () => {
    let recovered = false;
    function FailsOnce(): React.ReactElement {
      if (!recovered) throw new Error("fake pane failure");
      return createElement("span", null, "recovered content");
    }
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = await render(
      createElement(ErrorBoundary, { scope: "Preview", children: createElement(FailsOnce) }),
    );
    expect(view.host.querySelector(".crash-pane")?.textContent).toContain("Preview couldn't be drawn.");
    expect(view.host.querySelector(".crash-detail")?.textContent).toBe("fake pane failure");
    expect(consoleError).toHaveBeenCalledWith("[Preview] render failed:", expect.any(Error), expect.any(String));

    recovered = true;
    await act(async () => reactClick(button(view.host, "Try again"))());
    expect(view.host.textContent).toBe("recovered content");
    await act(async () => view.root.unmount());
  });

  it("uses the root recovery card and reloads through the fabricated window", async () => {
    function EmptyMessageFailure(): React.ReactElement {
      throw new Error("");
    }
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = await render(
      createElement(ErrorBoundary, {
        scope: "Arcelle",
        root: true,
        children: createElement(EmptyMessageFailure),
      }),
    );
    expect(view.host.querySelector(".crash-screen")?.getAttribute("role")).toBe("alert");
    expect(view.host.textContent).toContain("Something went wrong");
    expect(view.host.querySelector(".crash-detail")?.textContent).toBe("Error");
    await act(async () => reactClick(button(view.host, "Reload Arcelle"))());
    expect(view.reload).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });
});
