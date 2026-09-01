/**
 * Whole-room checkpoints — named, consistent, encrypted copies of the entire
 * `.roomai` file, and the pure filesystem/DB primitives a rollback is built
 * from. Ported from `src-tauri/src/commands/room_checkpoints.rs` (lines 1-461,
 * i.e. everything up through `perform_swap`).
 *
 * NOT ported here: the `#[tauri::command]` wrappers `create_room_checkpoint`,
 * `list_room_checkpoints`, `delete_room_checkpoint`, `rollback_room_checkpoint`
 * and `list_stranded_checkpoints` (plus `stranded_checkpoint_names`, its
 * private helper). All of those close over Tauri's `AppState` — the open
 * room's live connection/lock, `rollback_in_flight`, `drain_inflight`, MCP/
 * Leash teardown, and the room-lifecycle reopen path — none of which exists
 * yet in this migration. They need a room-lifecycle/AppState equivalent built
 * first; this module only carries the parts of `room_checkpoints.rs` that are
 * pure over a `Database` handle and a directory path, which is deliberately
 * exactly what the Rust file itself keeps unit-testable without `AppState`.
 *
 * The checkpoints registry lives OUTSIDE the room DB, in a plaintext sidecar
 * directory beside the room file (`<room>.checkpoints/`) — it must survive
 * the DB being rolled back. Only names/dates/sizes are plaintext; the
 * `<uuid>.roomck` payloads are full SQLCipher copies keeping the room's
 * current key.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

/** One checkpoint's plaintext metadata. `auto` marks the pre-rollback safety
 * copies (capped/pruned) apart from user checkpoints. camelCase because the
 * same shape serves the manifest file AND the (future) frontend api. */
export interface CheckpointMeta {
  id: string;
  name: string;
  createdAt: string;
  sizeBytes: number;
  auto: boolean;
}

/** The on-disk registry: a versioned list of checkpoint metadata. */
export interface CheckpointManifest {
  v: number;
  entries: CheckpointMeta[];
}

function defaultManifest(): CheckpointManifest {
  return { v: 1, entries: [] };
}

/** What a command says when handed something that is not one of our ids. */
export const NOT_A_CHECKPOINT_ID = "That isn't a checkpoint of this room.";

/** The sidecar directory for a room's checkpoints, beside the room file. */
export function checkpointsDir(roomPath: string): string {
  return `${roomPath}.checkpoints`;
}

/** The `.roomck` payload path for one checkpoint id inside a checkpoints dir. */
export function checkpointFilePath(dir: string, id: string): string {
  return `${dir}/${id}.roomck`;
}

/**
 * Whether `id` is a plain path component we minted ourselves.
 *
 * Every checkpoint id in the manifest is a `randomUUID()` string, so this is
 * exactly the shape of a real one. The two commands that (will) take an id
 * from the frontend paste it into `checkpointFilePath` and then DELETE or
 * SWAP IN the result, so this rejects rather than sanitizes: an id is either
 * one we wrote or it is not a checkpoint at all, and quietly rewriting it
 * into a different id would delete the wrong file.
 */
export function checkpointIdOk(id: string): boolean {
  if (id.length === 0 || id.length > 64) {
    return false;
  }
  return /^[A-Za-z0-9_-]+$/.test(id);
}

// --------------------------------------------------------------- timestamps
//
// The app has no chrono-equivalent dependency; every timestamp the DB writes
// comes from `strftime('%Y-%m-%dT%H:%M:%SZ','now')` — ISO 8601 with the
// trailing Z that says it is UTC. Checkpoint metadata lives in a JSON sidecar
// rather than the DB, so this produces that SAME format, via the SAME pure
// integer arithmetic the Rust side uses (Howard Hinnant's civil_from_days),
// rather than `Date`/`toISOString` — different engines' "ISO string" have
// bitten this app before (see the Rust module's own doc comment on the format
// that used to be missing its trailing Z).

/** Truncating integer division, matching Rust's `i64` division (truncates
 * toward zero) rather than JS's `Math.floor` (which floors toward -Infinity
 * and would disagree with Rust for negative operands). */
function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/** Howard Hinnant's days-since-epoch → civil (y, m, d) algorithm, ported
 * verbatim from `civil_from_days` in room_checkpoints.rs. */
