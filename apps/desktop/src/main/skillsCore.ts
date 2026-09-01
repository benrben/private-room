/** Cohesive extraction from skillsCmds.ts; its public API remains on that module. */
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

import {
  createSkill as createSkillDb,
  deleteSkill as deleteSkillDb,
  deleteSkillResource as deleteSkillResourceDb,
  findSkill as findSkillDb,
  getSkill as getSkillDb,
  getSkillResource as getSkillResourceDb,
  listSkillResources as listSkillResourcesDb,
  listSkills as listSkillsDb,
  setSkillEnabled as setSkillEnabledDb,
  updateSkill as updateSkillDb,
  upsertSkillResource as upsertSkillResourceDb,
  SKILL_GONE,
  type Skill,
  type SkillResource,
  type SkillSummary,
} from "./db-host/skills.js";
import { findFileLike, getFileExtractedText, getFileMeta } from "./db-host/files.js";
import { CancelFlag } from "./cancel.js";
import { executeScriptInWorkspace, type Runner, type ScriptManifest } from "./scriptRun.js";
import { approveScriptBytes as approveScriptBytesReal } from "./scriptConsent.js";
import { DELETE_DECLINED } from "./mcpConfig.js";
import { SKILL_AGENT_IDS } from "./toolSpecs.js";
import { clampBytes } from "./textClamp.js";
import type { OpenRoom } from "./turnEngine.js";
import { listModels } from "./engineRouting.js";
import { modelSetting } from "./gatherContext.js";
import { recoverJson } from "./ollamaGenerate.js";
import { defaultResolvedModel } from "./workflowModel.js";
import { generateTextAnyEngine, withRealOllamaGenerate } from "./workflowCompose.js";
import { parseSkillMd } from "./skillsResources.js";
// ============================================================================
// Constants — skills.rs's own module-level `const`s, verbatim values.
// ============================================================================

export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 2_000;
export const MAX_INSTRUCTIONS = 200_000;
export const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 128 * 1024 * 1024;
export const MAX_RESOURCES = 250;
export const MAX_COMPOSE_SOURCE_FILES = 12;
export const MAX_COMPOSE_SOURCE_PROMPT_CHARS = 48_000;
export const MAX_COMPOSE_SOURCE_PROMPT_PER_FILE = 12_000;
export const MAX_COMPOSE_SOURCE_SNAPSHOT_CHARS = 500_000;
export const MAX_COMPOSE_SOURCE_SNAPSHOT_TOTAL_CHARS = 4_000_000;

// ============================================================================
// Small local helpers
// ============================================================================

/** Best-effort renderer notification (`emit_skills_changed`). Every command
 * that MUTATES emits; the read-only ones (`get_skill`, `list_skills`,
 * `skill_import_conflict`, `export_skill_folder`, `skill_agent_ids`) do not —
 * exactly the set Rust's own commands emit from. */
export type EmitFn = (event: string, payload: unknown) => void;

