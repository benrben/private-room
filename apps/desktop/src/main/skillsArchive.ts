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
import { EmitFn, MAX_IMPORT_BYTES, MAX_RESOURCES, MAX_RESOURCE_BYTES, SkillBundle, SkillResourceContent, SkillResourceMeta, checkNewResourcePath, checkResourcePaths, emitSafely, errMessage, isTextPath, normalizeSkillPath, requireSkill, skillOwnerToStore, skillResourceKind, storedResourceKey, tryDecodeUtf8, validateSkillAgent, validateSkillFields } from "./skillsCore.js";
import { agentDeleteSkill } from "./skillsMutations.js";
import { ParsedSkillMd, parseSkillMd, renderSkillMd, safeExportName } from "./skillsResources.js";
import { registerSkillsIpc } from "./skillsRuntime.js";
// ============================================================================
// Settings-screen commands — ported from the `#[tauri::command]` functions of
// the same names. Each MUTATING one emits `skills-changed` itself, exactly as
// Rust's own commands call `emit_skills_changed`, so a caller that reaches the
// logic directly (not through {@link registerSkillsIpc}) still notifies.
// ============================================================================

/** Ported from `list_skills` (the command) — the DB summary shape directly,
 * no projection, exactly as Rust returns `Vec<db::SkillSummary>`. */
export function listSkillsCmd(db: Database.Database): SkillSummary[] {
  return listSkillsDb(db, false);
}

/** Ported from `get_skill`. */
export function getSkillCmd(db: Database.Database, id: string): SkillBundle {
  const skill = getSkillDb(db, id);
  const resources: SkillResourceMeta[] = listSkillResourcesDb(db, id).map((r: SkillResource) => ({
    path: r.path,
    kind: r.kind,
    sizeBytes: r.content.length,
    text: isTextPath(r.path, r.content),
    updatedAt: r.updatedAt,
  }));
  return { skill, resources };
}

/** Ported from `create_skill`. A human-facing save NEVER forces `enabled` —
 * it creates disabled because that is what Rust's `create_skill` passes, and
 * {@link setSkillEnabledCmd} is the only way on. */
export function createSkillCmd(
  db: Database.Database,
  name: string,
  description: string,
  instructions: string,
  agent?: string | null,
  emit?: EmitFn
): string {
  const cleanedName = validateSkillFields(name, description, instructions);
  const owner = skillOwnerToStore(agent, null);
  const id = createSkillDb(db, cleanedName, description.trim(), instructions.trim(), false, "user", owner);
  emitSafely(emit, "skills-changed", undefined);
  return id;
}

/** Ported from `update_skill`. */
export function updateSkillCmd(
  db: Database.Database,
  id: string,
  name: string,
  description: string,
  instructions: string,
  agent?: string | null,
  emit?: EmitFn
): void {
  const cleanedName = validateSkillFields(name, description, instructions);
  // `UPDATE … WHERE id=?` matches no rows and still succeeds, so a skill
  // deleted while its editor was open reported "Saved" and kept nothing. Read
  // it first and fail honestly instead.
  const existing = requireSkill(db, id);
  // Omitted = "leave the binding alone" (the editor form may not send it);
  // anything else is checked before it can be stored (AUDIT defect 111).
  const owner = skillOwnerToStore(agent, existing.agent);
  updateSkillDb(db, id, cleanedName, description.trim(), instructions.trim(), owner);
  emitSafely(emit, "skills-changed", undefined);
}

/**
 * Ported from `set_skill_enabled` — the ONE seam in the whole module that can
 * set `enabled = true`, and it is reachable only from the Skills screen a
 * human is looking at. Enabling re-validates the STORED fields (a skill saved
 * before a rule tightened must still pass it to come back on); disabling only
 * needs the existence check, but needs it: turning off a skill that was
 * already deleted must not report success either.
 */
export function setSkillEnabledCmd(db: Database.Database, id: string, enabled: boolean, emit?: EmitFn): void {
  if (enabled) {
    // Not a bare `getSkill`: for a skill deleted out from under the editor
    // that answers with the driver's own "Query returned no rows", while the
    // disable half of this same command says SKILL_GONE.
    const s = requireSkill(db, id);
    validateSkillFields(s.name, s.description, s.instructions);
    setSkillEnabledDb(db, id, true);
  } else {
    requireSkill(db, id);
    setSkillEnabledDb(db, id, false);
  }
  emitSafely(emit, "skills-changed", undefined);
}