function civilFromDays(zIn: number): [number, number, number] {
  const z = zIn + 719_468;
  const era = idiv(z >= 0 ? z : z - 146_096, 146_097);
  const doe = z - era * 146_097;
  const yoe = idiv(doe - idiv(doe, 1460) + idiv(doe, 36_524) - idiv(doe, 146_096), 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + idiv(yoe, 4) - idiv(yoe, 100));
  const mp = idiv(5 * doy + 2, 153);
  const d = doy - idiv(153 * mp + 2, 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** Seconds since the Unix epoch → "YYYY-MM-DDTHH:MM:SSZ", ported verbatim
 * from `format_epoch` (secs is treated as non-negative, matching Rust's
 * `u64`). */
export function formatEpoch(secs: number): string {
  const days = idiv(secs, 86_400);
  const rem = secs % 86_400;
  const hh = idiv(rem, 3600);
  const mm = idiv(rem % 3600, 60);
  const ss = rem % 60;
  const [y, m, d] = civilFromDays(days);
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}T${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}Z`;
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

export function nowTimestamp(): string {
  return formatEpoch(nowSecs());
}

/** The date-only helper (default checkpoint names) — first 10 chars of
 * `nowTimestamp()`. */
export function nowDate(): string {
  return nowTimestamp().slice(0, 10);
}

/** A file's mtime, through `formatEpoch` — falls back to `nowTimestamp()` if
 * the file can't be stat'd (mirrors Rust's `unwrap_or_else(now_timestamp)`). */
export function mtimeTimestamp(filePath: string): string {
  try {
    const secs = Math.floor(statSync(filePath).mtimeMs / 1000);
    return formatEpoch(secs);
  } catch {
    return nowTimestamp();
  }
}

// --------------------------------------------------------------- manifest I/O

function manifestPath(dir: string): string {
  return `${dir}/manifest.json`;
}

function stringFields(record: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => typeof record[field] === "string");
}

export function isCheckpointMeta(x: unknown): x is CheckpointMeta {
  if (typeof x !== "object" || x === null) {
    return false;
  }
  const o = x as Record<string, unknown>;
  return (
    stringFields(o, ["id", "name", "createdAt"]) &&
    typeof o.sizeBytes === "number" &&
    typeof o.auto === "boolean"
  );
}

export function isCheckpointManifest(x: unknown): x is CheckpointManifest {
  if (typeof x !== "object" || x === null) {
    return false;
  }
  const o = x as Record<string, unknown>;
  return typeof o.v === "number" && Array.isArray(o.entries) && o.entries.every(isCheckpointMeta);
}

/** Reads `dir/manifest.json`; returns the default `{v:1, entries:[]}` on ANY
 * read/parse/shape failure — a missing file, invalid JSON, or JSON that isn't
 * shaped like a manifest all read the same as "no checkpoints yet" rather
 * than crashing whatever called in. The shape check validates every entry's
 * fields (not just that `entries` is an array), mirroring serde's strict,
 * all-fields-required struct deserialization on the Rust side: a manifest
 * entry missing a field there fails to deserialize AT ALL, so the whole
 * manifest falls back to empty rather than quietly keeping a half-shaped
 * entry other code would later choke on. */
export function readManifest(dir: string): CheckpointManifest {
  try {
    const raw = readFileSync(manifestPath(dir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isCheckpointManifest(parsed) ? parsed : defaultManifest();
  } catch {
    return defaultManifest();
  }
}

/** Single-shot manifest write: serialize to a temp file, then rename over the
 * live one, so a crash mid-write never leaves a half-written manifest
 * behind. 0600, not the default 0644: the checkpoint COPIES are encrypted but
 * this index is not, and the names in it are ones the user typed — "Before
 * the tax settlement" would tell anyone with the disk or a backup what the
 * room is about without a single encrypted byte being touched. The mode is
 * set twice on purpose (once via the `mode` option, once via `chmodSync`)
 * because the option only applies when Node CREATES the file, and a leftover
 * temp file from an older, differently-permissioned build must not keep its
 * looser mode — this mirrors the Rust source's `recent::write_private`
 * helper exactly (open with `.mode(0o600)` THEN an unconditional
 * `set_permissions`). Both stages are wrapped with the same descriptive
 * messages the Rust `write_manifest` produces (`map_err` on the write, then
 * on the rename), rather than letting a raw Node fs error escape. */
export function writeManifest(dir: string, manifest: CheckpointManifest): void {
  const json = JSON.stringify(manifest, null, 2);
  const tmp = `${dir}/manifest.json.tmp`;
  try {
    writeFileSync(tmp, json, { mode: 0o600 });
    chmodSync(tmp, 0o600);
  } catch (err) {
    throw new Error(`Could not write the checkpoint manifest: ${errMsg(err)}`);
  }
  try {
    renameSync(tmp, manifestPath(dir));
  } catch (err) {
    throw new Error(`Could not save the checkpoint manifest: ${errMsg(err)}`);
  }
}

function dedupeCheckpointEntries(entries: CheckpointMeta[]): CheckpointMeta[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const duplicate = seen.has(entry.id);
    seen.add(entry.id);
    return !duplicate;
  });
}

function entriesWithPayload(dir: string, entries: CheckpointMeta[]): CheckpointMeta[] {
  return entries.filter((entry) => existsSync(checkpointFilePath(dir, entry.id)));
}

function checkpointSizeOrZero(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function refreshEntrySize(dir: string, entry: CheckpointMeta): void {
  try {
    entry.sizeBytes = statSync(checkpointFilePath(dir, entry.id)).size;
  } catch {
    // The payload existed when filtering. Keeping the last-known size is safe
    // if it disappears between that check and this one.
  }
}

function refreshEntrySizes(dir: string, entries: CheckpointMeta[]): void {
  for (const entry of entries) {
    refreshEntrySize(dir, entry);
  }
}

function directoryNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function removeFileBestEffort(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Best effort cleanup must not hide the operation's original result.
  }
}

function recoveredCheckpoint(fullPath: string, id: string): CheckpointMeta {
  return {
    id,
    name: "Recovered checkpoint",
    createdAt: mtimeTimestamp(fullPath),
    sizeBytes: checkpointSizeOrZero(fullPath),
    auto: false,
  };
}

function reconcileDirectoryEntry(dir: string, fileName: string, known: Set<string>): CheckpointMeta | undefined {
  const fullPath = `${dir}/${fileName}`;
  if (fileName.endsWith(".tmp")) {
    removeFileBestEffort(fullPath);
    return undefined;
  }
  if (!fileName.endsWith(".roomck")) {
    return undefined;
  }
  const id = fileName.slice(0, -".roomck".length);
  return known.has(id) ? undefined : recoveredCheckpoint(fullPath, id);
}

function recoverDirectoryEntries(dir: string, manifest: CheckpointManifest): void {
  const known = new Set(manifest.entries.map((entry) => entry.id));
  for (const fileName of directoryNames(dir)) {
    const recovered = reconcileDirectoryEntry(dir, fileName, known);
    if (recovered !== undefined) {
      manifest.entries.push(recovered);
    }
  }
}

function writeManifestBestEffort(dir: string, manifest: CheckpointManifest): void {
  try {
    writeManifest(dir, manifest);
  } catch {
    // Recovery is still useful in memory when its durable manifest write fails.
  }
}

/** The crash-recovery point in BOTH directions: dedupe entries by id (keep
 * first), drop manifest entries whose `.roomck` is gone, refresh the
 * survivors' sizes, delete stale `*.tmp` files (a crash mid-vacuum), and
 * ADOPT orphan `.roomck` files that no entry names (a crash between the
 * tmp→final rename and the manifest append) so no multi-GB copy is ever an
 * invisible leak. The healed manifest is written back (best-effort — mirrors
 * Rust's `let _ = write_manifest(...)`, since a write failure here must not
 * stop the CALLER from seeing the healed-in-memory manifest). */
export function reconcile(dir: string): CheckpointManifest {
  const manifest = readManifest(dir);
  manifest.entries = entriesWithPayload(dir, dedupeCheckpointEntries(manifest.entries));
  refreshEntrySizes(dir, manifest.entries);
  recoverDirectoryEntries(dir, manifest);
  writeManifestBestEffort(dir, manifest);
  return manifest;
}

/** Every checkpoint's `.roomck` path for a room — e.g. for a future
 * `change_password` to re-key each copy so a later password change never
 * strands them. Empty when the checkpoints dir doesn't exist at all. */
export function checkpointCkPaths(roomPath: string): string[] {
  const dir = checkpointsDir(roomPath);
  if (!existsSync(dir)) {
    return [];
  }
  return reconcile(dir).entries.map((e) => checkpointFilePath(dir, e.id));
}

function autoCheckpointIdsToPrune(entries: CheckpointMeta[], keep: number): Set<string> {
  const autos = entries
    .filter((entry) => entry.auto)
    .map((entry) => ({ id: entry.id, createdAt: entry.createdAt }));
  autos.sort((left, right) => {
    if (left.createdAt < right.createdAt) {
      return 1;
    }
    return left.createdAt > right.createdAt ? -1 : 0;
  });
  return new Set(autos.slice(keep).map((entry) => entry.id));
}

function deleteCheckpointPayloads(dir: string, ids: Set<string>): void {
  for (const id of ids) {
    removeFileBestEffort(checkpointFilePath(dir, id));
  }
}

/** Keep only the newest `keep` auto (pre-rollback) checkpoints; delete the
 * rest's payload files AND their manifest entries. Non-auto entries are
 * never touched. */
export function pruneAutoCheckpoints(dir: string, keep: number): void {
  const manifest = reconcile(dir);
  const doomed = autoCheckpointIdsToPrune(manifest.entries, keep);
  if (doomed.size === 0) {
    return;
  }
  deleteCheckpointPayloads(dir, doomed);
  manifest.entries = manifest.entries.filter((e) => !doomed.has(e.id));
  writeManifestBestEffort(dir, manifest);
}

// --------------------------------------------------------------- disk space
//
// A checkpoint is a SECOND FULL COPY of the room and a rollback stages a
// THIRD alongside it, so on a nearly-full disk the copy dies part-way through
// and the user sees a raw "database or disk is full" error. Check first and
// say so in words instead.
//
// DELIBERATE DEVIATION from the Rust source: Rust shells out to `/bin/df -Pk`
// because std has no free-space API and the app has no libc dependency. The
// migration plan calls for using Node's built-in `fs.statfsSync` instead (no
// process spawn, no text parsing of `df`'s columns) — available since Node
// 19.6, and Electron 39 ships Node 22, so it's always present here.

/** Bytes free on the volume holding `path`, or `null` when it can't be told.
 * `null` on ANY failure — a missing/unsupported `statfsSync` must never block
 * a checkpoint that would have worked. */
export function freeBytes(targetPath: string): number | null {
  try {
    const st = statfsSync(targetPath);
    return st.bsize * st.bavail;
  } catch {
    return null;
  }
}

/** Leave the volume some air: SQLite's journal, the manifest, and whatever
 * else the Mac is doing while a multi-GB copy runs. */
const HEADROOM_BYTES = 256 * 1024 * 1024;

/** Refuse before writing when `need` bytes (plus headroom) will not fit on
 * the volume holding `dir`. Silent (does not throw) when free space can't be
 * determined — a missing/unsupported statfs must never block a checkpoint
 * that would have worked. */
export function checkRoomFor(dir: string, need: number, what: string): void {
  const free = freeBytes(dir);
  if (free === null) {
    return;
  }
  const needed = need + HEADROOM_BYTES;
  if (free >= needed) {
    return;
  }
  const mb = (n: number) => n / (1024 * 1024);
  throw new Error(
    `Not enough free disk space ${what}: a full copy of this room needs about ${mb(needed).toFixed(0)} MB ` +
      `(with room to work) and only ${mb(free).toFixed(0)} MB is free. Free some space — deleting an old ` +
      `checkpoint is the quickest way — and try again.`
  );
}

/** How many bytes a full copy of this room would take, as SQLite sees it.
 * `VACUUM INTO` writes a COMPACTED copy, so this is an upper bound. */
export function roomSizeBytes(db: Database.Database): number {
  const pageCount = Math.max(0, db.pragma("page_count", { simple: true }) as number);
  const pageSize = Math.max(0, db.pragma("page_size", { simple: true }) as number);
  return pageCount * pageSize;
}

// --------------------------------------------------------------- create core

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function ensureCheckpointDirectory(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(`Could not create the checkpoints folder: ${errMsg(err)}`);
  }
}

function vacuumIntoCheckpoint(db: Database.Database, tmpPath: string): void {
  removeFileBestEffort(tmpPath);
  try {
    const escaped = tmpPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  } catch (err) {
    // A copy that died part-way must not remain for recovery to find later.
    removeFileBestEffort(tmpPath);
    throw err;
  }
}

function publishCheckpoint(tmpPath: string, finalPath: string): void {
  try {
    renameSync(tmpPath, finalPath);
  } catch (err) {
    removeFileBestEffort(tmpPath);
    throw new Error(`Could not save the checkpoint: ${errMsg(err)}`);
  }
}

function checkpointName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : `Checkpoint — ${nowDate()}`;
}

function checkpointMeta(id: string, name: string, auto: boolean, finalPath: string): CheckpointMeta {
  return {
    id,
    name: checkpointName(name),
    createdAt: nowTimestamp(),
    sizeBytes: checkpointSizeOrZero(finalPath),
    auto,
  };
}

/** Write a full SQLCipher copy of `db` into `dir` as a new checkpoint, append
 * its manifest entry, and return the metadata. Pure over a Database handle +
 * dir (no room-lifecycle state) so it is unit-testable against a real room
 * file. The copy is made via `VACUUM INTO` into a `.tmp` path then renamed to
 * `<uuid>.roomck`, so a crash never leaves a torn payload the manifest
 * already names. */
export function writeCheckpoint(
  db: Database.Database,
  dir: string,
  name: string,
  auto: boolean
): CheckpointMeta {
  ensureCheckpointDirectory(dir);
  // Self-heal the dir FIRST — before creating the new payload — so reconcile
  // can't mistake our fresh `.roomck` for an orphan and double-count it.
  const manifest = reconcile(dir);
  checkRoomFor(dir, roomSizeBytes(db), "to save a checkpoint");

  const id = randomUUID();
  const tmp = `${dir}/${id}.tmp`;
  const finalPath = checkpointFilePath(dir, id);
  vacuumIntoCheckpoint(db, tmp);
  publishCheckpoint(tmp, finalPath);
  const meta = checkpointMeta(id, name, auto, finalPath);
  manifest.entries.push(meta);
  writeManifest(dir, manifest);
  return meta;
}

function removeRoomSidecars(roomPath: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    removeFileBestEffort(`${roomPath}${suffix}`);
  }
}

function stageRollbackCopy(checkpointPath: string, swapTmp: string): void {
  try {
    copyFileSync(checkpointPath, swapTmp);
  } catch (err) {
    removeFileBestEffort(swapTmp);
    throw new Error(`Could not stage the rollback copy: ${errMsg(err)}`);
  }
}

function publishRollbackCopy(swapTmp: string, roomPath: string): void {
  try {
    renameSync(swapTmp, roomPath);
  } catch (err) {
    removeFileBestEffort(swapTmp);
    throw new Error(`Could not swap in the checkpoint: ${errMsg(err)}`);
  }
}

/** Swap a checkpoint's `.roomck` in for the room file: delete stale WAL/SHM/
 * journal siblings of the pre-swap DB, copy the checkpoint to a swap temp
 * beside the room (same volume as `roomPath`, so the later rename is atomic),
 * then rename it over the room path. Pure (no room-lifecycle state) so it is
 * unit-testable. The caller MUST have torn down the open connection first —
 * this only touches the filesystem. */
export function performSwap(roomPath: string, ckPath: string): void {
  // The staged copy sits beside the room until the rename, so the volume
  // briefly holds the room AND the checkpoint twice. Say so before starting
  // rather than dying half-way through with a raw copy error.
  checkRoomFor(roomPath, checkpointSizeOrZero(ckPath), "to roll back");
  removeRoomSidecars(roomPath);
  const swapTmp = `${roomPath}.swap-${randomUUID()}`;
  // Clear the partial copy the same way the rename branch below does: a
  // failure part-way through (a volume that filled after the pre-check, an
  // ejected disk) otherwise leaves a room-sized file beside the room that
  // nothing in the app ever sweeps, and every retry adds another.
  stageRollbackCopy(ckPath, swapTmp);
  publishRollbackCopy(swapTmp, roomPath);
}
