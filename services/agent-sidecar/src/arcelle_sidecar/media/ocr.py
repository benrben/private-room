"""On-device OCR for scans and photos (ADD-14).

Port of `src-tauri/src/ocr.rs`. When a PDF or image yields no extractable
text, we recognize the text with Apple's Vision framework
(`VNRecognizeTextRequest`) — entirely on the Mac, no bundled engine and
nothing over the network. Best-effort by design: any failure returns `None`
so import silently falls back to "no text", exactly as before this feature
existed.

English + 19 other scripts are requested with the accurate recognition
level (see `WANTED_LANGUAGE_PREFIXES`); Vision is asked which of them THIS
Mac actually supports, and only that subset is ever handed back to it — an
unsupported code makes Vision refuse the whole request, which is exactly
how "OCR found nothing" happens silently.

Everything here works on in-memory bytes, never the filesystem (mirroring
the Rust source's `CFData`/`NSData`-backed handlers): there is no temp file
to worry about for this module, unlike `quicklook.py`.

Backend notes (the two things objc2 does with CoreGraphics/`CGPDFDocument`
that PyObjC has no direct binding for):

- PDF rendering uses `pymupdf` (a hard dependency of this project) rather
  than hand-rolled `CGPDFDocument`/`CGContext` calls. It decodes/rasterizes
  the page itself and produces PNG bytes directly, removing the need to
  build a bitmap context, repack a padded row, and encode a PNG by hand.
  The page-size caps (`page_raster_size`) are ported verbatim regardless:
  they exist to keep an attacker-controlled media box from asking for a
  multi-gigabyte allocation, and that risk is identical whichever library
  ends up doing the rasterizing.
- Rust explicitly paints a white rectangle behind the page before drawing
  it, "so transparent (vector-text) pages don't recognize as light text on
  black." Empirically verified (see `test_pixmap_alpha_false_is_opaque_
  white_not_black` in the test suite) against the installed pymupdf
  (1.28.2): `Page.get_pixmap(alpha=False)` already composites onto opaque
  white — a blank page's corner samples come back `0xff 0xff 0xff`, not
  black or transparent. `alpha=False` is passed explicitly (it also happens
  to be the library default) to PIN that behavior rather than merely rely
  on whatever the current default is, matching the Rust side's explicit
  (not incidental) white fill.

Platform note: the Rust source is `#[cfg(target_os = "macos")]`-gated and
returns `None` on every other platform. This module has no compile-time
gate, so it does the equivalent at runtime: if the `Vision`/`Foundation`
PyObjC bridges are not importable, `ocr_image_bytes` (and therefore
`recognize`/`ocr_pdf`, which call it) degrade to `None` rather than raising
an `ImportError` at call time. On the real target (macOS with PyObjC
installed, the only platform this sidecar ships on) this branch never runs.
"""

from __future__ import annotations

import math
from typing import Any

import pymupdf

try:
    import objc
    import Vision
    from Foundation import NSData
except ImportError:  # pragma: no cover - this sidecar only ships on macOS
    objc = None  # type: ignore[assignment]
    Vision = None  # type: ignore[assignment]
    NSData = None  # type: ignore[assignment]


def is_ocr_candidate(mime: str, ext: str) -> bool:
    """True for the file kinds worth OCR-ing when text extraction came back
    empty: raster images and PDFs (which may be image-only scans)."""
    return mime.startswith("image/") or ext == "pdf"


# ------------------------------------------------------------------ PDF caps

#: Render PDFs at 2x the point size so small scanned type is legible to the
#: recognizer.
PDF_RENDER_SCALE: float = 2.0

#: Bound work on huge documents; OCR runs in the background, but it should
#: not read a library. Whatever this cuts is REPORTED in the text — the old
#: 50-page limit meant a 200-page scan looked like it had worked while three
#: quarters of it was missing from search and from every answer.
MAX_PDF_PAGES: int = 500

#: Ceiling on one rasterized page. 40 MP is ~160 MB for the RGBA bitmap, and
#: the tight repack plus the PNG encode each cost about as much again. The
#: old guard was per-dimension (20 000 x 20 000), which allowed a 1.6 GB
#: allocation and then two more copies of it. A poster- or map-sized page is
#: rendered at a reduced scale rather than skipped outright.
MAX_PAGE_PIXELS: float = 40_000_000.0

