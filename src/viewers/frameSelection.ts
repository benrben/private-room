/**
 * Getting a selection back out of a sandboxed document frame.
 *
 * A page in the Page tab renders inside a `roomdoc://` frame: an opaque origin
 * with no `allow-same-origin`, so the app cannot read its document, its
 * selection, or anything else about it. That is the whole security posture and
 * it is not up for negotiation — which left the most-read format in the app
 * with no way to quote a sentence from it.
 *
 * The frame already runs the page's own script (`script-src 'unsafe-inline'`),
 * so nothing new is granted by asking it to report its selection: this adds a
 * message, not a permission. What it does add is a channel from untrusted
 * script to the app, so everything arriving on it is treated as a CLAIM —
 * shape-checked here, and checked against the document itself by
 * `verifiedFrameQuote` before a word of it can be quoted.
 *
 * Only the HTML reader injects this. The book and legacy-document readers run
 * their frames at `sandbox=""` with no script at all, and buying a quote button
 * with `allow-scripts` on untrusted book and Word files would be a bad trade —
 * they offer a Text reading in the app's own document instead.
 */

/** Names the message so ordinary page chatter to `parent` is not mistaken for
 * one. Not a security boundary — the sender's identity and the text itself are
 * what get checked — just a filter. */
const MARK = "arcelle:frame-selection";

/** Far above any sane selection and far below anything that could hurt us: a
 * hostile page cannot make the app hold a hundred megabytes by selecting. The
 * quote itself is cut to MAX_QUOTE_CHARS later. */
const MAX_REPORT_CHARS = 8000;

export interface FrameSelection {
  text: string;
  /** Viewport-relative WITHIN THE FRAME; the host adds the frame's own offset.
   * Null when the selection has no box to point at. */
  rect: { top: number; left: number; width: number } | null;
}

/**
 * The reporter, as a `<script>` the staged document carries.
 *
 * Deliberately tiny and total: every read is wrapped, because this runs inside
 * someone else's document and a page that has replaced `document.getSelection`
 * must not be able to break its own rendering through us.
 */
const REPORTER = `<script>(function(){try{
var send=function(){try{
var s=document.getSelection();var t=s?String(s):"";var r=null;
if(t&&s.rangeCount){var b=s.getRangeAt(0).getBoundingClientRect();
if(b.width||b.height){r={top:b.top,left:b.left,width:b.width};}}
parent.postMessage({mark:${JSON.stringify(MARK)},text:t.slice(0,${MAX_REPORT_CHARS}),rect:r},"*");
}catch(e){}};
document.addEventListener("selectionchange",send);
}catch(e){}})();</script>`;

/** Add the reporter to a document on its way to being staged. Appended, so it
 * runs after the page's own markup exists and never displaces anything. */
export function withSelectionReporter(html: string): string {
  return html + REPORTER;
}

/**
 * A selection report, if this message is one.
 *
 * Everything here arrives from a document the app does not trust, so nothing is
 * assumed: not the shape, not the types, not that the numbers are finite. The
 * caller still has to establish WHO sent it and whether the text is really in
 * the document — this only says the message is the right shape.
 */
export function frameSelectionOf(data: unknown): FrameSelection | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.mark !== MARK) return null;
  if (typeof m.text !== "string") return null;
  const text = m.text.slice(0, MAX_REPORT_CHARS);

  let rect: FrameSelection["rect"] = null;
  const r = m.rect;
  if (typeof r === "object" && r !== null) {
    const { top, left, width } = r as Record<string, unknown>;
    if (
      typeof top === "number" && Number.isFinite(top) &&
      typeof left === "number" && Number.isFinite(left) &&
      typeof width === "number" && Number.isFinite(width)
    ) {
      rect = { top, left, width };
    }
  }
  return { text, rect };
}
