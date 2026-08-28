"""Tests for `arcelle_sidecar.media.ocr` (port of `src-tauri/src/ocr.rs`).

Sections (1)-(3) are pure-function ports of the Rust `#[cfg(test)]` modules
(`mod tests` in both the top-level file and the `mac` submodule) and need
nothing from the OS. Sections (4)-(6) genuinely exercise Apple's Vision
framework and `pymupdf` against real bytes generated in-process — no
mocking of the framework calls themselves. Vision requires macOS; on any
other platform those tests skip with a clear reason instead of failing,
exactly like the Rust suite (which is itself `#[cfg(target_os = "macos")]`
-gated and simply does not build the OCR-running code, only the pure
`page_raster_size`/`unread_notes` tests, elsewhere).

Note on scope: `is_ocr_candidate` only matches `image/*` mimes and the
`pdf` extension (never video), so unlike the sibling `decode`/`probe`
modules this suite has no video fixture to reach for.
"""

from __future__ import annotations

import math
import platform

import pymupdf
import pytest

from arcelle_sidecar.media import ocr

_ON_MACOS = platform.system() == "Darwin"
try:
    import Vision as _Vision  # noqa: F401

    _HAS_VISION = True
except ImportError:
    _HAS_VISION = False

requires_vision = pytest.mark.skipif(
    not (_ON_MACOS and _HAS_VISION),
    reason="requires macOS with the PyObjC Vision framework bridge installed",
)


# --------------------------------------------------------- (1) page_raster_size


def test_a_degenerate_media_box_cannot_ask_for_a_gigabyte_bitmap() -> None:
    # Regression: the per-dimension guard was replaced by an area cap alone,
    # and area bounds NEITHER side. /MediaBox [0 0 250000000 0.001] has an
    # area of 250 000 pt^2, so the cap left the scale at 2.0 and the render
    # would ask for a 500 000 000 x 1 bitmap -- a 2 GB context, plus another
    # 2 GB for the tight repack. Confirms the cap ORDER: area cap first,
    # then the per-edge clamp catches what the area cap could not.
    for w, h in [(250_000_000.0, 0.001), (0.001, 250_000_000.0)]:
        result = ocr.page_raster_size(w, h)
        assert result is not None, f"({w}, {h}) should still be renderable"
        width, height, _scale = result
        assert width <= ocr.MAX_PAGE_EDGE, f"width {width} unbounded"
        assert height <= ocr.MAX_PAGE_EDGE, f"height {height} unbounded"
        assert width * height <= ocr.MAX_PAGE_PIXELS, f"{width}x{height} past the area cap"


def test_ordinary_a4_page_renders_at_full_scale() -> None:
    # A4 at 72dpi: rendered at the full 2x, untouched by either cap.
    result = ocr.page_raster_size(595.0, 842.0)
    assert result is not None, "A4 renders"
    width, height, scale = result
    assert scale == ocr.PDF_RENDER_SCALE
    assert (width, height) == (1190, 1684)


def test_poster_sized_page_is_scaled_down_not_refused() -> None:
    # A wall-sized plan: scaled DOWN by the area cap, not refused.
    result = ocr.page_raster_size(5000.0, 7000.0)
    assert result is not None, "poster renders"
    width, height, scale = result
    assert 0.0 < scale < ocr.PDF_RENDER_SCALE, f"scale {scale}"
    # Rounding each edge UP can put the product a pixel-row over.
    assert width * height <= ocr.MAX_PAGE_PIXELS + (width + height), f"{width}x{height}"


def test_nothing_drawable_returns_none() -> None:
    assert ocr.page_raster_size(0.0, 0.0) is None
    assert ocr.page_raster_size(math.inf, math.inf) is None
    huge = 1.7976931348623157e308  # ~= f64::MAX
    assert ocr.page_raster_size(huge, huge) is None


def test_page_raster_size_scale_is_always_finite_and_positive_when_present() -> None:
    for w, h in [(1.0, 1.0), (250_000_000.0, 0.001), (5000.0, 7000.0), (595.0, 842.0)]:
        result = ocr.page_raster_size(w, h)
        if result is not None:
            _w, _h, scale = result
            assert math.isfinite(scale)
            assert scale > 0.0


# ------------------------------------------------------------- (2) unread_notes


