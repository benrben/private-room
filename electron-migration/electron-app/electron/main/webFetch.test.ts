/**
 * Coverage for `webFetch.ts` — the port of `src-tauri/src/web/fetch.rs`.
 *
 * Its own `#[cfg(test)]`/`preview_tests` modules are the baseline for the
 * pure-function cases; everything network-shaped is driven against a REAL
 * `node:http` server (this repo's "real behavior over mocks" convention),
 * never a patched client. That is what lets the streaming byte caps and the
 * per-hop redirect guard be tested as BEHAVIOUR rather than as a unit check of
 * a constant — the gap the Rust suite itself has.
 *
 * THE ONE THING MOCKED is `resolvePublicAddr`, and only for two fixed fake
 * hostnames:
 *   - `safehost.example` → 127.0.0.1, so a real local test server can look
 *     "public" for connection-pinning purposes without touching real DNS;
 *   - `rebinder.example` → 10.0.0.9, classified by the REAL, unmocked
 *     `isPublicIp` — a name that looks fine and resolves private, which is the
 *     DNS-rebinding-through-a-redirect case.
 * `checkPublicHttpUrl` (the literal-address/hostname classifier) is left
 * completely real throughout, so every SECURITY decision still runs the actual
 * guard code from `browser/guard.ts`.
 */

import http from "node:http";
import tls from "node:tls";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const TEST_HOST = "safehost.example";
const REBIND_HOST = "rebinder.example";
/** A public IP LITERAL (TEST-NET-3, which the guard treats as public), pinned
 * onto the local TLS server so the RFC 6066 "no IP in SNI" case is reachable. */
const TLS_IP_HOST = "203.0.113.7";
const PRIVATE_BLOCKED = "This address points to a private network and was blocked.";

vi.mock("./browser/guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./browser/guard.js")>();
  return {
    ...actual,
    resolvePublicAddr: vi.fn(async (host: string, port: number) => {
      if (host === TEST_HOST) {
        return { address: "127.0.0.1", port };
      }
      if (host === TLS_IP_HOST) {
        return { address: "127.0.0.1", port };
      }
      if (host === REBIND_HOST) {
        // A fake DNS answer, classified by the REAL guard: the rebind is
        // caught by production code, not by the test double.
        if (!actual.isPublicIp("10.0.0.9")) {
          throw new Error(PRIVATE_BLOCKED);
        }
        return { address: "10.0.0.9", port };
      }
      // Everything else (in particular a literal private IP a redirect points
      // at) gets the REAL check.
      return actual.resolvePublicAddr(host, port);
    }),
  };
});

import { resolvePublicAddr } from "./browser/guard.js";
import {
  bodyCappedTo,
  decodeBody,
  dispositionFileName,
  downloadToTemp,
  extractCaptionTracks,
  fetchImage,
  fetchPage,
  fetchPreview,
  fetchReadable,
  guessDownloadMime,
  guardedGet,
  htmlTitle,
  MAX_FETCH_BYTES,
  MAX_PREVIEW_IMAGE_BYTES,
  previewFromHtml,
  redirectTarget,
  safeFileName,
  timedtextJson3ToLines,
  youtubeTranscript,
  youtubeVideoId,
} from "./webFetch.js";

describe("download MIME routing", () => {
  it.each([
    ["clip.mov", "video/quicktime"],
    ["clip.webm", "video/webm"],
    ["clip.mkv", "video/x-matroska"],
    ["sound.mp3", "audio/mpeg"],
    ["sound.wav", "audio/wav"],
    ["sound.m4a", "audio/mp4"],
    ["sound.flac", "audio/flac"],
    ["sound.ogg", "audio/ogg"],
    ["sound.opus", "audio/ogg"],
    ["photo.avif", "image/avif"],
  ] as const)("maps %s to %s", (name, expected) => {
    expect(guessDownloadMime(name)).toBe(expected);
  });

  it("routes TIFF to the image surface after the worker decoder ships", () => {
    expect(guessDownloadMime("scan.tiff")).toBe("image/tiff");
    expect(guessDownloadMime("scan.tif")).toBe("image/tiff");
  });
});

