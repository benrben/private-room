import { describe, expect, it } from "vitest";
import {
  claudeAgentDefinitions,
  codexAgentInstructions,
  loadAgentManifest,
  parseManifest,
} from "./agentManifest.js";

function validManifest() {
  return {
    version: 1,
    defaults: {
      timeoutSeconds: 30,
      maxRounds: 4,
      privacy: "inherit-parent",
      outputSchema: "plain-text",
      permission: "read",
    },
    agents: Array.from({ length: 16 }, (_, index) => ({
      id: `agent-${index}`,
      label: `Agent ${index}`,
      tag: "",
      graph: `shape-${index % 8}`,
      instructions: `Instructions ${index}`,
      tools: index === 0 ? [] : [`tool-${index}`],
      permission: index % 2 === 0 ? "read" : "write",
      capability: "tool-calling",
    })),
  };
}

describe("shared agent manifest generators", () => {
  it("generates all sixteen Claude subagents with read/write restrictions", () => {
    const manifest = loadAgentManifest();
    const definitions = claudeAgentDefinitions(manifest);
    expect(Object.keys(definitions)).toHaveLength(16);
    expect(Object.keys(definitions)).toContain("files-read");
    expect(definitions["files-read"]?.tools).toContain("mcp__room__organize_files");
    expect(definitions["files-read"]?.tools).toContain("Write");
    expect(definitions["chat-web"]?.disallowedTools).toContain("Write");
    expect(definitions["chat-web"]?.disallowedTools).toContain("Bash");
  });

  it("generates the Codex collaboration catalog from the same source", () => {
    const instructions = codexAgentInstructions();
    expect(instructions).toContain("files.read (File agent; write; graph=react_verify");
    expect(instructions).toContain("chat.web (Web agent; read; graph=chain_stage");
    expect(instructions.match(/^- /gm)).toHaveLength(16);
    expect(instructions).toContain("Serialize specialists that can write");
  });

  it("rejects malformed manifests before any agent could be started", () => {
    expect(() => parseManifest(null)).toThrow("Agent manifest must be an object.");
    expect(() => parseManifest({ version: 2, agents: [] })).toThrow("Unsupported agent manifest version.");
    expect(() => parseManifest({ version: 1, agents: [] })).toThrow("Agent manifest defaults are missing.");

    const invalidEntry = validManifest();
    invalidEntry.agents[0] = null as never;
    expect(() => parseManifest(invalidEntry)).toThrow("Agent manifest entry 0 is invalid.");

    const duplicate = validManifest();
    duplicate.agents[1]!.id = duplicate.agents[0]!.id;
    expect(() => parseManifest(duplicate)).toThrow("Agent manifest contains duplicate id agent-0.");

    const invalidTool = validManifest();
    invalidTool.agents[0]!.tools = [""];
    expect(() => parseManifest(invalidTool)).toThrow("Agent manifest tools for agent-0 are invalid.");

    const invalidPermission = validManifest();
    invalidPermission.agents[0]!.permission = "admin";
    expect(() => parseManifest(invalidPermission)).toThrow("Agent manifest permission for agent-0 is invalid.");

    const invalidLabel = validManifest();
    invalidLabel.agents[0]!.label = "  ";
    expect(() => parseManifest(invalidLabel)).toThrow("Agent manifest agent-0.label is invalid.");

    const unsupportedCatalog = validManifest();
    unsupportedCatalog.agents = unsupportedCatalog.agents.slice(0, 1);
    expect(() => parseManifest(unsupportedCatalog)).toThrow(
      "Agent manifest must contain the supported sixteen specialists and eight graph shapes.",
    );

    const invalidDefaultPermission = validManifest();
    invalidDefaultPermission.defaults.permission = "admin";
    expect(() => parseManifest(invalidDefaultPermission)).toThrow(
      "Agent manifest default permission is invalid.",
    );
  });
});
