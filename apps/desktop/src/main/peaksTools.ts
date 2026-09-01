/**
 * Port of `src-tauri/src/commands/peaks.rs` (289 lines, read in full) — the
 * `audio_peaks` command that computes a waveform's downsampled envelope
 * (peaks/duration/silent) for the audio viewer, PLUS the pure math it is
 * built from: `envelope`, `is_silent`, `describe_decode_error`, `cache_key`,
 * and the `PeakCache` it reads/writes.
 *
 * PURE POST-PROCESSING over an already-stored file's bytes — no live mic, no
 * `getDisplayMedia`, no recorder engine. That is why this is its own file
 * rather than folded into `recBridge.ts`: `peaks.rs` itself has no dependency
 * on `recording.rs`'s live capture machinery, only on `db::get_file_meta`/
 * `get_file_full` (any file in the room, recorded or imported) and
 * `stt::decode_bytes_to_pcm`/`media_kind` (decode-to-PCM, a `stt.rs`
 * dependency — see below).
 *
 * NOT a model tool: confirmed by grep over `src-tauri/src` — `audio_peaks` is
 * registered ONLY in `lib.rs`'s plain `invoke_handler` list
 * (`commands::audio_peaks`), never in any tool-schema/`exec_tool` match arm.
 * Same check repeated over this migration's `toolSpecs.ts`/`toolSchema.ts`/
 * `execTool.ts` (also grepped): no reference anywhere. Nothing here touches
 * `execTool.ts`.
 *
 * `AudioPeaks` is NOT redeclared — it already exists, field-for-field, in
 * `../shared/apiTypes.ts` (and `../shared/ipc-contract.ts` already pins the
 * `audio_peaks` channel's exact args/result shape: `{ id, buckets: number |
 * null }` → `AudioPeaks`), so this file imports it rather than inventing a
 * second copy that could drift from what the (not-yet-wired) preload/viewer
 * side already expects.
 *
 * ROOM ACCESS / IPC SHAPE — mirrors `previewTools.ts`'s `quicklook_preview`
 * port almost exactly, because `peaks.rs` and `preview.rs` have the same
 * skeleton (room lookup → `db::get_file_full` → empty-bytes short-circuit →
 * an unported native/OS render-or-decode step, injectable): {@link
 * RoomSource} reuses `turnEngine.ts`'s {@link OpenRoom} rather than a third
 * "how do I reach the open room" convention (`recIpc.ts`'s own `RoomSource`
 * gives the same reasoning); {@link audioPeaks} takes the room's
 * ALREADY-UNWRAPPED `Database.Database`, resolved once by {@link
 * registerPeaksIpc} via the shared `openDb`/`"No room is open."` shape
 * `recIpc.ts`/`previewTools.ts` already use. `peaks.rs` itself re-acquires
 * `state.room.lock()` TWICE (once for `get_file_meta`'s size, once for
 * `get_file_full`'s bytes) specifically so the mutex is never held across the
 * decode step — but the two acquisitions never race each other: nothing
 * `await`s between them in the Rust source either. `audioPeaks` reproduces
 * that ordering (metadata read, cache check, THEN the bytes read) as two
 * plain synchronous calls against the one `db` handle — same reasoning
 * `previewTools.ts`'s own "ROOM-LOCK EQUIVALENCE" note gives: `better-sqlite3`
 * is synchronous and off the event loop, so there is no real mutex to
 * release, and the shape survives structurally rather than literally.
 *
 * CACHING — `Mutex<HashMap<String, AudioPeaks>>` becomes a plain {@link
 * PeakCache} (`{ map: Map<string, AudioPeaks> }`): Node has no threads
 * racing this map, so no mutex is needed, only the `Map` RULE 2 already
 * requires for a room-controlled key (`id` is a file id from the room; a
 * plain `{}` literal keyed by it is the exact `"__proto__"`-pollution shape
 * already found twice in this codebase). `createPeakCache`/`clearPeaks`
 * mirror `cancel.ts`'s own `CancelState`/`createCancelState` translation of a
 * Rust host-state struct. Rust's `.cloned()` on a cache hit — and its own
 * `computed.clone()` on a cache write, so the STORED copy and the RETURNED
 * value are independent — is reproduced by {@link clonePeaks}: without it, a
 * caller holding the returned `AudioPeaks` could mutate its `peaks` array in
 * place and corrupt every future cache hit for that id/buckets/size, a bug
 * class Rust's `Clone` makes structurally impossible.
 *
 * DECODE — THE ONE GENUINE GAP, and the reason this file does not simply
 * call `stt::decode_bytes_to_pcm` outright: that function shells out to
 * `/usr/bin/afconvert` (always) and `/usr/bin/avconvert` (for video) with
 * careful owner-only-tempfile handling of its own, and has NO Electron port
 * anywhere in this tree — confirmed by grepping the whole migration for
 * `afconvert`/`avconvert`/`decode_bytes_to_pcm`/`decodeBytesToPcm`: zero
 * hits. It is `stt.rs`'s own subsystem, not a helper this file can
 * reasonably inline (same call `previewTools.ts` makes for `quicklook.rs`'s
 * PyObjC render, and `jobDownload.ts` for `web::download_to_temp`'s HTTP
 * engine). {@link decodeAudioBytes} is the injectable seam this gap gets:
 *   - WAV bytes decode FOR REAL, via `recFormat.ts`'s already-ported,
 *     already-tested `decodeWav` — this room's own ADD-27 recordings
 *     (`recBridge.ts` always stores them as 16 kHz mono WAV) and any plain
 *     imported `.wav` file both work today, with no stub in the way.
 *   - Everything else (`.mp3`/`.m4a`/`.aac`/`.flac`/`.aiff`/`.caf`/`.ogg`/
 *     `.opus`/`.mp4`/`.mov`/`.m4v` — needs a REAL transcode, not a parse)
 *     rejects with the labelled {@link DECODE_NON_WAV_NOT_IMPLEMENTED} —
 *     an honest refusal, never a fabricated waveform.
 * Routing between the two is done by `decodeWav`'s OWN magic-byte check
 * (`"RIFF"`/`"WAVE"`), not by `ext`/`kind`: a `.wav`-named file that isn't
 * really one still gets a real parse error, and any container that happens
 * to BE a WAV under a different name/mime still decodes for real, matching
 * how little the actual bytes care what they were called.
 *
 * `mediaKind` (`stt::media_kind`) is ported HERE, for real, and this file is
 * where the app's one copy of it lives: `retrievalBackfill.ts` imports it
 * from here rather than carrying a second spelling or a stub, because
 * `spawn_reextract_backfill`'s skip branch is the difference between leaving
 * a recording to the transcription worker and feeding it to the document
 * extractor. Here it is likewise not incidental: `mediaKind` gates
 * whether {@link audioPeaks} even attempts {@link decodeAudioBytes}, which
 * has a REAL, working path (WAV). Stubbing it to always answer `null` would
 * break waveform generation for every recording in the room, today, for no
 * reason — so this file carries its own small, verbatim, pure port instead
 * (15 lines in the Rust source, trivially checked side by side). A future
 * `stt.ts` that ports the rest of `stt.rs` for real should absorb this copy
 * (and retire the other two stubs) rather than the reverse.
 *
 * RUST-FIDELITY DEVIATION, spelled out because it is easy to miss:
 * `decode_bytes_to_pcm` ALWAYS resamples through `afconvert` first, so
 * `parse_wav_to_mono_f32`/`recording::decode_wav` (this port's `decodeWav`)
 * never actually sees a non-16 kHz WAV in production — both the Rust and the
 * TS `decode_wav` DISCARD the header's own sample-rate field and assume
 * 16 kHz unconditionally. This port's WAV fast path skips that resample
 * step, so blindly copying that assumption would silently under/over-report
 * `duration` for a plain imported WAV recorded at, say, 44.1 kHz (this
 * room's OWN recordings are unaffected either way — `encodeWav` hard-codes
 * 16 kHz). {@link wavSampleRate} reads the header's REAL declared rate
 * (falling back to `recFormat.ts`'s `SAMPLE_RATE` only when the header can't
 * be read) so `duration` is computed from the rate the bytes actually
 * carry — strictly more correct than the assumption it deviates from, not
 * less. `envelope`'s own bucket math is rate-agnostic (it only ever counts
 * samples), so this affects `duration` alone, never the shape of `peaks`.
 *
 * ALSO NOT TRANSLATED: Rust's outer `.map_err(|e| format!("The waveform
 * could not be computed: {e}"))` wraps only a `spawn_blocking` JOIN failure
 * (the blocking task PANICKED) — a layer with no JS analogue (an exception
 * thrown inside an `async` function is just a rejected promise; there is no
 * separate "thread panicked" case to distinguish). `describeDecodeError` is
 * applied directly to whatever {@link decodeAudioBytes} throws, matching
 * `previewTools.ts`'s own choice to leave its render step's rejection
 * unwrapped end to end for the same reason ("wrapping it would bury the
 * exact NOT_IMPLEMENTED marker a caller or test matches on").
 *
 * `clampBuckets` is an HONEST ADDITION, not in the Rust source: Tauri's own
 * deserialization refuses a negative/non-integer `buckets` before
 * `audio_peaks` ever runs (`Option<usize>` cannot hold one), so Rust's
 * `.unwrap_or(DEFAULT_BUCKETS).clamp(64, MAX_BUCKETS)` only ever sees `None`
 * or a valid `usize`. Electron's IPC bridge enforces no such boundary, so
 * this normalizes anything non-finite (missing, `NaN`, a string that slipped
 * through untyped JS) to {@link DEFAULT_BUCKETS} before the same clamp runs —
 * closing a gap Rust's type system closes for free, not opening a new one.
 *
 * NO IPC WIRING in this batch, same as `dictStopTimeout.ts`/`recIpc.ts`/
 * `previewTools.ts`: Phase 2 (renderer/preload) needs an explicit owner
 * go-ahead before touching the live shipping app. {@link registerPeaksIpc}
 * exists, ready to be wired, but nothing in this migration's bootstrap calls
 * it yet — and neither does `clear_peaks`'s own caller (`rooms.rs`'s
 * room-close path has no Electron port yet either); {@link clearPeaks} is
 * exported for whichever future room-lifecycle batch needs it.
 */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";
