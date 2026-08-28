import { describe, expect, it } from "vitest";
import { claudeAgentDefinitions, codexAgentInstructions, loadAgentManifest } from "./agentManifest.js";

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
});
