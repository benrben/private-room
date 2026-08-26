import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface InventoryEntry {
  path: string;
  access: string[];
  category: string;
  workspaceCurrentBytesAllowed: boolean;
  note: string;
}

interface Inventory {
  version: number;
  scope: string[];
  entries: InventoryEntry[];
  knownIndirectBlobAssumptions: Array<{ path: string; reason: string }>;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const inventoryPath = path.join(repoRoot, "config", "original-bytes-inventory.json");

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const absolute = path.join(root, name);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      if (["node_modules", "dist", "dist_boot", "dist_package", "__pycache__"].includes(name)) continue;
      out.push(...sourceFiles(absolute));
      continue;
    }
    if (name.endsWith(".test.ts") || name.endsWith(".spec.ts")) continue;
    if (!/\.(?:ts|tsx|py|sql)$/.test(name)) continue;
    out.push(absolute);
  }
  return out;
}

describe("files.original_bytes production inventory", () => {
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as Inventory;

  it("covers every production source that still names the legacy blob column", () => {
    const found = inventory.scope.flatMap((relativeRoot) =>
      sourceFiles(path.join(repoRoot, relativeRoot))
        .filter((absolute) => readFileSync(absolute, "utf8").includes("original_bytes"))
        .map((absolute) => path.relative(repoRoot, absolute)),
    ).sort();
    const declared = inventory.entries.map((entry) => entry.path).sort();
    expect(found).toEqual(declared);
  });

  it("records access type, ownership boundary and a plain-English reason", () => {
    expect(inventory.version).toBe(1);
    expect(new Set(inventory.entries.map((entry) => entry.path)).size).toBe(inventory.entries.length);
    for (const entry of inventory.entries) {
      expect(existsSync(path.join(repoRoot, entry.path)), entry.path).toBe(true);
      expect(entry.access.length, entry.path).toBeGreaterThan(0);
      expect(entry.category.trim(), entry.path).not.toBe("");
      expect(entry.note.trim(), entry.path).not.toBe("");
      expect(entry.workspaceCurrentBytesAllowed, entry.path).toBe(false);
    }
  });

  it("keeps indirect legacy-blob callers visible until their cutover is complete", () => {
    expect(inventory.knownIndirectBlobAssumptions.length).toBeGreaterThan(0);
    for (const gap of inventory.knownIndirectBlobAssumptions) {
      expect(existsSync(path.join(repoRoot, gap.path)), gap.path).toBe(true);
      expect(gap.reason.trim(), gap.path).not.toBe("");
    }
  });
});
