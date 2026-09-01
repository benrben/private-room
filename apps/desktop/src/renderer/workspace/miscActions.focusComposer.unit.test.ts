import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutApi } from "../shell/useLayout";
import type { WSState } from "./state";

const apiMocks = vi.hoisted(() => ({ api: {} }));

vi.mock("../api", () => ({
  api: apiMocks.api,
  engineModelLabel: vi.fn(),
  frontPage: vi.fn(),
  frontPageSuggestions: vi.fn(),
}));

import { makeMiscActions } from "./miscActions";

const originalWindow = Reflect.get(globalThis, "window");

function state(composer: { focus: () => void } | null) {
  return {
    composerRef: { current: composer },
    setAiTab: vi.fn(),
  } as unknown as WSState;
}

function layout(): LayoutApi {
  return { showPane: vi.fn() } as unknown as LayoutApi;
}

function actionsFor(s: WSState) {
  return makeMiscActions(s, {} as never, { viewFile: vi.fn().mockResolvedValue(undefined) });
}

beforeEach(() => {
  vi.useFakeTimers();
  Reflect.set(globalThis, "window", { setTimeout: globalThis.setTimeout } as unknown as Window & typeof globalThis);
});

afterEach(() => {
  vi.useRealTimers();
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
  else Reflect.set(globalThis, "window", originalWindow);
  vi.restoreAllMocks();
});

describe("makeMiscActions focusComposer with a fabricated composer ref", () => {
  it("reveals chat and focuses a mounted composer without scheduling a retry", () => {
    const focus = vi.fn();
    const s = state({ focus });
    const l = layout();

    actionsFor(s).focusComposer(l);

    expect(s.setAiTab).toHaveBeenCalledWith("chat");
    expect(l.showPane).toHaveBeenCalledWith("ai");
    expect(focus).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries after the fabricated composer mounts and leaves the optional layout untouched", () => {
    const focus = vi.fn();
    const s = state(null);

    actionsFor(s).focusComposer();
    expect(vi.getTimerCount()).toBe(1);
    s.composerRef.current = { focus } as unknown as HTMLTextAreaElement;
    vi.advanceTimersByTime(40);

    expect(s.setAiTab).toHaveBeenCalledWith("chat");
    expect(focus).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops retrying when the composer never mounts and preserves focus errors", () => {
    const absent = state(null);
    actionsFor(absent).focusComposer();
    vi.runAllTimers();
    expect(vi.getTimerCount()).toBe(0);

    const error = new Error("fake focus failure");
    const s = state({ focus: () => { throw error; } });
    expect(() => actionsFor(s).focusComposer()).toThrow(error);
  });
});
