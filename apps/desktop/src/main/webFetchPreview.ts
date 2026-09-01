import {
  TOO_LARGE,
  bodyCappedTo,
  decodeBody,
  discard,
  guardedGet,
  headerString,
  htmlTitle,
} from "./webFetchCore.js";
import { stripHtml } from "./editMatchHtml.js";
import { decodeBasicEntities } from "./editMatchExtraction.js";

const MAX_PREVIEW_HTML_BYTES = 256 * 1024;

/** Hard cap per preview image. Real `og:image` files are 20–150 KB; anything
 * larger is a full-resolution hero shot we have no use for at card size.
 * Ported from `MAX_PREVIEW_IMAGE_BYTES`. */
export const MAX_PREVIEW_IMAGE_BYTES = 200 * 1024;

/** What an oversized preview image says. Distinct from `TOO_LARGE`: telling
 * the user "the page is too large to fetch" when a PICTURE was too big
 * explains nothing. */
const IMAGE_TOO_LARGE = "Preview image is too large.";

/** What one enrich pass learns about a result page (BROWSE-3b). Ported from
 * `PagePreview`. */
export interface PagePreview {
  /** Absolute URL of the page's own preview image, if it declares one. */
  imageUrl: string | null;
  /** Absolute URL of the page's favicon, if it declares one. */
  iconUrl: string | null;
  /** The page's own `meta description` — first-party and usually better
   * written than the engine's snippet. */
  description: string | null;
  title: string | null;
  /** Readable text, so a later Peek is already paid for. */
  text: string;
}

/** Pull one attribute's value out of a single tag. Handles both quote styles;
 * unquoted values are rare enough in real `<head>` markup to skip. Ported from
 * `attr_value`. */
function attrValue(tag: string, attr: string): string | null {
  const lower = tag.toLowerCase();
  const at = lower.indexOf(`${attr}=`);
  if (at === -1) {
    return null;
  }
  const rest = tag.slice(at + attr.length + 1);
  const quote = rest.charAt(0);
  if (quote !== '"' && quote !== "'") {
    return null;
  }
  const end = rest.indexOf(quote, 1);
  if (end === -1) {
    return null;
  }
  return rest.slice(1, end);
}

/**
 * Read one `<meta>` value by property/name, case-insensitively. A deliberately
 * small scanner rather than a DOM parse: we are reading four known keys out of
 * a `<head>`, and pulling in a full HTML parser for that would be the tail
 * wagging the dog. Both quote styles, because `property='og:image'` is equally
 * legal and a page that uses single quotes is not a page without a preview
 * image. Ported from `meta_content`.
 */
function metadataTagAt(html: string, lower: string, at: number): string | null {
  const tagStart = lower.lastIndexOf("<", at);
  if (tagStart === -1) {
    return null;
  }
  const closeAt = lower.indexOf(">", at);
  // Rust's `.unwrap_or(0)` leaves `tag_end == at` when the tag is never
  // closed (a truncated page), which still scans the fragment before the
  // needle rather than discarding the match.
  const tagEnd = closeAt === -1 ? at : closeAt;
  return html.slice(tagStart, tagEnd);
}

function metadataContentInTag(tag: string): string | null {
  const value = attrValue(tag, "content");
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : decodeBasicEntities(trimmed);
}

function metadataValueForNeedle(html: string, lower: string, needle: string): string | null {
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at === -1) {
      return null;
    }
    const tag = metadataTagAt(html, lower, at);
    const value = tag === null ? null : metadataContentInTag(tag);
    if (value !== null) {
      return value;
    }
    from = at + needle.length;
  }
}

