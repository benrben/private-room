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

/** Parse either dialect. Cue numbers, `WEBVTT` headers, `NOTE` and `STYLE`
 * blocks are structure, not speech, and are dropped. */
export function parseCues(raw: string): Cue[] {
  const cues: Cue[] = [];
  // Both dialects separate cues with a blank line; \r\n is normalized first so
  // a Windows-authored file doesn't leave a stray \r on every line of text.
  const blocks = raw.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    if (/^WEBVTT/i.test(lines[0]) && lines.length === 1) continue;
    if (/^(NOTE|STYLE|REGION)\b/i.test(lines[0])) continue;
    // A leading bare number is SRT's cue index; WebVTT may use a cue id here.
    let at = 0;
    if (!lines[at].includes("-->")) at++;
    if (at >= lines.length || !lines[at].includes("-->")) continue;
    const [rawStart, rawEnd] = lines[at].split("-->");
    const startMs = parseStamp(rawStart ?? "");
    // A WebVTT timing line can carry settings after the end stamp
    // ("... --> 00:02.000 line:90%"), so only the first token is the time.
    const endMs = parseStamp((rawEnd ?? "").trim().split(/\s+/)[0] ?? "");
    if (startMs == null || endMs == null) continue;
    const text = lines.slice(at + 1).join("\n").trim();
    if (!text) continue;
    cues.push({ index: cues.length + 1, startMs, endMs, text });
  }
  return cues;
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

/** Serialize back to WebVTT. */
export function toVtt(cues: Cue[]): string {
  return (
    "WEBVTT\n\n" +
    cues
      .map(
        (c) =>
          `${formatStamp(c.startMs, ".")} --> ${formatStamp(c.endMs, ".")}\n${c.text}`,
      )
      .join("\n\n") +
    "\n"
  );
}
