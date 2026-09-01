/**
 * Tests for `ocrTools.ts` — `ocr.rs`'s port. `isOcrCandidate`, `pageRasterSize`
 * and `unreadNotes` are pure; their tests are the Rust suite's OWN tests
 * (`ocr.rs`'s `#[cfg(test)] mod tests` and `mac::tests`) ported verbatim,
 * same names, same fixture values, same assertions. `recognize`'s tests are
 * new (the Rust source has no unit test for it — it is native, untestable
 * without a real Mac + Vision) and exercise the real orchestration against
 * both the honest NOT_IMPLEMENTED stub and an injected fake standing in for
 * a future real recognizer.
 */

import { describe, expect, it, vi } from "vitest";

const sidecar = vi.hoisted(() => ({ sidecarJsonCancellable: vi.fn() }));

vi.mock("./sidecarJsonCancellable.js", () => sidecar);

import {
  isOcrCandidate,
  MAX_PAGE_EDGE,
  MAX_PAGE_PIXELS,
  OCR_NOT_IMPLEMENTED,
  ocrRecognizeNotImplemented,
  PDF_RENDER_SCALE,
  pageRasterSize,
  recognize,
  recognizeViaSidecar,
  unreadNotes,
  type OcrRecognizeFn,
} from "./ocrTools.js";

// -------------------------------------------------------- is_ocr_candidate

describe("isOcrCandidate", () => {
  it("ocr_candidates_are_images_and_pdfs — ported verbatim from ocr.rs", () => {
    expect(isOcrCandidate("image/jpeg", "jpg")).toBe(true);
    expect(isOcrCandidate("image/png", "png")).toBe(true);
    expect(isOcrCandidate("application/pdf", "pdf")).toBe(true);
    // Not scans: text/office formats we already extract natively.
    expect(isOcrCandidate("text/plain", "txt")).toBe(false);
    expect(
      isOcrCandidate(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docx"
      )
    ).toBe(false);
  });

  it("dispatches on mime OR ext, not both — a pdf-named file with a wrong mime is still a candidate", () => {
    expect(isOcrCandidate("application/octet-stream", "pdf")).toBe(true);
    expect(isOcrCandidate("image/heic", "heic")).toBe(true);
  });
});

// ---------------------------------------------------------- page_raster_size

describe("pageRasterSize", () => {
  it("a_degenerate_media_box_cannot_ask_for_a_gigabyte_bitmap — ported verbatim from mac::tests", () => {
    // Regression: the per-dimension guard was replaced by an area cap alone,
    // and area bounds NEITHER side. /MediaBox [0 0 250000000 0.001] has an
    // area of 250 000 pt², so the cap left the scale at 2.0 and the render
    // asked CoreGraphics for 500 000 000 × 1 — a 2 GB context, plus another
    // 2 GB for `vec![0u8; w*h*4]`.
    for (const [w, h] of [
      [250_000_000, 0.001],
      [0.001, 250_000_000],
    ]) {
      const result = pageRasterSize(w!, h!);
      expect(result, "still renderable").not.toBeNull();
      const { width, height } = result!;
      expect(width, `width ${width} unbounded`).toBeLessThanOrEqual(MAX_PAGE_EDGE);
      expect(height, `height ${height} unbounded`).toBeLessThanOrEqual(MAX_PAGE_EDGE);
      expect(width * height, `${width}×${height} past the area cap`).toBeLessThanOrEqual(
        MAX_PAGE_PIXELS
      );
    }
  });

  it("ordinary_and_poster_pages_still_render — ported verbatim from mac::tests", () => {
    // A4 at 72dpi: rendered at the full 2x, untouched by either cap.
    const a4 = pageRasterSize(595.0, 842.0);
    expect(a4, "A4 renders").not.toBeNull();
    expect(a4!.scale).toBe(PDF_RENDER_SCALE);
    expect([a4!.width, a4!.height]).toEqual([1190, 1684]);

    // A wall-sized plan: scaled DOWN by the area cap, not refused.
    const poster = pageRasterSize(5000.0, 7000.0);
    expect(poster, "poster renders").not.toBeNull();
    const { width: w, height: h, scale } = poster!;
    expect(scale < PDF_RENDER_SCALE && scale > 0, `scale ${scale}`).toBe(true);
    // Rounding each edge UP can put the product a pixel-row over.
    expect(w * h, `${w}×${h}`).toBeLessThanOrEqual(MAX_PAGE_PIXELS + (w + h));

    // Nothing drawable at all.
    expect(pageRasterSize(0.0, 0.0)).toBeNull();
    expect(pageRasterSize(Number.MAX_VALUE, Number.MAX_VALUE)).toBeNull();
  });
});

