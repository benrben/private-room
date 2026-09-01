/** Pure sentence-boundary helpers for the streaming voice queue. */
export const FORCE_FLUSH_CHARS = 300;

export function stripForSpeech(text: string): string {
  return text
    .replace(/```[a-zA-Z0-9_-]*\n?[\s\S]*?```/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/[*_~|#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitOpenFence(work: string): { work: string; held: string } {
  const fenceIndex = work.indexOf("```");
  if (fenceIndex < 0) return { work, held: "" };
  return { work: work.slice(0, fenceIndex), held: work.slice(fenceIndex) };
}

export function emitCompleteSentences(work: string, emit: (sentence: string) => void): string {
  const sentences = /[.!?…。！？]+[\s"')\]」』）】》〉”’]*/g;
  let cut = 0;
  let match: RegExpExecArray | null;
  while ((match = sentences.exec(work))) {
    const end = match.index + match[0].length;
    if (isInternalPeriod(match[0], work[end] ?? "")) continue;
    emit(work.slice(cut, end));
    cut = end;
  }
  return work.slice(cut);
}

function isInternalPeriod(punctuation: string, after: string): boolean {
  return punctuation === "." && after !== "" && !/\p{Lu}/u.test(after);
}

export function flushLongRemainder(rest: string, carryLength: number, emit: (sentence: string) => void): string {
  while (rest.length + carryLength > FORCE_FLUSH_CHARS) {
    const cutAt = breakPoint(rest.slice(0, FORCE_FLUSH_CHARS));
    if (cutAt <= 0) break;
    emit(rest.slice(0, cutAt));
    rest = rest.slice(cutAt);
  }
  return rest;
}

const SOFT_BREAKS = ",;: 、，；：";

/** Where to cut a chunk that has outgrown FORCE_FLUSH_CHARS: just past the
 * last break character in `window`, or the end of the window itself when it
 * holds none. Non-zero for any non-empty window, so callers can loop on it. */
export function breakPoint(window: string): number {
  let at = -1;
  for (const ch of SOFT_BREAKS) at = Math.max(at, window.lastIndexOf(ch));
  return at > 0 ? at + 1 : window.length;
}
