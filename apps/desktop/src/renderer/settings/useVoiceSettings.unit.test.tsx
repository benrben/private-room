import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));
const voice = vi.hoisted(() => ({
  defaults: {
    off: { reverb: 0, distortion: 0 },
    demon: { reverb: 0.4, distortion: 0.5 },
    ghost: { reverb: 0.6, distortion: 0 },
    wraith: { reverb: 0.7, distortion: 0 },
    ancient: { reverb: 0.3, distortion: 0.19 },
  },
  configure: vi.fn(),
  cancelAll: vi.fn(),
  ensureUnlocked: vi.fn(),
  speakText: vi.fn(),
}));
const catalog = vi.hoisted(() => ({ loadVoiceCatalog: vi.fn() }));

vi.mock("../api", () => ({ api: bridge }));
vi.mock("../workspace/voice", () => ({
  ARCHETYPE_DEFAULTS: voice.defaults,
  configure: voice.configure,
  cancelAll: voice.cancelAll,
  ensureUnlocked: voice.ensureUnlocked,
  speakText: voice.speakText,
}));
vi.mock("./voiceCatalog", () => ({ loadVoiceCatalog: catalog.loadVoiceCatalog }));

import { useVoiceSettings } from "./useVoiceSettings";

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

type VoiceSettings = ReturnType<typeof useVoiceSettings>;
let settings: VoiceSettings | null = null;

function VoiceSettingsProbe({ visible }: { visible: boolean }) {
  settings = useVoiceSettings(visible);
  return null;
}

function current(): VoiceSettings {
  if (!settings) throw new Error("Voice settings hook has not rendered.");
  return settings;
}

