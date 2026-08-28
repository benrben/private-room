/**
 * ART-1: the staged-artifact write funnel. Port of the WHOLE
 * `src-tauri/src/db/artifacts.rs` (451 lines) — `Provenance`, `Staged`,
 * `MAX_ARTIFACT_BYTES`, `stageArtifact`, `discardStaged`, `commitStaged`,
 * `sweepStagedArtifacts`, `fileProvenance`.
 *
 * WHY A FUNNEL. "Ask before AI edits files" is OFF by the owner's decision, so
 * the app writes generated documents into the room without asking first. Two
 * things have to be true for that to be safe rather than merely convenient:
 *
 *   1. a write that does not FINISH must not be visible at all — no truncated
 *      document, no half-written page the library shows as if it were the work;
 *   2. a write that finishes over an earlier artifact must not destroy it.
 *
 * {@link stageArtifact} / {@link discardStaged} / {@link sweepStagedArtifacts}
 * are (1): bytes land in `staged_artifacts`, are validated there, and nothing
 * in `files` changes until one transaction moves them across. (2) is the
 * versioning inside {@link commitStaged}, which routes a regeneration through
 * the existing ADD-2 snapshot path (`snapshotFileVersion` +
 * `updateFileContent`) instead of `availableName`'s duplicate-numbering.
 *
 * DEPENDENCY ON `versions.ts`: `commitStaged` calls `snapshotFileVersion`. See
 * that module's header for why that one function (and not the rest of
 * `versions.rs`) is ported alongside this file.
 *
 * ESTABLISHED CONVENTIONS reused from `util.ts`/`files.ts` (see those module
 * comments for the full rationale): every read/write goes through
 * `queryOpt`/`executeOne` rather than a bare `db.prepare` call site — with the
 * one documented exception, {@link sweepStagedArtifacts}, whose return value IS
 * the affected-row count, the same exception `files.ts`'s `emptyTrash` already
 * carries; rows are read positionally via `.raw()`; and a reused Rust `?N`
 * becomes a `?` repeated in the params array in the ORDER the placeholders
 * occur in the SQL TEXT. `commitStaged`'s final UPDATE is the one to read
 * twice: the Rust text is `SET provenance = ?2, artifact_key = ?3 WHERE id =
 * ?1` against `params![id, provenance, name]`, so the array here is
 * `[provenance, name, id]`.
 *
 * PROVENANCE JSON SHAPE. The Rust `Provenance` is
 * `#[serde(rename_all = "camelCase")]` with every field
 * `#[serde(default, skip_serializing_if = "…")]` — a field with nothing in it
 * is OMITTED from the JSON, never written as `null` or `[]`. That matters
 * beyond taste in BOTH directions, because a `.roomai` file opened by this port
 * may hold `files`/`file_versions` rows the Rust app wrote: {@link
 * provenanceToJson} reproduces the omit-if-empty shape on the way out, and
 * {@link provenanceFromJson} reproduces `serde_json::from_str(…).ok()`'s
 * strictness on the way back in.
 *
 * DEVIATION — `commitStaged`'s return shape: Rust returns `(FileMeta, bool)`.
 * Ported as a two-element tuple `[FileMeta, boolean]`, this port's existing
 * convention for a Rust tuple return (see `files.ts`'s `getFileFull`).
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import { executeOne, queryOpt } from "./util.js";
import {
  availableName,
  getFileMeta,
  inTransaction,
  insertFile,
  isWorkspaceDatabase,
  updateFileContent,
  type FileMeta,
} from "./files.js";
import { snapshotFileVersion } from "./versions.js";

// ---------------------------------------------------------------- provenance

/** What produced a generated artifact. Ids and names ONLY — a run id, the
 * agent/tool that wrote it, the ids of the files it read. Never a line of the
 * content itself and never anything the user typed: this is recorded so the
 * History strip can say where a version came from, and provenance that carried
 * room content would be a copy of the room in a place nothing encrypts twice.
 *
 * Mirrors the Rust `Provenance` struct (`artifacts.rs`), which is
 * field-for-field the `Provenance` in `shared/apiTypes.ts`. Every field is
 * optional for the reason spelled out there: the room records what it actually
 * witnessed, so a missing `agent` means nobody recorded one — not "unknown
 * agent". */
