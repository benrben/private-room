import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function copyRenderer({ sourceDir, outputDir }) {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(path.dirname(outputDir), { recursive: true });
  await cp(sourceDir, outputDir, { recursive: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = path.resolve(appRoot, "..", "..");
  await copyRenderer({
    sourceDir: path.join(repoRoot, "dist"),
    outputDir: path.join(appRoot, "dist_package", "renderer"),
  });
  console.log("Copied the Vite renderer into dist_package/renderer/.");
}
