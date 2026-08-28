import {
  bytesToText,
  findEntry,
  mimeForPath,
  resolvePath,
  toDataUrl,
  withoutFragment,
} from "./zipdoc";

export interface Chapter {
  /** Path of the XHTML part inside the archive. */
  path: string;
  /** Title from the table of contents, when the book has one. */
  title: string;
}

export interface Book {
  title: string;
  author: string;
  chapters: Chapter[];
  /** Cover image as a data URL, when the book declares one. */
  cover: string | null;
}

function parseXml(text: string): Document | null {
  try {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    return doc.querySelector("parsererror") ? null : doc;
  } catch {
    return null;
  }
}

function descendants(root: Element | Document, local: string): Element[] {
  return Array.from(root.getElementsByTagName("*")).filter((e) => e.localName === local);
}
function attr(el: Element, local: string): string | null {
  for (const a of Array.from(el.attributes)) if (a.localName === local) return a.value;
  return null;
}

/** An href in an OPF, an NCX or a chapter is a URI reference, so a zip entry
 * named `Text/Chapter 1.xhtml` is written `Text/Chapter%201.xhtml` — required
 * for any space or non-ASCII character. The entry names are the decoded text,
 * so a book whose publisher escaped its hrefs loses its whole spine unless the
 * escapes come off here.
 *
 * The escapes come off LAST, once the reference has been resolved, because
 * every separator `resolvePath` reads is a URI separator: a chapter named
 * `Notes: one.xhtml` is written `Notes%3A%20one.xhtml`, and decoding that
 * first hands `resolvePath` something starting `Notes:`, which it correctly
 * reads as an absolute URL and returns unresolved — the book's folder is
 * dropped and the chapter is lost. For the same reason an encoded `%2E%2E`
 * stays one path segment instead of climbing out of the archive.
 *
 * The fragment goes first of all, so an encoded `%23` in a filename cannot
 * turn into a fragment separator. A malformed escape is kept as written rather
 * than throwing: a stray `%` in a filename is not a reason for the book to
 * fail to open. */
export function hrefToPath(base: string, href: string): string {
  const path = resolvePath(base, withoutFragment(href));
  try {
    return decodeURIComponent(path);
  } catch {
    // Not a valid escape sequence — the literal text is the only name we have.
    return path;
  }
}

/** The OPF package path, from `META-INF/container.xml`. Falls back to any
 * `.opf` in the archive, which is what a slightly-malformed book has. */
export function opfPath(files: Record<string, Uint8Array>): string | null {
  const container = parseXml(bytesToText(findEntry(files, "META-INF/container.xml")));
  const root = container ? descendants(container, "rootfile")[0] : null;
  const declared = root ? attr(root, "full-path") : null;
  if (declared && findEntry(files, declared)) return declared;
  return Object.keys(files).find((n) => n.toLowerCase().endsWith(".opf")) ?? null;
}

/** Titles keyed by chapter path, from the EPUB 3 nav document or the EPUB 2
 * NCX. Both are read because real libraries contain both. */
function tocTitles(
  files: Record<string, Uint8Array>,
  navPath: string | null,
  ncxPath: string | null,
): Map<string, string> {
  const out = new Map<string, string>();
  if (navPath) {
    const doc = parseXml(bytesToText(findEntry(files, navPath)));
    // The nav with `epub:type="toc"`, or the first one when nothing is typed.
    const navs = doc ? descendants(doc, "nav") : [];
    const toc = navs.find((n) => (attr(n, "type") ?? "").includes("toc")) ?? navs[0];
    for (const a of toc ? descendants(toc, "a") : []) {
      const href = attr(a, "href");
      const label = (a.textContent ?? "").trim();
      if (href && label) out.set(hrefToPath(navPath, href), label);
    }
  }
  if (ncxPath) {
    const doc = parseXml(bytesToText(findEntry(files, ncxPath)));
    for (const point of doc ? descendants(doc, "navPoint") : []) {
      const content = descendants(point, "content")[0];
      const href = content ? attr(content, "src") : null;
      const label = descendants(point, "text")[0]?.textContent?.trim() ?? "";
      if (href && label) {
        const path = hrefToPath(ncxPath, href);
        if (!out.has(path)) out.set(path, label);
      }
    }
  }
  return out;
}

