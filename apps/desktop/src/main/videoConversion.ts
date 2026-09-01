import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { MediaMeta } from "../shared/apiTypes.js";
import { probePath } from "./mediaProbe.js";
import { clampChars } from "./textClamp.js";
import { removeQuietly, writePrivate } from "./textUtil.js";

export const execFileAsync = promisify(execFile);


// ------------------------------------------------------------------ constants

/** A clip shorter than this is not a cut, it is a mistake. Ported verbatim
 * from `video.rs`'s `MIN_TRIM_SECS`. */
export const MIN_TRIM_SECS = 0.1;
export

/** `commands/files.rs`'s own room-wide file-size ceiling (files.rs has no
 * Electron port yet in this tree — see this module's doc for the OCR/STT
 * lane gap, a different corner of that same unported file). Verbatim value;
 * a future `files.ts` port should absorb this copy rather than the reverse,
 * the same standing `peaksTools.ts` leaves for its own `mediaKind` copy. */
const MAX_IMPORT_BYTES = 1_000_000_000;
export

/** `AppState::with_room`'s own refusal, spelled the way every other port in
 * this tree already spells it. */
const NO_ROOM_OPEN = "No room is open.";
export

// -------------------------------------------------------------- pure helpers

/** Rust's `{:.1}` fixed-precision float format — one digit after the point.
 * Every value this module formats this way comes from a UI-supplied seconds
 * count or an already-probed duration, never a value near a half-ULP
 * rounding boundary, so `toFixed`'s rounding rule (vs. Rust's) never
 * disagrees for any input either side of this port actually produces. */
function fmt1(n: number): string {
  return n.toFixed(1);
}


/**
 * `[start, end)` must sit somewhere the cut means something. Ported verbatim
 * from `video.rs`'s `validate_span`; throws instead of returning
 * `Result<(f64, f64), String>`, this port's house style.
 *
 * An unknown `duration` (`null`) is NOT a reason to refuse — it only removes
 * the upper bound; a tail that overruns a KNOWN duration is clamped rather
 * than refused (the "drag to the end" case), because the user's intent there
 * is unambiguous.
 */
export function validateSpan(
  start: number,
  end: number,
  duration: number | null
): [number, number] {
  assertRealTrimPoints(start, end);
  assertNonnegativeTrimStart(start);
  assertLongEnoughTrim(start, end);
  return clampTrimToDuration(start, end, duration);
}
export function assertRealTrimPoints(start: number, end: number): void {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error("The trim points aren't real numbers.");
  }
}
export function assertNonnegativeTrimStart(start: number): void {
  if (start < 0) {
    throw new Error("A trim can't start before the beginning of the video.");
  }
}
export function assertLongEnoughTrim(start: number, end: number): void {
  if (end - start < MIN_TRIM_SECS) {
    throw new Error(
      `That span is too short to trim — the end has to be at least ${MIN_TRIM_SECS}s after the start.`
    );
  }
}
export function clampTrimToDuration(start: number, end: number, duration: number | null): [number, number] {
  if (duration === null) {
    return [start, end];
  }
  if (start >= duration) {
    throw new Error(
      `The trim starts at ${fmt1(start)}s but the video is only ${fmt1(duration)}s long.`
    );
  }
  return [start, Math.min(end, duration)];
}
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}


/** Seconds → the "1-23" form used inside a file name (colons are legal in a
 * room name but read as a Finder path separator on export). Ported verbatim
 * from `video.rs`'s `stamp_for_name`. */
export function stampForName(secs: number): string {
  const s = Math.round(Math.max(secs, 0));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}-${pad2(m)}-${pad2(sec)}`;
  }
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}-${pad2(sec)}`;
}


/**
 * A file name split into (stem, extension), KEEPING the extension's own
 * case. NOT `editMatchExtraction.ts`'s `extensionOf`: that lowercases, and
 * stripping a lowercased suffix off the real name silently fails to match a
 * camera's `IMG_0042.MOV` — the bug this module's own Rust doc comment
 * names by the exact garbled name it used to produce. Ported verbatim from
 * `video.rs`'s `split_name`.
 */
export function splitName(name: string): [string, string] {
  const idx = name.lastIndexOf(".");
  // A leading dot (idx === 0) is not an extension — ".hidden" is the whole
  // name — and a trailing dot (idx === name.length - 1) leaves no extension
  // either; `rsplit_once` requires both halves non-empty.
  if (idx > 0 && idx < name.length - 1) {
    return [name.slice(0, idx), name.slice(idx + 1)];
  }
  return [name, ""];
}


