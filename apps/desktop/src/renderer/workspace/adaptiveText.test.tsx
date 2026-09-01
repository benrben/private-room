import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  generateUiText: vi.fn(),
  getSetting: vi.fn(),
}));

vi.mock("../api", () => ({
  api: { getSetting: fakes.getSetting },
  generateUiText: fakes.generateUiText,
}));

import {
  adaptiveTextCacheKey,
  type AdaptiveText,
  type UseAdaptiveTextOptions,
  useAdaptiveText,
} from "./adaptiveText";

const { act, createElement } = React;
const globalKeys = ["document", "window", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

let value: AdaptiveText = undefined;

function options(overrides: Partial<UseAdaptiveTextOptions> = {}): UseAdaptiveTextOptions {
  return {
    roomId: "room-1",
    kind: "dek",
    prompt: "Write a dek",
    facts: { count: 2, labels: ["a", { z: 1, a: 2 }] },
    maxWords: 8,
    enabled: true,
    ...overrides,
  };
}

function Probe({ opts }: { opts: UseAdaptiveTextOptions }) {
  value = useAdaptiveText(opts);
  return null;
}

async function flush(rounds = 6) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function renderHook(initial: UseAdaptiveTextOptions) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const update = async (next: UseAdaptiveTextOptions) => {
    await act(async () => {
      root.render(createElement(Probe, { opts: next }));
      await Promise.resolve();
    });
  };
  await update(initial);
  return { close: async () => act(async () => root.unmount()), update };
}

beforeEach(() => {
  fakes.generateUiText.mockReset();
  fakes.getSetting.mockReset().mockResolvedValue("1");
});

afterEach(() => {
  vi.useRealTimers();
  value = undefined;
  for (const [key, original] of Object.entries(originalGlobals)) {
    if (original === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, original);
  }
});

describe("adaptive text cache and hook", () => {
  it("canonicalizes nested fact objects without changing array order", () => {
    const first = adaptiveTextCacheKey("room", "dek", "Prompt", {
      z: { b: 2, a: 1 },
      a: ["first", { y: 2, x: 1 }],
    });
    const same = adaptiveTextCacheKey("room", "dek", "Prompt", {
      a: ["first", { x: 1, y: 2 }],
      z: { a: 1, b: 2 },
    });
    const reorderedArray = adaptiveTextCacheKey("room", "dek", "Prompt", {
      a: [{ x: 1, y: 2 }, "first"],
      z: { a: 1, b: 2 },
    });

    expect(first).toBe(same);
    expect(reorderedArray).not.toBe(first);
  });

  it("returns fallback first, swaps only a timely result, and serves cache hits synchronously", async () => {
    let resolveFresh: ((text: string) => void) | undefined;
    fakes.generateUiText.mockReturnValueOnce(new Promise<string>((resolve) => {
      resolveFresh = resolve;
    }));
    const initial = options();
    const first = await renderHook(initial);
    expect(value).toBeUndefined();
    resolveFresh?.("Fresh adaptive text");
    await flush();
    expect(value).toBe("Fresh adaptive text");
    expect(fakes.generateUiText).toHaveBeenCalledWith("dek", "Write a dek", initial.facts, 8);
    await first.close();

    const cached = await renderHook(initial);
    expect(value).toBe("Fresh adaptive text");
    expect(fakes.generateUiText).toHaveBeenCalledOnce();
    let resolveChanged: ((text: string) => void) | undefined;
    fakes.generateUiText.mockReturnValueOnce(new Promise<string>((resolve) => {
      resolveChanged = resolve;
    }));
    await cached.update(options({ prompt: "Changed" }));
    expect(value).toBeUndefined();
    resolveChanged?.("Changed adaptive text");
    await flush();
    expect(value).toBe("Changed adaptive text");
    await cached.update(options({ enabled: false }));
    expect(value).toBeNull();
    await cached.close();

    const disabled = await renderHook(options({ prompt: "Disabled", enabled: false }));
    expect(value).toBeNull();
    await flush();
    expect(fakes.generateUiText).toHaveBeenCalledTimes(2);
    await disabled.close();
  });

  it("keeps late results for the next view and degrades rejected generation to cached null", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
    let resolveLate: ((text: string) => void) | undefined;
    fakes.generateUiText.mockReturnValueOnce(new Promise<string>((resolve) => {
      resolveLate = resolve;
    }));
    const lateOptions = options({ prompt: "Late" });
    const late = await renderHook(lateOptions);
    await flush();
    await act(async () => vi.advanceTimersByTime(401));
    resolveLate?.("Cached late text");
    await flush();
    expect(value).toBeUndefined();
    await late.close();

    const nextView = await renderHook(lateOptions);
    expect(value).toBe("Cached late text");
    await nextView.close();

    let reject: ((error: Error) => void) | undefined;
    fakes.generateUiText.mockReturnValueOnce(new Promise<string>((_resolve, rejectGeneration) => {
      reject = rejectGeneration;
    }));
    const rejected = await renderHook(options({ prompt: "Rejected" }));
    expect(value).toBeUndefined();
    reject?.(new Error("fake sidecar unavailable"));
    await flush();
    expect(value).toBeNull();
    await rejected.close();

    let resolveCancelled: ((text: string) => void) | undefined;
    fakes.generateUiText.mockReturnValueOnce(new Promise<string>((resolve) => {
      resolveCancelled = resolve;
    }));
    const cancelled = await renderHook(options({ prompt: "Cancelled" }));
    await flush();
    await cancelled.close();
    resolveCancelled?.("Never applied");
    await Promise.resolve();
  });
});