let server: http.Server | undefined;
let tlsServer: tls.Server | undefined;
const tmpDirs: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  if (server !== undefined) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  if (tlsServer !== undefined) {
    const srv = tlsServer;
    tlsServer = undefined;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Start a real server on loopback, reachable through the guard as
 * `http://safehost.example:<port>` (see the module doc's DNS-pinning mock). */
async function listenOn(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://${TEST_HOST}:${port}`;
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "web-fetch-"));
  tmpDirs.push(dir);
  return dir;
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// ============================================================ pure functions

describe("redirectTarget", () => {
  const from = new URL("https://example.com/a/b");

  it("resolves a relative Location against the URL it came from", () => {
    expect(redirectTarget(302, "/next", from)).toBe("https://example.com/next");
  });

  it("keeps an absolute, even cross-origin, Location — the hop the guard must re-check", () => {
    expect(redirectTarget(301, "http://127.0.0.1:11434/api", from)).toBe("http://127.0.0.1:11434/api");
  });

  it("recognises every redirect status", () => {
    for (const status of [301, 302, 303, 307, 308]) {
      expect(redirectTarget(status, "/x", from)).not.toBeNull();
    }
  });

  it("falls through to normal status handling for a non-redirect, or a redirect with nothing to follow", () => {
    expect(redirectTarget(200, "/x", from)).toBeNull();
    expect(redirectTarget(404, "/x", from)).toBeNull();
    expect(redirectTarget(302, undefined, from)).toBeNull();
    expect(redirectTarget(302, null, from)).toBeNull();
    expect(redirectTarget(302, "   ", from)).toBeNull();
  });
});

describe("htmlTitle", () => {
  it("extracts and entity-decodes a page title", () => {
    expect(htmlTitle("<html><head><TITLE>Hello &amp; more</TITLE></head>")).toBe("Hello & more");
  });

  it("is null when there is no title tag", () => {
    expect(htmlTitle("<html><head></head></html>")).toBeNull();
  });
});

describe("decodeBody", () => {
  it("decodes per the Content-Type charset — the legacy-Hebrew-page case", () => {
    const heb = Buffer.from([0xf9, 0xec, 0xe5, 0xed]);
    expect(decodeBody(heb, "text/html; charset=windows-1255")).toBe("שלום");
    expect(decodeBody(heb, 'text/html; charset="windows-1255"')).toBe("שלום");
  });

  it("reads the charset parameter case-insensitively", () => {
    const heb = Buffer.from([0xf9, 0xec, 0xe5, 0xed]);
    expect(decodeBody(heb, "text/html; CHARSET=windows-1255")).toBe("שלום");
  });

  it("falls back to lossy UTF-8 for an absent or unknown charset", () => {
    expect(decodeBody(Buffer.from("שלום", "utf8"), "text/html")).toBe("שלום");
    expect(decodeBody(Buffer.from("plain"), "text/plain; charset=bogus")).toBe("plain");
  });
});

describe("safeFileName (reused from browser/downloads.ts)", () => {
  it("sanitizes into a safe filename", () => {
    expect(safeFileName("report.pdf")).toBe("report.pdf");
    expect(safeFileName("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(safeFileName("a b;rm -rf /")).toBe("a_b_rm_-rf__");
    expect(Array.from(safeFileName("x".repeat(500))).length).toBeLessThanOrEqual(80);
  });

  it("never becomes an empty or traversal-only path component", () => {
    expect(safeFileName("")).toBe("download");
    expect(safeFileName("..")).toBe("download");
    expect(safeFileName("///")).toBe("download");
  });

  it("keeps non-ASCII letters, because Rust's char::is_alphanumeric() is Unicode-aware", () => {
    // An ASCII-only `[a-zA-Z0-9]` re-port mangles this to "h_llo_w_rld.pdf".
    expect(safeFileName("héllo wörld.pdf")).toBe("héllo_wörld.pdf");
  });
});

describe("dispositionFileName", () => {
  it("reads both the plain and the extended (RFC 5987) forms", () => {
    expect(dispositionFileName('attachment; filename="report q3.pdf"')).toBe("report q3.pdf");
    expect(dispositionFileName("attachment; filename*=UTF-8''data.csv")).toBe("data.csv");
    expect(dispositionFileName("inline")).toBeNull();
  });

  it("takes the value after the LAST '' in an extended form", () => {
    expect(dispositionFileName("attachment; filename*=UTF-8''a''b.csv")).toBe("b.csv");
  });

  it("skips a filename that is only quotes rather than returning an empty name", () => {
    expect(dispositionFileName('attachment; filename=""; filename="real.pdf"')).toBe("real.pdf");
  });
});

describe("youtubeVideoId", () => {
  it("recognises every watch/short/embed/youtu.be shape", () => {
    const cases: Array<[string, string | null]> = [
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
      ["https://youtu.be/dQw4w9WgXcQ?t=42", "dQw4w9WgXcQ"],
      ["https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=x", "dQw4w9WgXcQ"],
      ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
      ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
      ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
      ["https://example.com/watch?v=dQw4w9WgXcQ", null],
      ["https://www.youtube.com/feed/history", null],
      ["https://www.youtube.com/shorts/", null],
      ["not a url", null],
    ];
    for (const [url, want] of cases) {
      expect(youtubeVideoId(url), url).toBe(want);
    }
  });

  it("strips a repeated host prefix, matching Rust's trim_start_matches", () => {
    // `String.replace(/^www\./, "")` only strips ONE — Rust strips every one.
    expect(youtubeVideoId("https://www.www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
});

describe("extractCaptionTracks", () => {
  it("walks the JSON array out of the page soup with string/escape awareness", () => {
    const html =
      'junk"captionTracks":[{"baseUrl":"https://yt/api?x=1&lang=en","kind":"asr","languageCode":"en"},' +
      '{"baseUrl":"https://yt/api?x=2","languageCode":"he"}],"other":1 junk';
    const tracks = extractCaptionTracks(html);
    expect(tracks).toHaveLength(2);
    expect((tracks![0] as Record<string, unknown>).baseUrl).toBe("https://yt/api?x=1&lang=en");
    expect((tracks![1] as Record<string, unknown>).kind).toBeUndefined();
    expect(extractCaptionTracks("no captions here")).toBeNull();
  });

  it("is not fooled by a ']' inside a JSON string", () => {
    const html = 'x"captionTracks":[{"baseUrl":"https://yt/a]b","kind":"asr"}] rest';
    const tracks = extractCaptionTracks(html);
    expect(tracks).toHaveLength(1);
    expect((tracks![0] as Record<string, unknown>).baseUrl).toBe("https://yt/a]b");
  });
});

describe("timedtextJson3ToLines", () => {
  it("turns events into [m:ss] lines, skipping aAppend re-sends and empty text", () => {
    const json = JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: "Hello " }, { utf8: "world" }] },
        { tStartMs: 65000, aAppend: 1, segs: [{ utf8: "repeat" }] },
        { tStartMs: 65000, segs: [{ utf8: "\n" }] },
        { tStartMs: 75400, segs: [{ utf8: "Second line" }] },
      ],
    });
    expect(timedtextJson3ToLines(json)).toBe("[0:00] Hello world\n[1:15] Second line");
    expect(timedtextJson3ToLines(JSON.stringify({ events: [] }))).toBeNull();
    expect(timedtextJson3ToLines("not json")).toBeNull();
  });

  it("uses an h:mm:ss stamp past the hour", () => {
    const json = JSON.stringify({ events: [{ tStartMs: 3_723_000, segs: [{ utf8: "late" }] }] });
    expect(timedtextJson3ToLines(json)).toBe("[1:02:03] late");
  });
});

describe("previewFromHtml", () => {
  const PAGE = `<html><head>
    <title>Fallback title</title>
    <meta property="og:title" content="Speaker diarisation">
    <meta property="og:image" content="/img/hero.png">
    <meta name="description" content="Who spoke &amp; when.">
    <link rel="shortcut icon" href="https://cdn.example.com/i.png">
  </head><body><main>Body text here.</main></body></html>`;

  it("reads og:image, description, title and icon", () => {
    const p = previewFromHtml("https://example.com/a/b", PAGE);
    expect(p.imageUrl).toBe("https://example.com/img/hero.png");
    expect(p.iconUrl).toBe("https://cdn.example.com/i.png");
    expect(p.description).toBe("Who spoke & when.");
    expect(p.title).toBe("Speaker diarisation");
    expect(p.text).toContain("Body text here.");
  });

  it("decodes the same entities the page body does (regression: a private 5-entity chain double-unescaped &amp;)", () => {
    const page = `<html><head>
      <meta property="og:title" content="Python 3.13 &#8212; what&#8217;s new">
      <meta name="description" content="Escaping &amp;lt;div&amp;gt; in prose">
    </head><body>x</body></html>`;
    const p = previewFromHtml("https://example.com/", page);
    expect(p.title).toBe("Python 3.13 — what’s new");
    expect(p.description).toBe("Escaping &lt;div&gt; in prose");
  });

  it("falls back to the <title> tag when there is no og:title", () => {
    const p = previewFromHtml("https://example.com/", "<html><head><title>Plain</title></head></html>");
    expect(p.title).toBe("Plain");
    expect(p.imageUrl).toBeNull();
  });

  it("reports no preview image (never a broken slot) but still the conventional favicon path", () => {
    const p = previewFromHtml("https://example.com/", "<html><head></head><body>x</body></html>");
    expect(p.imageUrl).toBeNull();
    expect(p.iconUrl).toBe("https://example.com/favicon.ico");
  });

  it("a DECLARED but unusable icon still falls back to /favicon.ico (Rust's and_then/or_else chain)", () => {
    // Regression against both candidate ports, which wrote this as an
    // if/else on "did the page declare an icon" and so left a page with a
    // `data:` favicon carrying NO icon at all.
    const html = '<link rel="icon" href="data:image/png;base64,AAA">';
    expect(previewFromHtml("https://example.com/p/q", html).iconUrl).toBe("https://example.com/favicon.ico");
  });

  it("a data: asset URL must never reach the fetcher", () => {
    const html = '<meta property="og:image" content="data:image/png;base64,AAA">';
    expect(previewFromHtml("https://example.com/", html).imageUrl).toBeNull();
  });

  it("resolves protocol-relative and single-quoted-attribute images", () => {
    const html = '<meta property="og:image" content="//cdn.example.com/a.jpg">';
    expect(previewFromHtml("https://example.com/p", html).imageUrl).toBe("https://cdn.example.com/a.jpg");
    const single = "<meta property='og:image' content='https://a.com/x.png'>";
    expect(previewFromHtml("https://a.com/", single).imageUrl).toBe("https://a.com/x.png");
  });
});

// ================================================== bodyCappedTo, unit-level

/** A response whose body arrives in SEVERAL chunks, so an oversize that only
 * shows up on the running total is the thing under test — not one buffer whose
 * size was knowable up front. */
function chunked(chunks: readonly Buffer[], headers: http.IncomingHttpHeaders = {}) {
  return { headers, stream: Readable.from(chunks) };
}

function bytes(n: number, fill: number): Buffer {
  return Buffer.alloc(n, fill);
}

describe("bodyCappedTo", () => {
  it("rejects on a declared oversize Content-Length before reading any body", async () => {
    await expect(bodyCappedTo(chunked([bytes(10, 1)], { "content-length": "999999" }), 100, false, "too large")).rejects.toThrow(
      "too large"
    );
  });

  it("rejects a body that crosses the cap only ACROSS chunks, with no declared length", async () => {
    await expect(bodyCappedTo(chunked([bytes(40, 1), bytes(40, 2), bytes(40, 3)]), 100, false, "too large")).rejects.toThrow(
      "too large"
    );
  });

  it("an UNDERSTATED Content-Length does not exempt a body from the real streamed cap", async () => {
    const resp = chunked([bytes(60, 1), bytes(60, 2)], { "content-length": "10" });
    await expect(bodyCappedTo(resp, 100, false, "too large")).rejects.toThrow("too large");
  });

  it("truncate keeps exactly `limit` bytes, and they are the FIRST bytes of the real stream", async () => {
    const out = await bodyCappedTo(chunked([bytes(40, 1), bytes(40, 2), bytes(40, 3)]), 100, true, "too large");
    expect(out.length).toBe(100);
    expect(out.subarray(0, 40).every((b) => b === 1)).toBe(true);
    expect(out.subarray(40, 80).every((b) => b === 2)).toBe(true);
    expect(out.subarray(80, 100).every((b) => b === 3)).toBe(true);
  });

  it("a body under the cap is read whole", async () => {
    const out = await bodyCappedTo(chunked([bytes(10, 7), bytes(5, 8)]), 100, false, "too large");
    expect(out.length).toBe(15);
  });

  it("a body exactly at the cap is kept, not refused", async () => {
    const out = await bodyCappedTo(chunked([bytes(100, 9)]), 100, false, "too large");
    expect(out.length).toBe(100);
  });
});

// ==================================================== guardedGet / fetchPage

describe("guardedGet — SSRF-guarded, per-hop redirect following", () => {
  it("follows a redirect chain, re-checking AND re-resolving EVERY hop (never just the first)", async () => {
    const base = await listenOn((req, res) => {
      if (req.url === "/hop1") {
        res.writeHead(302, { location: `${base}/hop2` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("final content");
    });
    const resp = await guardedGet(`${base}/hop1`);
    const raw = await streamToBuffer(resp.stream);
    expect(raw.toString("utf8")).toBe("final content");
    expect(resp.finalUrl).toBe(`${base}/hop2`);
    // SEC-5: the redirect target got its OWN resolve+pin. A weaker guard that
    // only checked the first URL would call this once.
    expect(vi.mocked(resolvePublicAddr)).toHaveBeenCalledTimes(2);
  });

  it("a redirect to a literal private address is blocked FOR REAL, with no mocking in the rejection", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:1/private" });
      res.end();
    });
    // Hop 1 looks public and is reachable; hop 2 is where the real, UNMOCKED
    // `checkPublicHttpUrl` fires.
    await expect(guardedGet(`${base}/redirect-to-private`)).rejects.toThrow(
      "Local and private-network addresses cannot be fetched."
    );
  });

  it("DNS rebinding via a redirect: a public-LOOKING name that RESOLVES private is blocked, and never connected to", async () => {
    let hopsServed = 0;
    const base = await listenOn((_req, res) => {
      hopsServed += 1;
      res.writeHead(302, { location: `http://${REBIND_HOST}/secret` });
      res.end();
    });
    // The literal check on `rebinder.example` passes — it is an ordinary name.
    // Only the per-hop RESOLVE reveals the rebind, which is exactly what a
    // first-hop-only guard would miss.
    await expect(guardedGet(`${base}/start`)).rejects.toThrow(PRIVATE_BLOCKED);
    expect(hopsServed).toBe(1);
  });

  it("bounds the redirect chain rather than following it forever", async () => {
    const base = await listenOn((req, res) => {
      res.writeHead(302, { location: `${base}${req.url}` });
      res.end();
    });
    await expect(guardedGet(`${base}/loop`)).rejects.toThrow("Too many redirects.");
    // 6 attempts (MAX_REDIRECTS = 5, plus the initial one) — bounded.
    expect(vi.mocked(resolvePublicAddr)).toHaveBeenCalledTimes(6);
  });

  it("a non-2xx status is a real error naming the status code", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
    });
    await expect(guardedGet(`${base}/missing`)).rejects.toThrow("The page returned HTTP 404.");
  });

  it("refuses a non-http(s) scheme and a local name before any resolve is attempted", async () => {
    await expect(guardedGet("file:///etc/passwd")).rejects.toThrow("Only http(s) URLs can be fetched.");
    await expect(guardedGet("http://localhost.:11434/api/tags")).rejects.toThrow(
      "Local and private-network addresses cannot be fetched."
    );
    expect(vi.mocked(resolvePublicAddr)).not.toHaveBeenCalled();
  });

  it("resolves an IPv6 literal by its BRACKETLESS address — brackets belong to the Host header, not to DNS", async () => {
    // `new URL(...).hostname` keeps the brackets; handing "[2606:…]" to
    // dns.lookup fails, so a public IPv6 literal would be unreachable.
    await expect(guardedGet("http://[2606:4700:4700::1111]/x")).rejects.toThrow();
    expect(vi.mocked(resolvePublicAddr)).toHaveBeenCalledWith("2606:4700:4700::1111", 80);
  });
});

