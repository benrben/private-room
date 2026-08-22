/**
 * ADD-27 recording data model + the pure text/audio-format helpers every
 * recording DB write and every transcript-editing command needs. Port of the
 * data-model and free-function half of `src-tauri/src/recording.rs` — and
 * NOTHING from the live engine itself (VAD, the decoder thread,
 * ScreenCaptureKit, the diarization pipeline). That engine already shipped,
 * unchanged, as the Python `sidecar/arcelle_sidecar/rec/engine.py`; this file
 * exists so ELECTRON's side (`db-host/recordings.ts`, `recBridge.ts`) can
 * read/write the exact same `RecMeta` JSON and produce byte-identical
 * WAV/transcript output without depending on that engine at all.
 *
 * Ported field-for-field / line-for-line:
 *   - `RecWord`/`VoicePrint`/`RecSegment`/`By`/`NoteKind`/`RecNote`/
 *     `RecHighlight`/`RecChapter`/`RecCut`/`ReadStamp`/`RecMeta`
 *     (`recording.rs:110-345`, `diarize.rs:519-530` for `VoicePrint`),
 *   - `csOfSamples`/`samplesOfCs`/`formatStamp`/`segmentVisibleText`/
 *     `noteLine`/`transcriptText`/`addCut` (`recording.rs:347-499`),
 *   - `encodeWav`/`decodeWav`/`spliceOut`/`cutShiftBefore`/`insideCut`
 *     (`recording.rs:506-598`).
 *
 * NOT ported (the live engine's own machinery, not a data format): the VAD /
 * segmentation constants, `resample_to_16k`, `relabel_interval`,
 * `text_overlap`/`time_overlap`, and everything past the `Save` enum.
 *
 * ON FIELD NAMES. Every struct above carries `#[serde(rename_all =
 * "camelCase")]`, so the TS field names ARE the on-disk/on-wire names — with
 * one exception that is easy to get wrong and expensive when you do:
 * `diarize::VoicePrint` renames its two fields individually to `v` and `f`
 * (`#[serde(rename = "v")]` / `#[serde(rename = "f")]`). There is therefore
 * exactly ONE `VoicePrint` shape in this port — `{v, f}` — used both in memory
 * and on the wire, exactly as Rust has one struct. A second, "friendlier"
 * in-memory spelling (`{vec, voicedFrames}`) reads `undefined` off every real
 * segment the sidecar or an existing room hands over.
 */

export const SAMPLE_RATE = 16_000;

// ---------------------------------------------------------------- data model

/** One word with its place on the timeline (centiseconds). `del` marks words
 * removed by the transcript editor — the audio keeps them until export.
 * (`#[serde(default, skip_serializing_if = "Not::not")]` on the Rust side, so
 * an absent `del` is `false`.) */
export interface RecWord {
  w: string;
  t0: number;
  t1: number;
  del?: boolean;
}

/**
 * One phrase's (or one identity's) voiceprint plus how much real speech went
 * into it — the vector alone cannot say whether it is trustworthy.
 *
 * `v` is L2-normalized, so cosine similarity is a plain dot product: 192 dims
 * for a TitaNet print, 19 or 21 for the DSP prints in older files. `f` is
 * voiced 16 ms frames. THESE ARE THE WIRE NAMES — see this module's own header.
 */
export interface VoicePrint {
  v: number[];
  f: number;
}

export interface RecSegment {
  id: string;
  /** "mic" | "sys" — which capture lane heard it. */
  source: string;
  /** "You" for the microphone, "Speaker N" for clustered meeting voices. */
  speaker: string;
  t0: number;
  t1: number;
  text: string;
  words: RecWord[];
  lang?: string | null;
  /** The phrase's voiceprint (meeting lane only) — absent on mic phrases and
   * on files recorded before ADD-27. */
  voice?: VoicePrint | null;
}

/** Who put an annotation on the recording: the room's reading pass, or the
 * person. The re-run rule: a fresh pass replaces everything `room` and never
 * touches anything `you` — editing an item makes it yours, permanently. */
export type By = "room" | "you";

/** What the room found in a stretch of the conversation. */
export type NoteKind = "decision" | "action" | "question" | "point";

/** The four `NoteKind` spellings, as one runtime-checkable set — Rust's
 * `rec_note_add` matches on the trimmed string and falls through to `Point`,
 * so an unknown kind must be NORMALIZED, never stored verbatim. */
