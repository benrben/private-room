#!/usr/bin/env node

/**
 * Remove reproducible build and test output without touching dependencies,
 * packaged model weights, source fixtures, or developer configuration.
 *
 * Use `npm run clean:dry-run` to inspect the exact targets first.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

const generatedPaths = [
  "dist",
  "sidecar/dist",
  "sidecar/build",
  "sidecar/.build-venv",
  "sidecar/.pytest_cache",
  "sidecar/.mypy_cache",
  "sidecar/.ruff_cache",
  "sidecar/arcelle_sidecar.egg-info",
  "sidecar/privateroom_sidecar.egg-info",
  "electron-migration/electron-app/dist_a",
  "electron-migration/electron-app/dist_b",
  "electron-migration/electron-app/dist_boot",
  "electron-migration/electron-app/dist_boot_a",
  "electron-migration/electron-app/dist_boot_b",
  "electron-migration/electron-app/dist_renderer",
  "electron-migration/electron-app/dist_pkg_a",
  "electron-migration/electron-app/dist_pkg_b",
  "electron-migration/electron-app/dist_package",
  "electron-migration/electron-app/pkgout_a",
  "electron-migration/electron-app/release",
  "electron-migration/electron-app/release_b",
  "electron-migration/electron-app/release_b_proof2",
  "electron-migration/electron-app/release_b_proof3",
  "electron-migration/electron-app/build_b",
  "electron-migration/electron-app/resources_b",
  "electron-migration/spikes/s3-metal-wheel/venv",
  "pm-request/_stage",
  ".pytest_cache",
  ".ruff_cache",
];

const excludedDirectoryNames = new Set([
  ".build-venv",
  ".git",
  ".venv",
  "node_modules",
  "venv",
]);
const transientDirectoryNames = new Set([
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);

const targets = new Set(
  generatedPaths
    .map((relativePath) => path.join(repoRoot, relativePath))
    .filter(existsSync),
);

function discoverTransientFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (targets.has(absolutePath)) continue;
      if (excludedDirectoryNames.has(entry.name)) continue;
      if (transientDirectoryNames.has(entry.name)) {
        targets.add(absolutePath);
        continue;
      }
      discoverTransientFiles(absolutePath);
    } else if (entry.name === ".DS_Store") {
      targets.add(absolutePath);
    }
  }
}

discoverTransientFiles(repoRoot);

const orderedTargets = [...targets].sort((a, b) => a.localeCompare(b));
for (const target of orderedTargets) {
  console.log(`${dryRun ? "would remove" : "removed"} ${path.relative(repoRoot, target)}`);
  if (!dryRun) rmSync(target, { recursive: true, force: true });
}

console.log(
  `${dryRun ? "Dry run:" : "Cleaned"} ${orderedTargets.length} generated or transient path${orderedTargets.length === 1 ? "" : "s"}.`,
);
