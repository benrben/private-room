import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import type { Readable } from "node:stream";
import { checkPublicHttpUrl, resolvePublicAddr } from "./browser/guard.js";
import { stripHtml } from "./editMatchHtml.js";
import { decodeBasicEntities } from "./editMatchExtraction.js";
import { readPage } from "./browser/article.js";

export const MAX_PAGE_CHARS = 200_000;

/** Hard cap on how much of any response body gets buffered. Generous, because
 * research pages and YouTube watch pages legitimately run to multiple MB — but
 * a hostile server can no longer stream gigabytes into memory. Ported from
 * `MAX_FETCH_BYTES`. */
export const MAX_FETCH_BYTES = 8 * 1024 * 1024;

export const TOO_LARGE = "The page is too large to fetch.";

/** How many redirect hops one fetch may take before it gives up. Ported from
 * `MAX_REDIRECTS`. */
const MAX_REDIRECTS = 5;

/** Per-hop request timeout — `reqwest::Client::builder().timeout(20s)`. */
const HOP_TIMEOUT_MS = 20_000;

const USER_AGENT = "Mozilla/5.0 (Macintosh) Arcelle/0.1";

// ----------------------------------------------------------- body capping

/** The pieces of a response {@link bodyCappedTo} reads: the headers it must
 * not trust, and the still-unread body. `http.IncomingMessage` satisfies this
 * structurally; a test can satisfy it with any `Readable`. */
export interface CappableResponse {
  headers: http.IncomingHttpHeaders;
  stream: Readable;
}

export function declaredLength(headers: http.IncomingHttpHeaders): number | null {
  const raw = headers["content-length"];
  const value = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (value === undefined) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function declaredBodyIsTooLarge(
  headers: http.IncomingHttpHeaders,
  limit: number,
  truncate: boolean,
): boolean {
  const declared = declaredLength(headers);
  return !truncate && declared !== null && declared > limit;
}

function bodyChunk(piece: unknown): Buffer {
  return Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array | string);
}

function appendCappedChunk(
  resp: CappableResponse,
  chunks: Buffer[],
  total: number,
  chunk: Buffer,
  limit: number,
  truncate: boolean,
  tooLarge: string,
): number | null {
  if (total + chunk.length <= limit) {
    chunks.push(chunk);
    return total + chunk.length;
  }
  if (!truncate) {
    resp.stream.destroy();
    throw new Error(tooLarge);
  }
  chunks.push(chunk.subarray(0, limit - total));
  resp.stream.destroy();
  return null;
}

/**
 * Read a body into memory without trusting the server about its size: reject
 * on a declared oversize `Content-Length`, then stream chunks and stop at
 * `limit`. With `truncate` the first `limit` bytes are kept (for callers that
 * window the text anyway); otherwise an oversized body throws `tooLarge`.
 * Ported from `body_capped_to`.
 *
 * The limit is a PARAMETER because the callers want very different amounts: a
 * preview needs the `<head>` and an `og:image` needs a card-sized picture, and
 * both used to stream up to the whole 8 MiB page cap and throw almost all of
 * it away — real bandwidth on a metered connection, eight results at a time.
 *
 * The stream is DESTROYED on every early exit (declared-oversize, streamed
 * overflow, truncation), so a hostile server cannot keep pushing bytes at a
 * caller that has already decided.
 */
export async function bodyCappedTo(
  resp: CappableResponse,
  limit: number,
  truncate: boolean,
  tooLarge: string
): Promise<Buffer> {
  if (declaredBodyIsTooLarge(resp.headers, limit, truncate)) {
    resp.stream.destroy();
    throw new Error(tooLarge);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const piece of resp.stream) {
    const chunk = bodyChunk(piece);
    if (chunk.length === 0) {
      continue;
    }
    const nextTotal = appendCappedChunk(resp, chunks, total, chunk, limit, truncate, tooLarge);
    if (nextTotal === null) {
      total = limit;
      break;
    }
    total = nextTotal;
  }
  return Buffer.concat(chunks, total);
}

/** The whole-page read: everything up to {@link MAX_FETCH_BYTES}. Ported from
 * `body_capped`. */
export async function bodyCapped(resp: CappableResponse, truncate: boolean): Promise<Buffer> {
  return bodyCappedTo(resp, MAX_FETCH_BYTES, truncate, TOO_LARGE);
}

/**
 * Decode capped body bytes per the Content-Type charset — what `resp.text()`
 * did before body capping. Legacy pages (old Hebrew sites are commonly
 * `charset=windows-1255`) would otherwise turn to mojibake; absent/unknown
 * charsets fall back to lossy UTF-8. Ported from `decode_body`.
 *
 * `TextDecoder` implements the same WHATWG Encoding Standard `encoding_rs`
 * does, so the labels and aliases resolve identically. The label match is
 * case-insensitive even though every caller here already lowercases its
 * `contentType`, because this is also the function a future caller reaches for
 * with a raw header.
 */
