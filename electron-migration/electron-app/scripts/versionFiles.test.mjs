import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkVersionFiles } from "./versionFiles.mjs";

async function writeFixtureTree(root, { electronAppVersion, rootPkgVersion, rootLockVersion, sidecarVersions }) {
  const electronApp = path.join(root, "electron-migration", "electron-app");
  await mkdir(electronApp, { recursive: true });
  await writeFile(path.join(electronApp, "package.json"), JSON.stringify({ name: "arcelle-electron", version: electronAppVersion }));
  await writeFile(
    path.join(electronApp, "package-lock.json"),
    JSON.stringify({ version: electronAppVersion, packages: { "": { version: electronAppVersion } } }),
  );
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "arcelle", version: rootPkgVersion }));
  await writeFile(
    path.join(root, "package-lock.json"),
    JSON.stringify({ version: rootLockVersion, packages: { "": { version: rootLockVersion } } }),
  );
  const sidecar = path.join(root, "sidecar");
  await mkdir(path.join(sidecar, "arcelle_sidecar"), { recursive: true });
  await writeFile(
    path.join(sidecar, "pyproject.toml"),
    `[project]\nname = "arcelle-sidecar"\nversion = "${sidecarVersions.pyproject}"\n`,
  );
  await writeFile(
    path.join(sidecar, "arcelle_sidecar", "__init__.py"),
    `__version__ = "${sidecarVersions.initPy}"\n`,
  );
  await writeFile(
    path.join(sidecar, "uv.lock"),
    `version = 1\n\n[[package]]\nname = "arcelle-sidecar"\nversion = "${sidecarVersions.uvLock}"\nsource = { editable = "." }\n\n` +
      `[[package]]\nname = "some-other-dep"\nversion = "9.9.9"\n`,
  );
}

const tmpDirs = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function makeFixture(overrides) {
  const root = await mkdtemp(path.join(os.tmpdir(), "versionfiles-a-"));
  tmpDirs.push(root);
  await writeFixtureTree(root, overrides);
  return root;
}

describe("checkVersionFiles — fixture trees", () => {
  it("reports ok:true when all six files agree with the electron-app package.json", async () => {
    const root = await makeFixture({
      electronAppVersion: "0.26.0",
      rootPkgVersion: "0.26.0",
      rootLockVersion: "0.26.0",
      sidecarVersions: { pyproject: "0.26.0", initPy: "0.26.0", uvLock: "0.26.0" },
    });
    const result = await checkVersionFiles({ repoRoot: root });
    expect(result.version).toBe("0.26.0");
    expect(result.ok).toBe(true);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    // 1 source + 2 electron-app lock keys + 1 root pkg + 2 root lock keys + 3 sidecar files = 9.
    expect(result.checks).toHaveLength(9);
  });

  it("flags EXACTLY the drifted file(s), by label, when one sidecar file is stale", async () => {
    const root = await makeFixture({
      electronAppVersion: "0.26.0",
      rootPkgVersion: "0.26.0",
      rootLockVersion: "0.26.0",
      sidecarVersions: { pyproject: "0.26.0", initPy: "0.25.0", uvLock: "0.26.0" },
    });
    const result = await checkVersionFiles({ repoRoot: root });
    expect(result.ok).toBe(false);
    const bad = result.checks.filter((c) => !c.ok);
    expect(bad).toHaveLength(1);
    expect(bad[0].label).toContain("__init__.py");
    expect(bad[0].found).toBe("0.25.0");
  });

  it("reproduces the exact v0.14.0-class incident: root package-lock.json .version and .packages[\"\"].version can independently drift", async () => {
    const root = await makeFixture({
      electronAppVersion: "0.26.0",
      rootPkgVersion: "0.26.0",
      rootLockVersion: "0.26.0",
      sidecarVersions: { pyproject: "0.26.0", initPy: "0.26.0", uvLock: "0.26.0" },
    });
    // Botch just .packages[""].version, leaving top-level .version correct --
    // this is exactly why preflight.sh's own lock_version() pattern and this
    // port both read BOTH keys rather than trusting one to imply the other.
    await writeFile(
      path.join(root, "package-lock.json"),
      JSON.stringify({ version: "0.26.0", packages: { "": { version: "0.20.0" } } }),
    );
    const result = await checkVersionFiles({ repoRoot: root });
    expect(result.ok).toBe(false);
    const bad = result.checks.filter((c) => !c.ok);
    expect(bad).toHaveLength(1);
    expect(bad[0].label).toContain('.packages[""].version');
  });

  it("treats a missing file as a failed check (found: null), not a thrown error", async () => {
    const root = await makeFixture({
      electronAppVersion: "0.26.0",
      rootPkgVersion: "0.26.0",
      rootLockVersion: "0.26.0",
      sidecarVersions: { pyproject: "0.26.0", initPy: "0.26.0", uvLock: "0.26.0" },
    });
    await rm(path.join(root, "sidecar", "uv.lock"));
    const result = await checkVersionFiles({ repoRoot: root });
    expect(result.ok).toBe(false);
    const uvLockCheck = result.checks.find((c) => c.label.includes("uv.lock"));
    expect(uvLockCheck.found).toBeNull();
    expect(uvLockCheck.ok).toBe(false);
  });
});

describe("checkVersionFiles — live repo", () => {
  // Not a fixture: this runs against the actual working tree, the same way
  // the packaging preflight does. The interrupted migration left the
  // Electron workspace and root lockfile behind at older versions; those
  // files are now part of the enforced agreement rather than documented debt.
  const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

  it("keeps every Electron-era version file in agreement", async () => {
    const result = await checkVersionFiles({ repoRoot });
    expect(result.version).toBe("0.25.0");
    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.found === "0.25.0")).toBe(true);
  });
});
