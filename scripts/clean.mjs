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
  ".artifacts",
  "apps/desktop/dist",
  "apps/desktop/dist_main",
  "services/agent-sidecar/dist",
  "services/agent-sidecar/build",
  "services/agent-sidecar/.build-venv",
  "services/agent-sidecar/.pytest_cache",
  "services/agent-sidecar/.mypy_cache",
  "services/agent-sidecar/.ruff_cache",
  "services/agent-sidecar/src/arcelle_sidecar.egg-info",
  "services/agent-sidecar/privateroom_sidecar.egg-info",
  "apps/desktop/dist_a",
  "apps/desktop/dist_b",
  "apps/desktop/dist_boot",
  "apps/desktop/dist_boot_a",
  "apps/desktop/dist_boot_b",
  "apps/desktop/dist_renderer",
  "apps/desktop/dist_pkg_a",
  "apps/desktop/dist_pkg_b",
  "apps/desktop/dist_package",
  "apps/desktop/pkgout_a",
  "apps/desktop/release",
  "apps/desktop/release_b",
  "apps/desktop/release_b_proof2",
  "apps/desktop/release_b_proof3",
  "apps/desktop/build_b",
  "apps/desktop/resources_b",
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
