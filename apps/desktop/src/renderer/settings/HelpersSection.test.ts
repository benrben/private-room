import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import HelpersSection from "./HelpersSection";

vi.mock("../icons", () => ({ CircleCheckIcon: () => null }));

const { act, createElement } = React;
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

type Props = React.ComponentProps<typeof HelpersSection>;
type View = Awaited<ReturnType<typeof renderSection>>;

function props(overrides: Partial<Props> = {}): Props {
  return {
    ai: {
      running: true,
      installed: true,
      models: [],
      defaultModel: "",
      external: [],
      remoteRelay: false,
    },
    visionInstalled: false,
    groundingModel: null,
    visionBlock: null,
    recommended: { vision: "vision-local", embed: "embed-local" },
    pullSpecial: vi.fn(),
    pullingSpecial: null,
    pulling: false,
    stopPull: vi.fn(),
    stoppingPull: false,
    embedInstalled: false,
    pullPercent: null,
    pullStatus: "",
    DownloadIcon: () => createElement("span", { "data-icon": "download" }),
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderSection(overrides: Partial<Props> = {}) {
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
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  let current = props(overrides);
  const update = async (next: Partial<Props>) => {
    current = { ...current, ...next };
    await act(async () => {
      root.render(createElement(HelpersSection, current));
      await Promise.resolve();
    });
    await flush();
  };
  await update({});
  return {
    close: async () => act(async () => root.unmount()),
    host,
    props: () => current,
    update,
    window,
  };
}

async function click(view: View, element: Element) {
  await act(async () => {
    element.dispatchEvent(new view.window.Event("click", { bubbles: true }));
    await Promise.resolve();
  });
  await flush();
}

function button(view: View, text: string): HTMLButtonElement {
  const found = [...view.host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("HelpersSection", () => {
  it("shows installed helpers and names the model currently marking images", async () => {
    const view = await renderSection({
      visionInstalled: true,
      groundingModel: "room-vision",
      embedInstalled: true,
    });

    expect(view.host.textContent).toContain("Ready — the AI can see and mark images (room-vision).");
    expect(view.host.textContent).toContain("On — search understands meaning, not just words.");
    expect(view.host.querySelectorAll(".model-row.active.is-ok")).toHaveLength(2);
    expect(view.host.querySelectorAll("button")).toHaveLength(0);
    await view.update({ groundingModel: null });
    expect(view.host.textContent).toContain("Ready — the AI can see and mark images.");
    expect(view.host.textContent).not.toContain("room-vision");
    await view.close();
  });

  it("shows a vision preflight block instead of an unnecessary download", async () => {
    const view = await renderSection({
      visionBlock: "Cloud privacy must be disabled before this model can inspect images.",
      embedInstalled: true,
    });

    expect(view.host.querySelector(".set-note--flag")?.textContent).toBe(
      "Cloud privacy must be disabled before this model can inspect images.",
    );
    expect(view.host.textContent).not.toContain("Nothing can read or mark images");
    expect(view.host.querySelectorAll("button")).toHaveLength(0);
    await view.close();
  });

  it("gates uninstalled helpers while Ollama is stopped", async () => {
    const view = await renderSection({
      ai: { running: false, installed: true, models: [], defaultModel: "", external: [], remoteRelay: false },
    });

    expect(view.host.textContent).toContain("(vision-local)");
    expect(view.host.textContent).toContain("(embed-local)");
    expect(view.host.textContent).toContain("Ollama is not running — start it to download a local helper.");
    expect(view.host.textContent).toContain("Ollama is not running — start it to turn this on.");
    expect(view.host.querySelectorAll("button")).toHaveLength(0);
    await view.close();
  });

  it("starts the respective helper pull and keeps disabled action states", async () => {
    const pullSpecial = vi.fn();
    const view = await renderSection({ pullSpecial });
    await click(view, button(view, "Download a local vision helper"));
    await click(view, button(view, "Turn on semantic search"));
    expect(pullSpecial).toHaveBeenNthCalledWith(1, "vision-local");
    expect(pullSpecial).toHaveBeenNthCalledWith(2, "embed-local", true);

    await view.update({ pullingSpecial: "vision-local" });
    expect(button(view, "Download a local vision helper").disabled).toBe(true);
    expect(button(view, "Turn on semantic search").disabled).toBe(true);
    await view.update({ pullingSpecial: null, pulling: true });
    expect(button(view, "Download a local vision helper").disabled).toBe(true);
    expect(button(view, "Turn on semantic search").disabled).toBe(true);
    await view.close();
  });

  it("retains no-catalog pull semantics for vision and semantic search", async () => {
    const pullSpecial = vi.fn();
    const view = await renderSection({ recommended: null, pullSpecial });
    await click(view, button(view, "Download a local vision helper"));
    await click(view, button(view, "Turn on semantic search"));

    expect(pullSpecial).toHaveBeenCalledTimes(1);
    expect(pullSpecial).toHaveBeenCalledWith("", true);
    await view.close();
  });

  it("renders pull progress with stop ordering, then its stopping state without a percent bar", async () => {
    const stopPull = vi.fn();
    const view = await renderSection({
      pullingSpecial: "vision-local",
      pullPercent: 42.6,
      pullStatus: "Downloading layers",
      stopPull,
    });

    expect(view.host.querySelector(".pull-bar-fill")?.getAttribute("style")).toContain("42.6%");
    expect(view.host.querySelector(".pull-progress")?.textContent).toContain("Downloading layers — 43%");
    await click(view, button(view, "Stop"));
    expect(stopPull).toHaveBeenCalledTimes(1);

    await view.update({ pullPercent: null, pullStatus: "Cancelling", stoppingPull: true });
    expect(view.host.querySelector(".pull-bar")).toBeNull();
    expect(view.host.querySelector(".pull-progress")?.textContent).toContain("Cancelling");
    expect(button(view, "Stopping…").disabled).toBe(true);
    await view.close();
  });
});
