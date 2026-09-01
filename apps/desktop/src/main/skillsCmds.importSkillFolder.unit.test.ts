import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

const fakes = vi.hoisted(() => ({
  createSkill: vi.fn(),
  deleteSkill: vi.fn(),
  deleteSkillResource: vi.fn(),
  findSkill: vi.fn(),
  listSkillResources: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  updateSkill: vi.fn(),
  upsertSkillResource: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: fakes.readFileSync,
  readdirSync: fakes.readdirSync,
  statSync: fakes.statSync,
}));

vi.mock("./db-host/skills.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db-host/skills.js")>()),
  createSkill: fakes.createSkill,
  deleteSkill: fakes.deleteSkill,
  deleteSkillResource: fakes.deleteSkillResource,
  findSkill: fakes.findSkill,
  listSkillResources: fakes.listSkillResources,
  updateSkill: fakes.updateSkill,
  upsertSkillResource: fakes.upsertSkillResource,
}));

vi.mock("./workflowCompose.js", () => ({
  generateTextAnyEngine: vi.fn(),
  withRealOllamaGenerate: vi.fn((deps) => deps),
}));

import { collectFolderFiles, importSkillFolderCmd, skillImportConflict } from "./skillsCmds.js";

const ROOT = "/fabricated/skill";
const SKILL_MD = [
  "---",
  "name: review",
  'description: "Review contracts"',
  "agent: files.read",
  "---",
  "",
  "Review the supplied contracts.",
].join("\n");

function dirent(name: string, kind: "directory" | "file") {
  return {
    name,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => false,
  };
}

function configureSkillFolder(skillMd = SKILL_MD): void {
  fakes.statSync.mockReturnValue({ isDirectory: () => true });
  fakes.readdirSync.mockImplementation((folder: string) => {
    if (folder === ROOT) return [dirent("SKILL.md", "file"), dirent("references", "directory")];
    if (folder === `${ROOT}/references`) return [dirent("policy.md", "file")];
    throw new Error(`Unexpected fabricated folder: ${folder}`);
  });
  fakes.readFileSync.mockImplementation((file: string, encoding?: string) => {
    if (file === `${ROOT}/SKILL.md` && encoding === "utf8") return skillMd;
    if (file === `${ROOT}/references/policy.md`) return Buffer.from("fabricated policy");
    throw new Error(`Unexpected fabricated file: ${file}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.createSkill.mockReturnValue("skill-new");
  fakes.findSkill.mockReturnValue(null);
  fakes.listSkillResources.mockReturnValue([]);
});

describe("importSkillFolderCmd", () => {
  it("imports fabricated folder bytes and keeps an emit failure from affecting the import", () => {
    configureSkillFolder();
    const emit = vi.fn(() => { throw new Error("fabricated renderer closed"); });

    expect(importSkillFolderCmd({} as Database.Database, ROOT, undefined, emit)).toBe("skill-new");

    expect(fakes.createSkill).toHaveBeenCalledWith(
      {},
      "review",
      "Review contracts",
      "Review the supplied contracts.",
      false,
      "import",
      "files.read",
    );
    expect(fakes.upsertSkillResource).toHaveBeenCalledWith(
      {},
      "skill-new",
      "references/policy.md",
      "reference",
      Buffer.from("fabricated policy"),
    );
    expect(emit).toHaveBeenCalledWith("skills-changed", undefined);
  });

  it("uses the fabricated existing skill only when replace is requested", () => {
    configureSkillFolder();
    fakes.findSkill.mockReturnValue({ id: "skill-existing" });
    fakes.listSkillResources.mockReturnValue([{ path: "scripts/old.py" }]);
    const db = {} as Database.Database;

    expect(importSkillFolderCmd(db, ROOT, true)).toBe("skill-existing");

    expect(fakes.createSkill).not.toHaveBeenCalled();
    expect(fakes.updateSkill).toHaveBeenCalledWith(
      db,
      "skill-existing",
      "review",
      "Review contracts",
      "Review the supplied contracts.",
      "files.read",
    );
    expect(fakes.deleteSkillResource).toHaveBeenCalledWith(db, "skill-existing", "scripts/old.py");
  });

  it("refuses a fabricated missing or non-directory folder before reading it", () => {
    fakes.statSync.mockImplementation(() => { throw new Error("fabricated missing"); });

    expect(() => importSkillFolderCmd({} as Database.Database, ROOT)).toThrow(
      "Choose a skill folder containing SKILL.md.",
    );
    expect(fakes.readFileSync).not.toHaveBeenCalled();

    fakes.statSync.mockReturnValue({ isDirectory: () => false });
    expect(() => importSkillFolderCmd({} as Database.Database, ROOT)).toThrow(
      "Choose a skill folder containing SKILL.md.",
    );
    expect(fakes.readFileSync).not.toHaveBeenCalled();
  });

  it("reports a missing SKILL.md and rejects an unknown agent before importing resources", () => {
    fakes.statSync.mockReturnValue({ isDirectory: () => true });
    fakes.readFileSync.mockImplementation(() => { throw new Error("fabricated unreadable"); });

    expect(() => importSkillFolderCmd({} as Database.Database, ROOT)).toThrow(
      "That folder has no readable SKILL.md.",
    );

    configureSkillFolder(SKILL_MD.replace("files.read", "not-an-agent"));
    expect(() => importSkillFolderCmd({} as Database.Database, ROOT)).toThrow(
      /SKILL\.md names an agent no assistant has/,
    );
    expect(fakes.readdirSync).not.toHaveBeenCalled();
    expect(fakes.createSkill).not.toHaveBeenCalled();
  });

  it("rejects a malformed SKILL.md as no usable import conflict", () => {
    fakes.readFileSync.mockReturnValue("---\n: invalid yaml\n---\nBody");

    expect(skillImportConflict({} as Database.Database, ROOT)).toBeNull();
  });

  it("enforces the 250-resource folder cap before accepting a fabricated extra file", () => {
    fakes.readdirSync.mockReturnValue(
      Array.from({ length: 251 }, (_, index) => dirent(`file-${index}.txt`, "file")),
    );
    fakes.readFileSync.mockReturnValue(Buffer.from("x"));

    expect(() => collectFolderFiles(ROOT, ROOT, [], { value: 0 })).toThrow(
      "That skill folder is too large (250 files / 128 MB maximum).",
    );
  });

  it("removes a half-created import without masking its resource-write failure", () => {
    configureSkillFolder();
    fakes.upsertSkillResource.mockImplementation(() => {
      throw new Error("fabricated resource write failure");
    });
    fakes.deleteSkill.mockImplementation(() => {
      throw new Error("fabricated rollback delete failure");
    });

    expect(() => importSkillFolderCmd({} as Database.Database, ROOT)).toThrow(
      "fabricated resource write failure",
    );
    expect(fakes.deleteSkill).toHaveBeenCalledWith({}, "skill-new");
  });
});
