import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoveryFile,
  leashJson,
  removeDiscovery,
  writeDiscovery,
  writeDiscoveryAt,
  type LeashRecord,
} from "./moonshotDiscovery.js";

describe("leashJson", () => {
  it("carries every field an external agent needs to self-configure", () => {
    const v = leashJson(17872, "tok123", "full", "My Room");
    expect(v.version).toBe(1);
    expect(v.url).toBe("http://127.0.0.1:17872/mcp");
    expect(v.token).toBe("tok123");
    expect(v.scope).toBe("full");
    expect(v.room).toBe("My Room");
    expect(v.pid).toBe(process.pid);
    expect(v.startedAt).toBeGreaterThan(0);
  });
});

describe("writeDiscoveryAt / removal (real fixture directory, real filesystem)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "leash-test-"));
    filePath = path.join(dir, "leash.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes the full record, 0600, and re-reads it byte-for-value identical", () => {
    // Mirrors discovery.rs's own `discovery_file_fields_perms_and_removal`.
    const v = leashJson(17872, "tok123", "full", "My Room");
    writeDiscoveryAt(filePath, v);
    const read = JSON.parse(fs.readFileSync(filePath, "utf8")) as LeashRecord;
    expect(read.version).toBe(1);
    expect(read.url).toBe("http://127.0.0.1:17872/mcp");
    expect(read.token).toBe("tok123");
    expect(read.scope).toBe("full");
    expect(read.room).toBe("My Room");
    expect(read.pid).toBe(process.pid);
    expect(read.startedAt).toBeGreaterThan(0);
    // 0600 — the bearer token must never be group/world readable.
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("re-tightens permissions on a pre-existing looser-mode leftover", () => {
    const v = leashJson(17872, "tok123", "full", "My Room");
    writeDiscoveryAt(filePath, v);
    fs.chmodSync(filePath, 0o644);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o644);
    writeDiscoveryAt(filePath, v);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("creates the parent directory when it does not exist yet", () => {
    const nested = path.join(dir, "nested", "leash.json");
    writeDiscoveryAt(nested, leashJson(1, "t", "files", "R"));
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("overwrites whatever was there on every call", () => {
    writeDiscoveryAt(filePath, leashJson(1, "old-token", "files", "Room A"));
    writeDiscoveryAt(filePath, leashJson(2, "new-token", "full", "Room B"));
    const read = JSON.parse(fs.readFileSync(filePath, "utf8")) as LeashRecord;
    expect(read.token).toBe("new-token");
    expect(read.room).toBe("Room B");
    expect(read.scope).toBe("full");
  });
});

describe("discoveryFile", () => {
  const originalHome = process.env["HOME"];

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
  });

  it("resolves to ~/.arcelle/leash.json under the real HOME", () => {
    expect(discoveryFile()).toBe(path.join(originalHome as string, ".arcelle", "leash.json"));
  });

  it("falls back to the passwd home for an unset or EMPTY HOME, as dirs::home_dir does", () => {
    // Tauri's `app.path().home_dir()` resolves through the `dirs` crate, whose
    // unix `home_dir()` is "$HOME if set and NON-EMPTY, else getpwuid" — it does
    // not give up the moment the variable is missing. An earlier version of this
    // file threw here instead, which is also what made it disagree with
    // `moonshotServer.ts`'s (now deleted) second copy about where leash.json is.
    const passwdHome = path.join(os.userInfo().homedir, ".arcelle", "leash.json");
    process.env["HOME"] = "";
    expect(discoveryFile()).toBe(passwdHome);
    delete process.env["HOME"];
    expect(discoveryFile()).toBe(passwdHome);
  });

  it("an explicit home overrides the environment entirely (the test-only seam)", () => {
    process.env["HOME"] = "/should/not/be/read";
    expect(discoveryFile("/tmp/somewhere")).toBe(path.join("/tmp/somewhere", ".arcelle", "leash.json"));
  });
});

describe("ONE implementation — moonshotServer.ts must not re-derive this", () => {
  it("moonshotServer.ts's discovery surface IS this module's, identity-equal", async () => {
    // The bug this pins: `moonshotServer.ts` (the port of `moonshot/server.rs`,
    // which calls `write_discovery`/`remove_discovery` on every Leash
    // start/stop) once carried its own second copy of all of this, resolving
    // the home directory through `os.homedir()` while this module used
    // `process.env.HOME`-or-throw. With HOME unset the two named DIFFERENT
    // files, so a Leash started through one and torn down through the other
    // (room close / app exit reach for the DISCOVERY module) left a live 0600
    // bearer token on disk after the room was gone.
    const server = await import("./moonshotServer.js");
    expect(server.writeDiscovery).toBe(writeDiscovery);
    expect(server.removeDiscovery).toBe(removeDiscovery);
    expect(server.discoveryFilePath).toBe(discoveryFile);
  });
});

describe("writeDiscovery / removeDiscovery against the real ~/.arcelle path", () => {
  // These two exercise the full seam (HOME resolution + write/remove) rather
  // than a fixture directory, so they redirect HOME to an isolated temp
  // directory rather than touching the real developer machine's home.
  let dir: string;
  const originalHome = process.env["HOME"];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "leash-home-test-"));
    process.env["HOME"] = dir;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes to ~/.arcelle/leash.json and removeDiscovery deletes it", () => {
    writeDiscovery(17872, "tok123", "full", "My Room");
    const written = discoveryFile();
    expect(fs.existsSync(written)).toBe(true);
    expect(fs.statSync(written).mode & 0o777).toBe(0o600);
    removeDiscovery();
    expect(fs.existsSync(written)).toBe(false);
  });

  it("removal is idempotent — a missing file is fine", () => {
    expect(() => removeDiscovery()).not.toThrow();
    expect(() => removeDiscovery()).not.toThrow();
  });

  it("removeDiscovery never throws even when HOME cannot be resolved", () => {
    process.env["HOME"] = "";
    expect(() => removeDiscovery()).not.toThrow();
  });
});
