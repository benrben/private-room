import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryOpt: vi.fn() }));

vi.mock("./util.js", () => ({
  executeExisting: vi.fn(),
  executeOne: vi.fn(),
  executeUnique: vi.fn(),
  queryOne: vi.fn(),
  queryOpt: mocks.queryOpt,
  queryRows: vi.fn(),
}));

import { SKILL_GONE, updateSkill } from "./skills.js";

function fakeDb(run: ReturnType<typeof vi.fn>) {
  const statement = { run };
  return {
    prepare: vi.fn(() => statement),
  };
}

describe("updateSkill with fabricated database boundaries", () => {
  beforeEach(() => vi.resetAllMocks());

  it("patches a non-conflicting skill through the supplied fake statement", () => {
    const run = vi.fn(() => ({ changes: 1 }));
    const db = fakeDb(run);
    mocks.queryOpt.mockReturnValue(null);

    expect(() => updateSkill(
      db as never,
      "skill-1",
      "Review contracts",
      "Find missing terms",
      "Read every termination clause.",
      "legal.review",
    )).not.toThrow();

    expect(mocks.queryOpt).toHaveBeenCalledWith(
      db,
      expect.stringContaining("name = ? COLLATE NOCASE"),
      ["Review contracts", "skill-1", "skill-1"],
      expect.any(Function),
    );
    expect(run).toHaveBeenCalledWith(
      "Review contracts",
      "Find missing terms",
      "Read every termination clause.",
      "legal.review",
      "skill-1",
    );
  });

  it("reports a missing skill when the fake update changes no rows", () => {
    const run = vi.fn(() => ({ changes: 0 }));
    const db = fakeDb(run);
    mocks.queryOpt.mockReturnValue(null);

    expect(() => updateSkill(db as never, "deleted", "Review", "d", "body", ""))
      .toThrow(SKILL_GONE);
  });

  it("rejects a case-insensitive name clash before preparing a fake update", () => {
    const run = vi.fn(() => ({ changes: 1 }));
    const db = fakeDb(run);
    mocks.queryOpt.mockReturnValue(true);

    expect(() => updateSkill(db as never, "skill-1", "review", "d", "body", ""))
      .toThrow('A skill named "review" already exists.');
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("relables a fake unique-constraint write error with the skill name", () => {
    const run = vi.fn(() => { throw new Error("UNIQUE constraint failed: skills.name"); });
    const db = fakeDb(run);
    mocks.queryOpt.mockReturnValue(null);

    expect(() => updateSkill(db as never, "skill-1", "Review", "d", "body", ""))
      .toThrow('A skill named "Review" already exists.');
  });

  it("preserves a non-unique non-Error fake database failure", () => {
    const failure = "fabricated database unavailable";
    const run = vi.fn(() => { throw failure; });
    const db = fakeDb(run);
    mocks.queryOpt.mockReturnValue(null);

    let caught: unknown;
    try {
      updateSkill(db as never, "skill-1", "Review", "d", "body", "");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
  });
});