/** `talk.mp4` + 7.3s-19.0s -> `talk (trim 0-07 to 0-19).mp4`. Ported
 * verbatim from `video.rs`'s `trimmed_name`. */
export function trimmedName(name: string, start: number, end: number): string {
  const [stem, ext] = splitName(name);
  const a = stampForName(start);
  const b = stampForName(end);
  return ext === "" ? `${stem} (trim ${a} to ${b})` : `${stem} (trim ${a} to ${b}).${ext}`;
}


/** `talk.mp4` at 83.4s -> `talk @ 1-23.png`. Ported verbatim from
 * `video.rs`'s `frame_name`. */
export function frameName(name: string, secs: number): string {
  const [stem] = splitName(name);
  return `${stem} @ ${stampForName(secs)}.png`;
}


/** What went wrong with the cut, said in a sentence. Ported verbatim from
 * `video.rs`'s `describe_convert_error`. */
export function describeConvertError(err: string): string {
  if (err.includes("NotFound") || err.includes("No such file or directory")) {
    return "This Mac has no /usr/bin/avconvert, which is the tool that cuts video here — " +
      "nothing was trimmed.";
  }
  return `The video couldn't be trimmed: ${err}`;
}
export

/** `MediaMeta::is_empty()` (`meta == MediaMeta::default()`) — every field
 * independently unknown. Ported verbatim from `media_probe.rs`. */
function isEmptyMediaMeta(m: MediaMeta): boolean {
  return [
    m.durationSecs,
    m.width,
    m.height,
    m.videoCodec,
    m.frameRate,
    m.bitrateKbps,
    m.hasAudio,
    m.audioCodec,
  ].every((value) => value === null);
}
export

// -------------------------------------------------------------- base64/png

/** `base64::engine::general_purpose::STANDARD.decode` — strict: standard
 * alphabet, canonical padding, no whitespace. A FOURTH local copy of the
 * same strict decoder `chatCmds.ts`/`externalAdvisor.ts`/`skillsCmds.ts`
 * each already carry — see `chatCmds.ts`'s module doc for why Node's own
 * lenient `Buffer.from(s, "base64")` used alone is unsafe here (it never
 * throws, which would turn a corrupt paste into a corrupt file silently
 * written into the room). */
function decodeBase64Strict(s: string): Buffer | null {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    return null;
  }
  return Buffer.from(s, "base64");
}
export

/** The 8-byte PNG signature. `png.starts_with(b"\x89PNG\r\n\x1a\n")`. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function isPng(bytes: Buffer): boolean {
  return bytes.length >= PNG_MAGIC.length && bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}
export

// ---------------------------------------------------------- real: avconvert

/** One attempt with one preset. */
interface AvconvertAttempt {
  success: boolean;
  stderrText: string;
  statusText: string;
}
export function spawnFailureText(err: NodeJS.ErrnoException): string {
  // Node's spawn-level failure carries a STRING `code` ("ENOENT", …), unlike
  // a completed-but-nonzero exit (a NUMBER `code`) — see `runOnePreset`. This
  // mirrors what Rust's own `io::Error` Debug-prints for the same failure
  // (`Os { code: 2, kind: NotFound, message: "No such file or directory" }`)
  // closely enough for `describeConvertError`'s substring check to fire.
  if (err.code === "ENOENT") {
    return "No such file or directory (os error 2)";
  }
  return err.message ?? String(err.code ?? "spawn failed");
}
export

/**
 * Run `/usr/bin/avconvert` once with `preset`. Resolves `{success: true}`
 * only on a clean exit (the caller still checks `dst` really exists, exactly
 * as `run_avconvert` does); resolves `{success: false, …}` with whatever
 * stderr/status came back for a completed-but-failed run; THROWS only for a
 * spawn-level failure (the binary itself could not be found/run) — mirroring
 * Rust's `Command::output()`'s own split between "the OS could not even run
 * this" (`io::Error`, the `?` after `.output()`) and "it ran and told us it
 * failed" (`Output` with a non-success `status`).
 */
