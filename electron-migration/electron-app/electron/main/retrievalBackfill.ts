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

import { authedHeaders, busy, ensureUp } from "./sidecar.js";
import { resolvedBaseUrl } from "./engineRouting.js";
import { extensionOf, isImage } from "./editMatchExtraction.js";
import { mediaKind } from "./peaksTools.js";
import { isOcrCandidate } from "./ocrTools.js";
import {
  filesMissingText,
  filesWithBytes,
  getFileFull,
  updateFileContent,
} from "./db-host/files.js";
import { getSetting, setSetting } from "./db-host/settings.js";
import {
  chunksMissingEmbedding,
  embeddingToBlob,
  setChunkEmbedding,
} from "./db-host/embeddings.js";
import { pinnedDb, type RoomSource } from "./jobs.js";

// ============================================================================
// Constants — verbatim from backfill.rs / ollama.rs
// ============================================================================

/** `ollama.rs`'s own `EMBED_MODEL`. Copied verbatim rather than imported: the
 * only other spelling in this tree (`turnContext.ts`) is a private module
 * constant recognizing an embed model BY NAME, for a different purpose. */
const EMBED_MODEL = "nomic-embed-text";

/** How many chunks one backfill batch embeds at once — `backfill.rs`'s own
 * `const BATCH: usize = 32`. */
export const EMBED_BACKFILL_BATCH = 32;

/** How long an EMPTY batch (fully indexed, for now) waits before re-polling
 * for chunks a later import or edit added — `Duration::from_secs(10)`. */
export const EMBED_IDLE_POLL_MS = 10_000;

/** How long a FAILED embed call (model missing, Ollama down, a wrong-length
 * response) backs off before retrying — `Duration::from_secs(60)`. */
export const EMBED_RETRY_BACKOFF_MS = 60_000;

/** Extensions whose extractor was CORRECTED, not merely extended — verbatim
 * from `REPAIRED_EXTENSIONS`. A `.doc` imported before the fix held the font
 * table and mojibake; a `.ppt` held the slide master's placeholder prompts and
 * binary noise. That text was what the search index and the model were given. */
const REPAIRED_EXTENSIONS: ReadonlySet<string> = new Set(["doc", "ppt"]);

/** The settings key recording that a room has been swept for
 * {@link REPAIRED_EXTENSIONS} — verbatim from `REPAIR_STAMP`. Bump it when an
 * extractor is corrected again; the sweep then re-runs once per room and never
 * again. See this file's module doc on the stamp hazard. */
export const REPAIR_STAMP = "legacy_text_repaired_v1";

// ============================================================================
// pass_is_current — pure
// ============================================================================

/**
 * May a pass that started as `carriedGeneration`, against `carriedPath`, still
 * write into the room now open at `roomPath`? Ported verbatim from
 * `pass_is_current`.
 *
 * Both halves matter and neither implies the other. A newer pass having taken
 * the slot (the generation moved) means these vectors were computed against a
 * corpus this pass no longer owns; a different room path means they belong to
 * a different room entirely.
 */
export function passIsCurrent(
  carriedGeneration: number,
  currentGeneration: number,
  carriedPath: string,
  roomPath: string
): boolean {
  return carriedGeneration === currentGeneration && carriedPath === roomPath;
}

// ============================================================================
// ocr::is_ocr_candidate — a real port, not a seam
// ============================================================================

// ============================================================================
// ollama::embed / embed_question
// ============================================================================

/** `ollama::embed`'s own signature: one vector per input text, in the same
 * order. Throws — never a fabricated vector — on a transport failure, a
 * missing model, or a malformed response. Each caller decides what "no
 * embedding" means for its own contract ({@link embedQuestion}'s
 * `null`-on-any-failure vs {@link runEmbedBackfillPass}'s
 * back-off-and-retry). */
export type EmbedFn = (
  model: string,
  texts: readonly string[],
  keepAlive: string
) => Promise<number[][]>;

