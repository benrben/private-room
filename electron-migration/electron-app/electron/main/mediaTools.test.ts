/**
 * Tests for `mediaTools.ts` — `commands/media.rs`'s port. Every case named
 * after a Rust `#[test]` reproduces that test verbatim (same inputs, same
 * expectations); cases with no Rust counterpart are called out as such.
 */

import { describe, expect, it } from "vitest";
import {
  clearMedia,
  createMediaStreams,
  MAX_STAGED,
  MAX_STAGED_BYTES,
  mediaResponse,
  parseRange,
  playableMediaMime,
  stageMediaBytes,
  type MediaStreams,
} from "./mediaTools.js";

function stagedWith(bytes: Buffer): MediaStreams {
  const s = createMediaStreams();
  stageMediaBytes(s, bytes, "video/mp4");
  return s;
}

function onlyToken(s: MediaStreams): string {
  const [token] = s.map.keys();
  if (token === undefined) {
    throw new Error("expected exactly one staged entry");
  }
  return token;
}

function headerValue(headers: [string, string][], name: string): string | undefined {
  return headers.find(([k]) => k === name)?.[1];
}

// ------------------------------------------------------------------- parseRange

describe("parseRange", () => {
  // Rust: range_parsing_covers_the_grammar — plain span, clamped end, open
  // end, suffix, and the invalid shapes, reproduced case by case.
  it("covers the grammar", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual([0, 9]);
    expect(parseRange("bytes=10-", 100)).toEqual([10, 99]);
    expect(parseRange("bytes=0-500", 100)).toEqual([0, 99]);
    expect(parseRange("bytes=-10", 100)).toEqual([90, 99]);
    expect(parseRange("bytes=-500", 100)).toEqual([0, 99]);
    expect(parseRange("bytes=100-", 100)).toBeNull(); // start past end
    expect(parseRange("bytes=9-3", 100)).toBeNull(); // inverted
    expect(parseRange("chunks=0-9", 100)).toBeNull(); // wrong unit
    expect(parseRange("bytes=a-b", 100)).toBeNull(); // garbage
    expect(parseRange("bytes=0-0", 0)).toBeNull(); // empty body
  });

  // Not in the Rust `#[test]` list, but exercises the two grammar quirks
  // this port's doc calls out explicitly: the first-dash split (so a second
  // dash inside `end_s` makes it an invalid number, not a wider range) and
  // internal whitespace around the dash surviving the same way Rust's own
  // `start_s.trim()`/`end_s.trim()` handle it.
  it("splits on the FIRST dash only, and tolerates internal whitespace", () => {
    expect(parseRange("bytes=10-20-30", 100)).toBeNull();
    expect(parseRange("bytes= 0 - 9 ", 100)).toEqual([0, 9]);
  });

  // A decimal point is not valid `u64` text; a naive `Number()` coercion
  // would accept it. (A leading `+` IS valid — see the next case.)
  it("refuses fractional numbers a naive Number() coercion would accept", () => {
    expect(parseRange("bytes=0-9.5", 100)).toBeNull();
    expect(parseRange("bytes=1e3-", 100)).toBeNull();
    expect(parseRange("bytes=0x10-", 100)).toBeNull();
    expect(parseRange("bytes=-0", 100)).toBeNull(); // suffix "0 bytes" is not > 0
  });

  // Not a Rust `#[test]`, but pinned against the REAL `u64::from_str`
  // (verified by compiling `media.rs`'s own `parse_range` and running it):
  // `from_str_radix` strips a leading `+` for unsigned types, so all three of
  // these parse in the shipped app. A digits-only guard answered 416 for a
  // header Rust serves.
  it("accepts a leading '+' exactly as Rust's u64::from_str does", () => {
    expect(parseRange("bytes=+0-9", 100)).toEqual([0, 9]);
    expect(parseRange("bytes=+5-", 100)).toEqual([5, 99]);
    expect(parseRange("bytes=-+5", 100)).toEqual([95, 99]); // suffix form
    expect(parseRange("bytes=-5-", 100)).toBeNull(); // '-' is never a u64 sign
  });

  // The oversized-value boundary. Rust's `end_s.parse::<u64>().ok()?` FAILS on
  // a value past u64::MAX and the caller answers 416; a `Number()` coercion
  // silently produced 1e23, `.min(len - 1)` clamped it, and the handler served
  // a 206 whose Content-Range claimed the whole body.
  it("treats a number past u64::MAX as unparseable, not as a clamped maximum", () => {
    expect(parseRange("bytes=0-18446744073709551615", 100)).toEqual([0, 99]); // u64::MAX itself
    expect(parseRange("bytes=0-18446744073709551616", 100)).toBeNull(); // one past it
    expect(parseRange("bytes=0-99999999999999999999999", 100)).toBeNull();
    expect(parseRange("bytes=-99999999999999999999999", 100)).toBeNull(); // suffix form
    expect(parseRange("bytes=99999999999999999999999-", 100)).toBeNull(); // start form
  });
});

