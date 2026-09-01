import { beforeEach, describe, expect, it, vi } from "vitest";
import { createToolEffects, execTool, type ExecToolDeps } from "./execTool.js";

const skillDb = vi.hoisted(() => ({
  createSkill: vi.fn(),
  deleteSkillResource: vi.fn(),
  findSkill: vi.fn(),
  getSkillResource: vi.fn(),
  listSkillResources: vi.fn(),
  listSkills: vi.fn(),
  setSkillEnabled: vi.fn(),
  updateSkill: vi.fn(),
  upsertSkillResource: vi.fn(),
}));

vi.mock("./db-host/skills.js", () => skillDb);

function deps(overrides: Partial<ExecToolDeps> = {}): ExecToolDeps {
  return {
    db: {} as ExecToolDeps["db"],
    routes: [],
    emit: vi.fn(),
    ...overrides,
  };
}

async function writeResource(
  path: string,
  content = "fabricated resource body",
  context: Partial<ExecToolDeps> = {}
) {
  return execTool(
    "write_skill_resource",
    { skill: "fabricated-skill", path, content },
    createToolEffects(),
    deps(context)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  skillDb.findSkill.mockReturnValue({ id: "skill-1", name: "Fabricated skill" });
  skillDb.listSkillResources.mockReturnValue([]);
});

describe("write_skill_resource resource kinds", () => {
  it.each([
    ["scripts/compile.mjs", "scripts/compile.mjs", "script"],
    ["references/policy.with-any-extension", "references/policy.with-any-extension", "reference"],
    ["assets/logo", "assets/logo", "asset"],
    ["agents/reviewer.yaml", "agents/reviewer.yaml", "agent"],
    ["notes/plain.bin", "notes/plain.bin", "resource"],
    ["Scripts/case-sensitive.ts", "Scripts/case-sensitive.ts", "resource"],
    ["scripts\\normalizes.ts", "scripts/normalizes.ts", "script"],
  ])("stores %s as %s", async (providedPath, savedPath, kind) => {
    await expect(writeResource(providedPath)).resolves.toEqual({
      ok: true,
      text: `Saved ${savedPath} in "Fabricated skill" and left the skill disabled for review.`,
    });

    expect(skillDb.upsertSkillResource).toHaveBeenCalledWith(
      expect.anything(),
      "skill-1",
      savedPath,
      kind,
      Buffer.from("fabricated resource body", "utf8")
    );
    expect(skillDb.setSkillEnabled).toHaveBeenCalledWith(expect.anything(), "skill-1", false);
  });

  it.each([
    ["../assets/logo.png", "Resource paths must stay inside the skill folder; SKILL.md is edited through the skill fields."],
    ["assets/", 'A resource path must name a file, not a folder — remove the trailing "/".'],
    ["SKILL.md", "Resource paths must stay inside the skill folder; SKILL.md is edited through the skill fields."],
  ])("rejects malformed resource path %s before using the fabricated DB", async (path, error) => {
    await expect(writeResource(path)).resolves.toEqual({ ok: false, error });
    expect(skillDb.findSkill).not.toHaveBeenCalled();
    expect(skillDb.upsertSkillResource).not.toHaveBeenCalled();
  });

  it("refuses an oversized resource before looking up a fabricated room or skill", async () => {
    const oversized = "x".repeat(32 * 1024 * 1024 + 1);

    await expect(writeResource("assets/large.txt", oversized)).resolves.toEqual({
      ok: false,
      error: "That resource is too large (32 MB maximum).",
    });

    expect(skillDb.findSkill).not.toHaveBeenCalled();
    expect(skillDb.upsertSkillResource).not.toHaveBeenCalled();
  });

  it("refuses a valid fabricated resource when no room is open", async () => {
    await expect(writeResource("references/policy.md", "text", { db: null })).resolves.toEqual({
      ok: false,
      error: "No room is open.",
    });

    expect(skillDb.findSkill).not.toHaveBeenCalled();
    expect(skillDb.upsertSkillResource).not.toHaveBeenCalled();
  });

  it("reports a missing fabricated skill without attempting to write its resource", async () => {
    skillDb.findSkill.mockReturnValue(null);

    await expect(writeResource("references/policy.md")).resolves.toEqual({
      ok: false,
      error: 'No skill named "fabricated-skill" exists.',
    });

    expect(skillDb.listSkillResources).not.toHaveBeenCalled();
    expect(skillDb.upsertSkillResource).not.toHaveBeenCalled();
  });

  it("refuses a fabricated resource that would turn an existing file into a folder", async () => {
    skillDb.listSkillResources.mockReturnValue([{ path: "references" }]);

    await expect(writeResource("references/policy.md")).resolves.toEqual({
      ok: false,
      error:
        '"references" and "references/policy.md" can\'t both be in one skill: a file and a folder cannot share a name. Rename one of them.',
    });

    expect(skillDb.upsertSkillResource).not.toHaveBeenCalled();
    expect(skillDb.setSkillEnabled).not.toHaveBeenCalled();
  });
});
