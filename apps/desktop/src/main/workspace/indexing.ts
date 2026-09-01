import type Database from "better-sqlite3-multiple-ciphers";
import type { Readable } from "node:stream";
import { clearChunks, DERIVED_PREVIEW_DESTINATION, insertChunks } from "../db-host/files.js";
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

type IndexCandidateOutcome = "ready" | "unsupported" | "failed" | "staleDiscarded";

const STALE_INDEX_RESULT = "STALE_INDEX_RESULT";

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

function extractionStillCurrent(
  db: Database.Database,
  candidate: IndexCandidate,
  extracted: StreamExtractionResult,
): boolean {
  return extracted.sha256 === candidate.content_sha256
    && candidateStillCurrent(db, candidate.id, candidate.content_sha256);
}

function isStaleIndexResult(error: unknown): boolean {
  return error instanceof Error && error.message === STALE_INDEX_RESULT;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  private rerunRequested = false;
  private closed = false;

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly extract: WorkspaceStreamExtractor = extractDocumentStream,
  ) {}

  indexPending(): Promise<WorkspaceIndexResult> {
    if (this.closed) return Promise.resolve({ ready: 0, unsupported: 0, failed: 0, staleDiscarded: 0 });
    if (this.running !== null) {
      // A reconcile can discover more files while a previous extraction is
      // awaiting the sidecar. Returning that old pass without remembering the
      // request leaves the new rows pending until an unrelated later event.
      this.rerunRequested = true;
      return this.running;
    }
    this.running = this.runUntilSettled().finally(() => { this.running = null; });
    return this.running;
  }

  private async runUntilSettled(): Promise<WorkspaceIndexResult> {
    const total: WorkspaceIndexResult = {
      ready: 0,
      unsupported: 0,
      failed: 0,
      staleDiscarded: 0,
    };
    do {
      this.rerunRequested = false;
      const pass = await this.run();
      total.ready += pass.ready;
      total.unsupported += pass.unsupported;
      total.failed += pass.failed;
      total.staleDiscarded += pass.staleDiscarded;
    } while (!this.closed && this.rerunRequested);
    return total;
  }

  private async run(): Promise<WorkspaceIndexResult> {
    const result: WorkspaceIndexResult = {
      ready: 0,
      unsupported: 0,
      failed: 0,
      staleDiscarded: 0,
    };
    for (const candidate of this.indexCandidates()) {
      if (this.closed) break;
      this.recordOutcome(result, await this.indexCandidate(candidate));
    }
    return result;
  }

  private indexCandidates(): IndexCandidate[] {
    return this.workspace.db.prepare(
      `SELECT id, name, content_sha256 FROM files
       WHERE storage_kind = 'workspace' AND trashed_at IS NULL
         AND origin_destination <> '${DERIVED_PREVIEW_DESTINATION}'
         AND index_state IN ('pending', 'stale', 'failed')
         AND content_sha256 IS NOT NULL
       ORDER BY last_seen_at, created_at`,
    ).all() as IndexCandidate[];
  }

  private async extractCurrent(candidate: IndexCandidate): Promise<StreamExtractionResult | undefined> {
    const extracted = await this.extract(candidate.name, this.workspace.readStream(candidate.id));
    return extractionStillCurrent(this.workspace.db, candidate, extracted) ? extracted : undefined;
  }

  private commitExtraction(candidate: IndexCandidate, extracted: StreamExtractionResult): IndexCandidateOutcome {
    const state = extracted.text === null ? "unsupported" : "ready";
    this.workspace.db.transaction(() => {
      if (!candidateStillCurrent(this.workspace.db, candidate.id, candidate.content_sha256)) {
        throw new Error(STALE_INDEX_RESULT);
      }
      clearChunks(this.workspace.db, candidate.id);
      insertChunks(this.workspace.db, candidate.id, extracted.text);
      this.workspace.db.prepare(
        `UPDATE files SET extracted_text = ?, ai_summary = NULL,
           index_state = ?, index_error = NULL
         WHERE id = ? AND content_sha256 = ?`,
      ).run(extracted.text, state, candidate.id, candidate.content_sha256);
    })();
    return state;
  }

  private recordFailure(candidate: IndexCandidate, error: unknown): IndexCandidateOutcome {
    if (!candidateStillCurrent(this.workspace.db, candidate.id, candidate.content_sha256)) {
      return "staleDiscarded";
    }
    this.workspace.db.prepare(
      `UPDATE files SET index_state = 'failed', index_error = ?
       WHERE id = ? AND content_sha256 = ?`,
    ).run(errorText(error), candidate.id, candidate.content_sha256);
    return "failed";
  }

  private async indexCandidate(candidate: IndexCandidate): Promise<IndexCandidateOutcome> {
    try {
      const extracted = await this.extractCurrent(candidate);
      if (extracted === undefined) return "staleDiscarded";
      return this.commitExtraction(candidate, extracted);
    } catch (error) {
      return isStaleIndexResult(error) ? "staleDiscarded" : this.recordFailure(candidate, error);
    }
  }

  private recordOutcome(result: WorkspaceIndexResult, outcome: IndexCandidateOutcome): void {
    if (outcome === "ready") result.ready += 1;
    else if (outcome === "unsupported") result.unsupported += 1;
    else if (outcome === "failed") result.failed += 1;
    else result.staleDiscarded += 1;
  }

  close(): void {
    this.closed = true;
  }
}
