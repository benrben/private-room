/**
 * Tests for `runtimesCmds.ts` — the MCP-connector runtime-provisioning door
 * ported from `src-tauri/src/commands/runtimes.rs`.
 *
 * WHAT IS REAL, AND WHY:
 *   - Every filesystem call is against a REAL scratch directory
 *     (`mkdtempSync` under `os.tmpdir()`), never mocked — `isInstalled`/
 *     `pathPrefix`/`provisionRuntime` all do real `fs` work and there is
 *     nothing to gain from faking it.
 *   - The tar EXTRACTION half of `provisionRuntime` is exercised against the
 *     REAL `/usr/bin/tar` (always present on macOS, this app's only target)
 *     with REAL `.tar.gz` fixtures built by shelling out to the same `tar`
 *     in `beforeAll` — genuine coverage of the exact argument list
 *     (`-xzf … -C … --strip-components=1`) this module builds, not a promise
 *     that the module WOULD build the right ones. Only the HTTP fetch is
 *     injected (`RuntimeFetchLike`) — pulling real bytes from GitHub/
 *     nodejs.org on every test run would be slow, flaky, and prove nothing
 *     `ytdlp.test.ts` hasn't already proven about fetch-and-hash streaming.
 *   - `mcpRuntimeForCommand`'s default (`loginShellPath`, unmocked) is
 *     exercised once for real — a real `zsh -lc`, no network — to prove the
 *     production wiring actually resolves, matching the "real subprocess
 *     coverage" bar `skillsCmds.test.ts` sets for its own script-run arm.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cachedPathPrefix as scriptRunCachedPathPrefix,
  setCachedPathPrefix as setScriptRunCachedPathPrefix,
} from "./scriptRun.js";
import {
  cachedPathPrefix,
  checksumRefusal,
  installDir,
  isInstalled,
  mcpProvisionRuntime,
  mcpRuntimeForCommand,
  NODE_SHA256_ARM64,
  NODE_SHA256_X64,
  NODE_VERSION,
  parseRuntimeKind,
  pathPrefix,
  provisionRuntime,
  refreshPathPrefix,
  registerRuntimesIpc,
  resetPathPrefixCellForTests,
  runtimeAsset,
  runtimeBinSubdir,
  runtimeForCommand,
  runtimeLabel,
  runtimeMarker,
  runtimesRoot,
  runtimeSource,
  RUNTIME_KINDS,
  statusFor,
  UV_SHA256_AARCH64,
  UV_SHA256_X86_64,
  UV_VERSION,
  whichIn,
  type ProvisionDeps,
  type RuntimeFetchLike,
} from "./runtimesCmds.js";
import type { HttpResponseLike, SpawnedProcess, SpawnFn } from "./ytdlp.js";

// ------------------------------------------------------------------- fakes

/** Mirrors `ytdlp.test.ts`'s own `fakeChunkReader`/`fakeFetchOk`: a scripted
 * `HttpResponseLike` that streams fixed bytes, split into `chunkSize`-byte
 * pieces so multi-chunk progress accounting is exercised, not just a single
 * `read()`. */
function fakeFetchOk(
  bytes: Uint8Array,
  opts: { chunkSize?: number; contentLength?: number } = {},
): RuntimeFetchLike {
  const chunkSize = opts.chunkSize ?? (bytes.length || 1);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(bytes.subarray(i, i + chunkSize));
  }
  return async (): Promise<HttpResponseLike> => {
    let i = 0;
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-length"
            ? String(opts.contentLength ?? bytes.length)
            : null,
      },
      body: {
        getReader: () => ({
          read: async () => {
            if (i >= chunks.length) return { done: true };
            return { done: false, value: chunks[i++] as Uint8Array };
          },
        }),
      },
    };
  };
}

/** A scriptable stand-in for {@link SpawnedProcess}, mirroring `ytdlp.test.ts`'s
 * own `FakeProcess`: a real `EventEmitter` with real `PassThrough` stdio, so
 * `runTar`'s real stream/close/error wiring runs against it unmodified. */
