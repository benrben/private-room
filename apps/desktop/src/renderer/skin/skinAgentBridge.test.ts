import { beforeEach, describe, expect, it } from "vitest";
import { handleSkinAgentRequest } from "./skinAgentBridge";
import { resetSkinWorkspace, setAgentMaySave, setSkinMode } from "./skinStore";

beforeEach(() => resetSkinWorkspace());

describe("Design agent skin bridge", () => {
  it("requires a fresh revision, writes only a draft, and cannot save without permission", () => {
    const initial = handleSkinAgentRequest("skin_read", {});
    expect(initial).toMatchObject({ revision: 0, mode: "together", agent_can_edit: true, agent_can_save: false });

    expect(handleSkinAgentRequest("skin_update", {
      expected_revision: 9,
      label: "Stale proposal",
      patch: { shape: { radius: 14 } },
    })).toMatchObject({ code: "revision_conflict", current_revision: 0 });

    expect(handleSkinAgentRequest("skin_update", {
      expected_revision: 0,
      label: "Softer corners",
      patch: { shape: { radius: 14 } },
    })).toMatchObject({ updated: true, revision: 1, dirty: true });

    expect(handleSkinAgentRequest("skin_save", {
      expected_revision: 1,
      name: "Agent proposal",
    })).toMatchObject({ code: "save_not_allowed" });
  });

  it("rejects fields outside the skin schema", () => {
    expect(handleSkinAgentRequest("skin_update", {
      expected_revision: 1,
      label: "Unsafe",
      patch: { arbitraryCss: "body { display: none }" },
    })).toMatchObject({ error: expect.stringContaining("unknown field") });
  });

  it("validates and undoes proposals through the same revision guard", () => {
    expect(handleSkinAgentRequest("skin_validate", {})).toMatchObject({ valid: true, revision: 0 });
    expect(handleSkinAgentRequest("skin_update", {
      expected_revision: 0,
      label: "Unreadable",
      patch: { typography: { bodySize: 2 } },
    })).toMatchObject({ code: "invalid_skin", issues: expect.any(Array) });
    expect(handleSkinAgentRequest("skin_update", {
      expected_revision: 0,
      label: "Dense",
      patch: { spacing: { scale: 0.9 } },
    })).toMatchObject({ updated: true, label: "Dense", revision: 1 });
    expect(handleSkinAgentRequest("skin_read", {})).toMatchObject({
      revision: 1,
      recent_changes: [{ actor: "agent", label: "Dense", revision: 1 }],
    });
    expect(handleSkinAgentRequest("skin_undo", { expected_revision: 0 })).toMatchObject({ code: "revision_conflict" });
    expect(handleSkinAgentRequest("skin_undo", { expected_revision: 1 })).toMatchObject({ undone: true, revision: 2, dirty: false });
  });

  it("saves only with ownership, permission, valid strings, and exact integers", () => {
    expect(handleSkinAgentRequest("skin_update", { expected_revision: -1, label: "Bad", patch: {} })).toMatchObject({
      error: expect.stringContaining("non-negative integer"),
    });
    expect(handleSkinAgentRequest("skin_update", { expected_revision: 0, label: " ", patch: {} })).toMatchObject({
      error: expect.stringContaining("non-empty string"),
    });
    expect(handleSkinAgentRequest("skin_save", { expected_revision: 0, name: " " })).toMatchObject({
      error: expect.stringContaining("non-empty string"),
    });

    setSkinMode("agent");
    setAgentMaySave(true);
    expect(handleSkinAgentRequest("skin_update", {
      expected_revision: 0,
      label: "Agent blue",
      patch: { palette: { dark: { accent: "#73a8d8" } } },
    })).toMatchObject({ updated: true, revision: 1 });
    expect(handleSkinAgentRequest("skin_save", { expected_revision: 1, name: "Agent blue" })).toMatchObject({
      saved: true,
      applied: true,
      name: "Agent blue",
    });
  });

  it("returns a stable error for a request kind from a newer host", () => {
    expect(handleSkinAgentRequest("future_skin_tool" as never, {})).toEqual({
      error: 'Unknown skin request kind "future_skin_tool".',
    });
  });

  it("reports edit ownership for every collaboration mode", () => {
    setSkinMode("user");
    expect(handleSkinAgentRequest("skin_read", {})).toMatchObject({ mode: "user", agent_can_edit: false });
    setSkinMode("agent");
    expect(handleSkinAgentRequest("skin_read", {})).toMatchObject({ mode: "agent", agent_can_edit: true });
    setSkinMode("together");
    expect(handleSkinAgentRequest("skin_read", {})).toMatchObject({ mode: "together", agent_can_edit: true });
  });
});
