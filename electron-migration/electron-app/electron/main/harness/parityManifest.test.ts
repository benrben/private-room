import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type ParityStatus = "implemented" | "partial" | "missing" | "not-applicable";

interface ParityCell {
  status: ParityStatus;
  evidence: string[];
  gap?: string;
}

interface ParityManifest {
  version: number;
  statuses: ParityStatus[];
  providers: string[];
  features: Record<string, Record<string, ParityCell>>;
}

interface AgentManifest {
  version: number;
  agents: Array<{ id: string; graph: string }>;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const parity = JSON.parse(
  readFileSync(path.join(repoRoot, "config", "workspace-harness-parity.json"), "utf8"),
) as ParityManifest;
const agents = JSON.parse(
  readFileSync(path.join(repoRoot, "config", "agent-manifest.json"), "utf8"),
) as AgentManifest;

describe("workspace harness parity manifest", () => {
  it("covers every target provider for every feature", () => {
    expect(parity.version).toBe(1);
    expect(parity.providers).toEqual(["codex", "claude", "ollama-local", "ollama-cloud", "openrouter"]);
    for (const [feature, cells] of Object.entries(parity.features)) {
      expect(Object.keys(cells).sort(), feature).toEqual([...parity.providers].sort());
      for (const [provider, cell] of Object.entries(cells)) {
        expect(parity.statuses, `${feature}/${provider}`).toContain(cell.status);
        expect(cell.evidence.length, `${feature}/${provider}`).toBeGreaterThan(0);
        for (const evidence of cell.evidence) {
          expect(existsSync(path.join(repoRoot, evidence)), `${feature}/${provider}: ${evidence}`).toBe(true);
        }
        if (cell.status === "partial" || cell.status === "missing") {
          expect(cell.gap?.trim(), `${feature}/${provider}`).not.toBe("");
        }
      }
    }
  });

  it("pins the shared manifest at sixteen specialists and eight graph shapes", () => {
    expect(agents.version).toBe(1);
    expect(agents.agents).toHaveLength(16);
    expect(new Set(agents.agents.map((agent) => agent.id)).size).toBe(16);
    expect(new Set(agents.agents.map((agent) => agent.graph)).size).toBe(8);
  });
});
