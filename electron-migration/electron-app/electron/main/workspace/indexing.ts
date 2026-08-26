import type Database from "better-sqlite3-multiple-ciphers";
import type { Readable } from "node:stream";
import { clearChunks, insertChunks } from "../db-host/files.js";
import { extractDocumentStream, type StreamExtractionResult } from "../documentExtraction.js";
import type { WorkspaceService } from "./workspaceService.js";

interface IndexCandidate {
  id: string;
  name: string;
  content_sha256: string;
}

export interface WorkspaceIndexResult {
  ready: number;
  unsupported: number;
  failed: number;
  staleDiscarded: number;
}

export type WorkspaceStreamExtractor = (
  name: string,
  stream: Readable,
) => Promise<StreamExtractionResult>;

function candidateStillCurrent(
  db: Database.Database,
  fileId: string,
  expectedHash: string,
): boolean {
  try {
    const row = db.prepare(
      `SELECT content_sha256 FROM files
       WHERE id = ? AND storage_kind = 'workspace' AND trashed_at IS NULL`,
    ).get(fileId) as { content_sha256: string | null } | undefined;
    return row?.content_sha256 === expectedHash;
  } catch {
    return false;
  }
}

/**
 * Hash-pinned workspace extraction and search-index replacement.
 *
 * The filesystem is read through WorkspaceService. The extracted result is
 * committed only when both the staged bytes and the live database row still
 * have the hash captured before extraction started.
 */
export class WorkspaceIndexService {
  private running: Promise<WorkspaceIndexResult> | null = null;
  private closed = false;

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly extract: WorkspaceStreamExtractor = extractDocumentStream,
  ) {}

  indexPending(): Promise<WorkspaceIndexResult> {
    if (this.closed) return Promise.resolve({ ready: 0, unsupported: 0, failed: 0, staleDiscarded: 0 });
    if (this.running !== null) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run(): Promise<WorkspaceIndexResult> {
    const result: WorkspaceIndexResult = {
      ready: 0,
      unsupported: 0,
      failed: 0,
      staleDiscarded: 0,
    };
    const candidates = this.workspace.db.prepare(
      `SELECT id, name, content_sha256 FROM files
       WHERE storage_kind = 'workspace' AND trashed_at IS NULL
         AND index_state IN ('pending', 'stale', 'failed')
         AND content_sha256 IS NOT NULL
       ORDER BY last_seen_at, created_at`,
    ).all() as IndexCandidate[];

    for (const candidate of candidates) {
      if (this.closed) break;
      try {
        const extracted = await this.extract(candidate.name, this.workspace.readStream(candidate.id));
        if (
          extracted.sha256 !== candidate.content_sha256
          || !candidateStillCurrent(this.workspace.db, candidate.id, candidate.content_sha256)
        ) {
          result.staleDiscarded += 1;
          continue;
        }
        const state = extracted.text === null ? "unsupported" : "ready";
        this.workspace.db.transaction(() => {
          if (!candidateStillCurrent(this.workspace.db, candidate.id, candidate.content_sha256)) {
            throw new Error("STALE_INDEX_RESULT");
          }
          clearChunks(this.workspace.db, candidate.id);
          insertChunks(this.workspace.db, candidate.id, extracted.text);
          this.workspace.db.prepare(
            `UPDATE files SET extracted_text = ?, ai_summary = NULL,
               index_state = ?, index_error = NULL
             WHERE id = ? AND content_sha256 = ?`,
          ).run(extracted.text, state, candidate.id, candidate.content_sha256);
        })();
        if (state === "ready") result.ready += 1;
        else result.unsupported += 1;
      } catch (error) {
        if (error instanceof Error && error.message === "STALE_INDEX_RESULT") {
          result.staleDiscarded += 1;
          continue;
        }
        if (candidateStillCurrent(this.workspace.db, candidate.id, candidate.content_sha256)) {
          this.workspace.db.prepare(
            `UPDATE files SET index_state = 'failed', index_error = ?
             WHERE id = ? AND content_sha256 = ?`,
          ).run(error instanceof Error ? error.message : String(error), candidate.id, candidate.content_sha256);
          result.failed += 1;
        } else {
          result.staleDiscarded += 1;
        }
      }
    }
    return result;
  }

  close(): void {
    this.closed = true;
  }
}
