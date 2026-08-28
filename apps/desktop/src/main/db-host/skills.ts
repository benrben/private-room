/**
 * Encrypted persistence for Agent Skills. A skill is intentionally not a room
 * `file`: `skills` represents SKILL.md and `skill_resources` represents the
 * relative folder tree that travels with it. Ported from
 * `src-tauri/src/db/skills.rs`.
 *
 * The three interfaces below mirror Rust's own structs, which are declared in
 * `db/skills.rs` ITSELF rather than in `commands.rs` — this port keeps that
 * boundary rather than reusing the frontend-facing types already in
 * `shared/apiTypes.ts`, which are a projection, not this row: theirs narrows
 * `createdBy` to a closed union where the column is free-form TEXT, and has no
 * equivalent for the raw resource CONTENT bytes {@link SkillResource} carries.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import {
  executeExisting,
  executeOne,
  executeUnique,
  queryOne,
  queryOpt,
  queryRows,
  type Row,
} from "./util.js";

/** Level-1 progressive-disclosure metadata: the only part of every enabled
 * skill placed in an ordinary model turn. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  createdBy: string;
  /** Which sub-agent owns this skill (`agent:` in SKILL.md frontmatter).
   * Empty = GENERAL: offered to every agent, which is what every skill
   * authored before 2026-07-24 stays. */
  agent: string;
  resourceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  createdBy: string;
  /** See {@link SkillSummary.agent}. */
  agent: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillResource {
  id: string;
  skillId: string;
  path: string;
  kind: string;
  content: Buffer;
  createdAt: string;
  updatedAt: string;
}

/** Lifted verbatim from the Rust constant, unaliased count subquery and all —
 * `util.ts`'s positional `.raw()` row mode needs no column names, so the SQL
 * does not have to be edited to be readable. */
const SUMMARY_COLS =
  "s.id, s.name, s.description, s.enabled, s.created_by, " +
  "(SELECT count(*) FROM skill_resources r WHERE r.skill_id = s.id), " +
  "s.created_at, s.updated_at, s.agent";

/** The full SKILL.md row, in the order `skillRow` reads it. Named once so
 * `getSkill` and `findSkill` cannot drift apart from each other or from the
 * mapper. */
const SKILL_COLS =
  "id, name, description, instructions, enabled, created_by, created_at, updated_at, agent";

const RESOURCE_COLS = "id, skill_id, path, kind, content, created_at, updated_at";

function summaryRow(r: Row): SkillSummary {
  return {
    id: r[0] as string,
    name: r[1] as string,
    description: r[2] as string,
    enabled: (r[3] as number) !== 0,
    createdBy: r[4] as string,
    resourceCount: r[5] as number,
    createdAt: r[6] as string,
    updatedAt: r[7] as string,
    agent: r[8] as string,
  };
}

function skillRow(r: Row): Skill {
  return {
    id: r[0] as string,
    name: r[1] as string,
    description: r[2] as string,
    instructions: r[3] as string,
    enabled: (r[4] as number) !== 0,
    createdBy: r[5] as string,
    createdAt: r[6] as string,
    updatedAt: r[7] as string,
    agent: r[8] as string,
  };
}

function resourceRow(r: Row): SkillResource {
  return {
    id: r[0] as string,
    skillId: r[1] as string,
    path: r[2] as string,
    kind: r[3] as string,
    content: r[4] as Buffer,
    createdAt: r[5] as string,
    updatedAt: r[6] as string,
  };
}

export function listSkills(db: Database.Database, enabledOnly: boolean): SkillSummary[] {
  const whereClause = enabledOnly ? "WHERE s.enabled = 1" : "";
  return queryRows(
    db,
    `SELECT ${SUMMARY_COLS} FROM skills s ${whereClause} ORDER BY s.name COLLATE NOCASE`,
    [],
    summaryRow
  );
}

export function getSkill(db: Database.Database, id: string): Skill {
  return queryOne(db, `SELECT ${SKILL_COLS} FROM skills WHERE id = ?`, [id], skillRow);
}

export function findSkill(db: Database.Database, nameOrId: string): Skill | null {
  return queryOpt(
    db,
    `SELECT ${SKILL_COLS} FROM skills WHERE id = ? OR lower(name) = lower(?) LIMIT 1`,
    [nameOrId, nameOrId],
    skillRow
  );
}

/** The skills table's UNIQUE index is case-SENSITIVE, so "Legal" and "legal"
 * could both exist — while every LOOKUP is case-INSENSITIVE
 * ({@link findSkill} matches `lower(name)` and takes the first row it gets).
 * Two skills whose names differ only in capitals are therefore
 * indistinguishable to anyone asking for one by name, and whichever SQLite
 * returns first quietly runs. Reject the clash at the write instead.
 * `exceptId` lets a rename keep its own name, including a pure change of
 * capitalization, which is a real rename. */
function skillNameClashes(
  db: Database.Database,
  name: string,
  exceptId: string | null
): boolean {
  const hit = queryOpt(
    db,
    `SELECT 1 FROM skills WHERE name = ? COLLATE NOCASE
       AND (? IS NULL OR id <> ?) LIMIT 1`,
    [name, exceptId, exceptId],
    () => true
  );
  return hit !== null;
}

