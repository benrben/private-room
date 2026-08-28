/**
 * What each picture/video model will actually accept — read, never guessed.
 *
 * Ported from `src-tauri/src/commands/media_limits.rs` (453 lines, read in
 * full, including its `#[cfg(test)] mod tests` — all six reproduced in
 * `mediaLimits.test.ts`).
 *
 * The ordinary model catalogue (`providers.ts`) says a model makes video. It
 * does not say that Veo will take only 4, 6 or 8 seconds, that Kling wants
 * 3–15, or that Runway Aleph 2 has a 56-cent minimum however short the clip.
 * Two dedicated OpenRouter endpoints do — `/videos/models` and
 * `/images/models` — and this module is the cache in front of both. Reading
 * the limits is free; sending an illegal duration is not (a 400 after the
 * user has waited, or on the floor-billed models, a charge for nothing).
 *
 * NO EXEC_TOOL ARM: none of `limitsFor`/`mediaTableLoaded`/`ensureMediaLimits`
 * carry a `#[tauri::command]` in the Rust source — `media_limits.rs` is a
 * support module the Create page's own commands read, not a command surface
 * of its own. Its three callers are `commands/create.rs` (the Create page's
 * model shelf), `commands/story.rs::snap_seconds`, and
 * `commands/jobs/create.rs` (the actual generation request) — the first and
 * third are not ported anywhere in this migration yet, so their read of this
 * cache has no Electron analogue to wire up. `story.rs::snap_seconds` DOES
 * have a port — `storyTools.ts::snapSeconds` — which this batch also
 * upgrades from its documented always-taken degradation to the real lookup,
 * now that the catalogue it needed exists. See that function's doc.
 *
 * WIRE SHAPE: {@link MediaLimits} is not redeclared here. It already exists,
 * camelCase and field-for-field with the Rust struct (which itself derives
 * `#[serde(rename_all = "camelCase")]`), in `shared/apiTypes.ts` as the type
 * of `CreateModel.limits` — so importing it is what keeps this cache and the
 * as-yet-unported `create.ts`'s eventual wire shape from ever drifting apart.
 *
 * CREDENTIAL: `ensure_media_limits(key: &str)` takes the OpenRouter key as a
 * plain argument in Rust — the Keychain read happens at the CALL SITE
 * (`create.rs`'s `openrouter_key()`), not inside this module. This port keeps
 * that shape exactly: {@link ensureMediaLimits} also takes `key` directly.
 * `providers.ts` exports `openrouterKey()` for exactly this reason (see its
 * own module doc's note), so a future `create.ts` port supplies it from
 * there rather than this module growing a second Keychain vocabulary.
 *
 * FETCH SEAM: `OPENROUTER_BASE_URL`, `FetchJsonLike` and `HttpJsonResponseLike`
 * are imported from `providers.ts` rather than redeclared — the Rust source
 * itself does `use super::providers::OPENROUTER_BASE_URL;`, and the fetch
 * shape (bearer auth, the same two branding headers, a 30s whole-request
 * timeout) is identical to `fetchOpenrouterCatalog`'s, so a second copy of
 * that seam would only be a second thing to keep in sync. {@link
 * MediaLimitsDeps} is the same kind of test seam `ProviderDeps` is — real
 * `fetch` by default, overridable so a test never touches the network.
 *
 * SINGLE-FLIGHT LOCK: the Rust source guards its fetch with a
 * `tokio::sync::Mutex<()>` and a `try_lock()`/`lock().await` split — a
 * concurrent caller joins the queue and waits ONLY when there is nothing to
 * serve meanwhile (`media_table_loaded()` is false); with a full table already
 * in hand, a second caller mid-refresh returns immediately rather than
 * sitting through someone else's refresh. Node has no OS threads to race, but
 * concurrent `async` callers still interleave at `await` points, so the same
 * two rules are reproduced with a module-level busy flag (checked
 * synchronously, matching `try_lock`'s non-blocking probe) plus a promise
 * chain (matching `lock().await`'s FIFO wait) — the same translation
 * `providers.ts::ensureProviderCatalog`'s header comment describes for its
 * own, simpler, always-queues version of this pattern.
 */

