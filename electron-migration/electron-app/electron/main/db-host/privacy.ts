/**
 * PRIV-1/PRIV-2: the room's protected-entity map (`privacy_entities`) and its
 * per-file scan bookkeeping (`privacy_scans`). Ported from
 * `src-tauri/src/db/privacy.rs` (390 lines, read in full).
 *
 * ESTABLISHED CONVENTIONS reused from this directory (see `util.ts`'s own
 * module comment for the full rationale, and `files.ts`/`chats.ts` for worked
 * examples): every read/write goes through `queryOne`/`queryOpt`/`queryRows`/
 * `executeOne` rather than a bare `db.prepare` call site, and rows are read
 * POSITIONALLY via `.raw()`, matching the Rust mappers' `r.get(i)` order
 * column for column so the SQL stays a character-for-character copy.
 *
 * `isProtectable`/`MIN_PROTECTED_CHARS` are NOT redeclared here — they come
 * from `../privacyRedact.js`, the one definition of the door's floor, shared
 * by the redactor and every entity write. That mirrors the Rust source's own
 * cross-module reach (`db/privacy.rs` calls `crate::commands::is_protectable`),
 * and the cross-directory import matches an existing convention in this port
 * (`files.ts` already imports `../obs.js` the same way).
 */

import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { executeOne, queryOne, queryOpt, queryRows, type Row } from "./util.js";
import { isProtectable, MIN_PROTECTED_CHARS } from "../privacyRedact.js";

/** PRIV-1: one protected entity — a real string that must never reach a
 * non-local model, and the stable placeholder that replaces it. Mirrors the
 * Rust `PrivacyEntity` struct (`rename_all = "camelCase"`), which is
 * field-for-field the `PrivacyEntity` in `shared/apiTypes.ts` — an entity row
 * goes out to the frontend unchanged. */
export interface PrivacyEntity {
  id: string;
  realText: string;
  placeholder: string;
  category: string;
  source: string;
}

/** The display series per category. `concept` findings (user topic rules) get
 * the neutral "Private" series; everything else names its kind so the user can
 * read a redacted answer ("[Person A] met [Person B] at [Address A]"). Ported
 * verbatim from `series_for`. */
function seriesFor(category: string): string {
  switch (category) {
    case "person":
      return "Person";
    case "address":
      return "Address";
    case "phone":
      return "Phone";
    case "email":
      return "Email";
    case "id":
      return "ID";
    case "org":
      return "Org";
    default:
      return "Private";
  }
}

/** A..Z, then AA..AZ, BA.. — stable, readable, never runs out. A bijective
 * base-26 counter, ported verbatim from `letters`. */
function letters(n: number): string {
  let out = "";
  let m = n;
  for (;;) {
    out = String.fromCharCode(65 + (m % 26)) + out;
    m = Math.floor(m / 26);
    if (m === 0) {
      break;
    }
    m -= 1;
  }
  return out;
}

function entityRow(r: Row): PrivacyEntity {
  return {
    id: r[0] as string,
    realText: r[1] as string,
    placeholder: r[2] as string,
    category: r[3] as string,
    source: r[4] as string,
  };
}

/** The existing entity whose real text is the same string ignoring case, if
 * any.
 *
 * Done in application code rather than in SQL because SQLite's `lower()` only
 * folds ASCII: "JOSÉ MUÑOZ" did not match "José Muñoz", so one person became
 * two rows with two placeholders — the panel listed them twice and only one of
 * the two was ever emitted. The table is a hand-curated block list plus scan
 * findings, so reading it whole costs less than the correctness did. Ported
 * from `find_entity_ignoring_case`. */
function findEntityIgnoringCase(db: Database.Database, real: string): PrivacyEntity | null {
  const wanted = real.toLowerCase();
  const rows = queryRows(
    db,
    "SELECT id, real_text, placeholder, category, source FROM privacy_entities",
    [],
    entityRow
  );
  for (const row of rows) {
    if (row.realText.toLowerCase() === wanted) {
      return row;
    }
  }
  return null;
}