export function createSkill(
  db: Database.Database,
  name: string,
  description: string,
  instructions: string,
  enabled: boolean,
  createdBy: string,
  agent: string
): string {
  if (skillNameClashes(db, name, null)) {
    throw new Error(`A skill named "${name}" already exists.`);
  }
  const id = randomUUID();
  executeUnique(
    db,
    `INSERT INTO skills(id, name, description, instructions, enabled, created_by, agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, name, description, instructions, enabled ? 1 : 0, createdBy, agent],
    () => `A skill named "${name}" already exists.`
  );
  return id;
}

export function updateSkill(
  db: Database.Database,
  id: string,
  name: string,
  description: string,
  instructions: string,
  agent: string
): void {
  if (skillNameClashes(db, name, id)) {
    throw new Error(`A skill named "${name}" already exists.`);
  }
  // Hand-rolled rather than delegating, because this needs BOTH guards at
  // once: `executeUnique`'s clash relabelling AND `executeExisting`'s
  // affected-row check. The row count is the whole point — a skill deleted in
  // another window (or by the assistant) while this one was open matched no
  // row, changed nothing, and would otherwise report success, so Save said
  // "Saved" and threw the edited instructions away. Empty must read as empty.
  let changed: number;
  try {
    changed = db
      .prepare(
        `UPDATE skills SET name=?, description=?, instructions=?, agent=?,
         updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`
      )
      .run(name, description, instructions, agent, id).changes;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE")) {
      throw new Error(`A skill named "${name}" already exists.`);
    }
    throw err;
  }
  if (changed === 0) {
    throw new Error(SKILL_GONE);
  }
}

/** What every write to a skill that is no longer there says. Word-for-word
 * the sentence the commands layer's own existence check uses, so whichever
 * guard fires first the user reads the same thing. */
export const SKILL_GONE = "That skill no longer exists — it was deleted.";

export function setSkillEnabled(db: Database.Database, id: string, enabled: boolean): void {
  // Same reason as `updateSkill`: turning a deleted skill on said "on".
  executeExisting(
    db,
    "UPDATE skills SET enabled=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",
    [enabled ? 1 : 0, id],
    SKILL_GONE
  );
}

export function deleteSkill(db: Database.Database, id: string): void {
  executeOne(db, "DELETE FROM skills WHERE id=?", [id]);
}

export function listSkillResources(db: Database.Database, skillId: string): SkillResource[] {
  return queryRows(
    db,
    `SELECT ${RESOURCE_COLS} FROM skill_resources WHERE skill_id=? ORDER BY path COLLATE NOCASE`,
    [skillId],
    resourceRow
  );
}

/** A skill that has no file at this path, in words.
 *
 * `queryOne` would answer SQLite's own "Query returned no rows", and that
 * string went out unchanged: to the model as the whole result of
 * `read_skill_resource` — for a SKILL.md naming a file nobody bundled, which
 * is the ordinary way this happens — and to the editor as a red toast when a
 * row that had been deleted underneath it was clicked. The paths the skill
 * DOES have are the half that answers the question. */
function missingResource(db: Database.Database, skillId: string, path: string): string {
  let who = "That skill";
  try {
    who = `"${getSkill(db, skillId).name}"`;
  } catch {
    // The skill itself is gone too — the generic wording still answers.
  }
  // `unwrap_or_default()` in the Rust source, and deliberately the same here:
  // this function's ONLY job is to replace a raw driver string with a sentence.
  // Letting the listing's own failure escape would put a raw driver string back
  // in its place — and, worse, in place of a DIFFERENT error than the one the
  // caller actually hit.
  let has: string[] = [];
  try {
    has = listSkillResources(db, skillId).map((r) => r.path);
  } catch {
    // Nothing to list is the honest fallback; the sentence still answers.
  }
  if (has.length === 0) {
    return `${who} has no file at ${path} — no files travel with it at all.`;
  }
  return `${who} has no file at ${path}. It carries: ${has.join(", ")}.`;
}

export function getSkillResource(
  db: Database.Database,
  skillId: string,
  path: string
): SkillResource {
  const found = queryOpt(
    db,
    `SELECT ${RESOURCE_COLS} FROM skill_resources WHERE skill_id=? AND path=?`,
    [skillId, path],
    resourceRow
  );
  if (found === null) {
    throw new Error(missingResource(db, skillId, path));
  }
  return found;
}

export function upsertSkillResource(
  db: Database.Database,
  skillId: string,
  path: string,
  kind: string,
  content: Uint8Array
): void {
  executeOne(
    db,
    `INSERT INTO skill_resources(id, skill_id, path, kind, content) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(skill_id, path) DO UPDATE SET kind=excluded.kind, content=excluded.content,
       updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
    [randomUUID(), skillId, path, kind, content]
  );
  executeOne(db, "UPDATE skills SET updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?", [
    skillId,
  ]);
}

export function deleteSkillResource(db: Database.Database, skillId: string, path: string): void {
  // A DELETE that matched nothing used to answer Ok, and the tool above it
  // reported "Deleted references/policy.md from skill \"review\"." for a file
  // the skill never had — a cleanup the model then believed and passed on.
  // Unlike `deleteSkill`, absence here is not the intent satisfied: the caller
  // named a particular file.
  executeExisting(
    db,
    "DELETE FROM skill_resources WHERE skill_id=? AND path=?",
    [skillId, path],
    `That skill has no file at ${path}.`
  );
  executeOne(db, "UPDATE skills SET updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?", [
    skillId,
  ]);
}