import type { AudioPeaks } from "../shared/apiTypes.js";
import type { OpenRoom } from "./turnEngine.js";
import { readRoomFile } from "./workspace/roomContent.js";
import { getFileFull, getFileMeta } from "./db-host/files.js";
import { extensionOf } from "./editMatchExtraction.js";
import {
  decodeAudioBytes,
  type DecodeToPcmFn,
} from "./peaksDecode.js";

export {
  DECODE_NON_WAV_NOT_IMPLEMENTED,
  decodeAudioBytes,
  decodeAudioBytesWith,
  transcodeWithMacOs,
  transcodeWithMacOsUsing,
  type DecodedPcm,
  type DecodeToPcmFn,
  type MacOsTranscodeDeps,
  type TranscodeToWav,
} from "./peaksDecode.js";

export type { AudioPeaks };

// ------------------------------------------------------------------ constants

/** How many buckets to compute when the caller doesn't say. ~2000 is more
 * than a pane is ever wide in CSS pixels, so the drawing is never
 * under-sampled, and it is small enough to cross IPC without thought. */
export const DEFAULT_BUCKETS = 2000;
export const MAX_BUCKETS = 8000;

/** The amplitude at or under which an envelope is silence rather than
 * signal. {@link envelope} refuses to normalize below it (dither must not be
 * amplified into a fake waveform), so a file that never crosses it draws as
 * a flat lane — and that flat lane is what the viewer has to explain. */
