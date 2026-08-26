/**
 * Port of `src-tauri/src/ocr.rs` (420 lines, read in full) — ADD-14's
 * on-device OCR for scans and photos: when a PDF or image yields no
 * extractable text, recognize it with Apple's Vision framework
 * (`VNRecognizeTextRequest`), entirely on the Mac, no bundled engine and
 * nothing over the network.
 *
 * ROOM-FREE, UNLIKE `peaksTools.ts`/`previewTools.ts`: `ocr.rs` never
 * touches a room, a DB, or `AppState` — its whole public surface is
 * `recognize(mime, ext, bytes) -> Option<String>` and the pure helpers it is
 * built from. It is not a `#[tauri::command]` either (confirmed by reading
 * the file whole — no `#[tauri::command]` attribute anywhere in it): it is
 * called by `commands::files::run_ocr_job`, a background job runner living
 * in `files.rs` (1647 lines — its own much larger, not-yet-ported migration
 * item; see `pm-request/electron-python-migration-inventory-2026-08-22.md`),
 * which re-reads the room under its own lock and hands `recognize` only raw
 * bytes. So this file has no room/DB/IPC surface either, and no
 * `register*Ipc` function — its exports are meant to be imported directly by
 * whichever future `files.ts`/`jobs.ts` port carries `run_ocr_job` forward,
 * exactly how `peaksTools.ts`'s `mediaKind` is imported directly by
 * `retrievalBackfill.ts` with no IPC step in between.
 *
 * NOT A MODEL TOOL: grepped `src-tauri/src/commands/agent.rs` for `ocr::`
 * (zero hits; only `files.rs` and the unrelated `stt_cmds.rs` reference the
 * module) and this migration's `toolSpecs.ts`/`toolSchema.ts`/`execTool.ts`
 * for `ocr` (zero hits, case-insensitive). OCR runs automatically on
 * import/backfill, never as something the model calls as a tool. Nothing
 * here touches `execTool.ts`.
 *
 * PORTED FOR REAL — pure logic, no Vision/CoreGraphics dependency, exactly
 * the "parsing, math, format detection" carve-out:
 *   - {@link isOcrCandidate} — `is_ocr_candidate`, one line, own Rust test
 *     ported verbatim below. THE canonical home: `retrievalBackfill.ts`
 *     imports it from here rather than carrying its own copy, the same
 *     consolidation `peaksTools.ts`'s own doc already established for
 *     `retrievalBackfill.ts`'s `mediaKind` import.
 *   - {@link pageRasterSize} — `page_raster_size`, the PDF page-size caps
 *     (area cap FIRST, then per-edge cap — order matters, see the Rust
 *     comment) that stop an attacker-controlled `/MediaBox` from asking for
 *     a multi-gigabyte bitmap. Pure float math; both Rust unit tests ported
 *     verbatim below.
 *   - {@link unreadNotes} — `unread_notes`, the "[only the first N of M
 *     pages...]" / "[K pages could not be rendered...]" bookkeeping. Pure
 *     string formatting; the Rust suite's ordering/joining test ported
 *     verbatim below.
 *   - {@link WANTED_LANGUAGE_PREFIXES} and the four page-cap constants —
 *     plain data, ported verbatim for fidelity: a future real recognizer (or
 *     a future real Node-side PDF rasterizer) needs the exact same numbers.
 *
 * These three functions are NOT orphaned busywork with no real caller in
 * this tree: `sidecar/arcelle_sidecar/media/ocr.py` (a REAL, working PyObjC
 * port, commit `cf7fd53` "Migration batch 15: PyObjC trio (ocr.py,
 * quicklook.py, probe.py)", read in full) carries the IDENTICAL three
 * functions for the IDENTICAL reason — the attacker-controlled-media-box
 * risk `MAX_PAGE_EDGE`'s Rust comment describes is a property of the BYTES,
 * not of which language reads them. Porting them here too means this file's
 * own reasoning about that risk is checkable independent of whichever
 * process ends up doing the rasterizing.
 *
 * PRODUCTION WIRING — Vision-framework recognition itself. `ocr.py`
 * has the real implementation of `recognize`/`ocr_pdf`/`ocr_image_bytes`
 * (PyObjC `Vision.VNRecognizeTextRequest`, PDF pages rasterized via
 * `pymupdf` rather than hand-rolled `CGPDFDocument`/`CGContext` calls — its
 * own doc explains why pymupdf stands in for the two CoreGraphics calls
 * objc2 has no direct binding for). The sidecar exposes it through `/ocr`, and
 * {@link recognizeViaSidecar} is the production client used by the automatic
 * file-import OCR path. {@link recognize} retains an injectable recognizer and
 * a labelled rejecting default for isolated callers and tests; production
 * always supplies the live sidecar recognizer.
 *
 * DEVIATION FROM RUST'S OWN STATED CONTRACT, spelled out because `ocr.rs`'s
 * own doc comment says close to the opposite: "Best-effort by design: any
 * failure returns `None`." That promise covers Vision/CoreGraphics failing
 * on THIS Mac for THIS file — a real, WIRED implementation's own job to
 * honor (it should catch its own genuine failures and resolve `null`,
 * exactly as `ocr.py`'s `recognize`/`ocr_image_bytes`/`ocr_pdf` already do
 * today with bare `try/except` around each native call). It was never meant
 * to cover "no implementation exists to call at all" — that is a wiring gap,
 * not a per-file OCR failure, and {@link recognize} does not swallow it: a
 * rejection from the `ocr` parameter propagates unchanged, the same choice
 * `previewTools.ts`'s `quicklookPreview` makes for its own `render`
 * parameter, and for the same stated reason ("wrapping it would bury the
 * exact NOT_IMPLEMENTED marker a caller or test matches on").
 *
 * MAC-ONLY, NO PLATFORM GATE NEEDED: `ocr.rs`'s `#[cfg(not(target_os =
 * "macos"))]` branch (always `None`) has no TS equivalent because this app
 * ships macOS-only — there is no other platform build to gate against.
 *
 * NOT PORTED: `mac::run_recognition`/`mac::ocr_image_bytes`/`mac::ocr_pdf`/
 * `mac::render_pdf_page_png`/`mac::available_languages` themselves — every
 * line of each is a direct objc2/Vision/CoreGraphics call with no Node
 * equivalent (that IS the gap {@link OcrRecognizeFn} stands in for). No CLI
 * or child-process alternative was assumed instead of checked: this Mac
 * happens to have Homebrew's `tesseract` installed, but shelling out to it
 * would silently swap Apple Vision (the product's explicit, stated design —
 * "no bundled engine and nothing over the network," `ocr.rs`'s own opening
 * comment) for a different OCR engine with different accuracy, different
 * language support, and no bundled Hebrew data of its own — a materially
 * different result presented as the same feature, which is exactly the
 * fabrication rule 3 forbids, not a legitimate substitute. `shortcuts run`
 * (macOS's own Shortcuts CLI) could in principle invoke a "Extract Text from
 * Image" action, but only if that exact shortcut already exists on the
 * user's Mac — an unshippable, undocumented, silently-fragile dependency,
 * not a real port.
*/

