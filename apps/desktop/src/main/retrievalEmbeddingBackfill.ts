import type Database from "better-sqlite3-multiple-ciphers";
import { authedHeaders, busy, ensureUp } from "./sidecar.js";
import { resolvedBaseUrl } from "./engineRouting.js";
import { chunksMissingEmbedding, embeddingToBlob, setChunkEmbedding } from "./db-host/embeddings.js";
import { type RoomSource } from "./jobs.js";
import { OpenRoom } from "./retrievalBackfill.js";

export

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
export

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
export

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
function embedRoomForGeneration(
  deps: EmbedBackfillDeps,
  state: EmbedBackfillState,
  generation: number,
): OpenRoom | null {
  if (state.generation !== generation) {
    return null;
  }
  return deps.rooms.current();
}
export function missingEmbeddingBatch(room: OpenRoom): Array<[string, string, string]> {
  try {
    return chunksMissingEmbedding(room.db, EMBED_BACKFILL_BATCH);
  } catch {
    return [];
  }
}
export function embeddingTexts(batch: ReadonlyArray<[string, string, string]>): string[] {
  return batch.map(([, name, text]) => `search_document: ${name}\n${text}`);
}
export async function requestedEmbeddings(
  embed: EmbedFn,
  texts: readonly string[],
): Promise<number[][] | null> {
  try {
    const vectors = await embed(EMBED_MODEL, texts, "30s");
    return vectors.length === texts.length ? vectors : null;
  } catch {
    return null;
  }
}
export function currentEmbeddingWriteRoom(
  deps: EmbedBackfillDeps,
  state: EmbedBackfillState,
  generation: number,
  sourcePath: string,
): OpenRoom | null {
  const room = deps.rooms.current();
  if (room === null) {
    return null;
  }
  return passIsCurrent(generation, state.generation, sourcePath, room.path) ? room : null;
}
export function writeEmbedding(
  db: Database.Database,
  chunkId: string | undefined,
  vector: number[] | undefined,
): boolean {
  if (chunkId === undefined || vector === undefined || vector.length === 0) {
    return false;
  }
  try {
    setChunkEmbedding(db, chunkId, embeddingToBlob(vector));
    return true;
  } catch {
    // best-effort, mirrors Rust's `let _ = db::set_chunk_embedding(...)`.
    return false;
  }
}
export function writeEmbeddings(
  db: Database.Database,
  batch: ReadonlyArray<[string, string, string]>,
  vectors: ReadonlyArray<number[]>,
): number {
  let written = 0;
  for (let index = 0; index < batch.length; index += 1) {
    if (writeEmbedding(db, batch[index]?.[0], vectors[index])) {
      written += 1;
    }
  }
  return written;
}


export async function runEmbedBackfillPass(
  deps: EmbedBackfillDeps,
  state: EmbedBackfillState,
  generation: number
): Promise<EmbedBackfillOutcome> {
  const room = embedRoomForGeneration(deps, state, generation);
  if (room === null) {
    return { kind: "stale" };
  }
  const batch = missingEmbeddingBatch(room);
  if (batch.length === 0) {
    return { kind: "idle" };
  }
  const vectors = await requestedEmbeddings(deps.embed ?? embedViaSidecar, embeddingTexts(batch));
  if (vectors === null) {
    return { kind: "embedFailed" };
  }

  // Write back only if this is still the same open room at the same
  // generation — the slow embed call was just awaited above.
  const writeRoom = currentEmbeddingWriteRoom(deps, state, generation, room.path);
  if (writeRoom === null) {
    return { kind: "stale" };
  }
  return { kind: "wrote", count: writeEmbeddings(writeRoom.db, batch, vectors) };
}
export

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
export

/**
 * ADD-13: background pass that fills `chunks.embedding` for the open room —
 * ported from `backfill_embeddings`. Drains NULL-embedding chunks in batches,
 * then idles, picking up chunks later imports/edits add, until the room
 * closes, a different room opens, or a newer pass is spawned (the generation
 * stamp moves). {@link runEmbedBackfillPass} answering `"stale"` is this
 * loop's only way to stop — an intentionally unbounded loop, exactly like the
 * Rust source.
 */
interface EmbedBackfillTiming {
  idleMs: number;
  errorBackoffMs: number;
  sleep: (ms: number) => Promise<void>;
}
export function embedBackfillTiming(opts: EmbedBackfillOpts): EmbedBackfillTiming {
  return {
    idleMs: opts.idleMs ?? EMBED_IDLE_POLL_MS,
    errorBackoffMs: opts.errorBackoffMs ?? EMBED_RETRY_BACKOFF_MS,
    sleep: opts.sleep ?? realSleep,
  };
}
export async function continueEmbeddingBackfill(
  outcome: EmbedBackfillOutcome,
  timing: EmbedBackfillTiming,
): Promise<boolean> {
  if (outcome.kind === "stale") {
    return false;
  }
  if (outcome.kind === "idle") {
    await timing.sleep(timing.idleMs);
  }
  if (outcome.kind === "embedFailed") {
    await timing.sleep(timing.errorBackoffMs);
  }
  return true;
}


export async function backfillEmbeddings(
  deps: EmbedBackfillDeps,
  state: EmbedBackfillState,
  generation: number,
  opts: EmbedBackfillOpts = {}
): Promise<void> {
  const timing = embedBackfillTiming(opts);
  for (;;) {
    const outcome = await runEmbedBackfillPass(deps, state, generation);
    if (!(await continueEmbeddingBackfill(outcome, timing))) {
      return;
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
