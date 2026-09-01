/** Numeric and Unicode primitives used by deterministic shot splitting. */

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** Match Rust's saturating, truncating float-to-unsigned-integer cast. */
export function asWholeNonNegative(n: number): number {
  return Number.isNaN(n) ? 0 : Math.max(0, Math.trunc(n));
}

export function divCeil(a: number, b: number): number {
  return Math.floor((a + b - 1) / b);
}

export function charCount(value: string): number {
  return Array.from(value).length;
}

export function isWhitespaceChar(char: string): boolean {
  return /\s/u.test(char);
}

export function isAsciiDigit(char: string): boolean {
  return char.length === 1 && char >= "0" && char <= "9";
}

/** Apply ASCII-only uppercase conversion, preserving all other characters. */
export function toAsciiUppercase(value: string): string {
  return Array.from(value)
    .map((char) => {
      const code = char.codePointAt(0)!;
      return code >= 97 && code <= 122 ? String.fromCharCode(code - 32) : char;
    })
    .join("");
}

export function trimMatches(value: string, predicate: (char: string) => boolean): string {
  const chars = Array.from(value);
  let start = 0;
  let end = chars.length;
  while (start < end && predicate(chars[start]!)) start += 1;
  while (end > start && predicate(chars[end - 1]!)) end -= 1;
  return chars.slice(start, end).join("");
}

export function trimStartMatches(value: string, predicate: (char: string) => boolean): string {
  const chars = Array.from(value);
  let start = 0;
  while (start < chars.length && predicate(chars[start]!)) start += 1;
  return chars.slice(start).join("");
}

export function trimEndMatches(value: string, predicate: (char: string) => boolean): string {
  const chars = Array.from(value);
  let end = chars.length;
  while (end > 0 && predicate(chars[end - 1]!)) end -= 1;
  return chars.slice(0, end).join("");
}

/** Match Rust `str::lines`: no terminal empty line and strip each trailing CR. */
export function rustLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (text.endsWith("\n")) parts.pop();
  return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** Return the last index among equal maximum values. */
export function argmaxLastTie(values: readonly number[]): number {
  let bestIndex = 0;
  let bestValue = -Infinity;
  for (let index = 0; index < values.length; index += 1) {
    if (values[index]! >= bestValue) {
      bestValue = values[index]!;
      bestIndex = index;
    }
  }
  return bestIndex;
}