async function runOnePreset(
  preset: string,
  src: string,
  dst: string,
  start: number,
  dur: number
): Promise<AvconvertAttempt> {
  const args = [
    "-p",
    preset,
    "-s",
    src,
    "-o",
    dst,
    "--start",
    String(start),
    "--duration",
    String(dur),
    "--replace",
  ];
  try {
    await execFileAsync("/usr/bin/avconvert", args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return { success: true, stderrText: "", statusText: "exit code: 0" };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      stderr?: string;
      signal?: NodeJS.Signals | null;
    };
    if (typeof err.code === "string") {
      throw new Error(describeConvertError(spawnFailureText(err)));
    }
    const stderrText = typeof err.stderr === "string" ? err.stderr : "";
    const statusText =
      typeof err.code === "number"
        ? `exit code: ${err.code}`
        : err.signal
          ? `signal: ${err.signal}`
          : "unknown exit";
    return { success: false, stderrText, statusText };
  }
}


/**
 * Cut `[start, start+dur)` out of `src` into `dst` with the OS's own
 * converter. `PresetPassthrough` copies the encoded samples (no re-encode,
 * no generation loss); a container it refuses falls back to a real
 * re-encode (`PresetHighestQuality`). Ported verbatim from `video.rs`'s
 * `run_avconvert` — a REAL subprocess port, not a stub; see this module's
 * doc for why.
 *
 * Throws {@link describeConvertError}'s message on failure — including
 * IMMEDIATELY on a spawn-level failure (never tries the second preset),
 * mirroring Rust's own `?` after `.output()`.
 */
export async function runAvconvert(
  src: string,
  dst: string,
  start: number,
  dur: number
): Promise<void> {
  let last = "";
  for (const preset of ["PresetPassthrough", "PresetHighestQuality"]) {
    const attempt = await runOnePreset(preset, src, dst, start, dur);
    if (attempt.success && fs.existsSync(dst)) {
      return;
    }
    last = clampChars(attempt.stderrText, 300).trim();
    if (last === "") {
      last = `${preset} exited with ${attempt.statusText}`;
    }
  }
  throw new Error(describeConvertError(last));
}


// -------------------------------------------------------- real: media_probe

/** `media_probe::probe_path(path) -> Option<MediaMeta>` — the injectable
 * engine seam. Defaults to {@link probeVideoWithFfprobe}, a REAL read; kept
 * injectable so a future AVFoundation/PyObjC bridge can replace the engine
 * without touching a caller. See this module's doc. */
export type ProbeVideoFn = (path: string) => Promise<MediaMeta | null>;


/**
 * The REAL default {@link ProbeVideoFn}: `mediaProbe.ts`'s {@link probePath},
 * this migration's full port of `media_probe.rs` over `ffprobe`.
 *
 * Written as a named wrapper rather than passing `probePath` itself, so this
 * file's default never silently acquires `probePath`'s SECOND parameter (its
 * own injectable `ProbeEngine`) — `ProbeVideoFn` is one argument by contract,
 * and a two-argument default would let a caller's stray second argument reach
 * a seam it knows nothing about.
 *
 * `null` for a file no engine could read — including a Mac with no `ffprobe`
 * installed — which is `media_probe.rs`'s own `None`, not a swallowed error.
 */
export const probeVideoWithFfprobe: ProbeVideoFn = (p) => probePath(p);
export

/**
 * Stage `bytes` to an owner-only temp file (AVFoundation dispatches on the
 * file EXTENSION as well as the container's own magic, so the temp copy
 * keeps it, and so does `ffprobe`), probe it, and remove the temp file on
 * every exit path — success, `probe` resolving `null`, or `probe` throwing.
 * Ported verbatim from `media_probe.rs`'s `probe_bytes`, with the engine read
 * taken as the injected `probe` (see this module's doc).
 *
 * A rejection from `probe` PROPAGATES. The real default never rejects (it is
 * `Option`-shaped end to end, like Rust's own `probe_bytes`), so this only
 * concerns an INJECTED prober; letting it through rather than folding it into
 * `null` keeps "this engine failed" distinguishable from "this engine looked
 * and found nothing."
 */
async function probeBytes(
  bytes: Buffer,
  ext: string,
  probe: ProbeVideoFn
): Promise<MediaMeta | null> {
  const stem = randomUUID();
  const file = path.join(
    os.tmpdir(),
    ext === "" ? `arcelle-probe-${stem}` : `arcelle-probe-${stem}.${ext}`
  );
  try {
    if (!writePrivate(file, bytes)) {
      return null;
    }
    return await probe(file);
  } finally {
    removeQuietly(file);
  }
}
