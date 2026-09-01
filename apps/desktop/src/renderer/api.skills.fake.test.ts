import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("./platform", () => bridge);

import { api } from "./api";

beforeEach(() => {
  bridge.invoke.mockReset();
  bridge.listen.mockReset();
  bridge.open.mockReset();
  bridge.save.mockReset();
});

describe("skill API IPC wrappers", () => {
  it("creates a fabricated skill with its explicit agent binding", async () => {
    bridge.invoke.mockResolvedValueOnce("skill-created");

    await expect(api.createSkill("Research", "Find sources", "Cite primary material.", "chat.web"))
      .resolves.toBe("skill-created");

    expect(bridge.invoke).toHaveBeenCalledWith("create_skill", {
      name: "Research",
      description: "Find sources",
      instructions: "Cite primary material.",
      agent: "chat.web",
    });
  });

  it("serializes an omitted fabricated create binding as null", async () => {
    bridge.invoke.mockResolvedValueOnce("skill-general");

    await api.createSkill("General", "Reusable", "Use checked facts.");

    expect(bridge.invoke).toHaveBeenCalledWith("create_skill", {
      name: "General",
      description: "Reusable",
      instructions: "Use checked facts.",
      agent: null,
    });
  });

  it("preserves a fabricated create IPC failure", async () => {
    const failure = new Error("fabricated skill save failure");
    bridge.invoke.mockRejectedValueOnce(failure);

    await expect(api.createSkill("Broken", "No save", "Do not persist.")).rejects.toBe(failure);
  });

  it("updates a fabricated skill with its explicit agent binding", async () => {
    bridge.invoke.mockResolvedValueOnce(undefined);

    await api.updateSkill("skill-1", "Updated", "More precise", "Keep citations.", "files.read");

    expect(bridge.invoke).toHaveBeenCalledWith("update_skill", {
      id: "skill-1",
      name: "Updated",
      description: "More precise",
      instructions: "Keep citations.",
      agent: "files.read",
    });
  });

  it("serializes an omitted fabricated update binding as null", async () => {
    bridge.invoke.mockResolvedValueOnce(undefined);

    await api.updateSkill("skill-2", "Existing", "Unchanged binding", "Keep behavior.");

    expect(bridge.invoke).toHaveBeenCalledWith("update_skill", {
      id: "skill-2",
      name: "Existing",
      description: "Unchanged binding",
      instructions: "Keep behavior.",
      agent: null,
    });
  });

  it("forwards fabricated skill enablement", async () => {
    bridge.invoke.mockResolvedValueOnce(undefined);

    await api.setSkillEnabled("skill-3", false);

    expect(bridge.invoke).toHaveBeenCalledWith("set_skill_enabled", { id: "skill-3", enabled: false });
  });

  it("forwards fabricated skill deletion", async () => {
    bridge.invoke.mockResolvedValueOnce(undefined);

    await api.deleteSkill("skill-4");

    expect(bridge.invoke).toHaveBeenCalledWith("delete_skill", { id: "skill-4" });
  });

  it("reads fabricated bundles and resources without transforming their IPC payload", async () => {
    const bundle = { skill: { id: "skill-5" } };
    const resource = { text: "fabricated content" };
    bridge.invoke.mockResolvedValueOnce(bundle).mockResolvedValueOnce(resource);

    await expect(api.getSkill("skill-5")).resolves.toBe(bundle);
    await expect(api.getSkillResource("skill-5", "references/policy.md")).resolves.toBe(resource);

    expect(bridge.invoke).toHaveBeenNthCalledWith(1, "get_skill", { id: "skill-5" });
    expect(bridge.invoke).toHaveBeenNthCalledWith(2, "get_skill_resource", {
      skillId: "skill-5",
      path: "references/policy.md",
    });
  });

  it("writes fabricated text and binary resource variants with explicit null counterparts", async () => {
    bridge.invoke.mockResolvedValue(undefined);

    await api.saveSkillResource("skill-6", "references/guide.md", { text: "fabricated guide" });
    await api.saveSkillResource("skill-6", "assets/icon.bin", { dataB64: "ZmFrZQ==" });
    await api.deleteSkillResource("skill-6", "assets/old.bin");

    expect(bridge.invoke).toHaveBeenNthCalledWith(1, "save_skill_resource", {
      skillId: "skill-6", path: "references/guide.md", text: "fabricated guide", dataB64: null,
    });
    expect(bridge.invoke).toHaveBeenNthCalledWith(2, "save_skill_resource", {
      skillId: "skill-6", path: "assets/icon.bin", text: null, dataB64: "ZmFrZQ==",
    });
    expect(bridge.invoke).toHaveBeenNthCalledWith(3, "delete_skill_resource", {
      skillId: "skill-6", path: "assets/old.bin",
    });
  });

  it("uses the fabricated import replacement default and passes an explicit replacement", async () => {
    bridge.invoke.mockResolvedValueOnce("import-1").mockResolvedValueOnce("import-2");

    await api.importSkillFolder("/fabricated/skill");
    await api.importSkillFolder("/fabricated/replacement", true);

    expect(bridge.invoke).toHaveBeenNthCalledWith(1, "import_skill_folder", {
      path: "/fabricated/skill", replace: false,
    });
    expect(bridge.invoke).toHaveBeenNthCalledWith(2, "import_skill_folder", {
      path: "/fabricated/replacement", replace: true,
    });
  });

  it("forwards fabricated conflict, agent roster, export, and composition requests", async () => {
    bridge.invoke
      .mockResolvedValueOnce("existing-skill")
      .mockResolvedValueOnce(["chat.web", "files.read"])
      .mockResolvedValueOnce("/fabricated/export")
      .mockResolvedValueOnce("composed-default")
      .mockResolvedValueOnce("composed-refs");

    await api.skillImportConflict("/fabricated/skill");
    await api.skillAgentIds();
    await api.exportSkillFolder("skill-7", "/fabricated/export");
    await api.composeSkill("Draft a reusable guide");
    await api.composeSkill("Draft with source", ["file-1"]);

    expect(bridge.invoke).toHaveBeenNthCalledWith(1, "skill_import_conflict", { path: "/fabricated/skill" });
    expect(bridge.invoke).toHaveBeenNthCalledWith(2, "skill_agent_ids");
    expect(bridge.invoke).toHaveBeenNthCalledWith(3, "export_skill_folder", {
      id: "skill-7", destination: "/fabricated/export",
    });
    expect(bridge.invoke).toHaveBeenNthCalledWith(4, "compose_skill", {
      description: "Draft a reusable guide", fileIds: [],
    });
    expect(bridge.invoke).toHaveBeenNthCalledWith(5, "compose_skill", {
      description: "Draft with source", fileIds: ["file-1"],
    });
  });
});
