/**
 * The guarded HTTP client behind the agent's web tools. Ported from
 * `src-tauri/src/web/fetch.rs` (977 lines, read in full): `fetch_page`,
 * `fetch_readable`, the binary-download engine (`download_to_temp`,
 * `disposition_file_name`), the YouTube-transcript path (`youtube_video_id`,
 * `youtube_transcript`) and the result-preview enrich pass (`fetch_preview`,
 * `fetch_image`).
 *
 * REUSED RATHER THAN RE-PORTED, because earlier batches already ported them:
 * - `checkPublicHttpUrl` / `resolvePublicAddr` — `./browser/guard.ts`, the
 *   port of `src-tauri/src/web/guard.rs`. That file IS this module's SSRF
 *   guard; nothing here re-implements address classification.
 * - `safeFileName` / `MAX_DOWNLOAD_BYTES` — `./browser/downloads.ts`, which
 *   already ports exactly those two pieces of THIS Rust file (and does so
 *   Unicode-correctly: Rust's `char::is_alphanumeric` is `\p{L}\p{N}`, not
 *   `[A-Za-z0-9]`, and the 80-char cap counts CODE POINTS).
 * - `stripHtml` — `./editMatchHtml.ts` (`extraction::strip_html`).
 * - `decodeBasicEntities` — `./editMatchExtraction.ts`.
 * - the Readability pass `fetch_readable` uses — `./browser/article.ts`'s
 *   `readPage`.
 *
 * THE SSRF POSTURE, which is the whole point of this file:
 *
 * 1. EVERY HOP gets the WHOLE guard, never just the first URL. {@link guardedGet}
 *    follows redirects BY HAND — no HTTP client's own redirect policy — and
 *    each hop runs `checkPublicHttpUrl` (literal/`localhost`/`.local` check),
 *    then `resolvePublicAddr` (resolve the name and confirm EVERY returned
 *    address is public), then connects to the ONE address that was checked.
 *    `web/guard.rs`'s own tombstone comment for the deleted
 *    `hop_host_is_public` says why a per-hop check that cannot PIN is strictly
 *    weaker than no shortcut at all: an approved hop gets resolved a SECOND
 *    time, unpinned, to open the connection, and a hostile server can answer
 *    the check publicly and the connection privately.
 * 2. DNS PINNING, Node edition. `reqwest`'s `.resolve(host, addr)` pins one
 *    client's DNS for one hop; the direct analogue is passing the
 *    already-resolved, already-checked ADDRESS as `http(s).request`'s
 *    `hostname` (the literal TCP connect target) while the ORIGINAL host name
 *    stays in the `Host` header (virtual hosting) and in `servername` (TLS SNI
 *    + certificate hostname verification). Dropping `servername` would make
 *    Node validate the leaf certificate against the IP literal instead of the
 *    domain, which fails for essentially every real certificate — a guarded
 *    HTTPS fetch would look like a TLS outage. (`servername` is omitted when
 *    the host IS an IP literal: RFC 6066 forbids an IP in SNI, and Node then
 *    validates against the connect address, which is that same literal.)
 * 3. STREAMING BYTE CAPS. {@link bodyCappedTo} reads the body in chunks and
 *    stops — destroying the stream — the instant the cap is reached. It never
 *    buffers a whole body and checks the size afterwards, and it never trusts
 *    `Content-Length`: an understated one does not exempt a body from the
 *    running total, and an overstated one is refused before a single body byte
 *    is read.
 *
 * DELIBERATELY `node:http`/`node:https` RATHER THAN `fetch`: the Rust client
 * is `reqwest` built WITHOUT the `gzip` feature (see `src-tauri/Cargo.toml`:
 * `features = ["json", "stream", "rustls-tls"]`), so it negotiates no
 * content-encoding and the byte caps above bound exactly the bytes on the
 * wire. Node's `fetch` (undici) always advertises `gzip, deflate, br` and
 * decodes transparently, which would silently change what the caps count.
 * This module's tests also drive the real transport against real local
 * servers, which a `fetch` port cannot do without a pinning shim of its own.
 */

import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { checkPublicHttpUrl, resolvePublicAddr } from "./browser/guard.js";
import { MAX_DOWNLOAD_BYTES, safeFileName } from "./browser/downloads.js";
import { stripHtml } from "./editMatchHtml.js";
import { decodeBasicEntities } from "./editMatchExtraction.js";
import { readPage } from "./browser/article.js";

export { MAX_DOWNLOAD_BYTES, safeFileName };

