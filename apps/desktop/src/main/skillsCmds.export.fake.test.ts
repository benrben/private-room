import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

const fakes = vi.hoisted(() => ({
  fs: {
    chmodSync: vi.fn(),
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(),
    rmSync: vi.fn(),
    statSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
  executeScriptInWorkspace: vi.fn(),
  files: {
    findFileLike: vi.fn(),
    getFileExtractedText: vi.fn(),
    getFileMeta: vi.fn(),
  },
  skills: {
    createSkill: vi.fn(),
    deleteSkill: vi.fn(),
    deleteSkillResource: vi.fn(),
    findSkill: vi.fn(),
    getSkill: vi.fn(),
    getSkillResource: vi.fn(),
    listSkillResources: vi.fn(),
    listSkills: vi.fn(),
    setSkillEnabled: vi.fn(),
    updateSkill: vi.fn(),
    upsertSkillResource: vi.fn(),
  },
}));

vi.mock("node:fs", () => fakes.fs);
vi.mock("./db-host/skills.js", () => ({
  ...fakes.skills,
  SKILL_GONE: "That skill no longer exists.",
}));
vi.mock("./db-host/files.js", () => fakes.files);
vi.mock("./scriptRun.js", () => ({
  executeScriptInWorkspace: fakes.executeScriptInWorkspace,
}));
vi.mock("./scriptConsent.js", () => ({
  approveScriptBytes: vi.fn(),
}));
vi.mock("./mcpConfig.js", () => ({ DELETE_DECLINED: "Deletion was declined." }));
vi.mock("./toolSpecs.js", () => ({ SKILL_AGENT_IDS: [] }));
vi.mock("./engineRouting.js", () => ({ listModels: vi.fn() }));
vi.mock("./gatherContext.js", () => ({ modelSetting: vi.fn() }));
vi.mock("./ollamaGenerate.js", () => ({ recoverJson: vi.fn() }));
vi.mock("./workflowModel.js", () => ({ defaultResolvedModel: vi.fn() }));
vi.mock("./workflowCompose.js", () => ({
  generateTextAnyEngine: vi.fn(),
  withRealOllamaGenerate: vi.fn(),
}));

import { agentRunSkillScript, agentSaveSkill, exportSkillFolderCmd } from "./skillsCmds.js";

const db = {} as Database.Database;
const destination = "/fake/skill-exports";

function arrangeExport(resources: Array<{ path: string; content: Buffer }> = []): void {
  fakes.skills.getSkill.mockReturnValue({
    id: "skill-1",
    name: "review-contracts",
    description: "Review contract terms",
    instructions: "Read the policy before responding.",
    enabled: true,
    createdBy: "human",
    agent: "files.read",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  });
  fakes.skills.listSkillResources.mockReturnValue(
    resources.map((resource, index) => ({
      id: `resource-${index}`,
      skillId: "skill-1",
      kind: "reference",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      ...resource,
    }))
  );
  fakes.fs.statSync.mockReturnValue({ isDirectory: () => true });
  fakes.fs.existsSync.mockReturnValue(false);
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("exportSkillFolderCmd", () => {
  it("writes a portable skill document and each nested resource to the selected fake destination", () => {
    arrangeExport([
      { path: "references/policy.md", content: Buffer.from("Policy text") },
      { path: "assets/logo.bin", content: Buffer.from([1, 2, 3]) },
    ]);

    const root = exportSkillFolderCmd(db, "skill-1", destination);

    expect(root).toBe(path.join(destination, "review-contracts"));
    expect(fakes.fs.mkdirSync).toHaveBeenNthCalledWith(1, root);
    expect(fakes.fs.writeFileSync).toHaveBeenNthCalledWith(
      1,
      path.join(root, "SKILL.md"),
      expect.stringContaining("agent: files.read\n")
    );
    expect(fakes.fs.writeFileSync).toHaveBeenNthCalledWith(
      2,
      path.join(root, "references", "policy.md"),
      Buffer.from("Policy text")
    );
    expect(fakes.fs.writeFileSync).toHaveBeenNthCalledWith(
      3,
      path.join(root, "assets", "logo.bin"),
      Buffer.from([1, 2, 3])
    );
    expect(fakes.fs.mkdirSync).toHaveBeenCalledWith(path.join(root, "references"), { recursive: true });
    expect(fakes.fs.mkdirSync).toHaveBeenCalledWith(path.join(root, "assets"), { recursive: true });
    expect(fakes.fs.rmSync).not.toHaveBeenCalled();
  });

  it("refuses missing, non-directory, and occupied fake destinations without creating a skill folder", () => {
    arrangeExport();
    fakes.fs.statSync.mockImplementation(() => {
      throw new Error("missing");
    });
    expect(() => exportSkillFolderCmd(db, "skill-1", destination)).toThrow("Choose an existing destination folder.");

    fakes.fs.statSync.mockReturnValue({ isDirectory: () => false });
    expect(() => exportSkillFolderCmd(db, "skill-1", destination)).toThrow("Choose an existing destination folder.");

    fakes.fs.statSync.mockReturnValue({ isDirectory: () => true });
    fakes.fs.existsSync.mockReturnValue(true);
    expect(() => exportSkillFolderCmd(db, "skill-1", destination)).toThrow(
      'A folder named "review-contracts" already exists there.'
    );
    expect(fakes.fs.mkdirSync).not.toHaveBeenCalled();
    expect(fakes.fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("detects stored file-folder collisions before it creates the export root", () => {
    arrangeExport([
      { path: "references", content: Buffer.from("not a directory") },
      { path: "references/policy.md", content: Buffer.from("policy") },
    ]);

    expect(() => exportSkillFolderCmd(db, "skill-1", destination)).toThrow("cannot share a name");

    expect(fakes.fs.mkdirSync).not.toHaveBeenCalled();
    expect(fakes.fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("removes the newly created fake folder and preserves the write failure", () => {
    arrangeExport();
    const failure = new Error("fake disk refused the skill document");
    fakes.fs.writeFileSync.mockImplementation(() => {
      throw failure;
    });
    const root = path.join(destination, "review-contracts");

    expect(() => exportSkillFolderCmd(db, "skill-1", destination)).toThrow(failure);

    expect(fakes.fs.rmSync).toHaveBeenCalledWith(root, { recursive: true, force: true });
  });
});

describe("agent skill failure cleanup with fabricated boundaries", () => {
  it("removes a half-created sourced skill and preserves the resource failure", () => {
    fakes.skills.findSkill.mockReturnValue(null);
    fakes.skills.createSkill.mockReturnValue("agent-skill-id");
    fakes.files.findFileLike.mockReturnValue(["source-id", "source.md"]);
    fakes.files.getFileMeta.mockReturnValue({ id: "source-id", name: "source.md", mimeType: "text/markdown" });
    fakes.files.getFileExtractedText.mockReturnValue("source text");
    fakes.skills.upsertSkillResource.mockImplementation(() => {
      throw new Error("fabricated source save failure");
    });
    fakes.skills.deleteSkill.mockImplementation(() => {
      throw new Error("fabricated cleanup failure");
    });

    expect(() => agentSaveSkill(db, {
      name: "sourced-skill",
      description: "Description",
      instructions: "Use the source.",
      source_files: ["source.md"],
    })).toThrow("fabricated source save failure");
    expect(fakes.skills.deleteSkill).toHaveBeenCalledWith(db, "agent-skill-id");
  });

  it("ignores orphan sweep and final cleanup failures around a successful fabricated script", async () => {
    fakes.skills.findSkill.mockReturnValue({ id: "skill-1", name: "runner", enabled: true });
    fakes.skills.listSkillResources.mockReturnValue([{
      id: "resource-1",
      skillId: "skill-1",
      path: "scripts/run.js",
      kind: "script",
      content: Buffer.from("console.log('fake')"),
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    }]);
    fakes.fs.readdirSync.mockReturnValue(["orphan-run"]);
    fakes.fs.rmSync.mockImplementation(() => {
      throw new Error("fabricated cleanup refusal");
    });
    fakes.executeScriptInWorkspace.mockResolvedValue({
      exitCode: 0,
      stdoutTail: "fabricated output",
      stderrTail: "",
    });

    await expect(agentRunSkillScript(db, { skill: "runner", path: "scripts/run.js" }, {
      cacheDir: "/fake/cache",
      approveScriptBytes: async () => ({
        runner: { kind: "node", command: "/fake/node", args: [] } as never,
        manifest: { timeoutSecs: 10 } as never,
      }),
    })).resolves.toBe("fabricated output");
    expect(fakes.fs.rmSync).toHaveBeenCalledWith(
      "/fake/cache/skill-runs/orphan-run",
      { recursive: true, force: true },
    );
  });

  it("continues a fabricated script run when the orphan directory cannot be listed", async () => {
    fakes.skills.findSkill.mockReturnValue({ id: "skill-1", name: "runner", enabled: true });
    fakes.skills.listSkillResources.mockReturnValue([{
      id: "resource-1",
      skillId: "skill-1",
      path: "scripts/run.js",
      kind: "script",
      content: Buffer.from("console.log('fake')"),
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    }]);
    fakes.fs.readdirSync.mockImplementation(() => {
      throw new Error("fabricated directory read refusal");
    });
    fakes.executeScriptInWorkspace.mockResolvedValue({
      exitCode: 0,
      stdoutTail: "fabricated output",
      stderrTail: "",
    });

    await expect(agentRunSkillScript(db, { skill: "runner", path: "scripts/run.js" }, {
      cacheDir: "/fake/cache",
      approveScriptBytes: async () => ({
        runner: { kind: "node", command: "/fake/node", args: [] } as never,
        manifest: { timeoutSecs: 10 } as never,
      }),
    })).resolves.toBe("fabricated output");
    expect(fakes.executeScriptInWorkspace).toHaveBeenCalledOnce();
  });
});
