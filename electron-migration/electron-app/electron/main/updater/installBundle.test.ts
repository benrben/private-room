import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  InstallError,
  assertBundleIdentity,
  buildPrivilegedMoveScript,
  defaultInstallDeps,
  deriveAppBundlePath,
  extractTarGz,
  installAndRelaunch,
  installExtractedBundle,
  readCFBundleExecutable,
  relaunchApp,
  type FsOps,
  type InstallDeps,
  type ProcessRunner,
} from "./installBundle.js";

/** Await a call that MUST reject, and return its error typed. Unlike
 * `.catch(e => e as E)`, this fails loudly if the call unexpectedly resolves
 * instead of quietly handing the assertions a success value. */
async function rejectsWith<E>(p: Promise<unknown>): Promise<E> {
  try {
    await p;
  } catch (e) {
    return e as E;
  }
  throw new Error("expected the call to reject, but it resolved");
}

// ------------------------------------------------------------------ fakes

interface FakeState {
  calls: string[];
  existing: Set<string>;
  renameErrors: Map<string, NodeJS.ErrnoException>;
  tempCounter: number;
}

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

/** Info.plist values a healthy bridge payload declares. */
const GOOD_PLIST: Record<string, string> = {
  CFBundleExecutable: "Arcelle",
  CFBundleIdentifier: "com.benreich.privateroom",
  CFBundleShortVersionString: "0.26.0",
};

function fakeDeps(
  overrides: Partial<{
    existing: string[];
    runResult: string;
    quit: () => void;
    /** Per-key `plutil -extract` results, keyed by the plist key requested. */
    plist: Record<string, string>;
  }> = {},
) {
  const state: FakeState = {
    calls: [],
    existing: new Set(overrides.existing ?? []),
    renameErrors: new Map(),
    tempCounter: 0,
  };
  const fsOps: FsOps = {
    async mkdtemp(prefix) {
      const dir = `/tmp/${prefix}${++state.tempCounter}`;
      state.calls.push(`mkdtemp:${dir}`);
      state.existing.add(dir);
      return dir;
    },
    async rm(target) {
      state.calls.push(`rm:${target}`);
      state.existing.delete(target);
    },
    async rename(from, to) {
      state.calls.push(`rename:${from}->${to}`);
      const err = state.renameErrors.get(from);
      if (err) throw err;
      state.existing.delete(from);
      state.existing.add(to);
    },
    async pathExists(target) {
      return state.existing.has(target);
    },
    async touch(target) {
      state.calls.push(`touch:${target}`);
    },
  };
  const proc: ProcessRunner = {
    async run(command, args) {
      state.calls.push(`run:${command} ${args.join(" ")}`);
      if (overrides.plist && args[0] === "-extract") {
        const key = args[1]!;
        if (!Object.hasOwn(overrides.plist, key)) {
          throw new Error(`plutil exited 1: no value at ${key}`);
        }
        return overrides.plist[key]!;
      }
      return overrides.runResult ?? "";
    },
    spawnDetached(command, args) {
      state.calls.push(`spawn:${command} ${args.join(" ")}`);
    },
  };
  const deps: InstallDeps = { fs: fsOps, proc, quit: overrides.quit };
  return { deps, state };
}

// --------------------------------------------------------------- unit tests

describe("deriveAppBundlePath", () => {
  it("strips Contents/MacOS regardless of the executable's name", () => {
    // The Tauri binary is `arcelle`, the Electron one is `Arcelle`; both must
    // resolve to the same bundle.
    expect(deriveAppBundlePath("/Applications/Arcelle.app/Contents/MacOS/arcelle")).toBe(
      "/Applications/Arcelle.app",
    );
    expect(deriveAppBundlePath("/Applications/Arcelle.app/Contents/MacOS/Arcelle")).toBe(
      "/Applications/Arcelle.app",
    );
  });

  it("rejects anything that is not a .app bundle executable", () => {
    for (const bad of [
      "/usr/local/bin/arcelle",
      "/Applications/Arcelle.app/Contents/Resources/arcelle",
      "/Applications/Arcelle/Contents/MacOS/arcelle",
    ]) {
      expect(() => deriveAppBundlePath(bad), bad).toThrow(InstallError);
    }
  });
});

