export function fileNameOf(path: string): string {
  return path.split("/").pop() ?? path;
}

/** What the save sheet should suggest for a duplicate of `roomName` — the base
 * name only, no extension.
 *
 * The sheet used to offer "Copy of room" for every room, so duplicating two
 * different rooms produced two files with the same generic name while the app
 * had known both real names the whole time. `/` and `:` are stripped because
 * macOS shows a `/` in a file name as `:` and vice versa, and a room called
 * "Q3/Q4 plan" would otherwise suggest a name Finder renders as a different
 * one. A room with no usable name at all falls back to the old wording rather
 * than suggesting an empty file name. */
export function duplicateFileName(roomName: string): string {
  const clean = (roomName ?? "")
    .replace(/[/:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? `Copy of ${clean}` : "Copy of room";
}

/** Save-panel wording for the two room storage formats.
 *
 * A workspace duplicate is a directory containing normal files. Giving that
 * directory an `.arcelle` suffix makes it look like the single encrypted
 * backup format and can make Finder treat it like a document. Legacy rooms
 * still duplicate to one encrypted database file, so only they keep the
 * extension. */
export function duplicateDestinationSuggestion(
  roomName: string,
  kind: "legacy" | "workspace",
): { title: string; defaultPath: string } {
  const name = duplicateFileName(roomName);
  return kind === "workspace"
    ? { title: "Choose destination workspace folder", defaultPath: name }
    : { title: "Save duplicated Arcelle room", defaultPath: `${name}.arcelle` };
}

export type Strength = {
  score: 0 | 1 | 2 | 3;
  label: string;
  level: "weak" | "okay" | "strong";
};

function characterKinds(value: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(value),
  ).length;
}

function strengthPoints(password: string, kinds: number): number {
  let points = 0;
  if (password.length >= 8) points += 1;
  if (password.length >= 12) points += 1;
  if (kinds >= 2) points += 1;
  if (kinds >= 3) points += 1;
  return points;
}

function strengthBand(password: string, points: number): Strength {
  if (password.length < 8 || points <= 1) {
    return { score: 1, label: "Weak", level: "weak" };
  }
  if (points === 2 || points === 3) {
    return { score: 2, label: "Okay", level: "okay" };
  }
  return { score: 3, label: "Strong", level: "strong" };
}

// Simple, library-free estimate: length plus the mix of character kinds
// (lowercase, uppercase, digit, symbol). Empty input scores nothing.
export function passwordStrength(pw: string): Strength {
  if (!pw) return { score: 0, label: "", level: "weak" };
  return strengthBand(pw, strengthPoints(pw, characterKinds(pw)));
}

function counted(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
}

function monthTime(days: number): string {
  const months = Math.round(days / 30);
  if (months < 12) return counted(months, "month");
  return counted(Math.round(months / 12), "year");
}

function dayTime(hours: number): string {
  const days = Math.round(hours / 24);
  if (days < 30) return counted(days, "day");
  return monthTime(days);
}

function hourTime(minutes: number): string {
  const hours = Math.round(minutes / 60);
  if (hours < 24) return counted(hours, "hour");
  return dayTime(hours);
}

function minuteTime(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return hourTime(minutes);
}

// Friendly "Opened 2 hours ago" for the Recent list.
export function relativeTime(ms?: number | null): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  return minuteTime(Math.round(diff / 60000));
}

// The check-off chips shown under the strength meter, so "how much more?" is
// answerable rather than a mystery between Weak and Strong.
export function passwordCriteria(
  pw: string,
): { label: string; met: boolean }[] {
  const kinds = characterKinds(pw);
  return [
    { label: "8+ characters", met: pw.length >= 8 },
    { label: "12+ characters", met: pw.length >= 12 },
    { label: "Mix of letters, numbers or symbols", met: kinds >= 2 },
  ];
}

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
