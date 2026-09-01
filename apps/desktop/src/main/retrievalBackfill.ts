/**
 * Background retrieval maintenance: the question-embedding helper, the lazy
 * chunk-embedding backfill loop, and the two one-shot legacy-content sweeps.
 * Ported from `src-tauri/src/commands/retrieval/backfill.rs` (267 lines, read
 * in full).
 *
 * SCOPE — `src-tauri/src/commands/retrieval.rs` (904 lines, also read in full)
 * is NOT re-ported here. Every non-test item in it — `strip_markup_blocks`,
 * `STOPWORDS`, `question_terms`, `MIN_CHUNK_SIMILARITY`,
 * `MAX_VECTOR_CANDIDATES`, `ScoredChunk`, `fts_match_expr`,
 * `retrieve_context`/`_excluding`/`_limited`, `make_snippet`,
 * `compact_history`, `select_memories` — is already in `db-host/retrieval.ts`,
 * whose own header names `backfill.rs` as the one piece it left out. The
 * "chat commands" heading at `retrieval.rs:434` is a bare comment with no code
 * under it (the `#name`/`@name` pipeline lives in `commands/chat_commands/`).
 * So `backfill.rs` is this file's whole job.
 *
 * NOT A MODEL-INVOCABLE TOOL. `search_room` — the one retrieval capability the
 * model calls — is already wired in `fileTools.ts` against
 * `retrieveContextExcluding`, and (matching the `agent.rs` arm it is ported
 * from) passes a `null` question embedding. Nothing here changes that. What
 * this file adds are the PRODUCERS of the inputs `retrieveContext*` already
 * knows how to consume: the question's vector ({@link embedQuestion}, the
 * concrete function `turnEngine.ts`'s `AskDeps.embedQuestion` seam was
 * declared against and left unwired) and the chunk vectors the blend scores
 * against ({@link backfillEmbeddings}). Per this batch's rules nothing here is
 * invoked from a bootstrap file yet — same posture as `autoIndex.ts` and
 * `privacy.ts`, the two sibling room-lifecycle background passes.
 *
 * WHAT IS REAL, against already-ported dependencies:
 *  - {@link passIsCurrent} — `pass_is_current`, verbatim, with the Rust
 *    suite's own three tests.
 *  - {@link embedAt}/{@link embedViaSidecar}/{@link embedQuestion} — a REAL
 *    POST to the sidecar's `/embed` (`arcelle_sidecar/server.py:542`), through
 *    the already-ported `ensureUp`/`busy`/`authedHeaders` (`sidecar.ts`) and
 *    `resolvedBaseUrl` (`engineRouting.ts`), parsed exactly as
 *    `ollama::embed` parses it.
 *  - `extensionOf`/`isImage` (`editMatchExtraction.ts`), `mediaKind`
 *    (`peaksTools.ts`, a verbatim port of `stt::media_kind`) and
 *    `isOcrCandidate` (`ocrTools.ts`, `ocr::is_ocr_candidate`) are IMPORTED,
 *    not re-declared and not stubbed — `ocrTools.ts` is the canonical home;
 *    this file used to carry its own byte-identical copy of the one-liner,
 *    a duplication a later cleanup pass removed. Getting these wrong is not
 *    cosmetic: with
 *    `isImage`/`isOcrCandidate`/`mediaKind` stubbed to "no", every scan, photo
 *    and recording in the room is fed to the document extractor by
 *    {@link runReextractBackfill} — the exact thing `backfill.rs`'s skip
 *    branch exists to prevent.
 *  - {@link runReextractBackfill}/{@link runLegacyTextRepair} — the room-pin
 *    discipline (path AND epoch re-checked before every write, at exactly the
 *    points `backfill.rs` re-checks them), the settings-stamp gate, the
 *    unchanged-text skip, and every `db-host/*` call.
 *  - {@link runEmbedBackfillPass}/{@link backfillEmbeddings}/
 *    {@link spawnEmbeddingBackfill} — the batch loop, the generation-stamped
 *    supersession, the idle poll and the embed-failure backoff, against real
 *    `chunksMissingEmbedding`/`setChunkEmbedding` and a real `RoomSource`
 *    (`jobs.ts`) rather than an invented `AppState`.
 *
 * THE ONE HONEST STUB (rule 3): {@link ExtractionDeps.extractText}, standing
 * in for `extraction::extract_text`. It is a REQUIRED field with no default,
 * so a production wiring that forgets it fails to compile;
 * {@link extractTextNotImplemented} is the labeled stub to pass meanwhile.
 * Answering `null` is not a fabrication — Rust's own `extract_text` returns
 * `Option<String>` and `None` ("could not read this file") is a real outcome
 * both passes already skip a file on.
 *
 * There IS a partial port: `editMatch.ts`'s `extractText` reads text
 * extensions + `.docx` + `.html` only, and `scriptRun.ts` already wires it as
 * its own extractor. It is a reasonable dependency for
 * {@link runReextractBackfill}. It is NOT one for
 * {@link runLegacyTextRepair} — read the next paragraph before wiring it
 * there.
 *
 * THE STAMP HAZARD, which is why `extractText` stays required rather than
 * defaulting to anything: {@link runLegacyTextRepair} writes
 * `legacy_text_repaired_v1` into `settings` on EVERY completed run, whether or
 * not it repaired anything — that is `backfill.rs`'s own behavior, and the
 * escape hatch its comment names is "bump the stamp when an extractor is
 * corrected again". So running this pass with an extractor that cannot read
 * `.doc`/`.ppt` (the stub, or `editMatch.ts`'s narrowed one) marks every room
 * as swept while sweeping nothing, and those rooms will never be swept again
 * under this stamp once the legacy readers land. Wire a real
 * `extraction::legacy` port first, or bump {@link REPAIR_STAMP} when you do.
 *
 * DELIBERATELY NOT CALLED, matching gaps `engineRouting.ts` already documents
 * for its own `/models` and `/handoff_summary` POSTs: `ollama::wake_daemon()`
 * (spawning the local `ollama serve` process — `ollama_lifecycle.rs`'s process
 * dance, not the same thing `isAwake` does, which only probes),
 * `commands::inject_policy` (PRIV-1's redaction door) and
 * `ensure_provider_catalog`/`inject_provider_runtime`. A cold daemon surfaces
 * as a real transport error from the sidecar, which every caller here already
 * treats as "no embedding" — never a silent hang, never a fabricated vector.
 * One consequence worth naming: `ollama::sidecar_post` maps the sidecar's
 * `{code}` envelope back to the `OLLAMA_DOWN` / `MODEL_MISSING:<model>`
 * sentinels, and {@link embedAt} does not. Nothing here branches on them —
 * both of `backfill.rs`'s embed callers swallow every error identically — but
 * a future caller that wants to TELL THE USER which failure happened needs
 * that mapping added at this seam.
 *
 * DEVIATION — two independent counters, kept independent. The epoch the two
 * sweeps pin against is `AppState::room_epoch()` (bumped by every room
 * open/teardown/rollback); the generation {@link backfillEmbeddings} pins
 * against is `AppState::embed_generation` (bumped only by
 * {@link spawnEmbeddingBackfill}). The Rust source never merges them and
 * neither does this port: `roomEpoch()` is an explicit field on each sweep's
 * deps — following `privacy.ts`, which takes `rooms: RoomSource` from
 * `jobs.ts` PLUS its own `roomEpoch(): number` for this identical gap rather
 * than inventing a second room-state shape — and the embed generation is
 * {@link EmbedBackfillState}.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { authedHeaders, busy, ensureUp } from "./sidecar.js";
import { resolvedBaseUrl } from "./engineRouting.js";
import { extensionOf, isImage } from "./editMatchExtraction.js";
import { mediaKind } from "./peaksTools.js";
import { isOcrCandidate } from "./ocrTools.js";
import {
  filesMissingText,
  filesWithBytes,
  getFileFull,
  setFileExtractedText,
  updateFileContent,
} from "./db-host/files.js";
import { getSetting, setSetting } from "./db-host/settings.js";
import {
  chunksMissingEmbedding,
  embeddingToBlob,
  setChunkEmbedding,
} from "./db-host/embeddings.js";
import { pinnedDb, type RoomSource } from "./jobs.js";
import { readRoomFile } from "./workspace/roomContent.js";

interface ExtractionCandidate {
  id: string;
  name: string;
  mime: string;
  bytes: Buffer;
  expectedHash: string | null;
  workspace: boolean;
}

type OpenRoom = NonNullable<ReturnType<RoomSource["current"]>>;

type WorkspaceExtractionRow = {
  id: string;
  name: string;
  mime: string;
  content_sha256: string | null;
};

function legacyExtractionCandidates(
  room: OpenRoom,
  missingOnly: boolean,
): ExtractionCandidate[] {
  const rows = missingOnly ? filesMissingText(room.db) : filesWithBytes(room.db);
  return rows.map(([id, name, mime, bytes]) => ({
    id,
    name,
    mime,
    bytes,
    expectedHash: null,
    workspace: false,
  }));
}

function workspaceExtractionRows(room: OpenRoom, missingOnly: boolean): WorkspaceExtractionRow[] {
  const missingTextWhere = missingOnly
    ? "AND (extracted_text IS NULL OR trim(extracted_text) = '')"
    : "";
  return room.db.prepare(
    `SELECT id, name, coalesce(mime_type, '') AS mime, content_sha256
       FROM files
      WHERE trashed_at IS NULL AND storage_kind = 'workspace' ${missingTextWhere}`,
  ).all() as WorkspaceExtractionRow[];
}

async function workspaceExtractionCandidate(
  room: OpenRoom,
  row: WorkspaceExtractionRow,
): Promise<ExtractionCandidate | null> {
  try {
    const bytes = (await readRoomFile(room, row.id)).bytes;
    if (bytes === null) {
      return null;
    }
    return {
      id: row.id,
      name: row.name,
      mime: row.mime,
      bytes,
      expectedHash: row.content_sha256,
      workspace: true,
    };
  } catch {
    // Offline or externally removed normal files are skipped safely.
    return null;
  }
}

async function workspaceExtractionCandidates(
  room: OpenRoom,
  missingOnly: boolean,
): Promise<ExtractionCandidate[]> {
  const candidates: ExtractionCandidate[] = [];
  for (const row of workspaceExtractionRows(room, missingOnly)) {
    const candidate = await workspaceExtractionCandidate(room, row);
    if (candidate !== null) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

async function extractionCandidates(
  room: OpenRoom,
  missingOnly: boolean,
): Promise<ExtractionCandidate[]> {
  if (room.workspace !== undefined) {
    return workspaceExtractionCandidates(room, missingOnly);
  }
  return legacyExtractionCandidates(room, missingOnly);
}

function commitLegacyExtractedText(
  db: Database.Database,
  candidate: ExtractionCandidate,
  text: string,
): void {
  updateFileContent(db, candidate.id, candidate.bytes, text);
}

function workspaceTextIsCurrent(db: Database.Database, candidate: ExtractionCandidate): boolean {
  const current = db.prepare(
    `SELECT content_sha256 FROM files
      WHERE id = ? AND storage_kind = 'workspace' AND trashed_at IS NULL`,
  ).get(candidate.id) as { content_sha256: string | null } | undefined;
  return current !== undefined && current.content_sha256 === candidate.expectedHash;
}

function commitWorkspaceExtractedText(
  db: Database.Database,
  candidate: ExtractionCandidate,
  text: string,
): boolean {
  if (!workspaceTextIsCurrent(db, candidate)) {
    return false;
  }
  setFileExtractedText(db, candidate.id, text);
  return true;
}

function commitExtractedText(
  db: Database.Database,
  candidate: ExtractionCandidate,
  text: string,
): boolean {
  if (candidate.workspace) {
    return commitWorkspaceExtractedText(db, candidate, text);
  }
  commitLegacyExtractedText(db, candidate, text);
  return true;
}
import { REPAIRED_EXTENSIONS } from "./retrievalEmbeddingBackfill.js";
export { EMBED_BACKFILL_BATCH, EMBED_IDLE_POLL_MS, EMBED_RETRY_BACKOFF_MS, REPAIR_STAMP, passIsCurrent, embedAt, embedViaSidecar, embedQuestion, createEmbedBackfillState, runEmbedBackfillPass, backfillEmbeddings, spawnEmbeddingBackfill } from "./retrievalEmbeddingBackfill.js";
export type { EmbedFn, EmbedBackfillState, EmbedBackfillDeps, EmbedBackfillOpts, EmbedBackfillOutcome } from "./retrievalEmbeddingBackfill.js";

export { extractTextNotImplemented, runReextractBackfill, spawnReextractBackfill, runLegacyTextRepair, spawnLegacyTextRepair } from "./retrievalExtractionBackfill.js";
export type { ExtractionDeps, ReextractBackfillDeps, LegacyTextRepairDeps } from "./retrievalExtractionBackfill.js";


export { ExtractionCandidate, OpenRoom, REPAIRED_EXTENSIONS, commitExtractedText, extractionCandidates };
