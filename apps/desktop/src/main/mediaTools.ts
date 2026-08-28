/**
 * Port of `src-tauri/src/commands/media.rs` (311 lines, read in full) — the
 * in-memory decrypted-media staging map behind the `roommedia://` streaming
 * protocol, plus the pure MIME/Range helpers it and the protocol handler are
 * built from: `MediaStreams`/`stage_media_bytes`/`clear_media`,
 * `playable_media_mime`, `parse_range`, and `media_response`.
 *
 * WHY THIS EXISTS. A recording or video lives encrypted in SQLite; the
 * viewer's `<video>`/`<audio>` element needs a seekable URL, not a giant
 * base64 IPC payload (WKWebView refuses to seek — and above a size, to play
 * at all — without HTTP 206 Range responses; the same is true of Chromium's
 * media element). `stageMediaBytes` puts decrypted bytes behind a one-shot
 * token in an in-process map; `mediaResponse` is the pure request→response
 * function a `roommedia://` (or Electron `protocol.handle`) handler adapts in
 * two lines, exactly as Rust's own comment describes it ("so the protocol
 * handler in lib.rs stays a two-line adapter and this logic is
 * unit-testable"). Privacy bargain, same as the Rust: bytes live only in this
 * map, never on disk, capped by count AND by total bytes (a stale entry is
 * evicted oldest-first), and dropped in full when the room closes/locks.
 *
 * NOT A `#[tauri::command]` FILE. Every Rust item here is a plain
 * function/struct — `media.rs` has no `#[tauri::command]` of its own, so
 * there is no IPC channel to register and no `exec_tool` arm to wire.
 * Confirmed by grep over `src-tauri/src` for this module's names: they are
 * called from THREE other command modules, none of which this port touches:
 *   - `commands/files.rs`'s `get_file_content` stages a file's decrypted bytes
 *     for playback. Not yet ported to Electron (no `fileTools.ts` arm calls
 *     this file yet); a future port of that command is the one to wire it in.
 *   - `commands/agent.rs`'s `view_media_frame` (the `view_media_frame` model
 *     tool) stages a clip's bytes so the driver can grab a frame from it.
 *     This tool's `execTool.ts` arm is ALREADY ported and deliberately still
 *     `notImplemented(...)` — for a reason unrelated to this file: it needs
 *     the `AgentUi` screen-driving round-trip (`request_ui`), which has no
 *     Electron port at all yet. Nothing in `execTool.ts` changes here (rule
 *     6) — the arm was already an honest refusal and stays one.
 *   - `commands/rooms.rs`'s room-teardown path calls `clear_media` alongside
 *     `clear_peaks`/`clear_slides`/etc. `roomManager.ts` ALREADY anticipates
 *     this exact gap: its `RoomManagerHooks.clearEphemeralCaches` doc names
 *     `MediaStreams` by name as one of "the SIX Rust pieces with no Electron
 *     home yet". {@link clearMedia} is exported, ready for whichever future
 *     batch supplies that hook — this file does not call into
 *     `roomManager.ts` itself (that traffic runs the other way).
 *   - `lib.rs` registers the `roommedia://` custom protocol and calls
 *     {@link mediaResponse}-equivalent logic as its handler. Registering an
 *     Electron `protocol.handle("roommedia", …)` is bootstrap wiring (rule 4)
 *     for a future batch; {@link mediaResponse} is already the pure function
 *     that handler would adapt, needing no change itself.
 *
 * `MAX_STAGED`/`MAX_STAGED_BYTES` — `MediaStreams` becomes a plain
 * {@link MediaStreams} interface holding a `Map` (never a `{}` literal keyed
 * by a token — RULE 2: a `mediaResponse` token comes off an incoming request
 * path, i.e. caller-supplied input, the same shape of risk `mcpConfig.ts`/
 * `privacyRedact.ts`/this session's `jsonTools.ts`/`feedbackTools.ts` already
 * hit with a `"__proto__"`-named entry). Node has no threads racing this map,
 * so the Rust `Mutex`/`AtomicU64` collapse to a plain field — same
 * translation `peaksTools.ts`'s `PeakCache` and `cancel.ts`'s `CancelState`
 * already use for their own Rust host-state structs. `createMediaStreams()`
 * is the `MediaStreams::default()` equivalent.
 *
 * TOKEN FORMAT matches Rust's `format!("{seq}-{}", Uuid::new_v4())` exactly —
 * `${seq}-${randomUUID()}` — using `node:crypto`'s `randomUUID`, this
 * codebase's existing UUID convention (`editMatch.ts`, `externalAdvisor.ts`,
 * `artifactBuilder.test.ts`/`editMatch.test.ts`'s own fixture rooms).
 * `next.fetch_add(1, Ordering::Relaxed)` returns the PRE-increment value and
 * leaves `next` one higher; `streams.next++` (postfix) is the same operation.
 *
 * `playableMediaMime` RETURNS THE LOWERCASED MIME, not the caller's original
 * casing — this is a real, easy-to-miss detail of the Rust source: `let m =
 * mime.to_ascii_lowercase();` shadows the parameter, and the passthrough
 * branch (`return m;`) returns THAT lowercased binding, not the original
 * `mime` string. A port that returned the original-cased `mime` here would
 * diverge from Rust on any mixed-case input (`"Video/MP4"` → Rust answers
 * `"video/mp4"`).
 *
 * `parseRange` mirrors the Rust grammar's exact quirks, verified against
 * `media.rs`'s own `range_parsing_covers_the_grammar` test case-by-case (all
 * ten reproduced below): `strip_prefix`/`split_once('-')` split on the FIRST
 * `-` only (so `"10-20-30"` parses `end_s` as `"20-30"`, a bad number, not a
 * range spanning the second dash) — reproduced with `indexOf("-")` rather
 * than `.split("-")`, which would over-split. The suffix form (`"bytes=-N"`)
 * falls out of that same first-dash split: `-500` splits to `("", "500")`
 * because the leading `-` IS the first dash, not a special case in the Rust
 * source and not one here either. The NUMBER grammar is `u64::from_str`'s and
 * nothing looser — see {@link parseU64}: a leading `+` IS accepted (Rust's
 * `from_str_radix` strips it for unsigned types), and a value past `u64::MAX`
 * is a parse ERROR, so an oversized Range header answers 416 here exactly as
 * the shipped app does rather than a 206 claiming the whole body.
 *
 * `mediaResponse`'s `path.trim_start_matches('/')` strips EVERY leading `/`,
 * not just one (`"//tok"` → `"tok"`); `path.replace(/^\/+/, "")` matches that,
 * where a single `.slice(1)` would not. Every failure response (404, 416)
 * carries the CORS header exactly as Rust's does — the frame-grab caller
 * (`view_media_frame`, once it lands) requests this scheme
 * `crossorigin="anonymous"`, and a plain top-level error would otherwise
 * arrive at that caller as an opaque cross-origin failure instead of its own
 * message. The 200/206 bodies are independent copies of the staged buffer
 * (`Buffer.from(...)`), matching Rust's own `.clone()`/`.to_vec()` on both
 * paths — a caller must not be able to mutate the cached bytes through the
 * handed-back response.
 */