describe("installExtractedBundle — ordering", () => {
  it("moves the current app ASIDE before putting the new one in place", async () => {
    const { deps, state } = fakeDeps({ existing: ["/Applications/Arcelle.app"] });
    await installExtractedBundle(deps, "/tmp/extracted", "/Applications/Arcelle.app");

    const renames = state.calls.filter((c) => c.startsWith("rename:"));
    expect(renames[0]).toMatch(/^rename:\/Applications\/Arcelle\.app->.*current_app$/);
    expect(renames[1]).toBe("rename:/tmp/extracted->/Applications/Arcelle.app");
    // Nothing was destroyed before the replacement was in place: the only rm is
    // the backup cleanup, and it comes last.
    const rms = state.calls.filter((c) => c.startsWith("rm:"));
    expect(rms).toHaveLength(1);
    expect(state.calls.indexOf(rms[0]!)).toBeGreaterThan(state.calls.indexOf(renames[1]!));
    expect(state.calls).toContain("touch:/Applications/Arcelle.app");
  });

  it("installs cleanly when no previous app exists", async () => {
    const { deps, state } = fakeDeps();
    await installExtractedBundle(deps, "/tmp/extracted", "/Applications/Arcelle.app");
    expect(state.calls.filter((c) => c.startsWith("rename:"))).toEqual([
      "rename:/tmp/extracted->/Applications/Arcelle.app",
    ]);
  });

  it("escalates on a permission error WITHOUT having touched the old app", async () => {
    const { deps, state } = fakeDeps({ existing: ["/Applications/Arcelle.app"] });
    state.renameErrors.set("/Applications/Arcelle.app", errno("EPERM"));

    const err = await rejectsWith<InstallError>(
      installExtractedBundle(deps, "/tmp/extracted", "/Applications/Arcelle.app"),
    );
    expect(err).toBeInstanceOf(InstallError);
    expect(err.code).toBe("permission_denied");
    expect(err.privilegedMoveScript).toContain("with administrator privileges");
    // The old app is still exactly where it was.
    expect(state.existing.has("/Applications/Arcelle.app")).toBe(true);
    expect(state.calls.some((c) => c === "rm:/Applications/Arcelle.app")).toBe(false);
  });

  it("puts the old app BACK when the second rename fails", async () => {
    // This is why a delete-then-move ordering is wrong: a failure there leaves
    // the user with no app at all.
    const { deps, state } = fakeDeps({ existing: ["/Applications/Arcelle.app"] });
    state.renameErrors.set("/tmp/extracted", errno("ENOSPC"));

    const err = await rejectsWith<InstallError>(
      installExtractedBundle(deps, "/tmp/extracted", "/Applications/Arcelle.app"),
    );
    expect(err.code).toBe("install_failed");
    expect(err.message).toContain("previous version was restored");
    expect(state.existing.has("/Applications/Arcelle.app")).toBe(true);
  });

  it("names where the old app went when even the restore fails", async () => {
    const { deps, state } = fakeDeps({ existing: ["/Applications/Arcelle.app"] });
    state.renameErrors.set("/tmp/extracted", errno("EIO"));
    // Fail the restore too, by rejecting a rename out of the backup path.
    const originalRename = deps.fs.rename.bind(deps.fs);
    deps.fs.rename = async (from, to) => {
      if (from.includes("current_app")) throw errno("EIO");
      return originalRename(from, to);
    };

    const err = await rejectsWith<InstallError>(
      installExtractedBundle(deps, "/tmp/extracted", "/Applications/Arcelle.app"),
    );
    expect(err.message).toMatch(/The previous version is at .*current_app/);
    expect(state.existing.has("/Applications/Arcelle.app")).toBe(false);
  });

  it("reports EXDEV distinctly, since it means TMPDIR is on another volume", async () => {
    const { deps, state } = fakeDeps();
    state.renameErrors.set("/tmp/extracted", errno("EXDEV"));
    const err = await rejectsWith<InstallError>(
      installExtractedBundle(deps, "/tmp/extracted", "/Applications/Arcelle.app"),
    );
    expect(err.code).toBe("cross_device");
  });

  it("leaves no temp dir behind when the install fails with nothing to restore", async () => {
    const { deps, state } = fakeDeps();
    state.renameErrors.set("/tmp/extracted", errno("ENOSPC"));
    await rejectsWith<InstallError>(
      installExtractedBundle(deps, "/tmp/extracted", "/Applications/Arcelle.app"),
    );
    const backups = [...state.existing].filter((p) => p.includes("arcelle-update-backup-"));
    expect(backups).toEqual([]);
  });

  it("KEEPS the backup when the restore failed, since it is the only copy left", async () => {
    const { deps, state } = fakeDeps({ existing: ["/Applications/Arcelle.app"] });
    state.renameErrors.set("/tmp/extracted", errno("EIO"));
    const originalRename = deps.fs.rename.bind(deps.fs);
    deps.fs.rename = async (from, to) => {
      if (from.includes("current_app")) throw errno("EIO");
      return originalRename(from, to);
    };
    await rejectsWith<InstallError>(
      installExtractedBundle(deps, "/tmp/extracted", "/Applications/Arcelle.app"),
    );
    expect(state.calls.some((c) => c.startsWith("rm:/tmp/arcelle-update-backup-"))).toBe(false);
  });

  it("survives a failing touch, which the real plugin also ignores", async () => {
    const { deps } = fakeDeps({ existing: ["/Applications/Arcelle.app"] });
    deps.fs.touch = async () => {
      throw errno("EACCES");
    };
    await expect(
      installExtractedBundle(deps, "/tmp/extracted", "/Applications/Arcelle.app"),
    ).resolves.toBeUndefined();
  });
});

