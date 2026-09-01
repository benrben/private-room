/**
 * Tests for `officeTools.ts` — `commands/office.rs`'s `slide_preview` and
 * `office_html` ports. The pure `<p:sldIdLst>` splice and the eviction cache
 * are exercised as direct Rust-parity unit tests (mirroring `office.rs`'s own
 * `#[cfg(test)] mod tests` case for case); the two commands themselves run
 * against a real fixture `.roomai` file, with their genuinely-unported render
 * steps (Quick Look, textutil) exercised both via their honest NOT_IMPLEMENTED
 * stubs and via injected fakes standing in for the future sidecar routes.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { insertFile } from "./db-host/files.js";
import { buildZip, readZipEntryBytes, readZipEntryText } from "./editMatchZip.js";
import { QUICKLOOK_RENDER_NOT_IMPLEMENTED, type PreviewRenderFn } from "./previewTools.js";
import {
  MAX_CACHED_SLIDES,
  clearSlides,
  createSlideCache,
  deckWithSlideFirst,
  evictToFit,
  officeHtml,
  registerOfficeIpc,
  slideCountOf,
  slidePreview,
  slidePreviewInRoom,
  type RoomSource,
  type SlideCache,
  type SlideCacheEntry,
} from "./officeTools.js";

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

let tmpDir: string;
let db: Database.Database;
let roomPath = "";

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "officeTools-"));
  roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  db = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return db;
}

function roomSource(open: boolean): RoomSource {
  return { currentRoom: () => (open ? { db, path: roomPath } : null) };
}

// ---------------------------------------------------------------- fixtures

/** A minimal, single-entry Office-style zip. Mirrors `extraction.rs`'s
 * `fake_office_zip` test helper. */
function fakeOfficeZip(entry: string, xml: string): Buffer {
  return buildZip([{ name: entry, data: Buffer.from(xml, "utf8") }]);
}

/** A deck whose `presentation.xml` lists `n` slides, `rId1`..`rIdN` in order.
 * Mirrors `office.rs`'s own `fake_deck` test helper. */
function fakeDeck(n: number): Buffer {
  let ids = "";
  for (let i = 1; i <= n; i++) {
    ids += `<p:sldId id="${255 + i}" r:id="rId${i}"/>`;
  }
  return fakeOfficeZip(
    "ppt/presentation.xml",
    `<p:presentation><p:sldMasterIdLst/><p:sldIdLst>${ids}</p:sldIdLst>` +
      `<p:sldSz cx="12192000" cy="6858000"/></p:presentation>`
  );
}

/** The `r:id` of every `<p:sldId>` in a deck, in document order. Mirrors
 * `office.rs`'s own `id_order` test helper. */
function idOrder(bytes: Buffer): string[] {
  const xml = readZipEntryText(bytes, "ppt/presentation.xml");
  if (xml === undefined) {
    throw new Error("fixture has no presentation.xml");
  }
  const out: string[] = [];
  const re = /<p:sldId\b[^>]*\br:id="([^"]+)"/g;
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    out.push(m[1] as string);
  }
  return out;
}

/** A legacy binary `.ppt`: an OLE compound file, not a zip of XML at all. */
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...Buffer.from(" not a zip")]);

// ============================================================================
// Pure logic: slideCountOf / deckWithSlideFirst (office.rs's own test cases)
// ============================================================================

describe("slideCountOf", () => {
  it("a_deck_counts_its_slides", () => {
    expect(slideCountOf(fakeDeck(7))).toBe(7);
    expect(slideCountOf(Buffer.from("not a pptx"))).toBe(0);
  });

  it("a legacy binary .ppt counts as zero rather than crashing — slidePreview is what turns 0 into 1", () => {
    expect(slideCountOf(OLE_MAGIC)).toBe(0);
    expect(Math.max(slideCountOf(OLE_MAGIC), 1)).toBe(1);
  });

  it("treats a missing or truncated slide-list opening tag as no listed slides", () => {
    expect(slideCountOf(fakeOfficeZip("ppt/presentation.xml", "<p:presentation/>"))).toBe(0);
    expect(slideCountOf(fakeOfficeZip(
      "ppt/presentation.xml",
      "<p:presentation><p:sldIdLst",
    ))).toBe(0);
  });
});