import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

// -------------------------------------------------------------- MediaStreams

/** One staged decrypted media blob. `seq` is insertion order, used for
 * oldest-first eviction — never for anything about the token's uniqueness
 * (the token itself already is unique). */
export interface StagedMedia {
  bytes: Buffer;
  mime: string;
  seq: number;
  /** Workspace files stay on disk and are opened only when the protocol asks
   * for bytes. Blob rooms leave this undefined and keep using `bytes`. */
  openStream?: () => Promise<Readable>;
  /** Optional seekable factory. Workspace files use this so a late video
   * range does not read and discard every byte before the requested span. */
  openRange?: (start: number, end: number) => Promise<Readable>;
  sizeBytes?: number;
}

/** Keep at most this many staged media entries alive. Opening a new file
 * evicts the oldest. Ported verbatim from `media.rs`'s `MAX_STAGED`. */
export const MAX_STAGED = 4;

/** …and at most this many BYTES across all of them. Counting entries alone is
 * no limit at all: four large videos are four large videos. The newest entry
 * is always kept, however big — it is the one about to play. Ported verbatim
 * from `media.rs`'s `MAX_STAGED_BYTES`. */
export const MAX_STAGED_BYTES = 1_500_000_000;

/** `Mutex<HashMap<String, StagedMedia>>` + `AtomicU64` → a plain `Map` plus a
 * plain counter (see this module's doc for why no mutex/atomic is needed). */