describe("guardedGet over TLS — the pin must not cost certificate identity", () => {
  /** A real TLS listener with NO certificate: the handshake is parsed far
   * enough to fire `SNICallback` (which is what this asserts on) and then
   * fails, so the client's own refusal is also observed. Generating a
   * throwaway X.509 chain would add a dependency to prove less. */
  async function listenTls(): Promise<{ port: number; sni: () => string | null }> {
    let seen: string | null = null;
    const srv = tls.createServer({
      SNICallback: (name, cb) => {
        seen = name;
        cb(new Error("no certificate configured"), null as unknown as tls.SecureContext);
      },
    });
    srv.on("tlsClientError", () => {});
    tlsServer = srv;
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    return { port: (srv.address() as AddressInfo).port, sni: () => seen };
  }

  it("sends the ORIGINAL hostname as SNI even though the socket dials the pinned address", async () => {
    // This is the whole reason `servername` is set by hand: without it Node
    // would validate the leaf certificate against the IP literal it connected
    // to, and every guarded HTTPS fetch would look like a TLS outage.
    const { port, sni } = await listenTls();
    await expect(fetchPage(`https://${TEST_HOST}:${port}/p`)).rejects.toThrow(/Could not fetch the page/);
    expect(sni()).toBe(TEST_HOST);
  });

  it("sends NO SNI for an IP-literal host (RFC 6066), rather than an illegal one", async () => {
    const { port, sni } = await listenTls();
    await expect(fetchPage(`https://${TLS_IP_HOST}:${port}/p`)).rejects.toThrow(/Could not fetch the page/);
    expect(sni()).toBeNull();
  });

  it("a TLS failure is a refusal, never a silently-downgraded plaintext fetch", async () => {
    const { port } = await listenTls();
    await expect(fetchPage(`https://${TEST_HOST}:${port}/p`)).rejects.toThrow();
  });
});

