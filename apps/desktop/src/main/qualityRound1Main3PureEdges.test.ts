import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildZip } from "./editMatchZip.js";
import { extractDocx, replaceInTextNodes } from "./editMatchDocx.js";
import { parseA1 } from "./fileTools.js";
import {
  inlineIcons,
  mcpRegistryOptinFile,
  mcpRegistryOptinStatus,
  setMcpRegistryOptin,
} from "./mcpRegistry.js";
import { namesAppear } from "./storyTools.js";
import { resolveWorkspacePath } from "./workspace/pathSafety.js";
import {
  compareSemVer,
  ManifestParseError,
  parseSemVer,
  parseUpdateManifest,
} from "./updater/updateManifest.js";

describe("round-one main shard pure error paths", () => {
  it("treats an empty memory-style search and an exhausted story scan as no matches", async () => {
    expect(namesAppear("", "Mira")).toBe(false);
    expect(parseA1(`A${"9".repeat(400)}`)).toBeNull();

    const entries = [{
      id: "io.example/plain",
      title: "Plain",
      description: "No icon to fetch",
      icon: null,
      install: null,
    }];
    await expect(inlineIcons(entries)).resolves.toBeUndefined();
    expect(entries[0]?.icon).toBeNull();
  });

  it("keeps path resolution inside the canonical root", () => {
    const root = path.join(os.tmpdir(), "arcelle-main-3-root");
    expect(resolveWorkspacePath(root, "notes/today.txt")).toBe(
      path.join(root, "notes", "today.txt"),
    );
  });

  it("accepts equal prerelease identifiers and refuses a scalar platform entry", () => {
    expect(compareSemVer(parseSemVer("1.0.0-alpha"), parseSemVer("1.0.0-alpha"))).toBe(0);
    expect(() => parseUpdateManifest(
      '{"version":"1.0.0","platforms":{"darwin-aarch64":"not-an-object"}}',
    )).toThrow(ManifestParseError);
  });

  it("ignores blank optional Word parts and an all-whitespace search", () => {
    const bytes = buildZip([
      { name: "word/document.xml", data: Buffer.from("<w:p><w:t>Body</w:t></w:p>") },
      { name: "word/footnotes.xml", data: Buffer.from("<w:p><w:t>   </w:t></w:p>") },
    ]);
    const extracted = extractDocx(bytes);
    expect(extracted?.trim()).toBe("Body");
    expect(extracted).not.toContain("[footnotes]");
    expect(replaceInTextNodes("<w:p><w:t>Body</w:t></w:p>", "   ", "x")).toEqual({
      xml: "<w:p><w:t>Body</w:t></w:p>",
      count: 0,
    });
    expect(replaceInTextNodes("<w:p><w:t>Body</w:t></w:p>", "Body   ", "x")).toEqual({
      xml: "<w:p><w:t>x</w:t></w:p>",
      count: 1,
    });
  });

  it("fails closed when the registry opt-in flag cannot be read or removed", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "arcelle-main-3-registry-"));
    const notDirectory = path.join(root, "not-a-directory");
    writeFileSync(notDirectory, "x");
    const unreadableRoot = path.join(root, "unreadable-root");
    mkdirSync(mcpRegistryOptinFile(unreadableRoot), { recursive: true });

    expect(mcpRegistryOptinStatus(unreadableRoot)).toBe(false);
    writeFileSync(mcpRegistryOptinFile(root), "1");
    expect(() => setMcpRegistryOptin(notDirectory, false)).not.toThrow();
    expect(mcpRegistryOptinStatus(root)).toBe(true);
  });
});
