(function () {
  "use strict";
  if (window.__arcelleBrowse) return;
  var scope = window.__arcellePageScope;
  if (!scope) return;
  var READ_MAX = scope.READ_MAX;
  var clean = scope.clean;
  var isVisible = scope.isVisible;


  // ------------------------------------------------------------------- read

  var DROP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SVG: 1, IFRAME: 1, CANVAS: 1,
    TEMPLATE: 1, HEAD: 1, LINK: 1, META: 1,
  };

  var CHROME_TAGS = { NAV: 1, HEADER: 1, FOOTER: 1, ASIDE: 1, FORM: 1 };


  function preferredReadRoot() {
    var main = document.querySelector("main, [role='main'], article");
    if (main && clean(main.textContent).length > 200) return main;
    return null;
  }


  function hasReadParagraphs(block) {
    return block.querySelectorAll("p").length >= 3;
  }


  function longerReadBlock(best, block) {
    var length = clean(block.textContent).length;
    if (length > best.length) {
      best.root = block;
      best.length = length;
    }
  }


  function largestReadBlockIn(blocks, best) {
    var limit = Math.min(blocks.length, 400);
    for (var index = 0; index < limit; index++) {
      var block = blocks[index];
      if (hasReadParagraphs(block)) longerReadBlock(best, block);
    }
    return best.root;
  }


  function largestReadBlock() {
    var best = { root: document.body, length: 0 };
    try {
      return largestReadBlockIn(document.querySelectorAll("div, section, article"), best) || document.body;
    } catch (e) {
      return best.root || document.body;
    }
  }


  /** The main-content root, best effort: an explicit <main>/role=main, else
   *  <article>, else the block with the most text. Never throws. */
  function readRoot(mode) {
    if (mode === "full") return document.body;
    return preferredReadRoot() || largestReadBlock();
  }


  function appendMarkdownText(context, node) {
    var text = clean(node.nodeValue);
    if (text) context.out.push(text);
  }


  function isChromeNode(context, node, tag) {
    return !context.full && CHROME_TAGS[tag] && node !== context.root;
  }


  function isReadableNode(node, tag) {
    return tag === "BODY" || isVisible(node, true);
  }


  function hasNodeAttribute(node, name, value) {
    return node.getAttribute && node.getAttribute(name) === value;
  }


  function isArcelleUiNode(node) {
    return node.getAttribute && node.getAttribute("data-arcelle-ui");
  }


  function skipsMarkdownNode(context, node, tag) {
    if (DROP_TAGS[tag]) return true;
    if (isArcelleUiNode(node)) return true;
    if (isChromeNode(context, node, tag)) return true;
    if (hasNodeAttribute(node, "aria-hidden", "true")) return true;
    return !isReadableNode(node, tag);
  }


  function renderHeading(context, node, tag) {
    var text = clean(node.textContent);
    if (text) context.out.push("\n" + "#".repeat(Number(tag[1])) + " " + text + "\n");
  }


  function renderParagraph(context, node, tag) {
    var text = clean(node.textContent);
    if (text) context.out.push("\n" + (tag === "BLOCKQUOTE" ? "> " : "") + text + "\n");
  }


  function renderListItem(context, node) {
    var text = clean(node.textContent);
    if (text) context.out.push("\n- " + text);
  }


  function renderPre(context, node) {
    var code = node.textContent || "";
    if (clean(code)) context.out.push("\n```\n" + code.replace(/\s+$/, "") + "\n```\n");
  }


  function resolvedHref(href) {
    try {
      return href ? new URL(href, location.href).href : "";
    } catch (e) {
      return href;
    }
  }


  function renderLink(context, node) {
    var text = clean(node.textContent);
    if (!text) return;
    var href = node.getAttribute("href") || "";
    var absolute = resolvedHref(href);
    context.out.push(
      absolute && absolute.indexOf("javascript:") !== 0 ? "[" + text + "](" + absolute + ")" : text,
    );
  }


  function walkChildren(context, node, depth) {
    var children = node.childNodes;
    for (var i = 0; i < children.length; i++) walk(context, children[i], depth + 1);
  }


  function renderTable(context, node, depth) {
    var outerRow = context.tableRow;
    context.tableRow = 0;
    walkChildren(context, node, depth);
    context.tableRow = outerRow;
    context.out.push("\n");
  }


  function renderTableRow(context, node) {
    var cells = [];
    var tds = node.children || [];
    for (var index = 0; index < tds.length; index++) cells.push(clean(tds[index].textContent));
    if (cells.length === 0) return;
    context.out.push("\n| " + cells.join(" | ") + " |");
    if (context.tableRow === 0) context.out.push("\n|" + " --- |".repeat(cells.length));
    context.tableRow++;
  }


  function renderImage(context, node) {
    var alt = clean(node.getAttribute("alt"));
    if (alt) context.out.push("![" + alt + "]");
  }


  var MARKDOWN_RENDERERS = {
    P: renderParagraph,
    BLOCKQUOTE: renderParagraph,
    LI: renderListItem,
    PRE: renderPre,
    A: renderLink,
    BR: function (context) { context.out.push("\n"); },
    TABLE: renderTable,
    TR: renderTableRow,
    IMG: renderImage,
  };


  function rendersMarkdownNode(context, node, tag, depth) {
    if (/^H[1-6]$/.test(tag)) {
      renderHeading(context, node, tag);
      return true;
    }
    var render = MARKDOWN_RENDERERS[tag];
    if (!render) return false;
    render(context, node, tag, depth);
    return true;
  }


  function endsMarkdownBlock(context, tag) {
    if (tag === "DIV" || tag === "SECTION" || tag === "UL" || tag === "OL") context.out.push("\n");
  }


  function stopsWalk(node, depth) {
    return !node || depth > 40;
  }


  function walkElement(context, node, depth) {
    var tag = node.tagName;
    if (skipsMarkdownNode(context, node, tag)) return;
    if (rendersMarkdownNode(context, node, tag, depth)) return;
    walkChildren(context, node, depth);
    endsMarkdownBlock(context, tag);
  }


  function walk(context, node, depth) {
    if (stopsWalk(node, depth)) return;
    if (node.nodeType === 3) {
      appendMarkdownText(context, node);
      return;
    }
    if (node.nodeType !== 1) return;
    walkElement(context, node, depth);
  }


  function markdownContext(root, mode) {
    return { root: root, out: [], full: mode === "full", tableRow: 0 };
  }


  function markdownText(context) {
    return context.out
      .join(" ")
      .replace(/[ \t]+/g, " ")
      // Fragments are joined with a space, so every line that a pushed "\n"
      // starts inherits a trailing space from the fragment before it. Two of
      // those in a row is a Markdown hard line break, and one on a table's
      // header row is enough to make some readers miss the delimiter.
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n\s*\n\s*\n+/g, "\n\n")
      .trim();
  }


  function readMarkdown(mode) {
    var root = readRoot(mode);
    if (!root) return "";
    var context = markdownContext(root, mode);
    try {
      walk(context, root, 0);
    } catch (e) {
      return clean(root.textContent || "");
    }
    return markdownText(context);
  }


  function isHighSurrogate(c) {
    return c >= 0xd800 && c <= 0xdbff;
  }

  function isLowSurrogate(c) {
    return c >= 0xdc00 && c <= 0xdfff;
  }


  function readMode(args) {
    return args.mode === "full" ? "full" : "main";
  }


  function readStart(body, offset) {
    // Never cut through a surrogate pair: half an emoji decodes to a
    // replacement character, and if the cut lands there the whole chunk can
    // come back as garbage.
    var start = Math.min(offset, body.length);
    if (start > 0 && start < body.length && isLowSurrogate(body.charCodeAt(start))) start--;
    return start;
  }


  function readEnd(body, start) {
    var end = Math.min(body.length, start + READ_MAX);
    if (end < body.length && end - 1 > start && isHighSurrogate(body.charCodeAt(end - 1))) end--;
    return end;
  }


  function readResult(mode, body, start, end) {
    var slice = body.slice(start, end);
    return {
      ok: true,
      url: location.href,
      title: document.title || "",
      mode: mode,
      offset: start,
      // Where the NEXT read must start, counted in the same units this sliced
      // with. The Rust side used to work it out by counting CHARACTERS in the
      // returned text, which is a different count from JavaScript's UTF-16
      // code units the moment an emoji is involved — so the continuation mark
      // came back short and the next chunk repeated text already read.
      nextOffset: start + slice.length,
      total: body.length,
      truncated: start + slice.length < body.length,
      text: slice,
    };
  }


  function read(args) {
    args = args || {};
    var mode = readMode(args);
    var body = readMarkdown(mode);
    var offset = Math.max(0, Number(args.offset) || 0);
    var start = readStart(body, offset);
    return readResult(mode, body, start, readEnd(body, start));
  }


  // ---------------------------------------------------------------- capture

  // Caps for saving a page into the room (BROWSE-2). Far larger than READ_MAX:
  // this feeds a room FILE, not a model turn — but still bounded, because a
  // runaway SPA DOM can be arbitrarily huge.
  var CAPTURE_TEXT_MAX = 800000;

  var CAPTURE_HTML_MAX = 4000000;


  /** The page — or the user's current selection — as save-ready content:
   *  readable markdown plus the raw HTML of the LIVE DOM. Unlike a re-fetch,
   *  this is what is actually on screen: scripts run, logins honoured. */
  /** A non-empty selection, by `capture`'s own definition of one.
   *
   * Whitespace-only does not count: `capture` trims and then refuses, so a
   * scope offered on the untrimmed answer would be offered for a selection
   * that the very next call reports as nothing selected. */
  function hasSelection() {
    try {
      return String(window.getSelection() || "").trim().length > 0;
    } catch (e) {
      return false;
    }
  }


  function selectionText() {
    var selection = "";
    try {
      selection = String(window.getSelection() || "");
    } catch (e) {}
    return selection.trim();
  }


  function selectionCapture(what) {
    var selection = selectionText();
    if (!selection) return { ok: false, error: "Nothing is selected on the page." };
    return {
      ok: true,
      what: what,
      url: location.href,
      title: document.title || "",
      text: selection.slice(0, CAPTURE_TEXT_MAX),
      html: "",
      truncated: selection.length > CAPTURE_TEXT_MAX,
      // The WHOLE selection's length, so a caller that shows a clipped
      // passage can say how much it is not showing. Without it the only
      // honest thing to print is "some of this is missing", and the only
      // dishonest one is a number nobody measured.
      total: selection.length,
    };
  }


  function pageHtml() {
    try {
      var root = document.documentElement;
      if (root) return "<!doctype html>\n" + root.outerHTML;
      if (!root) return "";
    } catch (e) {
      return "";
    }
  }


  function pageCapture(what) {
    var text = readMarkdown("main");
    var html = pageHtml();
    return {
      ok: true,
      what: what,
      url: location.href,
      title: document.title || "",
      text: text.slice(0, CAPTURE_TEXT_MAX),
      html: html.slice(0, CAPTURE_HTML_MAX),
      truncated: text.length > CAPTURE_TEXT_MAX || html.length > CAPTURE_HTML_MAX,
    };
  }


  function capture(args) {
    var what = args && args.what === "selection" ? "selection" : "page";
    return what === "selection" ? selectionCapture(what) : pageCapture(what);
  }
  Object.assign(scope, { DROP_TAGS: DROP_TAGS, CHROME_TAGS: CHROME_TAGS, preferredReadRoot: preferredReadRoot, hasReadParagraphs: hasReadParagraphs, longerReadBlock: longerReadBlock, largestReadBlockIn: largestReadBlockIn, largestReadBlock: largestReadBlock, readRoot: readRoot, appendMarkdownText: appendMarkdownText, isChromeNode: isChromeNode, isReadableNode: isReadableNode, hasNodeAttribute: hasNodeAttribute, isArcelleUiNode: isArcelleUiNode, skipsMarkdownNode: skipsMarkdownNode, renderHeading: renderHeading, renderParagraph: renderParagraph, renderListItem: renderListItem, renderPre: renderPre, resolvedHref: resolvedHref, renderLink: renderLink, walkChildren: walkChildren, renderTable: renderTable, renderTableRow: renderTableRow, renderImage: renderImage, MARKDOWN_RENDERERS: MARKDOWN_RENDERERS, rendersMarkdownNode: rendersMarkdownNode, endsMarkdownBlock: endsMarkdownBlock, stopsWalk: stopsWalk, walkElement: walkElement, walk: walk, markdownContext: markdownContext, markdownText: markdownText, readMarkdown: readMarkdown, isHighSurrogate: isHighSurrogate, isLowSurrogate: isLowSurrogate, readMode: readMode, readStart: readStart, readEnd: readEnd, readResult: readResult, read: read, CAPTURE_TEXT_MAX: CAPTURE_TEXT_MAX, CAPTURE_HTML_MAX: CAPTURE_HTML_MAX, hasSelection: hasSelection, selectionText: selectionText, selectionCapture: selectionCapture, pageHtml: pageHtml, pageCapture: pageCapture, capture: capture });
})();
