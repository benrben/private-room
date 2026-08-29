/**
 * Proves `packTarGz_a.mjs`'s output really round-trips through the REAL
 * bridge-consuming code in `src/main/updater/installBundle.ts` --
 * `extractTarGz`, `readCFBundleExecutable`, `assertBundleIdentity` -- rather
 * than asserting anything about this module's output in isolation. This is
 * the "old Tauri client / this repo's own Electron client consumes a bridge
 * release built by this candidate" contract, exercised directly, with real
 * `/usr/bin/tar` and `/usr/bin/plutil` (both real system tools; nothing here
 * signs, packages for real, or touches any secret -- see this batch's safety
 * rules).
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { packTarGz } from "./packTarGz.mjs";
import {
  assertBundleIdentity,
  defaultInstallDeps,
  extractTarGz,
  InstallError,
  readCFBundleExecutable,
} from "../src/main/updater/installBundle.js";

const execFileAsync = promisify(execFile);

const work = await fs.mkdtemp(path.join(os.tmpdir(), "packtargz-a-proof-"));
afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true });
});

/**
 * A fixture `.app` with the same interesting shape the research doc's
 * `tarprobe/` empirical run checked: an executable with the exec bit set, and
 * a `.framework`-style relative symlink chain (`Current -> A`, then the
 * framework binary symlinked THROUGH `Versions/Current`) -- the two things a
 * naive re-implementation (or a non-`portable` tar mode) could plausibly
 * mangle.
 */