// --------------------------------------------------------------- constants

/**
 * Hard cap on the readable text one `fetch_page` yields. Ported from
 * `MAX_PAGE_CHARS`.
 *
 * Was 12,000 in an earlier Rust revision — which silently disabled the
 * pagination protocol it sits behind: `fetchPageWindow` windows 40,000
 * characters and tells the model to call again with the next `start`, but text
 * truncated at 12,000 can never reach a second window. Raised well past one
 * window so long pages can actually be paged through; the 8 MiB byte cap
 * upstream still bounds the fetch itself.
 */
export const MAX_PAGE_CHARS = 200_000;

/** Hard cap on how much of any response body gets buffered. Generous, because
 * research pages and YouTube watch pages legitimately run to multiple MB — but
 * a hostile server can no longer stream gigabytes into memory. Ported from
 * `MAX_FETCH_BYTES`. */
export const MAX_FETCH_BYTES = 8 * 1024 * 1024;

const TOO_LARGE = "The page is too large to fetch.";

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

function declaredLength(headers: http.IncomingHttpHeaders): number | null {
  const raw = headers["content-length"];
  const value = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (value === undefined) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
  const declared = declaredLength(resp.headers);
  if (!truncate && declared !== null && declared > limit) {
    resp.stream.destroy();
    throw new Error(tooLarge);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const piece of resp.stream) {
    const chunk: Buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array | string);
    if (chunk.length === 0) {
      continue;
    }
    if (total + chunk.length > limit) {
      if (!truncate) {
        resp.stream.destroy();
        throw new Error(tooLarge);
      }
      chunks.push(chunk.subarray(0, limit - total));
      total = limit;
      resp.stream.destroy();
      break;
    }
    chunks.push(chunk);
    total += chunk.length;
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
function discard(stream: Readable): void {
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
function headerString(headers: http.IncomingHttpHeaders, name: string): string {
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
export const INLINE_DOWNLOAD_BYTES = 64 * 1024 * 1024;

/** A file staged to the app's temp area by {@link downloadToTemp}, ready for
 * an import step to move into the room. Ported from `Downloaded`. */
export interface Downloaded {
  path: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
}

/** Outcome of a capped download. `tooLarge` is an OUTCOME, not a thrown error,
 * because the caller chooses what it means: at the inline cap it promotes the
 * download to a background job (D18); at the hard cap it is a truthful refusal
 * (D15). Ported from `DownloadOutcome`. */
export type DownloadOutcome = { kind: "done"; downloaded: Downloaded } | { kind: "tooLarge" };

/**
 * The server's suggested filename from a Content-Disposition header, if any.
 * Reads `filename*=charset''value` (kept raw — percent escapes fall to
 * `safeFileName`) and quoted or bare `filename=`. Ported from
 * `disposition_file_name`, INCLUDING its order of operations: quotes are
 * trimmed from both ends first (repeatedly, like `trim_matches('"')`) and
 * whitespace after, so `filename= "x"` keeps its quotes exactly as Rust does.
 */
export function dispositionFileName(value: string): string | null {
  for (const rawPart of value.split(";")) {
    const part = rawPart.trim();
    let raw: string;
    if (part.startsWith("filename*=")) {
      const v = part.slice("filename*=".length);
      const idx = v.lastIndexOf("''");
      raw = idx === -1 ? v : v.slice(idx + 2);
    } else if (part.startsWith("filename=")) {
      raw = part.slice("filename=".length);
    } else {
      continue;
    }
    const name = raw.replace(/^"+|"+$/g, "").trim();
    if (name !== "") {
      return name;
    }
  }
  return null;
}

/**
 * A small extension → MIME table. DEVIATION from Rust, which calls the
 * `mime_guess` crate: no equivalent dependency is installed in this migration,
 * and adding one for this would be scope creep. Anything not listed reads as
 * the generic binary type, exactly as `mime_guess`'s own
 * `first_or_octet_stream()` fallback does.
 */
const EXTENSION_MIME: ReadonlyMap<string, string> = new Map([
  ["html", "text/html"],
  ["htm", "text/html"],
  ["txt", "text/plain"],
  ["md", "text/markdown"],
  ["csv", "text/csv"],
  ["json", "application/json"],
  ["xml", "application/xml"],
  ["pdf", "application/pdf"],
  ["zip", "application/zip"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["m4a", "audio/mp4"],
  ["mp4", "video/mp4"],
  ["webm", "video/webm"],
  ["mov", "video/quicktime"],
  ["doc", "application/msword"],
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["xls", "application/vnd.ms-excel"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["ppt", "application/vnd.ms-powerpoint"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
]);

export function guessDownloadMime(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) {
    return "application/octet-stream";
  }
  return EXTENSION_MIME.get(fileName.slice(dot + 1).toLowerCase()) ?? "application/octet-stream";
}

function urlLastSegment(url: string): string | null {
  try {
    const segs = new URL(url).pathname.split("/").filter((s) => s !== "");
    return segs.length > 0 ? segs[segs.length - 1]! : null;
  } catch {
    return null;
  }
}

/** The staging area `download_to_temp` writes into. */
export function defaultDownloadTempDir(): string {
  return path.join(os.tmpdir(), "arcelle-downloads");
}

/**
 * Download any URL — binary included — to a staged temp file, streaming and
 * size-capped. Same SSRF posture as every other fetch (public-URL check, SEC-5
 * DNS pinning, hop-by-hop redirect re-checks); unlike {@link fetchPage} it
 * accepts every content type. The caller owns the staged file: import it into
 * the room, then delete it. Ported from `download_to_temp`.
 *
 * `cancel` is polled per chunk (a set flag aborts with "Stopped." and removes
 * the partial file); `progress` receives (bytes so far, declared total).
 *
 * `tempDir` is a PARAMETER (Rust hardcodes `std::env::temp_dir()`) purely so a
 * test can point it at a fresh directory and assert the partial file really is
 * gone; it defaults to the same path Rust uses.
 */
export async function downloadToTemp(
  url: string,
  cap: number,
  cancel: { load(): boolean } | null | undefined,
  progress: (soFar: number, declared: number | null) => void,
  tempDir: string = defaultDownloadTempDir()
): Promise<DownloadOutcome> {
  const resp = await guardedGet(url);
  const declared = declaredLength(resp.headers);
  if (declared !== null && declared > cap) {
    discard(resp.stream);
    return { kind: "tooLarge" };
  }
  const dispositionHeader = resp.headers["content-disposition"];
  const suggested =
    (typeof dispositionHeader === "string" ? dispositionFileName(dispositionHeader) : null) ??
    urlLastSegment(url) ??
    "download";
  const fileName = safeFileName(suggested);
  const headerMime = headerString(resp.headers, "content-type").split(";")[0]!.trim();
  const mime =
    headerMime !== "" && headerMime !== "application/octet-stream" ? headerMime : guessDownloadMime(fileName);

  fs.mkdirSync(tempDir, { recursive: true });
  const filePath = path.join(tempDir, `${randomUUID()}-${fileName}`);
  const out = fs.createWriteStream(filePath);
  // `createWriteStream` opens the fd ASYNCHRONOUSLY. Deleting the partial file
  // without waiting for the stream to close first is a race the abort paths
  // lose: the unlink runs, THEN the pending open re-creates the file, and the
  // "removed the partial file" promise is quietly false. Both candidate ports
  // had this; an already-cancelled download left its empty file behind.
  const closed = new Promise<void>((resolve) => out.once("close", () => resolve()));
  const cleanUp = async (): Promise<void> => {
    resp.stream.destroy();
    out.destroy();
    await closed;
    await fs.promises.rm(filePath, { force: true }).catch(() => {});
  };
  // Rust polls the flag at the TOP of the loop, before awaiting a chunk — so a
  // download that starts already-cancelled writes nothing at all.
  if (cancel?.load() === true) {
    await cleanUp();
    throw new Error("Stopped.");
  }
  let total = 0;
  try {
    for await (const piece of resp.stream) {
      if (cancel?.load() === true) {
        await cleanUp();
        throw new Error("Stopped.");
      }
      const chunk: Buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array | string);
      total += chunk.length;
      if (total > cap) {
        await cleanUp();
        return { kind: "tooLarge" };
      }
      await new Promise<void>((resolve, reject) => {
        out.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
      progress(total, declared);
    }
  } catch (err) {
    await cleanUp();
    if (err instanceof Error && err.message === "Stopped.") {
      throw err;
    }
    throw new Error(`The download failed partway: ${err instanceof Error ? err.message : String(err)}`);
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  return { kind: "done", downloaded: { path: filePath, fileName, mime, sizeBytes: total } };
}

// -------------------------------------------------- YouTube transcripts (ADD-19)

/** Rust's `trim_start_matches` strips the prefix REPEATEDLY; a single
 * `String.replace` does not, and "www.www.youtube.com" would then miss. */
function stripAllPrefix(s: string, prefix: string): string {
  let out = s;
  while (out.startsWith(prefix)) {
    out = out.slice(prefix.length);
  }
  return out;
}

function isYoutubeId(s: string): boolean {
  return s.length >= 8 && s.length <= 16 && /^[A-Za-z0-9_-]+$/.test(s);
}

/** Video id when `url` is a YouTube watch/short/embed/youtu.be link, else
 * `null` — the switch `import_link` uses to route to the transcript path.
 * Ported from `youtube_video_id`. */
export function youtubeVideoId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = stripAllPrefix(stripAllPrefix(parsed.hostname, "www."), "m.");
  const segments = parsed.pathname.split("/").filter((s) => s !== "");
  if (host === "youtu.be") {
    const id = segments[0];
    return id !== undefined && isYoutubeId(id) ? id : null;
  }
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (segments.length === 0 || segments[0] === "watch") {
      const v = parsed.searchParams.get("v");
      return v !== null && isYoutubeId(v) ? v : null;
    }
    if (segments.length >= 2 && ["shorts", "embed", "live"].includes(segments[0]!)) {
      const id = segments[1]!;
      return isYoutubeId(id) ? id : null;
    }
    return null;
  }
  return null;
}

/** Slice the `"captionTracks":[...]` array out of a watch page. The page is a
 * JS soup, so this walks the array with string/escape awareness rather than
 * trusting a regex, then hands the exact slice to `JSON.parse`. Ported from
 * `extract_caption_tracks`. */
export function extractCaptionTracks(html: string): unknown[] | null {
  const key = '"captionTracks":';
  const at = html.indexOf(key);
  if (at === -1) {
    return null;
  }
  const rest = html.slice(at + key.length);
  const start = rest.indexOf("[");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < rest.length; i++) {
    const ch = rest[i]!;
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(rest.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function tsMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const rem = s % 3600;
  const m = Math.floor(rem / 60);
  const sec = rem % 60;
  const pad2 = (n: number): string => n.toString().padStart(2, "0");
  return h > 0 ? `[${h}:${pad2(m)}:${pad2(sec)}]` : `[${m}:${pad2(sec)}]`;
}

/** Turn a timedtext `fmt=json3` payload into "[m:ss] line" text — the same
 * timestamp contract the on-device transcriber writes. Ported from
 * `timedtext_json3_to_lines`. */
export function timedtextJson3ToLines(json: string): string | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) {
    return null;
  }
  const events = (v as Record<string, unknown>).events;
  if (!Array.isArray(events)) {
    return null;
  }
  const lines: string[] = [];
  for (const ev of events) {
    if (typeof ev !== "object" || ev === null) {
      continue;
    }
    const rec = ev as Record<string, unknown>;
    // aAppend events re-send text already emitted; skip them. `in`, not
    // `!== undefined`: Rust's `get("aAppend").is_some()` is true for an
    // explicit JSON `null` too.
    if ("aAppend" in rec) {
      continue;
    }
    const segs = rec.segs;
    if (!Array.isArray(segs)) {
      continue;
    }
    let text = "";
    for (const seg of segs) {
      if (typeof seg === "object" && seg !== null && typeof (seg as Record<string, unknown>).utf8 === "string") {
        text += (seg as Record<string, unknown>).utf8 as string;
      }
    }
    text = text.replace(/\n/g, " ").trim();
    if (text === "") {
      continue;
    }
    const ms = typeof rec.tStartMs === "number" ? rec.tStartMs : 0;
    lines.push(`${tsMs(ms)} ${text}`);
  }
  return lines.length === 0 ? null : lines.join("\n");
}

/**
 * Fetch a YouTube video's own caption track as a timestamped transcript — no
 * video download, no extra tools. Manual captions win over auto-generated
 * ("asr") ones when both exist. Ported from `youtube_transcript`.
 *
 * The `baseUrl` comes out of an untrusted watch page, so the second fetch goes
 * through the full {@link guardedGet} exactly like the first — a caption track
 * pointing at `http://localhost:11434/` is refused, not followed.
 */
export async function youtubeTranscript(url: string): Promise<{ title: string; transcript: string }> {
  const first = await guardedGet(url);
  // YouTube serves UTF-8 unconditionally; no charset sniffing needed here.
  const body = (await bodyCapped(first, true)).toString("utf8");
  const rawTitle = htmlTitle(body);
  const title = rawTitle !== null ? rawTitle.replace(/ - YouTube$/, "") : url;
  const tracks = extractCaptionTracks(body);
  if (tracks === null) {
    throw new Error("This video has no captions/transcript to import.");
  }
  const isManual = (t: unknown): boolean =>
    typeof t === "object" && t !== null && (t as Record<string, unknown>).kind !== "asr";
  const track = tracks.find(isManual) ?? tracks[0];
  if (typeof track !== "object" || track === null) {
    throw new Error("This video has no captions/transcript to import.");
  }
  const base = (track as Record<string, unknown>).baseUrl;
  if (typeof base !== "string") {
    throw new Error("This video's captions could not be read.");
  }
  const sep = base.includes("?") ? "&" : "?";
  const second = await guardedGet(`${base}${sep}fmt=json3`);
  const timedtext = (await bodyCapped(second, false)).toString("utf8");
  const transcript = timedtextJson3ToLines(timedtext);
  if (transcript === null) {
    throw new Error("This video's captions came back empty.");
  }
  return { title, transcript };
}

// -------------------------------------------------------- result previews (BROWSE-3b)

/** How much of a result page to read while enriching it. Everything we want —
 * `og:image`, `meta description`, `<title>`, the icon link — lives in `<head>`,
 * so a quarter-megabyte is generous. Ported from `MAX_PREVIEW_HTML_BYTES`. */
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
function metaContent(html: string, keys: readonly string[]): string | null {
  const lower = html.toLowerCase();
  for (const key of keys) {
    for (const quote of ['"', "'"] as const) {
      const needle = `${quote}${key}${quote}`;
      let from = 0;
      for (;;) {
        const at = lower.indexOf(needle, from);
        if (at === -1) {
          break;
        }
        // Walk back to the opening tag, then forward to its end. A fragment
        // with no opening tag is skipped, never fatal: one malformed match
        // must not abandon the remaining keys.
        const tagStart = lower.lastIndexOf("<", at);
        if (tagStart === -1) {
          from = at + needle.length;
          continue;
        }
        const closeAt = lower.indexOf(">", at);
        // Rust's `.unwrap_or(0)` leaves `tag_end == at` when the tag is never
        // closed (a truncated page), which still scans the fragment before the
        // needle rather than discarding the match.
        const tagEnd = closeAt === -1 ? at : closeAt;
        if (tagEnd <= tagStart) {
          from = at + needle.length;
          continue;
        }
        const value = attrValue(html.slice(tagStart, tagEnd), "content");
        if (value !== null && value.trim() !== "") {
          // Entities decoded by the SAME single-pass reader the page body uses
          // — a card and the page can no longer disagree about the same
          // characters (Rust's `html_unescape` → `decode_basic_entities`).
          return decodeBasicEntities(value.trim());
        }
        from = at + needle.length;
      }
    }
  }
  return null;
}

/** The `href` of the page's icon link, if it declares one. Ported from
 * `icon_href`. */
function iconHref(html: string): string | null {
  const lower = html.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf("<link", from);
    if (at === -1) {
      return null;
    }
    const end = lower.indexOf(">", at);
    if (end === -1) {
      return null;
    }
    const tag = html.slice(at, end);
    const rel = (attrValue(tag, "rel") ?? "").toLowerCase();
    if (rel.split(/\s+/).some((r) => r === "icon" || r === "shortcut")) {
      const href = attrValue(tag, "href");
      if (href !== null && href.trim() !== "") {
        return decodeBasicEntities(href.trim());
      }
    }
    from = end;
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
export function previewFromHtml(url: string, html: string): PagePreview {
  const image = metaContent(html, ["og:image", "twitter:image", "og:image:url"]);
  const icon = iconHref(html);
  const description = metaContent(html, ["og:description", "description", "twitter:description"])?.trim();
  return {
    imageUrl: image !== null ? absolutize(url, image) : null,
    // Rust chains `icon_href(..).and_then(absolutize).or_else(|| absolutize(url, "/favicon.ico"))`:
    // a DECLARED icon that fails to absolutize (a `data:` favicon, a
    // `javascript:` href) still falls back to the conventional path. Writing
    // this as an if/else on `icon` — as both candidate ports did — loses that
    // fallback and leaves such a page with NO icon at all.
    iconUrl: (icon !== null ? absolutize(url, icon) : null) ?? absolutize(url, "/favicon.ico"),
    description: description !== undefined && description !== "" ? description : null,
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