const NOTE_KINDS = new Set<string>(["decision", "action", "question", "point"]);

/** `rec_note_add`'s own `match kind.trim() { … _ => Point }`
 * (`recording_cmds.rs:974-979`). */
export function noteKindOf(kind: string): NoteKind {
  const trimmed = kind.trim();
  return NOTE_KINDS.has(trimmed) ? (trimmed as NoteKind) : "point";
}

/** A note pinned to a moment. `t0` is ORIGINAL-timeline centiseconds — the
 * same timeline `RecCut` is stated on, not a segment id (segment ids are
 * re-minted on every re-transcribe; a time stays true across that). */
export interface RecNote {
  id: string;
  t0: number;
  kind: NoteKind;
  /** Who the action is on, when the transcript actually says. */
  who?: string | null;
  text: string;
  by: By;
}

/** A stretch worth coming back to. The words are the transcript's own — a
 * highlight marks them, it does not copy them. */
export interface RecHighlight {
  id: string;
  t0: number;
  t1: number;
  by: By;
}

/** A named section of the recording, starting at `t0` and running to the next
 * chapter (or the end). */
export interface RecChapter {
  id: string;
  t0: number;
  title: string;
  by: By;
}

/** A span deleted from the transcript. Playback skips it; "export edited copy"
 * cuts it out of the audio for real. Non-destructive and undoable. */
export interface RecCut {
  t0: number;
  t1: number;
}

/** The fingerprint of the transcript a reading pass was made from. Cheap and
 * exact enough: any edit to the words moves one of the two numbers. */
export interface ReadStamp {
  turns: number;
  chars: number;
}

/** The stamp for a transcript as it stands now (`recording.rs:312-317`).
 *
 * Rust's `.len()` on a `String` is UTF-8 BYTE length, not character count —
 * matched here for the same reason `files.ts`'s chunking measures true byte
 * length: a Hebrew transcript has to move this number by exactly as much as
 * the Rust original would, or a reading pass written by one and checked by the
 * other reads as stale on sight. */
export function readStampOf(segments: readonly RecSegment[]): ReadStamp {
  let chars = 0;
  for (const s of segments) {
    chars += Buffer.byteLength(s.text, "utf8");
  }
  return { turns: segments.length, chars };
}

/** A recording's stored metadata. Shape changes are handled by JSON alone —
 * new fields are optional/defaulted, retired ones are simply ignored when an
 * older room's JSON is parsed. */
export interface RecMeta {
  durationCs: number;
  segments: RecSegment[];
  cuts: RecCut[];
  /** How many meeting voices to tell apart. 0 means "discover them". */
  maxSpeakers: number;
  /** GH #5: machine label -> what the user calls them ("Speaker 2" ->
   * "Dana"). An OVERLAY, not baked into `segments` — diarization rewrites
   * labels freely, and a name written into every segment would be destroyed by
   * the next pass. */
  speakerNames: Record<string, string>;
  /** Which of `speakerNames` the app GUESSED from a voice heard before, rather
   * than the user typing them. A `BTreeSet<String>` in Rust; a plain array
   * here, treated as a set by every mutator. */
  recognized: string[];
  chapters: RecChapter[];
  highlights: RecHighlight[];
  notes: RecNote[];
  /** What the room found when it read this recording. `null`/absent means
   * never read — what the background sweep looks for. */
  readOf?: ReadStamp | null;
}

/** A fresh, empty `RecMeta` — Rust's `RecMeta::default()`. */
export function defaultRecMeta(): RecMeta {
  return {
    durationCs: 0,
    segments: [],
    cuts: [],
    maxSpeakers: 0,
    speakerNames: {},
    recognized: [],
    chapters: [],
    highlights: [],
    notes: [],
    readOf: null,
  };
}

/** What a speaker should be CALLED — the user's name if they set one, else the
 * machine label. Every user-visible rendering of a speaker goes through here
 * so the screen and the file cannot drift apart. */
export function displaySpeaker(meta: RecMeta, label: string): string {
  return meta.speakerNames[label] ?? label;
}

// ------------------------------------------------------------- time / text

export function csOfSamples(samples: number): number {
  return Math.trunc((samples * 100) / SAMPLE_RATE);
}