describe("streaming byte-cap enforcement — a real oversized response, not a unit check of a constant", () => {
  /** Streams 1 MiB chunks on an interval so a client that read to completion
   * would take a very long time (or run this test out of memory) — proof that
   * the cap is a STREAMING cut-off, not a post-hoc size check. */
  function streamForever(res: http.ServerResponse, onChunkSent: (total: number) => void): void {
    res.writeHead(200, { "content-type": "text/plain" });
    const chunk = Buffer.alloc(1024 * 1024, "a");
    let sent = 0;
    const iv = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(iv);
        return;
      }
      // A safety net so a BROKEN cap (one that never destroys the connection)
      // fails this test promptly instead of hanging forever.
      if (sent >= 64) {
        clearInterval(iv);
        res.end();
        return;
      }
      res.write(chunk);
      sent += 1;
      onChunkSent(sent * chunk.length);
    }, 2);
    res.on("close", () => clearInterval(iv));
  }

  it("fetchReadable (truncate=false) rejects with TOO_LARGE and stops reading — never buffers the whole body", async () => {
    let bytesServerSent = 0;
    let serverConnectionClosed = false;
    const base = await listenOn((_req, res) => {
      streamForever(res, (total) => {
        bytesServerSent = total;
      });
      res.on("close", () => {
        serverConnectionClosed = true;
      });
    });
    const startedAt = Date.now();
    await expect(fetchReadable(`${base}/huge`)).rejects.toThrow("The page is too large to fetch.");
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(bytesServerSent).toBeLessThan(64 * 1024 * 1024);
    await vi.waitFor(() => expect(serverConnectionClosed).toBe(true), { timeout: 2_000 });
  });

  it("fetchPage (truncate=true) also stops reading early — no error, but the connection is cut at the cap", async () => {
    let bytesServerSent = 0;
    const base = await listenOn((_req, res) => {
      streamForever(res, (total) => {
        bytesServerSent = total;
      });
    });
    const startedAt = Date.now();
    const page = await fetchPage(`${base}/huge`);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(bytesServerSent).toBeLessThan(64 * 1024 * 1024);
    // The final text is further capped to MAX_PAGE_CHARS and marked truncated.
    expect(page.text.endsWith("\n… (truncated)")).toBe(true);
    expect(page.text.length).toBeLessThan(210_000);
  });

  it("rejects a declared oversize Content-Length before reading ANY body bytes (truncate=false)", async () => {
    let connectionClosedByClient = false;
    const base = await listenOn((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-length": String(MAX_FETCH_BYTES + 1),
      });
      // Headers only, flushed explicitly — the body is deliberately never
      // written: if the client tried to read it, this test would hang.
      res.flushHeaders();
      res.socket?.on("close", () => {
        connectionClosedByClient = true;
      });
    });
    await expect(fetchReadable(`${base}/declared-huge`)).rejects.toThrow("The page is too large to fetch.");
    await vi.waitFor(() => expect(connectionClosedByClient).toBe(true), { timeout: 2_000 });
  });
});

