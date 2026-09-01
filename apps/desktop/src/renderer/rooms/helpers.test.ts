import { afterEach, describe, expect, it, vi } from "vitest";
import {
  duplicateDestinationSuggestion,
  duplicateFileName,
  fileNameOf,
  passwordCriteria,
  passwordStrength,
  prefersReducedMotion,
  relativeTime,
} from "./helpers";

const originalWindow = Reflect.get(globalThis, "window");

afterEach(() => {
  vi.restoreAllMocks();
  if (originalWindow === undefined)
    Reflect.deleteProperty(globalThis, "window");
  else Reflect.set(globalThis, "window", originalWindow);
});

describe("room filename helpers", () => {
  it("keeps basename and duplicate destination rules distinct", () => {
    expect(fileNameOf("rooms/alpha.arcelle")).toBe("alpha.arcelle");
    expect(fileNameOf("trailing/")).toBe("");
    expect(duplicateFileName(" Q3/Q4: plan ")).toBe("Copy of Q3 Q4 plan");
    expect(duplicateFileName(" /: ")).toBe("Copy of room");
    expect(duplicateFileName(null as unknown as string)).toBe("Copy of room");
    expect(duplicateDestinationSuggestion("Research", "workspace")).toEqual({
      title: "Choose destination workspace folder",
      defaultPath: "Copy of Research",
    });
    expect(duplicateDestinationSuggestion("Research", "legacy")).toEqual({
      title: "Save duplicated Arcelle room",
      defaultPath: "Copy of Research.arcelle",
    });
  });
});

describe("password strength", () => {
  it("uses the exact length and character-kind thresholds", () => {
    expect(passwordStrength("")).toEqual({
      score: 0,
      label: "",
      level: "weak",
    });
    expect(passwordStrength("Aa1!aaa")).toEqual({
      score: 1,
      label: "Weak",
      level: "weak",
    });
    expect(passwordStrength("abc12345")).toEqual({
      score: 2,
      label: "Okay",
      level: "okay",
    });
    expect(passwordStrength("Abcdef12")).toEqual({
      score: 2,
      label: "Okay",
      level: "okay",
    });
    expect(passwordStrength("Abcdefgh1234!")).toEqual({
      score: 3,
      label: "Strong",
      level: "strong",
    });
  });

  it("reports the same threshold facts in the criteria list", () => {
    expect(passwordCriteria("short")).toEqual([
      { label: "8+ characters", met: false },
      { label: "12+ characters", met: false },
      { label: "Mix of letters, numbers or symbols", met: false },
    ]);
    expect(passwordCriteria("Abcdef123456")).toEqual([
      { label: "8+ characters", met: true },
      { label: "12+ characters", met: true },
      { label: "Mix of letters, numbers or symbols", met: true },
    ]);
  });
});

describe("relativeTime", () => {
  it("uses deterministic rounding boundaries and singular/plural units", () => {
    const now = 1_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const ago = (minutes: number) => relativeTime(now - minutes * 60_000);

    expect(relativeTime()).toBe("");
    expect(relativeTime(0)).toBe("");
    expect(relativeTime(now + 1)).toBe("just now");
    expect(relativeTime(now - 29_999)).toBe("just now");
    expect(ago(0.5)).toBe("1 min ago");
    expect(ago(59)).toBe("59 min ago");
    expect(ago(60)).toBe("1 hour ago");
    expect(ago(120)).toBe("2 hours ago");
    expect(ago(60 * 24)).toBe("1 day ago");
    expect(ago(60 * 24 * 2)).toBe("2 days ago");
    expect(ago(60 * 24 * 30)).toBe("1 month ago");
    expect(ago(60 * 24 * 60)).toBe("2 months ago");
    expect(ago(60 * 24 * 360)).toBe("1 year ago");
    expect(ago(60 * 24 * 720)).toBe("2 years ago");
  });
});

describe("prefersReducedMotion", () => {
  it("requires a browser matcher and its positive result", () => {
    Reflect.deleteProperty(globalThis, "window");
    expect(prefersReducedMotion()).toBe(false);

    Reflect.set(globalThis, "window", {});
    expect(prefersReducedMotion()).toBe(false);

    const matchMedia = vi.fn(() => ({ matches: true }));
    Reflect.set(globalThis, "window", { matchMedia });
    expect(prefersReducedMotion()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  });
});