export function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = window.emit(...)`.
  }
}

export function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function asciiLowerCode(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

/** `str::eq_ignore_ascii_case` — ASCII-only folding. Deliberately NOT
 * `toLowerCase()`: JS folds the full Unicode table, so `K` (U+212A) would
 * equal `k` and `İ` would grow a code unit mid-comparison, both of which
 * invent path collisions Rust never reports. */
export function eqIgnoreAsciiCase(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (asciiLowerCode(a.charCodeAt(i)) !== asciiLowerCode(b.charCodeAt(i))) return false;
  }
  return true;
}

/**
 * Mirrors Rust's `str::lines()`: split on `\n`, strip ONE trailing `\r` from
 * each element, and — unlike a bare `split("\n")` — produce no trailing empty
 * element for a string that ends in `\n`. {@link parseSkillMd} indexes this
 * array exactly the way the Rust source indexes its own
 * `text.lines().collect::<Vec<_>>()`, so the two must agree element for
 * element or `body_start` and the instructions slice drift by a line — and a
 * CRLF-authored SKILL.md would carry its `\r`s into the database.
 */
export function rustLines(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

// ============================================================================
// requireSkill — the existence guard Save and Enable/Disable both run before
// writing, because `UPDATE … WHERE id=?` matching no rows is a SUCCESS in
// SQLite. Ported from `require_skill`.
// ============================================================================

/**
 * Resolve a skill by id, or fail with {@link SKILL_GONE}. `findSkill` matches
 * by id OR by name (case-insensitively), so the `.id === id` filter — Rust's
 * own `.filter(|s| s.id == id)` — is load-bearing: an `id` argument that
 * happens to spell a DIFFERENT skill's NAME must never resolve to that skill.
 */
export function requireSkill(db: Database.Database, id: string): Skill {
  const found = findSkillDb(db, id);
  if (found === null || found.id !== id) {
    throw new Error(SKILL_GONE);
  }
  return found;
}

// ============================================================================
// Wire types — mirror the Rust `#[derive(Serialize)]` structs verbatim,
// including `Option<String>` serializing as an explicit `null` (no
// `skip_serializing_if`), which the renderer's shape depends on.
// ============================================================================

export interface SkillResourceMeta {
  path: string;
  kind: string;
  sizeBytes: number;
  text: boolean;
  updatedAt: string;
}

export interface SkillBundle {
  skill: Skill;
  resources: SkillResourceMeta[];
}

export interface SkillResourceContent {
  path: string;
  kind: string;
  text: string | null;
  dataB64: string | null;
}

// ============================================================================
// Validation — ported from `validate_skill_name`/`validate_skill_fields`/
// `validate_skill_agent`/`skill_owner_to_store`. Throwing rather than
// Result-shaped: Rust's `Result<T, String>` + `?` maps directly onto a thrown
// `Error` that an `ipcMain.handle` caller awaits and catches, and every
// consumer in this file propagates rather than inspects.
// ============================================================================

/** Ported from `validate_skill_name`. Returns the cleaned name. */
export function validateSkillName(name: string): string {
  const n = name.trim().toLowerCase().replace(/[ _]/g, "-");
  if (n === "") {
    throw new Error("Give the skill a name.");
  }
  if (n.length > MAX_NAME || n.startsWith("-") || n.endsWith("-") || !/^[a-z0-9-]+$/.test(n)) {
    throw new Error(
      "Skill names must be 1–64 lowercase letters, numbers, or hyphens, without a leading or trailing hyphen."
    );
  }
  return n;
}

/**
 * Ported from `validate_skill_fields`. Returns the cleaned NAME; description
 * and instructions are checked but returned unmodified (every real caller
 * stores them trimmed itself). Both caps count Unicode SCALAR VALUES
 * (`[...s].length`), matching Rust's `chars().count()` rather than a
 * UTF-16-code-unit `.length`.
 */
export function validateSkillFields(name: string, description: string, instructions: string): string {
  const cleanedName = validateSkillName(name);
  const desc = description.trim();
  if (desc === "") {
    throw new Error("Describe what the skill does and when the assistant should use it.");
  }
  if ([...desc].length > MAX_DESCRIPTION) {
    throw new Error(`Keep the skill description under ${MAX_DESCRIPTION} characters.`);
  }
  if ([...instructions].length > MAX_INSTRUCTIONS) {
    throw new Error("SKILL.md is too large. Move detailed material into references/.");
  }
  return cleanedName;
}

/**
 * Ported from `validate_skill_agent`. A skill scoped to an id no worker has is
 * invisible forever — never offered to a specialist, never surfaced — and one
 * mistyped character ("file.read") used to produce exactly that, silently.
 * EVERY seam that accepts an owner runs this: the model's `save_skill`, a
 * folder import, and (AUDIT defect 111) the two Settings-side saves via
 * {@link skillOwnerToStore}. Empty is the GENERAL case every agent sees, so it
 * stays allowed.
 */
