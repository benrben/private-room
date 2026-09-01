/** Shared helpers for the two zip-container document formats the app renders
 * in the frontend: PPTX decks and EPUB books.
 *
 * Both are a zip of XML plus media, both address their parts through a
 * `_rels` sidecar, and both need their images turned into data URLs before
 * anything can be shown. The pure functions here are unit-tested under
 * `npm run test:page`; the DOM-dependent parsing lives beside them in
 * `pptx.ts` / `epub.ts`.
 */

/** English Metric Units per inch — OOXML's internal unit for every position
 * and size in a slide. 914,400 of them to the inch, 12,700 to the point. */
export const EMU_PER_INCH = 914_400;

/** Resolve a relationship target against the part that referenced it.
 *
 * OOXML and EPUB both store targets relative to the referencing part's own
 * folder (`../media/image1.png` from `ppt/slides/_rels/slide1.xml.rels` means
 * `ppt/media/image1.png`), and getting this wrong is the classic reason a deck
 * renders with every picture missing.
 */
function isAbsoluteTarget(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target);
}

function baseParts(base: string): string[] {
  if (!base.includes("/")) return [];
  const baseDir = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
  return baseDir ? baseDir.split("/") : [];
}

function applyTargetSegment(parts: string[], segment: string) {
  if (segment === "" || segment === ".") return;
  if (segment === "..") {
    parts.pop();
    return;
  }
  parts.push(segment);
}

export function resolvePath(base: string, target: string): string {
  if (isAbsoluteTarget(target)) return target; // absolute URL — not ours
  if (target.startsWith("/")) return target.slice(1);
  const parts = baseParts(base);
  for (const seg of target.split("/")) {
    applyTargetSegment(parts, seg);
  }
  return parts.join("/");
}

/** Strip a URL's query/fragment — EPUB hrefs routinely carry `#anchor`. */
export function withoutFragment(href: string): string {
  return href.split("#")[0].split("?")[0];
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  emf: "image/emf",
  wmf: "image/wmf",
  css: "text/css",
  otf: "font/otf",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
};

export function mimeForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** True for the image formats a browser will actually draw. EMF/WMF are the
 * two that appear in real decks and that nothing on the web can render — they
 * get a placeholder instead of a broken-image glyph. */
export function isRenderableImage(path: string): boolean {
  const mime = mimeForPath(path);
  return mime.startsWith("image/") && mime !== "image/emf" && mime !== "image/wmf";
}

/** Bytes → data URL, in chunks so a multi-megabyte image can't blow the
 * argument limit of `String.fromCharCode`. */
export function toDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

const TEXT_DECODER = new TextDecoder("utf-8");
export function bytesToText(bytes: Uint8Array | undefined): string {
  return bytes ? TEXT_DECODER.decode(bytes) : "";
}

/** Escape for insertion into HTML text or an attribute value. Used when
 * building the sandboxed chapter document — an EPUB is untrusted input. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A zip entry lookup that tolerates the case differences and leading slashes
 * real files contain. Exact match first, so a correctly-built file costs
 * nothing. */
export function findEntry(
  files: Record<string, Uint8Array>,
  path: string,
): Uint8Array | undefined {
  if (files[path]) return files[path];
  const wanted = path.replace(/^\/+/, "").toLowerCase();
  for (const key of Object.keys(files)) {
    if (key.replace(/^\/+/, "").toLowerCase() === wanted) return files[key];
  }
  return undefined;
}
