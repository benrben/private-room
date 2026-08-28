/**
 * roomai — a tiny, honest, offline CLI for a Arcelle file.
 *
 * Ported from `src-tauri/src/bin/roomai.rs` (the whole file, including its
 * module doc comment and every `#[test]`).
 *
 * It reuses the app's own db-host modules (`open.ts` / `recovery.ts` /
 * `meta.ts`) so it opens rooms with the exact same SQLCipher scheme the app
 * uses — no second code path to drift out of sync. Nothing here touches the
 * network or a model; it only decrypts a local file and reads or copies out
 * what is already inside.
 *
 * Subcommands: verify / info / recover / export. Secrets come from the
 * environment ONLY (ROOMAI_PASSWORD / ROOMAI_RECOVERY). There is
 * deliberately no --password / --code flag: on macOS every process running
 * as you can read another's argv (`ps -ww`, /proc equivalents, any
 * monitoring agent), so a room password typed on the command line is
 * readable by anything on the machine — and lands in shell history besides.
 * The flags used to exist as an "escape hatch"; the environment is the
 * escape hatch.
 *
 * Splitting `parseArgs` (pure) from the `do*` functions (real filesystem/DB
 * work) keeps argument handling pure and unit-testable (no room, no
 * filesystem) — mirrored from the Rust module's own `parse`/`run` split,
 * called out in its doc comment.
 *
 * Exit codes: 0 ok, 1 runtime error, 2 usage.
 *
 * NOTE (deviation from the Rust source, deliberate): the Rust `do_verify` /
 * `do_info` / `do_recover` / `do_export` each call `println!` themselves as
 * they go. Here the `do*` functions instead BUILD and RETURN the output as a
 * string, and only `main()` prints it, so the formatting logic is testable
 * without capturing real stdout. The exact text (including the blank line
 * Rust's `print_meta_dump`'s leading `println!("\nMeta:")` puts between the
 * OK banner and the "Meta:" section) is preserved.
 *
 * NOTE (deviation, deliberate): `main()` here does not call `process.exit()`
 * itself — it returns the exit code so it stays testable. A real bin
 * entrypoint wires that up (see the bottom of this file).
 */

import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { openRoom, openRoomReadonly } from "../src/main/db-host/open.js";
import { openWithRecovery } from "../src/main/db-host/recovery.js";
import { getMeta } from "../src/main/db-host/meta.js";

// ------------------------------------------------------------------ usage

export const USAGE =
  "roomai — offline tools for a Arcelle file\n" +
  "\n" +
  "Usage:\n" +
  "  roomai verify  <path>           Check the file decrypts and is a valid room.\n" +
  "  roomai info    <path>           Verify, then dump the room's meta keys.\n" +
  "  roomai recover <path>           Open using a recovery code instead of a password.\n" +
  "  roomai export  <path> <outdir>  Write every stored file back out to a folder.\n" +
  "\n" +
  "Secrets (environment only — never on the command line, where any other\n" +
  "program running as you can read them):\n" +
  "  ROOMAI_PASSWORD   password for verify / info / export\n" +
  "  ROOMAI_RECOVERY   recovery code for recover\n" +
  "\n" +
  "Exit codes: 0 ok, 1 error, 2 usage.\n";

// ----------------------------------------------------------------- parsing

/**
 * A parsed command line. Splitting parse from run keeps argument handling
 * pure and unit-testable (no room, no filesystem).
 */
export type Command =
  | { kind: "verify"; path: string }
  | { kind: "info"; path: string }
  | { kind: "recover"; path: string }
  | { kind: "export"; path: string; outdir: string }
  /** No args, `help`, or `-h/--help`. Renders usage and exits 2. */
  | { kind: "help" };

/**
 * The two flags that used to carry a secret on the command line. Named
 * explicitly rather than falling through to "Unknown flag" so anyone with an
 * old script is told WHY it stopped working and what to do instead.
 */
function rejectSecretFlags(args: string[]): void {
  for (const a of args) {
    if (a === "--password" || a === "--code") {
      throw new Error(
        `\`${a}\` is no longer accepted: any program running as you can read another process's arguments, so a secret there is not private. Set ROOMAI_PASSWORD / ROOMAI_RECOVERY in the environment instead.`
      );
    }
  }
}

/**
 * Reject any leftover token that looks like a flag — catches typos such as
 * `--passwrod` before they get silently treated as a path.
 */