/**
 * Ported from the Settings-side `delete_skill` — deliberately NOT
 * {@link requireSkill}-guarded, unlike every other write here, and with no
 * confirmation gate: the click on the Skills screen IS the confirmation, and
 * Rust's own command is a bare `db::delete_skill`. Deleting an already-absent
 * skill satisfies the caller's intent either way, which is why
 * `db-host/skills.ts`'s `deleteSkill` is `executeOne` (no-rows-is-fine) rather
 * than `executeExisting`. Compare {@link agentDeleteSkill}, which must ask.
 */
export function deleteSkillCmd(db: Database.Database, id: string, emit?: EmitFn): void {
  deleteSkillDb(db, id);
  emitSafely(emit, "skills-changed", undefined);
}

/** Ported from `get_skill_resource`. `text` and `dataB64` are explicit
 * `null`s, never absent keys: Rust's `Option<String>` fields carry no
 * `skip_serializing_if`, so the renderer sees `null`. */
export function getSkillResourceCmd(
  db: Database.Database,
  skillId: string,
  path: string
): SkillResourceContent {
  const normalized = normalizeSkillPath(path);
  const r = getSkillResourceDb(db, skillId, normalized);
  const text = tryDecodeUtf8(r.content);
  return {
    path: r.path,
    kind: r.kind,
    text,
    dataB64: text === null ? r.content.toString("base64") : null,
  };
}

/**
 * `base64::engine::general_purpose::STANDARD.decode` — STRICT: standard
 * alphabet, canonical padding, no whitespace, no stray characters. Node's own
 * `Buffer.from(s, "base64")` is lenient — it silently drops what it does not
 * recognise and NEVER throws — so a `try/catch` around it is dead code and
 * malformed input becomes silent garbage bytes in the room. The same hazard
 * `externalAdvisor.ts`'s own `decodeBase64Strict` documents for image
 * attachments; that helper is not exported, hence this one.
 *
 * One deliberate gap: the Rust engine also rejects non-canonical TRAILING BITS
 * (`"AB=="`, whose final bits are not zero). Reproducing that would need a
 * hand-rolled decoder for no user-visible gain; the padding/alphabet/length
 * rules below are what actually separate "a real base64 payload" from "a typo".
 */
export function decodeBase64Strict(s: string): Buffer | null {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    return null;
  }
  return Buffer.from(s, "base64");
}

/** Ported from `save_skill_resource`. `text` wins over `dataB64` when both
 * are supplied, matching Rust's `(Some(t), _)` match arm. */
export function saveSkillResourceCmd(
  db: Database.Database,
  skillId: string,
  path: string,
  text?: string | null,
  dataB64?: string | null,
  emit?: EmitFn
): void {
  const normalized = normalizeSkillPath(path);
  const bytes = skillResourceBytes(text, dataB64);
  if (bytes.length > MAX_RESOURCE_BYTES) {
    throw new Error("That resource is too large (32 MB maximum).");
  }
  checkNewResourcePath(db, skillId, normalized);
  upsertSkillResourceDb(db, skillId, normalized, skillResourceKind(normalized), bytes);
  emitSafely(emit, "skills-changed", undefined);
}

export function skillResourceBytes(text: string | null | undefined, dataB64: string | null | undefined): Buffer {
  if (text !== null && text !== undefined) return Buffer.from(text, "utf8");
  if (dataB64 === null || dataB64 === undefined) {
    throw new Error("Provide text or binary resource content.");
  }
  return decodedSkillResourceBytes(dataB64);
}

export function decodedSkillResourceBytes(dataB64: string): Buffer {
  const decoded = decodeBase64Strict(dataB64);
  if (decoded === null) throw new Error("That resource is not valid base64.");
  return decoded;
}

/** Ported from the Settings-side `delete_skill_resource` — matches on
 * {@link storedResourceKey}, not {@link normalizeSkillPath}, so a legacy row
 * (a stored trailing slash) can still be removed. */
export function deleteSkillResourceCmd(
  db: Database.Database,
  skillId: string,
  path: string,
  emit?: EmitFn
): void {
  deleteSkillResourceDb(db, skillId, storedResourceKey(path));
  emitSafely(emit, "skills-changed", undefined);
}

// ============================================================================
// Folder import/export — ported from `collect_folder_files`/`import_into`/
// `import_skill_folder`/`skill_import_conflict`/`export_skill_folder`.
// ============================================================================

