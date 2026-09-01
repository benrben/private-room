"""Tests for `arcelle_sidecar.docs.iwork` (port of
`src-tauri/src/extraction.rs::{iwork_preview_entry, extract_iwork}`,
lines 474-511).

No dedicated `#[cfg(test)]` cases exist for this function in the Rust
source (it's covered only indirectly elsewhere), so this suite is written
from scratch against the documented behavior: suffix matching in both flat
and package bundle layouts, first-in-archive-order tie-breaking, the
no-preview case, delegation to `extract_pdf` (including its own `None`
outcome), and both halves of the decompression-bomb guard -- declared size
alone over the cap, and (by faking a lying reader, since stdlib `zipfile`
itself never produces this on an honestly-built archive -- see the module
docstring) actual read size over the cap despite a small declared size.
"""

from __future__ import annotations

import io
import zipfile

import pymupdf

from arcelle_sidecar.docs import iwork


def _pdf_bytes(text: str) -> bytes:
    """A minimal real single-page PDF containing `text`, built the same way
    `tests/test_docs_pdf.py` builds its fixtures.
    """
    doc = pymupdf.open()
    try:
        page = doc.new_page(width=400, height=200)
        page.insert_text((20, 100), text, fontsize=24)
        return doc.tobytes()
    finally:
        doc.close()