import { CancelFlag } from "./cancel.js";
import { sidecarJsonCancellable } from "./sidecarJsonCancellable.js";

// ---------------------------------------------------------------- constants

/** Render PDFs at 2x the point size so small scanned type is legible to the
 * recognizer. */
export const PDF_RENDER_SCALE = 2.0;

/** Bound work on huge documents; OCR runs in the background, but it should
 * not read a library. Whatever this cuts is REPORTED in the text (see
 * {@link unreadNotes}) — the old 50-page limit meant a 200-page scan looked
 * like it had worked while three quarters of it was missing from search and
 * from every answer. */
export const MAX_PDF_PAGES = 500;

/** Ceiling on one rasterized page. 40 MP is ~160 MB for the RGBA bitmap, and
 * the tight repack plus the PNG encode each cost about as much again. The
 * old guard was per-dimension (20 000 × 20 000), which allowed a 1.6 GB
 * allocation and then two more copies of it. A poster- or map-sized page is
 * rendered at a reduced scale rather than skipped outright. */
export const MAX_PAGE_PIXELS = 40_000_000;

/** Ceiling on EITHER edge of a rasterized page. Area alone bounds neither
 * side: a page whose media box declares 250 000 000 × 0.001 pt has a
 * trivial area, so the area cap leaves the scale at 2.0 and CoreGraphics is
 * asked for a 500 000 000 × 1 bitmap — 2 GB it then fills with white,
 * followed by another 2 GB for the tight repack. The bytes are
 * attacker-supplied: OCR runs on any text-less PDF that arrives by import or
 * by download. */
export const MAX_PAGE_EDGE = 20_000;

