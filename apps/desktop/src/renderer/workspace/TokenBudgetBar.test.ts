import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskTokenUsage, Message } from "../apiTypes";
import type { WSActions } from "./actions";
import type { WSState } from "./state";

const mocks = vi.hoisted(() => ({ markdown: vi.fn() }));

vi.mock("../icons", () => ({
  RefreshIcon: () => null,
  SparklesIcon: () => null,
}));
vi.mock("../viewers/MarkdownView", () => ({
  default: ({ text }: { text: string }) => {
    mocks.markdown(text);
    return null;
  },
}));

import TokenBudgetBar, { HandoffMarker } from "./TokenBudgetBar";

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

function usage(
  totalTokens: number,
  maxContext = 1000,
  estimated = false,
  breakdown: Partial<AskTokenUsage["breakdown"]> = {},
): AskTokenUsage {
  return {
    total_tokens: totalTokens,
    max_context: maxContext,
    estimated,
    breakdown: {
      system: { tokens: 100, estimated: false },
      history: { tokens: 200, estimated: false },
      tools: { tokens: 300, estimated: false },
      skills: { tokens: 100, estimated: false },
      files: { tokens: 100, estimated: false },
      ...breakdown,
    },
  };
}

function message(snapshot: AskTokenUsage): Message {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "Persisted answer",
    sources: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    effects: { usage: snapshot },
  };
}

function state(overrides: Record<string, unknown> = {}): WSState {
  return {
    tokenUsage: null,
    messages: [],
    handoffStarting: false,
    asking: false,
    ...overrides,
  } as unknown as WSState;
}

