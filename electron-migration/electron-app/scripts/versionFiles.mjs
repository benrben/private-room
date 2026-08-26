/**
 * Version-agreement gate for the Electron application. It checks every
 * shipping version source that remains after the Tauri/Rust retirement.
 *
 * The Electron package is the source of truth because electron-builder reads
 * it as `appInfo.version`, writes it into `CFBundleShortVersionString`, and
 * exposes it through `app.getVersion()`. The repository package, Python
 * sidecar, and both lockfiles must agree with it.
 *
 * The seven version sources:
 *   1. electron-migration/electron-app/package.json .version    (SOURCE OF TRUTH)
 *   2. electron-migration/electron-app/package-lock.json .version AND .packages[""].version
 *   3. package.json .version                                    (repo root, hand-edited)
 *   4. package-lock.json .version AND .packages[""].version     (repo root, npm-written)
 *   5. sidecar/pyproject.toml [project] version                 (hand-edited)
 *   6. sidecar/arcelle_sidecar/__init__.py __version__           (hand-edited)
 *   7. sidecar/uv.lock [[package]] name = "arcelle-sidecar" -> version  (uv-written)
 *
 * The npm lockfiles each carry two version fields; both are checked so a
 * partially resolved merge cannot silently ship a mismatched version.
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";

/** Ports `preflight.sh`'s own awk one-liner for a Cargo/uv TOML `[section]`
 * `key = "value"` pair — first match under the given `[section]` header. */
function readToml(text, section, key) {
  const lines = text.split("\n");
  let inSection = false;
  for (const line of lines) {
    const sectionMatch = /^\[([^\]]+)\]/.exec(line.trim());
    if (sectionMatch) {
      inSection = sectionMatch[1] === section;
      continue;
    }
    if (!inSection) continue;
    const m = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`).exec(line.trim());
    if (m) return m[1];
  }
  return null;
}

/** Ports `preflight.sh`'s `lock_version()`: find `name = "<pkg>"` in a
 * `uv.lock` (TOML), then the `version = "..."` in the `[[package]]` table
 * that follows it. */
function readUvLockVersion(text, packageName) {
  const lines = text.split("\n");
  let found = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === `name = "${packageName}"`) {
      found = true;
      continue;
    }
    if (found) {
      const m = /^version\s*=\s*"([^"]*)"/.exec(trimmed);
      if (m) return m[1];
      // A new [[package]] boundary without hitting version = the lockfile
      // doesn't record one (unusual, but don't loop past it forever).
      if (trimmed.startsWith("[[package]]")) return null;
    }
  }
  return null;
}

async function readJsonVersion(filePath, jsonPointerFn) {
  const text = await readFile(filePath, "utf8");
  const data = JSON.parse(text);
  return jsonPointerFn(data);
}

/**
 * @param {object} opts
 * @param {string} opts.repoRoot - absolute path to the repo root (the
 *   directory containing `package.json`, `sidecar/`, `electron-migration/`).
 * @returns {Promise<{ version: string, checks: Array<{label: string, found: string|null, ok: boolean}>, ok: boolean }>}
 */
export async function checkVersionFiles({ repoRoot }) {
  const electronApp = path.join(repoRoot, "electron-migration", "electron-app");
  const source = await readJsonVersion(path.join(electronApp, "package.json"), (d) => d.version);
  if (!source) {
    throw new Error(
      `electron-migration/electron-app/package.json has no .version — cannot check anything against it`,
    );
  }

  const checks = [];
  const check = (label, found) => checks.push({ label, found: found ?? null, ok: found === source });

  check("electron-migration/electron-app/package.json (source of truth)", source);

  try {
    const lock = JSON.parse(await readFile(path.join(electronApp, "package-lock.json"), "utf8"));
    check("electron-migration/electron-app/package-lock.json .version", lock.version);
    check("electron-migration/electron-app/package-lock.json .packages[\"\"].version", lock.packages?.[""]?.version);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    check("electron-migration/electron-app/package-lock.json", null);
  }

  try {
    const rootPkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
    check("package.json (repo root)", rootPkg.version);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    check("package.json (repo root)", null);
  }

  try {
    const rootLock = JSON.parse(await readFile(path.join(repoRoot, "package-lock.json"), "utf8"));
    check("package-lock.json (repo root) .version", rootLock.version);
    check("package-lock.json (repo root) .packages[\"\"].version", rootLock.packages?.[""]?.version);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    check("package-lock.json (repo root)", null);
  }

  try {
    const pyproject = await readFile(path.join(repoRoot, "sidecar", "pyproject.toml"), "utf8");
    check("sidecar/pyproject.toml [project] version", readToml(pyproject, "project", "version"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    check("sidecar/pyproject.toml", null);
  }

  try {
    const initPy = await readFile(path.join(repoRoot, "sidecar", "arcelle_sidecar", "__init__.py"), "utf8");
    const m = /^__version__\s*=\s*"([^"]*)"/m.exec(initPy);
    check("sidecar/arcelle_sidecar/__init__.py __version__", m ? m[1] : null);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    check("sidecar/arcelle_sidecar/__init__.py", null);
  }

  try {
    const uvLock = await readFile(path.join(repoRoot, "sidecar", "uv.lock"), "utf8");
    check("sidecar/uv.lock [[package]] arcelle-sidecar", readUvLockVersion(uvLock, "arcelle-sidecar"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    check("sidecar/uv.lock", null);
  }

  return { version: source, checks, ok: checks.every((c) => c.ok) };
}

// CLI: node versionFiles.mjs [repoRoot]
if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "..", "..", ".."));
  const { version, checks, ok } = await checkVersionFiles({ repoRoot });
  console.log(`Version agreement (source: electron-app package.json = ${version})`);
  for (const c of checks) {
    const mark = c.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`  ${mark} ${c.label} — ${c.found ?? "<not found>"}`);
  }
  process.exit(ok ? 0 : 1);
}
