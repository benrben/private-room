import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutApi } from "../shell/useLayout";
import type { WSState } from "./state";

const bridge = vi.hoisted(() => ({ api: { setSetting: vi.fn() } }));

vi.mock("../api", () => ({
  api: bridge.api,
  engineModelLabel: vi.fn(),
  frontPage: vi.fn(),
  frontPageSuggestions: vi.fn(),
}));

import { makeMiscActions } from "./miscActions";

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function state() {
  return {
    setActiveChatId: vi.fn(),
    setAiTab: vi.fn(),
    setRevealMsgId: vi.fn(),
    setShowSearch: vi.fn(),
    setShowMap: vi.fn(),
    setShowWorkflows: vi.fn(),
    setShowScripts: vi.fn(),
    setOpenFile: vi.fn(),
    setArea: vi.fn(),
    setShowMemoryIntro: vi.fn(),
  } as unknown as WSState;
}

function actionsFor(s: WSState, viewFile = vi.fn().mockResolvedValue(undefined)) {
  return {
    actions: makeMiscActions(s, {} as never, { viewFile }),
    viewFile,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  bridge.api.setSetting.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  vi.restoreAllMocks();
});

describe("makeMiscActions result navigation with fabricated state", () => {
  it("opens a file hit with its find target and closes search", () => {
    const s = state();
    const { actions, viewFile } = actionsFor(s);

    actions.activateResult({ kind: "file", id: "file-1", name: "Notes", snippet: "needle" });

    expect(viewFile).toHaveBeenCalledWith("file-1", { find: "needle" });
    expect(s.setShowSearch).toHaveBeenCalledWith(false);
  });

  it("brings a message hit forward, retries until its fabricated element renders, then clears its mark", () => {
    const s = state();
    const showPane = vi.fn();
    const layout = { showPane } as unknown as LayoutApi;
    const scrollIntoView = vi.fn();
    const style = { outline: "", outlineOffset: "", borderRadius: "" };
    let message: { scrollIntoView: () => void; style: typeof style } | null = null;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { setTimeout: globalThis.setTimeout },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: vi.fn(() => message) },
    });

    actionsFor(s).actions.activateResult(
      { kind: "message", chatId: "chat-1", messageId: "message-1", snippet: "quoted" },
      layout,
    );

    expect(s.setActiveChatId).toHaveBeenCalledWith("chat-1");
    expect(s.setAiTab).toHaveBeenCalledWith("chat");
    expect(showPane).toHaveBeenCalledWith("ai");
    expect(s.setRevealMsgId).toHaveBeenCalledWith("message-1");
    expect(s.setShowSearch).toHaveBeenCalledWith(false);
    expect(vi.getTimerCount()).toBe(1);

    message = { scrollIntoView, style };
    vi.advanceTimersByTime(50);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(style).toEqual({
      outline: "2px solid var(--accent)",
      outlineOffset: "3px",
      borderRadius: "8px",
    });
    vi.advanceTimersByTime(2600);
    expect(style).toEqual({ outline: "", outlineOffset: "", borderRadius: "" });
  });

  it("opens a memory hit even when its best-effort setting write rejects", async () => {
    const s = state();
    bridge.api.setSetting.mockRejectedValueOnce(new Error("fabricated write failure"));

    actionsFor(s).actions.activateResult({ kind: "memory", id: "memory-1", snippet: "fact" });
    await Promise.resolve();

    expect(s.setShowMap).toHaveBeenCalledWith(false);
    expect(s.setShowWorkflows).toHaveBeenCalledWith(false);
    expect(s.setShowScripts).toHaveBeenCalledWith(false);
    expect(s.setOpenFile).toHaveBeenCalledWith(null);
    expect(s.setArea).toHaveBeenCalledWith("memory");
    expect(s.setShowMemoryIntro).toHaveBeenCalledWith(false);
    expect(bridge.api.setSetting).toHaveBeenCalledWith("memory_intro_seen", "1");
    expect(s.setShowSearch).toHaveBeenCalledWith(false);
  });
});