/** Read the book's structure: reading order, chapter titles and metadata.
 *
 * Reading order comes from the OPF SPINE, which is the book's own answer and
 * routinely differs from alphabetical filename order — `chapter10.xhtml`
 * sorts before `chapter2.xhtml` and a reader that trusted names would put the
 * chapters in the wrong sequence.
 */
export function parseEpub(files: Record<string, Uint8Array>): Book | null {
  const opf = opfPath(files);
  if (!opf) return null;
  const doc = parseXml(bytesToText(findEntry(files, opf)));
  if (!doc) return null;

  const title = descendants(doc, "title")[0]?.textContent?.trim() ?? "";
  const author = descendants(doc, "creator")[0]?.textContent?.trim() ?? "";

  // manifest: id → { href, mediaType, properties }
  const manifest = new Map<string, { path: string; type: string; props: string }>();
  for (const item of descendants(doc, "item")) {
    const id = attr(item, "id");
    const href = attr(item, "href");
    if (!id || !href) continue;
    manifest.set(id, {
      path: hrefToPath(opf, href),
      type: attr(item, "media-type") ?? "",
      props: attr(item, "properties") ?? "",
    });
  }

  const navEntry = Array.from(manifest.values()).find((m) => m.props.includes("nav"));
  const ncxEntry = Array.from(manifest.values()).find((m) => m.type.includes("dtbncx"));
  const titles = tocTitles(files, navEntry?.path ?? null, ncxEntry?.path ?? null);

  const chapters: Chapter[] = [];
  for (const ref of descendants(doc, "itemref")) {
    const idref = attr(ref, "idref");
    const entry = idref ? manifest.get(idref) : undefined;
    if (!entry || !findEntry(files, entry.path)) continue;
    // The nav document is part of the spine in some books; it is a table of
    // contents, not a chapter.
    if (entry.props.includes("nav")) continue;
    chapters.push({
      path: entry.path,
      title: titles.get(entry.path) ?? `Section ${chapters.length + 1}`,
    });
  }
  // A book with no usable spine still opens — every XHTML part, in name order.
  if (chapters.length === 0) {
    for (const path of Object.keys(files).sort()) {
      if (/\.x?html?$/i.test(path) && !path.startsWith("META-INF/")) {
        chapters.push({ path, title: titles.get(path) ?? `Section ${chapters.length + 1}` });
      }
    }
  }

  const coverEntry =
    Array.from(manifest.values()).find((m) => m.props.includes("cover-image")) ??
    Array.from(manifest.values()).find(
      (m) => m.type.startsWith("image/") && /cover/i.test(m.path),
    );
  const coverBytes = coverEntry ? findEntry(files, coverEntry.path) : undefined;

  return {
    title,
    author,
    chapters,
    cover: coverBytes ? toDataUrl(coverBytes, mimeForPath(coverEntry!.path)) : null,
  };
}

/**
 * One chapter as a self-contained HTML document.
 *
 * Every asset it references — images, stylesheets, fonts — is inlined as a
 * data URL, because the document is served from the app's `roomdoc://`
 * sandbox whose CSP is `default-src 'none'`. That sandbox is the reason this
 * is safe to render at all: the chapter's own markup and styling display
 * exactly as the publisher wrote them, while script, network access and any
 * reach into the app or the room are blocked at the origin.
 */