describe("fetchPage", () => {
  it("fetches a text page, reduces HTML to readable text, and reports where it landed", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><head><title>My Page</title></head><body><main>Hello there.</main></body></html>");
    });
    const page = await fetchPage(`${base}/p`);
    expect(page.title).toBe("My Page");
    expect(page.text).toContain("Hello there.");
    expect(page.finalUrl).toBe(`${base}/p`);
    expect(page.status).toBe(200);
  });

  it("carries the query string through to the server", async () => {
    let seen: string | undefined;
    const base = await listenOn((req, res) => {
      seen = req.url;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await fetchPage(`${base}/search?q=hello%20world&n=2`);
    expect(seen).toBe("/search?q=hello%20world&n=2");
  });

  it("sends the ORIGINAL hostname as the Host header even though it connects to the pinned address", async () => {
    let host: string | undefined;
    const base = await listenOn((req, res) => {
      host = req.headers.host;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await fetchPage(`${base}/p`);
    expect(host?.startsWith(`${TEST_HOST}:`)).toBe(true);
  });

  it("refuses a non-textual content type", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([0, 1, 2]));
    });
    await expect(fetchPage(`${base}/img`)).rejects.toThrow(/not a text page/);
  });

  it("uses the URL itself as the title when the page declares none", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("just text");
    });
    expect((await fetchPage(`${base}/notitle`)).title).toBe(`${base}/notitle`);
  });
});