export const NOISE_FLOOR = 0.01;

/** Keep at most this many envelopes. Each is a few tens of KB, so this is
 * about tidiness rather than memory pressure. */
export const MAX_CACHED = 24;

// ------------------------------------------------------------------ envelope

/**
 * Reduce mono samples to `buckets` maxima. Uses the maximum ABSOLUTE value in
 * each bucket, not the mean: a mean envelope of speech is nearly flat, which
 * is exactly the "featureless grey sausage" a waveform is supposed not to
 * be. Ported verbatim from `peaks.rs`'s `envelope`.
 *
 * `buckets <= 0` (Rust: `buckets == 0`) returns empty — widened from `== 0`
 * because `usize` cannot go negative in Rust but a plain `number` can here;
 * treating a negative bucket count as "nothing to compute" rather than
 * constructing a negative-length array is a defensive generalization of the
 * same rule, not a behavior change for any value Rust could ever pass.
 */
export function envelope(samples: ArrayLike<number>, buckets: number): number[] {
  const len = samples.length;
  if (len === 0 || buckets <= 0) {
    return [];
  }
  const out: number[] = new Array(buckets);
  // Integer-free bucket walk so the last bucket can't run past the slice on
  // a length that doesn't divide evenly. `len * buckets` stays well within
  // Number.MAX_SAFE_INTEGER even for a three-hour recording (≈1.7e8 samples)
  // times MAX_BUCKETS (8000) ≈ 1.4e12 — no BigInt needed, unlike Rust's u64
  // widening (which exists only because `usize` is 32-bit on some targets).
  for (let b = 0; b < buckets; b++) {
    out[b] = bucketPeak(samples, len, buckets, b);
  }
  return normalizeEnvelope(out);
}

