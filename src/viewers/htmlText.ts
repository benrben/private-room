/**
 * A document's words, with its markup taken off.
 *
 * Lived inside HtmlView while the page reader was its only caller. It has three
 * now — the page reader's Text mode, the book reader's, and the check that a
 * selection reported by a sandboxed frame actually occurs in the document it
 * claims to come from — and all three want the same thing: the file's own text,
 * in the file's own order, derived by nothing.
 */

/** Contents that are code, not words. A stylesheet shown as the page's text
 * would read as something the page said. */
const TEXT_SKIP = new Set(["script", "style", "noscript", "template"]);

/** Elements that start their own line. Without these the whole page arrives
 * as one paragraph with words fused across every tag boundary. */
const TEXT_BLOCK = new Set([
  "address", "article", "aside", "blockquote", "dd", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
  "section", "table", "tr", "ul",
]);

/**
 * `DOMParser` builds an INERT document: it has no browsing context, so nothing
 * in it executes and nothing in it fetches — the same primitive every HTML
 * sanitiser is built on, and the reason this does not weaken the sandbox one
 * bit. Nothing is ever assigned to `innerHTML`; the only things read back out
 * are text nodes.
 *
 * Nothing is summarised, filtered by "importance", or reordered: what comes
 * out is the document's own text in the document's own order. Runs of
 * whitespace collapse the way a browser collapses them when it lays the page
 * out — EXCEPT inside `<pre>`, where the author's spacing IS the content and
 * is passed through untouched.
 */
export function textOf(html: string): string {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return "";
  }

  const out: string[] = [];
  /** One blank line between blocks, never a stack of them. */
  const newline = () => {
    let run = 0;
    for (let i = out.length - 1; i >= 0 && out[i] === "\n"; i--) run++;
    if (run < 2) out.push("\n");
  };

  const walk = (node: Node, inPre: boolean): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.nodeValue ?? "";
      if (inPre) {
        out.push(raw);
        return;
      }
      const collapsed = raw.replace(/\s+/g, " ");
      // A lone space straight after a line break is layout, not text.
      if (collapsed === " " && (out.length === 0 || out[out.length - 1] === "\n")) return;
      if (collapsed) out.push(collapsed);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).tagName.toLowerCase();
    if (TEXT_SKIP.has(tag)) return;
    if (tag === "br") {
      out.push("\n");
      return;
    }
    const block = TEXT_BLOCK.has(tag);
    if (block) newline();
    const pre = inPre || tag === "pre";
    for (const child of Array.from(node.childNodes)) walk(child, pre);
    if (block) newline();
  };

  walk(doc.body ?? doc.documentElement, false);
  return out.join("").trim();
}