// -------------------------------------------------------------- unread_notes

describe("unreadNotes", () => {
  it("pages_that_could_not_be_rendered_are_declared — ported verbatim from mac::tests", () => {
    // Regression: a scan whose pages mostly failed to rasterize was stored
    // and answered from as if the few that worked were the whole document —
    // the loop `continue`d and, with no cap in play, nothing was appended at
    // all.
    const note = unreadNotes(12, 12, 9);
    expect(note, note).toContain("9 of 12");
    expect(note, note).toContain("could not be rendered");
    expect(note).not.toContain("only the first");

    // A whole document that rendered cleanly says nothing extra.
    expect(unreadNotes(12, 12, 0)).toBe("");
    // One page short of clean still speaks up.
    expect(unreadNotes(12, 12, 1)).toContain("1 of 12");

    // Capped AND partly unrenderable: both facts, cap first.
    const both = unreadNotes(900, 500, 3);
    const cap = both.indexOf("only the first 500 of 900");
    const skip = both.indexOf("3 of 500");
    expect(cap).not.toBe(-1);
    expect(skip).not.toBe(-1);
    expect(cap, both).toBeLessThan(skip);

    // Capped but every attempted page drew: only the cap note.
    const capped = unreadNotes(900, 500, 0);
    expect(capped, capped).toContain("only the first 500 of 900");
    expect(capped).not.toContain("could not be rendered");
  });
});

// ------------------------------------------------------------------ recognize

describe("recognize", () => {
  it("resolves the recognized text when ocr resolves non-empty text", async () => {
    const ocr: OcrRecognizeFn = () => Promise.resolve("hello world");
    await expect(recognize("image/png", "png", Buffer.from([1]), ocr)).resolves.toBe(
      "hello world"
    );
  });

  it("resolves null when ocr resolves null — nothing was read", async () => {
    const ocr: OcrRecognizeFn = () => Promise.resolve(null);
    await expect(recognize("image/png", "png", Buffer.from([1]), ocr)).resolves.toBeNull();
  });

  it("resolves null for whitespace-only text — text.filter(|t| !t.trim().is_empty())", async () => {
    const ocr: OcrRecognizeFn = () => Promise.resolve("   \n\t  ");
    await expect(recognize("image/png", "png", Buffer.from([1]), ocr)).resolves.toBeNull();
  });

  it("passes mime, ext, and bytes through to ocr unchanged", async () => {
    const ocr = vi.fn<OcrRecognizeFn>(() => Promise.resolve("x"));
    const bytes = Buffer.from([9, 8, 7]);
    await recognize("application/pdf", "pdf", bytes, ocr);
    expect(ocr).toHaveBeenCalledTimes(1);
    expect(ocr).toHaveBeenCalledWith("application/pdf", "pdf", bytes);
  });

  it("with no ocr dependency, rejects with the labelled NOT_IMPLEMENTED reason rather than a fabricated result", async () => {
    await expect(recognize("image/jpeg", "jpg", Buffer.from([1, 2, 3]))).rejects.toThrow(
      OCR_NOT_IMPLEMENTED
    );
    expect(OCR_NOT_IMPLEMENTED).toMatch(/^NOT_IMPLEMENTED: /);
  });

  it("ocrRecognizeNotImplemented itself always rejects, never resolves a fabricated recognition or a fabricated null", async () => {
    await expect(ocrRecognizeNotImplemented("image/png", "png", Buffer.from([1]))).rejects.toThrow(
      OCR_NOT_IMPLEMENTED
    );
  });

  it("does not swallow a genuine ocr rejection into null — the wiring-gap/no-text distinction the module doc draws", async () => {
    const ocr: OcrRecognizeFn = () => Promise.reject(new Error("Vision request handler crashed"));
    await expect(recognize("image/png", "png", Buffer.from([1]), ocr)).rejects.toThrow(
      "Vision request handler crashed"
    );
  });
});

