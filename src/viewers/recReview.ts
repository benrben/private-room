/**
 * Reviewing a finished recording — the decisions the review screen makes,
 * kept out of RecordingView so they can be argued with on their own
 * (e2e/page-script/recReview.test.mjs).
 *
 * Everything here answers a question about a recording that has already been
 * made: which stage of capture the file is in, where the transport's marks
 * sit, which phrases a search matched, which phrase the playhead is inside,
 * and what a highlight actually QUOTES. None of it changes anything, and none
 * of it touches the DOM — the three P1s this module was written for were all
 * cases of one of those rules being buried in JSX, where it could not be
 * checked and quietly went wrong.
 */
import type { RecChapter, RecHighlight } from "../apiTypes";

/** Centiseconds → "m:ss", or "h:mm:ss" past the hour. Every stamp in the
 * recording UI is drawn by this one function, so the transport, the
 * transcript, the clips and the highlight rows cannot disagree about what
 * time a moment is. */
export function formatTimestamp(centiseconds: number): string {
  const s = Math.max(0, Math.floor(centiseconds / 100));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ stage */

/**
 * What this file is doing right now, as one word.
 *
 * QA 2026-08-15 (P1): a FINISHED recording permanently showed "Include the
 * Mac's audio", "Speakers detected automatically" and "Live translate" — the
 * choices you make before capturing, offered forever afterwards beside a
 * transcript they can no longer affect. The view only ever asked `isLive`,
 * which cannot tell a file that has never been recorded from one that is
 * finished, so both got the same row of capture settings. That distinction is
 * this type: "fresh" is a file waiting to be recorded and its choices belong
 * on screen; "finished" is a recording being reviewed and they belong behind
 * the act that would use them.
 */
export type CaptureStage = "recording" | "paused" | "saving" | "fresh" | "finished";

export function captureStage(status: string, everRecorded: boolean): CaptureStage {
  if (status === "recording" || status === "paused" || status === "saving") return status;
  return everRecorded ? "finished" : "fresh";
}

/** Pressing "Continue recording" on a finished file opens the capture choices
 * first, because they are the choices that press applies — system audio and
 * live translate are set for the session that is about to start, not for the
 * one that already ended. Nowhere else needs a preflight: a fresh file shows
 * the same choices inline (there is nothing else on the page to bury them
 * under), and a live session's controls have to stay reachable mid-meeting. */
export const needsPreflight = (stage: CaptureStage): boolean => stage === "finished";

/** The other reading of the same rule, so the JSX can say which it means. */
export const showsChoicesInline = (stage: CaptureStage): boolean => !needsPreflight(stage);

/* ---------------------------------------------------------------- playback */

/** The speeds the transport offers. A spoken-word range: fast enough to skim
 * a meeting, slow enough to make out a mumbled name. `<audio controls>` gave
 * WebKit's own list, which is what this replaces. */
export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2] as const;

export function rateLabel(rate: number): string {
  return `${rate}×`;
}

/** The element takes 0–1 and throws on anything else, and the slider hands us
 * whatever the platform parsed out of its own value. */
export function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}

/** What the seek slider tells a screen reader. A bare percentage is the one
 * thing nobody scrubbing a recording wants to hear. */
export function seekLabel(atCs: number, durationCs: number): string {
  return `${formatTimestamp(atCs)} of ${formatTimestamp(durationCs)}`;
}

/** A mark drawn on the seek track, at a percentage of the whole recording. */
export interface SeekMark {
  key: string;
  kind: "highlight" | "chapter";
  /** 0–100, ready for `left: %`. */
  atPct: number;
  title: string;
}

/**
 * Where the marks sit on the transport's own track.
 *
 * The waveform already draws these, but the waveform is not the transport and
 * is absent while a file has no envelope yet; a transport that owns seeking
 * has to show what is worth seeking TO. Percentages, not pixels, because the
 * track's width is the container's business.
 */
export function seekMarks(
  durationCs: number,
  highlights: readonly RecHighlight[] = [],
  chapters: readonly RecChapter[] = [],
): SeekMark[] {
  if (!(durationCs > 0)) return [];
  const pct = (cs: number) => Math.min(100, Math.max(0, (cs / durationCs) * 100));
  const out: SeekMark[] = [
    ...highlights.map((h) => ({
      key: `h-${h.id}`,
      kind: "highlight" as const,
      atPct: pct(h.t0),
      title: `Highlight ${formatTimestamp(h.t0)}–${formatTimestamp(h.t1)}`,
    })),
    ...chapters.map((c) => ({
      key: `c-${c.id}`,
      kind: "chapter" as const,
      atPct: pct(c.t0),
      title: `Chapter “${c.title}” ${formatTimestamp(c.t0)}`,
    })),
  ];
  return out.sort((a, b) => a.atPct - b.atPct);
}