function rejectUnknownFlags(args: string[]): void {
  for (const a of args) {
    if (a.startsWith("-") && a !== "-") {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
}

function onePositional(args: string[], cmd: string, what: string): string {
  rejectUnknownFlags(args);
  if (args.length === 0) {
    throw new Error(`\`${cmd}\` needs a ${what}.`);
  }
  if (args.length === 1) {
    return args[0]!;
  }
  throw new Error(`\`${cmd}\` takes exactly one ${what}.`);
}

function twoPositionals(args: string[], cmd: string): [string, string] {
  rejectUnknownFlags(args);
  if (args.length !== 2) {
    throw new Error(`\`${cmd}\` needs <path> and <outdir>.`);
  }
  return [args[0]!, args[1]!];
}

/**
 * Parse `args` (already stripped of the program name — i.e. what
 * `process.argv.slice(2)` gives you) into a `Command`. Throws `Error(message)`
 * on any parse failure. No args, `help`, or `-h`/`--help` is
 * `{ kind: "help" }`, not a throw.
 */
export function parseArgs(args: string[]): Command {
  if (args.length === 0) {
    return { kind: "help" };
  }
  const cmd = args[0]!;
  const rest = args.slice(1);
  switch (cmd) {
    case "help":
    case "-h":
    case "--help":
      return { kind: "help" };
    case "verify":
    case "info": {
      rejectSecretFlags(rest);
      const path = onePositional(rest, cmd, "<path>");
      return cmd === "verify" ? { kind: "verify", path } : { kind: "info", path };
    }
    case "recover": {
      rejectSecretFlags(rest);
      const path = onePositional(rest, cmd, "<path>");
      return { kind: "recover", path };
    }
    case "export": {
      rejectSecretFlags(rest);
      const [path, outdir] = twoPositionals(rest, cmd);
      return { kind: "export", path, outdir };
    }
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

// --------------------------------------------------------------- secrets

/** Throws if `ROOMAI_PASSWORD` is unset/empty. */
export async function resolvePassword(): Promise<string> {
  const v = process.env.ROOMAI_PASSWORD;
  if (v !== undefined && v !== "") {
    return v;
  }
  throw new Error(
    "No password. Set ROOMAI_PASSWORD (never pass it as an argument — other programs on this Mac can read a process's arguments)."
  );
}

/** Throws if `ROOMAI_RECOVERY` is unset/empty. */
export async function resolveCode(): Promise<string> {
  const v = process.env.ROOMAI_RECOVERY;
  if (v !== undefined && v !== "") {
    return v;
  }
  throw new Error(
    "No recovery code. Set ROOMAI_RECOVERY (never pass it as an argument — other programs on this Mac can read a process's arguments)."
  );
}

// ---------------------------------------------------------------- helpers

/** The value, or "(unset)" when the key is missing. */
function metaOr(db: Database.Database, key: string): string {
  return getMeta(db, key) ?? "(unset)";
}

/**
 * Count rows in a table. The table name is always a hard-coded literal from
 * this file, never user input, so string interpolation is not an injection
 * surface.
 */
function countRows(db: Database.Database, table: string): number {
  try {
    const row = db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as
      | { c: number }
      | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/** Success banner shared by verify / info / recover. */
function formatOk(db: Database.Database): string {
  return [
    "OK: decrypts and is a valid Arcelle file.",
    `  format:         ${metaOr(db, "format")}`,
    `  format_version: ${metaOr(db, "format_version")}`,
    `  files:          ${countRows(db, "files")}`,
    `  chats:          ${countRows(db, "chats")}`,
  ].join("\n");
}

/**
 * The extra `info` section: the interesting meta keys, shown even when unset
 * so it's clear which ones a room does and doesn't carry.
 *
 * Starts with a blank line then "Meta:" — mirroring Rust's own
 * `println!("\nMeta:")`, which puts a blank line between the OK banner
 * `print_ok` already printed and this section.
 */
function formatMetaDump(db: Database.Database): string {
  const lines: string[] = ["", "Meta:"];
  for (const key of ["format", "format_version", "name", "embed_model", "embed_dim"]) {
    const v = getMeta(db, key);
    lines.push(v !== null ? `  ${key}: ${v}` : `  ${key}: (not set)`);
  }
  return lines.join("\n");
}

/** Close a db handle, swallowing an already-closed/double-close error — this
 * runs in a `finally`, so a close failure must never mask whatever error (if
 * any) is already propagating out of the try block. Mirrors the same
 * defensive pattern `open.ts`'s own error paths use around `db.close()`. */
function closeQuietly(db: Database.Database): void {
  try {
    db.close();
  } catch {
    // already closed / nothing to do
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Minimal filename hardening for export: keep only the final path component
 * and neutralise separators / NUL, so a stored name like `../../etc/passwd`
 * can never write outside the chosen output directory.
 */
export function sanitize(name: string): string {
  const segments = name.split(/[/\\]/);
  const base = segments[segments.length - 1] ?? name;
  let cleaned = "";
  for (const c of base) {
    cleaned += c === "/" || c === "\\" || c === "\0" ? "_" : c;
  }
  const trimmed = cleaned.trim();
  if (trimmed === "" || trimmed === "." || trimmed === "..") {
    return "unnamed";
  }
  return trimmed;
}

/**
 * Make `base` unique against `used` — seeded with the destination's
 * pre-existing filenames and every name handed out earlier in this export
 * run — so nothing gets silently clobbered. Appends ` (2)`, ` (3)`, … before
 * the extension. `used` holds LOWERCASED keys (and candidates are tested
 * lowercased) because APFS is case-insensitive by default; the returned name
 * keeps the original case.
 */
export function uniqueName(used: Set<string>, base: string): string {
  const lowerBase = base.toLowerCase();
  if (!used.has(lowerBase)) {
    used.add(lowerBase);
    return base;
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? `.${base.slice(dot + 1)}` : "";
  let n = 2;
  for (;;) {
    const candidate = `${stem} (${n})${ext}`;
    const lowerCandidate = candidate.toLowerCase();
    if (!used.has(lowerCandidate)) {
      used.add(lowerCandidate);
      return candidate;
    }
    n += 1;
  }
}

// --------------------------------------------------------------- commands

/**
 * CHECK, don't touch. `openRoom` always runs the schema migration and at
 * least one write, so "verify" used to fail outright on a copy sitting on a
 * read-only volume — and on a room not opened since the last schema change
 * it rebuilt the search index while claiming only to be looking. Uses
 * `openRoomReadonly` instead.
 */
export async function doVerify(path: string): Promise<string> {
  const password = await resolvePassword();
  const db = openRoomReadonly(path, password);
  try {
    return formatOk(db);
  } finally {
    closeQuietly(db);
  }
}

export async function doInfo(path: string): Promise<string> {
  const password = await resolvePassword();
  const db = openRoomReadonly(path, password);
  try {
    return formatOk(db) + "\n" + formatMetaDump(db);
  } finally {
    closeQuietly(db);
  }
}

export async function doRecover(path: string): Promise<string> {
  const code = await resolveCode();
  const db = await openWithRecovery(path, code);
  try {
    return formatOk(db);
  } finally {
    closeQuietly(db);
  }
}

export async function doExport(path: string, outdir: string): Promise<string> {
  const password = await resolvePassword();
  const db = openRoom(path, password);
  try {
    try {
      await fsp.mkdir(outdir, { recursive: true });
    } catch (err) {
      throw new Error(`Could not create ${outdir}: ${errMessage(err)}`);
    }

    // Trash: an export is "everything in this room", and a deleted file is
    // not in the room. Exporting it would also be the one way trashed bytes
    // could reach the plain filesystem — the whole point of keeping them
    // inside the room is that they never do.
    const rows = db
      .prepare(
        "SELECT name, original_bytes FROM files WHERE trashed_at IS NULL ORDER BY created_at, rowid"
      )
      .all() as { name: string; original_bytes: Buffer | null }[];

    // Never clobber what's already in the output folder: seed the dedupe
    // set with the names that exist there so uniqueName() steps past them.
    // Keys are lowercased because APFS is case-insensitive by default, so
    // "Report.pdf" would overwrite an existing "report.pdf".
    const used = new Set<string>();
    let entries: string[];
    try {
      entries = await fsp.readdir(outdir);
    } catch (err) {
      throw new Error(`Could not read ${outdir}: ${errMessage(err)}`);
    }
    for (const entry of entries) {
      used.add(entry.toLowerCase());
    }

    let written = 0;
    let skipped = 0;
    for (const row of rows) {
      // Rows can carry no original bytes (e.g. app-generated notes). Nothing
      // to write out — count it and move on rather than emit an empty file.
      if (row.original_bytes === null || row.original_bytes === undefined) {
        skipped += 1;
        continue;
      }
      const filename = uniqueName(used, sanitize(row.name));
      const dest = nodePath.join(outdir, filename);
      try {
        await fsp.writeFile(dest, row.original_bytes);
      } catch (err) {
        throw new Error(`Could not write ${dest}: ${errMessage(err)}`);
      }
      written += 1;
    }

    let summary = `Wrote ${written} file(s) to ${outdir}.`;
    if (skipped > 0) {
      summary += `\nSkipped ${skipped} row(s) with no stored bytes.`;
    }
    return summary;
  } finally {
    closeQuietly(db);
  }
}

// ------------------------------------------------------------------- main

/**
 * Top-level dispatch. Returns the process exit code and never throws on bad
 * input — every failure path maps to a clean stderr line and a non-zero
 * code. Does NOT call `process.exit()` itself, so it stays testable; a real
 * bin entrypoint wires that up (see the bottom of this file).
 */
export async function main(argv: string[]): Promise<number> {
  let cmd: Command;
  try {
    cmd = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${errMessage(err)}\n\n`);
    process.stderr.write(USAGE);
    return 2;
  }

  if (cmd.kind === "help") {
    process.stderr.write(USAGE);
    return 2;
  }

  try {
    let output: string;
    switch (cmd.kind) {
      case "verify":
        output = await doVerify(cmd.path);
        break;
      case "info":
        output = await doInfo(cmd.path);
        break;
      case "recover":
        output = await doRecover(cmd.path);
        break;
      case "export":
        output = await doExport(cmd.path, cmd.outdir);
        break;
    }
    console.log(output);
    return 0;
  } catch (err) {
    console.error(`Error: ${errMessage(err)}`);
    return 1;
  }
}

// A real bin entrypoint is intentionally NOT included in this file — wire up
//   main(process.argv.slice(2)).then((code) => process.exit(code));
// in a tiny separate script once this becomes the actual shipped CLI, so the
// exported surface above stays free of a top-level side effect.
