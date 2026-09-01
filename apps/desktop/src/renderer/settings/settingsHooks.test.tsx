import * as React from "react";
import type ReactType from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  values: new Map<string, string | null>(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("../api", () => ({
  api: {
    getSetting: mocks.getSetting,
    setSetting: mocks.setSetting,
  },
}));

import { useAdvisors } from "./useAdvisors";
import { useBehaviorSettings } from "./useBehaviorSettings";

const globalKeys = ["window", "document", "navigator", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

let advisors: ReturnType<typeof useAdvisors> | null = null;
let behavior: ReturnType<typeof useBehaviorSettings> | null = null;
let clearBehaviorError: ReturnType<typeof vi.fn>;

function AdvisorsProbe() {
  advisors = useAdvisors();
  return null;
}

function BehaviorProbe() {
  behavior = useBehaviorSettings(clearBehaviorError);
  return null;
}

beforeEach(() => {
  advisors = null;
  behavior = null;
  clearBehaviorError = vi.fn();
  mocks.values.clear();
  mocks.getSetting.mockReset().mockImplementation(async (key: string) => mocks.values.get(key) ?? null);
  mocks.setSetting.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

async function mount(Probe: () => ReactType.ReactNode) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Probe));
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
  return { close: async () => act(async () => root.unmount()) };
}

describe("useAdvisors", () => {
  it("loads fake settings and turns off the dependent tools setting with the master switch", async () => {
    mocks.values.set("advisors_enabled", "on");
    mocks.values.set("advisor_tools_enabled", "on");
    const view = await mount(AdvisorsProbe);
    try {
      expect(advisors).toMatchObject({ advisorsOn: true, advisorToolsOn: true });
      await act(async () => {
        advisors?.onAdvisorsToggle({ target: { checked: false } } as ReactType.ChangeEvent<HTMLInputElement>);
      });
      expect(advisors).toMatchObject({ advisorsOn: false, advisorToolsOn: false });
      expect(mocks.setSetting).toHaveBeenNthCalledWith(1, "advisors_enabled", "off");
      expect(mocks.setSetting).toHaveBeenNthCalledWith(2, "advisor_tools_enabled", "off");

      await act(async () => {
        advisors?.onAdvisorsToggle({ target: { checked: true } } as ReactType.ChangeEvent<HTMLInputElement>);
        advisors?.onAdvisorToolsToggle({ target: { checked: true } } as ReactType.ChangeEvent<HTMLInputElement>);
      });
      expect(advisors).toMatchObject({ advisorsOn: true, advisorToolsOn: true });
      expect(mocks.setSetting).toHaveBeenLastCalledWith("advisor_tools_enabled", "on");
    } finally {
      await view.close();
    }
  });
});

describe("useBehaviorSettings temperature loading", () => {
  it.each([
    [null, 0.7, undefined],
    ["not-a-number", 0.7, undefined],
    ["1.5", 1, ["temperature", "1.00"]],
    ["0.35", 0.35, undefined],
  ] as const)("keeps the documented temperature contract for %s", async (stored, expected, persisted) => {
    if (stored !== null) mocks.values.set("temperature", stored);
    const view = await mount(BehaviorProbe);
    try {
      expect(behavior?.temperature).toBe(expected);
      if (persisted) expect(mocks.setSetting).toHaveBeenCalledWith(...persisted);
      else expect(mocks.setSetting).not.toHaveBeenCalled();
    } finally {
      await view.close();
    }
  });

  it("keeps a rejected auto-index read at its safe default", async () => {
    mocks.getSetting.mockImplementation(async (key: string) => {
      if (key === "auto_index") throw new Error("setting unavailable");
      return null;
    });
    const view = await mount(BehaviorProbe);
    try {
      expect(behavior?.autoIndex).toBe(true);
    } finally {
      await view.close();
    }
  });

  it("loads stored custom instructions as the clean tuning baseline", async () => {
    mocks.values.set("custom_instructions", "Use the room glossary.");
    const view = await mount(BehaviorProbe);
    try {
      expect(behavior?.instructions).toBe("Use the room glossary.");
      expect(behavior?.tuningDirty).toBe(false);
    } finally {
      await view.close();
    }
  });

  it("saves tuning and immediately persists every behavioral toggle", async () => {
    const view = await mount(BehaviorProbe);
    try {
      await act(async () => {
        behavior?.setTemperature(0.25);
        behavior?.setInstructions("  Keep it short.  ");
      });
      await act(async () => behavior?.saveTuning());
      await act(async () => {
        behavior?.changeResponseStyle("terse");
        behavior?.changeAutoIndex(false);
        behavior?.changeMemoryAutoSave(true);
        behavior?.changeEditApproval("turn");
        behavior?.changeAdaptiveTextEnabled(false);
        await Promise.resolve();
      });

      expect(clearBehaviorError).toHaveBeenCalledOnce();
      expect(mocks.setSetting.mock.calls).toEqual(expect.arrayContaining([
        ["temperature", "0.25"],
        ["custom_instructions", "Keep it short."],
        ["response_style", "terse"],
        ["auto_index", "0"],
        ["memory_auto_save", "1"],
        ["edit_approval", "turn"],
        ["adaptive_text_enabled", "0"],
      ]));
      expect(behavior).toMatchObject({
        saved: true,
        tuningDirty: false,
        responseStyle: "terse",
        autoIndex: false,
        memoryAutoSave: true,
        editApproval: "turn",
        adaptiveTextEnabled: false,
      });
    } finally {
      await view.close();
    }
  });
});