export function validateSkillAgent(agent: string): void {
  const a = agent.trim();
  if (a === "" || SKILL_AGENT_IDS.includes(a)) {
    return;
  }
  throw new Error(
    `agent must be one of: ${SKILL_AGENT_IDS.join(", ")} — or omit it for a skill any agent may ` +
      `use. Got ${JSON.stringify(a)}; nothing was saved.`
  );
}

/**
 * Every owner a skill may be bound to, for the Skills screen's picker. Ported
 * from `skill_agent_ids` — a COPY of {@link SKILL_AGENT_IDS} itself, never a
 * hand-written second list, so the picker can never offer an id
 * {@link validateSkillAgent} would refuse (AUDIT 511). The general case (any
 * agent) is the empty string and is deliberately not in this list: it is not
 * an agent.
 */
export function skillAgentIds(): string[] {
  return [...SKILL_AGENT_IDS];
}

/**
 * Which owner a save should STORE, having checked it is a real agent. Ported
 * from `skill_owner_to_store`. `null`/`undefined` means "leave the binding
 * alone" — how the Settings editor saves without touching the owner — and
 * reads `existing`; `""` clears it back to the general case; anything else is
 * validated before it can be stored.
 */
export function skillOwnerToStore(
  incoming: string | null | undefined,
  existing: string | null | undefined
): string {
  if (incoming === null || incoming === undefined) {
    // Untouched: the stored value was validated when it was stored.
    return existing ?? "";
  }
  const owner = incoming.trim();
  validateSkillAgent(owner);
  return owner;
}

// ============================================================================
// Resource paths — ported from `normalize_skill_path`/`check_resource_paths`/
// `check_new_resource_path`/`stored_resource_key`/`skill_resource_kind`.
// ============================================================================

/**
 * Ported from `normalize_skill_path`, over Rust's real `Path::components()`
 * semantics (see this file's header):
 *   - absolute paths, `..` anywhere, and a LEADING `.` are refused;
 *   - a `.` in the middle is normalized away, and `a//b` collapses — the
 *     stored path is exactly what the export and script-run seams re-create;
 *   - a trailing `/` is refused outright: a resource is a FILE, and a folder
 *     is only ever implied by the file inside it (a stored `references/` was a
 *     nameless row in the folder pane and an export that died on `os error 2`);
 *   - `SKILL.md` in any case is refused — it is edited through the skill
 *     fields;
 *   - the 240 cap counts BYTES (`raw.len()`), so a long non-Latin path is
 *     refused here exactly as Rust refuses it.
 */
export function normalizeSkillPath(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, "/");
  validateSkillPathShape(trimmed);
  const parts = normalizedSkillPathParts(trimmed);
  return parts.join("/");
}

export function validateSkillPathShape(path: string): void {
  if (path === "" || Buffer.byteLength(path, "utf8") > 240) {
    throw new Error("Use a short relative resource path.");
  }
  if (path.endsWith("/")) {
    throw new Error('A resource path must name a file, not a folder — remove the trailing "/".');
  }
  if (isEscapingSkillPath(path)) {
    throw new Error(
      "Resource paths must stay inside the skill folder; SKILL.md is edited through the skill fields."
    );
  }
}

export function isEscapingSkillPath(path: string): boolean {
  return path.startsWith("/") || path.toLowerCase() === "skill.md" || hasEscapingSkillPathComponent(path);
}

export function hasEscapingSkillPathComponent(path: string): boolean {
  const components = path.split("/");
  // `..` is never normalized away by `Path::components()`; a `.` is, EXCEPT
  // at the very beginning of the path, where it stays a `CurDir` component.
  return components.some((part) => part === "..") || components.filter((part) => part !== "")[0] === ".";
}

export function normalizedSkillPathParts(path: string): string[] {
  return path.split("/").filter((part) => part !== "" && part !== ".");
}

