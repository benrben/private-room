import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NeuralVoiceInfo } from "../api";

const mocks = vi.hoisted(() => ({ listNeuralVoices: vi.fn() }));

vi.mock("../api", () => ({ api: { listNeuralVoices: mocks.listNeuralVoices } }));

function voice(
  id: string,
  locale: string,
  gender = "",
): NeuralVoiceInfo {
  return { id, locale, gender };
}

async function catalog() {
  return import("./voiceCatalog");
}

beforeEach(() => {
  vi.resetModules();
  mocks.listNeuralVoices.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("voiceCatalog", () => {
  it("shares a successful catalog load and retries after a mocked failure", async () => {
    const voices = [voice("en-US-AdaMultilingualNeural", "en-US", "Female")];
    mocks.listNeuralVoices.mockResolvedValueOnce(voices);
    const firstCatalog = await catalog();
    const first = firstCatalog.loadVoiceCatalog();
    const second = firstCatalog.loadVoiceCatalog();
    expect(second).toBe(first);
    await expect(first).resolves.toEqual(voices);
    expect(mocks.listNeuralVoices).toHaveBeenCalledOnce();

    vi.resetModules();
    mocks.listNeuralVoices.mockRejectedValueOnce(new Error("catalog offline"));
    const retryCatalog = await catalog();
    await expect(retryCatalog.loadVoiceCatalog()).rejects.toThrow("catalog offline");
    mocks.listNeuralVoices.mockResolvedValueOnce(voices);
    await expect(retryCatalog.loadVoiceCatalog()).resolves.toEqual(voices);
    expect(mocks.listNeuralVoices).toHaveBeenCalledTimes(3);
  });

  it("turns catalog identifiers into consistent labels and language groups", async () => {
    const voiceCatalog = await catalog();
    const ada = voice("en-US-AdaMultilingualNeural", "en-US", "Female");
    const ben = voice("he-IL-BenNeural", "he-IL", "Male");
    const camille = voice("fr-FR-CamilleNeural", "fr-FR");
    expect(voiceCatalog.voiceName(ada.id)).toBe("Ada");
    expect(voiceCatalog.optionLabel(ada)).toBe("Ada — female");
    expect(voiceCatalog.optionLabel(camille)).toBe("Camille");
    expect(voiceCatalog.isMultilingual(ada)).toBe(true);
    expect(voiceCatalog.isMultilingual(ben)).toBe(false);
    expect(voiceCatalog.languageLabel("he-IL")).toBe("Hebrew (Israel)");

    const grouped = voiceCatalog.groupVoices([ben, ada, camille]);
    expect(grouped.multilingual).toEqual([ada]);
    expect(grouped.byLanguage.map(([, voices]) => voices)).toEqual([[camille], [ben]]);

    const displayNames = Intl.DisplayNames;
    Object.defineProperty(Intl, "DisplayNames", {
      configurable: true,
      value: () => { throw new Error("DisplayNames unsupported"); },
    });
    try {
      expect(voiceCatalog.languageLabel("zz-ZZ")).toBe("zz-ZZ");
    } finally {
      Object.defineProperty(Intl, "DisplayNames", { configurable: true, value: displayNames });
    }
  });

  it("suggests distinct voices in multilingual order while respecting a preferred voice", async () => {
    const voiceCatalog = await catalog();
    const ada = voice("en-US-AdaMultilingualNeural", "en-US", "Female");
    const max = voice("en-US-MaxMultilingualNeural", "en-US", "Male");
    const ben = voice("he-IL-BenNeural", "he-IL", "Male");
    const fallback = voice("fr-FR-CamilleNeural", "fr-FR");
    expect(voiceCatalog.suggestDistinctVoices([ada, max, ben], 4, ben.id)).toEqual([
      ben.id,
      ada.id,
      max.id,
      "",
    ]);
    expect(voiceCatalog.suggestDistinctVoices([ada, max, fallback], 3)).toEqual([
      ada.id,
      max.id,
      fallback.id,
    ]);
    expect(voiceCatalog.suggestDistinctVoices([ada], 0, ada.id)).toEqual([ada.id]);
    expect(voiceCatalog.castNeedsVoices([{ voice: " Ada " }, { voice: "Ada" }])).toBe(true);
    expect(voiceCatalog.castNeedsVoices([{ voice: "" }, { voice: "Ben" }])).toBe(true);
    expect(voiceCatalog.castNeedsVoices([{ voice: "Ada" }, { voice: "Ben" }])).toBe(false);
  });
});
