import { describe, expect, it } from "vitest";
import { stripHebrewMarks } from "./files.js";

describe("stripHebrewMarks", () => {
  it("removes only combining marks, retaining Hebrew-block punctuation", () => {
    expect(stripHebrewMarks("קֹהֶלֶת־בְּרָכָה׃")).toBe("קהלת־ברכה׃");
  });
});