export function chapterHtml(
  files: Record<string, Uint8Array>,
  path: string,
  fontScale = 1,
  dark = false,
): string {
  const doc = parseXml(bytesToText(findEntry(files, path)));
  if (!doc) {
    // An unparseable chapter still shows its words rather than nothing.
    return wrap(escapeBody(bytesToText(findEntry(files, path))), fontScale, dark);
  }

  // Inline images.
  for (const img of Array.from(doc.getElementsByTagName("*"))) {
    if (img.localName !== "img" && img.localName !== "image") continue;
    const srcAttr = img.localName === "image" ? "href" : "src";
    const raw = attr(img, srcAttr);
    if (!raw || raw.startsWith("data:")) continue;
    const assetPath = hrefToPath(path, raw);
    const asset = findEntry(files, assetPath);
    if (asset) {
      img.setAttribute(srcAttr, toDataUrl(asset, mimeForPath(assetPath)));
    } else {
      img.removeAttribute(srcAttr);
    }
  }

  // Inline stylesheets, so the publisher's typography survives the sandbox.
  const styles: string[] = [];
  for (const link of descendants(doc, "link")) {
    const rel = (attr(link, "rel") ?? "").toLowerCase();
    const href = attr(link, "href");
    if (!rel.includes("stylesheet") || !href) continue;
    const cssPath = hrefToPath(path, href);
    const css = findEntry(files, cssPath);
    if (css) styles.push(inlineCssAssets(files, cssPath, bytesToText(css)));
    link.remove();
  }
  for (const style of descendants(doc, "style")) {
    styles.push(style.textContent ?? "");
    style.remove();
  }

  // Script never reaches the sandbox anyway (its CSP forbids it); removing it
  // here keeps the document honest and the console quiet.
  for (const s of descendants(doc, "script")) s.remove();

  const body = descendants(doc, "body")[0];
  return wrap(body ? body.innerHTML : doc.documentElement.outerHTML, fontScale, dark, styles);
}

/** Rewrite `url(...)` references inside a stylesheet to data URLs. Without
 * this an embedded font or a background image silently disappears. */
function inlineCssAssets(
  files: Record<string, Uint8Array>,
  cssPath: string,
  css: string,
): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (all, _q, ref: string) => {
    if (/^(data:|https?:)/i.test(ref)) return all;
    const assetPath = hrefToPath(cssPath, ref);
    const bytes = findEntry(files, assetPath);
    return bytes ? `url("${toDataUrl(bytes, mimeForPath(assetPath))}")` : "url()";
  });
}

function escapeBody(text: string): string {
  return `<pre>${text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")}</pre>`;
}

/** Reader chrome around the chapter: a measured column, comfortable line
 * height, and colours that follow the APP's light/dark setting.
 *
 * `dark` is passed in rather than sniffed with `prefers-color-scheme`: the
 * chapter renders in a separate, opaque origin that cannot see the app's
 * theme, so it would otherwise follow the MAC's — a dark page inside a light
 * window whenever the two disagree. */
function wrap(body: string, fontScale: number, dark: boolean, styles: string[] = []): string {
  const bg = dark ? "#16161a" : "#fdfcfa";
  const fg = dark ? "#ddd8d0" : "#1a1a1a";
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  :root { color-scheme: ${dark ? "dark" : "light"}; }
  html { -webkit-text-size-adjust: 100%; min-height: 100%; background: ${bg}; }
  body {
    margin: 0 auto;
    min-height: 100vh;
    padding: 2.5rem 1.5rem 4rem;
    max-width: 38rem;
    font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;
    font-size: ${(fontScale * 1.05).toFixed(2)}rem;
    line-height: 1.7;
    color: ${fg};
    background: ${bg};
    overflow-wrap: break-word;
  }
  a { color: ${dark ? "#9d8df1" : "#5b4bd6"}; }
  img, svg { max-width: 100%; height: auto; }
  h1, h2, h3 { line-height: 1.25; }
  /* The publisher's own rules come last so they win where they exist. */
</style>
${styles.map((s) => `<style>${s}</style>`).join("\n")}
</head><body>${body}</body></html>`;
}