import type { MediaLimits } from "../shared/apiTypes.js";
import { OPENROUTER_BASE_URL, type FetchJsonLike, type HttpJsonResponseLike } from "./providers.js";

export type { MediaLimits };

// ─────────────────────────────────────────────────────────────── constants

/** How long a fetched limits table is trusted before another attempt is
 * allowed — `media_limits.rs::REFRESH_AFTER` (one hour), in milliseconds
 * since there is no `Duration` to reach for here. Model line-ups change on
 * the order of weeks, and a room open for a fortnight should notice a new
 * model without a restart. */
export const REFRESH_AFTER_MS = 60 * 60 * 1000;

/** How long a HALF table (one of the two endpoints answered, the other did
 * not) is trusted — `media_limits.rs::RETRY_HALF_AFTER` (five minutes). An
 * hour would be far too long to sit on the gap, but retrying on every
 * Create-page open would make each one wait out the failing endpoint's 30s
 * timeout, so the missing half is not chased that hard either. Nothing is
 * EXCLUDED while a table is missing (see {@link mediaTableLoaded}), so the
 * only cost of the wait is the seconds picker. */
export const RETRY_HALF_AFTER_MS = 5 * 60 * 1000;

/** One catalogue GET's whole-request deadline, matching the Rust client's
 * `Duration::from_secs(30)`. */
const MEDIA_FETCH_TIMEOUT_MS = 30_000;

// ─────────────────────────────────────────────────────────────────── types

/** The seam this port adds over the Rust source, mirroring `providers.ts`'s
 * `ProviderDeps`: the default is the real network, overridable so a test
 * never touches it. */
export interface MediaLimitsDeps {
  fetchJson: FetchJsonLike;
}

const realFetchJson: FetchJsonLike = (url, init) => fetch(url, init) as unknown as Promise<HttpJsonResponseLike>;

export const defaultMediaLimitsDeps: MediaLimitsDeps = { fetchJson: realFetchJson };

/** An unpublished `MediaLimits` — `media_limits.rs`'s `MediaLimits::default()`,
 * restated as a function since TS interfaces carry no constructor. Every
 * field reads as "the provider published nothing", which every caller here
 * treats as "send nothing and let the model default" (see the Rust module
 * doc this file was ported from). */
export function emptyMediaLimits(): MediaLimits {
  return {
    durations: [],
    resolutions: [],
    aspectRatios: [],
    frameImages: [],
    maxReferences: null,
    generateAudio: false,
  };
}

// ──────────────────────────────────────────────────────── tiny JSON reader
//
// Restated locally rather than imported from `providers.ts`, which does not
// export its own copy — the same "self-contained module" choice that file's
// header makes for its restated `<Security/SecBase.h>` constants. Mirrors
// `serde_json::Value`'s `Index` semantics: indexing a missing key, or
// indexing into something that is not an object at all, answers "nothing
// here" rather than throwing.

function jget(value: unknown, key: string): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return (value as Record<string, unknown>)[key] ?? null;
  }
  return null;
}

function jstr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Rust's `Value::as_u64()` (narrowed to what this file needs): a JSON number
 * is only an unsigned integer if it really is one. A negative, fractional or
 * non-numeric value reads as "the catalog said nothing", never a rounded
 * guess. */
function jUnsignedInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** `media_limits.rs::strings` — `value.as_array().into_iter().flatten()
 * .filter_map(|v| v.as_str()...)`: a non-array (including a missing field)
 * reads as empty, and non-string entries are dropped rather than stringified. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// ──────────────────────────────────────────────────────── module-level state
//
// `media_limits.rs` guards all of this with `OnceLock<RwLock<…>>`/
// `AtomicBool`/`Mutex<Option<Instant>>` because several OS threads may call
// in at once. Node is single-threaded — the only interleaving is at `await`
// points — so plain module state reproduces the same externally visible
// behavior; see the module doc's SINGLE-FLIGHT LOCK section for the one part
// of this that needs real care.

