"""Fake-only orchestration tests for PDF OCR."""

from __future__ import annotations

from arcelle_sidecar.media import ocr


class FakeDocument:
    def __init__(self, page_count: int) -> None:
        self.page_count = page_count
        self.closed = False

    def close(self) -> None:
        self.closed = True


def test_ocr_pdf_keeps_page_order_and_reports_skipped_fake_rasters(monkeypatch) -> None:
    document = FakeDocument(page_count=3)
    seen_pages: list[int] = []
    seen_images: list[bytes] = []

    def fake_open(*_args, **_kwargs):
        return document

    def fake_render(_doc, page_number: int) -> bytes | None:
        seen_pages.append(page_number)
        return (b"first", None, b"third")[page_number]

    def fake_ocr(png: bytes) -> str | None:
        seen_images.append(png)
        return {b"first": "First page", b"third": "Third page"}[png]

    monkeypatch.setattr(ocr.pymupdf, "open", fake_open)
    monkeypatch.setattr(ocr, "_render_pdf_page_png", fake_render)
    monkeypatch.setattr(ocr, "ocr_image_bytes", fake_ocr)

    assert ocr.ocr_pdf(b"fake pdf") == (
        "First page\nThird page\n\n[1 of 3 pages of this scan could not be rendered and were not read]"
    )
    assert seen_pages == [0, 1, 2]
    assert seen_images == [b"first", b"third"]
    assert document.closed is True


def test_ocr_pdf_honors_the_page_cap_with_fake_document_boundaries(monkeypatch) -> None:
    document = FakeDocument(page_count=3)
    seen_pages: list[int] = []

    monkeypatch.setattr(ocr, "MAX_PDF_PAGES", 2)
    monkeypatch.setattr(ocr.pymupdf, "open", lambda **_kwargs: document)
    monkeypatch.setattr(
        ocr,
        "_render_pdf_page_png",
        lambda _doc, page_number: seen_pages.append(page_number) or f"page-{page_number}".encode(),
    )
    monkeypatch.setattr(ocr, "ocr_image_bytes", lambda png: png.decode())

    assert ocr.ocr_pdf(b"fake pdf") == "page-0\npage-1\n\n[only the first 2 of 3 pages of this scan were read]"
    assert seen_pages == [0, 1]
    assert document.closed is True


def test_ocr_pdf_returns_none_and_closes_a_zero_page_fake_document(monkeypatch) -> None:
    document = FakeDocument(page_count=0)
    monkeypatch.setattr(ocr.pymupdf, "open", lambda **_kwargs: document)
    monkeypatch.setattr(ocr, "_render_pdf_page_png", lambda *_args: (_ for _ in ()).throw(AssertionError()))

    assert ocr.ocr_pdf(b"fake pdf") is None
    assert document.closed is True
