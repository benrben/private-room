/**
 * `fetch_page`'s pagination-window formatting. Ported from
 * `src-tauri/src/commands/agent.rs`'s `FETCH_PAGE_WINDOW` constant,
 * `fetch_page_window` (~4776-4818) and `fetch_page_reply` (~4825-4837) — NOT
 * from `web.rs`/`web/fetch.rs`: these two live in the `exec_tool` arm file
 * itself, immediately below the `"fetch_page"` match arm they format for. They
 * get their own module here (rather than another 40 lines inside the already
 * very large `execTool.ts`) the same way the rest of `agent.rs` has been split
 * across `turnNotices.ts`/`toolRouting.ts`/`gatherContext.ts`.
 */

/**
 * Largest slice of a fetched page handed back in ONE tool result.
 *
 * Matches the private browser's own `READ_MAX` (`browser/page.js`), so the two
 * web-reading tools behave identically — a model that has learned to page
 * through `browse_read` pages through `fetch_page` the same way. Ported from
 * `FETCH_PAGE_WINDOW`.
 */
export const FETCH_PAGE_WINDOW = 40_000;

/**
 * Format a fetched page's readable text starting at char offset `start`,
 * bounded to one window.
 *
 * This USED to return the whole remainder, unbounded, under the rule that "the
 * provider/model is the context authority". Two things made that wrong rather
 * than permissive: the tool's own schema already promised the opposite ("if the
 * result is truncated, call again with the same url and the start value from
 * the truncation notice" — a pagination protocol declared, documented and never
 * implemented), and nothing downstream undid it, so one `fetch_page` of a heavy
 * site went to the provider verbatim and the request was rejected. The
 * authority argument survives intact: the model still decides how much of the
 * page it wants, one window at a time, and nothing is amputated.
 *
 * Iterated by CODE POINT (`Array.from`, matching Rust's `text.chars()`), so a
 * Hebrew (or any multibyte) page is windowed on character boundaries rather
 * than sliced mid-codepoint. Ported from `fetch_page_window`.
 */
export function fetchPageWindow(title: string, url: string, text: string, start: number): string {
  const chars = Array.from(text);
  const total = chars.length;
  const from = Math.min(start, total);
  const end = Math.min(from + FETCH_PAGE_WINDOW, total);
  const header = `[${title}] ${url}\n\n`;
  const body = chars.slice(from, end).join("");
  if (end < total) {
    return (
      `${header}${body}\n\n… ${end} of ${total} characters shown — call fetch_page ` +
      `again with the same url and start ${end} for the rest.`
    );
  }
  return `${header}${body}`;
}

/**
 * D2 (2026-08-04): {@link fetchPageWindow} plus a redirect note, so a fetch
 * that landed somewhere other than the requested URL isn't invisible.
 * `redirectedTo` is `null` for a cache hit (no live redirect info) or a fetch
 * that landed exactly where it was pointed — the common case gets no extra line
 * at all. Ported from `fetch_page_reply`.
 */
export function fetchPageReply(
  title: string,
  url: string,
  text: string,
  start: number,
  redirectedTo: string | null
): string {
  const windowed = fetchPageWindow(title, url, text, start);
  return redirectedTo !== null ? `(Redirected to ${redirectedTo})\n${windowed}` : windowed;
}