/** Prefix stored ahead of recognized text so viewers can distinguish OCR from
 * authored/extracted text. Kept in sync with `src/viewers/util.ts`. */
export const OCR_TEXT_PREFIX = "(text recognized from scan)";

/** Scripts worth offering the recognizer, in priority order. Only English
 * and Hebrew used to be requested, so a scan in Russian, Chinese, Japanese
 * or Arabic came back completely empty, and a French or German page was
 * read AS English — which mangles its accented words.
 *
 * These are language PREFIXES, matched against whatever a real Vision-backed
 * implementation reports as supported on the Mac it runs on; that device's
 * own identifiers are what gets passed back. Handing Vision a code it
 * doesn't know makes it refuse the entire request, which is exactly how "OCR
 * found nothing" happens silently. Ported verbatim as data — the matching
 * itself (`available_languages`/`_available_languages`) is a real Vision
 * call with no Node equivalent, part of {@link OcrRecognizeFn}'s gap. */
export const WANTED_LANGUAGE_PREFIXES: readonly string[] = [
  "en", "he", "fr", "de", "es", "it", "pt", "nl", "ru", "uk", "ar", "ars", "zh", "yue",
  "ja", "ko", "th", "vi", "pl", "tr",
];

// ------------------------------------------------------------------ candidacy

/** True for the file kinds worth OCR-ing when text extraction came back
 * empty: raster images and PDFs (which may be image-only scans). Ported
 * verbatim from `ocr::is_ocr_candidate` — see this module's doc for the
 * pre-existing duplicate at `retrievalBackfill.ts`. */
export function isOcrCandidate(mime: string, ext: string): boolean {
  return mime.startsWith("image/") || ext === "pdf";
}

// -------------------------------------------------------------- page sizing

export interface PageRasterSize {
  width: number;
  height: number;
  scale: number;
}

/**
 * Rust's `f64 as usize` — a SATURATING float-to-integer cast (stabilized in
 * Rust 1.45): `NaN` becomes 0, anything below zero becomes 0, anything above
 * `usize::MAX` becomes `usize::MAX`.
 *
 * This is not a pedantic detail here, it is the load-bearing half of
 * {@link pageRasterSize}'s guard. Rust's `width == 0 || height == 0` check
 * only catches a degenerate page BECAUSE the cast folds `NaN` and negatives
 * into 0 first. Translated as a bare `Math.ceil`, `pageRasterSize(NaN, 100)`
 * returned `{width: NaN, height: 200}` and `pageRasterSize(-100, 200)`
 * returned `{width: -200, …}` — both sailing past the zero check that is
 * supposed to be the last line of defence before a bitmap is allocated from
 * an ATTACKER-SUPPLIED `/MediaBox`. (The Rust CALL SITE additionally sanitizes
 * with `media.size.width.max(0.0)`, and `f64::max` returns the non-NaN
 * operand — but `page_raster_size` is a separately-exported, separately-tested
 * guard in both languages, and this port must not be weaker than the one it
 * claims to be a verbatim translation of.)
 *
 * The upper saturation needs no code: every caller below immediately
 * `Math.min`s against `MAX_PAGE_EDGE`, which lands on the same answer whether
 * the input saturated at `usize::MAX` or stayed a large float.
 */
function asUsize(n: number): number {
  return Number.isNaN(n) ? 0 : Math.max(0, n);
}

/**
 * Bitmap size (and the scale that produced it) for one page's media box, or
 * `null` when there is nothing drawable. Pure, so both caps are testable
 * without a PDF. Ported verbatim from `mac::page_raster_size`.
 *
 * Cap order matters: the area cap runs FIRST (it alone would let a
 * degenerate long-thin media box slip an enormous single dimension through,
 * since area bounds neither edge on its own), THEN each edge is clamped
 * independently.
 */
export function pageRasterSize(pageW: number, pageH: number): PageRasterSize | null {
  let scale = PDF_RENDER_SCALE;
  const pixels = pageW * pageH * scale * scale;
  if (pixels > MAX_PAGE_PIXELS) {
    scale *= Math.sqrt(MAX_PAGE_PIXELS / pixels);
  }
  // Then clamp each edge on its own, so a degenerate media box can't slip an
  // enormous single dimension past the area cap.
  for (const edge of [pageW, pageH]) {
    if (edge * scale > MAX_PAGE_EDGE) {
      scale = MAX_PAGE_EDGE / edge;
    }
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    return null;
  }
  // `Math.min` rather than a bare check: rounding up can leave the product a
  // hair over the clamp, and clipping a sub-pixel is better than refusing a
  // legitimately poster-sized page. {@link asUsize} reproduces Rust's
  // saturating `as usize`, without which the zero check below cannot catch a
  // NaN or negative media-box edge.
  const width = Math.min(asUsize(Math.ceil(pageW * scale)), MAX_PAGE_EDGE);
  const height = Math.min(asUsize(Math.ceil(pageH * scale)), MAX_PAGE_EDGE);
  if (width === 0 || height === 0) {
    return null;
  }
  return { width, height, scale };
}

