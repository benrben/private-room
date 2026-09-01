import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyRuntimeAssets,
  RUNTIME_ASSETS,
  runtimeAssetsOutputRoot,
  SHARED_RUNTIME_ASSETS,
} from "./copyRuntimeAssets.mjs";
import { PAGE_SCRIPT_FILES } from "../src/main/browser/pageScript.ts";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("copyRuntimeAssets", () => {
  it("packages every browser preload fragment registered by the main process", () => {
    const packagedPageScripts = RUNTIME_ASSETS
      .filter((parts) => parts[0] === "src" && parts[1] === "main" && parts[2] === "browser")
      .map((parts) => parts.at(-1));

    expect(packagedPageScripts).toEqual(PAGE_SCRIPT_FILES);
  });

  it("targets the compiled-main runtime tree when a test build asks for it", () => {
    expect(runtimeAssetsOutputRoot("/app", ["--output-root", "dist_main"])).toBe("/app/dist_main");
    expect(runtimeAssetsOutputRoot("/app", [])).toBe("/app/dist_package");
    expect(() => runtimeAssetsOutputRoot("/app", ["--output-root"])).toThrow("needs a path");
  });

  it("copies every runtime asset to the same path under the package output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-runtime-assets-"));
    roots.push(root);
    const sourceRoot = path.join(root, "electron-migration", "electron-app");
    const outputRoot = path.join(root, "output");

    for (const [index, parts] of RUNTIME_ASSETS.entries()) {
      const source = path.join(sourceRoot, ...parts);
      await mkdir(path.dirname(source), { recursive: true });
      await writeFile(source, `asset-${index}`, "utf8");
    }
    for (const [index, parts] of SHARED_RUNTIME_ASSETS.entries()) {
      const source = path.join(sourceRoot, "../..", ...parts);
      await mkdir(path.dirname(source), { recursive: true });
      await writeFile(source, `shared-${index}`, "utf8");
    }

    await copyRuntimeAssets({ sourceRoot, outputRoot });

    for (const [index, parts] of RUNTIME_ASSETS.entries()) {
      const destination = path.join(outputRoot, ...parts);
      await access(destination);
      expect(await readFile(destination, "utf8")).toBe(`asset-${index}`);
    }
    for (const [index, parts] of SHARED_RUNTIME_ASSETS.entries()) {
      const destination = path.join(outputRoot, ...parts);
      await access(destination);
      expect(await readFile(destination, "utf8")).toBe(`shared-${index}`);
    }
  });
});