/**
 * Recursively collect a picked skill folder's real material into
 * `[relPath, bytes]` pairs, mutating `out` and `totalRef.value`. Ported from
 * `collect_folder_files`.
 *
 * The normal distribution shape of an Agent Skill is a git checkout, so the
 * folder the user picks usually carries `.git` and `.DS_Store`: those were
 * stored as encrypted resources — re-emitted on every export — or, once
 * history was big enough, tripped the 250-file cap and refused the whole
 * import with a size message that named the wrong cause. Every dot-entry is
 * skipped, as is the skill's own SKILL.md IN ANY CASE (a folder whose file is
 * spelled `skill.md`, which macOS opens and this import has already READ, used
 * to be refused with a message about paths escaping the skill folder).
 */
export function collectFolderFiles(
  root: string,
  dir: string,
  out: Array<[string, Buffer]>,
  totalRef: { value: number }
): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    collectFolderEntry(root, dir, entry, out, totalRef);
  }
}

export function collectFolderEntry(
  root: string,
  dir: string,
  entry: fs.Dirent,
  out: Array<[string, Buffer]>,
  totalRef: { value: number }
): void {
  if (entry.name.startsWith(".")) return;
  const full = nodePath.join(dir, entry.name);
  if (entry.isSymbolicLink()) throw new Error("Skill folders may not contain symbolic links.");
  if (entry.isDirectory()) {
    collectFolderFiles(root, full, out, totalRef);
    return;
  }
  if (!entry.isFile()) return;
  const resource = folderResourceFile(root, full);
  if (resource !== null) addFolderResource(resource, out, totalRef);
}

export function folderResourceFile(root: string, full: string): [string, Buffer] | null {
  // Rust's own `to_string_lossy().replace('\\', "/")`: a backslash in a
  // macOS filename becomes a separator here exactly as it does there.
  const relative = nodePath.relative(root, full).replace(/\\/g, "/");
  if (relative.toLowerCase() === "skill.md") return null;
  const path = normalizeSkillPath(relative);
  const bytes = fs.readFileSync(full);
  if (bytes.length > MAX_RESOURCE_BYTES) throw new Error(`${path} is larger than 32 MB.`);
  return [path, bytes];
}

export function addFolderResource(
  resource: readonly [string, Buffer],
  out: Array<[string, Buffer]>,
  totalRef: { value: number }
): void {
  totalRef.value += resource[1].length;
  if (totalRef.value > MAX_IMPORT_BYTES || out.length >= MAX_RESOURCES) {
    throw new Error("That skill folder is too large (250 files / 128 MB maximum).");
  }
  out.push([resource[0], resource[1]]);
}

/**
 * The body of {@link importSkillFolderCmd} over a plain connection — pure, so
 * the replace path's invariants (the id survives, the enabled state survives,
 * files the folder dropped are gone) are unit-testable without a room. Ported
 * from `import_into`.
 *
 * `replace` = "this is an UPDATE of the skill of that name". Without it a name
 * clash is simply refused, and the only way to install a newer version of a
 * skill was to delete the old one first — which also destroyed any file you
 * had hand-edited inside it, with no warning that it would (AUDIT 510).
 */
export function importInto(
  db: Database.Database,
  name: string,
  description: string,
  instructions: string,
  agent: string,
  files: ReadonlyArray<[string, Buffer]>,
  replace: boolean
): string {
  // A folder carrying both `references` and `references/policy.md` imports
  // fine and can then never be exported or run. Refuse it while the user is
  // still looking at the folder they picked.
  checkResourcePaths(files.map(([p]) => p));
  // `findSkill` matches by name case-insensitively, the same way every other
  // lookup does.
  const existing = replace ? findSkillDb(db, name) : null;
  if (existing !== null) {
    return replaceImportedSkill(db, existing.id, name, description, instructions, agent, files);
  }
  return createImportedSkill(db, name, description, instructions, agent, files);
}

export function replaceImportedSkill(
  db: Database.Database,
  id: string,
  name: string,
  description: string,
  instructions: string,
  agent: string,
  files: ReadonlyArray<[string, Buffer]>
): string {
  updateSkillDb(db, id, name, description, instructions, agent);
  saveImportedResources(db, id, files);
  removeDroppedImportedResources(db, id, files);
  return id;
}

export function createImportedSkill(
  db: Database.Database,
  name: string,
  description: string,
  instructions: string,
  agent: string,
  files: ReadonlyArray<[string, Buffer]>
): string {
  const id = createSkillDb(db, name, description, instructions, false, "import", agent);
  try {
    saveImportedResources(db, id, files);
  } catch (error) {
    bestEffortDeleteSkill(db, id);
    throw error;
  }
  return id;
}

export function saveImportedResources(db: Database.Database, id: string, files: ReadonlyArray<[string, Buffer]>): void {
  for (const [path, bytes] of files) {
    upsertSkillResourceDb(db, id, path, skillResourceKind(path), bytes);
  }
}