export interface MediaStreams {
  map: Map<string, StagedMedia>;
  next: number;
}

/** A fresh, empty streams table — the TS equivalent of `MediaStreams::default()`. */
export function createMediaStreams(): MediaStreams {
  return { map: new Map(), next: 0 };
}

/**
 * Stage decrypted media bytes; returns the token the viewer plays via
 * `roommedia://localhost/<token>`. Ported verbatim from `media.rs`'s
 * `stage_media_bytes`, including its eviction loop: keeps evicting the
 * OLDEST entry (by `seq`) while the table is at/over `MAX_STAGED` entries OR
 * the new entry would push the total over `MAX_STAGED_BYTES`, stopping early
 * if nothing is left to evict — so the newest entry always lands, however big.
 */
export function stageMediaBytes(streams: MediaStreams, bytes: Buffer, mime: string): string {
  const seq = streams.next++;
  const token = `${seq}-${randomUUID()}`;
  const staged = bytes.length;
  for (;;) {
    let held = 0;
    for (const m of streams.map.values()) {
      held += m.bytes.length;
    }
    if (streams.map.size < MAX_STAGED && held + staged <= MAX_STAGED_BYTES) {
      break;
    }
    let oldestKey: string | undefined;
    let oldestSeq = Number.POSITIVE_INFINITY;
    for (const [key, m] of streams.map) {
      if (m.seq < oldestSeq) {
        oldestSeq = m.seq;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) {
      break; // nothing left to evict: the newest entry stands
    }
    streams.map.delete(oldestKey);
  }
  streams.map.set(token, { bytes, mime, seq });
  return token;
}

/** Stage a trusted stream factory without copying a normal workspace file
 * into the main-process heap. The factory returns a fresh stream for every
 * media request because Chromium may make several independent range reads. */
export function stageMediaStream(
  streams: MediaStreams,
  sizeBytes: number,
  mime: string,
  openStream: () => Promise<Readable>,
  openRange?: (start: number, end: number) => Promise<Readable>,
): string {
  const seq = streams.next++;
  const token = `${seq}-${randomUUID()}`;
  while (streams.map.size >= MAX_STAGED) {
    let oldestKey: string | undefined;
    let oldestSeq = Number.POSITIVE_INFINITY;
    for (const [key, staged] of streams.map) {
      if (staged.seq < oldestSeq) {
        oldestSeq = staged.seq;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    streams.map.delete(oldestKey);
  }
  streams.map.set(token, {
    bytes: Buffer.alloc(0),
    mime,
    seq,
    openStream,
    openRange,
    sizeBytes,
  });
  return token;
}

/** Drop every staged entry — called when the room closes/locks so no
 * decrypted media outlives the session. Ported verbatim from `media.rs`'s
 * `clear_media`. Not called from anywhere in this batch — see this module's
 * doc's `roomManager.ts` note. */
export function clearMedia(streams: MediaStreams): void {
  streams.map.clear();
}

// --------------------------------------------------------------- playable mime

/** m4a-flavored labels `<audio>`/`<video>` refuse to play (AAC-in-MP4 is
 * `audio/mp4`, not any of these). Ported verbatim from `media.rs`'s
 * `playable_media_mime`. */
const M4A_LIKE_MIMES: ReadonlySet<string> = new Set([
  "audio/m4a",
  "audio/x-m4a",
  "audio/mp4a-latm",
  "audio/aac",
]);

/**
 * The Content-Type the media element will actually play for this file.
 * RETURNS THE LOWERCASED MIME on the passthrough branch — see this module's
 * doc. Ported verbatim from `media.rs`'s `playable_media_mime`.
 */
export function playableMediaMime(mime: string, ext: string, video: boolean): string {
  const m = mime.toLowerCase();
  if (M4A_LIKE_MIMES.has(m)) {
    return "audio/mp4";
  }
  if (m !== "" && m !== "application/octet-stream") {
    return m;
  }
  switch (ext) {
    case "mov":
      return "video/quicktime";
    case "webm":
      return video ? "video/webm" : "audio/webm";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "flac":
      return "audio/flac";
    case "ogg":
    case "opus":
      return "audio/ogg";
    default:
      return video ? "video/mp4" : "audio/mp4";
  }
}

// -------------------------------------------------------------------- range

/** The exact text `u64::from_str` accepts: an OPTIONAL leading `+` (Rust's
 * `from_str_radix` strips `+` for unsigned types; only `-` is rejected) then
 * ASCII digits. No whitespace, no decimal point, no exponent. */
const U64_TEXT = /^\+?\d+$/;

/** `u64::MAX` — a digit string above this is a Rust parse ERROR, not a
 * saturating clamp. */
const U64_MAX = 18_446_744_073_709_551_615n;

/**
 * `u64::from_str`, exactly: `null` for anything Rust's parser rejects,
 * including a value that overflows 64 bits.
 *
 * BOTH halves matter here and a plain `Number()` gets both wrong. Without the
 * `+` arm, `"bytes=+0-9"` — which Rust parses as `Some((0, 9))` — answered a
 * 416. Without the overflow arm, `"bytes=0-99999999999999999999999"` — which
 * Rust REFUSES, so the caller answers 416 — coerced to `1e23`, got clamped by
 * `.min(len - 1)`, and served a 206 whose `Content-Range` claimed the whole
 * body for a Range header the shipped app calls unsatisfiable.
 *
 * The returned `number` loses precision above 2^53, which is harmless here
 * and only here: every such value is astronomically larger than any staged
 * `len`, so it always takes the same `>= len` / `.min(len - 1)` branch it
 * would have taken exactly.
 */
function parseU64(s: string): number | null {
  if (!U64_TEXT.test(s)) {
    return null;
  }
  const digits = s.startsWith("+") ? s.slice(1) : s;
  if (BigInt(digits) > U64_MAX) {
    return null;
  }
  return Number(digits);
}

/**
 * Parse an HTTP `Range` header against a body of `len` bytes. Returns the
 * inclusive byte span to serve, or `null` when the header is malformed or
 * unsatisfiable (caller answers 416). Only single ranges are supported —
 * no caller here ever requests a multipart range. Ported verbatim from
 * `media.rs`'s `parse_range`; see this module's doc for the two grammar
 * quirks (first-dash split, suffix form) worth calling out explicitly.
 */
export function parseRange(header: string, len: number): [number, number] | null {
  if (len === 0) {
    return null;
  }
  const trimmed = header.trim();
  if (!trimmed.startsWith("bytes=")) {
    return null;
  }
  const spec = trimmed.slice("bytes=".length);
  const dash = spec.indexOf("-");
  if (dash === -1) {
    return null;
  }
  const startS = spec.slice(0, dash).trim();
  const endS = spec.slice(dash + 1).trim();

  if (startS === "") {
    // Suffix form: "bytes=-N" — the final N bytes.
    const n = parseU64(endS);
    if (n === null || !(n > 0)) {
      return null;
    }
    const clamped = Math.min(n, len);
    return [len - clamped, len - 1];
  }

  const start = parseU64(startS);
  if (start === null || start >= len) {
    return null;
  }
  let end: number;
  if (endS === "") {
    end = len - 1;
  } else {
    const parsedEnd = parseU64(endS);
    if (parsedEnd === null) {
      return null;
    }
    end = Math.min(parsedEnd, len - 1);
  }
  if (end < start) {
    return null;
  }
  return [start, end];
}

// ---------------------------------------------------------------- response

/** One header, in emission order — mirrors Rust's `Vec<(String, String)>`
 * (an ORDERED list, not a map: the same header name never repeats here, but
 * nothing enforces that structurally, exactly as in the Rust source). */
export type MediaHeader = [string, string];

export interface MediaHttpResponse {
  status: number;
  headers: MediaHeader[];
  body: Buffer;
}

export interface StreamingMediaHttpResponse {
  status: number;
  headers: MediaHeader[];
  body: Buffer | ReadableStream<Uint8Array>;
}

const ALLOW_ORIGIN: MediaHeader = ["Access-Control-Allow-Origin", "*"];

/**
 * The `roommedia://` response for a request path + optional Range header, as
 * `{ status, headers, body }`. Pure, so a future protocol handler stays a
 * two-line adapter and this logic is unit-testable — ported verbatim from
 * `media.rs`'s `media_response`.
 *
 * The CORS header belongs on the FAILURE answers too (404/416): a staged
 * entry can be evicted out from under a `crossorigin="anonymous"` frame-grab
 * request (`MAX_STAGED` is 4), and without the header a plain "that clip is
 * no longer staged" arrives at the page as an opaque CORS failure instead.
 */
export function mediaResponse(
  streams: MediaStreams,
  path: string,
  range: string | null | undefined
): MediaHttpResponse {
  const token = path.replace(/^\/+/, "");
  const staged = streams.map.get(token);
  if (staged === undefined) {
    return {
      status: 404,
      headers: [["Content-Type", "text/plain"], ALLOW_ORIGIN],
      body: Buffer.from("media not staged"),
    };
  }
  const { bytes, mime } = staged;
  const len = bytes.length;
  const base: MediaHeader[] = [
    ["Content-Type", mime],
    ["Accept-Ranges", "bytes"],
    // Media never leaves this handler for the network; forbid the page
    // context from doing anything with it beyond playback.
    ["Cache-Control", "no-store"],
    // A CORS-clean response so a `<video crossorigin="anonymous">` frame grab
    // doesn't taint the canvas — `roommedia://` is a different origin than
    // the app, and canvas.toDataURL would otherwise throw a SecurityError.
    // The scheme is app-internal, so `*` is safe.
    ["Access-Control-Allow-Origin", "*"],
  ];

  if (range === null || range === undefined) {
    const headers: MediaHeader[] = [...base, ["Content-Length", String(len)]];
    return { status: 200, headers, body: Buffer.from(bytes) };
  }

  const parsed = parseRange(range, len);
  if (parsed === null) {
    return {
      status: 416,
      headers: [["Content-Range", `bytes */${len}`], ALLOW_ORIGIN],
      body: Buffer.alloc(0),
    };
  }
  const [start, end] = parsed;
  const body = Buffer.from(bytes.subarray(start, end + 1));
  const headers: MediaHeader[] = [
    ...base,
    ["Content-Length", String(body.length)],
    ["Content-Range", `bytes ${start}-${end}/${len}`],
  ];
  return { status: 206, headers, body };
}

async function rangeStream(
  source: Readable,
  start: number,
  end: number,
): Promise<ReadableStream<Uint8Array>> {
  async function* selected(): AsyncGenerator<Buffer> {
    let position = 0;
    try {
      for await (const raw of source) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        const chunkStart = position;
        const chunkEnd = position + chunk.length - 1;
        position += chunk.length;
        if (chunkEnd < start) continue;
        if (chunkStart > end) break;
        const from = Math.max(0, start - chunkStart);
        const to = Math.min(chunk.length, end - chunkStart + 1);
        if (to > from) yield chunk.subarray(from, to);
        if (chunkEnd >= end) break;
      }
    } finally {
      source.destroy();
    }
  }
  return Readable.toWeb(Readable.from(selected())) as ReadableStream<Uint8Array>;
}

/** Async protocol response used for normal workspace files. Legacy staged
 * blobs still delegate to the exact synchronous implementation above. */
export async function mediaStreamingResponse(
  streams: MediaStreams,
  path: string,
  range: string | null | undefined,
): Promise<StreamingMediaHttpResponse> {
  const token = path.replace(/^\/+/, "");
  const staged = streams.map.get(token);
  if (staged?.openStream === undefined || staged.sizeBytes === undefined) {
    return mediaResponse(streams, path, range);
  }
  const len = staged.sizeBytes;
  const base: MediaHeader[] = [
    ["Content-Type", staged.mime],
    ["Accept-Ranges", "bytes"],
    ["Cache-Control", "no-store"],
    ALLOW_ORIGIN,
  ];
  if (range === null || range === undefined) {
    const stream = await staged.openStream();
    return {
      status: 200,
      headers: [...base, ["Content-Length", String(len)]],
      body: await rangeStream(stream, 0, Math.max(0, len - 1)),
    };
  }
  const parsed = parseRange(range, len);
  if (parsed === null) {
    return {
      status: 416,
      headers: [["Content-Range", `bytes */${len}`], ALLOW_ORIGIN],
      body: Buffer.alloc(0),
    };
  }
  const [start, end] = parsed;
  const stream = staged.openRange === undefined
    ? await staged.openStream()
    : await staged.openRange(start, end);
  return {
    status: 206,
    headers: [
      ...base,
      ["Content-Length", String(end - start + 1)],
      ["Content-Range", `bytes ${start}-${end}/${len}`],
    ],
    body: staged.openRange === undefined
      ? await rangeStream(stream, start, end)
      : await rangeStream(stream, 0, end - start),
  };
}