describe("recognizeViaSidecar", () => {
  it("sends encoded OCR input through the fake cancellable sidecar seam", async () => {
    sidecar.sidecarJsonCancellable.mockResolvedValue({ kind: "value", value: { text: "recognized" } });
    const bytes = Buffer.from([0, 255, 3]);

    await expect(recognizeViaSidecar("image/png", "png", bytes)).resolves.toBe("recognized");

    expect(sidecar.sidecarJsonCancellable).toHaveBeenCalledWith(
      "/ocr",
      { mime: "image/png", ext: "png", data_b64: bytes.toString("base64") },
      expect.anything(),
      30 * 60 * 1000,
    );
  });

  it("returns null when the fake sidecar response has no string text", async () => {
    for (const value of [null, {}, { text: 42 }]) {
      sidecar.sidecarJsonCancellable.mockResolvedValueOnce({ kind: "value", value });
      await expect(recognizeViaSidecar("application/pdf", "pdf", Buffer.alloc(0))).resolves.toBeNull();
    }
  });

  it("preserves stopped and sidecar error outcomes", async () => {
    sidecar.sidecarJsonCancellable.mockResolvedValueOnce({ kind: "stopped" });
    await expect(recognizeViaSidecar("image/jpeg", "jpg", Buffer.alloc(0))).rejects.toThrow("Stopped.");

    sidecar.sidecarJsonCancellable.mockResolvedValueOnce({
      kind: "error",
      error: { error: "fake Vision bridge failed" },
    });
    await expect(recognizeViaSidecar("image/jpeg", "jpg", Buffer.alloc(0))).rejects.toThrow(
      "fake Vision bridge failed",
    );
  });
});

// ============================================================================
// ADVERSARIAL — the guard's own inputs are attacker-supplied
// ============================================================================
//
// `pageRasterSize` is not a formatting helper, it is a CEILING on a bitmap
// allocated from a `/MediaBox` that arrived inside an untrusted PDF (by
// import or by download — `MAX_PAGE_EDGE`'s own Rust comment says so). The
// Rust suite's two ported tests above cover the degenerate-but-numeric cases.
// These cover the values a hand-written or corrupted media box can carry that
// are not ordinary numbers at all, and that Rust's `f64 as usize` cast
// silently folds to 0 before its `width == 0` guard ever runs.

describe("pageRasterSize, adversarial media boxes", () => {
  it("REGRESSION: a NaN edge returns null, never a NaN-sized bitmap", () => {
    // Was `{width: NaN, height: 200, scale: 2}` — NaN sails straight past a
    // `width === 0` check, and would have been handed to a bitmap allocator.
    expect(pageRasterSize(Number.NaN, 100)).toBeNull();
    expect(pageRasterSize(100, Number.NaN)).toBeNull();
    expect(pageRasterSize(Number.NaN, Number.NaN)).toBeNull();
  });

  it("REGRESSION: a negative edge returns null, never a negative-sized bitmap", () => {
    // Was `{width: -200, height: 400, scale: 2}`.
    expect(pageRasterSize(-100, 200)).toBeNull();
    expect(pageRasterSize(200, -100)).toBeNull();
    expect(pageRasterSize(-1, -1)).toBeNull();
  });

  it("an infinite edge returns null rather than an unbounded allocation", () => {
    expect(pageRasterSize(Number.POSITIVE_INFINITY, 100)).toBeNull();
    expect(pageRasterSize(100, Number.POSITIVE_INFINITY)).toBeNull();
    expect(pageRasterSize(Number.NEGATIVE_INFINITY, 100)).toBeNull();
  });

  it("EVERY surviving answer is bounded on both edges AND on area, whatever the media box claimed", () => {
    // The property the whole function exists for, asserted over a spread of
    // hostile shapes rather than the two the Rust suite happens to name.
    const hostile: Array<[number, number]> = [
      [250_000_000, 0.001],
      [0.001, 250_000_000],
      [1e9, 1e9],
      [Number.MAX_VALUE, 1],
      [1, Number.MAX_VALUE],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      [5000, 7000],
      [595, 842],
      [1e-9, 1e-9],
      [20_000, 20_000],
      [19_999.9, 0.5],
    ];
    for (const [w, h] of hostile) {
      const got = pageRasterSize(w, h);
      if (got === null) continue;
      expect(Number.isInteger(got.width), `${w}x${h} width ${got.width}`).toBe(true);
      expect(Number.isInteger(got.height), `${w}x${h} height ${got.height}`).toBe(true);
      expect(got.width).toBeGreaterThan(0);
      expect(got.height).toBeGreaterThan(0);
      expect(got.width).toBeLessThanOrEqual(MAX_PAGE_EDGE);
      expect(got.height).toBeLessThanOrEqual(MAX_PAGE_EDGE);
      // Rounding each edge UP can put the product a pixel-row over, exactly
      // as the Rust suite's own poster test allows for.
      expect(got.width * got.height).toBeLessThanOrEqual(
        MAX_PAGE_PIXELS + got.width + got.height
      );
      expect(got.scale).toBeGreaterThan(0);
      expect(Number.isFinite(got.scale)).toBe(true);
      expect(got.scale).toBeLessThanOrEqual(PDF_RENDER_SCALE);
    }
  });
});

