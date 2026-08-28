#!/usr/bin/env node

/** Repository-organization regression gate.
 *
 * Keep this deliberately structural: it prevents obsolete migration roots,
 * duplicate npm locks/contracts, and accidental top-level build state from
 * returning without prescribing how individual feature modules are written.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IGNORED = new Set([".git", ".venv", "node_modules", ".artifacts"]);

function walk(directory, root, predicate, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, root, predicate, found);
    else if (predicate(absolute)) found.push(path.relative(root, absolute));
  }
  return found;
}

export function auditLayout(root = DEFAULT_ROOT) {
  const errors = [];
  const required = [
    "apps/desktop/package.json",
    "apps/desktop/src/main/index.ts",
    "apps/desktop/src/preload/index.ts",
    "apps/desktop/src/renderer/main.tsx",
    "apps/desktop/src/shared/apiTypes.ts",
    "services/agent-sidecar/pyproject.toml",
    "services/agent-sidecar/src/arcelle_sidecar/__init__.py",
    "tests/contract",
    "tests/e2e",
    "tests/installed",
    "tests/fixtures/sqlcipher",
    "tests/visual",
    "assets/brand",
  ];
  for (const relativePath of required) {
    if (!existsSync(path.join(root, relativePath))) errors.push(`missing ${relativePath}`);
  }

  for (const obsolete of [
    ".arcelle-app-backups",
    "electron-migration",
    "sidecar",
    "e2e",
    "qa",
    "art",
    "src",
    "public",
  ]) {
    if (existsSync(path.join(root, obsolete))) errors.push(`obsolete top-level path returned: ${obsolete}`);
  }

  const locks = walk(root, root, (absolute) => path.basename(absolute) === "package-lock.json");
  if (locks.length !== 1 || locks[0] !== "package-lock.json") {
    errors.push(`expected one root npm lockfile, found: ${locks.join(", ") || "none"}`);
  }

  const rendererContract = path.join(root, "apps/desktop/src/renderer/apiTypes.ts");
  if (existsSync(rendererContract)) {
    const shim = readFileSync(rendererContract, "utf8");
    if (!shim.includes('export * from "../shared/apiTypes"')) {
      errors.push("renderer apiTypes.ts must remain a thin re-export of the shared contract");
    }
    if (shim.split("\n").length > 12) {
      errors.push("renderer apiTypes.ts duplicated the shared contract");
    }
  }

  const obsoleteDesktopPath = ["electron-migration", "electron-app"].join("/");
  const stalePathFiles = walk(root, root, (absolute) => {
    if (!/\.(?:cjs|css|html|js|json|md|mjs|py|sh|toml|ts|tsx|yml)$/u.test(absolute)) return false;
    const text = readFileSync(absolute, "utf8");
    return text.includes(obsoleteDesktopPath);
  });
  if (stalePathFiles.length) {
    errors.push(`obsolete desktop path referenced by: ${stalePathFiles.join(", ")}`);
  }

  return errors;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const errors = auditLayout();
  if (errors.length) {
    for (const error of errors) console.error(`layout: ${error}`);
    process.exit(1);
  }
  console.log("Repository layout is canonical.");
}