describe("deckWithSlideFirst", () => {
  it("moves the wanted slide to the front and keeps the rest in their order", () => {
    const moved = deckWithSlideFirst(fakeDeck(5), 2);
    expect(idOrder(moved)).toEqual(["rId3", "rId1", "rId2", "rId4", "rId5"]);
  });

  it("asking for the first slide changes nothing about the order", () => {
    const deck = fakeDeck(4);
    const moved = deckWithSlideFirst(deck, 0);
    expect(idOrder(moved)).toEqual(idOrder(deck));
  });

  it("every other part survives the rewrite byte for byte", () => {
    // Media, layouts, masters and themes are copied raw. If any of them were
    // dropped or re-encoded, the renderer would refuse the file.
    const png = Buffer.from("\x89PNG\r\n\x1a\nPRETEND", "latin1");
    const deck = buildZip([
      {
        name: "ppt/presentation.xml",
        data: Buffer.from(
          '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/>' +
            '<p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>',
          "utf8"
        ),
      },
      { name: "ppt/media/image1.png", data: png },
      { name: "ppt/theme/theme1.xml", data: Buffer.from("<a:theme/>", "utf8") },
    ]);

    const moved = deckWithSlideFirst(deck, 1);
    expect(readZipEntryText(moved, "ppt/theme/theme1.xml")).toBe("<a:theme/>");
    expect(readZipEntryBytes(moved, "ppt/media/image1.png")).toEqual(png);
  });

  it("a slide entry written the long way keeps its closing tag and its children", () => {
    // PowerPoint writes `<p:sldId …><p:extLst>…</p:extLst></p:sldId>` as
    // readily as the self-closing spelling. Carrying only the opening tag
    // through would leave `<p:sldIdLst>` unbalanced.
    const deck = fakeOfficeZip(
      "ppt/presentation.xml",
      '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1">' +
        '<p:extLst><p:ext uri="{ABC}"/></p:extLst></p:sldId>' +
        '<p:sldId id="257" r:id="rId2"></p:sldId></p:sldIdLst></p:presentation>'
    );
    expect(slideCountOf(deck)).toBe(2);
    const moved = deckWithSlideFirst(deck, 1);
    expect(idOrder(moved)).toEqual(["rId2", "rId1"]);
    const out = readZipEntryText(moved, "ppt/presentation.xml") as string;
    const opens = (out.match(/<p:sldId /g) ?? []).length;
    const closes = (out.match(/<\/p:sldId>/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(out).toContain("<p:ext uri=");
  });

  it("an out-of-range slide says how many there are", () => {
    expect(() => deckWithSlideFirst(fakeDeck(3), 9)).toThrow("3");
  });

  it("a file that is not a deck is refused rather than corrupted", () => {
    expect(() => deckWithSlideFirst(Buffer.from("not a pptx at all"), 0)).toThrow();
  });

  it("a presentation with no slides is refused", () => {
    const deck = fakeOfficeZip(
      "ppt/presentation.xml",
      "<p:presentation><p:sldIdLst></p:sldIdLst></p:presentation>"
    );
    expect(() => deckWithSlideFirst(deck, 0)).toThrow("no slides");
  });
});

// ============================================================================
// Adversarial: the reorder's structural invariant across EVERY index, a
// malformed `<p:sldIdLst>`, and a zip that is not a deck at all. `office.rs`'s
// own tests check one index of one well-formed deck; none of these are covered
// there, and each is a shape a real `.pptx` (or a half-synced one) can take.
// ============================================================================

describe("adversarial — deckWithSlideFirst is a PERMUTATION, for every index", () => {
  /** A deck mixing both spellings PowerPoint actually writes: self-closing,
   * long-form-with-children, and long-form-empty. */
  function mixedDeck(): Buffer {
    const ids =
      '<p:sldId id="256" r:id="rId1"/>' +
      '<p:sldId id="257" r:id="rId2"><p:extLst><p:ext uri="{ABC}"/></p:extLst></p:sldId>' +
      '<p:sldId id="258" r:id="rId3"/>' +
      '<p:sldId id="259" r:id="rId4"></p:sldId>' +
      '<p:sldId id="260" r:id="rId5"/>';
    return fakeOfficeZip("ppt/presentation.xml", `<p:presentation><p:sldIdLst>${ids}</p:sldIdLst></p:presentation>`);
  }

  it("moves each of five slides to the front without dropping, duplicating or reordering the rest", () => {
    const deck = mixedDeck();
    const original = idOrder(deck);
    expect(original).toEqual(["rId1", "rId2", "rId3", "rId4", "rId5"]);
    for (let k = 0; k < original.length; k++) {
      const moved = deckWithSlideFirst(deck, k);
      const got = idOrder(moved);
      // Exactly the wanted slide first, the rest in their ORIGINAL relative
      // order behind it — and nothing gained or lost on the way.
      expect(got).toEqual([original[k], ...original.filter((_, i) => i !== k)]);
      expect(new Set(got).size).toBe(original.length);
      // The count the viewer pages by must survive its own rewrite.
      expect(slideCountOf(moved)).toBe(original.length);
      // The long-form entry's children came with it, at every position.
      expect(readZipEntryText(moved, "ppt/presentation.xml")).toContain('<p:ext uri="{ABC}"/>');
    }
  });

  it("the LAST index is in range and one past it is refused by count", () => {
    const deck = mixedDeck();
    expect(idOrder(deckWithSlideFirst(deck, 4))[0]).toBe("rId5");
    expect(() => deckWithSlideFirst(deck, 5)).toThrow("This presentation has 5 slides.");
  });

  it("an entry compressed with method 0 (stored) is copied through raw, not re-encoded", () => {
    // `buildZip`'s `raw` path is `raw_copy_file`'s equivalent; a STORED media
    // part exercises a different branch of it than a deflated one.
    const png = Buffer.from("\x89PNG\r\n\x1a\nSTORED-RAW", "latin1");
    const deck = buildZip([
      {
        name: "ppt/presentation.xml",
        data: Buffer.from(
          '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/>' +
            '<p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>',
          "utf8"
        ),
      },
      { name: "ppt/media/image1.png", data: png, store: true },
    ]);
    const moved = deckWithSlideFirst(deck, 1);
    expect(readZipEntryBytes(moved, "ppt/media/image1.png")).toEqual(png);
    expect(idOrder(moved)).toEqual(["rId2", "rId1"]);
  });
});

describe("adversarial — a malformed ppt/presentation.xml", () => {
  it("a <p:sldId> whose closing tag never arrives is DROPPED, never emitted half-written into the rewrite", () => {
    // Rust's `split_self_closing` stops the scan rather than pushing half an
    // element ("An element whose closing tag is missing is not one we can
    // move"), which is what keeps the rewritten `<p:sldIdLst>` balanced. This
    // pins that exact parity: the truncated entry is lost, and what comes out
    // is still well-formed rather than a document Quick Look would refuse.
    const deck = fakeOfficeZip(
      "ppt/presentation.xml",
      '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/>' +
        '<p:sldId id="257" r:id="rId2"></p:sldIdLst></p:presentation>'
    );
    expect(slideCountOf(deck)).toBe(1);
    const out = readZipEntryText(deckWithSlideFirst(deck, 0), "ppt/presentation.xml") as string;
    expect(out).toBe('<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>');
    expect(out).not.toContain("rId2");
  });

  it("a self-closing empty <p:sldIdLst/> is 'does not list its slides', never a corrupt rewrite", () => {
    const deck = fakeOfficeZip("ppt/presentation.xml", "<p:presentation><p:sldIdLst/></p:presentation>");
    expect(slideCountOf(deck)).toBe(0);
    expect(() => deckWithSlideFirst(deck, 0)).toThrow("does not list its slides");
  });

  it("a presentation.xml truncated mid-list (no </p:sldIdLst>) is refused rather than half-spliced", () => {
    const deck = fakeOfficeZip("ppt/presentation.xml", '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/>');
    expect(slideCountOf(deck)).toBe(0);
    expect(() => deckWithSlideFirst(deck, 0)).toThrow("does not list its slides");
  });

  it("a .pptx-named zip with no presentation.xml at all draws ONE page from its ORIGINAL bytes", async () => {
    // Same rule that saves a legacy binary `.ppt`: nothing to reorder means
    // render the file exactly as it stands, rather than reporting it
    // undrawable. Reordering it would be the corrupting move.
    freshRoom();
    const zip = buildZip([{ name: "word/document.xml", data: Buffer.from("<w:document/>", "utf8") }]);
    const file = insertFile(db, "mislabelled.pptx", PPTX_MIME, zip, null, "library");
    const render = vi.fn<PreviewRenderFn>(() => Promise.resolve(Buffer.from([3])));
    const result = await slidePreview(db, file.id, 0, createSlideCache(), render);
    expect(result).toEqual({ pngB64: Buffer.from([3]).toString("base64"), slides: 1 });
    expect(Buffer.from(render.mock.calls[0]![1])).toEqual(zip);
    // …and there is no second page to ask for.
    await expect(slidePreview(db, file.id, 1, createSlideCache(), render)).resolves.toBeNull();
  });
});

describe("adversarial — the slide cache never crosses two indices of one deck", () => {
  it("slide 0 and slide 1 keep their own renders under the same id and bytes", async () => {
    freshRoom();
    const file = insertFile(db, "deck.pptx", PPTX_MIME, fakeDeck(3), null, "library");
    const cache = createSlideCache();
    const first = await slidePreview(db, file.id, 0, cache, () => Promise.resolve(Buffer.from([10])));
    const second = await slidePreview(db, file.id, 1, cache, () => Promise.resolve(Buffer.from([20])));
    expect(first?.pngB64).toBe(Buffer.from([10]).toString("base64"));
    expect(second?.pngB64).toBe(Buffer.from([20]).toString("base64"));
    expect(cache.map.size).toBe(2);
    // Re-asking for slide 0 must return SLIDE 0's render, not the newer one.
    await expect(
      slidePreview(db, file.id, 0, cache, () => Promise.reject(new Error("should not run")))
    ).resolves.toEqual({ pngB64: Buffer.from([10]).toString("base64"), slides: 3 });
  });
});

// ============================================================================
// evictToFit — office.rs's own eviction unit test
// ============================================================================

describe("evictToFit", () => {
  it("drops the oldest entry rather than emptying itself, then stops at zero", () => {
    const map = new Map<string, SlideCacheEntry>();
    for (let i = 0; i < 4; i++) {
      map.set(`deck:${i}:d`, { seq: i, pngB64: "png" });
    }
    evictToFit(map, 4);
    expect(map.size).toBe(3);
    expect(map.has("deck:0:d")).toBe(false);
    expect(map.has("deck:3:d")).toBe(true);

    // A ceiling of zero empties the map and then stops — with nothing left
    // to evict the loop ends rather than spinning forever.
    evictToFit(map, 0);
    expect(map.size).toBe(0);
  });
});

// ============================================================================
// slidePreview
// ============================================================================

describe("slidePreview", () => {
  it("throws when the id names no file in this room — mirrors get_file_full's Err propagation", async () => {
    freshRoom();
    await expect(slidePreview(db, "no-such-id", 0, createSlideCache())).rejects.toThrow();
  });

  it("resolves null for empty bytes WITHOUT ever calling render", async () => {
    freshRoom();
    const file = insertFile(db, "empty.pptx", PPTX_MIME, new Uint8Array(), null, "library");
    const render = vi.fn<PreviewRenderFn>(() => Promise.reject(new Error("must not be called")));
    await expect(slidePreview(db, file.id, 0, createSlideCache(), render)).resolves.toBeNull();
    expect(render).not.toHaveBeenCalled();
  });

  it("an out-of-range index resolves null without calling render", async () => {
    freshRoom();
    const deck = fakeDeck(3);
    const file = insertFile(db, "deck.pptx", PPTX_MIME, deck, null, "library");
    const render = vi.fn<PreviewRenderFn>(() => Promise.reject(new Error("must not be called")));
    await expect(slidePreview(db, file.id, 3, createSlideCache(), render)).resolves.toBeNull();
    expect(render).not.toHaveBeenCalled();
  });

  it("a legacy .ppt renders as ONE page, from its ORIGINAL bytes, never reordered", async () => {
    freshRoom();
    const file = insertFile(db, "old.ppt", "application/vnd.ms-powerpoint", OLE_MAGIC, null, "library");
    const render = vi.fn<PreviewRenderFn>(() => Promise.resolve(Buffer.from([1])));
    const result = await slidePreview(db, file.id, 0, createSlideCache(), render);
    expect(result?.slides).toBe(1);
    expect(render).toHaveBeenCalledTimes(1);
    const [, gotBytes] = render.mock.calls[0]!;
    expect(Buffer.from(gotBytes)).toEqual(OLE_MAGIC);

    // Index 1 is out of range for a one-page deck.
    await expect(slidePreview(db, file.id, 1, createSlideCache(), render)).resolves.toBeNull();
  });

  it("index 0 of a real deck passes the bytes through unreordered", async () => {
    freshRoom();
    const deck = fakeDeck(3);
    const file = insertFile(db, "deck.pptx", PPTX_MIME, deck, null, "library");
    const render = vi.fn<PreviewRenderFn>(() => Promise.resolve(Buffer.from([1])));
    await slidePreview(db, file.id, 0, createSlideCache(), render);
    const [, gotBytes] = render.mock.calls[0]!;
    expect(idOrder(Buffer.from(gotBytes))).toEqual(idOrder(deck));
  });

  it("a nonzero index reorders the deck before rendering it", async () => {
    freshRoom();
    const deck = fakeDeck(4);
    const file = insertFile(db, "deck.pptx", PPTX_MIME, deck, null, "library");
    const render = vi.fn<PreviewRenderFn>(() => Promise.resolve(Buffer.from([1])));
    await slidePreview(db, file.id, 2, createSlideCache(), render);
    const [name, gotBytes] = render.mock.calls[0]!;
    expect(name).toBe("deck.pptx");
    expect(idOrder(Buffer.from(gotBytes))).toEqual(["rId3", "rId1", "rId2", "rId4"]);
  });

  it("reports the deck's real slide count alongside the rendered page", async () => {
    freshRoom();
    const deck = fakeDeck(6);
    const file = insertFile(db, "deck.pptx", PPTX_MIME, deck, null, "library");
    const render: PreviewRenderFn = () => Promise.resolve(Buffer.from([1]));
    const result = await slidePreview(db, file.id, 4, createSlideCache(), render);
    expect(result?.slides).toBe(6);
  });

  it("base64-encodes the rendered PNG into pngB64", async () => {
    freshRoom();
    const file = insertFile(db, "deck.pptx", PPTX_MIME, fakeDeck(1), null, "library");
    const pngBytes = Buffer.from("not really a png but bytes", "utf8");
    const result = await slidePreview(db, file.id, 0, createSlideCache(), () => Promise.resolve(pngBytes));
    expect(result).toEqual({ pngB64: pngBytes.toString("base64"), slides: 1 });
  });

  it("an EMPTY render result is `{pngB64: '', slides}`, not null", async () => {
    // Only a `null` render answer means "nothing to draw"; an empty buffer is
    // a (degenerate) drawn image and must not collapse into the same answer.
    freshRoom();
    const file = insertFile(db, "deck.pptx", PPTX_MIME, fakeDeck(1), null, "library");
    const result = await slidePreview(db, file.id, 0, createSlideCache(), () => Promise.resolve(Buffer.alloc(0)));
    expect(result).toEqual({ pngB64: "", slides: 1 });
  });

  it("render resolving null resolves the whole call null and caches nothing", async () => {
    freshRoom();
    const file = insertFile(db, "deck.pptx", PPTX_MIME, fakeDeck(1), null, "library");
    const cache = createSlideCache();
    const result = await slidePreview(db, file.id, 0, cache, () => Promise.resolve(null));
    expect(result).toBeNull();
    expect(cache.map.size).toBe(0);
  });

  it("serves a cache hit for the same id/index/bytes WITHOUT rendering again", async () => {
    freshRoom();
    const file = insertFile(db, "deck.pptx", PPTX_MIME, fakeDeck(3), null, "library");
    const cache = createSlideCache();
    const render = vi.fn<PreviewRenderFn>(() => Promise.resolve(Buffer.from([7, 7])));
    const first = await slidePreview(db, file.id, 1, cache, render);
    const second = await slidePreview(db, file.id, 1, cache, render);
    expect(render).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("a cache hit needs no render function at all, even the NOT_IMPLEMENTED default", async () => {
    freshRoom();
    const deck = fakeDeck(2);
    const file = insertFile(db, "deck.pptx", PPTX_MIME, deck, null, "library");
    const cache = createSlideCache();
    await slidePreview(db, file.id, 0, cache, () => Promise.resolve(Buffer.from([9])));
    // No render argument this time — the default rejects. A genuine cache hit
    // must short-circuit before ever reaching it.
    await expect(slidePreview(db, file.id, 0, cache)).resolves.toEqual({
      pngB64: Buffer.from([9]).toString("base64"),
      slides: 2,
    });
  });

  it("rewriting the file's bytes under the same id invalidates its cached slides", async () => {
    freshRoom();
    const file = insertFile(db, "deck.pptx", PPTX_MIME, fakeDeck(2), null, "library");
    const cache = createSlideCache();
    await slidePreview(db, file.id, 0, cache, () => Promise.resolve(Buffer.from([1])));
    db.prepare("UPDATE files SET original_bytes = ? WHERE id = ?").run(fakeDeck(5), file.id);
    const render = vi.fn<PreviewRenderFn>(() => Promise.resolve(Buffer.from([2])));
    const result = await slidePreview(db, file.id, 0, cache, render);
    expect(render).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ pngB64: Buffer.from([2]).toString("base64"), slides: 5 });
  });

  it("evicts the oldest cached slide once the cache exceeds its ceiling", async () => {
    freshRoom();
    const n = MAX_CACHED_SLIDES + 5;
    const file = insertFile(db, "big.pptx", PPTX_MIME, fakeDeck(n), null, "library");
    const cache = createSlideCache();
    for (let i = 0; i < n; i++) {
      // eslint-disable-next-line no-await-in-loop
      await slidePreview(db, file.id, i, cache, () => Promise.resolve(Buffer.from([1])));
    }
    expect(cache.map.size).toBeLessThanOrEqual(MAX_CACHED_SLIDES);

    // The very first slide cached must have been evicted: asking for it again
    // with a render that REJECTS proves it is a fresh miss, not a hit.
    await expect(
      slidePreview(db, file.id, 0, cache, () => Promise.reject(new Error("evicted-miss-sentinel")))
    ).rejects.toThrow("evicted-miss-sentinel");

    // The most recently cached slide must still be a hit: the same rejecting
    // render must never be reached for it.
    await expect(
      slidePreview(db, file.id, n - 1, cache, () => Promise.reject(new Error("should not run")))
    ).resolves.not.toBeNull();
  });

  it("clearSlides empties the cache", () => {
    const cache: SlideCache = createSlideCache();
    cache.map.set("k", { seq: 0, pngB64: "x" });
    clearSlides(cache);
    expect(cache.map.size).toBe(0);
  });

  it("with no render dependency, rejects with the labelled NOT_IMPLEMENTED reason on a cache miss", async () => {
    freshRoom();
    const file = insertFile(db, "deck.pptx", PPTX_MIME, fakeDeck(1), null, "library");
    await expect(slidePreview(db, file.id, 0, createSlideCache())).rejects.toThrow(
      QUICKLOOK_RENDER_NOT_IMPLEMENTED
    );
  });

  // ------------------------------------------------------- the usize guard

  it("a negative index rejects synchronously before any room/DB work, without calling render", async () => {
    freshRoom();
    const file = insertFile(db, "deck.pptx", PPTX_MIME, fakeDeck(1), null, "library");
    const render = vi.fn<PreviewRenderFn>(() => Promise.reject(new Error("must not be called")));
    await expect(slidePreview(db, file.id, -1, createSlideCache(), render)).rejects.toThrow(
      "non-negative integer"
    );
    expect(render).not.toHaveBeenCalled();
  });

  it("a non-integer index is refused the same way — Tauri's usize can hold neither", async () => {
    freshRoom();
    const file = insertFile(db, "deck.pptx", PPTX_MIME, fakeDeck(1), null, "library");
    await expect(slidePreview(db, file.id, 1.5, createSlideCache())).rejects.toThrow("non-negative integer");
  });

  it("the index guard rejects even for a nonexistent file id — it runs before the DB lookup", async () => {
    freshRoom();
    await expect(slidePreview(db, "no-such-id", -1, createSlideCache())).rejects.toThrow(
      "non-negative integer"
    );
  });
});

describe("slidePreviewInRoom", () => {
  it("uses the same index validation and room-backed rendering path", async () => {
    freshRoom();
    const file = insertFile(db, "deck.pptx", PPTX_MIME, fakeDeck(2), null, "library");
    const render = vi.fn<PreviewRenderFn>(() => Promise.resolve(Buffer.from([4])));
    const open = { db, path: roomPath };

    await expect(slidePreviewInRoom(open, file.id, -1, createSlideCache(), render)).rejects.toThrow(
      "non-negative integer"
    );
    expect(render).not.toHaveBeenCalled();

    await expect(slidePreviewInRoom(open, file.id, 1, createSlideCache(), render)).resolves.toEqual({
      pngB64: Buffer.from([4]).toString("base64"),
      slides: 2,
    });
    expect(idOrder(Buffer.from(render.mock.calls[0]![1]))).toEqual(["rId2", "rId1"]);
  });
});

// ============================================================================
// officeHtml — real `/usr/bin/textutil` conversions, mirroring office.rs's
// own `textutil_reads_a_real_rtf_into_html` / hyperlink-field tests. A
// sibling workflow landed a real, tested `textUtil.ts` port (`convert` +
// `resolveFieldCodes`) while this file was being written, so — per this
// batch's reuse-not-duplicate rule — `officeHtml` calls it directly rather
// than through an injectable seam; these tests exercise the real subprocess.
// ============================================================================

const REAL_RTF = Buffer.from(
  String.raw`{\rtf1\ansi{\fonttbl\f0\froman Times;}\f0\fs48 Hello \b bold\b0  world.\par}`,
  "utf8"
);

const REAL_RTF_WITH_HYPERLINK = Buffer.from(
  String.raw`{\rtf1\ansi\f0\fs24 See {\field{\*\fldinst{HYPERLINK "https://example.com/page"}}{\fldrslt{the page}}} now.\par}`,
  "utf8"
);

describe("officeHtml", () => {
  it("throws when the id names no file in this room", async () => {
    freshRoom();
    await expect(officeHtml(db, "no-such-id")).rejects.toThrow();
  });

  it("resolves null for empty bytes without ever invoking textutil", async () => {
    freshRoom();
    const file = insertFile(db, "empty.doc", "application/msword", new Uint8Array(), null, "library");
    await expect(officeHtml(db, file.id)).resolves.toBeNull();
  });

  it("resolves null for a format textutil cannot import (e.g. a .pptx opened through this command)", async () => {
    freshRoom();
    const file = insertFile(db, "deck.pptx", PPTX_MIME, new Uint8Array([1, 2, 3]), null, "library");
    await expect(officeHtml(db, file.id)).resolves.toBeNull();
  });

  it("a real .rtf is drawn as formatted HTML by macOS's own Word importer", async () => {
    freshRoom();
    const file = insertFile(db, "sample.rtf", "application/rtf", REAL_RTF, null, "library");
    const html = await officeHtml(db, file.id);
    expect(html).not.toBeNull();
    expect(html).toContain("Hello");
    expect((html as string).toLowerCase()).toContain("<b>");
  });

  it("a Word HYPERLINK field code reaches the preview as a real link, not leaked machinery", async () => {
    freshRoom();
    const file = insertFile(db, "linked.rtf", "application/rtf", REAL_RTF_WITH_HYPERLINK, null, "library");
    const html = await officeHtml(db, file.id);
    expect(html).not.toBeNull();
    expect(html).not.toContain("HYPERLINK");
    expect(html).toContain("now.");
  });

  it("a TRASHED file is refused, never previewed", async () => {
    freshRoom();
    const file = insertFile(db, "secret.rtf", "application/rtf", REAL_RTF, null, "library");
    db.prepare("UPDATE files SET trashed_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(file.id);
    await expect(officeHtml(db, file.id)).rejects.toThrow();
  });
});

// ============================================================================
// registerOfficeIpc
// ============================================================================

describe("registerOfficeIpc", () => {
  function listener(handle: ReturnType<typeof vi.fn>, channel: string): (...args: unknown[]) => unknown {
    const entry = handle.mock.calls.find((c) => c[0] === channel);
    if (entry === undefined) {
      throw new Error(`channel ${channel} was not registered`);
    }
    return entry[1] as (...args: unknown[]) => unknown;
  }

  it("registers exactly the slide_preview and office_html channels", () => {
    freshRoom();
    const handle = vi.fn();
    registerOfficeIpc({ handle }, roomSource(true), createSlideCache());
    expect(handle).toHaveBeenCalledTimes(2);
    const channels = handle.mock.calls.map((c) => c[0]).sort();
    expect(channels).toEqual(["office_html", "slide_preview"]);
  });

  it("refuses with 'No room is open.' for slide_preview when no room is open", async () => {
    freshRoom();
    const handle = vi.fn();
    registerOfficeIpc({ handle }, roomSource(false), createSlideCache());
    const fn = listener(handle, "slide_preview");
    await expect(Promise.resolve().then(() => fn({}, { id: "anything", index: 0 }))).rejects.toThrow(
      "No room is open."
    );
  });

  it("refuses with 'No room is open.' for office_html when no room is open", async () => {
    freshRoom();
    const handle = vi.fn();
    registerOfficeIpc({ handle }, roomSource(false), createSlideCache());
    const fn = listener(handle, "office_html");
    await expect(Promise.resolve().then(() => fn({}, { id: "anything" }))).rejects.toThrow("No room is open.");
  });

  it("reaches the real DB-backed slide_preview logic, not a stub", async () => {
    freshRoom();
    const handle = vi.fn();
    registerOfficeIpc({ handle }, roomSource(true), createSlideCache());
    const fn = listener(handle, "slide_preview");
    await expect(fn({}, { id: "not-a-real-id", index: 0 })).rejects.toThrow();
  });

  it("forwards an injected slide render dependency through to the real logic", async () => {
    freshRoom();
    const file = insertFile(db, "deck.pptx", PPTX_MIME, fakeDeck(1), null, "library");
    const render: PreviewRenderFn = () => Promise.resolve(Buffer.from([5, 6]));
    const handle = vi.fn();
    registerOfficeIpc({ handle }, roomSource(true), createSlideCache(), render);
    const fn = listener(handle, "slide_preview");
    await expect(fn({}, { id: file.id, index: 0 })).resolves.toEqual({
      pngB64: Buffer.from([5, 6]).toString("base64"),
      slides: 1,
    });
  });

  it("reaches the real office_html logic (a real textutil conversion), not a stub", async () => {
    freshRoom();
    const file = insertFile(db, "sample.rtf", "application/rtf", REAL_RTF, null, "library");
    const handle = vi.fn();
    registerOfficeIpc({ handle }, roomSource(true), createSlideCache());
    const fn = listener(handle, "office_html");
    const html = await fn({}, { id: file.id });
    expect(html).toContain("Hello");
  });
});