export interface Provenance {
  /** The job/ask run this write belongs to, when the caller has one. */
  runId?: string;
  /** Which agent or command produced it ("Documents agent", "#minutes"). */
  agent?: string;
  /** The tool call that wrote it, when one did ("create_file"). */
  tool?: string;
  /** Ids of the room files this artifact was made FROM. */
  sourceFileIds?: string[];
}

/** True for a provenance that records nothing — the stand-in for Rust's
 * `self == &Provenance::default()`. An empty `sourceFileIds` counts as nothing,
 * exactly as `Vec::is_empty` does. */
function isDefaultProvenance(p: Provenance): boolean {
  return (
    p.runId === undefined &&
    p.agent === undefined &&
    p.tool === undefined &&
    (p.sourceFileIds === undefined || p.sourceFileIds.length === 0)
  );
}

/**
 * A provenance with nothing in it records nothing: `null` is stored so the
 * History strip stays silent rather than showing an empty attribution.
 *
 * Built field-by-field rather than by `JSON.stringify(p)` so an empty
 * `sourceFileIds` is omitted the way `skip_serializing_if = "Vec::is_empty"`
 * omits it — `[]` would round-trip fine inside this port but is NOT what a
 * Rust-written row already on disk looks like.
 *
 * Rust marks the equivalent `pub(crate)` for the one write that cannot go
 * through the funnel (the shared scratch pad's get-or-create, which records its
 * own provenance by hand — see `agent.rs`, "create_file"). Exported here: this
 * port has no module-private-but-sibling-visible concept, and that call site is
 * a later batch's to wire up.
 */
export function provenanceToJson(p: Provenance): string | null {
  if (isDefaultProvenance(p)) {
    return null;
  }
  const out: Record<string, unknown> = {};
  if (p.runId !== undefined) out.runId = p.runId;
  if (p.agent !== undefined) out.agent = p.agent;
  if (p.tool !== undefined) out.tool = p.tool;
  if (p.sourceFileIds !== undefined && p.sourceFileIds.length > 0) {
    out.sourceFileIds = p.sourceFileIds;
  }
  return JSON.stringify(out);
}

/** One optional string field, serde-style: absent and JSON `null` both read as
 * "not recorded"; anything that is not a string fails the whole parse. The
 * sentinel is `false`, which no valid field value can be. */
function optString(v: unknown): string | undefined | false {
  if (v === undefined || v === null) return undefined;
  return typeof v === "string" ? v : false;
}

/**
 * Parse a stored provenance string back into a {@link Provenance}, or `null`
 * when it is not one.
 *
 * Mirrors `serde_json::from_str::<Provenance>(&j).ok()` on three points that a
 * bare `JSON.parse(j) as Provenance` gets wrong, and that matter because these
 * strings can have been written by the Rust app:
 *
 *   - a value of the WRONG TYPE fails the parse (serde errors, `.ok()` → None)
 *     rather than being handed back as if it were a run id;
 *   - UNKNOWN keys are dropped, not carried through — serde ignores them, and
 *     a `Provenance` that secretly holds extra fields would leak them straight
 *     back out through `provenanceToJson` on the next write;
 *   - a parse failure is absence, never a throw: a corrupt attribution must
 *     not be the reason a file will not open.
 *
 * The one deliberate loosening: a JSON `null` for `sourceFileIds` reads as
 * absent (serde would reject it). Refusing the whole attribution over a null
 * array would throw away the run id and the agent name with it, and "no source
 * files recorded" is what both spellings mean.
 */
export function provenanceFromJson(json: string): Provenance | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const runId = optString(o.runId);
  const agent = optString(o.agent);
  const tool = optString(o.tool);
  if (runId === false || agent === false || tool === false) {
    return null;
  }
  let sourceFileIds: string[] | undefined;
  if (o.sourceFileIds !== undefined && o.sourceFileIds !== null) {
    if (!Array.isArray(o.sourceFileIds) || o.sourceFileIds.some((x) => typeof x !== "string")) {
      return null;
    }
    sourceFileIds = o.sourceFileIds as string[];
  }
  const out: Provenance = {};
  if (runId !== undefined) out.runId = runId;
  if (agent !== undefined) out.agent = agent;
  if (tool !== undefined) out.tool = tool;
  if (sourceFileIds !== undefined) out.sourceFileIds = sourceFileIds;
  return out;
}