// ------------------------------------------------------------- playableMediaMime

describe("playableMediaMime", () => {
  it("maps every m4a-flavored label to audio/mp4", () => {
    for (const m of ["audio/m4a", "audio/x-m4a", "audio/mp4a-latm", "audio/aac"]) {
      expect(playableMediaMime(m, "m4a", false)).toBe("audio/mp4");
    }
  });

  it("passes through a real, non-octet-stream mime — LOWERCASED", () => {
    // The easy-to-miss Rust behavior this port's doc flags: the passthrough
    // branch returns the lowercased binding, not the caller's original casing.
    expect(playableMediaMime("Video/MP4", "mp4", true)).toBe("video/mp4");
    expect(playableMediaMime("TEXT/PLAIN", "txt", false)).toBe("text/plain");
  });

  it("falls back to the extension when the mime is empty or octet-stream", () => {
    expect(playableMediaMime("", "mov", true)).toBe("video/quicktime");
    expect(playableMediaMime("application/octet-stream", "mov", true)).toBe("video/quicktime");
    expect(playableMediaMime("", "webm", true)).toBe("video/webm");
    expect(playableMediaMime("", "webm", false)).toBe("audio/webm");
    expect(playableMediaMime("", "mp3", false)).toBe("audio/mpeg");
    expect(playableMediaMime("", "wav", false)).toBe("audio/wav");
    expect(playableMediaMime("", "flac", false)).toBe("audio/flac");
    expect(playableMediaMime("", "ogg", false)).toBe("audio/ogg");
    expect(playableMediaMime("", "opus", false)).toBe("audio/ogg");
  });

  it("defaults to a generic audio/video mime for an unrecognized extension", () => {
    expect(playableMediaMime("", "xyz", true)).toBe("video/mp4");
    expect(playableMediaMime("", "xyz", false)).toBe("audio/mp4");
  });
});

// -------------------------------------------------------------------- staging

describe("stageMediaBytes / clearMedia", () => {
  it("evicts oldest and clear empties", () => {
    // Rust: staging_evicts_oldest_and_clear_empties
    const s = createMediaStreams();
    const first = stageMediaBytes(s, Buffer.from([1]), "audio/mp4");
    for (let i = 0; i < MAX_STAGED; i++) {
      stageMediaBytes(s, Buffer.from([2]), "audio/mp4");
    }
    expect(s.map.size).toBe(MAX_STAGED);
    expect(s.map.has(first)).toBe(false);
    clearMedia(s);
    expect(s.map.size).toBe(0);
  });

  it("is capped by bytes, not only by count", () => {
    // Rust: staging_is_capped_by_bytes_not_only_by_count
    const s = createMediaStreams();
    const big = Math.floor(MAX_STAGED_BYTES / 2) + 1;
    const a = stageMediaBytes(s, Buffer.alloc(big), "video/mp4");
    const b = stageMediaBytes(s, Buffer.alloc(big), "video/mp4");
    expect(s.map.has(a)).toBe(false); // the byte budget never evicted anything
    expect(s.map.has(b)).toBe(true); // the newest entry must stay playable
    let total = 0;
    for (const m of s.map.values()) total += m.bytes.length;
    expect(total).toBeLessThanOrEqual(MAX_STAGED_BYTES);

    // An entry bigger than the whole budget is still served — evicting it
    // would leave the viewer with nothing to play.
    const huge = stageMediaBytes(s, Buffer.alloc(MAX_STAGED_BYTES + 1), "video/mp4");
    expect(s.map.size).toBe(1);
    expect(s.map.has(huge)).toBe(true);
  });

  it("tokens are unique per call and never collide even for identical bytes", () => {
    // Not a Rust test, but load-bearing: identical bytes/mime staged twice
    // must not overwrite each other's map entry.
    const s = createMediaStreams();
    const bytes = Buffer.from("same bytes");
    const t1 = stageMediaBytes(s, bytes, "audio/mp4");
    const t2 = stageMediaBytes(s, bytes, "audio/mp4");
    expect(t1).not.toBe(t2);
    expect(s.map.size).toBe(2);
  });

  it("a token shaped like a prototype-pollution attempt is just an ordinary miss", () => {
    // RULE 2 sanity check: `mediaResponse` looks the token up in a `Map`
    // (never a `{}` literal keyed by caller-supplied input), so a
    // `__proto__`/`constructor`/`prototype`-named token behaves exactly like
    // any other unstaged token — a plain 404 — rather than resolving through
    // the object prototype chain.
    const s = createMediaStreams();
    for (const evil of ["__proto__", "constructor", "prototype"]) {
      const { status } = mediaResponse(s, `/${evil}`, null);
      expect(status).toBe(404);
    }
  });
});