#: Ceiling on EITHER edge of a rasterized page. Area alone bounds neither
#: side: a page whose media box declares 250 000 000 x 0.001 pt has a
#: trivial area, so the area cap leaves the scale at 2.0 and the rasterizer
#: is asked for a 500 000 000 x 1 bitmap — 2 GB it then fills with white,
#: followed by another 2 GB for the tight repack. The bytes are
#: attacker-supplied: OCR runs on any text-less PDF that arrives by import
#: or by download.
MAX_PAGE_EDGE: float = 20_000.0


def page_raster_size(page_w: float, page_h: float) -> tuple[int, int, float] | None:
    """Bitmap size (and the scale that produced it) for one page's media
    box, or `None` when there is nothing drawable. Pure, so both caps are
    testable without a PDF.

    Cap order matters: the area cap runs FIRST (it alone would let a
    degenerate long-thin media box slip an enormous single dimension
    through, since area bounds neither edge on its own), THEN each edge is
    clamped independently. This is ported verbatim from the Rust source.
    """
    scale = PDF_RENDER_SCALE
    pixels = page_w * page_h * scale * scale
    if pixels > MAX_PAGE_PIXELS:
        scale *= math.sqrt(MAX_PAGE_PIXELS / pixels)
    # Then clamp each edge on its own, so a degenerate media box can't slip
    # an enormous single dimension past the area cap.
    for edge in (page_w, page_h):
        if edge * scale > MAX_PAGE_EDGE:
            scale = MAX_PAGE_EDGE / edge
    if not math.isfinite(scale) or scale <= 0.0:
        return None
    edge_px = int(MAX_PAGE_EDGE)
    # `min()` rather than a bare check: rounding up can leave the product a
    # hair over the clamp, and clipping a sub-pixel is better than refusing
    # a legitimately poster-sized page.
    width = min(math.ceil(page_w * scale), edge_px)
    height = min(math.ceil(page_h * scale), edge_px)
    if width == 0 or height == 0:
        return None
    return (width, height, scale)


def unread_notes(total_pages: int, pages: int, unrendered: int) -> str:
    """What this scan's text does NOT contain, appended so neither the
    reader nor the model treats a partial read as the whole file. Empty
    when every page was both reached and rendered.

    `pages` is how many were attempted (the cap), `unrendered` how many of
    those the rasterizer could not draw at all.
    """
    notes = ""
    if total_pages > pages:
        notes += f"\n\n[only the first {pages} of {total_pages} pages of this scan were read]"
    if unrendered > 0:
        notes += (
            f"\n\n[{unrendered} of {pages} pages of this scan could not be "
            "rendered and were not read]"
        )
    return notes


# -------------------------------------------------------------- languages

#: Scripts worth offering the recognizer, in priority order. Only English
#: and Hebrew used to be requested, so a scan in Russian, Chinese, Japanese
#: or Arabic came back completely empty, and a French or German page was
#: read AS English — which mangles its accented words.
#:
#: These are language PREFIXES, matched against whatever this Mac reports as
#: supported; the device's own identifiers are what gets passed back.
#: Handing Vision a code it doesn't know makes it refuse the entire request,
#: which is exactly how "OCR found nothing" happens silently.
WANTED_LANGUAGE_PREFIXES: tuple[str, ...] = (
    "en", "he", "fr", "de", "es", "it", "pt", "nl", "ru", "uk", "ar", "ars", "zh", "yue",
    "ja", "ko", "th", "vi", "pl", "tr",
)


def _available_languages(request: Any) -> list[str]:
    """The subset of `WANTED_LANGUAGE_PREFIXES` this Mac actually supports,
    as its own identifiers, in our priority order."""
    try:
        supported, error = request.supportedRecognitionLanguagesAndReturnError_(None)
    except Exception:  # noqa: BLE001 - treat any Vision-side refusal as "nothing supported"
        return []
    if error is not None or not supported:
        return []
    ids = [str(s) for s in supported]
    chosen: list[str] = []
    for want in WANTED_LANGUAGE_PREFIXES:
        for lang_id in ids:
            base = lang_id.split("-", 1)[0]
            if base == want and lang_id not in chosen:
                chosen.append(lang_id)
    return chosen