def test_pages_that_could_not_be_rendered_are_declared() -> None:
    # Regression: a scan whose pages mostly failed to rasterize was stored
    # and answered from as if the few that worked were the whole document --
    # the loop `continue`d and, with no cap in play, nothing was appended at
    # all.
    note = ocr.unread_notes(12, 12, 9)
    assert "9 of 12" in note, note
    assert "could not be rendered" in note, note
    assert "only the first" not in note, note

    # A whole document that rendered cleanly says nothing extra.
    assert ocr.unread_notes(12, 12, 0) == ""
    # One page short of clean still speaks up.
    assert "1 of 12" in ocr.unread_notes(12, 12, 1)

    # Capped AND partly unrenderable: both facts, cap first.
    both = ocr.unread_notes(900, 500, 3)
    cap_idx = both.find("only the first 500 of 900")
    skip_idx = both.find("3 of 500")
    assert cap_idx != -1, both
    assert skip_idx != -1, both
    assert cap_idx < skip_idx, both

    # Capped but every attempted page drew: only the cap note.
    capped = ocr.unread_notes(900, 500, 0)
    assert "only the first 500 of 900" in capped, capped
    assert "could not be rendered" not in capped, capped


# ---------------------------------------------------------- (3) is_ocr_candidate


def test_ocr_candidates_are_images_and_pdfs() -> None:
    assert ocr.is_ocr_candidate("image/jpeg", "jpg")
    assert ocr.is_ocr_candidate("image/png", "png")
    assert ocr.is_ocr_candidate("application/pdf", "pdf")
    # Not scans: text/office formats we already extract natively.
    assert not ocr.is_ocr_candidate("text/plain", "txt")
    assert not ocr.is_ocr_candidate(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docx",
    )


def test_wanted_language_prefixes_exact_order() -> None:
    assert list(ocr.WANTED_LANGUAGE_PREFIXES) == [
        "en", "he", "fr", "de", "es", "it", "pt", "nl", "ru", "uk", "ar", "ars", "zh", "yue",
        "ja", "ko", "th", "vi", "pl", "tr",
    ]


# ------------------------------------------------------------- (4) real Vision OCR


def _render_text_png(text: str, width: int = 500, height: int = 150) -> bytes:
    """Render `text` onto a real pymupdf page and return real PNG bytes --
    genuine rasterized text, not a synthetic fixture."""
    doc = pymupdf.open()
    try:
        page = doc.new_page(width=width, height=height)
        page.insert_text((20, height / 2), text, fontsize=28)
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(2.0, 2.0), alpha=False)
        return pixmap.tobytes("png")
    finally:
        doc.close()


@requires_vision
def test_ocr_image_bytes_recovers_real_text_from_a_rendered_png() -> None:
    png = _render_text_png("Hello World Testing OCR")
    result = ocr.ocr_image_bytes(png)
    assert result is not None, "Vision found nothing in a clean rendered PNG"
    lowered = result.lower()
    assert "hello" in lowered and "world" in lowered, result


@requires_vision
def test_ocr_image_bytes_on_a_blank_image_returns_none() -> None:
    doc = pymupdf.open()
    try:
        page = doc.new_page(width=300, height=100)
        png = page.get_pixmap(alpha=False).tobytes("png")
    finally:
        doc.close()
    assert ocr.ocr_image_bytes(png) is None


@requires_vision
def test_run_recognition_returns_none_when_handler_finds_nothing() -> None:
    import objc
    import Vision
    from Foundation import NSData

    # 1x1 real (tiny but valid) PNG -- decodable, but has no legible text.
    tiny_png = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\xcf\xc0"
        b"\x00\x00\x03\x01\x01\x00\x18\xdd\x8d\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    with objc.autorelease_pool():
        ns_data = NSData.dataWithBytes_length_(tiny_png, len(tiny_png))
        handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(ns_data, {})
        assert ocr.run_recognition(handler) is None


@requires_vision
def test_available_languages_is_a_valid_priority_filtered_subsequence() -> None:
    import Vision

    request = Vision.VNRecognizeTextRequest.new()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    chosen = ocr._available_languages(request)
    # Whatever this Mac supports, "en" should be among the offered scripts.
    bases = [c.split("-", 1)[0] for c in chosen]
    assert "en" in bases, chosen
    # No duplicates, every base a WANTED prefix, and non-decreasing priority.
    assert len(bases) == len(set(chosen))
    seen_priority = -1
    for base in bases:
        assert base in ocr.WANTED_LANGUAGE_PREFIXES, base
        priority = ocr.WANTED_LANGUAGE_PREFIXES.index(base)
        assert priority >= seen_priority, (base, chosen)
        seen_priority = priority