// ------------------------------------------------------------------- mediaResponse

describe("mediaResponse", () => {
  it("serves the full body when there is no range", () => {
    // Rust: full_body_when_no_range
    const s = stagedWith(Buffer.from("0123456789"));
    const { status, headers, body } = mediaResponse(s, `/${onlyToken(s)}`, null);
    expect(status).toBe(200);
    expect(body).toEqual(Buffer.from("0123456789"));
    expect(headerValue(headers, "Accept-Ranges")).toBe("bytes");
    expect(headerValue(headers, "Content-Type")).toBe("video/mp4");
    expect(headerValue(headers, "Content-Length")).toBe("10");
  });

  it("serves a partial body with Content-Range", () => {
    // Rust: partial_body_with_content_range
    const s = stagedWith(Buffer.from("0123456789"));
    const { status, headers, body } = mediaResponse(s, `/${onlyToken(s)}`, "bytes=2-5");
    expect(status).toBe(206);
    expect(body).toEqual(Buffer.from("2345"));
    expect(headerValue(headers, "Content-Range")).toBe("bytes 2-5/10");
  });

  it("answers 416 for an unsatisfiable range and 404 for an unknown token, both CORS-readable", () => {
    // Rust: unsatisfiable_range_is_416_and_unknown_token_404
    const s = stagedWith(Buffer.from("0123456789"));
    const range = mediaResponse(s, `/${onlyToken(s)}`, "bytes=50-60");
    expect(range.status).toBe(416);
    expect(headerValue(range.headers, "Content-Range")).toBe("bytes */10");

    const missing = mediaResponse(s, "/no-such-token", null);
    expect(missing.status).toBe(404);

    for (const { status, headers } of [missing, range]) {
      expect(
        headerValue(headers, "Access-Control-Allow-Origin"),
        `the ${status} answer must be readable by the page that asked`
      ).toBe("*");
    }
  });

  it("strips every leading slash from the request path, not just one", () => {
    // Not a Rust `#[test]`, but pins `trim_start_matches('/')`'s real
    // behavior (strips ALL leading slashes) against a naive `.slice(1)`
    // port, which would leave a leading slash on a double-slash path and
    // miss the token entirely.
    const s = stagedWith(Buffer.from("hi"));
    const token = onlyToken(s);
    expect(mediaResponse(s, `//${token}`, null).status).toBe(200);
    expect(mediaResponse(s, `///${token}`, null).status).toBe(200);
  });

  it("answers 416 (not a whole-body 206) for a Range number past u64::MAX", () => {
    // End to end through `mediaResponse`, since the damage of the coercion bug
    // was not in the parser's return value but in what the handler then SENT:
    // a 206 + `Content-Range: bytes 0-9/10` for a header the shipped app calls
    // unsatisfiable.
    const s = stagedWith(Buffer.from("0123456789"));
    const token = onlyToken(s);
    for (const bad of ["bytes=0-99999999999999999999999", "bytes=-99999999999999999999999"]) {
      const r = mediaResponse(s, `/${token}`, bad);
      expect(r.status, `${bad} must be unsatisfiable`).toBe(416);
      expect(r.body.length).toBe(0);
      expect(headerValue(r.headers, "Content-Range")).toBe("bytes */10");
    }
  });

  it("an empty Range header string is unsatisfiable, and an empty staged body is 416 for any range", () => {
    // `"".trim().strip_prefix("bytes=")` is None in Rust, and `len == 0`
    // short-circuits before the grammar is even looked at.
    const s = stagedWith(Buffer.from("0123456789"));
    expect(mediaResponse(s, `/${onlyToken(s)}`, "").status).toBe(416);

    const empty = createMediaStreams();
    const token = stageMediaBytes(empty, Buffer.alloc(0), "audio/mp4");
    expect(mediaResponse(empty, `/${token}`, null).status).toBe(200);
    expect(mediaResponse(empty, `/${token}`, "bytes=0-").status).toBe(416);
    expect(headerValue(mediaResponse(empty, `/${token}`, "bytes=0-").headers, "Content-Range")).toBe(
      "bytes */0"
    );
  });

  it("the response body is independent of the staged buffer (no shared mutation)", () => {
    // Rust clones on every path (`.clone()` for 200, `.to_vec()` for 206);
    // returning the underlying Buffer by reference here would let a caller
    // corrupt every future read of the same staged entry.
    const s = stagedWith(Buffer.from("0123456789"));
    const { body } = mediaResponse(s, `/${onlyToken(s)}`, null);
    body[0] = 0x39; // '9'
    const again = mediaResponse(s, `/${onlyToken(s)}`, null);
    expect(again.body).toEqual(Buffer.from("0123456789"));
  });
});
