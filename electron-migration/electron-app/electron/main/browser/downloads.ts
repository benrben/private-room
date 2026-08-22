// BROWSE-1: the pure download decisions.
//
// Port of `download_over_limit` (src-tauri/src/browser.rs) and
// `safe_file_name`/`MAX_DOWNLOAD_BYTES` (src-tauri/src/web/fetch.rs) — the two
// checks downloadGating.ts's `will-download` wiring calls into.
//
// NOT PORTED: the `downloads: Map<url, StagedDownload>` de-duplication behind
// Rust's `stage_download`. That map exists only because Tauri's
// `DownloadEvent::Finished` carries nothing but the URL on macOS, so the staged
// path has to be looked back up by that key — and two downloads of the same
// address collide under it (the bug
// `a_second_download_of_the_same_address_cannot_displace_the_first` pins: the
// first to finish imported the SECOND one's still-being-written file). Electron
// hands `will-download` a live `DownloadItem`, and every listener stays
// attached to THAT object; two concurrent downloads of one address are two
// objects with two closures and no shared key. The bug class cannot occur here,
// so the map is dropped rather than carried forward — which also drops the
// user-visible "Already downloading X — the duplicate was ignored" refusal,
// deliberately: on this side both downloads can simply succeed.

/**
 * D15: hard per-file cap for anything downloaded into the room. A room file is
 * one SQLite blob with a hard ceiling near 953 MB (SQLite's 10^9-byte blob
 * limit) — refuse before storage does. The SAME number the eventual import
 * funnel applies, deliberately: the point of the early warning is to say what
 * that funnel will decide at the end, and a second number here would warn about
 * the wrong thing.
 */
export const MAX_DOWNLOAD_BYTES = 900 * 1024 * 1024;

/**
 * Is this staged download already too big to ever become a room file? Port of
 * `download_over_limit` — strictly greater than the cap, so a file exactly at
 * the ceiling is not warned about.
 */
export function downloadOverLimit(bytes: number, cap: number = MAX_DOWNLOAD_BYTES): boolean {
  return bytes > cap;
}

/**
 * Keep a network-supplied filename honest: alphanumerics plus `. - _`, at most
 * 80 characters, never empty. Port of `safe_file_name`.
 *
 * Rust's `char::is_alphanumeric()` is Unicode-aware (any letter or number
 * category), so `\p{L}`/`\p{N}` is the closest match here. Iterated by CODE
 * POINT (like Rust's `.chars()`, not UTF-16 code units) so "80 characters"
 * means the same thing on both sides even for astral-plane input. Callers
 * always prefix a UUID before using the result as a path component, so
 * traversal sequences die here AND cannot escape there.
 */
export function safeFileName(name: string): string {
  const cleaned = Array.from(name)
    .slice(0, 80)
    .map((ch) => (/[\p{L}\p{N}._-]/u.test(ch) ? ch : "_"))
    .join("");
  // Rust's `trim_matches(['.', '_'])` trims BOTH ends repeatedly; a name that is
  // only dots and underscores once cleaned carries no information at all.
  const meaningful = cleaned.replace(/^[._]+/, "").replace(/[._]+$/, "");
  return meaningful === "" ? "download" : cleaned;
}