@requires_vision
def test_pixmap_alpha_false_is_opaque_white_not_black() -> None:
    """Empirical check backing the deviation note in ocr.py's docstring: a
    blank pymupdf page rendered with `alpha=False` composites onto opaque
    white, so no separate white-fill step (unlike the CoreGraphics path in
    Rust, which paints white explicitly before drawing) is needed before
    handing pages to the recognizer -- a transparent/vector-text page will
    not be misread as light text on a black background.
    """
    doc = pymupdf.open()
    try:
        page = doc.new_page(width=50, height=50)
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(1.0, 1.0), alpha=False)
        assert pixmap.alpha == 0
        assert pixmap.samples[:12] == b"\xff" * 12
    finally:
        doc.close()


# --------------------------------------------------------- (5) real pymupdf OCR


@requires_vision
def test_ocr_pdf_recovers_real_text_from_a_two_page_pdf() -> None:
    doc = pymupdf.open()
    try:
        p1 = doc.new_page(width=400, height=200)
        p1.insert_text((20, 100), "Alpha Bravo Charlie", fontsize=24)
        p2 = doc.new_page(width=400, height=200)
        p2.insert_text((20, 100), "Delta Echo Foxtrot", fontsize=24)
        pdf_bytes = doc.tobytes()
    finally:
        doc.close()

    text = ocr.ocr_pdf(pdf_bytes)
    assert text is not None, "OCR found nothing in the PDF at all"
    lowered = text.lower()
    assert "alpha" in lowered and "bravo" in lowered, text
    assert "delta" in lowered and "echo" in lowered, text
    # Two pages, well under both caps: no partial-read note appended.
    assert "only the first" not in text, text
    assert "could not be rendered" not in text, text


@requires_vision
def test_ocr_pdf_on_a_blank_single_page_pdf_returns_none() -> None:
    doc = pymupdf.open()
    try:
        doc.new_page(width=300, height=100)
        pdf_bytes = doc.tobytes()
    finally:
        doc.close()
    assert ocr.ocr_pdf(pdf_bytes) is None


def test_ocr_pdf_on_a_zero_page_pdf_returns_none() -> None:
    # pymupdf refuses to `.tobytes()`/`.save()` a zero-page document
    # ("cannot save with zero pages"), so a genuinely empty PDF has to be
    # built by hand rather than via the library's own writer. pymupdf's
    # repair path tolerates the made-up (wrong) byte offsets fine -- it
    # rebuilds the xref -- and opens this as a real zero-page document,
    # exercising the `pages == 0: return None` branch specifically (as
    # opposed to `pymupdf.open` itself failing on garbage bytes).
    pdf_bytes = (
        b"%PDF-1.4\n"
        b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
        b"2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n"
        b"trailer\n<< /Size 3 /Root 1 0 R >>\n%%EOF\n"
    )
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    assert doc.page_count == 0, "test fixture itself must be a genuine zero-page PDF"
    doc.close()

    assert ocr.ocr_pdf(pdf_bytes) is None


@requires_vision
def test_recognize_dispatches_pdf_vs_image_by_extension() -> None:
    doc = pymupdf.open()
    try:
        page = doc.new_page(width=400, height=200)
        page.insert_text((20, 100), "Golf Hotel India", fontsize=24)
        pdf_bytes = doc.tobytes()
    finally:
        doc.close()

    text = ocr.recognize("application/pdf", "pdf", pdf_bytes)
    assert text is not None
    assert "golf" in text.lower() and "hotel" in text.lower(), text

    png = _render_text_png("Golf Hotel India")
    text2 = ocr.recognize("image/png", "png", png)
    assert text2 is not None
    assert "golf" in text2.lower() and "hotel" in text2.lower(), text2


# ------------------------------------------------------- (6) garbage input


def test_ocr_image_bytes_on_garbage_returns_none() -> None:
    garbage = b"not an image at all, just plain garbage bytes" * 20
    assert ocr.ocr_image_bytes(garbage) is None


def test_ocr_image_bytes_on_empty_bytes_returns_none() -> None:
    assert ocr.ocr_image_bytes(b"") is None


def test_ocr_pdf_on_garbage_returns_none() -> None:
    garbage = b"not a pdf at all, just plain garbage bytes" * 20
    assert ocr.ocr_pdf(garbage) is None


def test_ocr_pdf_on_empty_bytes_returns_none() -> None:
    assert ocr.ocr_pdf(b"") is None


def test_recognize_on_garbage_returns_none_for_both_dispatches() -> None:
    garbage = b"garbage garbage garbage garbage garbage garbage" * 10
    assert ocr.recognize("application/pdf", "pdf", garbage) is None
    assert ocr.recognize("image/png", "png", garbage) is None
