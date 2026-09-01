import { describe, expect, it } from "vitest";
import type { CastMember } from "./db-host/story.js";
import {
  assignCast,
  MAX_SHOT_CAST,
  namesAppear,
  parseParsedMembers,
  type PlannedShot,
} from "./storyTools.js";

function member(name: string): CastMember {
  return { id: name, name, description: "", story: "", faceFileId: null, ord: 0 };
}

function shot(action: string): PlannedShot {
  return { action, seconds: 15 };
}

describe("story tool pure parsing", () => {
  it("keeps cast parsing all-or-nothing", () => {
    expect(
      parseParsedMembers([
        { name: "Mira", description: "grey coat", story: "a sailor" },
        { name: "Doran", description: "broad", story: "a dock worker" },
      ]),
    ).toEqual([
      { name: "Mira", description: "grey coat", story: "a sailor" },
      { name: "Doran", description: "broad", story: "a dock worker" },
    ]);
    expect(parseParsedMembers([{ name: "Mira", description: "grey coat" }])).toEqual([]);
    expect(parseParsedMembers({ cast: [] })).toEqual([]);
  });

  it("matches whole UTF-8 byte words with the shipped boundary quirk", () => {
    expect(namesAppear("Mira, she turns.", "Mira")).toBe(true);
    expect(namesAppear("Noah waits; no answer comes.", "Noa")).toBe(false);
    expect(namesAppear("xNoa", "Noa")).toBe(false);
    expect(namesAppear("Mira—she turns.", "Mira")).toBe(false);
    expect(namesAppear("Zoë waits.", "Zoë")).toBe(true);
  });

  it("assigns recognized cast in order, caps a crowd, and carries a scene forward", () => {
    const cast = ["Ada", "Bo", "Cai", "Dev", "Eli", "Mira Halloran"].map(member);
    const assigned = assignCast([
      shot("Ada, Bo, Cai, Dev, and Eli arrive."),
      shot("They look toward the quay."),
      shot("Mira walks into the light."),
    ], cast);

    expect(assigned[0]).toEqual(["Ada", "Bo", "Cai", "Dev"]);
    expect(assigned[0]).toHaveLength(MAX_SHOT_CAST);
    expect(assigned[1]).toEqual(["Ada", "Bo", "Cai", "Dev"]);
    expect(assigned[2]).toEqual(["Mira Halloran"]);
  });
});
