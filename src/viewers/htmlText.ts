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

/**
 * Text that is in the markup but nowhere on the page.
 *
 * The third caller is a check on a CLAIM: a sandboxed frame reports what it
 * says the reader selected, and the app looks for that passage in the document
 * before letting it be quoted. A reader can only select what is rendered, so
 * hidden markup must not answer for them — otherwise a saved page can announce
 * a sentence buried in a `display:none` block and have the room quote it, with
 * the file's name attached, on a selection that never happened.
 *
 * WHAT THIS CANNOT SEE: the document is inert — no browsing context, no layout,
 * no style resolution — so only what is written on the element itself is
 * readable. A rule in a `<style>` block, an off-screen position or white ink on
 * white paper are all invisible to this, and the gesture check that would close
 * those lives on the message path, not here.
 */
export function isHiddenMarkup(el: Element): boolean {
  if (el.hasAttribute("hidden")) return true;
  const style = (el.getAttribute("style") ?? "").toLowerCase().replace(/\s+/g, "");
  return (
    style.includes("display:none") ||
    style.includes("visibility:hidden") ||
    style.includes("visibility:collapse")
  );
}

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
 * out is the document's own text in the document's own order — minus what the
 * document itself hid, which is not text a reader could ever see or select.
 * Runs of
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
    if (isHiddenMarkup(node as Element)) return;
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
