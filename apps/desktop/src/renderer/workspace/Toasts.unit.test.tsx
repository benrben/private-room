import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../icons", () => ({ CloseIcon: () => null }));

import Toasts from "./Toasts";
import type { Toast } from "./types";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function installDom() {
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
  return { document, window };
}

async function renderToasts(toasts: Toast[], dismissToast = vi.fn()) {
  const { document, window } = installDom();
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("Test root missing.");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Toasts, { toasts, dismissToast }));
  });
  return { dismissToast, host, root, window };
}

async function click(window: Window & typeof globalThis, element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("Toasts with an in-memory DOM", () => {
  it("renders nothing when there are no fabricated toasts", async () => {
    const view = await renderToasts([]);

    expect(view.host.innerHTML).toBe("");
    await act(async () => view.root.unmount());
  });

  it("announces each kind and runs an action before dismissing its toast", async () => {
    const run = vi.fn();
    const view = await renderToasts([
      { id: 1, kind: "success", text: "Saved", action: { label: "Open saved file", run } },
      { id: 2, kind: "error", text: "Save failed" },
      { id: 3, kind: "info", text: "Queued" },
    ]);

    expect(Array.from(view.host.querySelectorAll("[role]"), (element) => element.getAttribute("role"))).toEqual([
      "status", "alert", "status",
    ]);
    expect(Array.from(view.host.querySelectorAll(".toast-mark"), (element) => element.textContent)).toEqual([
      "Done", "Failed", "Note",
    ]);
    expect(view.host.querySelector(".toast.success .toast-mark")?.className).toContain("nb-sem-done");
    expect(view.host.querySelector(".toast.error .toast-mark")?.className).toContain("nb-sem-urgent");
    expect(view.host.querySelector(".toast.info .toast-mark")?.className).toContain("nb-sem-linked");

    const action = view.host.querySelector(".toast-action");
    const closeError = view.host.querySelectorAll<HTMLButtonElement>(".toast-close")[1];
    if (!action || !closeError) throw new Error("Toast buttons were not rendered.");
    await click(view.window, action);
    await click(view.window, closeError);

    expect(run).toHaveBeenCalledTimes(1);
    expect(view.dismissToast).toHaveBeenNthCalledWith(1, 1);
    expect(view.dismissToast).toHaveBeenNthCalledWith(2, 2);
    await act(async () => view.root.unmount());
  });
});