describe("buildPrivilegedMoveScript", () => {
  it("quotes for both the shell and the AppleScript string literal", () => {
    const script = buildPrivilegedMoveScript("/tmp/new app", "/Applications/Arcelle.app");
    expect(script).toBe(
      `do shell script "rm -rf '/Applications/Arcelle.app' && mv -f '/tmp/new app' '/Applications/Arcelle.app'" with administrator privileges`,
    );
  });

  it("escapes a single quote in a path rather than ending the shell word", () => {
    const script = buildPrivilegedMoveScript("/tmp/it's", "/Applications/Arcelle.app");
    // Two layers: the shell needs `'\''`, and that backslash then has to survive
    // being inside an AppleScript string literal, so it appears doubled here.
    expect(script).toContain(String.raw`'/tmp/it'\\''s'`);
  });
});

describe("readCFBundleExecutable", () => {
  it("reads the value from the NEW bundle's Info.plist", async () => {
    const { deps, state } = fakeDeps({ runResult: "Arcelle\n" });
    expect(await readCFBundleExecutable(deps, "/Applications/Arcelle.app")).toBe("Arcelle");
    expect(state.calls).toContain(
      "run:/usr/bin/plutil -extract CFBundleExecutable raw -o - /Applications/Arcelle.app/Contents/Info.plist",
    );
  });

  it("rejects an empty value", async () => {
    const { deps } = fakeDeps({ runResult: "   " });
    await expect(readCFBundleExecutable(deps, "/Applications/Arcelle.app")).rejects.toThrow(
      /empty CFBundleExecutable/,
    );
  });

  it("rejects a value that is not a plain file name", async () => {
    for (const bad of ["../../evil", "sub/dir", ".."]) {
      const { deps } = fakeDeps({ runResult: bad });
      await expect(readCFBundleExecutable(deps, "/Applications/Arcelle.app"), bad).rejects.toThrow(
        /not a plain file name/,
      );
    }
  });

  it("surfaces a plutil failure as plist_read_failed", async () => {
    const { deps } = fakeDeps();
    deps.proc.run = async () => {
      throw new Error("plutil exited 1: not a plist");
    };
    const err = await rejectsWith<InstallError>(
      readCFBundleExecutable(deps, "/Applications/Arcelle.app"),
    );
    expect(err.code).toBe("plist_read_failed");
  });
});

