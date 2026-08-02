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