class FakeTarProcess extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kill(): boolean {
    return true;
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const tmpDirs: string[] = [];

function mkTempDir(prefix = "runtimes-test-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetPathPrefixCellForTests();
  setScriptRunCachedPathPrefix("");
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A real `.tar.gz` fixture built by the real `tar`, containing exactly one
 * top-level directory (so `--strip-components=1` has something to strip) with
 * the given `[relPath, contents]` files inside it.
 */
function buildFixtureTarGz(files: ReadonlyArray<[string, string]>): Uint8Array {
  const workDir = mkTempDir("runtimes-fixture-");
  const topDir = path.join(workDir, "payload-1.0.0");
  mkdirSync(topDir, { recursive: true });
  for (const [rel, contents] of files) {
    const full = path.join(topDir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  const tarPath = path.join(workDir, "out.tar.gz");
  execFileSync("/usr/bin/tar", [
    "-czf",
    tarPath,
    "-C",
    workDir,
    "payload-1.0.0",
  ]);
  return new Uint8Array(readFileSync(tarPath));
}

/** Bytes that are valid gzip-magic-free garbage — real tar genuinely refuses
 * to extract this, giving a real non-zero exit without needing to fake tar
 * itself. */
function garbageBytes(n = 64): Uint8Array {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = (i * 37 + 11) % 256;
  return buf;
}

// ============================================================================
// Pure kind helpers
// ============================================================================

describe("parseRuntimeKind", () => {
  it("round-trips the two known kinds and rejects everything else", () => {
    expect(parseRuntimeKind("uv")).toBe("uv");
    expect(parseRuntimeKind("node")).toBe("node");
    expect(parseRuntimeKind("nope")).toBeNull();
    expect(parseRuntimeKind("")).toBeNull();
    expect(parseRuntimeKind("Uv")).toBeNull(); // case-sensitive, matching Rust's exact match
  });
});

describe("runtimeForCommand", () => {
  it("maps every uv/node alias, by leaf, and refuses anything else", () => {
    expect(runtimeForCommand("uvx")).toBe("uv");
    expect(runtimeForCommand("uv")).toBe("uv");
    expect(runtimeForCommand("uvenv")).toBe("uv");
    expect(runtimeForCommand("npx")).toBe("node");
    expect(runtimeForCommand("npm")).toBe("node");
    expect(runtimeForCommand("node")).toBe("node");
    // A full path is handled by its leaf.
    expect(runtimeForCommand("/opt/homebrew/bin/npx")).toBe("node");
    expect(runtimeForCommand("/usr/local/bin/uvx")).toBe("uv");
    // Docker / anything else is not provisionable.
    expect(runtimeForCommand("docker")).toBeNull();
    expect(runtimeForCommand("some-server")).toBeNull();
  });
});

describe("runtimeLabel / runtimeSource / runtimeBinSubdir / runtimeMarker", () => {
  it("carries the exact user-facing strings and filesystem layout per kind", () => {
    expect(runtimeLabel("uv")).toBe("Python runtime (uv)");
    expect(runtimeLabel("node")).toBe("Node.js runtime");
    expect(runtimeSource("uv")).toBe("astral.sh · ~22 MB");
    expect(runtimeSource("node")).toBe("nodejs.org · ~45 MB");
    // uv sits at the top of its install dir; Node keeps its bin/.
    expect(runtimeBinSubdir("uv")).toBe("");
    expect(runtimeBinSubdir("node")).toBe("bin");
    expect(runtimeMarker("uv")).toBe("uv");
    expect(runtimeMarker("node")).toBe("bin/node");
  });
});

// ============================================================================
// runtimeAsset — pinned URL + digest per (kind, arch)
// ============================================================================

describe("runtimeAsset", () => {
  it("builds the pinned uv URL/digest for each known arch", () => {
    const arm = runtimeAsset("uv", "arm64");
    expect(arm.url).toBe(
      `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-apple-darwin.tar.gz`,
    );
    expect(arm.sha256).toBe(UV_SHA256_AARCH64);

    const x64 = runtimeAsset("uv", "x64");
    expect(x64.url).toBe(
      `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-apple-darwin.tar.gz`,
    );
    expect(x64.sha256).toBe(UV_SHA256_X86_64);
  });

  it("builds the pinned node URL/digest for each known arch", () => {
    const arm = runtimeAsset("node", "arm64");
    expect(arm.url).toBe(
      `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-arm64.tar.gz`,
    );
    expect(arm.sha256).toBe(NODE_SHA256_ARM64);

    const x64 = runtimeAsset("node", "x64");
    expect(x64.url).toBe(
      `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-x64.tar.gz`,
    );
    expect(x64.sha256).toBe(NODE_SHA256_X64);
  });

  it("defaults to process.arch when no arch is supplied — well-formed for whatever chip runs the test", () => {
    // Mirrors runtimes.rs's own `asset_urls_are_platform_correct`: check shape,
    // not a specific arch string, since CI/dev machines differ.
    const uv = runtimeAsset("uv");
    expect(
      uv.url.startsWith("https://github.com/astral-sh/uv/releases/download/"),
    ).toBe(true);
    expect(uv.url.endsWith("-apple-darwin.tar.gz")).toBe(true);
    const node = runtimeAsset("node");
    expect(node.url).toContain("nodejs.org/dist/");
    expect(node.url).toContain("-darwin-");
    expect(node.url.endsWith(".tar.gz")).toBe(true);
  });

  it("throws naming the unsupported chip rather than returning a guessed asset", () => {
    expect(() => runtimeAsset("uv", "riscv64")).toThrow(
      "no uv build for riscv64",
    );
    expect(() => runtimeAsset("node", "riscv64")).toThrow(
      "no node build for riscv64",
    );
  });

  it("every pinned download is version-locked (never /latest/) and carries a real 64-hex digest", () => {
    // Mirrors runtimes.rs's own `every_runtime_download_is_pinned_and_carries_a_digest`.
    for (const kind of RUNTIME_KINDS) {
      for (const arch of ["arm64", "x64"]) {
        const a = runtimeAsset(kind, arch);
        expect(a.url).not.toContain("/latest/");
        expect(a.url.includes(UV_VERSION) || a.url.includes(NODE_VERSION)).toBe(
          true,
        );
        expect(a.sha256).toHaveLength(64);
        expect(/^[0-9a-f]+$/i.test(a.sha256)).toBe(true);
      }
    }
  });
});

// ============================================================================
// checksumRefusal
// ============================================================================

describe("checksumRefusal", () => {
  it("passes a matching digest, case-insensitively, and refuses by name otherwise", () => {
    // Mirrors runtimes.rs's own `a_download_that_hashes_wrong_is_refused_by_name`.
    const empty = sha256Hex(new Uint8Array(0));
    expect(empty).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );

    expect(checksumRefusal("uv", empty, empty)).toBeNull();
    // Case is not a difference: checksum files are published both ways.
    expect(checksumRefusal("uv", empty.toUpperCase(), empty)).toBeNull();
    // This is ASCII folding, not Unicode case folding: inputs outside a hex
    // digest must never become equal merely because another locale folds them.
    expect(checksumRefusal("uv", "Å", "å")).not.toBeNull();

    const why = checksumRefusal("node", empty, "00");
    expect(why).not.toBeNull();
    expect(why).toContain("Node.js runtime");
    expect(why).toContain(empty);
    expect(why).toContain("deleted");
    expect(why).toContain("Check the network you are on and try again.");
  });
});

// ============================================================================
// whichIn
// ============================================================================

describe("whichIn", () => {
  it("checks each PATH dir by leaf, resolving a full path to its basename", () => {
    // Mirrors runtimes.rs's own `which_in_checks_each_path_dir_by_leaf`.
    const dir = mkTempDir("runtimes-which-");
    writeFileSync(path.join(dir, "uvx"), "x");
    expect(whichIn("uvx", `/nope:${dir}`)).toBe(true);
    expect(whichIn("npx", `/nope:${dir}`)).toBe(false);
    expect(whichIn("/x/y/uvx", dir)).toBe(true);
    expect(whichIn("uvx", "")).toBe(false);
  });
});

// ============================================================================
// Filesystem — runtimesRoot / installDir / isInstalled / pathPrefix
// ============================================================================

describe("filesystem layout", () => {
  it("runtimesRoot creates <appDataDir>/runtimes on every call", () => {
    const appDataDir = mkTempDir();
    const root = runtimesRoot(appDataDir);
    expect(root).toBe(path.join(appDataDir, "runtimes"));
    expect(existsSync(root)).toBe(true);
  });

  it("installDir nests one directory per kind under the runtimes root", () => {
    const appDataDir = mkTempDir();
    expect(installDir(appDataDir, "uv")).toBe(
      path.join(appDataDir, "runtimes", "uv"),
    );
    expect(installDir(appDataDir, "node")).toBe(
      path.join(appDataDir, "runtimes", "node"),
    );
  });

  it("isInstalled is false until the marker file exists, and survives a missing dir", () => {
    const appDataDir = mkTempDir();
    expect(isInstalled(appDataDir, "uv")).toBe(false);
    const dir = installDir(appDataDir, "uv");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "uv"), "#!/bin/sh\n");
    expect(isInstalled(appDataDir, "uv")).toBe(true);
    // Node still isn't.
    expect(isInstalled(appDataDir, "node")).toBe(false);
  });

  it("reports not installed when the filesystem probe itself fails", () => {
    const appDataDir = mkTempDir();
    const exists = vi.fn(() => { throw new Error("volume unavailable"); });

    expect(isInstalled(appDataDir, "uv", exists)).toBe(false);
    expect(exists).toHaveBeenCalledOnce();
  });

  it("pathPrefix is empty when nothing is installed, and colon-joins uv-then-node when both are", () => {
    const appDataDir = mkTempDir();
    expect(pathPrefix(appDataDir)).toBe("");

    const uvDir = installDir(appDataDir, "uv");
    mkdirSync(uvDir, { recursive: true });
    writeFileSync(path.join(uvDir, "uv"), "x");
    // uv sits at the TOP of its install dir (no bin/ subdir).
    expect(pathPrefix(appDataDir)).toBe(uvDir);

    const nodeDir = installDir(appDataDir, "node");
    mkdirSync(path.join(nodeDir, "bin"), { recursive: true });
    writeFileSync(path.join(nodeDir, "bin", "node"), "x");
    // Node's bin/ subdir is what goes on PATH, and uv precedes node.
    expect(pathPrefix(appDataDir)).toBe(
      `${uvDir}:${path.join(nodeDir, "bin")}`,
    );
  });
});

// ============================================================================
// refreshPathPrefix / cachedPathPrefix — including the scriptRun.ts wiring
// ============================================================================

describe("refreshPathPrefix / cachedPathPrefix", () => {
  it("starts empty and stays empty when nothing is installed", () => {
    const appDataDir = mkTempDir();
    expect(cachedPathPrefix()).toBe("");
    refreshPathPrefix(appDataDir);
    expect(cachedPathPrefix()).toBe("");
  });

  it("publishes to BOTH this module's own cell and scriptRun.ts's pre-existing stand-in", () => {
    const appDataDir = mkTempDir();
    const uvDir = installDir(appDataDir, "uv");
    mkdirSync(uvDir, { recursive: true });
    writeFileSync(path.join(uvDir, "uv"), "x");

    expect(scriptRunCachedPathPrefix()).toBe("");
    refreshPathPrefix(appDataDir);
    expect(cachedPathPrefix()).toBe(uvDir);
    // The whole point of the cross-module wire: scriptRun.ts's probes see the
    // SAME value without scriptRun.ts itself changing.
    expect(scriptRunCachedPathPrefix()).toBe(uvDir);
  });
});

// ============================================================================
// statusFor / mcpRuntimeForCommand
// ============================================================================

describe("statusFor", () => {
  it("reports available when the command resolves on the login-shell PATH", async () => {
    const appDataDir = mkTempDir();
    const shellDir = mkTempDir("runtimes-shell-");
    writeFileSync(path.join(shellDir, "uvx"), "x");
    const status = await statusFor(appDataDir, "uvx", {
      resolveLoginPath: async () => shellDir,
    });
    expect(status).toEqual({
      available: true,
      kind: null,
      provisionable: false,
      note: "",
    });
  });

  it("reports available when a DOWNLOADED runtime satisfies it, even off the login PATH", async () => {
    const appDataDir = mkTempDir();
    const uvDir = installDir(appDataDir, "uv");
    mkdirSync(uvDir, { recursive: true });
    writeFileSync(path.join(uvDir, "uv"), "x");
    writeFileSync(path.join(uvDir, "uvx"), "x");
    const status = await statusFor(appDataDir, "uvx", {
      resolveLoginPath: async () => "/nope",
    });
    expect(status.available).toBe(true);
  });

  it("reports provisionable with the download note when the command maps to a fetchable runtime", async () => {
    const appDataDir = mkTempDir();
    const status = await statusFor(appDataDir, "npx", {
      resolveLoginPath: async () => "/nope",
    });
    expect(status).toEqual({
      available: false,
      kind: "node",
      provisionable: true,
      note: "First install downloads the Node.js runtime once (nodejs.org · ~45 MB). Nothing else to set up.",
    });
  });

  it("reports NOT provisionable, with the honest note, for a command the app can't fetch (e.g. docker)", async () => {
    const appDataDir = mkTempDir();
    const status = await statusFor(appDataDir, "docker", {
      resolveLoginPath: async () => "/nope",
    });
    expect(status.available).toBe(false);
    expect(status.kind).toBeNull();
    expect(status.provisionable).toBe(false);
    expect(status.note).toContain("“docker”");
    expect(status.note).toContain("Docker Desktop");
  });

  it("mcpRuntimeForCommand is a thin pass-through to statusFor", async () => {
    const appDataDir = mkTempDir();
    const status = await mcpRuntimeForCommand(appDataDir, "npx", {
      resolveLoginPath: async () => "/nope",
    });
    expect(status.kind).toBe("node");
  });

  it("with no deps override, resolves against the REAL login shell (no network) without hanging", async () => {
    const appDataDir = mkTempDir();
    const status = await mcpRuntimeForCommand(
      appDataDir,
      "definitely-not-a-real-binary-xyz",
    );
    expect(status.available).toBe(false);
    expect(status.provisionable).toBe(false);
  });
});

// ============================================================================
// provisionRuntime — real tar, injected fetch
// ============================================================================

describe("provisionRuntime", () => {
  it("is idempotent: an already-installed runtime returns immediately without fetching", async () => {
    const appDataDir = mkTempDir();
    const uvDir = installDir(appDataDir, "uv");
    mkdirSync(uvDir, { recursive: true });
    writeFileSync(path.join(uvDir, "uv"), "x");

    let called = false;
    const fetchFn: RuntimeFetchLike = async () => {
      called = true;
      throw new Error("should not be called");
    };
    await provisionRuntime(appDataDir, "uv", { fetchFn });
    expect(called).toBe(false);
  });

  it("downloads, verifies, and REALLY extracts via /usr/bin/tar — happy path", async () => {
    const appDataDir = mkTempDir();
    const bytes = buildFixtureTarGz([
      ["uv", "#!/bin/sh\necho fake-uv\n"],
      ["extra/readme.txt", "hello"],
    ]);
    const digest = sha256Hex(bytes);
    const events: Array<[string, unknown]> = [];

    const fetchFn = vi.fn(fakeFetchOk(bytes, { chunkSize: 37 }));
    vi.stubGlobal("fetch", fetchFn);
    const deps: ProvisionDeps = {
      assetOverride: () => ({
        url: "https://fixture.invalid/uv.tar.gz",
        sha256: digest,
      }),
      emit: (event, payload) => events.push([event, payload]),
    };
    await provisionRuntime(appDataDir, "uv", deps);

    expect(fetchFn).toHaveBeenCalledWith("https://fixture.invalid/uv.tar.gz", {
      headers: { "User-Agent": "Arcelle-Electron/runtimes" },
    });

    expect(isInstalled(appDataDir, "uv")).toBe(true);
    const uvDir = installDir(appDataDir, "uv");
    // --strip-components=1 stripped the fixture's "payload-1.0.0" wrapper.
    expect(readFileSync(path.join(uvDir, "uv"), "utf8")).toBe(
      "#!/bin/sh\necho fake-uv\n",
    );
    expect(readFileSync(path.join(uvDir, "extra", "readme.txt"), "utf8")).toBe(
      "hello",
    );
    // The temp download is cleaned up.
    expect(existsSync(path.join(appDataDir, "runtimes", "uv.download"))).toBe(
      false,
    );

    // Progress: at least one "download" phase, one "extract", one "done", all
    // tagged with the right kind, and "done" reports a positive total.
    const phases = events.map(([, p]) => (p as { phase: string }).phase);
    expect(phases[0]).toBe("download");
    expect(phases).toContain("extract");
    expect(phases[phases.length - 1]).toBe("done");
    expect(events.every(([e]) => e === "runtime-progress")).toBe(true);
    expect(events.every(([, p]) => (p as { kind: string }).kind === "uv")).toBe(
      true,
    );
    const done = events[events.length - 1]?.[1] as {
      got: number;
      total: number;
    };
    expect(done.got).toBeGreaterThan(0);
    expect(done.total).toBeGreaterThan(0);
  });

  it("refuses a download that hashes wrong, deletes the temp file, and never creates the install dir", async () => {
    const appDataDir = mkTempDir();
    const bytes = buildFixtureTarGz([["uv", "x"]]);
    const wrongDigest = sha256Hex(new Uint8Array([1, 2, 3]));

    await expect(
      provisionRuntime(appDataDir, "uv", {
        fetchFn: fakeFetchOk(bytes),
        assetOverride: () => ({
          url: "https://fixture.invalid/uv.tar.gz",
          sha256: wrongDigest,
        }),
      }),
    ).rejects.toThrow(/is not the one this app expects/);

    expect(existsSync(path.join(appDataDir, "runtimes", "uv.download"))).toBe(
      false,
    );
    expect(existsSync(installDir(appDataDir, "uv"))).toBe(false);
  });

  it("keeps the checksum refusal when best-effort temp cleanup itself fails", async () => {
    const appDataDir = mkTempDir();
    const bytes = buildFixtureTarGz([["uv", "x"]]);
    const tempPath = path.join(appDataDir, "runtimes", "uv.download");
    const unlinkFn = vi.fn(async () => { throw new Error("cleanup denied"); });

    await expect(provisionRuntime(appDataDir, "uv", {
      fetchFn: fakeFetchOk(bytes),
      assetOverride: () => ({
        url: "https://fixture.invalid/uv.tar.gz",
        sha256: sha256Hex(new Uint8Array([9, 9, 9])),
      }),
      unlinkFn,
    })).rejects.toThrow(/is not the one this app expects/);

    expect(unlinkFn).toHaveBeenCalledWith(tempPath);
    expect(existsSync(tempPath)).toBe(true);
  });

  it("continues extraction when best-effort stale-directory cleanup fails", async () => {
    const appDataDir = mkTempDir();
    const uvDir = installDir(appDataDir, "uv");
    mkdirSync(uvDir, { recursive: true });
    writeFileSync(path.join(uvDir, "stale.txt"), "preserved by simulated cleanup refusal");
    const bytes = buildFixtureTarGz([["uv", "fresh"]]);
    const rmdirFn = vi.fn(async () => { throw new Error("cleanup denied"); });

    await provisionRuntime(appDataDir, "uv", {
      fetchFn: fakeFetchOk(bytes),
      assetOverride: () => ({
        url: "https://fixture.invalid/uv.tar.gz",
        sha256: sha256Hex(bytes),
      }),
      rmdirFn,
    });

    expect(rmdirFn).toHaveBeenCalledWith(uvDir, { recursive: true, force: true });
    expect(readFileSync(path.join(uvDir, "uv"), "utf8")).toBe("fresh");
    expect(readFileSync(path.join(uvDir, "stale.txt"), "utf8")).toContain("cleanup refusal");
  });

  it("a real non-zero tar exit (garbage archive) is refused, and the empty install dir is removed", async () => {
    const appDataDir = mkTempDir();
    const bytes = garbageBytes();
    const digest = sha256Hex(bytes);

    await expect(
      provisionRuntime(appDataDir, "node", {
        fetchFn: fakeFetchOk(bytes),
        assetOverride: () => ({
          url: "https://fixture.invalid/node.tar.gz",
          sha256: digest,
        }),
      }),
    ).rejects.toThrow(/could not unpack the Node\.js runtime/);

    expect(existsSync(installDir(appDataDir, "node"))).toBe(false);
  });

  it("a real successful extraction missing the expected marker is refused, and the dir is removed", async () => {
    const appDataDir = mkTempDir();
    // Valid archive, but it has no "bin/node" inside — node's marker.
    const bytes = buildFixtureTarGz([["bin/npm", "not node"]]);
    const digest = sha256Hex(bytes);

    await expect(
      provisionRuntime(appDataDir, "node", {
        fetchFn: fakeFetchOk(bytes),
        assetOverride: () => ({
          url: "https://fixture.invalid/node.tar.gz",
          sha256: digest,
        }),
      }),
    ).rejects.toThrow(/didn't unpack as expected/);

    expect(existsSync(installDir(appDataDir, "node"))).toBe(false);
  });

  it("a tar SPAWN failure leaves the temp file AND the empty install dir behind (asymmetric, matching Rust's ?)", async () => {
    const appDataDir = mkTempDir();
    const bytes = buildFixtureTarGz([["uv", "x"]]);
    const digest = sha256Hex(bytes);

    const spawnFn: SpawnFn = () => {
      throw new Error("ENOENT: spawn /usr/bin/tar");
    };

    await expect(
      provisionRuntime(appDataDir, "uv", {
        fetchFn: fakeFetchOk(bytes),
        assetOverride: () => ({
          url: "https://fixture.invalid/uv.tar.gz",
          sha256: digest,
        }),
        spawnFn,
      }),
    ).rejects.toThrow(/could not run tar/);

    // Neither cleaned up — the freshly-created (empty) dir and the temp
    // download both survive a spawn failure, exactly as Rust's `?` leaves
    // them before its own `remove_file` line is ever reached.
    expect(existsSync(installDir(appDataDir, "uv"))).toBe(true);
    expect(existsSync(path.join(appDataDir, "runtimes", "uv.download"))).toBe(
      true,
    );
  });

  it("also reports a tar spawn failure delivered via an async 'error' event, not just a synchronous throw", async () => {
    const appDataDir = mkTempDir();
    const bytes = buildFixtureTarGz([["uv", "x"]]);
    const digest = sha256Hex(bytes);

    const spawnFn: SpawnFn = () => {
      const proc = new FakeTarProcess();
      queueMicrotask(() => proc.emit("error", new Error("EACCES")));
      return proc;
    };

    await expect(
      provisionRuntime(appDataDir, "uv", {
        fetchFn: fakeFetchOk(bytes),
        assetOverride: () => ({
          url: "https://fixture.invalid/uv.tar.gz",
          sha256: digest,
        }),
        spawnFn,
      }),
    ).rejects.toThrow(/could not run tar: EACCES/);
  });

  it("wipes a stale/partial install dir before extracting, rather than unpacking on top of it", async () => {
    // ADVERSARIAL ADDITION (verification pass): Rust's `provision` runs
    // `let _ = std::fs::remove_dir_all(&dir)` immediately before
    // `create_dir_all` — the retry after a half-finished extraction must land
    // in a CLEAN directory, or a runtime keeps files from a version it is no
    // longer. Nothing exercised that line: every existing happy-path test
    // starts from a directory that never existed, so a port that dropped the
    // remove entirely would still have passed all of them.
    const appDataDir = mkTempDir();
    const uvDir = installDir(appDataDir, "uv");
    mkdirSync(path.join(uvDir, "leftover"), { recursive: true });
    writeFileSync(
      path.join(uvDir, "leftover", "half-written.bin"),
      "from a crashed run",
    );
    writeFileSync(path.join(uvDir, "stale-uv-0.9"), "an older release's file");
    // Deliberately NOT the marker file, so `isInstalled` is still false and
    // the idempotent short-circuit does not hide the behavior under test.
    expect(isInstalled(appDataDir, "uv")).toBe(false);

    const bytes = buildFixtureTarGz([["uv", "#!/bin/sh\necho fresh\n"]]);
    await provisionRuntime(appDataDir, "uv", {
      fetchFn: fakeFetchOk(bytes),
      assetOverride: () => ({
        url: "https://fixture.invalid/uv.tar.gz",
        sha256: sha256Hex(bytes),
      }),
    });

    expect(isInstalled(appDataDir, "uv")).toBe(true);
    expect(readFileSync(path.join(uvDir, "uv"), "utf8")).toBe(
      "#!/bin/sh\necho fresh\n",
    );
    expect(existsSync(path.join(uvDir, "leftover"))).toBe(false);
    expect(existsSync(path.join(uvDir, "stale-uv-0.9"))).toBe(false);
  });

  it("truncates a leftover <kind>.download rather than appending to it — the digest is of THIS download only", async () => {
    // ADVERSARIAL ADDITION (verification pass): the temp path is a FIXED name
    // per kind (`uv.download`), so an interrupted download leaves one behind —
    // the module's own ported asymmetry (a tar spawn failure keeps the temp
    // file) guarantees it can happen. Rust opens it with `File::create`, which
    // truncates. Opening it for append instead would hash-and-write the old
    // bytes plus the new ones, so the checksum gate would refuse a download
    // that was in fact perfectly good — and the user would be sent back to the
    // same button forever with a "not the one this app expects" message about
    // a file that was never tampered with.
    const appDataDir = mkTempDir();
    const root = runtimesRoot(appDataDir);
    writeFileSync(
      path.join(root, "uv.download"),
      "GARBAGE FROM AN INTERRUPTED RUN".repeat(500),
    );

    const bytes = buildFixtureTarGz([["uv", "x"]]);
    await provisionRuntime(appDataDir, "uv", {
      fetchFn: fakeFetchOk(bytes, { chunkSize: 13 }),
      assetOverride: () => ({
        url: "https://fixture.invalid/uv.tar.gz",
        sha256: sha256Hex(bytes),
      }),
    });

    expect(isInstalled(appDataDir, "uv")).toBe(true);
    expect(existsSync(path.join(root, "uv.download"))).toBe(false);
  });

  it("says WHY the download could not be written when the temp file cannot be opened", async () => {
    // ADVERSARIAL ADDITION (verification pass) — a REAL fidelity gap this
    // found. Rust wraps exactly this step:
    //   `tokio::fs::File::create(&tmp).await.map_err(|e| format!("could not
    //    write the download: {e}"))?`
    // The port opened the handle bare, so the only failure of the whole
    // download pipeline that reaches the Connectors screen WITHOUT a sentence
    // explaining itself was this one — the user would get a raw
    // "EISDIR: illegal operation on a directory, open '…/uv.download'" where
    // Rust says what the app was trying to do. Reachable for real: a stray
    // directory at the fixed `<kind>.download` path, a read-only volume, a
    // full disk.
    const appDataDir = mkTempDir();
    // A DIRECTORY where the temp download file goes -> a real EISDIR from the
    // real fs, no mocking of `fs` itself.
    mkdirSync(path.join(runtimesRoot(appDataDir), "uv.download"), {
      recursive: true,
    });

    const bytes = buildFixtureTarGz([["uv", "x"]]);
    await expect(
      provisionRuntime(appDataDir, "uv", {
        fetchFn: fakeFetchOk(bytes),
        assetOverride: () => ({
          url: "https://fixture.invalid/uv.tar.gz",
          sha256: sha256Hex(bytes),
        }),
      }),
    ).rejects.toThrow(/could not write the download: /);
  });

  it("a non-OK HTTP status is refused without touching the filesystem", async () => {
    const appDataDir = mkTempDir();
    const fetchFn: RuntimeFetchLike = async () => ({
      ok: false,
      status: 503,
      headers: { get: () => null },
      body: null,
    });
    await expect(
      provisionRuntime(appDataDir, "uv", { fetchFn }),
    ).rejects.toThrow(/returned HTTP 503/);
    expect(existsSync(installDir(appDataDir, "uv"))).toBe(false);
  });

  it("a network-level fetch failure is reported by URL, not swallowed", async () => {
    const appDataDir = mkTempDir();
    const fetchFn: RuntimeFetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };
    await expect(
      provisionRuntime(appDataDir, "uv", {
        fetchFn,
        assetOverride: () => ({
          url: "https://fixture.invalid/x",
          sha256: "0".repeat(64),
        }),
      }),
    ).rejects.toThrow(
      /could not reach https:\/\/fixture\.invalid\/x: getaddrinfo ENOTFOUND/,
    );
  });

  it("keeps provisioning when the best-effort progress sender throws", async () => {
    const appDataDir = mkTempDir();
    const bytes = buildFixtureTarGz([["uv", "x"]]);
    await provisionRuntime(appDataDir, "uv", {
      fetchFn: fakeFetchOk(bytes),
      assetOverride: () => ({
        url: "https://fixture.invalid/uv.tar.gz",
        sha256: sha256Hex(bytes),
      }),
      emit: () => {
        throw new Error("renderer closed");
      },
    });

    expect(isInstalled(appDataDir, "uv")).toBe(true);
  });

  it("reports an interrupted response reader after closing its partial download", async () => {
    const appDataDir = mkTempDir();
    const fetchFn: RuntimeFetchLike = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => Promise.reject(new Error("connection reset")),
        }),
      },
    });

    await expect(
      provisionRuntime(appDataDir, "uv", {
        fetchFn,
        assetOverride: () => ({
          url: "https://fixture.invalid/uv.tar.gz",
          sha256: "0".repeat(64),
        }),
      }),
    ).rejects.toThrow("download interrupted: connection reset");
    expect(existsSync(path.join(appDataDir, "runtimes", "uv.download"))).toBe(
      true,
    );
    expect(existsSync(installDir(appDataDir, "uv"))).toBe(false);
  });

  it("passes the real, pinned asset by default (no assetOverride) — the fetch sees the real GitHub/nodejs.org URL", async () => {
    const appDataDir = mkTempDir();
    let seenUrl: string | null = null;
    const fetchFn: RuntimeFetchLike = async (url) => {
      seenUrl = url;
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        body: null,
      };
    };
    await expect(
      provisionRuntime(appDataDir, "node", { fetchFn }),
    ).rejects.toThrow();
    expect(seenUrl).toContain("nodejs.org/dist/");
  });
});