/**
 * What this scan's text does NOT contain, appended so neither the reader nor
 * the model treats a partial read as the whole file. Empty when every page
 * was both reached and rendered. Ported verbatim from `mac::unread_notes`.
 *
 * `pages` is how many were attempted (the cap), `unrendered` how many of
 * those the rasterizer could not draw at all.
 */
export function unreadNotes(totalPages: number, pages: number, unrendered: number): string {
  let notes = "";
  if (totalPages > pages) {
    notes += `\n\n[only the first ${pages} of ${totalPages} pages of this scan were read]`;
  }
  if (unrendered > 0) {
    notes += `\n\n[${unrendered} of ${pages} pages of this scan could not be rendered and were not read]`;
  }
  return notes;
}

// -------------------------------------------------------------- recognition

/**
 * `recognize(mime, ext, bytes) -> Option<String>`'s injectable seam,
 * standing in for the whole Vision (+ PDF rasterization) pipeline as ONE
 * call — matching `previewTools.ts`'s `PreviewRenderFn` and how a real
 * future wiring will actually reach this: one HTTP round trip to the
 * sidecar's live `/ocr` endpoint, which internally does exactly what
 * `ocr.py`'s own `recognize` does (dispatch on extension, rasterize+OCR a
 * PDF page by page OR OCR a single image, in Python). See this module's doc
 * for why the caps/bookkeeping live here as their own real functions rather
 * than being folded into a more granular seam nothing will ever call
 * separately.
 */
export type OcrRecognizeFn = (mime: string, ext: string, bytes: Buffer) => Promise<string | null>;

/** The labelled reason {@link ocrRecognizeNotImplemented} rejects with.
 * Exported so a caller or a test can recognize it without hand-copying the
 * string. */
export const OCR_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: no OCR recognizer was supplied to this isolated call. Production uses " +
  "recognizeViaSidecar and the sidecar's live /ocr Vision endpoint.";

/** {@link recognize}'s `ocr` parameter falls back to when no real
 * implementation is supplied — a clearly-labelled failure, never a
 * fabricated recognition or a fabricated "found nothing." */
export const ocrRecognizeNotImplemented: OcrRecognizeFn = () =>
  Promise.reject(new Error(OCR_NOT_IMPLEMENTED));

/**
 * Port of `ocr::recognize`. Recognizes text in a PDF or image's bytes,
 * on-device. Resolves the recognized text (WITHOUT the caller's "(text
 * recognized from scan)" prefix — that belongs to `run_ocr_job`, not ported
 * here, see this module's doc), or `null` when nothing was read.
 *
 * `text.filter(|t| !t.trim().is_empty())` — a blank recognition reads the
 * same as no recognition at all.
 *
 * Throws only when `ocr` itself rejects — see this module's doc's DEVIATION
 * note for why that is not swallowed into `null` the way Rust's own
 * "best-effort, any failure returns None" promise might suggest.
 */
export async function recognize(
  mime: string,
  ext: string,
  bytes: Buffer,
  ocr: OcrRecognizeFn = ocrRecognizeNotImplemented
): Promise<string | null> {
  const text = await ocr(mime, ext, bytes);
  return text !== null && text.trim() !== "" ? text : null;
}

/** Production Vision recognizer, hosted by the Python sidecar. */
export async function recognizeViaSidecar(
  mime: string,
  ext: string,
  bytes: Buffer,
): Promise<string | null> {
  const outcome = await sidecarJsonCancellable(
    "/ocr",
    { mime, ext, data_b64: bytes.toString("base64") },
    new CancelFlag(),
    30 * 60 * 1000,
  );
  if (outcome.kind === "stopped") throw new Error("Stopped.");
  if (outcome.kind === "error") throw new Error(outcome.error.error);
  const value = outcome.value as { text?: unknown } | null;
  return typeof value?.text === "string" ? value.text : null;
}