/**
 * The key a DELETE matches a stored row on. Ported from `stored_resource_key`,
 * and deliberately LOOSER than {@link normalizeSkillPath}: rows written before
 * that rule tightened keep their old spelling, and running a delete through
 * the CREATE rule either refused the path the folder pane is showing or looked
 * for a key no row has — leaving a resource nothing could take out. Nothing
 * here reaches the filesystem; a key that matches nothing is already reported
 * as "That skill has no file at …".
 */
export function storedResourceKey(raw: string): string {
  return raw.trim().replace(/\\/g, "/");
}

export const SKILL_RESOURCE_KINDS: ReadonlyMap<string, string> = new Map([
  ["scripts", "script"],
  ["references", "reference"],
  ["assets", "asset"],
  ["agents", "agent"],
]);

/** Ported from `skill_resource_kind`. */
export function skillResourceKind(path: string): string {
  const kind = SKILL_RESOURCE_KINDS.get(path.split("/")[0] as string);
  return kind === undefined ? "resource" : kind;
}

/**
 * The one filesystem rule a skill's resource paths must obey together: no path
 * may be a FOLDER prefix of another. `references` and `references/policy.md`
 * can both live in the database but never on disk — and both Export folder and
 * every script run materialize the whole tree, so one of the two writes always
 * failed, taking the export (and the destination folder it had just made) with
 * it. Ported from `check_resource_paths`.
 */
export function checkResourcePaths(paths: readonly string[]): void {
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (resourcePathsCollide(paths[i]!, paths[j]!)) {
        const [dir, under] = orderedResourcePaths(paths[i]!, paths[j]!);
        throw new Error(
          `"${dir}" and "${under}" can't both be in one skill: a file and a folder cannot share a name. Rename one of them.`
        );
      }
    }
  }
}

export function orderedResourcePaths(a: string, b: string): [string, string] {
  return a.length < b.length ? [a, b] : [b, a];
}

export function resourcePathsCollide(a: string, b: string): boolean {
  const [dir, under] = orderedResourcePaths(a, b);
  // macOS folds case, so `References` and `references/x.md` collide there
  // just as surely — but ASCII-fold only, per Rust.
  return under.length > dir.length && under[dir.length] === "/" && eqIgnoreAsciiCase(under.slice(0, dir.length), dir);
}

/** {@link checkResourcePaths} for ONE incoming path against what the skill
 * already holds — the write seams (the editor's New file path, the model's
 * `write_skill_resource`). Re-saving an existing path is not a collision.
 * Ported from `check_new_resource_path`. */
export function checkNewResourcePath(db: Database.Database, skillId: string, path: string): void {
  const paths = listSkillResourcesDb(db, skillId)
    .map((r) => r.path)
    .filter((p) => p !== path);
  paths.push(path);
  checkResourcePaths(paths);
}

export const TEXT_EXTENSIONS = new Set([
  "md",
  "txt",
  "py",
  "js",
  "ts",
  "tsx",
  "jsx",
  "json",
  "yaml",
  "yml",
  "toml",
  "csv",
  "html",
  "css",
  "sh",
  "sql",
  "xml",
  "svg",
]);

/** `Path::extension()`'s exact rule over the last `/`-separated component: no
 * dot → no extension; a single dot at position 0 (a dotfile like `.gitignore`)
 * → no extension; otherwise everything after the final dot. */
export function extensionOfPath(path: string): string {
  const base = path.split("/").pop() ?? "";
  const lastDot = base.lastIndexOf(".");
  if (lastDot === -1) return "";
  if (lastDot === 0) return "";
  return base.slice(lastDot + 1).toLowerCase();
}

/** Ported from `is_text_path` — valid UTF-8 AND a whitelisted extension. */
export function isTextPath(path: string, bytes: Uint8Array): boolean {
  if (tryDecodeUtf8(bytes) === null) return false;
  return TEXT_EXTENSIONS.has(extensionOfPath(path));
}