describe("relaunch", () => {
  it("spawns the executable the NEW bundle names, not the old one", () => {
    // The cutover risk this closes: the running binary is `arcelle`, the
    // installed one is `Arcelle`.
    const { deps, state } = fakeDeps({ runResult: "Arcelle" });
    relaunchApp(deps, "/Applications/Arcelle.app", "Arcelle");
    expect(state.calls).toContain("spawn:/Applications/Arcelle.app/Contents/MacOS/Arcelle ");
  });

  it("installAndRelaunch relaunches and quits only AFTER the bundle is in place", async () => {
    const quit = vi.fn();
    const { deps, state } = fakeDeps({
      existing: ["/Applications/Arcelle.app"],
      plist: GOOD_PLIST,
      quit,
    });
    // Report the extracted bundle as a real one so the post-extract check passes.
    const realExists = deps.fs.pathExists.bind(deps.fs);
    deps.fs.pathExists = async (p) => (p.endsWith("Contents/MacOS") ? true : realExists(p));

    await installAndRelaunch(deps, "/tmp/payload.tar.gz", "/Applications/Arcelle.app/Contents/MacOS/arcelle", {
      currentVersion: "0.25.0",
    });
    expect(quit).toHaveBeenCalledOnce();
    const spawnIdx = state.calls.findIndex((c) => c.startsWith("spawn:"));
    const installIdx = state.calls.findIndex((c) => c.endsWith("->/Applications/Arcelle.app"));
    expect(installIdx).toBeGreaterThan(-1);
    expect(spawnIdx).toBeGreaterThan(installIdx);
  });
});

/**
 * The manifest is unsigned; the payload's own Info.plist is not. These pin the
 * two attacks that every other check in the flow passes — a downgrade replayed
 * under an inflated manifest version, and an artifact that simply is not
 * Arcelle.
 */
describe("assertBundleIdentity — the signed payload must prove what it is", () => {
  const EXTRACTED = "/tmp/arcelle-update-1";

  it("accepts a genuine newer Arcelle bundle and reports what it read", async () => {
    const { deps } = fakeDeps({ plist: GOOD_PLIST });
    expect(await assertBundleIdentity(deps, EXTRACTED, { currentVersion: "0.25.0" })).toEqual({
      identifier: "com.benreich.privateroom",
      version: "0.26.0",
    });
  });

  it("rejects a payload whose CFBundleIdentifier is not Arcelle's", async () => {
    const { deps } = fakeDeps({
      plist: { ...GOOD_PLIST, CFBundleIdentifier: "com.attacker.malware" },
    });
    const err = await rejectsWith<InstallError>(
      assertBundleIdentity(deps, EXTRACTED, { currentVersion: "0.25.0" }),
    );
    expect(err.code).toBe("bundle_identity_rejected");
    expect(err.message).toMatch(/com\.attacker\.malware/);
  });

  it("rejects a DOWNGRADE replayed under a manifest claiming a newer version", async () => {
    // The signature over this payload is perfectly valid -- it is a real, older
    // release. Only the artifact's own signed version catches it.
    for (const stale of ["0.24.0", "0.25.0", "0.1.0", "0.25.0-beta.1"]) {
      const { deps } = fakeDeps({
        plist: { ...GOOD_PLIST, CFBundleShortVersionString: stale },
      });
      const err = await rejectsWith<InstallError>(
        assertBundleIdentity(deps, EXTRACTED, { currentVersion: "0.25.0" }),
      );
      expect(err.code, stale).toBe("bundle_identity_rejected");
      expect(err.message).toMatch(/not newer/);
    }
  });

  it("rejects a bundle whose version is not comparable at all", async () => {
    const { deps } = fakeDeps({
      plist: { ...GOOD_PLIST, CFBundleShortVersionString: "nightly" },
    });
    const err = await rejectsWith<InstallError>(
      assertBundleIdentity(deps, EXTRACTED, { currentVersion: "0.25.0" }),
    );
    expect(err.code).toBe("bundle_identity_rejected");
  });

  it("rejects rather than shrugs when the payload omits the keys entirely", async () => {
    for (const missing of ["CFBundleIdentifier", "CFBundleShortVersionString"]) {
      const plist = { ...GOOD_PLIST };
      delete plist[missing];
      const { deps } = fakeDeps({ plist });
      const err = await rejectsWith<InstallError>(
        assertBundleIdentity(deps, EXTRACTED, { currentVersion: "0.25.0" }),
      );
      expect(err.code, missing).toBe("plist_read_failed");
    }
  });

  it("checks the identifier BEFORE trusting anything else in the bundle", async () => {
    const { deps, state } = fakeDeps({
      plist: { CFBundleIdentifier: "com.attacker.malware", CFBundleShortVersionString: "9.9.9" },
    });
    await rejectsWith<InstallError>(assertBundleIdentity(deps, EXTRACTED, { currentVersion: "0.25.0" }));
    expect(state.calls.some((c) => c.includes("CFBundleShortVersionString"))).toBe(false);
  });
});

