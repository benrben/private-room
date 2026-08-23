/**
 * Wave 1a: `~/.arcelle/leash.json` — the discovery record an external agent
 * self-configures from (`cat ~/.arcelle/leash.json`) without the user
 * re-pasting a config. Written 0600 (it carries the bearer token) on every
 * Leash start, removed on stop, teardown, and app exit. Ported from
 * `src-tauri/src/commands/moonshot/discovery.rs` (107 lines, read in full).
 *
 * NOT model-invocable and NOT an IPC surface: `discovery.rs` declares no
 * `#[tauri::command]`. Its two `pub(crate)` functions are called directly by
 * other Rust modules — `moonshot/server.rs` (Leash start/stop),
 * `commands/rooms.rs` (room close/teardown), and `lib.rs` (app exit) — and
 * this port keeps that shape: {@link writeDiscovery}/{@link removeDiscovery}
 * are plain functions a future `moonshotServer.ts`/`roomManager.ts` porting
 * batch calls directly, not something wired through `execTool.ts` or
 * `ipcMain.handle`. `toolSpecs.ts`/`toolSchema.ts`/`execTool.ts` were checked
 * for a `leash`/`discovery` arm; there is none.
 *
 * NO AppHandle here: Tauri's `app.path().home_dir()` resolves through the
 * `dirs` crate, whose unix `home_dir()` is "`$HOME` if it is set AND
 * non-empty, otherwise the `getpwuid` passwd entry, otherwise `None`".
 * {@link homeDir} reproduces exactly those three steps —
 * `process.env["HOME"]` (the `scriptRun.ts`/`mcpClient.ts` precedent), then
 * `os.userInfo().homedir` (libuv's `getpwuid_r`, which is what Node exposes
 * of the passwd entry — NOT `os.homedir()`, which returns `""` verbatim for
 * an empty `HOME` and so never reaches the fallback), then a throw where
 * Tauri's `Result` would have propagated an `Err` through `write_discovery`'s
 * `?`.
 *
 * THIS FILE IS THE ONE IMPLEMENTATION. `moonshotServer.ts` (the port of
 * `moonshot/server.rs`, the Leash's start/stop) originally carried a second,
 * independently-written copy of all of this that resolved the home directory
 * through `os.homedir()` instead — so with `HOME` unset the two disagreed
 * about WHERE `leash.json` is, and a Leash started through one and torn down
 * through the other would have left a live 0600 bearer token on disk after
 * the room closed. `moonshotServer.ts` now imports these functions; do not
 * re-introduce a local copy there or in `roomManager.ts`'s teardown path.
 *
 * ONE deliberate, inert divergence: Rust's `serde_json::json!` macro without
 * the `preserve_order` feature serializes through a `BTreeMap`, so the actual
 * on-disk key order is alphabetical (`pid, room, scope, startedAt, token,
 * url, version`), not the order the macro literal is written in. This port
 * uses plain JS object insertion order instead (the literal's own order:
 * `version, url, token, scope, room, pid, startedAt`), which is what a human
 * running the documented `cat` reads more naturally. No reader — human or
 * agent — parses this file as anything but JSON, so key order carries no
 * behavior; see this file's test for the full value comparison that does.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The parsed shape of a `leash.json` record. `pid` is the staleness check:
 * after a crash the file may survive, so a reader should verify the pid is
 * alive before trusting the record; the next start unconditionally overwrites
 * it, so crash leftovers self-heal. */
export interface LeashRecord {
  version: number;
  url: string;
  token: string;
  scope: string;
  room: string;
  pid: number;
  /** Unix seconds — with `pid`, lets a reader judge staleness. */
  startedAt: number;
}

/** Ported from `leash_json`. */
export function leashJson(port: number, token: string, scope: string, room: string): LeashRecord {
  return {
    version: 1,
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    scope,
    room,
    pid: process.pid,
    startedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * `dirs::home_dir()` on unix, which is what `app.path().home_dir()` resolves
 * through: `$HOME` when it is set and NON-EMPTY, else the `getpwuid` passwd
 * entry, else nothing (Rust's `None` → this throws).
 */
function homeDir(): string {
  const fromEnv = process.env["HOME"];
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  try {
    // libuv's `uv_os_get_passwd` → `getpwuid_r`'s `pw_dir`, the same fallback
    // `dirs` makes. `os.homedir()` is NOT this: it returns an empty `HOME`
    // verbatim and never consults the passwd entry.
    const fromPasswd = os.userInfo().homedir;
    if (fromPasswd !== "") {
      return fromPasswd;
    }
  } catch {
    // No passwd entry either — fall through to the refusal below.
  }
  throw new Error("Could not determine the home directory.");
}

/**
 * The fixed discovery path. Ported from `discovery_file`.
 *
 * `home` exists only so a test can point the whole seam at a temp directory
 * (the same reason `discovery.rs`'s own test drives `write_discovery_at`
 * against an explicit path); production callers pass nothing and get
 * {@link homeDir}'s faithful resolution.
 */
export function discoveryFile(home?: string): string {
  return path.join(home ?? homeDir(), ".arcelle", "leash.json");
}

/**
 * Write the record 0600, overwriting whatever is there. Ported from
 * `write_discovery_at`. The mode is enforced with an explicit `chmodSync`
 * too — passing `mode` to `writeFileSync` only applies when the file is
 * CREATED (the same caveat Rust's own comment makes about `OpenOptions`'
 * `.mode(0o600)`), and a pre-existing leftover must not keep looser
 * permissions.
 */
export function writeDiscoveryAt(filePath: string, value: LeashRecord): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

/** Ported from `write_discovery`. `home` is the test-only override
 * {@link discoveryFile} documents. */
export function writeDiscovery(
  port: number,
  token: string,
  scope: string,
  room: string,
  home?: string
): void {
  writeDiscoveryAt(discoveryFile(home), leashJson(port, token, scope, room));
}

/**
 * Remove the discovery record (stop / teardown / app exit). Ported from
 * `remove_discovery`. Best-effort and idempotent — a missing file is fine,
 * matching Rust's `if let Ok(path) = discovery_file(app) { let _ =
 * std::fs::remove_file(path); }`: BOTH an unresolvable home directory and a
 * failed removal (missing file, permissions, …) are swallowed, never thrown.
 */
export function removeDiscovery(home?: string): void {
  try {
    fs.rmSync(discoveryFile(home), { force: true });
  } catch {
    // Intentionally ignored — best-effort, same as Rust's `let _ = ...`.
  }
}