async function buildFixtureApp(root, { identifier = "com.benreich.privateroom", version = "99.0.0", execName = "Arcelle" } = {}) {
  const appDir = path.join(root, "Arcelle.app");
  await fs.mkdir(path.join(appDir, "Contents", "MacOS"), { recursive: true });
  await fs.writeFile(path.join(appDir, "Contents", "MacOS", execName), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(
    path.join(appDir, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${execName}</string>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>
`,
  );

  const fwVersionsA = path.join(appDir, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A");
  await fs.mkdir(fwVersionsA, { recursive: true });
  await fs.writeFile(path.join(fwVersionsA, "Electron Framework"), "not a real Mach-O, just fixture bytes\n");
  const fwRoot = path.join(appDir, "Contents", "Frameworks", "Electron Framework.framework");
  await fs.symlink("A", path.join(fwRoot, "Versions", "Current"));
  await fs.symlink(path.join("Versions", "Current", "Electron Framework"), path.join(fwRoot, "Electron Framework"));

  return appDir;
}

describe("packTarGz_a — real tar/plutil round trip through installBundle.ts", () => {
  it("rejects a source path that doesn't name a *.app bundle", async () => {
    await expect(
      packTarGz({ appPath: path.join(work, "NotAnApp"), outFile: path.join(work, "x.tar.gz") }),
    ).rejects.toThrow(/must name a \*\.app bundle/);
  });

  it("packs a real fixture app, and the REAL installBundle.ts code accepts and installs it", async () => {
    const src = path.join(work, "clean-src");
    await fs.mkdir(src, { recursive: true });
    const appDir = await buildFixtureApp(src);
    const tarPath = path.join(work, "Arcelle.app.tar.gz");

    const written = await packTarGz({ appPath: appDir, outFile: tarPath });
    expect(written).toBe(tarPath);
    expect(fsSync.existsSync(tarPath)).toBe(true);

    const deps = defaultInstallDeps();
    const extracted = await extractTarGz(deps, tarPath);

    // Contents/MacOS post-condition, exec bit, symlinks all survived.
    const execPath = path.join(extracted, "Contents", "MacOS", "Arcelle");
    expect(fsSync.existsSync(execPath)).toBe(true);
    expect(fsSync.statSync(execPath).mode & 0o111).toBeTruthy();
    // The top-level directory component is gone: the bundle root IS `extracted`.
    expect(fsSync.existsSync(path.join(extracted, "Arcelle.app"))).toBe(false);

    const fwRoot = path.join(extracted, "Contents", "Frameworks", "Electron Framework.framework");
    const currentLink = fsSync.lstatSync(path.join(fwRoot, "Versions", "Current"));
    expect(currentLink.isSymbolicLink()).toBe(true);
    expect(fsSync.readlinkSync(path.join(fwRoot, "Versions", "Current"))).toBe("A");
    expect(fsSync.lstatSync(path.join(fwRoot, "Electron Framework")).isSymbolicLink()).toBe(true);
    // The symlink resolves through Versions/Current to real fixture bytes --
    // proves it's not just present as a dangling link but actually usable.
    expect(fsSync.readFileSync(path.join(fwRoot, "Electron Framework"), "utf8")).toContain("fixture bytes");

    expect(await readCFBundleExecutable(deps, extracted)).toBe("Arcelle");

    const identity = await assertBundleIdentity(deps, extracted, { currentVersion: "1.0.0" });
    expect(identity).toEqual({ identifier: "com.benreich.privateroom", version: "99.0.0" });
  });

  it("assertBundleIdentity rejects a payload whose signed Info.plist claims a version that is NOT newer (the downgrade-by-replay guard)", async () => {
    const src = path.join(work, "old-version-src");
    await fs.mkdir(src, { recursive: true });
    const appDir = await buildFixtureApp(src, { version: "0.1.0" });
    const tarPath = path.join(work, "old-version.tar.gz");
    await packTarGz({ appPath: appDir, outFile: tarPath });

    const deps = defaultInstallDeps();
    const extracted = await extractTarGz(deps, tarPath);
    await expect(assertBundleIdentity(deps, extracted, { currentVersion: "5.0.0" })).rejects.toMatchObject({
      code: "bundle_identity_rejected",
    });
  });

  it("assertBundleIdentity rejects a payload declaring the wrong bundle identifier", async () => {
    const src = path.join(work, "wrong-id-src");
    await fs.mkdir(src, { recursive: true });
    const appDir = await buildFixtureApp(src, { identifier: "com.example.not-arcelle" });
    const tarPath = path.join(work, "wrong-id.tar.gz");
    await packTarGz({ appPath: appDir, outFile: tarPath });

    const deps = defaultInstallDeps();
    const extracted = await extractTarGz(deps, tarPath);
    await expect(assertBundleIdentity(deps, extracted, { currentVersion: "1.0.0" })).rejects.toMatchObject({
      code: "bundle_identity_rejected",
    });
  });

  it("re-confirms the failure packTarGz_a exists to prevent: a raw bsdtar call WITHOUT COPYFILE_DISABLE really does carry an AppleDouble entry that breaks extraction", async () => {
    const src = path.join(work, "dirty-src");
    await fs.mkdir(src, { recursive: true });
    const dirtyApp = await buildFixtureApp(src);
    // Make the premise deterministic. Older local filesystems happened to add
    // metadata of their own, while fresh GitHub runner volumes do not. A real
    // xattr is exactly what COPYFILE_DISABLE must keep out of the archive.
    const taggedFile = path.join(dirtyApp, "Contents", "Info.plist");
    await execFileAsync("/usr/bin/xattr", ["-w", "com.arcelle.pack-proof", "present", taggedFile]);
    const xattr = await execFileAsync("/usr/bin/xattr", ["-p", "com.arcelle.pack-proof", taggedFile]);
    expect(xattr.stdout.trim()).toBe("present");
    const dirtyTar = path.join(work, "dirty.tar.gz");
    const env = { ...process.env };
    delete env.COPYFILE_DISABLE;
    await execFileAsync("/usr/bin/tar", ["-czf", dirtyTar, "-C", src, "Arcelle.app"], { env });

    const deps = defaultInstallDeps();
    const err = await extractTarGz(deps, dirtyTar).then(
      () => null,
      (e) => e,
    );
    // bsdtar's own AppleDouble-awareness means this doesn't necessarily
    // reproduce the exact "._Arcelle.app first" failure on every macOS
    // version/filesystem, but the archive genuinely differs from
    // packTarGz_a's COPYFILE_DISABLE=1 output -- assert that difference
    // directly rather than assuming one specific failure mode.
    const cleanTar = path.join(work, "clean-for-contrast.tar.gz");
    await packTarGz({ appPath: await buildFixtureApp(path.join(work, "clean-for-contrast-src")), outFile: cleanTar });
    // bsdtar hides AppleDouble members in its own metadata-aware listing.
    // Python's raw tar reader does not, which directly proves the dirty
    // archive contains the dangerous entries and the production packer does
    // not. Archive size was only a proxy and became identical on clean CI
    // volumes, even though the production rule itself remained necessary.
    const listRawMembers = async (tarPath) => {
      const script =
        "import json, sys, tarfile; " +
        "print(json.dumps(tarfile.open(sys.argv[1], 'r:gz').getnames()))";
      const { stdout } = await execFileAsync("/usr/bin/python3", ["-c", script, tarPath]);
      return JSON.parse(stdout);
    };
    const isAppleDouble = (name) => name.split("/").some((part) => part.startsWith("._"));
    expect((await listRawMembers(dirtyTar)).some(isAppleDouble)).toBe(true);
    expect((await listRawMembers(cleanTar)).some(isAppleDouble)).toBe(false);

    if (err) {
      expect(err).toBeInstanceOf(InstallError);
    }
  });
});