// ---------------------------------------------------- ART-1: staged artifacts

/** The largest artifact the funnel will stage. A generated document is text a
 * model produced; anything past this is a runaway loop, not a deliverable, and
 * staging it would only move the problem into the room's page cache. Imports
 * and downloads have their own (much larger) caps and do not come through
 * here.
 *
 * Private in Rust; exported here so a caller can refuse a runaway BEFORE
 * holding 64 MB of it, and so the cap is one number rather than two. */
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

/** A staged artifact: the id of its staging row plus the name it wants. The
 * bytes stay in the database — the caller never has to hold them a second time
 * to commit them. */
export interface Staged {
  id: string;
  name: string;
}

/**
 * Stage an artifact's bytes and validate them. Nothing in `files` changes here,
 * so every failure below leaves the room exactly as it was.
 *
 * Validation is deliberately about the WRITE, not about taste: an empty
 * artifact and a nameless one are the two ways a generator reports work it did
 * not do, and both must fail loudly at the door rather than land as a real file
 * somebody later has to disprove.
 */
export function stageArtifact(
  db: Database.Database,
  name: string,
  mime: string,
  bytes: Uint8Array,
  text: string | null,
  provenance: Provenance
): Staged {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new Error("An artifact needs a file name before it can be saved.");
  }
  if (bytes.length === 0) {
    throw new Error(
      `Nothing was generated for "${trimmed}" — it was not saved. ` +
        `(An empty file would look like finished work.)`
    );
  }
  if (bytes.length > MAX_ARTIFACT_BYTES) {
    // Integer division, as in Rust — the number is a plain-language size, not
    // a measurement, and "64.00000095 MB" reads as a machine talking.
    throw new Error(
      `"${trimmed}" came out at ${Math.floor(bytes.length / 1_048_576)} MB, past the ` +
        `${MAX_ARTIFACT_BYTES / 1_048_576} MB limit for a generated file — it was not saved.`
    );
  }
  const id = randomUUID();
  executeOne(
    db,
    `INSERT INTO staged_artifacts(id, name, mime, bytes, text, provenance)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, trimmed, mime, Buffer.from(bytes), text, provenanceToJson(provenance)]
  );
  return { id, name: trimmed };
}

/** Throw a staged artifact away, committing nothing. Used when the run that
 * staged it was cancelled or failed after staging. */
export function discardStaged(db: Database.Database, stagingId: string): void {
  executeOne(db, "DELETE FROM staged_artifacts WHERE id = ?", [stagingId]);
}

/** Row shape read out of `staged_artifacts` by {@link commitStaged}. */
interface StagedRow {
  name: string;
  mime: string;
  bytes: Buffer;
  text: string | null;
  provenance: string | null;
}

/**
 * Commit a staged artifact into the room, atomically.
 *
 * Regeneration is a VERSION, not a duplicate. When a non-trashed GENERATED file
 * already holds this exact name, the new bytes go through the ADD-2 write path
 * (`snapshotFileVersion` + `updateFileContent`), so the previous artifact
 * becomes v-1 in History and the user still has one file. When the name is held
 * by something a PERSON put in the room, or by nothing at all, the artifact is
 * inserted under the next free name — versioning over a user's own file would
 * be an AI silently rewriting work it did not make.
 *
 * Returns the committed file and whether this was a new version of an existing
 * artifact (`true`) or a fresh file (`false`).
 *
 * The whole move is one transaction: the snapshot, the content write, the
 * provenance, and the removal of the staging row either all happen or none do.
 * A crash mid-commit therefore leaves the old artifact intact AND the staging
 * row still there for the sweep — never a file half-way between two versions.
 */
export function commitStaged(db: Database.Database, stagingId: string): [FileMeta, boolean] {
  if (isWorkspaceDatabase(db)) {
    throw new Error("Workspace artifacts must be committed through commitToWorkspace.");
  }
  const staged = queryOpt(
    db,
    "SELECT name, mime, bytes, text, provenance FROM staged_artifacts WHERE id = ?",
    [stagingId],
    (r): StagedRow => ({
      name: r[0] as string,
      mime: r[1] as string,
      bytes: r[2] as Buffer,
      text: r[3] as string | null,
      provenance: r[4] as string | null,
    })
  );
  if (staged === null) {
    throw new Error("That generated file is no longer staged — nothing was saved.");
  }
  const { name, mime, bytes, text, provenance } = staged;

  return inTransaction(db, (): [FileMeta, boolean] => {
    // Which earlier artifact IS this one. The match is on the name the
    // generator ASKED for, not on the name its output ended up under: when a
    // person's file already holds "Plan.md", the first generation lands as
    // "Plan (2).md", and matching on the final name would make every later run
    // mint "Plan (3).md", "Plan (4).md" … — the duplicate this whole funnel
    // exists to prevent. Files written before `artifact_key` existed fall back
    // to their name. Case-insensitively, because `availableName` treats two
    // names differing only in case as the same one, so "deck.html" after
    // "Deck.html" must be a version and not a duplicate the library shows
    // twice.
    const existing = queryOpt(
      db,
      `SELECT id FROM files
       WHERE source = 'generated' AND trashed_at IS NULL
         AND (lower(artifact_key) = lower(?)
              OR (artifact_key IS NULL AND lower(name) = lower(?)))
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [name, name],
      (r) => r[0] as string
    );
    let id: string;
    let versioned: boolean;
    if (existing !== null) {
      id = existing;
      // The snapshot carries the OUTGOING content's provenance with it, so
      // History can say what made the version it is offering to restore — not
      // what made the one that replaced it.
      snapshotFileVersion(db, id, "AI regenerated");
      updateFileContent(db, id, bytes, text);
      versioned = true;
    } else {
      const free = availableName(db, name);
      const meta = insertFile(db, free, mime, bytes, text, "generated");
      id = meta.id;
      versioned = false;
    }
    executeOne(db, "UPDATE files SET provenance = ?, artifact_key = ? WHERE id = ?", [
      provenance,
      name,
      id,
    ]);
    executeOne(db, "DELETE FROM staged_artifacts WHERE id = ?", [stagingId]);
    return [getFileMeta(db, id), versioned];
  });
}