const limitsCache = new Map<string, MediaLimits>();

/** Which of the two catalogues has ever arrived, tracked separately because
 * they fail separately — `media_limits.rs::VIDEOS_LOADED`/`IMAGES_LOADED`.
 * Set only when that endpoint answered AND named at least one model; never
 * cleared, since the table it filled stays in the cache. */
let videosLoaded = false;
let imagesLoaded = false;

/** When the tables were last (successfully) fetched, or `null` if nothing has
 * ever arrived — `media_limits.rs::fetched_at`, with `Instant` replaced by a
 * plain `Date.now()` millisecond reading (see the report's fidelity note). */
let fetchedAtMs: number | null = null;

let limitsFetchChain: Promise<void> = Promise.resolve();
/** Synchronous stand-in for `tokio::sync::Mutex::try_lock`'s non-blocking
 * probe: true for the entire span between a caller committing to a fetch and
 * that fetch finishing. Toggled only at points where no other call can be
 * interleaved (module state, no intervening `await`), so it is safe to read
 * as an instantaneous "is anyone fetching right now". */
let limitsFetchBusy = false;

/** Test-only. Every singleton above is process-lifetime state in the Rust
 * source too, and `cargo test` hands each `#[test]` a process-fresh copy of
 * it; one `vitest` module instance does not. Never called from production
 * code. */
export function resetMediaLimitsStateForTests(): void {
  limitsCache.clear();
  videosLoaded = false;
  imagesLoaded = false;
  fetchedAtMs = null;
  limitsFetchChain = Promise.resolve();
  limitsFetchBusy = false;
}

// ───────────────────────────────────────────────────────────────── methods
//
// `media_limits.rs`'s `impl MediaLimits` block, restated as free functions —
// this port's convention for a struct with no state of its own beyond the
// fields it carries (see `providers.ts`'s `ModelRuntimeFacts` + its sibling
// `providerModelVision`/`providerModelFacts` functions).

/** `MediaLimits::allows_seconds` — is `seconds` a length this model actually
 * accepts? An unpublished list accepts anything, because the alternative is
 * refusing a legal request on the strength of a table never fetched. */
export function allowsSeconds(limits: MediaLimits, seconds: number): boolean {
  return limits.durations.length === 0 || limits.durations.includes(seconds);
}

/** `MediaLimits::default_seconds` — the length to use when the caller named
 * none, or named an illegal one: the shortest published, which is also the
 * cheapest. `null` when nothing is published at all.
 *
 * A FOLD, not `Math.min(...durations)`: Rust's `.iter().copied().min()` has
 * no length limit, while a spread pushes one argument per element onto the
 * call stack and throws `RangeError: Maximum call stack size exceeded` past
 * ~10^5 of them. `durations` is provider-published JSON — a garbled or
 * hostile `/videos/models` body is exactly the case a limits lookup must
 * survive, since this whole module exists to be non-fatal. */
export function defaultSeconds(limits: MediaLimits): number | null {
  let min: number | null = null;
  for (const d of limits.durations) {
    if (min === null || d < min) {
      min = d;
    }
  }
  return min;
}

/** `MediaLimits::takes_first_frame`. */
export function takesFirstFrame(limits: MediaLimits): boolean {
  return limits.frameImages.includes("first_frame");
}

// ───────────────────────────────────────────────────────────── read access

/** `media_limits.rs::limits_for` — everything known about one model, by bare
 * slug (no engine prefix). `undefined` (Rust: `None`) when the catalogues
 * never named it, or never loaded at all — see {@link mediaTableLoaded} for
 * why those two cases must never be confused. */
export function limitsFor(slug: string): MediaLimits | undefined {
  return limitsCache.get(slug);
}

