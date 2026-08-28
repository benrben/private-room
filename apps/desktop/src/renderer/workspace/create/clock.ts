/** Minutes and seconds, for a runtime the reader can check against what they
 * asked for. "300s" is a number; "5:00" is an episode.
 *
 * Its own module so both the shot list and the review sheet can use it without
 * importing each other — the sheet is opened BY the list, so a shared helper
 * living in either one would be a cycle. */
export function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
