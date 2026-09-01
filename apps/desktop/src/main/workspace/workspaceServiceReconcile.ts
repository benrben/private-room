import type Database from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, lstatSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { VERSIONS_KEPT } from "../db-host/versions.js";
import { clearChunks } from "../db-host/files.js";
import { ContentObjectStore } from "./contentObjects.js";
import { scanWorkspaceManifest, type TrustedManifestEntry } from "./manifest.js";
import {
  assertNoSymlinkSegments,
  normalizeRelativePath,
  pathKey,
  resolveWorkspacePath,
} from "./pathSafety.js";
import type { ContentEntry, ContentObjectRef, ManifestEntry, WriteResult } from "./types.js";

import { WorkspaceServiceMutations } from "./workspaceServiceMutations.js";
import {
  mimeForName,
  type ReconciledWorkspaceFileRow,
  type ReconcileResult,
  type WorkspaceFileRow,
} from "./workspaceServiceSupport.js";

export class WorkspaceService extends WorkspaceServiceMutations {
  reconcile(): Promise<ReconcileResult> {
    if (this.reconcileRunning !== null) {
      // Chokidar can emit add/change/rename hints as a burst. The later call is
      // not redundant: its filesystem view may be newer than the scan already
      // in flight, so remember it and return only after that final pass.
      this.reconcileAgain = true;
      return this.reconcileRunning;
    }
    this.reconcileRunning = this.reconcileUntilSettled().finally(() => {
      this.reconcileRunning = null;
    });
    return this.reconcileRunning;
  }

  protected async reconcileUntilSettled(): Promise<ReconcileResult> {
    let result = { added: 0, changed: 0, missing: 0, renamed: 0 };
    do {
      this.reconcileAgain = false;
      result = await this.reconcileOnce();
    } while (this.reconcileAgain);
    return result;
  }

  protected workspaceRows(): ReconciledWorkspaceFileRow[] {
    return this.db.prepare(
      `SELECT id, name, relative_path, path_key, content_sha256, size_bytes, mtime_ns, fs_identity,
              index_state
       FROM files WHERE storage_kind = 'workspace' AND trashed_at IS NULL`,
    ).all() as ReconciledWorkspaceFileRow[];
  }

  protected trustedManifestEntries(rows: ReconciledWorkspaceFileRow[]): Map<string, TrustedManifestEntry> {
    const trustedEntries = new Map<string, TrustedManifestEntry>();
    for (const row of rows) {
      if (row.content_sha256 === null || row.mtime_ns === null || row.fs_identity === null) continue;
      trustedEntries.set(row.path_key, {
        sizeBytes: row.size_bytes,
        mtimeNs: row.mtime_ns,
        sha256: row.content_sha256,
        fsIdentity: row.fs_identity,
      });
    }
    return trustedEntries;
  }

  protected applyMatchedManifestEntries(
    manifest: Map<string, ManifestEntry>,
    rowsByPathKey: Map<string, ReconciledWorkspaceFileRow>,
    unmatchedRows: Map<string, ReconciledWorkspaceFileRow>,
    unmatchedEntries: Map<string, ManifestEntry>,
  ): number {
    let changed = 0;
    for (const [key, entry] of manifest) {
      const row = rowsByPathKey.get(key);
      if (row === undefined) continue;
      unmatchedRows.delete(row.id);
      unmatchedEntries.delete(key);
      if (row.content_sha256 !== entry.sha256 || row.size_bytes !== entry.sizeBytes) changed += 1;
      this.updateManifestRow(row.id, entry, this.reconciledIndexState(row, entry.sha256));
    }
    return changed;
  }

