/** SRT and WebVTT cues, parsed for the subtitle editor.
 *
 * A `.srt` used to have no viewer at all — it landed on the plain-text card as
 * an interleaved wall of indexes, timecodes and lines. Here the timing and the
 * words are separate fields, so the file can be read as a transcript and its
 * lines corrected without touching a single timestamp by hand.
 *
 * Dependency-free and DOM-free so it is unit-tested directly under
 * `npm run test:page`.
 */
export interface Cue {
  /** 1-based position in the file, as displayed. */
  index: number;
  startMs: number;
  endMs: number;
  /** The cue's text, with its internal line breaks kept. */
  text: string;
  /** The line above the timing, when the file had one: SRT's cue number, or a
   * WebVTT cue identifier. */
  id?: string;
  /** Whatever followed the end stamp on the timing line — `line:90%
   * align:start`. It is where the caption sits on the picture, so a save that
   * dropped it moved every positioned caption. */
  settings?: string;
  /** Blocks that stood before this cue and are not cues: the `WEBVTT` header
   * with its own metadata lines, `NOTE`, `STYLE` and `REGION`. Kept verbatim
   * so re-serializing gives the file back rather than a stripped copy. */
  before?: string[];
  /** The same, for blocks after the LAST cue. Only ever set on it. */
  after?: string[];
}

/** `hh:mm:ss,mmm` (SRT) or `hh:mm:ss.mmm` / `mm:ss.mmm` (WebVTT) → ms.
 * Returns null when the stamp doesn't parse, which is how a malformed line is
 * skipped rather than silently read as time zero. */
export function parseStamp(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  const frac = m[4].padEnd(3, "0");
  return ((h * 60 + min) * 60 + sec) * 1000 + parseInt(frac, 10);
}

/** ms → `hh:mm:ss,mmm`, the SRT spelling. */
export function formatStamp(ms: number, sep = ","): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const f = t % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(f, 3)}`;
}

/** Short form for a UI label: `m:ss` (or `h:mm:ss` past an hour). */
export function shortStamp(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Parse either dialect. The words are separated from everything around them —
 * the cue's own id, its positioning settings, and the `WEBVTT` header,
 * `NOTE`/`STYLE`/`REGION` blocks between cues — and all of it is carried on the
 * cues so a save can put the file back together as it was. */
type ParsedCue = Omit<Cue, "index" | "before" | "after">;

interface ParseState {
  cues: Cue[];
  stray: string[];
}

interface CuePreamble {
  at: number;
  id?: string;
}

function cueLines(block: string): string[] {
  return block.split("\n").filter((line) => line.trim() !== "");
}

function isMetadataBlock(lines: string[]): boolean {
  return /^WEBVTT/i.test(lines[0]) || /^(NOTE|STYLE|REGION)\b/i.test(lines[0]);
}

function cuePreamble(lines: string[]): CuePreamble | undefined {
  if (lines[0].includes("-->")) return { at: 0 };
  if (!lines[1]) return undefined;
  return { at: 1, id: lines[0].trim() };
}

function parseTiming(
  timingLine: string,
): Pick<ParsedCue, "startMs" | "endMs" | "settings"> | undefined {
  const [rawStart = "", rawEnd = ""] = timingLine.split("-->");
  const startMs = parseStamp(rawStart);
  // A WebVTT timing line can carry settings after the end stamp
  // ("... --> 00:02.000 line:90%"), so only the first token is the time.
  const tail = rawEnd.trim().split(/\s+/);
  const endMs = parseStamp(tail[0]);
  if (startMs == null || endMs == null) return undefined;
  const settings = tail.slice(1).join(" ");
  return settings ? { startMs, endMs, settings } : { startMs, endMs };
}

function parseCue(lines: string[]): ParsedCue | undefined {
  const preamble = cuePreamble(lines);
  if (!preamble) return undefined;
  const timingLine = lines[preamble.at];
  if (!timingLine.includes("-->")) return undefined;
  const timing = parseTiming(timingLine);
  if (!timing) return undefined;
  // A timed block with no words is still a cue. Dropping it deleted the
  // timecode of every line the editor cleared, and renumbered the rest.
  const text = lines.slice(preamble.at + 1).join("\n").trim();
  return preamble.id ? { ...timing, id: preamble.id, text } : { ...timing, text };
}

function indexedCue(parsed: ParsedCue, index: number): Cue {
  const { id, settings, startMs, endMs, text } = parsed;
  const cue: Cue = { index, startMs, endMs, text };
  if (id) cue.id = id;
  if (settings) cue.settings = settings;
  return cue;
}

function publishCue(state: ParseState, parsed: ParsedCue): void {
  const cue = indexedCue(parsed, state.cues.length + 1);
  if (state.stray.length) {
    cue.before = state.stray;
    state.stray = [];
  }
  state.cues.push(cue);
}

function consumeBlock(state: ParseState, block: string): void {
  const lines = cueLines(block);
  if (!lines.length) return;
  if (isMetadataBlock(lines)) {
    state.stray.push(lines.join("\n"));
    return;
  }
  const parsed = parseCue(lines);
  if (parsed) publishCue(state, parsed);
}

function finishMetadata(state: ParseState): void {
  if (state.stray.length && state.cues.length) state.cues[state.cues.length - 1].after = state.stray;
}

export function parseCues(raw: string): Cue[] {
  const state: ParseState = { cues: [], stray: [] };
  // Both dialects separate cues with a blank line; \r\n is normalized first so
  // a Windows-authored file doesn't leave a stray \r on every line of text.
  raw.replace(/\r\n?/g, "\n").split(/\n{2,}/).forEach((block) => consumeBlock(state, block));
  finishMetadata(state);
  return state.cues;
}

/** Serialize back to SRT. Round-trips `parseCues`, so the subtitle editor can
 * save a corrected line without disturbing any timing. */
export function toSrt(cues: Cue[]): string {
  return (
    cues
      .map(
        (c, i) =>
          `${i + 1}\n${formatStamp(c.startMs)} --> ${formatStamp(c.endMs)}\n${c.text}`,
      )
      .join("\n\n") + "\n"
  );
}

/** Serialize back to WebVTT, header, styles, cue ids and positioning included.
 * Correcting one word must not cost a file its `STYLE` block or move a caption
 * that was placed by hand. */
export function toVtt(cues: Cue[]): string {
  const head = cues[0]?.before?.[0];
  const headed = head != null && /^WEBVTT/i.test(head);
  const out: string[] = [headed ? head : "WEBVTT"];
  cues.forEach((c, i) => {
    const before = c.before ?? [];
    out.push(...(i === 0 && headed ? before.slice(1) : before));
    const timing = `${formatStamp(c.startMs, ".")} --> ${formatStamp(c.endMs, ".")}${
      c.settings ? ` ${c.settings}` : ""
    }`;
    out.push(`${c.id ? `${c.id}\n` : ""}${timing}\n${c.text}`);
  });
  out.push(...(cues[cues.length - 1]?.after ?? []));
  return out.join("\n\n") + "\n";
}