export function decodeBody(raw: Uint8Array, contentType: string): string {
  const label = contentType
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.toLowerCase().startsWith("charset="))
    ?.slice("charset=".length)
    .trim()
    .replace(/^"+|"+$/g, "");
  if (label !== undefined && label !== "") {
    try {
      return new TextDecoder(label, { fatal: false }).decode(raw);
    } catch {
      // An unrecognised label falls through to the lossy-UTF-8 default below,
      // exactly like `Encoding::for_label` returning `None`.
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(raw);
}

// ------------------------------------------------------------- guarded GET

function defaultPortFor(protocol: string): number {
  return protocol === "https:" ? 443 : 80;
}

function portOf(url: URL): number {
  return url.port !== "" ? Number(url.port) : defaultPortFor(url.protocol);
}

/** `hostname` keeps the brackets on an IPv6 literal ("[::1]"); DNS resolution
 * and TLS want the bare address, the `Host` header wants the brackets. */
function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function hostHeaderFor(host: string, port: number, protocol: string): string {
  return port === defaultPortFor(protocol) ? host : `${host}:${port}`;
}

/**
 * Where a response says to go next, absolutized against the URL it came from.
 * `null` for anything that is not a redirect, and for a redirect with no
 * usable `Location` — which then falls through to the normal status handling
 * rather than being followed to nowhere. Ported from `redirect_target`.
 */
export function redirectTarget(status: number, location: string | null | undefined, from: URL): string | null {
  if (![301, 302, 303, 307, 308].includes(status)) {
    return null;
  }
  const loc = location?.trim();
  if (loc === undefined || loc === "") {
    return null;
  }
  try {
    return new URL(loc, from).toString();
  } catch {
    return null;
  }
}

interface HopResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  stream: http.IncomingMessage;
}

/**
 * One HOP of a guarded fetch, connected to the already-checked-and-resolved
 * `address` — never to `host` itself, which is what closes the check-vs-fetch
 * rebinding window (SEC-5). `Host` (and, for a named https host, `servername`)
 * still carry the ORIGINAL name, so virtual hosting, TLS SNI and certificate
 * hostname verification all see the name the model asked for.
 *
 * `agent: false` so no socket is pooled between hops — `fetch_client` builds a
 * fresh `reqwest::Client` per hop for the same reason, and a pinned connection
 * is not a thing to reuse across a redirect chain.
 */
function singleHop(parsed: URL, address: string, port: number): Promise<HopResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = parsed.protocol === "https:";
    const requestFn = isHttps ? https.request : http.request;
    const bareHost = stripBrackets(parsed.hostname);
    // RFC 6066: an IP literal is not a legal SNI name. Omitting `servername`
    // then makes Node check the certificate against the connect address, which
    // for an IP-literal URL is that same literal — the right identity either
    // way, and no spurious Node warning.
    const sni = isHttps && net.isIP(bareHost) === 0 ? { servername: bareHost } : {};
    const req = requestFn(
      {
        hostname: address,
        port,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        agent: false,
        headers: {
          Host: hostHeaderFor(parsed.hostname, port, parsed.protocol),
          "User-Agent": USER_AGENT,
          Accept: "*/*",
        },
        timeout: HOP_TIMEOUT_MS,
        ...sni,
      },
      (res) => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res });
      }
    );
    req.on("timeout", () => req.destroy(new Error("the request timed out")));
    req.on("error", (err) => reject(new Error(`Could not fetch the page: ${err.message}`)));
    req.end();
  });
}

/** Discard a response body without reading it into memory — a redirect hop's
 * own body (never read) and an error status's. */
export function discard(stream: Readable): void {
  stream.resume();
  stream.destroy();
}

/**
 * The result of a guarded fetch: where it actually landed (after following any
 * redirects itself), plus the still-open, still-unread response stream for the
 * caller to cap-read. `status` is always a 2xx — anything else already became
 * a thrown `Error` before this is returned.
 */
export interface GuardedResponse extends CappableResponse {
  status: number;
  finalUrl: string;
  stream: http.IncomingMessage;
}

/**
 * The one guarded GET every page/transcript/preview/download fetch goes
 * through. Ported from `guarded_get` — see this module's own doc for the three
 * properties it exists to hold.
 */
export async function guardedGet(url: string): Promise<GuardedResponse> {
  let next = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Throws the guard's own refusal strings ("Local and private-network
    // addresses cannot be fetched.", "Only http(s) URLs can be fetched.", …).
    const parsed = checkPublicHttpUrl(next);
    const port = portOf(parsed);
    // Resolve the host and confirm EVERY address it answers with is public,
    // then connect to the one that was checked. Re-run on every hop.
    const { address } = await resolvePublicAddr(stripBrackets(parsed.hostname), port);
    const resp = await singleHop(parsed, address, port);
    const location = typeof resp.headers.location === "string" ? resp.headers.location : undefined;
    const target = redirectTarget(resp.status, location, parsed);
    if (target !== null) {
      discard(resp.stream);
      next = target;
      continue;
    }
    if (resp.status < 200 || resp.status >= 300) {
      discard(resp.stream);
      throw new Error(`The page returned HTTP ${resp.status}.`);
    }
    return { status: resp.status, headers: resp.headers, finalUrl: parsed.toString(), stream: resp.stream };
  }
  throw new Error("Too many redirects.");
}

