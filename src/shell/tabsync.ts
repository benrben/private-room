/** The one decision the browser-page reconciliation gets to make.
 *
 * The tab strip mirrors what Rust actually has open, and it learns about new
 * pages by polling. Adopting a page focuses it — the tab list has a single
 * `open`, and opening focuses — so a page the ASSISTANT opened in the
 * background would yank the reader out of whatever they were reading (or
 * editing). The reconciliation therefore puts focus back afterwards.
 *
 * It must not do that for a page the USER asked for. ⌘T (and the ＋ button)
 * creates the page in Rust and only then turns the returned id into a tab; a
 * poll whose response lands in between sees a page with no tab and would
 * "restore" focus to the tab the user just left, leaving their brand-new page
 * sitting unfocused. Hence `userOpened`.
 *
 * Kept apart from the component so both halves of that race can be pinned in a
 * test — the component itself needs the whole Tauri backend to render.
 */
export function shouldRestoreFocus(
  /** Page ids that just earned a tab in this pass. */
  adopted: readonly string[],
  /** Page ids the user opened themselves, tab committed or not. */
  userOpened: ReadonlySet<string>,
  /** Whether the tab that was showing survived this pass — there is nothing to
   * restore focus to once it has been pruned. */
  showingLives: boolean,
): boolean {
  if (!showingLives) return false;
  return adopted.some((id) => !userOpened.has(id));
}

/** AUDIT 238: which page the strip must re-assert to Rust, or "" when the two
 * already agree.
 *
 * Every tab Rust reports says whether it is the one being SHOWN, and the strip
 * used to keep only the id and the title. They agree while the strip is what
 * changes pages — but a page that goes away on its own hands the screen to
 * Rust's heir rule, and the strip carries on highlighting the tab the user
 * chose. That disagreement is invisible: the highlighted tab looks selected,
 * and clicking it does nothing, because `browser_select_tab` is only called on
 * a real tab CHANGE and Rust already believes the other page is active.
 *
 * The strip is authoritative here on purpose. Rust's heir is a fallback for
 * "the visible page vanished"; the tab the user is looking at is an intent, and
 * re-asserting it is what makes the two agree again without moving the user.
 */
export function pageToReassert(
  /** What Rust reports open, in strip order. */
  live: readonly { id: string; active: boolean }[],
  /** The page id the strip is showing, or null when a file/area tab is up. */
  showingPageId: string | null,
): string {
  if (!showingPageId) return "";
  // A page the strip still points at but Rust no longer has is the pruning
  // path's business, not this one's — asking Rust to show it would fail.
  if (!live.some((p) => p.id === showingPageId)) return "";
  const shownByRust = live.find((p) => p.active)?.id ?? "";
  return shownByRust === showingPageId ? "" : showingPageId;
}
