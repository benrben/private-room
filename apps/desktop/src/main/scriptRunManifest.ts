/** Cohesive extraction from scriptRun.ts; its public API remains on that module. */
import { spawn, spawnSync, type ChildProcess, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";

import type { CancelFlag } from "./cancel.js";
import { extractText } from "./editMatch.js";
import { extensionOf } from "./editMatchExtraction.js";
import {
  fileByExactName,
  findFileLike,
  getFileBytes,
  getFileBytesNamed,
  getFileMeta,
  inTransaction,
  insertFile,
  listFiles,
  updateFileContent,
  type FileMeta,
} from "./db-host/files.js";
import { snapshotFileVersion } from "./db-host/versions.js";
import { pinnedDb, type RoomSource } from "./jobs.js";
import { clampBytesMarked } from "./textClamp.js";
import type { ScriptManifest } from "../shared/apiTypes.js";
import { createRoomFile, readRoomFile, writeRoomFile } from "./workspace/roomContent.js";

export type { ScriptManifest };
// ============================================================================
// Constants — script_run.rs's own module-level `const`s, verbatim values.
// ============================================================================

/** Default script timeout (seconds) — the first `uv` run resolves and
 * downloads wheels, so the default is generous. */
export const DEFAULT_TIMEOUT_SECS = 600;
export const MIN_TIMEOUT_SECS = 5;
export const MAX_TIMEOUT_SECS = 3600;
/** Stdout/stderr are drained into 32 KB ring tails. */
export const RING_BYTES = 32 * 1024;
/** How many times the uv runner will auto-install a missing package and retry
 * before giving up (one new package per round). Bounds the loop; enough for a
 * typical data-science script (pandas + yfinance + a couple more). */
export const MAX_HEAL_ROUNDS = 8;
/** Auto-import caps for NEW (undeclared) files a script creates (decision 2). */
export const MAX_NEW_FILES = 20;
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
/** Cap on room files auto-materialized by name-reference (read side). Bounds
 * the pre-run copy so a room with a huge file list can't balloon the
 * workspace; matches beyond the cap are skipped (a script can still declare
 * them via `# room-inputs:`). */
export const MAX_AUTO_MATERIALIZE = 20;
/** Grace between SIGTERM and SIGKILL when killing the process group. */
export const KILL_GRACE_MS = 5_000;
/** How long to wait for the stdout/stderr streams to reach EOF after the
 * script exits, before reporting the tails we have. */
export const READER_FLUSH_GRACE_MS = 2_000;
/** Total wall-clock budget for one script node, as a multiple of the script's
 * own timeout. The auto-heal loop re-runs the whole script once per missing
 * package, and each attempt used to get the FULL timeout again with no overall
 * cap — eight rounds of a 10-minute script held the single background slot for
 * an hour and a half while everything else waited. */
export const TOTAL_TIMEOUT_MULTIPLE = 2;
/** How often the run loop notices a Stop, matching Rust's 250ms poll. */
export const CANCEL_POLL_MS = 250;
/** The exact PATH handed to every script. Never `process.env.PATH`. */
export const SPAWN_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";
/** The sentinel a cancelled run rejects with — callers compare by message,
 * exactly as the Rust source's `Err("STOPPED".into())` is compared. */
export const STOPPED = "STOPPED";

// ============================================================================
// Manifest
// ============================================================================

/** A script's language, from its file extension — the wire form of Rust's
 * `ScriptLang` (`#[serde(rename_all = "snake_case")]`), which is exactly
 * `ScriptManifest.interpreter`'s type in `apiTypes.ts`. */
export type ScriptLang = ScriptManifest["interpreter"];

/** Where a script surfaces as a one-click shortcut (decision 3). `file` = the
 * headers of its declared input/output files; `global` = the TopBar; `none` =
 * no shortcut (still runnable from the Scripts page + file header). */
export type Shortcut = ScriptManifest["shortcut"];

/** `ScriptManifest::has_deps` — a plain function, since a TS interface carries
 * no behaviour. */
export function hasDeps(manifest: ScriptManifest): boolean {
  return manifest.deps.length > 0;
}

/** Language for a file name; `null` if it isn't a script we run. */
export function scriptLangOf(name: string): ScriptLang | null {
  const ext = extensionOf(name);
  if (ext === "py") return "py";
  if (ext === "js") return "js";
  return null;
}

/**
 * Resolve a `script_run` node's `file` (a stored file id, OR a name) to
 * (id, real name, bytes).
 *
 * The ONE resolver. Consent stamping, the manual consent card and the executor
 * each grew their own copy in Rust, and because a name resolves to "the newest
 * file with a matching name" they could disagree the moment a similarly named
 * file arrived between approving a script and running it — the run then parked
 * with "isn't approved on this Mac yet" for a script just approved.
 */
export interface ResolvedScriptFile {
  id: string;
  name: string;
  bytes: Buffer;
}

export function resolveScriptFile(db: Database.Database, file: string): ResolvedScriptFile {
  // An exact id first, then a fuzzy name match (the agent passes names).
  let id: string;
  try {
    getFileBytesNamed(db, file);
    id = file;
  } catch {
    id = findFileLike(db, file)[0];
  }
  const [name, bytes] = getFileBytesNamed(db, id);
  return { id, name, bytes: bytes ?? Buffer.alloc(0) };
}

/** SHA-256 (hex) of the script's raw bytes — the content-addressed consent key
 * (the `text_digest` idea, over bytes). Any edit changes the hash → the old
 * approval no longer counts, so a changed script re-prompts for free. */
export function scriptFingerprint(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** If `content` (with `lower` its lowercase) begins with `key:`, return the raw
 * value after the colon (original case preserved for file names). */
export function stripKey(lower: string, content: string, key: string): string | null {
  const want = `${key}:`;
  return lower.startsWith(want) ? content.slice(want.length) : null;
}

/** Comma-separated file names → trimmed, non-empty list. */
export function splitNames(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function isQuote(char: string | undefined): boolean {
  return char === '"' || char === "'";
}

export function quotedToken(source: string, start: number): { readonly token: string; readonly next: number } {
  const quote = source[start]!;
  let end = start + 1;
  while (end < source.length && source[end] !== quote) end += 1;
  return { token: source.slice(start + 1, end).trim(), next: end + 1 };
}

/** Pull the quoted strings out of a `dependencies = ["a", "b"]` line.
 * Tolerant: it does not require valid TOML, just the quoted tokens. */
export function extractQuoted(source: string): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < source.length) {
    if (!isQuote(source[index])) {
      index += 1;
      continue;
    }
    const { token, next } = quotedToken(source, index);
    if (token !== "") out.push(token);
    index = next;
  }
  return out;
}

/** Strict base-10 unsigned parse mirroring Rust's `str::parse::<u64>()`: every
 * character must be a digit or the whole parse fails — unlike
 * `Number.parseInt`, which happily reads the numeric PREFIX off "12abc". */
export function parseU64(s: string): number | null {
  const t = s.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

export interface ManifestFields {
  deps: string[];
  inputs: string[];
  outputs: string[];
  timeoutSecs: number | null;
  shortcut: Shortcut | null;
  depsSeen: boolean;
  inputsSeen: boolean;
  outputsSeen: boolean;
}

export function emptyManifestFields(): ManifestFields {
  return {
    deps: [],
    inputs: [],
    outputs: [],
    timeoutSecs: null,
    shortcut: null,
    depsSeen: false,
    inputsSeen: false,
    outputsSeen: false,
  };
}

export function manifestComment(raw: string, prefix: string): string | null {
  const line = raw.trimStart();
  return line.startsWith(prefix) ? line.slice(prefix.length).trim() : null;
}

export function applyDependencies(fields: ManifestFields, content: string, lower: string): boolean {
  if (fields.depsSeen || !lower.startsWith("dependencies") || !content.includes("=")) return false;
  fields.deps = extractQuoted(content);
  fields.depsSeen = true;
  return true;
}

export function applyInputs(fields: ManifestFields, content: string, lower: string): boolean {
  const value = stripKey(lower, content, "room-inputs");
  if (fields.inputsSeen || value === null) return false;
  fields.inputs = splitNames(value);
  fields.inputsSeen = true;
  return true;
}

export function applyOutputs(fields: ManifestFields, content: string, lower: string): boolean {
  const value = stripKey(lower, content, "room-outputs");
  if (fields.outputsSeen || value === null) return false;
  fields.outputs = splitNames(value);
  fields.outputsSeen = true;
  return true;
}

export function applyTimeout(fields: ManifestFields, content: string, lower: string): boolean {
  const value = stripKey(lower, content, "room-timeout");
  if (fields.timeoutSecs !== null || value === null) return false;
  const seconds = parseU64(value);
  if (seconds !== null) fields.timeoutSecs = Math.min(Math.max(seconds, MIN_TIMEOUT_SECS), MAX_TIMEOUT_SECS);
  return true;
}

export function applyShortcut(fields: ManifestFields, content: string, lower: string): boolean {
  const value = stripKey(lower, content, "room-shortcut");
  if (fields.shortcut !== null || value === null) return false;
  const shortcut = parseShortcut(value);
  if (shortcut !== null) fields.shortcut = shortcut;
  return true;
}

export function parseShortcut(value: string): Shortcut | null {
  switch (value.trim().toLowerCase()) {
    case "global":
    case "file":
    case "none":
      return value.trim().toLowerCase() as Shortcut;
    default:
      return null;
  }
}

export const MANIFEST_FIELD_READERS: ReadonlyArray<(fields: ManifestFields, content: string, lower: string) => boolean> = [
  applyDependencies,
  applyInputs,
  applyOutputs,
  applyTimeout,
  applyShortcut,
];

export function applyManifestComment(fields: ManifestFields, content: string): void {
  const lower = content.toLowerCase();
  for (const reader of MANIFEST_FIELD_READERS) {
    if (reader(fields, content, lower)) return;
  }
}

export function resolvedManifestShortcut(fields: ManifestFields): Shortcut {
  if (fields.shortcut !== null) return fields.shortcut;
  if (fields.inputs.length === 0 && fields.outputs.length === 0) return "none";
  return "file";
}

export function manifestLanguage(name: string): ScriptLang {
  return scriptLangOf(name) ?? "py";
}

export function manifestCommentPrefix(lang: ScriptLang): string {
  return lang === "py" ? "#" : "//";
}

export function applyManifestText(fields: ManifestFields, text: string, prefix: string): void {
  for (const raw of text.split("\n").slice(0, 64)) {
    const content = manifestComment(raw, prefix);
    if (content !== null) applyManifestComment(fields, content);
  }
}

/**
 * Parse the manifest from a script's text (decision 3's grammar). Pure — no
 * I/O. Scans the first 64 lines; comment prefix `#` for `.py`, `//` for `.js`;
 * first occurrence of each key wins; keys are case-insensitive. A missing
 * PEP-723 block means self-contained (no deps).
 */
export function parseScriptManifest(name: string, text: string): ScriptManifest {
  const lang = manifestLanguage(name);
  const fields = emptyManifestFields();
  applyManifestText(fields, text, manifestCommentPrefix(lang));
  return {
    interpreter: lang,
    deps: fields.deps,
    inputs: fields.inputs,
    outputs: fields.outputs,
    timeoutSecs: fields.timeoutSecs ?? DEFAULT_TIMEOUT_SECS,
    shortcut: resolvedManifestShortcut(fields),
  };
}
