import { describe, expect, it } from "vitest";
import { validateSkillFields, validateSkillName } from "./execTool.js";

const NAME_ERROR =
  "Skill names must be 1–64 lowercase letters, numbers, or hyphens, without a leading or trailing hyphen.";

describe("execTool skill validation", () => {
  it("normalizes valid skill names without changing valid hyphen runs", () => {
    expect(validateSkillName("  Review Contract_V2  ")).toEqual({ ok: true, value: "review-contract-v2" });
    expect(validateSkillName("a--b")).toEqual({ ok: true, value: "a--b" });
    expect(validateSkillName("a".repeat(64))).toEqual({ ok: true, value: "a".repeat(64) });
  });

  it.each([
    ["", "Give the skill a name."],
    [" \t ", "Give the skill a name."],
    ["-leading", NAME_ERROR],
    ["trailing-", NAME_ERROR],
    ["not!allowed", NAME_ERROR],
    ["a\tb", NAME_ERROR],
    ["a".repeat(65), NAME_ERROR],
  ])("rejects invalid name %j", (name, error) => {
    expect(validateSkillName(name)).toEqual({ ok: false, error });
  });

  it("accepts boundary-length Unicode fields and returns the normalized name", () => {
    expect(validateSkillFields(" Review_V2 ", "😀".repeat(2000), "i".repeat(200_000))).toEqual({
      ok: true,
      value: "review-v2",
    });
  });

  it("rejects the invalid name before inspecting the other fields", () => {
    expect(validateSkillFields("-invalid", "", "i".repeat(200_001))).toEqual({
      ok: false,
      error: NAME_ERROR,
    });
  });

  it.each([
    ["review", "  \n ", "", "Describe what the skill does and when the assistant should use it."],
    ["review", "😀".repeat(2001), "", "Keep the skill description under 2000 characters."],
    [
      "review",
      "A useful description",
      "i".repeat(200_001),
      "SKILL.md is too large. Move detailed material into references/.",
    ],
  ])("rejects invalid fields", (name, description, instructions, error) => {
    expect(validateSkillFields(name, description, instructions)).toEqual({ ok: false, error });
  });
});
