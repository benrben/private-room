import { checkPublicHttpUrl } from "./guard.js";

/** Return the single normalized key used for page-cache reads and writes. */
export function cacheKey(url: string): string {
  try {
    return checkPublicHttpUrl(url).toString();
  } catch {
    return url;
  }
}

/** Clip text to a code-point budget, preferring a whitespace boundary. */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const clipped = chars.slice(0, max);
  const half = Math.floor(max / 2);
  for (let index = clipped.length - 1; index > half; index -= 1) {
    if (/\s/.test(clipped[index] ?? "")) return clipped.slice(0, index).join("");
  }
  return clipped.join("");
}

/** Remove model reasoning spans, truncating an unterminated span. */
export function stripThinkSpans(raw: string): string {
  let output = raw;
  for (;;) {
    const start = output.indexOf("<think>");
    if (start === -1) break;
    const closeAt = output.indexOf("</think>", start);
    if (closeAt === -1) {
      output = output.slice(0, start);
      break;
    }
    output = output.slice(0, start) + output.slice(closeAt + "</think>".length);
  }
  return output;
}