/**
 * Insert `realText` into the entity map, minting the next free placeholder in
 * its category's series. A case-insensitive duplicate returns the EXISTING row
 * (a 'user' source upgrades a 'scan' row — the block list is the stronger
 * claim). Empty/whitespace text is rejected. Ported from `add_privacy_entity`.
 *
 * BUG-COMPATIBLE WITH RUST on one point: the row handed back on a duplicate is
 * `existing` as it was read BEFORE the scan->user upgrade above, so its
 * `.source` can still read "scan" while the database says "user" — Rust
 * returns the value it already had in hand rather than re-reading the row it
 * just changed. Every real caller reloads through {@link listPrivacyEntities}
 * immediately afterwards, where the true value shows.
 */
export function addPrivacyEntity(
  db: Database.Database,
  realText: string,
  category: string,
  source: string
): PrivacyEntity {
  const real = realText.trim();
  // The redactor's own floor, counted the way the message states it and the
  // way the redactor applies it: in CODE POINTS. `real.length` (UTF-16 units)
  // or a byte count would accept a single Hebrew or accented letter the panel
  // then lists as protected and `new Redactor(...)` silently discards.
  if (!isProtectable(real)) {
    throw new Error(`A protected detail needs at least ${MIN_PROTECTED_CHARS} characters.`);
  }
  const existing = findEntityIgnoringCase(db, real);
  if (existing !== null) {
    if (source === "user" && existing.source !== "user") {
      executeOne(db, "UPDATE privacy_entities SET source = 'user' WHERE id = ?", [existing.id]);
    }
    return existing;
  }
  const series = seriesFor(category);
  // Next free letter in this series: count existing placeholders of the series,
  // then walk forward past any that are already taken.
  const count = queryOne(
    db,
    "SELECT count(*) FROM privacy_entities WHERE placeholder LIKE ?",
    [`[${series} %`],
    (r) => r[0] as number
  );
  let n = count;
  let placeholder = "";
  for (;;) {
    const candidate = `[${series} ${letters(n)}]`;
    const taken = queryOne(
      db,
      "SELECT count(*) FROM privacy_entities WHERE placeholder = ?",
      [candidate],
      (r) => r[0] as number
    );
    if (taken === 0) {
      placeholder = candidate;
      break;
    }
    n += 1;
  }
  const id = randomUUID();
  executeOne(
    db,
    `INSERT INTO privacy_entities(id, real_text, placeholder, category, source)
     VALUES (?, ?, ?, ?, ?)`,
    [id, real, placeholder, category, source]
  );
  return { id, realText: real, placeholder, category, source };
}

/** Every protected entity, user block-list rows first, then by recency. Ported
 * verbatim from `list_privacy_entities`. */
export function listPrivacyEntities(db: Database.Database): PrivacyEntity[] {
  return queryRows(
    db,
    `SELECT id, real_text, placeholder, category, source FROM privacy_entities
     ORDER BY source = 'user' DESC, created_at DESC, rowid DESC`,
    [],
    entityRow
  );
}

/** One entity's `source` column, for the caller deciding whether to delete it
 * outright or tombstone it. Not a function of its own in Rust —
 * `commands::remove_privacy_entity` runs this exact `query_row` inline; pulled
 * out here so the command layer keeps using this directory's helpers rather
 * than reaching for a bare `db.prepare`. Throws (via `queryOne`) when `id`
 * names no row, exactly as the Rust `query_row` errors. */
export function entitySource(db: Database.Database, id: string): string {
  return queryOne(db, "SELECT source FROM privacy_entities WHERE id = ?", [id], (r) => r[0] as string);
}

/** Ported verbatim from `delete_privacy_entity`. */
export function deletePrivacyEntity(db: Database.Database, id: string): void {
  executeOne(db, "DELETE FROM privacy_entities WHERE id = ?", [id]);
}