/**
 * `media_limits.rs::media_table_loaded` — did the media catalogues load at
 * all?
 *
 * This is the difference between "that model has no picture endpoint" and
 * "we could not check", and the two must never be confused. `/videos/models`
 * and `/images/models` ARE the list of models those endpoints serve, so a
 * slug missing from a table that loaded is a settled answer. A slug missing
 * from a table that never arrived is nothing at all, and excluding models on
 * the strength of it would empty the Create page every time the network
 * hiccuped.
 *
 * BOTH tables, not either: a lone video table would make every image model
 * look unserved, and the page would say, as fact, that the provider's
 * picture endpoint refuses them. Half a table answers nothing about the
 * other half's models.
 */
export function mediaTableLoaded(): boolean {
  return videosLoaded && imagesLoaded;
}

// ────────────────────────────────────────────────────────── parsing (pure)

/**
 * `media_limits.rs::parse_video_models` — reads `GET /videos/models`'s own
 * flat field names into `into`, which the images parse below merges into
 * afterwards.
 *
 * Returns how many models were read, which is what tells the caller whether a
 * catalogue actually arrived: zero is a body in a shape this does not
 * recognise, not a provider that serves nothing.
 */
export function parseVideoModels(value: unknown, into: Map<string, MediaLimits>): number {
  let seen = 0;
  const data = jget(value, "data");
  for (const model of Array.isArray(data) ? data : []) {
    const id = jstr(jget(model, "id"));
    if (id === null) continue;
    seen += 1;
    const durationsRaw = jget(model, "supported_durations");
    const durations = Array.isArray(durationsRaw)
      ? durationsRaw.map(jUnsignedInt).filter((n): n is number => n !== null)
      : [];
    into.set(id, {
      durations,
      resolutions: strings(jget(model, "supported_resolutions")),
      aspectRatios: strings(jget(model, "supported_aspect_ratios")),
      frameImages: strings(jget(model, "supported_frame_images")),
      // Video reference counts are not published per model; the request
      // schema caps nothing either, so no number is invented.
      maxReferences: null,
      generateAudio: jget(model, "generate_audio") === true,
    });
  }
  return seen;
}

/**
 * `media_limits.rs::parse_image_models` — the images endpoint publishes a
 * *shape*, not flat lists: each parameter is an object that is either an enum
 * of values or a numeric range.
 *
 * Runs SECOND, into the same map the video parse filled, so a slug published
 * by both endpoints is merged rather than overwritten. An overwrite would
 * blank that model's durations (no seconds picker) and — worse — its frame
 * slots, and an empty frame list is a PUBLISHED "takes no starting picture":
 * a generation path would refuse a legal starting frame on the strength of a
 * field the images endpoint never speaks about.
 *
 * Returns how many models were read — see {@link parseVideoModels}.
 */
export function parseImageModels(value: unknown, into: Map<string, MediaLimits>): number {
  let seen = 0;
  const data = jget(value, "data");
  for (const model of Array.isArray(data) ? data : []) {
    const id = jstr(jget(model, "id"));
    if (id === null) continue;
    seen += 1;
    const params = jget(model, "supported_parameters");
    const resolutions = strings(jget(jget(params, "resolution"), "values"));
    const aspectRatios = strings(jget(jget(params, "aspect_ratio"), "values"));
    const maxReferences = jUnsignedInt(jget(jget(params, "input_references"), "max"));
    // Fill what is not already there rather than replace it: on a slug the
    // video endpoint also published, its sizes are the ones the clip has to
    // honour, and the images endpoint's silence corrects nothing.
    const entry = into.get(id) ?? emptyMediaLimits();
    if (entry.resolutions.length === 0) entry.resolutions = resolutions;
    if (entry.aspectRatios.length === 0) entry.aspectRatios = aspectRatios;
    if (entry.maxReferences === null) entry.maxReferences = maxReferences;
    into.set(id, entry);
  }
  return seen;
}

// ───────────────────────────────────────────────────────────────── fetching

/** `media_limits.rs::get_json` — one authenticated catalogue GET, parsed.
 * `null` (Rust: `None`) for a network failure, a non-2xx status (logged, the
 * one case the Rust source itself logs), or an unparseable body. */