// -------------------------------------------------------------- html title

/** The page's `<title>`, entity-decoded. Ported from `html_title` (exported
 * past Rust's `fn`-private visibility so it can be pinned directly, the mild
 * widening this port already uses elsewhere). */
export function htmlTitle(html: string): string | null {
  const lower = html.toLowerCase();
  const start = lower.indexOf("<title");
  if (start === -1) {
    return null;
  }
  const openRel = lower.slice(start).indexOf(">");
  if (openRel === -1) {
    return null;
  }
  const open = start + openRel;
  const endRel = lower.slice(open).indexOf("</title>");
  if (endRel === -1) {
    return null;
  }
  const end = open + endRel;
  const title = stripHtml(html.slice(open + 1, end)).trim();
  return title === "" ? null : title;
}

// -------------------------------------------------------------- fetch_page

function isTextualContentType(contentType: string): boolean {
  return (
    contentType.includes("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType === ""
  );
}

/** One header, lowercased, or `""`. Node folds repeats for everything but
 * `set-cookie`; an array is read at its first entry rather than joined. */
export function headerString(headers: http.IncomingHttpHeaders, name: string): string {
  const v = headers[name];
  const one = typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
  return one?.toLowerCase() ?? "";
}

/**
 * `fetch_page`'s result, carrying where the request actually landed — D2
 * (2026-08-04). `guardedGet` follows redirects itself, so without this the
 * model asking for one URL and silently reading the text of a DIFFERENT one (a
 * redirect it never saw) would be invisible. `status` is always a 2xx: anything
 * else already threw inside {@link guardedGet}. Ported from `FetchedPage`.
 */
export interface FetchedPage {
  title: string;
  text: string;
  finalUrl: string;
  status: number;
}

/** Fetch one page and return (title, readable text). HTML is reduced to plain
 * text; anything else comes back as-is if it's textual. Ported from
 * `fetch_page`. */
export async function fetchPage(url: string): Promise<FetchedPage> {
  const resp = await guardedGet(url);
  const contentType = headerString(resp.headers, "content-type");
  if (!isTextualContentType(contentType)) {
    discard(resp.stream);
    throw new Error(`The URL is not a text page (content-type: ${contentType}).`);
  }
  const raw = await bodyCapped(resp, true);
  const body = decodeBody(raw, contentType);
  const title = htmlTitle(body) ?? url;
  let text = contentType.includes("html") || body.trimStart().startsWith("<") ? stripHtml(body) : body;
  const chars = Array.from(text);
  if (chars.length > MAX_PAGE_CHARS) {
    text = `${chars.slice(0, MAX_PAGE_CHARS).join("")}\n… (truncated)`;
  }
  return { title, text, finalUrl: resp.finalUrl, status: resp.status };
}

/**
 * Like {@link fetchPage}, but also hands back the raw page bytes so the caller
 * can keep an offline copy of the source verbatim — the airlock (#research)
 * command saves the bytes as an owned file and answers from the readable text.
 * Goes through the exact same SSRF-guarded {@link guardedGet}. Unlike the
 * model-facing `fetchPage` the text is left un-truncated: it feeds the room's
 * normal chunking. Ported from `fetch_readable`.
 */
export async function fetchReadable(url: string): Promise<{ title: string; text: string; raw: Buffer }> {
  const resp = await guardedGet(url);
  const contentType = headerString(resp.headers, "content-type");
  if (!isTextualContentType(contentType)) {
    discard(resp.stream);
    throw new Error(`The URL is not a text page (content-type: ${contentType}).`);
  }
  const raw = await bodyCapped(resp, false);
  const body = decodeBody(raw, contentType);
  const title = htmlTitle(body) ?? url;
  let text: string;
  if (contentType.includes("html") || body.trimStart().startsWith("<")) {
    // The article, when the page has one — the same Readability pass the
    // browser's Save uses, so a page saved from a link and the same page saved
    // from the browser produce the same reading. `stripHtml` stays the fallback
    // for everything with no scorable article (a link list, a form, a feed).
    const article = readPage(body, url).article;
    text = article !== null ? article.text : stripHtml(body);
  } else {
    text = body;
  }
  return { title, text, raw };
}

// ------------------------------------------------ binary downloads (BROWSE-2)

/** D18: how much `download_url` fetches inline (within one tool call).
 * Anything bigger belongs on the durable-job tier, not in a chat round. Ported
 * from `INLINE_DOWNLOAD_BYTES`. */