function bucketPeak(samples: ArrayLike<number>, len: number, buckets: number, bucket: number): number {
  const start = Math.floor((bucket * len) / buckets);
  const end = Math.min(Math.max(Math.floor(((bucket + 1) * len) / buckets), start + 1), len);
  let peak = 0;
  for (let i = start; i < end; i++) {
    peak = Math.max(peak, Math.abs(samples[i] ?? 0));
  }
  return Math.min(peak, 1);
}

function normalizeEnvelope(out: number[]): number[] {
  // Normalize to the loudest moment so a quietly-recorded meeting still
  // fills the lane. A silent file stays silent rather than being amplified
  // into noise.
  const loudest = Math.max(0, ...out);
  if (loudest <= NOISE_FLOOR) {
    return out;
  }
  for (let i = 0; i < out.length; i++) {
    out[i] = (out[i] as number) / loudest;
  }
  return out;
}

/** Did anything in this envelope get above the floor? A normalized envelope
 * peaks at exactly 1.0, so this is only ever true for the un-normalized
 * case: a track with no audible content in it. Ported verbatim from
 * `peaks.rs`'s `is_silent`. */
export function isSilent(peaks: readonly number[]): boolean {
  if (peaks.length === 0) {
    return false;
  }
  let loudest = 0;
  for (const v of peaks) {
    if (v > loudest) {
      loudest = v;
    }
  }
  return loudest <= NOISE_FLOOR;
}

/**
 * What to show when the decoder refuses a file.
 *
 * `avconvert` fails on a video whose audio track is missing AND on one whose
 * audio the Mac has no decoder for, and it does not say which — so the
 * sentence stops at "none this Mac can read" rather than asserting the
 * track isn't there. Every other failure keeps its own words; a generic
 * rewrite would throw away the only clue there is. Ported verbatim from
 * `peaks.rs`'s `describe_decode_error`.
 *
 * This specific "no readable audio track" prefix is only ever produced by
 * `avconvert` (unported — see this module's doc), so it is currently dead in
 * practice; kept verbatim so a future real `decodeAudioBytes` needs no
 * change here to light it back up.
 */