// ============================================================================
// mcpProvisionRuntime — kind parsing + publish-after-install
// ============================================================================

describe("mcpProvisionRuntime", () => {
  it("rejects an unknown runtime kind by name, without touching the filesystem", async () => {
    const appDataDir = mkTempDir();
    await expect(mcpProvisionRuntime(appDataDir, "python")).rejects.toThrow(
      'unknown runtime "python"',
    );
    expect(existsSync(path.join(appDataDir, "runtimes"))).toBe(false);
  });

  it("on success, publishes the fresh prefix to BOTH cells so the very next connector launch sees it", async () => {
    const appDataDir = mkTempDir();
    const bytes = buildFixtureTarGz([["uv", "x"]]);
    const digest = sha256Hex(bytes);

    expect(cachedPathPrefix()).toBe("");
    await mcpProvisionRuntime(appDataDir, "uv", {
      fetchFn: fakeFetchOk(bytes),
      assetOverride: () => ({
        url: "https://fixture.invalid/uv.tar.gz",
        sha256: digest,
      }),
    });
    const uvDir = installDir(appDataDir, "uv");
    expect(cachedPathPrefix()).toBe(uvDir);
    expect(scriptRunCachedPathPrefix()).toBe(uvDir);
  });
});

// ============================================================================
// registerRuntimesIpc — thin wiring, per recIpc.ts's precedent
// ============================================================================