def _zip_bytes(entries: dict[str, bytes]) -> bytes:
    """A zip archive with the given entries, written in dict-iteration
    (insertion) order -- which is also the order `zip_entry_names` will
    report them in.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in entries.items():
            zf.writestr(name, content)
    return buf.getvalue()


# --------------------------------------------------------- iwork_preview_entry


def test_finds_flat_bundle_preview() -> None:
    names = ["Index/Document.iwa", "QuickLook/Preview.pdf", "Metadata/BuildVersionHistory.plist"]
    assert iwork.iwork_preview_entry(names) == "QuickLook/Preview.pdf"


def test_finds_package_bundle_preview_by_suffix() -> None:
    names = ["MyDoc.numbers/Index/Document.iwa", "MyDoc.numbers/QuickLook/Preview.pdf"]
    assert iwork.iwork_preview_entry(names) == "MyDoc.numbers/QuickLook/Preview.pdf"


def test_match_is_case_insensitive() -> None:
    names = ["Some/QUICKLOOK/PREVIEW.PDF"]
    assert iwork.iwork_preview_entry(names) == "Some/QUICKLOOK/PREVIEW.PDF"


def test_no_match_returns_none() -> None:
    names = ["Index/Document.iwa", "Metadata/BuildVersionHistory.plist", "preview.pdf"]
    assert iwork.iwork_preview_entry(names) is None


def test_first_in_listed_order_wins_when_multiple_qualify() -> None:
    # Contrived (real bundles carry exactly one preview), but the Rust
    # source explicitly picks by `.find()` -- first hit in archive order --
    # so a second qualifying entry must never win even if it sorts earlier
    # alphabetically.
    names = ["Zzz/QuickLook/Preview.pdf", "Aaa/QuickLook/Preview.pdf"]
    assert iwork.iwork_preview_entry(names) == "Zzz/QuickLook/Preview.pdf"


def test_empty_name_list_returns_none() -> None:
    assert iwork.iwork_preview_entry([]) is None


def test_finds_modern_root_and_package_preview_jpg() -> None:
    assert iwork.iwork_preview_entry(["preview.jpg"]) == "preview.jpg"
    assert iwork.iwork_preview_entry(["Deck.key/Preview.JPG"]) == "Deck.key/Preview.JPG"


def test_pdf_is_preferred_over_jpg_regardless_of_archive_order() -> None:
    names = ["preview.jpg", "QuickLook/Preview.pdf"]
    assert iwork.iwork_preview_entry(names) == "QuickLook/Preview.pdf"


def test_unsafe_or_unrelated_nested_jpg_is_not_a_preview() -> None:
    names = ["Assets/Thumbnails/preview.jpg", "../preview.jpg", "/preview.jpg"]
    assert iwork.iwork_preview_entry(names) is None


def test_unsafe_pdf_names_cannot_hide_a_later_safe_preview() -> None:
    # Names with NULs, Windows separators, absolute paths, and traversal are
    # ignored before preview selection; only the later safe archive entry wins.
    names = [
        "\x00QuickLook/Preview.pdf",
        "QuickLook\\Preview.pdf",
        "/QuickLook/Preview.pdf",
        "../QuickLook/Preview.pdf",
        "QuickLook/Preview.pdf",
    ]
    assert iwork.iwork_preview_entry(names) == "QuickLook/Preview.pdf"


# --------------------------------------------------------------- extract_iwork


def test_flat_bundle_preview_is_extracted() -> None:
    data = _zip_bytes(
        {
            "Index/Document.iwa": b"\x00opaque-snappy-protobuf-bytes",
            "QuickLook/Preview.pdf": _pdf_bytes("Hello from a flat iWork bundle."),
            "Metadata/BuildVersionHistory.plist": b"<plist/>",
        }
    )
    result = iwork.extract_iwork(data)
    assert result is not None
    assert "Hello from a flat iWork bundle." in result


def test_package_bundle_nested_preview_is_found_by_suffix() -> None:
    data = _zip_bytes(
        {
            "MyDoc.numbers/Index/Document.iwa": b"\x00opaque",
            "MyDoc.numbers/QuickLook/Preview.pdf": _pdf_bytes("Package bundle preview text."),
        }
    )
    result = iwork.extract_iwork(data)
    assert result is not None
    assert "Package bundle preview text." in result


def test_bundle_without_quicklook_preview_returns_none() -> None:
    data = _zip_bytes(
        {
            "Index/Document.iwa": b"\x00opaque-snappy-protobuf-bytes",
            "Metadata/BuildVersionHistory.plist": b"<plist/>",
        }
    )
    assert iwork.extract_iwork(data) is None


def test_jpg_preview_has_no_text_but_is_handled_consistently() -> None:
    data = _zip_bytes({"preview.jpg": b"\xff\xd8synthetic\xff\xd9"})
    assert iwork.iwork_preview_entry(["preview.jpg"]) == "preview.jpg"
    assert iwork.extract_iwork(data) is None


def test_non_zip_garbage_returns_none() -> None:
    assert iwork.extract_iwork(b"not a zip archive at all") is None


def test_preview_entry_stops_when_the_archive_cannot_be_opened(monkeypatch) -> None:
    data = _zip_bytes({"QuickLook/Preview.pdf": _pdf_bytes("unopenable archive")})
    monkeypatch.setattr(iwork, "_iwork_archive", lambda _data: None)
    assert iwork.extract_iwork(data) is None


def test_iwork_read_helpers_refuse_unreadable_archives_and_entries(monkeypatch) -> None:
    assert iwork._iwork_archive(b"not a zip archive at all") is None

    data = _zip_bytes({"QuickLook/Preview.pdf": b"preview"})
    archive = iwork._iwork_archive(data)
    assert archive is not None
    assert iwork._iwork_preview_bytes(archive, "missing.pdf") is None

    def unreadable_preview(*_args, **_kwargs):
        raise zipfile.BadZipFile("corrupt preview")

    monkeypatch.setattr(archive, "open", unreadable_preview)
    assert iwork._iwork_preview_bytes(archive, "QuickLook/Preview.pdf") is None


def test_preview_entry_with_unparsable_pdf_bytes_returns_none() -> None:
    # extract_pdf's own None outcome (garbage PDF bytes) must propagate,
    # not be swallowed into a truthy empty string or raise.
    data = _zip_bytes({"QuickLook/Preview.pdf": b"this is not a pdf"})
    assert iwork.extract_iwork(data) is None


def test_first_qualifying_entry_wins_over_a_later_one() -> None:
    # Same tie-break as iwork_preview_entry, exercised end-to-end: the
    # first-listed preview's PDF is the one actually read and extracted.
    data = _zip_bytes(
        {
            "First/QuickLook/Preview.pdf": _pdf_bytes("first preview wins"),
            "Second/QuickLook/Preview.pdf": _pdf_bytes("second preview loses"),
        }
    )
    result = iwork.extract_iwork(data)
    assert result is not None
    assert "first preview wins" in result
    assert "second preview loses" not in result


def test_declared_size_alone_over_the_cap_is_refused(monkeypatch) -> None:
    pdf = _pdf_bytes("This preview is perfectly readable, just too big to allow.")
    data = _zip_bytes({"QuickLook/Preview.pdf": pdf})
    # Lower the cap below the entry's honestly-declared size so the first
    # check alone must refuse it.
    monkeypatch.setattr(iwork, "MAX_ZIP_ENTRY_BYTES", len(pdf) - 1)
    assert iwork.extract_iwork(data) is None


def test_actual_read_over_the_cap_is_refused_even_when_declared_size_lies(monkeypatch) -> None:
    # stdlib zipfile truncates ZipExtFile.read() output to the archive's own
    # declared file_size, so an honestly-built zip can never make the SECOND
    # check (actual bytes read) fire on its own -- see the module docstring.
    # Fake a reader that lies the way the Rust source's guard is written to
    # distrust: getinfo() reports a small declared size, but the actual read
    # hands back more than the (now tiny) cap regardless.
    data = _zip_bytes({"QuickLook/Preview.pdf": b"whatever, replaced below"})
    monkeypatch.setattr(iwork, "MAX_ZIP_ENTRY_BYTES", 20)

    real_getinfo = zipfile.ZipFile.getinfo

    def lying_getinfo(self, name):
        info = real_getinfo(self, name)
        info.file_size = 5  # well within the 20-byte cap -- a lie
        return info

    class _LyingExtFile:
        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return False

        def read(self, n):
            return b"x" * n  # hands back the full bounded-read size regardless

    monkeypatch.setattr(zipfile.ZipFile, "getinfo", lying_getinfo)
    monkeypatch.setattr(zipfile.ZipFile, "open", lambda self, info, *a, **k: _LyingExtFile())

    assert iwork.extract_iwork(data) is None


# ----------------------------------------------------- adversarial (verify pass)


def test_first_matching_entry_fails_does_not_fall_back_to_a_later_valid_one(monkeypatch) -> None:
    # `iwork_preview_entry` commits to the FIRST qualifying name; `extract_iwork`
    # then reads ONLY that entry. If it turns out to be over the cap, the Rust
    # source never tries a second candidate -- there is no silent fallback.
    # Set the cap so the first (small, real) preview is refused while a
    # second, later-listed preview would otherwise have been perfectly
    # readable, and confirm the whole call still yields None rather than
    # quietly extracting the second one.
    first_pdf = _pdf_bytes("first, small, but pushed over the cap")
    second_pdf = _pdf_bytes("second preview would have been fine")
    data = _zip_bytes(
        {
            "First/QuickLook/Preview.pdf": first_pdf,
            "Second/QuickLook/Preview.pdf": second_pdf,
        }
    )
    monkeypatch.setattr(iwork, "MAX_ZIP_ENTRY_BYTES", len(first_pdf) - 1)
    assert iwork.extract_iwork(data) is None


def test_declared_size_exactly_at_the_cap_is_allowed_not_refused(monkeypatch) -> None:
    # Both guards in the Rust source are strict `>`, so a declared size or an
    # actual read size EQUAL to the cap must pass, not be refused off-by-one.
    pdf = _pdf_bytes("at the cap")
    data = _zip_bytes({"QuickLook/Preview.pdf": pdf})
    monkeypatch.setattr(iwork, "MAX_ZIP_ENTRY_BYTES", len(pdf))
    result = iwork.extract_iwork(data)
    assert result is not None
    assert "at the cap" in result


def test_empty_preview_entry_returns_none_via_extract_pdf_not_a_crash() -> None:
    # A zero-byte "Preview.pdf" is a real (if bizarre) possibility for a
    # crafted/corrupt bundle: the entry exists and passes both size guards
    # trivially (0 <= cap), but the bytes handed to extract_pdf are not a
    # PDF at all. Must resolve to None, not raise.
    data = _zip_bytes({"QuickLook/Preview.pdf": b""})
    assert iwork.extract_iwork(data) is None