export function describeDecodeError(err: string): string {
  if (err.startsWith("no readable audio track")) {
    return "This video has no audio track this Mac can read.";
  }
  return err;
}

/**
 * The cache key, and the reason this cache can no longer serve an envelope
 * of audio that has since been replaced.
 *
 * Keyed on the file id alone, and emptied only when the room closed, the
 * waveform after "Continue recording" was the PRE-continuation one: the
 * axis stopped at the old length, and every speaker lane, highlight band,
 * chapter rule and click-to-seek is positioned as a fraction of the
 * `duration` that came with it — so all of them pointed at the wrong
 * moments. `size` closes that: every path that rewrites a file's bytes goes
 * through `updateFileContent` (`db-host/files.ts`), which writes the new
 * `sizeBytes` in the same statement, so a rewritten file simply misses.
 *
 * What it does NOT see: a rewrite to a byte length identical to the old one
 * (restoring a version of exactly the same size). The envelope would be
 * stale there too — but the timeline it is drawn against has not moved,
 * which is the failure this key exists to prevent. Ported verbatim from
 * `peaks.rs`'s `cache_key`.
 */
export function cacheKey(id: string, buckets: number, size: number): string {
  return `${id}:${buckets}:${size}`;
}

// -------------------------------------------------------------- bucket count

/**
 * `buckets.unwrap_or(DEFAULT_BUCKETS).clamp(64, MAX_BUCKETS)` — see this
 * module's doc for why the extra non-finite guard is an honest addition
 * rather than a Rust behavior change.
 */
export function clampBuckets(requested: number | null | undefined): number {
  if (requested === null || requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_BUCKETS;
  }
  return Math.min(Math.max(Math.trunc(requested), 64), MAX_BUCKETS);
}

// ---------------------------------------------------------------- PeakCache

/**
 * Decoded envelopes, keyed by file id, bucket count AND the stored byte
 * length the envelope was computed from ({@link cacheKey}). Decoding shells
 * out to the OS converters and takes real seconds on a long recording, so
 * the answer is kept for as long as the room is open — reopening a meeting
 * must not pay for it twice. Cleared with the room, like every other
 * decrypted derivative (see {@link clearPeaks}).
 *
 * `Mutex<HashMap<...>>` → a plain `Map`: see this module's doc for why no
 * mutex is needed, and why `Map` rather than a `{}` literal (RULE 2 — `id`
 * is room-controlled).
 */
export interface PeakCache {
  map: Map<string, AudioPeaks>;
}

/** A fresh, empty cache — the TS equivalent of `PeakCache::default()`. */
export function createPeakCache(): PeakCache {
  return { map: new Map() };
}

/** `clear_peaks` — drop every cached envelope. Called when the room the
 * envelopes were decoded from closes; not wired to anything in this batch
 * (see this module's doc). */
export function clearPeaks(cache: PeakCache): void {
  cache.map.clear();
}

/** Rust's `.cloned()` on a cache hit / `computed.clone()` on a cache write —
 * see this module's doc for why an aliased `peaks` array would be a real
 * bug here that it never was in Rust. */
function clonePeaks(p: AudioPeaks): AudioPeaks {
  return { peaks: [...p.peaks], duration: p.duration, silent: p.silent };
}

// ------------------------------------------------------------------ mediaKind

/** `stt::MediaKind` — audio/video, only ever used to decide whether a file
 * is a waveform candidate at all before decoding is attempted. */
export type MediaKind = "audio" | "video";

/** Ported verbatim from `stt::media_kind`'s extension arm. See this module's
 * doc for why this one small function is a real port here — and note that
 * `retrievalBackfill.ts` imports {@link mediaKind} from this file, so these
 * two tables are the app's only copy of them. */