/**
 * The testable core of `ollama::embed`: POST `{model, texts, base_url,
 * keep_alive}` to an EXPLICIT sidecar base URL's `/embed` (the sidecar's own
 * `EmbedRequest`) and parse `{embeddings}`. Split from
 * {@link embedViaSidecar} the way `engineRouting.ts` splits `listModelsAt`
 * from `listModels`, so a test can drive it against a fake HTTP server with no
 * real sidecar process.
 *
 * `texts` being empty short-circuits to `[]` with no network call, matching
 * Rust's own `if texts.is_empty() { return Ok(Vec::new()); }`.
 */
export async function embedAt(
  base: string,
  model: string,
  texts: readonly string[],
  keepAlive: string
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }
  const resp = await fetch(`${base}/embed`, {
    method: "POST",
    headers: { ...authedHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      model,
      texts,
      base_url: resolvedBaseUrl(),
      keep_alive: keepAlive,
    }),
  });
  if (!resp.ok) {
    throw new Error(`sidecar /embed status ${resp.status}`);
  }
  const value = (await resp.json()) as Record<string, unknown> | null;
  const embeddings = value === null ? undefined : value.embeddings;
  if (!Array.isArray(embeddings)) {
    // Rust: `v["embeddings"].as_array().ok_or("Embed response had no embeddings")?`
    throw new Error("Embed response had no embeddings");
  }
  // Rust's `e.as_array().map(...).unwrap_or_default()`: a non-array entry is an
  // EMPTY vector (which both callers already treat as "no embedding for this
  // one"), and `filter_map(|n| n.as_f64())` drops a non-numeric element rather
  // than propagating it as NaN. The f32 narrowing happens at storage time, in
  // {@link embeddingToBlob}'s `writeFloatLE`.
  return embeddings.map((e) =>
    Array.isArray(e) ? e.filter((n): n is number => typeof n === "number") : []
  );
}

/** As {@link embedAt}, but resolving the sidecar's base URL itself
 * (`ensureUp`) and holding a {@link busy} guard for the call — the production
 * entry point, mirroring `engineRouting.ts`'s `listModels` wrapping
 * `listModelsAt`. See this file's module doc for what `ollama::embed` does
 * around this that is deliberately not done here. */
export async function embedViaSidecar(
  model: string,
  texts: readonly string[],
  keepAlive: string
): Promise<number[][]> {
  const base = await ensureUp();
  const guard = busy();
  try {
    return await embedAt(base, model, texts, keepAlive);
  } finally {
    guard.release();
  }
}

/**
 * ADD-13: embed the question so retrieval can blend meaning with keywords.
 * Ported from `embed_question`. Returns `null` on ANY failure (model missing,
 * sidecar/Ollama down, an empty result) so the caller silently falls back to
 * the pure keyword path — the chat never blocks. CHG-12: `nomic-embed-text`
 * expects the `search_query:` task prefix on queries, matching the
 * `search_document:` side {@link runEmbedBackfillPass} embeds chunks with.
 * The 5-minute `keep_alive` is what keeps the small embed model briefly warm
 * so back-to-back questions are fast.
 *
 * `embed` is injectable — defaulting to the real {@link embedViaSidecar} — so
 * a unit test needs no HTTP server. The return type is exactly the shape
 * `turnEngine.ts`'s `AskDeps.embedQuestion` already declares.
 */