def run_recognition(handler: Any) -> str | None:
    """Configure a text-recognition request (accurate level, every script
    this Mac can read), run it against `handler`, and collect the best
    candidate per text block."""
    request = Vision.VNRecognizeTextRequest.new()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    request.setUsesLanguageCorrection_(True)
    # Let Vision work out which script it is looking at rather than being
    # told it is always English; the list below is the priority hint.
    request.setAutomaticallyDetectsLanguage_(True)
    langs = _available_languages(request)
    if langs:
        request.setRecognitionLanguages_(langs)

    success, _error = handler.performRequests_error_([request], None)
    if not success:
        return None

    observations = request.results()
    if not observations:
        return None
    lines: list[str] = []
    for observation in observations:
        candidates = observation.topCandidates_(1)
        if candidates and len(candidates) > 0:
            line = str(candidates[0].string())
            if line.strip():
                lines.append(line)
    if not lines:
        return None
    return "\n".join(lines)


# ----------------------------------------------------------- image / pdf


def ocr_image_bytes(data: bytes) -> str | None:
    """OCR an image's encoded bytes (PNG/JPEG/HEIC/TIFF/… — anything
    CoreImage can decode) via a data-backed Vision request handler."""
    if Vision is None or NSData is None or objc is None:
        # Not on macOS (or PyObjC not installed): matches the Rust
        # `#[cfg(not(target_os = "macos"))]` branch, which always returns
        # `None`.
        return None
    try:
        with objc.autorelease_pool():
            ns_data = NSData.dataWithBytes_length_(data, len(data))
            handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(ns_data, {})
            return run_recognition(handler)
    except Exception:  # noqa: BLE001 - best-effort: garbage bytes must not raise
        return None


def _render_pdf_page_png(doc: Any, page_number: int) -> bytes | None:
    """Draw one PDF page (0-indexed) onto a white RGB bitmap and hand back
    PNG bytes, or `None` when the page's media box has nothing drawable, or
    the rasterizer refuses it."""
    try:
        page = doc.load_page(page_number)
        media = page.mediabox
        page_w = max(media.width, 0.0)
        page_h = max(media.height, 0.0)
        # Scale DOWN an unusually large page rather than refusing it: the
        # point of the 2x render is legibility, and half the legibility of a
        # poster still reads far better than nothing at all.
        sized = page_raster_size(page_w, page_h)
        if sized is None:
            return None
        _width, _height, scale = sized
        # `alpha=False`: paint onto an opaque white background (verified
        # empirically, see the module docstring) so transparent /
        # vector-text pages don't recognize as light text on black — the
        # same reason the Rust renderer explicitly fills white first.
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
        return pixmap.tobytes("png")
    except Exception:  # noqa: BLE001 - a damaged page object, counted not swallowed
        return None


def ocr_pdf(data: bytes) -> str | None:
    """Rasterize each PDF page to an RGB bitmap, then OCR it. Image-only
    scans have no text layer, so this is the only way to read them."""
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except Exception:  # noqa: BLE001 - a damaged or non-PDF byte string
        return None

    try:
        total_pages = doc.page_count
        pages = min(total_pages, MAX_PDF_PAGES)
        if pages == 0:
            return None

        out_parts: list[str] = []
        unrendered = 0
        for page_number in range(pages):
            png = _render_pdf_page_png(doc, page_number)
            if png is None:
                # A damaged page object or a rasterizer allocation this Mac
                # refused. Counted, not swallowed: the pages that DID render
                # must not be handed on as the whole document.
                unrendered += 1
                continue
            text = ocr_image_bytes(png)
            if text is not None and text.strip():
                out_parts.append(text)

        out = "\n".join(out_parts)
        if not out.strip():
            return None
        return out + unread_notes(total_pages, pages, unrendered)
    finally:
        doc.close()


def recognize(mime: str, ext: str, data: bytes) -> str | None:
    """Recognize text in a PDF or image's bytes, on-device. Returns the
    recognized text (WITHOUT the caller's "(text recognized from scan)"
    prefix), or `None` when nothing was read or OCR isn't available.
    Blocking — run off the request-handling thread. Returns `None` on every
    platform but macOS.
    """
    del mime  # dispatch is by extension alone, exactly like the Rust source
    text = ocr_pdf(data) if ext == "pdf" else ocr_image_bytes(data)
    if text is None or not text.strip():
        return None
    return text


__all__ = [
    "PDF_RENDER_SCALE",
    "MAX_PDF_PAGES",
    "MAX_PAGE_PIXELS",
    "MAX_PAGE_EDGE",
    "WANTED_LANGUAGE_PREFIXES",
    "is_ocr_candidate",
    "page_raster_size",
    "unread_notes",
    "run_recognition",
    "ocr_image_bytes",
    "ocr_pdf",
    "recognize",
]