const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  "m4a",
  "mp3",
  "wav",
  "aac",
  "flac",
  "aiff",
  "aif",
  "caf",
  "ogg",
  "opus",
]);
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(["mp4", "mov", "m4v"]);

/** Files worth transcribing when text extraction came back empty: audio and
 * video containers. Matched by mime first, extension as fallback (uploads
 * sometimes arrive as application/octet-stream). Ported verbatim from
 * `stt::media_kind`. */
export function mediaKind(mime: string, ext: string): MediaKind | null {
  if (mime.startsWith("audio/")) {
    return "audio";
  }
  if (mime.startsWith("video/")) {
    return "video";
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return "audio";
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }
  return null;
}

// -------------------------------------------------------------- room access

/** The slice of the (not-yet-ported) `AppState` this command needs:
 * whichever room is open RIGHT NOW. Reuses `turnEngine.ts`'s {@link
 * OpenRoom} rather than inventing a second "how do I reach the open room"
 * convention — same reasoning `recIpc.ts`'s / `previewTools.ts`'s own
 * `RoomSource` gives. */
export interface RoomSource {
  currentRoom(): OpenRoom | null;
}

/** `AppState::with_room`'s own refusal, spelled the way `recIpc.ts` and
 * `previewTools.ts` already spell it. */
const NO_ROOM_OPEN = "No room is open.";