export async function embedQuestion(
  question: string,
  embed: EmbedFn = embedViaSidecar
): Promise<readonly number[] | null> {
  const prefixed = `search_query: ${question}`;
  try {
    const vectors = await embed(EMBED_MODEL, [prefixed], "5m");
    const first = vectors[0];
    return first !== undefined && first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

// ============================================================================
// backfill_embeddings / spawn_embedding_backfill
// ============================================================================

/** `AppState::embed_generation`'s stand-in — the same generation-stamp pattern
 * `autoIndex.ts`'s `AutoIndexState` uses for its own counter. Bumping it
 * invalidates any older running pass, which exits at its next check rather
 * than writing vectors computed against a corpus it no longer owns. */
export interface EmbedBackfillState {
  generation: number;
}

export function createEmbedBackfillState(): EmbedBackfillState {
  return { generation: 0 };
}

/** Everything {@link runEmbedBackfillPass}/{@link backfillEmbeddings} need. */
export interface EmbedBackfillDeps {
  rooms: RoomSource;
  /** `ollama::embed` — defaults to the real {@link embedViaSidecar}. */
  embed?: EmbedFn;
}

/** Timing knobs, overridable so a test never waits on the real 10 s / 60 s —
 * `autoIndex.ts`'s `AutoIndexOpts` convention. */
export interface EmbedBackfillOpts {
  /** Overrides {@link EMBED_IDLE_POLL_MS}. */
  idleMs?: number;
  /** Overrides {@link EMBED_RETRY_BACKOFF_MS}. */
  errorBackoffMs?: number;
  /** `tokio::time::sleep` — injectable so a test can advance the loop
   * deterministically instead of racing a real timer. Defaults to a real,
   * `unref`'d sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** How one iteration of the `backfill_embeddings` loop body ended. Rust
 * expresses these as `return`/`continue`/falling off the body; naming them
 * makes {@link runEmbedBackfillPass} testable one iteration at a time — the
 * same `runAutoIndexPass`/`runAutoIndex` split `autoIndex.ts` uses. */
export type EmbedBackfillOutcome =
  /** The generation moved, or the room is closed / was swapped mid-call —
   * {@link backfillEmbeddings} STOPS, matching Rust's bare `return`. */
  | { readonly kind: "stale" }
  /** No chunk currently lacks an embedding — sleep, then poll again. */
  | { readonly kind: "idle" }
  /** The embed call failed or returned the wrong number of vectors — sleep,
   * then retry. Keyword retrieval keeps working meanwhile. */
  | { readonly kind: "embedFailed" }
  /** Wrote `count` chunk embeddings (a per-vector failure is swallowed and not
   * counted, matching `let _ = db::set_chunk_embedding(...)`) — loop again
   * immediately, no sleep. */
  | { readonly kind: "wrote"; readonly count: number };

/**
 * One iteration of `backfill_embeddings`'s loop body: read a batch of
 * NULL-embedding chunks from the currently open room, embed them (CHG-12's
 * `search_document:` prefix, with the file name prepended for context), and
 * write the vectors back — but only if the room this batch was read from is
 * still the one open, at the same generation, once the slow embed call
 * returns. The room is never held across that call.
 *
 * A batch-read failure reads as an EMPTY batch (`idle`), matching Rust's
 * `.unwrap_or_default()`: a transient DB hiccup is not grounds to stop the
 * whole background pass, only to skip this tick's work.
 */
export async function runEmbedBackfillPass(
  deps: EmbedBackfillDeps,
  state: EmbedBackfillState,
  generation: number
): Promise<EmbedBackfillOutcome> {
  const embed = deps.embed ?? embedViaSidecar;

  if (state.generation !== generation) {
    return { kind: "stale" };
  }
  const room = deps.rooms.current();
  if (room === null) {
    return { kind: "stale" };
  }
  const path = room.path;

  let batch: Array<[string, string, string]>;
  try {
    batch = chunksMissingEmbedding(room.db, EMBED_BACKFILL_BATCH);
  } catch {
    batch = [];
  }
  if (batch.length === 0) {
    return { kind: "idle" };
  }

  const texts = batch.map(([, name, text]) => `search_document: ${name}\n${text}`);
  let vectors: number[][] | null;
  try {
    const got = await embed(EMBED_MODEL, texts, "30s");
    vectors = got.length === texts.length ? got : null;
  } catch {
    vectors = null;
  }
  if (vectors === null) {
    return { kind: "embedFailed" };
  }

  // Write back only if this is still the same open room at the same
  // generation — the slow embed call was just awaited above.
  const currentGeneration = state.generation;
  const writeRoom = deps.rooms.current();
  if (writeRoom === null || !passIsCurrent(generation, currentGeneration, path, writeRoom.path)) {
    return { kind: "stale" };
  }
  let written = 0;
  for (let i = 0; i < batch.length; i++) {
    const vec = vectors[i];
    const chunkId = batch[i]?.[0];
    if (vec === undefined || vec.length === 0 || chunkId === undefined) {
      continue;
    }
    try {
      setChunkEmbedding(writeRoom.db, chunkId, embeddingToBlob(vec));
      written += 1;
    } catch {
      // best-effort, mirrors Rust's `let _ = db::set_chunk_embedding(...)`.
    }
  }
  return { kind: "wrote", count: written };
}

/** Sleep without holding the process open on the timer alone — the same
 * private helper, of the same shape, `autoIndex.ts` and `jobScheduler.ts` each
 * keep. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer: unknown = setTimeout(resolve, ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  });
}

/**
 * ADD-13: background pass that fills `chunks.embedding` for the open room —
 * ported from `backfill_embeddings`. Drains NULL-embedding chunks in batches,
 * then idles, picking up chunks later imports/edits add, until the room
 * closes, a different room opens, or a newer pass is spawned (the generation
 * stamp moves). {@link runEmbedBackfillPass} answering `"stale"` is this
 * loop's only way to stop — an intentionally unbounded loop, exactly like the
 * Rust source.
 */
export async function backfillEmbeddings(
  deps: EmbedBackfillDeps,
  state: EmbedBackfillState,
  generation: number,
  opts: EmbedBackfillOpts = {}
): Promise<void> {
  const idleMs = opts.idleMs ?? EMBED_IDLE_POLL_MS;
  const errorBackoffMs = opts.errorBackoffMs ?? EMBED_RETRY_BACKOFF_MS;
  const sleep = opts.sleep ?? realSleep;
  for (;;) {
    const outcome = await runEmbedBackfillPass(deps, state, generation);
    switch (outcome.kind) {
      case "stale":
        return;
      case "idle":
        await sleep(idleMs);
        break;
      case "embedFailed":
        await sleep(errorBackoffMs);
        break;
      case "wrote":
        break; // loop immediately — more of this room's chunks may remain
    }
  }
}

/**
 * ADD-13: kick off the lazy background embed pass for the currently open room.
 * Ported from `spawn_embedding_backfill`: bumps the embed generation (so any
 * older pass exits at its next check) and starts exactly one loop carrying the
 * new stamp. Cheap to call on every unlock; a no-op once every chunk has a
 * vector (the loop just idles). Returns the generation it runs under, so a
 * caller can tell which pass is live.
 *
 * Fire-and-forget, matching `tauri::async_runtime::spawn` — but a bare
 * detached promise would let an unexpected throw escape as an unhandled
 * rejection, which takes the Electron main process down. `.catch` is the floor
 * under that, reported rather than swallowed (`scheduleAutoIndex` and
 * `schedulePrivacyScan` set the same precedent).
 */
export function spawnEmbeddingBackfill(
  deps: EmbedBackfillDeps,
  state: EmbedBackfillState,
  opts: EmbedBackfillOpts = {}
): number {
  const generation = state.generation + 1;
  state.generation = generation;
  void backfillEmbeddings(deps, state, generation, opts).catch((err: unknown) => {
    console.error(`embedding backfill ${generation} failed:`, err);
  });
  return generation;
}

// ============================================================================
// spawn_reextract_backfill / spawn_legacy_text_repair
// ============================================================================

/**
 * The one `extraction.rs` dependency neither sweep can do without. REQUIRED,
 * never defaulted — see this file's module doc for what is already ported
 * (`extensionOf`/`isImage`/`mediaKind`/`isOcrCandidate`, all imported or
 * ported here for real), what a partial port would buy, and why the stamp
 * hazard makes "pick an extractor" a decision for the call site.
 */
export interface ExtractionDeps {
  /** `extraction::extract_text(name, bytes)`. `null` = could not extract — a
   * real, expected Rust outcome (`Option<String>`) both sweeps skip a file
   * on, not an error. */
  extractText: (name: string, bytes: Buffer) => string | null;
}

const EXTRACT_TEXT_NOT_IMPLEMENTED_REASON =
  "NOT_IMPLEMENTED: extraction::extract_text (the full pdf/xlsx/pptx/legacy " +
  ".doc/.ppt/epub/rtf/... dispatcher, src-tauri/src/extraction.rs) has no " +
  "Electron port — this backfill pass has nothing to re-extract this file " +
  "with. editMatch.ts's extractText is a NARROWED port (text extensions + " +
  ".docx + .html) and reads none of the formats either sweep exists for.";

/**
 * The stub to wire into {@link ExtractionDeps.extractText} until a real
 * extractor exists — the field is required, so nothing falls back to this on
 * its own. Answers `null` ("could not extract"), which is a real Rust outcome
 * rather than a fabricated one: the caller skips the file exactly as it would
 * for a genuine extraction miss, and the labeled reason is logged so a
 * forgotten wiring is never mistaken for a room that had nothing to fix.
 *
 * Do NOT wire this into {@link runLegacyTextRepair} in production — see this
 * file's module doc on the stamp hazard.
 */
export const extractTextNotImplemented: ExtractionDeps["extractText"] = () => {
  console.error(EXTRACT_TEXT_NOT_IMPLEMENTED_REASON);
  return null;
};

/** Everything {@link runReextractBackfill} needs beyond the room. */
export interface ReextractBackfillDeps extends ExtractionDeps {
  rooms: RoomSource;
  /** `AppState::room_epoch()` — bumped by every room open/teardown/rollback.
   * A SEPARATE counter from {@link EmbedBackfillState.generation}; see this
   * file's module doc. */
  roomEpoch: () => number;
  /** Best-effort `app.emit("room-files-changed", ())`, mirroring Rust's
   * `let _ = app.emit(...)` — the same optional seam `scriptRun.ts` and
   * `recBridge.ts` already declare for this identical event. */
  notifyFilesChanged?: () => void;
}

/**
 * One-shot re-extraction pass for files imported before an extractor
 * improvement, which therefore carry no text at all (the motivating case:
 * all-numeric `.xlsx` files stored when the extractor only read shared
 * strings). Ported from `spawn_reextract_backfill`'s closure body. Runs the
 * current extractor over their stored bytes and re-indexes any that now yield
 * text. Scans, photos and recordings are left to the OCR/STT workers.
 *
 * Pinned at (path, epoch) captured BEFORE the loop and re-checked before every
 * write. A mismatch is a bare `return` from the WHOLE pass, not a `continue`:
 * a rollback mid-pass means every remaining candidate's bytes are also
 * pre-rollback, so the rest of the batch is abandoned too. That is Rust's own
 * control flow, and it also means an abandoned pass never reaches its own
 * trailing `room-files-changed` — a pass cut off mid-flight has nothing of its
 * own to report.
 */
export async function runReextractBackfill(deps: ReextractBackfillDeps): Promise<void> {
  const startRoom = deps.rooms.current();
  if (startRoom === null) {
    return;
  }
  const path = startRoom.path;
  const epoch = deps.roomEpoch();

  let candidates: Array<[string, string, string, Buffer]>;
  try {
    candidates = filesMissingText(startRoom.db);
  } catch {
    candidates = []; // matches Rust's `.unwrap_or_default()`
  }

  let fixed = 0;
  for (const [id, name, mime, bytes] of candidates) {
    const ext = extensionOf(name);
    // Skip scans/photos/media — their text arrives via the OCR/STT workers.
    if (isImage(mime) || isOcrCandidate(mime, ext) || mediaKind(mime, ext) !== null) {
      continue;
    }
    const text = deps.extractText(name, bytes);
    if (text === null) {
      continue;
    }

    // Wave 3 (Idea 9) epoch pin: a rollback swapped the DB, so these
    // pre-rollback bytes must not be written into the restored room.
    const db = pinnedDb(deps.rooms, path);
    if (db === null || deps.roomEpoch() !== epoch) {
      return;
    }
    try {
      updateFileContent(db, id, bytes, text);
      fixed += 1;
    } catch {
      // A failed write did not fix this file — not counted, and not fatal to
      // the rest of the pass. Matches Rust's `if ....is_ok() { fixed += 1 }`.
    }
  }

  if (fixed > 0) {
    deps.notifyFilesChanged?.();
  }
}

/** Fire-and-forget wrapper for {@link runReextractBackfill} —
 * `tauri::async_runtime::spawn`'s analogue, with the same `.catch` floor
 * {@link spawnEmbeddingBackfill} explains. */
export function spawnReextractBackfill(deps: ReextractBackfillDeps): void {
  void runReextractBackfill(deps).catch((err: unknown) => {
    console.error("reextract backfill failed:", err);
  });
}

/** Everything {@link runLegacyTextRepair} needs beyond the room. */
export interface LegacyTextRepairDeps extends ExtractionDeps {
  rooms: RoomSource;
  /** See {@link ReextractBackfillDeps.roomEpoch}. */
  roomEpoch: () => number;
  /** See {@link ReextractBackfillDeps.notifyFilesChanged}. */
  notifyFilesChanged?: () => void;
}

/**
 * Re-read the files whose extractor was WRONG rather than merely incomplete,
 * once per room. Ported from `spawn_legacy_text_repair`'s closure body.
 *
 * Only files whose text actually CHANGES are written, so a room that was
 * already correct is untouched — no version churn, no `room-files-changed`
 * storm, and nothing in History pretending the user edited anything.
 *
 * Stamps {@link REPAIR_STAMP} on exit (room-pin permitting) so the sweep runs
 * once per room and never again — including when it repaired nothing. See this
 * file's module doc before wiring an extractor that cannot read `.doc`/`.ppt`.
 */
export async function runLegacyTextRepair(deps: LegacyTextRepairDeps): Promise<void> {
  const startRoom = deps.rooms.current();
  if (startRoom === null) {
    return;
  }
  const path = startRoom.path;
  const epoch = deps.roomEpoch();

  let stamped: string | null;
  try {
    stamped = getSetting(startRoom.db, REPAIR_STAMP);
  } catch {
    // Rust's `db::get_setting` hands back an Option, so an unreadable settings
    // table reads as "not stamped yet" rather than aborting the sweep.
    stamped = null;
  }
  if (stamped !== null) {
    return;
  }

  let all: Array<[string, string, string, Buffer]>;
  try {
    all = filesWithBytes(startRoom.db);
  } catch {
    all = []; // matches Rust's `.unwrap_or_default()`
  }
  // Filtered in TS with the same `extensionOf` the extractors use — see
  // `filesWithBytes`'s own doc for why this is not expressed in SQL.
  const candidates = all.filter(([, name]) => REPAIRED_EXTENSIONS.has(extensionOf(name)));

  let fixed = 0;
  for (const [id, name, , bytes] of candidates) {
    const text = deps.extractText(name, bytes);
    if (text === null) {
      continue;
    }

    // The same epoch pin as the re-extract pass, and the same whole-pass
    // `return` on a mismatch.
    const db = pinnedDb(deps.rooms, path);
    if (db === null || deps.roomEpoch() !== epoch) {
      return;
    }

    // Unchanged text is not an edit.
    let current: string | null;
    try {
      current = getFileFull(db, id)[3];
    } catch {
      current = null; // matches Rust's `.ok().and_then(...)`
    }
    if (current === text) {
      continue;
    }

    try {
      updateFileContent(db, id, bytes, text);
      fixed += 1;
    } catch {
      // best-effort, same swallow as `runReextractBackfill`.
    }
  }

  const finalDb = pinnedDb(deps.rooms, path);
  if (finalDb === null || deps.roomEpoch() !== epoch) {
    return;
  }
  try {
    setSetting(finalDb, REPAIR_STAMP, "1");
  } catch {
    // best-effort, mirrors Rust's `let _ = db::set_setting(...)`.
  }
  if (fixed > 0) {
    deps.notifyFilesChanged?.();
  }
}

/** Fire-and-forget wrapper for {@link runLegacyTextRepair} — see
 * {@link spawnReextractBackfill}. */
export function spawnLegacyTextRepair(deps: LegacyTextRepairDeps): void {
  void runLegacyTextRepair(deps).catch((err: unknown) => {
    console.error("legacy text repair failed:", err);
  });
}