  protected uniqueIdentityRename(
    row: ReconciledWorkspaceFileRow,
    unmatchedEntries: Map<string, ManifestEntry>,
  ): ManifestEntry | undefined {
    const candidates = [...unmatchedEntries.values()].filter(
      (entry) => entry.fsIdentity === row.fs_identity && entry.sha256 === row.content_sha256,
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  protected applyIdentityRenames(
    unmatchedRows: Map<string, ReconciledWorkspaceFileRow>,
    unmatchedEntries: Map<string, ManifestEntry>,
  ): number {
    let renamed = 0;
    for (const [id, row] of [...unmatchedRows]) {
      const entry = this.uniqueIdentityRename(row, unmatchedEntries);
      if (entry === undefined) continue;
      this.updateManifestRow(id, entry, this.reconciledIndexState(row, entry.sha256));
      unmatchedRows.delete(id);
      unmatchedEntries.delete(entry.pathKey);
      renamed += 1;
    }
    return renamed;
  }

  protected uniqueHashRename(
    row: ReconciledWorkspaceFileRow,
    unmatchedRows: Map<string, ReconciledWorkspaceFileRow>,
    unmatchedEntries: Map<string, ManifestEntry>,
  ): ManifestEntry | undefined {
    if (row.content_sha256 === null) return undefined;
    const sourceMatches = [...unmatchedRows.values()].filter(
      (candidate) => candidate.content_sha256 === row.content_sha256 && candidate.size_bytes === row.size_bytes,
    );
    const destinationMatches = [...unmatchedEntries.values()].filter(
      (entry) => entry.sha256 === row.content_sha256 && entry.sizeBytes === row.size_bytes,
    );
    if (sourceMatches.length !== 1 || destinationMatches.length !== 1) return undefined;
    return destinationMatches[0]!;
  }

  protected applyHashOnlyRenames(
    unmatchedRows: Map<string, ReconciledWorkspaceFileRow>,
    unmatchedEntries: Map<string, ManifestEntry>,
  ): number {
    let renamed = 0;
    for (const [id, row] of [...unmatchedRows]) {
      const entry = this.uniqueHashRename(row, unmatchedRows, unmatchedEntries);
      if (entry === undefined) continue;
      this.updateManifestRow(id, entry, this.reconciledIndexState(row, entry.sha256));
      unmatchedRows.delete(id);
      unmatchedEntries.delete(entry.pathKey);
      renamed += 1;
    }
    return renamed;
  }

  protected addManifestEntries(entries: Iterable<ManifestEntry>): void {
    for (const entry of entries) this.insertManifestEntry(entry);
  }

  protected markMissingRows(rows: Iterable<ReconciledWorkspaceFileRow>): number {
    let missing = 0;
    for (const row of rows) {
      if (row.index_state === "offline") continue;
      this.db.transaction(() => {
        clearChunks(this.db, row.id);
        this.db.prepare("UPDATE files SET index_state = 'offline' WHERE id = ?").run(row.id);
      })();
      missing += 1;
    }
    return missing;
  }

  protected async reconcileOnce(): Promise<ReconcileResult> {
    const rows = this.workspaceRows();
    const trustedEntries = this.trustedManifestEntries(rows);
    const manifest = await scanWorkspaceManifest(this.rootPath, { trustedEntries });
    const byKey = new Map(rows.map((row) => [row.path_key, row]));
    const unmatchedRows = new Map(rows.map((row) => [row.id, row]));
    const unmatchedEntries = new Map(manifest);
    const changed = this.applyMatchedManifestEntries(manifest, byKey, unmatchedRows, unmatchedEntries);

    // An identity+hash pair is strong enough to call an external move. Hash
    // alone is intentionally not enough when duplicate files exist.
    const identityRenames = this.applyIdentityRenames(unmatchedRows, unmatchedEntries);

    // Synced filesystems may replace the inode during a rename. Hash-only is
    // safe only when both sides are unique; identical files stay ambiguous.
    const hashOnlyRenames = this.applyHashOnlyRenames(unmatchedRows, unmatchedEntries);
    const added = unmatchedEntries.size;
    this.addManifestEntries(unmatchedEntries.values());
    const missing = this.markMissingRows(unmatchedRows.values());
    return { added, changed, missing, renamed: identityRenames + hashOnlyRenames };
  }

  protected reconciledIndexState(row: WorkspaceFileRow, sha256: string): string {
    if (row.content_sha256 !== sha256 || row.index_state === "offline") return "stale";
    return row.index_state ?? "stale";
  }

  protected updateManifestRow(fileId: string, entry: ManifestEntry, state: string): void {
    this.db.transaction(() => {
      if (state === "stale") clearChunks(this.db, fileId);
      this.db.prepare(
        `UPDATE files SET name = ?, relative_path = ?, path_key = ?, content_sha256 = ?,
           size_bytes = ?, mtime_ns = ?, fs_identity = ?, index_state = ?, index_error = NULL,
           extracted_text = CASE WHEN ? = 'stale' THEN NULL ELSE extracted_text END,
           ai_summary = CASE WHEN ? = 'stale' THEN NULL ELSE ai_summary END,
           last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
      ).run(
        path.basename(entry.relativePath), entry.relativePath, entry.pathKey, entry.sha256,
        entry.sizeBytes, entry.mtimeNs, entry.fsIdentity, state, state, state, fileId,
      );
    })();
  }

  protected insertManifestEntry(entry: ManifestEntry): string {
    const fileId = randomUUID();
    try {
      this.db.prepare(
        `INSERT INTO files(
           id, name, mime_type, size_bytes, source, original_bytes, storage_kind, relative_path,
           path_key, content_sha256, mtime_ns, fs_identity, index_state, last_seen_at
         ) VALUES (?, ?, ?, ?, 'external', NULL, 'workspace', ?, ?, ?, ?, ?, 'pending',
           strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
      ).run(
        fileId, path.basename(entry.relativePath), mimeForName(entry.relativePath), entry.sizeBytes,
        entry.relativePath, entry.pathKey, entry.sha256, entry.mtimeNs, entry.fsIdentity,
      );
      return fileId;
    } catch (error) {
      // A watcher hint, an explicit rescan, and a trusted import may overlap.
      // If another path won the insert race, keep its stable file ID and only
      // refresh its projection. Do not turn a harmless duplicate scan into a
      // UNIQUE-constraint failure.
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) {
        const existing = this.db.prepare(
          `SELECT id FROM files
           WHERE storage_kind = 'workspace' AND trashed_at IS NULL AND path_key = ?`,
        ).get(entry.pathKey) as { id: string } | undefined;
        if (existing !== undefined) {
          const row = this.db.prepare(
            "SELECT content_sha256, index_state FROM files WHERE id = ?",
          ).get(existing.id) as WorkspaceFileRow;
          this.updateManifestRow(existing.id, entry, this.reconciledIndexState(row, entry.sha256));
          return existing.id;
        }
      }
      throw error;
    }
  }

  /** Mark interrupted operations for reconciliation; no guessed destructive repair. */
  recoverIncompleteOperations(): number {
    const result = this.db.prepare(
      `UPDATE fs_operations SET phase = 'failed', error = 'Interrupted; workspace reconciliation required',
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE phase NOT IN ('completed', 'failed')`,
    ).run();
    return result.changes;
  }
}