describe("fetchReadable", () => {
  it("prefers the Readability article text when the page has one", async () => {
    const html =
      "<html><head><title>Article</title></head><body><article><p>" +
      "This is a long enough paragraph of real article content to clear Readability's own minimum " +
      "article length threshold so the extraction actually keeps it rather than falling back to a " +
      "plain tag-strip of the whole page, which is the behavior this test is distinguishing from." +
      "</p></article></body></html>";
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
    });
    const { title, text, raw } = await fetchReadable(`${base}/article`);
    expect(title).toBe("Article");
    expect(text).toContain("long enough paragraph");
    expect(raw.toString("utf8")).toBe(html);
  });

  it("falls back to strip_html for a page with no extractable article", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><nav>menu</nav><p>hi</p></body></html>");
    });
    const { text } = await fetchReadable(`${base}/shell`);
    expect(text).toContain("hi");
    expect(text).not.toContain("menu");
  });
});

// ============================================================== downloadToTemp

describe("downloadToTemp", () => {
  it("downloads a file, honoring the Content-Disposition filename and declared mime", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="report q3.pdf"',
      });
      res.end("pdf-bytes-stand-in");
    });
    const dir = tempDir();
    const outcome = await downloadToTemp(`${base}/f`, 1024, null, () => {}, dir);
    expect(outcome.kind).toBe("done");
    if (outcome.kind === "done") {
      expect(outcome.downloaded.fileName).toBe("report_q3.pdf");
      expect(outcome.downloaded.mime).toBe("application/pdf");
      expect(outcome.downloaded.sizeBytes).toBe(Buffer.byteLength("pdf-bytes-stand-in"));
      expect(readdirSync(dir)).toHaveLength(1);
    }
  });

  it("guesses a mime from the extension when the server sends octet-stream", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="photo.png"',
      });
      res.end("png-bytes");
    });
    const dir = tempDir();
    const outcome = await downloadToTemp(`${base}/f`, 1024, null, () => {}, dir);
    expect(outcome.kind === "done" && outcome.downloaded.mime).toBe("image/png");
  });

  it("falls back to the URL's last path segment when there is no Content-Disposition", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "text/csv" });
      res.end("a,b");
    });
    const dir = tempDir();
    const outcome = await downloadToTemp(`${base}/data/table.csv`, 1024, null, () => {}, dir);
    expect(outcome.kind === "done" && outcome.downloaded.fileName).toBe("table.csv");
  });

  it("rejects a declared oversize download before reading any bytes", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "video/mp4", "content-length": "10000" });
      res.flushHeaders();
    });
    const dir = tempDir();
    const outcome = await downloadToTemp(`${base}/f`, 100, null, () => {}, dir);
    expect(outcome.kind).toBe("tooLarge");
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("stops and removes the partial file once an UNDECLARED download crosses the cap mid-stream", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "video/mp4" }); // no content-length
      res.write(Buffer.alloc(200, "a"));
      res.write(Buffer.alloc(200, "a"));
      res.end();
    });
    const dir = tempDir();
    const outcome = await downloadToTemp(`${base}/f`, 300, null, () => {}, dir);
    expect(outcome.kind).toBe("tooLarge");
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("a cancel flag set mid-download stops it, throws 'Stopped.' and removes the partial file", async () => {
    let sendSecondChunk: (() => void) | undefined;
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "video/mp4" });
      res.write(Buffer.alloc(50, "a"));
      sendSecondChunk = () => {
        res.write(Buffer.alloc(50, "a"));
        res.end();
      };
    });
    const dir = tempDir();
    const cancel = { flagged: false, load: () => cancel.flagged };
    const progress = vi.fn((soFar: number) => {
      if (soFar > 0) {
        cancel.flagged = true;
        queueMicrotask(() => sendSecondChunk?.());
      }
    });
    await expect(downloadToTemp(`${base}/f`, 10_000, cancel, progress, dir)).rejects.toThrow("Stopped.");
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("an ALREADY-cancelled download writes nothing at all (Rust polls the flag at the top of the loop)", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "video/mp4" });
      res.end(Buffer.alloc(50, "a"));
    });
    const dir = tempDir();
    const progress = vi.fn();
    await expect(downloadToTemp(`${base}/f`, 10_000, { load: () => true }, progress, dir)).rejects.toThrow("Stopped.");
    expect(progress).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