async function getJson(key: string, path: string, fetchJson: FetchJsonLike): Promise<unknown> {
  let response: HttpJsonResponseLike;
  try {
    response = await fetchJson(`${OPENROUTER_BASE_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://arcelle.app",
        "X-OpenRouter-Title": "Arcelle",
      },
      // One deadline for the whole request, matching reqwest's
      // `.timeout(Duration::from_secs(30))`.
      signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    // eslint-disable-next-line no-console
    console.error(`media limits: ${path} answered ${response.status}`);
    return null;
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** `media_limits.rs::limits_are_stale` — a full table stands for an hour;
 * half of one for five minutes. Half used to stand for the full hour, which
 * is how a single failed fetch decided what the Create page believed about
 * the OTHER endpoint's models until a restart. */
function limitsAreStale(): boolean {
  const goodForMs = mediaTableLoaded() ? REFRESH_AFTER_MS : RETRY_HALF_AFTER_MS;
  if (fetchedAtMs === null) return true;
  return Date.now() - fetchedAtMs > goodForMs;
}

/** The actual fetch-and-merge, run inside the single-flight lock below.
 * `media_limits.rs::ensure_media_limits`'s body past the lock acquisition. */
async function fetchAndMergeLimits(key: string, deps: MediaLimitsDeps): Promise<void> {
  const found = new Map<string, MediaLimits>();
  // A catalogue counts as arrived only when it NAMED models. A 200 carrying
  // no `data` array — an outage page, a renamed field — parses to nothing,
  // and calling that "loaded" would tell the Create page that endpoint
  // serves no model at all, which empties the shelf and blames the provider
  // for it.
  let videos = false;
  let images = false;

  const videosValue = await getJson(key, "/videos/models", deps.fetchJson);
  if (videosValue !== null) {
    videos = parseVideoModels(videosValue, found) > 0;
  }
  const imagesValue = await getJson(key, "/images/models", deps.fetchJson);
  if (imagesValue !== null) {
    images = parseImageModels(imagesValue, found) > 0;
  }

  if (found.size > 0) {
    for (const [slug, limits] of found) {
      limitsCache.set(slug, limits);
    }
  }
  if (videos) videosLoaded = true;
  if (images) imagesLoaded = true;
  // Nothing arrived — let the next caller try again rather than sitting on
  // an empty table. A half table IS stamped, but only counts as fresh for
  // `RETRY_HALF_AFTER_MS` (see `limitsAreStale`).
  fetchedAtMs = videos || images ? Date.now() : null;
}

async function withLimitsFetchLock(fn: () => Promise<void>): Promise<void> {
  const previous = limitsFetchChain;
  let release: () => void = () => {};
  limitsFetchChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  // `previous` is only ever resolved (never rejected) by a `release()` in the
  // `finally` below, so awaiting it cannot strand the queue.
  await previous;
  limitsFetchBusy = true;
  try {
    await fn();
  } finally {
    limitsFetchBusy = false;
    release();
  }
}

/**
 * `media_limits.rs::ensure_media_limits` — load both limit tables if they are
 * missing or stale. Never fatal: a room with no limits table still
 * generates, the UI simply offers no seconds picker and the provider applies
 * its own defaults, which is a smaller loss than refusing to show the page.
 *
 * `key` is handed in by the caller (`providers.ts::openrouterKey()`, once a
 * future `create.ts` wires this up) rather than read here — see the module
 * doc's CREDENTIAL note.
 */
export async function ensureMediaLimits(key: string, deps: MediaLimitsDeps = defaultMediaLimitsDeps): Promise<void> {
  if (!limitsAreStale()) return;
  // Someone else is already fetching. Wait for them only when there is
  // nothing to serve meanwhile: with a table in hand this call is a
  // refresh, and making the page sit through someone else's refresh is the
  // same stall this check exists to prevent. Mirrors the Rust source's
  // `try_lock()` / `Err(_) if media_table_loaded() => return` arm.
  if (limitsFetchBusy && mediaTableLoaded()) return;
  await withLimitsFetchLock(async () => {
    // The winner of the race may have just filled it.
    if (!limitsAreStale()) return;
    await fetchAndMergeLimits(key, deps);
  });
}
