import { describe, expect, it, vi } from "vitest";

vi.mock("./monacoSetup", () => ({
  default: {},
  EDITOR_FONT: "test-font",
  languageForFile: vi.fn(),
  monacoTheme: vi.fn(),
  remeasureWhenFontReady: vi.fn(),
  watchMonacoTheme: vi.fn(),
}));

import { isRtlDominant } from "./DiffView";

describe("isRtlDominant", () => {
  it("recognizes Hebrew and Arabic text despite punctuation and numbers", () => {
    expect(isRtlDominant("שלום, version 2")).toBe(true);
    expect(isRtlDominant("مرحبا world")).toBe(true);
  });

  it("does not classify Latin, numbers, or a minority RTL run as RTL dominant", () => {
    expect(isRtlDominant("plain English document")).toBe(false);
    expect(isRtlDominant("1234 -- !?")).toBe(false);
    expect(isRtlDominant("abcdefghij אב")).toBe(false);
  });
});