// ================================================================ YouTube (ADD-19)

describe("youtubeTranscript — end-to-end over a fake watch page + timedtext endpoint", () => {
  it("prefers a manual caption track over an auto-generated one, and timestamps every line", async () => {
    const base = await listenOn((req, res) => {
      if (req.url === "/watch") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          `<html><head><title>My Video - YouTube</title></head><body>` +
            `junk"captionTracks":[` +
            `{"baseUrl":"${base}/timedtext?lang=en","kind":"asr"},` +
            `{"baseUrl":"${base}/timedtext?lang=he"}` +
            `],"other":1 junk</body></html>`
        );
        return;
      }
      if (req.url?.startsWith("/timedtext")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            events: [
              { tStartMs: 0, segs: [{ utf8: "Hello " }, { utf8: "world" }] },
              { tStartMs: 75400, segs: [{ utf8: "Second line" }] },
            ],
          })
        );
        return;
      }
      res.writeHead(404).end();
    });
    const { title, transcript } = await youtubeTranscript(`${base}/watch`);
    expect(title).toBe("My Video");
    expect(transcript).toBe("[0:00] Hello world\n[1:15] Second line");
  });

  it("reports no captions rather than fabricating a transcript", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>No captions</title></head><body>nothing here</body></html>");
    });
    await expect(youtubeTranscript(`${base}/watch`)).rejects.toThrow(
      "This video has no captions/transcript to import."
    );
  });

  it("puts the caption track's own baseUrl through the SAME guard — a private one is refused, not followed", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<html><head><title>V - YouTube</title></head><body>` +
          `"captionTracks":[{"baseUrl":"http://127.0.0.1:11434/api"}]</body></html>`
      );
    });
    await expect(youtubeTranscript(`${base}/watch`)).rejects.toThrow(
      "Local and private-network addresses cannot be fetched."
    );
  });
});

// ========================================================= previews (BROWSE-3b)

describe("fetchPreview / fetchImage", () => {
  it("fetchPreview reads a result page's metadata over the network", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<html><head><title>T</title><meta property="og:image" content="/hero.png"></head><body>x</body></html>'
      );
    });
    const preview = await fetchPreview(`${base}/result`);
    expect(preview.title).toBe("T");
    expect(preview.imageUrl).toBe(`${base}/hero.png`);
  });

  it("fetchImage refuses a non-image content type", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html></html>");
    });
    await expect(fetchImage(`${base}/notanimage`)).rejects.toThrow(/Not an image/);
  });

  it("fetchImage caps at the card's own image budget, not the page budget", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.alloc(MAX_PREVIEW_IMAGE_BYTES + 1024, 1));
    });
    await expect(fetchImage(`${base}/big.png`)).rejects.toThrow("Preview image is too large.");
  });

  it("fetchImage returns the bytes for a normal-sized image", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([1, 2, 3, 4]));
    });
    const { mime, bytes: got } = await fetchImage(`${base}/small.png`);
    expect(mime).toBe("image/png");
    expect(got.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
  });
});
