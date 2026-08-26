import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyRuntimeAssets, RUNTIME_ASSETS } from "./copyRuntimeAssets.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("copyRuntimeAssets", () => {
  it("copies every runtime asset to the same path under the package output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-runtime-assets-"));
    roots.push(root);
    const sourceRoot = path.join(root, "source");
    const outputRoot = path.join(root, "output");

    for (const [index, parts] of RUNTIME_ASSETS.entries()) {
      const source = path.join(sourceRoot, ...parts);
      await mkdir(path.dirname(source), { recursive: true });
      await writeFile(source, `asset-${index}`, "utf8");
    }

    await copyRuntimeAssets({ sourceRoot, outputRoot });

    for (const [index, parts] of RUNTIME_ASSETS.entries()) {
      const destination = path.join(outputRoot, ...parts);
      await access(destination);
      expect(await readFile(destination, "utf8")).toBe(`asset-${index}`);
    }
  });
});