/**
 * Drop every staged artifact left over from a previous session and say how many
 * there were. Called on room open: a staging row that outlived its run belongs
 * to a generation that never finished, and the whole point of staging is that
 * such a write is not in the library — so nothing the user can see changes when
 * these rows go.
 *
 * The count is returned for the tests, which is the only thing that reads it
 * today. Nothing is lost by that — an uncommitted artifact was never in the
 * library, so there is no vanishing act to explain — but if an "N unfinished
 * generations were discarded" line is ever wanted on room open, this is where
 * the number comes from.
 *
 * The one raw `db.prepare` in this file: the return value IS the affected-row
 * count, which no `util.ts` helper hands back (the same exception `files.ts`'s
 * `emptyTrash` documents).
 */
export function sweepStagedArtifacts(db: Database.Database): number {
  return db.prepare("DELETE FROM staged_artifacts").run().changes;
}

/** The provenance recorded for a file's CURRENT content, if any. A trashed file
 * has none to give: this is what the History strip asks with whatever id the
 * open tab is holding, and answering would tell the user which run wrote a file
 * that is not in the room. */
export function fileProvenance(db: Database.Database, fileId: string): Provenance | null {
  const raw = queryOpt(
    db,
    "SELECT provenance FROM files WHERE id = ? AND trashed_at IS NULL",
    [fileId],
    (r) => r[0] as string | null
  );
  // Two different absences collapse to one answer, as Rust's `.flatten()` does:
  // no such (untrashed) file, and a file that has no provenance recorded.
  if (raw === null) {
    return null;
  }
  return provenanceFromJson(raw);
}
