import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillSummary } from "../api";
import type { WSState } from "./state";

const transport = vi.hoisted(() => ({ listSkills: vi.fn() }));

vi.mock("../api", () => ({ api: transport }));

import { makeSkillActions } from "./skillActions";

function skill(id: string): SkillSummary {
  return {
    agent: "",
    createdAt: "2026-09-01T00:00:00.000Z",
    createdBy: "user",
    description: `${id} description`,
    enabled: true,
    id,
    name: id,
    resourceCount: 0,
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

type FakeState = {
  calls: string[];
  selectedSkillId: string | null;
  setArea: ReturnType<typeof vi.fn>;
  setOpenFile: ReturnType<typeof vi.fn>;
  setSelectedSkillId: ReturnType<typeof vi.fn>;
  setSkills: ReturnType<typeof vi.fn>;
};

function state(selectedSkillId: string | null = null): FakeState {
  const calls: string[] = [];
  return {
    calls,
    selectedSkillId,
    setArea: vi.fn(() => calls.push("area")),
    setOpenFile: vi.fn(() => calls.push("file")),
    setSelectedSkillId: vi.fn(() => calls.push("selected")),
    setSkills: vi.fn(),
  };
}

beforeEach(() => {
  transport.listSkills.mockReset();
});

describe("skill actions with a fabricated API", () => {
  it("refreshes the visible skill metadata while retaining a still-present selection", async () => {
    const current = state("writing");
    const skills = [skill("writing"), skill("research")];
    transport.listSkills.mockResolvedValueOnce(skills);

    await makeSkillActions(current as unknown as WSState).refreshSkills();

    expect(transport.listSkills).toHaveBeenCalledOnce();
    expect(current.setSkills).toHaveBeenCalledWith(skills);
    expect(current.setSelectedSkillId).not.toHaveBeenCalled();
  });

  it("clears a selection that disappeared from the refreshed metadata", async () => {
    const current = state("removed-skill");
    transport.listSkills.mockResolvedValueOnce([skill("writing")]);

    await makeSkillActions(current as unknown as WSState).refreshSkills();

    expect(current.setSkills).toHaveBeenCalledWith([skill("writing")]);
    expect(current.setSelectedSkillId).toHaveBeenCalledWith(null);
  });

  it("keeps the existing skill state when a refresh races a room transition", async () => {
    const current = state("writing");
    transport.listSkills.mockRejectedValueOnce(new Error("room closed"));

    await makeSkillActions(current as unknown as WSState).refreshSkills();

    expect(current.setSkills).not.toHaveBeenCalled();
    expect(current.setSelectedSkillId).not.toHaveBeenCalled();
  });

  it("opens a skill by clearing a file selection and moving to the skills area", () => {
    const current = state();

    makeSkillActions(current as unknown as WSState).openSkill("research");

    expect(current.setOpenFile).toHaveBeenCalledWith(null);
    expect(current.setSelectedSkillId).toHaveBeenCalledWith("research");
    expect(current.setArea).toHaveBeenCalledWith("skills");
    expect(current.calls).toEqual(["file", "selected", "area"]);
  });
});