export function removeDroppedImportedResources(
  db: Database.Database,
  id: string,
  files: ReadonlyArray<[string, Buffer]>
): void {
  // Files the new folder no longer carries go too — a replace that left them
  // behind would leave the skill half old, half new, with nothing on screen
  // saying which halves.
  const incoming = new Set(files.map(([path]) => path));
  for (const resource of listSkillResourcesDb(db, id)) {
    if (!incoming.has(resource.path)) deleteSkillResourceDb(db, id, resource.path);
  }
}

/** Rust's `let _ = db::delete_skill(&room.conn, &id);` — the rollback of a
 * half-written skill must never REPLACE the error that caused it. */
export function bestEffortDeleteSkill(db: Database.Database, id: string): void {
  try {
    deleteSkillDb(db, id);
  } catch {
    // Intentionally ignored.
  }
}

/** Ported from `import_skill_folder`. */
export function importSkillFolderCmd(
  db: Database.Database,
  folderPath: string,
  replace?: boolean | null,
  emit?: EmitFn
): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(folderPath);
  } catch {
    throw new Error("Choose a skill folder containing SKILL.md.");
  }
  if (!stat.isDirectory()) {
    throw new Error("Choose a skill folder containing SKILL.md.");
  }
  let skillMd: string;
  try {
    skillMd = fs.readFileSync(nodePath.join(folderPath, "SKILL.md"), "utf8");
  } catch {
    throw new Error("That folder has no readable SKILL.md.");
  }
  const { name, description, agent, instructions } = parseSkillMd(skillMd);
  // The import seam validates `agent:` exactly like the model's `save_skill`
  // does. A typo in a hand-written or hand-edited SKILL.md used to import
  // fine, list fine and enable fine, and then be offered to no agent at all —
  // with nothing anywhere saying why.
  try {
    validateSkillAgent(agent);
  } catch (e) {
    throw new Error(`SKILL.md names an agent no assistant has. ${errMessage(e)}`);
  }
  const files: Array<[string, Buffer]> = [];
  collectFolderFiles(folderPath, folderPath, files, { value: 0 });
  const id = importInto(db, name, description, instructions, agent, files, replace ?? false);
  emitSafely(emit, "skills-changed", undefined);
  return id;
}

/**
 * Does this room already have a skill named after this folder's SKILL.md? The
 * Skills screen asks BEFORE importing, so a re-import can offer "Replace"
 * instead of failing on the name clash. A folder with no readable/parseable
 * SKILL.md answers `null`, and {@link importSkillFolderCmd} then reports the
 * real problem. Ported from `skill_import_conflict`.
 */
export function skillImportConflict(db: Database.Database, folderPath: string): string | null {
  let skillMd: string;
  try {
    skillMd = fs.readFileSync(nodePath.join(folderPath, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  let parsed: ParsedSkillMd;
  try {
    parsed = parseSkillMd(skillMd);
  } catch {
    return null;
  }
  return findSkillDb(db, parsed.name)?.name ?? null;
}

/** Ported from `export_skill_folder`. */
export function exportSkillFolderCmd(db: Database.Database, id: string, destination: string): string {
  const skill = getSkillDb(db, id);
  const resources = listSkillResourcesDb(db, id);
  let destStat: fs.Stats;
  try {
    destStat = fs.statSync(destination);
  } catch {
    throw new Error("Choose an existing destination folder.");
  }
  if (!destStat.isDirectory()) {
    throw new Error("Choose an existing destination folder.");
  }
  // Before anything is created: a skill saved before `checkResourcePaths`
  // existed can still hold a file and a folder of the same name, and the write
  // loop below would abort halfway with a raw OS error and remove the
  // destination it had just made.
  checkResourcePaths(resources.map((r) => r.path));
  const folder = safeExportName(skill.name);
  const root = nodePath.join(destination, folder);
  if (fs.existsSync(root)) {
    throw new Error(`A folder named "${folder}" already exists there.`);
  }
  fs.mkdirSync(root);
  try {
    fs.writeFileSync(nodePath.join(root, "SKILL.md"), renderSkillMd(skill));
    for (const r of resources) {
      const target = nodePath.join(root, normalizeSkillPath(r.path));
      fs.mkdirSync(nodePath.dirname(target), { recursive: true });
      fs.writeFileSync(target, r.content);
    }
  } catch (e) {
    fs.rmSync(root, { recursive: true, force: true });
    throw e;
  }
  return root;
}