describe("installAndRelaunch — a rejected payload leaves the running app alone", () => {
  async function attempt(plist: Record<string, string>) {
    const quit = vi.fn();
    const { deps, state } = fakeDeps({ existing: ["/Applications/Arcelle.app"], plist, quit });
    const realExists = deps.fs.pathExists.bind(deps.fs);
    deps.fs.pathExists = async (p) => (p.endsWith("Contents/MacOS") ? true : realExists(p));
    const err = await rejectsWith<InstallError>(
      installAndRelaunch(deps, "/tmp/payload.tar.gz", "/Applications/Arcelle.app/Contents/MacOS/arcelle", {
        currentVersion: "0.25.0",
      }),
    );
    return { err, state, quit };
  }

  it("does not move, delete, relaunch or quit when the identity check fails", async () => {
    for (const plist of [
      { ...GOOD_PLIST, CFBundleIdentifier: "com.attacker.malware" },
      { ...GOOD_PLIST, CFBundleShortVersionString: "0.24.0" },
    ]) {
      const { err, state, quit } = await attempt(plist);
      expect(err.code).toBe("bundle_identity_rejected");
      // Nothing was renamed into or out of the live bundle...
      expect(state.calls.filter((c) => c.startsWith("rename:"))).toEqual([]);
      // ...the old app is still there, nothing was spawned, nothing quit.
      expect(state.existing.has("/Applications/Arcelle.app")).toBe(true);
      expect(state.calls.some((c) => c.startsWith("spawn:"))).toBe(false);
      expect(quit).not.toHaveBeenCalled();
      // ...and the extraction temp dir was cleaned up rather than leaked.
      expect(state.calls).toContain("rm:/tmp/arcelle-update-1");
    }
  });
});

describe("extractTarGz — guards", () => {
  it("rejects an archive that did not yield Contents/MacOS", async () => {
    const { deps } = fakeDeps();
    const err = await rejectsWith<InstallError>(extractTarGz(deps, "/tmp/x.tar.gz"));
    expect(err.code).toBe("extract_produced_no_bundle");
  });

  it("cleans up its temp dir and reports extract_failed when tar fails", async () => {
    const { deps, state } = fakeDeps();
    deps.proc.run = async () => {
      throw new Error("tar exited 1: truncated");
    };
    const err = await rejectsWith<InstallError>(extractTarGz(deps, "/tmp/x.tar.gz"));
    expect(err.code).toBe("extract_failed");
    expect(state.calls.some((c) => c.startsWith("rm:/tmp/arcelle-update-"))).toBe(true);
  });
});

// -------------------------------------------------------- real integration

/**
 * These drive the REAL `/usr/bin/tar`, `/usr/bin/plutil` and `node:fs` against
 * real files in a scratch directory — the extraction contract is about what the
 * system tools actually do with a macOS app bundle, and a fake cannot establish
 * that.
 */