describe("unreadNotes / isOcrCandidate, adversarial", () => {
  it("a mime that merely CONTAINS image/ is not an image — startsWith, not includes", () => {
    expect(isOcrCandidate("application/x-image/jpeg", "bin")).toBe(false);
    expect(isOcrCandidate("text/plain;x=image/png", "txt")).toBe(false);
    // And the ext check is exact, not a suffix match.
    expect(isOcrCandidate("application/octet-stream", "notpdf")).toBe(false);
    expect(isOcrCandidate("application/octet-stream", "PDF")).toBe(false);
  });

  it("never claims pages were skipped when none were — a false 'partial read' warning is its own lie", () => {
    expect(unreadNotes(0, 0, 0)).toBe("");
    expect(unreadNotes(1, 1, 0)).toBe("");
    // total < pages cannot happen (pages is total.min(cap)), and must not
    // produce a nonsense "only the first 5 of 3" line if it somehow did.
    expect(unreadNotes(3, 5, 0)).toBe("");
  });
});

describe("recognize, adversarial", () => {
  it("a recognizer that returns only control/zero-width whitespace is 'nothing read', not text", async () => {
    for (const blank of ["", " ", "\n\n", "\t\t", "  \r\n  "]) {
      const ocr: OcrRecognizeFn = () => Promise.resolve(blank);
      await expect(recognize("image/png", "png", Buffer.alloc(0), ocr)).resolves.toBeNull();
    }
  });

  it("the NOT_IMPLEMENTED refusal never resolves — not even for an empty buffer or an unknown mime", async () => {
    // The distinction the module exists to protect: "nobody wired this up"
    // must never arrive as "Vision looked and found nothing."
    await expect(recognize("", "", Buffer.alloc(0))).rejects.toThrow(OCR_NOT_IMPLEMENTED);
    await expect(recognize("application/pdf", "pdf", Buffer.from("%PDF-1.4"))).rejects.toThrow(
      OCR_NOT_IMPLEMENTED
    );
    await expect(ocrRecognizeNotImplemented("image/png", "png", Buffer.alloc(0))).rejects.toThrow(
      /^NOT_IMPLEMENTED: /
    );
  });

  it("does not pre-judge the bytes — a PDF ext with image bytes still reaches the recognizer verbatim", async () => {
    const seen: Array<[string, string, number]> = [];
    const ocr: OcrRecognizeFn = (mime, ext, bytes) => {
      seen.push([mime, ext, bytes.length]);
      return Promise.resolve("text");
    };
    await recognize("image/png", "pdf", Buffer.from([1, 2, 3]), ocr);
    expect(seen).toEqual([["image/png", "pdf", 3]]);
  });
});