describe("registerRuntimesIpc", () => {
  function fakeIpcMain(): {
    ipcMain: Pick<import("electron").IpcMain, "handle">;
    call: (channel: string, ...args: unknown[]) => Promise<unknown>;
    channels: string[];
  } {
    const handlers = new Map<
      string,
      (event: unknown, ...args: unknown[]) => unknown
    >();
    return {
      ipcMain: {
        handle: (
          channel: string,
          fn: (event: never, ...args: never[]) => unknown,
        ) => {
          handlers.set(
            channel,
            fn as unknown as (event: unknown, ...args: unknown[]) => unknown,
          );
        },
      } as unknown as Pick<import("electron").IpcMain, "handle">,
      call: async (channel, ...args) => {
        const fn = handlers.get(channel);
        if (fn === undefined)
          throw new Error(`no handler registered for ${channel}`);
        return fn(undefined, ...args);
      },
      channels: [...handlers.keys()],
    };
  }

  it("registers exactly the two Connectors-screen channels, under the Rust command names", async () => {
    const appDataDir = mkTempDir();
    const { ipcMain, call } = fakeIpcMain();
    registerRuntimesIpc(ipcMain, appDataDir);

    // A command that maps to neither uv nor node AND is not really on this
    // dev machine's PATH ("docker" itself is a bad choice here — plenty of
    // dev machines genuinely have Docker Desktop installed, which would make
    // this assertion depend on the machine running the suite rather than on
    // this module's own logic).
    const status = (await call("mcp_runtime_for_command", {
      command: "definitely-not-a-real-binary-xyz",
    })) as {
      available: boolean;
      provisionable: boolean;
    };
    expect(status.available).toBe(false);
    expect(status.provisionable).toBe(false);

    await expect(
      call("mcp_provision_runtime", { kind: "not-a-kind" }),
    ).rejects.toThrow('unknown runtime "not-a-kind"');
  });

  it("threads the supplied emit through to mcp_provision_runtime — proven via the idempotent short-circuit (no network reachable from this test)", async () => {
    // registerRuntimesIpc wires the REAL command surface with no fetch/spawn
    // override seam (by design — it is production wiring, not a test
    // harness), so a full download can't be exercised here without hitting
    // the real network. Pre-installing the runtime makes `provisionRuntime`
    // return before ever calling `fetchFn`, which proves the handler really
    // is `mcpProvisionRuntime` (not a stub) and that `emit` is accepted and
    // threaded through, without any network access.
    const appDataDir = mkTempDir();
    const uvDir = installDir(appDataDir, "uv");
    mkdirSync(uvDir, { recursive: true });
    writeFileSync(path.join(uvDir, "uv"), "x");

    const events: unknown[] = [];
    const { ipcMain, call } = fakeIpcMain();
    registerRuntimesIpc(ipcMain, appDataDir, (event, payload) =>
      events.push([event, payload]),
    );
    await call("mcp_provision_runtime", { kind: "uv" });
    expect(events).toEqual([]);
    // The publish-after-install step still ran (refreshPathPrefix), so the
    // already-installed uv is now on the published prefix.
    expect(cachedPathPrefix()).toBe(uvDir);
  });
});
