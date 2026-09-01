import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const moduleNames = [
  "remark-math",
  "rehype-katex",
  "rehype-highlight",
  "katex/dist/katex.min.css",
] as const;

type ModuleFactory = () => Record<string, unknown>;

function mockRichModules(overrides: Partial<Record<(typeof moduleNames)[number], ModuleFactory>> = {}) {
  const defaults: Record<(typeof moduleNames)[number], ModuleFactory> = {
    "remark-math": () => ({ default: "remark-math-plugin" }),
    "rehype-katex": () => ({ default: "rehype-katex-plugin" }),
    "rehype-highlight": () => ({ default: "rehype-highlight-plugin" }),
    "katex/dist/katex.min.css": () => ({}),
  };
  for (const name of moduleNames) vi.doMock(name, overrides[name] ?? defaults[name]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const name of moduleNames) vi.doUnmock(name);
  vi.resetModules();
});

describe("warmRichPlugins", () => {
  it("starts the mocked rich-plugin load during idle time and suppresses another warm while it is in flight", async () => {
    mockRichModules();
    const idle = { start: null as (() => void) | null };
    const requestIdleCallback = vi.fn((callback: () => void) => {
      idle.start = callback;
      return 1;
    });
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    const rich = await import("./markdownRich");

    rich.warmRichPlugins();
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 3000 });
    expect(rich.richPluginsIfLoaded()).toBeNull();

    if (!idle.start) throw new Error("idle callback was not scheduled");
    idle.start();
    rich.warmRichPlugins();
    expect(requestIdleCallback).toHaveBeenCalledOnce();
    await vi.dynamicImportSettled();
    expect(rich.richPluginsIfLoaded()).toEqual({
      remarkPlugins: ["remark-math-plugin"],
      rehypePlugins: [
        "rehype-katex-plugin",
        ["rehype-highlight-plugin", { ignoreMissing: true, detect: true }],
      ],
    });
  });

  it("uses the fallback timer and swallows a fabricated dynamic-plugin rejection without scheduling a retry", async () => {
    mockRichModules({
      "rehype-highlight": () => { throw new Error("fabricated plugin load failure"); },
    });
    vi.stubGlobal("requestIdleCallback", undefined);
    const rich = await import("./markdownRich");

    rich.warmRichPlugins();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1199);
    expect(rich.richPluginsIfLoaded()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await vi.dynamicImportSettled();
    expect(rich.richPluginsIfLoaded()).toBeNull();

    rich.warmRichPlugins();
    expect(vi.getTimerCount()).toBe(0);
  });
});