describe("real tar/plutil round trip", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "arcelle-updater-test-"));
  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  function buildBundle(root: string, execName: string): string {
    const appDir = path.join(root, "Arcelle.app");
    fs.mkdirSync(path.join(appDir, "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "Contents", "MacOS", execName), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(appDir, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${execName}</string>
<key>CFBundleIdentifier</key><string>com.benreich.privateroom</string>
</dict></plist>
`,
    );
    return appDir;
  }

  /** bsdtar keys off the PRESENCE of COPYFILE_DISABLE, so "off" means deleting
   * it — setting it to "" still suppresses AppleDouble entries. */
  function tarUp(srcRoot: string, out: string, copyfileDisable: boolean): string {
    const env = { ...process.env };
    if (copyfileDisable) env.COPYFILE_DISABLE = "1";
    else delete env.COPYFILE_DISABLE;
    execFileSync("/usr/bin/tar", ["-czf", out, "-C", srcRoot, "Arcelle.app"], { env });
    return out;
  }

  it("extracts a COPYFILE_DISABLE=1 payload, reads its plist, and installs it", async () => {
    const src = path.join(work, "clean-src");
    fs.mkdirSync(src, { recursive: true });
    buildBundle(src, "Arcelle");
    const tar = tarUp(src, path.join(work, "clean.tar.gz"), true);

    const deps = defaultInstallDeps();
    const extracted = await extractTarGz(deps, tar);
    expect(fs.existsSync(path.join(extracted, "Contents", "MacOS", "Arcelle"))).toBe(true);
    // The top-level directory component is gone: the bundle root IS the dir.
    expect(fs.existsSync(path.join(extracted, "Arcelle.app"))).toBe(false);
    // The executable bit survived the round trip; a bundle that lost it would
    // install and then refuse to launch.
    expect(fs.statSync(path.join(extracted, "Contents", "MacOS", "Arcelle")).mode & 0o111).toBeTruthy();

    expect(await readCFBundleExecutable(deps, extracted)).toBe("Arcelle");

    // Install over a stand-in for an existing older app.
    const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), "arcelle-apps-"));
    const target = path.join(appsDir, "Arcelle.app");
    buildBundle(appsDir, "arcelle"); // the OLD, lowercase-executable bundle
    expect(fs.existsSync(path.join(target, "Contents", "MacOS", "arcelle"))).toBe(true);

    await installExtractedBundle(deps, extracted, target);
    // Compared by directory listing, not existsSync: the default macOS
    // filesystem is case-INSENSITIVE, so `arcelle` and `Arcelle` would both
    // "exist" either way. The stored name is what actually changed.
    expect(fs.readdirSync(path.join(target, "Contents", "MacOS"))).toEqual(["Arcelle"]);
    expect(await readCFBundleExecutable(deps, target)).toBe("Arcelle");
    fs.rmSync(appsDir, { recursive: true, force: true });
  });

  it("a payload packed WITHOUT COPYFILE_DISABLE really does carry ._Arcelle.app", async () => {
    const src = path.join(work, "dirty-src");
    fs.mkdirSync(src, { recursive: true });
    const appDir = buildBundle(src, "Arcelle");
    // Extended attributes are what make bsdtar emit AppleDouble siblings; after
    // a real codesign nearly every file in the bundle carries them.
    execFileSync("/usr/bin/xattr", ["-w", "com.apple.metadata:kTest", "x", appDir]);
    execFileSync("/usr/bin/xattr", ["-w", "com.apple.metadata:kTest", "x", path.join(appDir, "Contents", "Info.plist")]);
    const tar = tarUp(src, path.join(work, "dirty.tar.gz"), false);

    // Prove the fixture reproduces the real footgun rather than simulating it:
    // `tar -tzf` would hide these, since bsdtar is AppleDouble-aware reading its
    // own archives. The raw bytes are not.
    const raw = gunzipSync(fs.readFileSync(tar));
    expect(raw.includes(Buffer.from("._Arcelle.app"))).toBe(true);

    // `--strip-components=1` skips entries that reduce to an empty path, so this
    // extractor survives what kills Tauri's per-entry `skip(1)` (which unpacks
    // the AppleDouble FILE over the extraction root and dies). Packaging must
    // still set COPYFILE_DISABLE=1 -- a Tauri client extracting this same
    // archive during the bridge would fail.
    const deps = defaultInstallDeps();
    const extracted = await extractTarGz(deps, tar);
    expect(fs.existsSync(path.join(extracted, "Contents", "MacOS", "Arcelle"))).toBe(true);
    expect(fs.existsSync(path.join(extracted, "._Arcelle.app"))).toBe(false);
  });

  it("rejects an archive whose top level is not an app bundle", async () => {
    const src = path.join(work, "wrong-src");
    fs.mkdirSync(path.join(src, "Arcelle.app", "NotContents"), { recursive: true });
    fs.writeFileSync(path.join(src, "Arcelle.app", "NotContents", "x"), "x");
    const tar = tarUp(src, path.join(work, "wrong.tar.gz"), true);

    const err = await rejectsWith<InstallError>(extractTarGz(defaultInstallDeps(), tar));
    expect(err).toBeInstanceOf(InstallError);
    expect(err.code).toBe("extract_produced_no_bundle");
  });
});