/** Mark a SCAN-found entity "not private after all". The row STAYS (a
 * tombstone) so a re-scan cannot quietly resurrect it: the scanner's `known`
 * list includes dismissed reals, and the rule builder skips them. Ported
 * verbatim from `dismiss_privacy_entity`. */
export function dismissPrivacyEntity(db: Database.Database, id: string): void {
  executeOne(db, "UPDATE privacy_entities SET source = 'dismissed' WHERE id = ?", [id]);
}

/** The scan bookkeeping row for one file, if any: [text_sha256, rules_sha256].
 * Ported verbatim from `get_privacy_scan`. */
export function getPrivacyScan(db: Database.Database, fileId: string): readonly [string, string] | null {
  return queryOpt(
    db,
    "SELECT text_sha256, rules_sha256 FROM privacy_scans WHERE file_id = ?",
    [fileId],
    (r) => [r[0] as string, r[1] as string] as const
  );
}

/** Ported verbatim from `set_privacy_scan`. */
export function setPrivacyScan(
  db: Database.Database,
  fileId: string,
  textSha256: string,
  rulesSha256: string
): void {
  executeOne(
    db,
    `INSERT INTO privacy_scans(file_id, text_sha256, rules_sha256, scanned_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(file_id) DO UPDATE SET
       text_sha256 = excluded.text_sha256,
       rules_sha256 = excluded.rules_sha256,
       scanned_at = excluded.scanned_at`,
    [fileId, textSha256, rulesSha256]
  );
}

/** The digest stored in `privacy_scans.text_sha256`: sha256 hex of the exact
 * text that was scanned. ONE definition, because the writer (the scan runner,
 * after a completed scan) and the staleness reader below must agree byte for
 * byte — two spellings of "hash the text" that drift mean either re-scanning
 * everything forever or never re-scanning anything. Ported verbatim from
 * `privacy_text_sha`. */
export function privacyTextSha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Files with extracted text whose scan row is missing, or stale for the given
 * rules hash, or stale because THE TEXT ITSELF CHANGED since it was scanned.
 * Returns [id, name, extractedText] oldest-imported first, so a long re-scan
 * makes visible progress through the library in a stable order.
 *
 * THE BUG THIS EXISTS FOR: the scan row has always recorded the digest of the
 * text it read, and nothing ever compared it again — only the rules hash was
 * tested. So a file edited (or a recording re-transcribed) after its scan kept
 * its "this file is protected" row forever: new names, addresses and ID numbers
 * in it were never found and went to a cloud model unhidden even after pressing
 * "Scan now".
 *
 * The digest is recomputed rather than compared in SQL (SQLite has no sha256),
 * which costs one hash of every already-scanned file's text per call — the
 * deliberate trade the Rust doc explains: this runs on scan starts and on
 * Settings/Home status reads, not per keystroke, and the alternative is a
 * write-time invalidation hook every future writer of `extracted_text` would
 * have to remember. Ported from `files_needing_privacy_scan`.
 */
export function filesNeedingPrivacyScan(
  db: Database.Database,
  rulesSha256: string
): Array<readonly [id: string, name: string, text: string]> {
  const rows = queryRows(
    db,
    `SELECT f.id, f.name, f.extracted_text, s.rules_sha256, s.text_sha256 FROM files f
     LEFT JOIN privacy_scans s ON s.file_id = f.id
     WHERE f.trashed_at IS NULL
       AND f.extracted_text IS NOT NULL AND length(f.extracted_text) > 0
     ORDER BY f.created_at ASC, f.rowid ASC`,
    [],
    (r) =>
      [r[0] as string, r[1] as string, r[2] as string, r[3] as string | null, r[4] as string | null] as const
  );
  return rows
    .filter(([, , text, scannedRules, scannedText]) => {
      // No scan row (or a half-written one): never scanned under any rules.
      if (scannedRules === null || scannedText === null) {
        return true;
      }
      return scannedRules !== rulesSha256 || scannedText !== privacyTextSha(text);
    })
    .map(([id, name, text]) => [id, name, text] as const);
}
