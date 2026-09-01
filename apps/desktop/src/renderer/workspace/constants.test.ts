import { describe, expect, it } from "vitest";
import { chatPageSlice, chatPageToReveal } from "./constants";

describe("chat page boundaries", () => {
  it("keeps only the newest requested rows and reports the omitted count", () => {
    expect(chatPageSlice(["one", "two", "three"], 2)).toEqual({
      hidden: 1,
      visible: ["two", "three"],
    });
    expect(chatPageSlice(["one", "two"], -1)).toEqual({ hidden: 2, visible: [] });
    expect(chatPageSlice(["one"], 8)).toEqual({ hidden: 0, visible: ["one"] });
  });

  it("expands a tail page just far enough to reveal a valid result", () => {
    expect(chatPageToReveal(100, 0)).toBe(100);
    expect(chatPageToReveal(100, 99)).toBe(1);
    expect(chatPageToReveal(100, -1)).toBe(0);
    expect(chatPageToReveal(100, 100)).toBe(0);
  });
});