async function flush(rounds = 6) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function renderHook(visible = false) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  const timers: Array<() => void> = [];
  Reflect.set(window, "setTimeout", (callback: () => void) => {
    timers.push(callback);
    return timers.length;
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
  await act(async () => root.render(createElement(VoiceSettingsProbe, { visible })));
  await flush();
  return {
    close: async () => act(async () => root.unmount()),
    rerender: async (nextVisible: boolean) => {
      await act(async () => root.render(createElement(VoiceSettingsProbe, { visible: nextVisible })));
      await flush();
    },
    runTimers: async () => act(async () => timers.splice(0).forEach((callback) => callback())),
  };
}

beforeEach(() => {
  settings = null;
  bridge.getSetting.mockReset().mockResolvedValue(null);
  bridge.setSetting.mockReset().mockResolvedValue(undefined);
  catalog.loadVoiceCatalog.mockReset().mockResolvedValue([
    { id: "en-US-FakeNeural", locale: "en-US", gender: "Female" },
  ]);
  voice.configure.mockReset();
  voice.cancelAll.mockReset();
  voice.ensureUnlocked.mockReset();
  voice.speakText.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("useVoiceSettings with fabricated bridge, catalog, and speech APIs", () => {
  it("loads the stored baseline and fetches its catalog only once after the page becomes visible", async () => {
    bridge.getSetting.mockImplementation((key: string) => Promise.resolve({
      voice_neural_id: "he-IL-FakeNeural",
      voice_archetype: "ghost",
      voice_params: JSON.stringify({ reverb: 0.25, distortion: 0.75 }),
    }[key] ?? null));
    const view = await renderHook(false);

    expect(bridge.getSetting).toHaveBeenCalledTimes(3);
    expect(current().neuralVoiceId).toBe("he-IL-FakeNeural");
    expect(current().archetype).toBe("ghost");
    expect(current().params).toEqual({ reverb: 0.25, distortion: 0.75 });
    expect(current().voiceDirty).toBe(false);
    expect(catalog.loadVoiceCatalog).not.toHaveBeenCalled();

    await view.rerender(true);
    expect(catalog.loadVoiceCatalog).toHaveBeenCalledOnce();
    expect(current().voices).toEqual([{ id: "en-US-FakeNeural", locale: "en-US", gender: "Female" }]);
    await view.rerender(false);
    await view.rerender(true);
    expect(catalog.loadVoiceCatalog).toHaveBeenCalledOnce();
    await view.close();
  });

  it("keeps malformed and unavailable stored values honest, and displays a fabricated catalog failure", async () => {
    bridge.getSetting.mockImplementation((key: string) => {
      if (key === "voice_neural_id") return Promise.reject(new Error("fake settings unavailable"));
      if (key === "voice_archetype") return Promise.resolve("demon");
      return Promise.resolve("{not JSON");
    });
    catalog.loadVoiceCatalog.mockRejectedValueOnce(new Error("fake catalog unavailable"));
    const view = await renderHook(true);

    expect(current().neuralVoiceId).toBe("");
    expect(current().archetype).toBe("demon");
    expect(current().params).toEqual(voice.defaults.off);
    expect(current().voiceDirty).toBe(false);
    expect(current().voicesError).toBe(true);
    expect(current().voices).toEqual([]);
    await view.close();
  });

  it("updates presets and manual sliders, then saves the exact unsaved configuration", async () => {
    const view = await renderHook();
    await act(async () => {
      current().setNeuralVoiceId("en-US-SavedNeural");
      current().pickArchetype("ghost");
    });
    expect(current().params).toEqual(voice.defaults.ghost);
    await act(async () => current().pickArchetype("custom"));
    expect(current().params).toEqual(voice.defaults.ghost);
    await act(async () => current().setParam("distortion", 0.33));
    expect(current().archetype).toBe("custom");
    expect(current().params).toEqual({ reverb: 0.6, distortion: 0.33 });
    expect(current().voiceDirty).toBe(true);

    await act(async () => current().save());
    expect(bridge.setSetting).toHaveBeenNthCalledWith(1, "voice_neural_id", "en-US-SavedNeural");
    expect(bridge.setSetting).toHaveBeenNthCalledWith(2, "voice_archetype", "custom");
    expect(bridge.setSetting).toHaveBeenNthCalledWith(3, "voice_params", JSON.stringify({ reverb: 0.6, distortion: 0.33 }));
    expect(voice.configure).toHaveBeenCalledWith({
      archetype: "custom", params: { reverb: 0.6, distortion: 0.33 }, neuralVoiceId: "en-US-SavedNeural",
    });
    expect(current().voiceDirty).toBe(false);
    expect(current().saved).toBe(true);
    await view.runTimers();
    expect(current().saved).toBe(false);
    await act(async () => current().setNeuralVoiceId(""));
    await act(async () => current().save());
    expect(voice.configure.mock.calls.at(-1)![0]).toEqual(expect.objectContaining({
      neuralVoiceId: null,
    }));
    await view.close();
  });

  it("leaves an unsaved choice intact and visible when fabricated storage rejects it", async () => {
    bridge.setSetting.mockRejectedValueOnce(new Error("fake write failure"));
    const view = await renderHook();
    await act(async () => current().setParam("reverb", 0.8));
    await act(async () => current().save());

    expect(bridge.setSetting).toHaveBeenCalledOnce();
    expect(voice.configure).not.toHaveBeenCalled();
    expect(current().voiceDirty).toBe(true);
    expect(current().saved).toBe(false);
    expect(current().saveError).toBe("Couldn't save: Error: fake write failure");
    await view.close();
  });

  it("uses only fabricated speech controls for preview, stop, completion, and teardown", async () => {
    const idle = await renderHook();
    await idle.close();
    expect(voice.cancelAll).not.toHaveBeenCalled();

    const view = await renderHook();
    await act(async () => current().preview());
    expect(voice.ensureUnlocked).toHaveBeenCalledOnce();
    expect(current().previewing).toBe(true);
    expect(voice.speakText).toHaveBeenCalledWith(
      "I have read every page you keep in this room.",
      expect.objectContaining({ archetype: "off", params: voice.defaults.off, neuralVoiceId: null }),
    );
    const onState = voice.speakText.mock.calls[0]![1].onState as (playing: boolean) => void;
    await act(async () => onState(true));
    expect(current().previewing).toBe(true);
    await act(async () => onState(false));
    expect(current().previewing).toBe(false);

    await act(async () => current().preview());
    await act(async () => current().preview());
    expect(voice.cancelAll).toHaveBeenCalledOnce();
    expect(current().previewing).toBe(false);

    await act(async () => current().setNeuralVoiceId("en-US-PreviewNeural"));
    await act(async () => current().preview());
    expect(voice.speakText.mock.calls.at(-1)![1]).toEqual(expect.objectContaining({
      neuralVoiceId: "en-US-PreviewNeural",
    }));
    await view.close();
    expect(voice.cancelAll).toHaveBeenCalledTimes(2);
  });
});