function metadataValueForKey(html: string, lower: string, key: string): string | null {
  for (const quote of ['"', "'"] as const) {
    const value = metadataValueForNeedle(html, lower, `${quote}${key}${quote}`);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function metaContent(html: string, keys: readonly string[]): string | null {
  const lower = html.toLowerCase();
  for (const key of keys) {
    const value = metadataValueForKey(html, lower, key);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

/** The `href` of the page's icon link, if it declares one. Ported from
 * `icon_href`. */
interface LinkTag {
  tag: string;
  end: number;
}

function nextLinkTag(html: string, lower: string, from: number): LinkTag | null {
  const at = lower.indexOf("<link", from);
  if (at === -1) {
    return null;
  }
  const end = lower.indexOf(">", at);
  if (end === -1) {
    return null;
  }
  return { tag: html.slice(at, end), end };
}

function isIconRelationship(value: string): boolean {
  return value === "icon" || value === "shortcut";
}

function iconHrefInTag(tag: string): string | null {
  const rel = (attrValue(tag, "rel") ?? "").toLowerCase();
  if (!rel.split(/\s+/).some(isIconRelationship)) {
    return null;
  }
  const href = attrValue(tag, "href");
  if (href === null || href.trim() === "") {
    return null;
  }
  return decodeBasicEntities(href.trim());
}

function iconHref(html: string): string | null {
  const lower = html.toLowerCase();
  let from = 0;
  for (;;) {
    const link = nextLinkTag(html, lower, from);
    if (link === null) {
      return null;
    }
    const href = iconHrefInTag(link.tag);
    if (href !== null) {
      return href;
    }
    from = link.end;
  }
}

/** Resolve a possibly-relative asset URL against the page it came from, and
 * refuse anything that isn't plain http(s) — a `data:` or `javascript:` URL in
 * an `og:image` must never reach the fetcher. Ported from `absolutize`. */
function absolutize(base: string, href: string): string | null {
  try {
    const joined = new URL(href.trim(), base);
    return joined.protocol === "http:" || joined.protocol === "https:" ? joined.toString() : null;
  } catch {
    return null;
  }
}

/** The parsing half of {@link fetchPreview}, split out so it can be tested
 * without a network. Ported from `preview_from_html`. */
function previewImageUrl(url: string, html: string): string | null {
  const image = metaContent(html, ["og:image", "twitter:image", "og:image:url"]);
  return image === null ? null : absolutize(url, image);
}

function previewIconUrl(url: string, html: string): string | null {
  const icon = iconHref(html);
  // Rust chains `icon_href(..).and_then(absolutize).or_else(|| absolutize(url, "/favicon.ico"))`:
  // a DECLARED icon that fails to absolutize (a `data:` favicon, a
  // `javascript:` href) still falls back to the conventional path. Writing
  // this as an if/else on `icon` — as both candidate ports did — loses that
  // fallback and leaves such a page with NO icon at all.
  return (icon !== null ? absolutize(url, icon) : null) ?? absolutize(url, "/favicon.ico");
}

function previewDescription(html: string): string | null {
  const description = metaContent(html, ["og:description", "description", "twitter:description"]);
  return description === null || description.trim() === "" ? null : description.trim();
}

export function previewFromHtml(url: string, html: string): PagePreview {
  return {
    imageUrl: previewImageUrl(url, html),
    iconUrl: previewIconUrl(url, html),
    description: previewDescription(html),
    title: metaContent(html, ["og:title"]) ?? htmlTitle(html),
    text: stripHtml(html),
  };
}

/**
 * Read one result page for its preview metadata (BROWSE-3b) — the enrich pass.
 * The same guarded GET as every other fetch, reading at most
 * {@link MAX_PREVIEW_HTML_BYTES} rather than streaming a whole page in and
 * throwing 97% of it away (eight results at up to 8 MiB each is 64 MB of
 * download for four `<head>` tags apiece). It is a plain HTTP client, not a
 * browser: no cookie jar, no script execution, no referrer, no storage — which
 * is what lets the results page show real thumbnails without any origin seeing
 * a browser fingerprint. Ported from `fetch_preview`.
 */
export async function fetchPreview(url: string): Promise<PagePreview> {
  const resp = await guardedGet(url);
  const contentType = headerString(resp.headers, "content-type");
  if (!(contentType.includes("html") || contentType === "")) {
    discard(resp.stream);
    throw new Error(`Not an HTML page (content-type: ${contentType}).`);
  }
  const raw = await bodyCappedTo(resp, MAX_PREVIEW_HTML_BYTES, true, TOO_LARGE);
  return previewFromHtml(url, decodeBody(raw, contentType));
}

/** Fetch one image through the same guard, refusing anything that isn't an
 * image or is bigger than a card needs. Capped at the CARD's budget, not the
 * page budget. Ported from `fetch_image`. */
export async function fetchImage(url: string): Promise<{ mime: string; bytes: Buffer }> {
  const resp = await guardedGet(url);
  const mime = headerString(resp.headers, "content-type").split(";")[0]!.trim();
  if (!mime.startsWith("image/")) {
    discard(resp.stream);
    throw new Error(`Not an image (content-type: ${mime}).`);
  }
  const bytes = await bodyCappedTo(resp, MAX_PREVIEW_IMAGE_BYTES, false, IMAGE_TOO_LARGE);
  return { mime, bytes };
}