export function samplesOfCs(cs: number): number {
  return Math.trunc((Math.max(cs, 0) * SAMPLE_RATE) / 100);
}

export function formatStamp(cs: number): string {
  const s = Math.max(Math.trunc(cs / 100), 0);
  const h = Math.trunc(s / 3600);
  const rem = s % 3600;
  const m = Math.trunc(rem / 60);
  const sec = rem % 60;
  const pad2 = (n: number): string => n.toString().padStart(2, "0");
  return h > 0 ? `[${h}:${pad2(m)}:${pad2(sec)}]` : `[${m}:${pad2(sec)}]`;
}

/** A segment's text with deleted words removed. Falls back to the raw text
 * when a segment has no word list (partial-only or legacy rows). */
export function segmentVisibleText(seg: RecSegment): string {
  if (seg.words.length === 0) {
    return seg.text.trim();
  }
  const kept: string[] = [];
  for (const w of seg.words) {
    if (w.del === true) {
      continue;
    }
    const trimmed = w.w.trim();
    if (trimmed !== "") {
      kept.push(trimmed);
    }
  }
  return kept.join(" ");
}

/** One note as the transcript states it — labelled by kind so a reader (human
 * or model) can tell a decision from an open question without guessing, and so
 * "action items" is a searchable phrase. */
function noteLine(n: RecNote): string {
  const label: Record<NoteKind, string> = {
    decision: "Decision",
    action: "Action",
    question: "Open question",
    point: "Point",
  };
  if (n.kind === "action" && n.who !== undefined && n.who !== null && n.who !== "") {
    return `${label[n.kind]} (${n.who}): ${n.text}`;
  }
  return `${label[n.kind]}: ${n.text}`;
}

/**
 * The searchable/actionable transcript stored as the file's extracted text —
 * the same "[m:ss] …" contract the audio viewer, the RAG index and every AI
 * action already consume. Deleted words are simply absent from it.
 *
 * Highlights are MARKED, not repeated: a highlight points at words already on
 * the line below it, so copying them would put every marked sentence into the
 * search index and into every AI prompt twice.
 *
 * `chapters` and `notes` are consumed in the ORDER `meta` already holds them —
 * a faithful walk of Rust's two `Peekable` iterators over `meta.chapters` /
 * `meta.notes` themselves. Every writer (this port's edit ops, the sidecar's
 * `_apply_add_*`, Rust's own commands) sorts on write, so re-sorting here would
 * only change the output for input Rust itself renders unsorted.
 */
export function transcriptText(meta: RecMeta): string {
  let out = "(live recording)\n";
  const { chapters, notes } = meta;
  let ci = 0;
  let ni = 0;
  for (const seg of meta.segments) {
    const text = segmentVisibleText(seg);
    if (text === "") {
      continue;
    }
    while (ci < chapters.length && (chapters[ci] as RecChapter).t0 <= seg.t0) {
      const c = chapters[ci] as RecChapter;
      out += `\n## ${formatStamp(c.t0)} ${c.title}\n`;
      ci++;
    }
    while (ni < notes.length && (notes[ni] as RecNote).t0 <= seg.t0) {
      const n = notes[ni] as RecNote;
      out += `${formatStamp(n.t0)} ${noteLine(n)}\n`;
      ni++;
    }
    const marked = meta.highlights.some((h) => h.t0 < seg.t1 && seg.t0 < Math.max(h.t1, h.t0 + 1));
    const who = displaySpeaker(meta, seg.speaker);
    out += `${marked ? "* " : ""}${formatStamp(seg.t0)} ${who}: ${text}\n`;
  }
  // Anything anchored past the last phrase still belongs in the text.
  for (; ci < chapters.length; ci++) {
    const c = chapters[ci] as RecChapter;
    out += `\n## ${formatStamp(c.t0)} ${c.title}\n`;
  }
  for (; ni < notes.length; ni++) {
    const n = notes[ni] as RecNote;
    out += `${formatStamp(n.t0)} ${noteLine(n)}\n`;
  }
  return out;
}

/** Merge a new cut into the (sorted, disjoint) cut list. Rust mutates its
 * `Vec` in place; this returns the merged list, so call sites read
 * `meta.cuts = addCut(meta.cuts, …)`. The input array is never mutated. */