export function openDb(room: RoomSource): Database.Database {
  const open = room.currentRoom();
  if (open === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return open.db;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ------------------------------------------------------------- audio_peaks

interface PeakWork {
  buckets: number;
  key: string;
  hit: AudioPeaks | undefined;
}

interface PeakFile {
  name: string;
  mime: string;
  bytes: Buffer;
}

function peakWork(
  db: Database.Database,
  cache: PeakCache,
  id: string,
  bucketsArg: number | null | undefined,
): PeakWork {
  const buckets = clampBuckets(bucketsArg);
  const size = getFileMeta(db, id).sizeBytes;
  const key = cacheKey(id, buckets, size);
  return { buckets, key, hit: cache.map.get(key) };
}

function legacyPeakFile(db: Database.Database, id: string): PeakFile {
  const [name, mimeRaw, bytesRaw] = getFileFull(db, id);
  return { name, mime: mimeRaw ?? "", bytes: bytesRaw ?? Buffer.alloc(0) };
}

async function roomPeakFile(room: OpenRoom, id: string): Promise<PeakFile> {
  const file = await readRoomFile({ db: room.db, path: room.path }, id);
  return {
    name: file.name,
    mime: file.mimeType ?? "",
    bytes: file.bytes ?? Buffer.alloc(0),
  };
}

function peakDecodeInput(file: PeakFile): { bytes: Buffer; ext: string; kind: MediaKind } {
  if (file.bytes.length === 0) {
    throw new Error("This file has no audio to draw.");
  }
  const ext = extensionOf(file.name);
  const kind = mediaKind(file.mime, ext);
  if (kind === null) {
    throw new Error("This file is not audio or video.");
  }
  return { bytes: file.bytes, ext, kind };
}

function computedPeaks(samples: ArrayLike<number>, sampleRate: number, buckets: number): AudioPeaks {
  const duration = sampleRate > 0 ? samples.length / sampleRate : 0;
  const peaks = envelope(samples, buckets);
  return { peaks, duration, silent: isSilent(peaks) };
}

async function decodePeaks(
  file: PeakFile,
  buckets: number,
  decode: DecodeToPcmFn,
): Promise<AudioPeaks> {
  const { bytes, ext, kind } = peakDecodeInput(file);
  try {
    const { samples, sampleRate } = await decode(bytes, ext, kind);
    return computedPeaks(samples, sampleRate, buckets);
  } catch (error) {
    throw new Error(describeDecodeError(errMessage(error)));
  }
}

function cacheComputedPeaks(cache: PeakCache, key: string, computed: AudioPeaks): AudioPeaks {
  if (cache.map.size >= MAX_CACHED) {
    cache.map.clear();
  }
  cache.map.set(key, clonePeaks(computed));
  return computed;
}

async function computeAndCachePeaks(
  cache: PeakCache,
  work: PeakWork,
  file: PeakFile,
  decode: DecodeToPcmFn,
): Promise<AudioPeaks> {
  return cacheComputedPeaks(cache, work.key, await decodePeaks(file, work.buckets, decode));
}

/**
 * Port of `commands::audio_peaks`. Takes the room's ALREADY-UNWRAPPED
 * `Database.Database` — `registerPeaksIpc` resolves it once per call,
 * matching `previewTools.ts`'s/`recIpc.ts`'s convention.
 *
 * Throws (matching the Rust `?` on `db::get_file_meta`/`get_file_full`) when
 * `id` names no file in this room, when the file has no bytes at all, when
 * its mime/extension names neither audio nor video, or when {@link
 * DecodeToPcmFn} itself fails (routed through {@link describeDecodeError}).
 */
export async function audioPeaks(
  db: Database.Database,
  cache: PeakCache,
  id: string,
  bucketsArg: number | null | undefined,
  decode: DecodeToPcmFn = decodeAudioBytes
): Promise<AudioPeaks> {
  // The stored length FIRST, and without the bytes: it is what tells a
  // cached envelope apart from one of audio that has since been rewritten
  // (see `cacheKey`'s own doc), and it means a cache HIT never has to read —
  // let alone decrypt — the file's (possibly huge) blob at all.
  const work = peakWork(db, cache, id, bucketsArg);
  if (work.hit !== undefined) return clonePeaks(work.hit);
  return computeAndCachePeaks(cache, work, legacyPeakFile(db, id), decode);
}

/** Hybrid-room entry point: metadata stays in SQLCipher, while workspace
 * audio bytes are streamed from the normal file instead of the nullable
 * legacy blob column. */
export async function audioPeaksForRoom(
  room: OpenRoom,
  cache: PeakCache,
  id: string,
  bucketsArg: number | null | undefined,
  decode: DecodeToPcmFn = decodeAudioBytes,
): Promise<AudioPeaks> {
  const work = peakWork(room.db, cache, id, bucketsArg);
  if (work.hit !== undefined) return clonePeaks(work.hit);
  return computeAndCachePeaks(cache, work, await roomPeakFile(room, id), decode);
}

/**
 * Registers {@link audioPeaks} on the `audio_peaks` channel — the Rust
 * `#[tauri::command]` name (and `../shared/ipc-contract.ts`'s already-pinned
 * channel) `src/api.ts`'s `invoke("audio_peaks", …)` already uses, so the
 * renderer side needs no rename. `ipcMain` is accepted as a parameter, typed
 * against the real `electron` module without importing it at runtime, so
 * this file resolves and tests under plain Node/vitest exactly like
 * `registerRecIpc`/`registerPreviewIpc` do.
 *
 * Exported and directly testable, but — same as `dictStopTimeout.ts`,
 * `recIpc.ts` and `previewTools.ts` — NOT called from any live main-process
 * entrypoint by this batch. Wiring it in is Phase 2 work pending an explicit
 * owner go-ahead.
 */
export function registerPeaksIpc(
  ipcMain: Pick<IpcMain, "handle">,
  room: RoomSource,
  cache: PeakCache,
  decode?: DecodeToPcmFn
): void {
  ipcMain.handle(
    "audio_peaks",
    (_event: IpcMainInvokeEvent, args: { id: string; buckets: number | null }) => {
      const open = room.currentRoom();
      if (open === null) throw new Error(NO_ROOM_OPEN);
      return audioPeaksForRoom(open, cache, args.id, args.buckets, decode);
    }
  );
}