/* -------------------------------------------------------------- transcript */

/** The shape the search needs of a turn: its key, and each phrase's id and
 * the words actually on screen (deleted ones already applied). Structural on
 * purpose — the view's own `Turn` satisfies it without being mapped, and a
 * test can build one in a line. */
export interface SearchTurn {
  key: string;
  segs: readonly { seg: { id: string }; text: string }[];
}

export interface TranscriptSearch<T> {
  /** The turns to draw. The same array when nothing is being searched for. */
  turns: readonly T[];
  /** Segment ids that matched, for marking them inside a kept turn. */
  hits: Set<string>;
  /** How many phrases matched — the number the count line states. */
  phrases: number;
  searching: boolean;
}

/**
 * Find a phrase in the transcript.
 *
 * QA 2026-08-15 (P1): "the transcript renders as one dense speaker turn" —
 * with no way to find anything in it but the eye. Matching is per PHRASE, not
 * per turn, because a phrase is what the page seeks to and what the reader is
 * looking for; a turn that matches is kept whole so the sentence still has
 * its context around it.
 */
export function searchTranscript<T extends SearchTurn>(
  turns: readonly T[],
  query: string,
): TranscriptSearch<T> {
  const needle = query.trim().toLowerCase();
  if (!needle) return { turns, hits: new Set(), phrases: 0, searching: false };
  const hits = new Set<string>();
  const kept: T[] = [];
  for (const t of turns) {
    let any = false;
    for (const s of t.segs) {
      if (s.text.toLowerCase().includes(needle)) {
        hits.add(s.seg.id);
        any = true;
      }
    }
    if (any) kept.push(t);
  }
  return { turns: kept, hits, phrases: hits.size, searching: true };
}

/**
 * Which phrase the playhead is inside.
 *
 * The segments arrive in time order, so the last one that has already started
 * is the one being spoken. Shared by the timeupdate handler and by "Show in
 * transcript", which must land on exactly the phrase playback would call
 * current — two implementations of "where are we" is how a jump lands one
 * line off.
 */
export function segmentAt(
  segments: readonly { id: string; t0: number }[],
  cs: number,
): string | null {
  let current: string | null = null;
  for (const seg of segments) {
    if (seg.t0 <= cs) current = seg.id;
    else break;
  }
  return current;
}

/* -------------------------------------------------------------- highlights */

/** A phrase as the highlight rows read it: when it was said, and the words
 * that survive the transcript edits. */
export interface Quote {
  t0: number;
  t1: number;
  text: string;
}

export interface HighlightQuote {
  /** A line to name the mark by — the first sentence, cut to a heading. */
  title: string;
  /** The rest of what was said inside the mark; "" when the title is all of
   * it, so the row does not print the same sentence twice. */
  excerpt: string;
}

const TITLE_MAX = 58;
const EXCERPT_MAX = 240;

/** Cut on a word boundary, or the ellipsis lands mid-word — in Hebrew and
 * Chinese as well as English, so the break is on whitespace and nothing
 * cleverer. */
function trimTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * What a highlight actually says.
 *
 * QA 2026-08-15 (P1): a highlight row showed a time range and nothing else,
 * so a list of marks was a list of numbers. The words come from the
 * transcript phrases the mark OVERLAPS and from nowhere else — this function
 * cannot invent a sentence, and it returns null rather than an empty quote
 * when a mark covers a stretch nobody transcribed (silence, music, live
 * transcription switched off), which the row then says in its own words.
 */
export function highlightQuote(
  quotes: readonly Quote[],
  t0: number,
  t1: number,
): HighlightQuote | null {
  const end = Math.max(t0, t1);
  const words = quotes
    .filter((q) => q.t0 < end && Math.max(q.t1, q.t0) > t0)
    .map((q) => q.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!words) return null;
  // The first sentence names the mark; whatever follows is the excerpt under
  // it. A mark on one short sentence gets a title and no excerpt at all.
  const stop = words.search(/[.!?…](\s|$)/);
  const head = stop > 0 ? words.slice(0, stop + 1) : words;
  const title = trimTo(head, TITLE_MAX);
  // A first sentence too long to be a heading is cut for the title, so the
  // excerpt carries the WHOLE quote — otherwise the cut words exist nowhere
  // on screen and the row is quietly lossy.
  const excerpt =
    head.length > TITLE_MAX
      ? trimTo(words, EXCERPT_MAX)
      : trimTo(words.slice(head.length).trim(), EXCERPT_MAX);
  return { title, excerpt };
}