export function addCut(cuts: readonly RecCut[], next: RecCut): RecCut[] {
  const sorted = [...cuts, next].sort((a, b) => a.t0 - b.t0);
  const merged: RecCut[] = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && c.t0 <= last.t1) {
      last.t1 = Math.max(last.t1, c.t1);
    } else {
      merged.push({ ...c });
    }
  }
  return merged;
}

// ---------------------------------------------------------------- WAV bytes

/** 16 kHz mono 16-bit WAV — the recording file's on-disk shape. Rust's
 * `as i16` cast TRUNCATES toward zero rather than rounding, so `Math.trunc`
 * (not `Math.round`) is what makes the bytes identical. */
export function encodeWav(samples: Float32Array | readonly number[]): Buffer {
  const n = samples.length;
  const dataLen = n * 2;
  const b = Buffer.alloc(44 + dataLen);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + dataLen, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(SAMPLE_RATE, 24);
  b.writeUInt32LE(SAMPLE_RATE * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < n; i++) {
    const clamped = Math.min(Math.max(samples[i] as number, -1), 1);
    b.writeInt16LE(Math.trunc(clamped * 32767), 44 + i * 2);
  }
  return b;
}

/** Parse OUR OWN WAV shape back to f32 (resume / export). Any-channel-count
 * tolerant, expects 16-bit PCM. Throws — Rust's `Result<Vec<f32>, String>`
 * error arm — for anything that is not a readable WAV. */
export function decodeWav(bytes: Buffer | Uint8Array): Float32Array {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.length < 44 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let channels = 1;
  let pos = 12;
  let dataStart = -1;
  let dataSize = 0;
  while (pos + 8 <= b.length) {
    const id = b.toString("ascii", pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt " && body + 4 <= b.length) {
      channels = Math.max(b.readUInt16LE(body + 2), 1);
    } else if (id === "data") {
      dataStart = body;
      dataSize = Math.min(size, Math.max(b.length - body, 0));
      break;
    }
    pos = body + size + (size & 1);
  }
  if (dataStart < 0) {
    throw new Error("WAV has no data chunk");
  }
  const frameBytes = 2 * channels;
  const frames = Math.trunc(dataSize / frameBytes);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      acc += b.readInt16LE(dataStart + i * frameBytes + c * 2);
    }
    out[i] = acc / channels / 32768;
  }
  return out;
}

/**
 * Remove the cut spans from the samples — the "make the edit real" step of
 * export. Cuts are centisecond spans on the same timeline as the samples.
 *
 * Two passes (measure the surviving spans, then one `set` per span) rather
 * than pushing sample-by-sample into a plain array: Rust's own
 * `Vec::with_capacity` + `extend_from_slice` is a memcpy, and a three-hour
 * recording is 170M samples — boxing each one into a JS array first is the
 * difference between a buffer copy and gigabytes of heap.
 */
export function spliceOut(samples: Float32Array, cuts: readonly RecCut[]): Float32Array {
  const sorted = [...cuts].sort((a, b) => a.t0 - b.t0);
  const keep: Array<[number, number]> = [];
  let pos = 0;
  let total = 0;
  for (const c of sorted) {
    const a = Math.min(samplesOfCs(c.t0), samples.length);
    const b = Math.min(samplesOfCs(c.t1), samples.length);
    if (a > pos) {
      keep.push([pos, a]);
      total += a - pos;
    }
    pos = Math.max(pos, b);
  }
  if (pos < samples.length) {
    keep.push([pos, samples.length]);
    total += samples.length - pos;
  }
  const out = new Float32Array(total);
  let at = 0;
  for (const [a, b] of keep) {
    out.set(samples.subarray(a, b), at);
    at += b - a;
  }
  return out;
}

/** How much cut time (cs) lies strictly before `t` — the timestamp shift an
 * exported (spliced) copy needs. */
export function cutShiftBefore(cuts: readonly RecCut[], t: number): number {
  let sum = 0;
  for (const c of cuts) {
    sum += Math.max(Math.min(c.t1, t) - c.t0, 0);
  }
  return sum;
}

/** Is `t` inside a deleted span? An annotation there points at words the
 * exported copy no longer contains. The ORIGINAL keeps it — cuts are undoable,
 * and un-deleting a span must bring its notes back with it. */
export function insideCut(cuts: readonly RecCut[], t: number): boolean {
  return cuts.some((c) => t >= c.t0 && t < c.t1);
}