function actions() {
  return {
    handoffContext: vi.fn().mockResolvedValue(undefined),
  } as unknown as WSActions;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(node: React.ReactElement) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  return { host, root, window };
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim().includes(label),
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () => {
    node.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
  await flush();
}

async function mouseDown(node: Element, window: Window & typeof globalThis) {
  await act(async () => {
    node.dispatchEvent(new window.Event("mousedown", { bubbles: true }));
  });
  await flush();
}

async function keyDown(window: Window & typeof globalThis, key: string) {
  const event = new window.Event("keydown", { bubbles: true });
  Object.defineProperty(event, "key", { value: key });
  await act(async () => window.dispatchEvent(event));
  await flush();
}

afterEach(() => {
  mocks.markdown.mockReset();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("TokenBudgetBar", () => {
  it("renders nothing for an empty conversation, but still offers handoff for unknown usage", async () => {
    const empty = await render(
      createElement(TokenBudgetBar, { s: state(), a: actions() }),
    );
    expect(empty.host.textContent).toBe("");
    await act(async () => empty.root.unmount());

    const lowUsage = await render(
      createElement(TokenBudgetBar, {
        s: state({ messages: [message(usage(20))] }),
        a: actions(),
      }),
    );
    expect(lowUsage.host.querySelector(".token-bar")).toBeNull();
    await act(async () => lowUsage.root.unmount());

    const unknownMessage = message(usage(20));
    unknownMessage.effects = null;
    const handoff = actions();
    const unknown = await render(
      createElement(TokenBudgetBar, {
        s: state({ messages: [unknownMessage] }),
        a: handoff,
      }),
    );
    expect(unknown.host.querySelector(".token-bar")).toBeNull();
    await click(button(unknown.host, "Hand off"), unknown.window);
    expect(handoff.handoffContext).toHaveBeenCalledOnce();
    await act(async () => unknown.root.unmount());
  });

  it("uses the persisted reading for an estimated warning meter and closes its breakdown", async () => {
    const persisted = usage(800, 1000, true, {
      system: { tokens: 400, estimated: true },
      history: { tokens: 200, estimated: true },
      tools: { tokens: 100, estimated: true },
      skills: { tokens: 50, estimated: true },
      files: { tokens: 50, estimated: true },
    });
    Reflect.deleteProperty(persisted.breakdown, "files");
    const view = await render(
      createElement(TokenBudgetBar, {
        s: state({ messages: [message(persisted)] }),
        a: actions(),
      }),
    );
    const meter = view.host.querySelector<HTMLButtonElement>(".token-bar");
    if (!meter) throw new Error("budget meter missing");
    expect(meter.className).toContain("warn");
    expect(meter.getAttribute("aria-expanded")).toBe("false");
    expect(meter.title).toContain("800 / 1,000 tokens");
    expect(view.host.textContent).toContain("Near limit");
    expect(view.host.textContent).toContain("~");
    expect(
      view.host.querySelector(".token-bar-fill")?.getAttribute("style"),
    ).toContain("80%");
    expect(view.host.querySelectorAll(".token-bar-seg")).toHaveLength(4);
    await click(meter, view.window);
    expect(meter.getAttribute("aria-expanded")).toBe("true");
    expect(view.host.querySelectorAll(".token-breakdown-row")).toHaveLength(5);
    expect(view.host.textContent).toContain("800 / 1,000 (80%)");
    expect(view.host.textContent).toContain("also estimated");
    await keyDown(view.window, "Enter");
    expect(view.host.querySelector(".token-breakdown-pop")).not.toBeNull();
    await mouseDown(view.host.querySelector(".menu-backdrop")!, view.window);
    expect(view.host.querySelector(".token-breakdown-pop")).toBeNull();
    await click(meter, view.window);
    await keyDown(view.window, "Escape");
    expect(view.host.querySelector(".token-breakdown-pop")).toBeNull();
    await act(async () => view.root.unmount());
  });

  it("uses live usage for danger overage and keeps handoff disabled while it starts or asks", async () => {
    const live = usage(1200, 1000, false, {
      system: { tokens: 1200, estimated: false },
      history: { tokens: 0, estimated: false },
      tools: { tokens: 0, estimated: false },
      skills: { tokens: 0, estimated: false },
      files: { tokens: 0, estimated: false },
    });
    const starting = await render(
      createElement(TokenBudgetBar, {
        s: state({
          tokenUsage: live,
          messages: [message(usage(800))],
          handoffStarting: true,
        }),
        a: actions(),
      }),
    );
    const meter = starting.host.querySelector<HTMLButtonElement>(".token-bar");
    if (!meter) throw new Error("live budget meter missing");
    expect(meter.className).toContain("danger");
    expect(starting.host.textContent).toContain("At limit");
    expect(
      starting.host.querySelector(".token-bar-fill")?.getAttribute("style"),
    ).toContain("100%");
    expect(starting.host.querySelectorAll(".token-bar-seg")).toHaveLength(1);
    expect(button(starting.host, "Summarizing").disabled).toBe(true);
    await click(meter, starting.window);
    expect(starting.host.textContent).not.toContain("also estimated");
    await mouseDown(
      starting.host.querySelector(".menu-backdrop")!,
      starting.window,
    );
    await act(async () => starting.root.unmount());

    const asking = await render(
      createElement(TokenBudgetBar, {
        s: state({
          tokenUsage: usage(700),
          messages: [message(usage(700))],
          asking: true,
        }),
        a: actions(),
      }),
    );
    expect(asking.host.querySelector(".token-bar")?.className).toContain("ok");
    expect(button(asking.host, "Hand off").disabled).toBe(true);
    await act(async () => asking.root.unmount());
  });

  it("renders a handoff marker through the shared markdown path", async () => {
    const handoff = message(usage(1));
    handoff.content = "## Short recap";
    const view = await render(
      createElement(HandoffMarker, { message: handoff }),
    );
    expect(view.host.textContent).toContain("Context summarized, continuing");
    expect(view.host.textContent).toContain("View summary");
    expect(mocks.markdown).toHaveBeenCalledWith("## Short recap");
    await act(async () => view.root.unmount());
  });
});
