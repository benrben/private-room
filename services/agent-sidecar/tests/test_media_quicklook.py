"""Tests for `arcelle_sidecar.media.quicklook` (port of
`src-tauri/src/quicklook.rs`).

Exercises the REAL `QLThumbnailGenerator` system service — no mocking of the
PyObjC calls themselves. The temp-file lifecycle (owner-only from creation,
removed on every exit path including refusal and a mid-render exception, a
unique name per render, the original extension preserved since QuickLook
dispatches on it) is the actual point of this module; the rendering is a
convenience layered on top.
"""

from __future__ import annotations

import os
import stat
import tempfile
import uuid
from pathlib import Path

import pytest

from arcelle_sidecar.media import quicklook as ql

_TMP_DIR = Path(tempfile.gettempdir())


def _leftovers(suffix: str) -> int:
    """Count leftover `arcelle-ql-*` temp copies WITH A GIVEN suffix.

    Filtering by suffix is what makes this honest on a shared temp directory:
    a naive count of every `arcelle-ql-*` file could see some unrelated
    leftover and report a leak that isn't there. Each test below owns a
    suffix no other test in this file uses, mirroring the Rust test file's
    own `leftovers(suffix)` helper.
    """
    try:
        return sum(
            1
            for entry in os.listdir(_TMP_DIR)
            if entry.startswith("arcelle-ql-") and entry.endswith(suffix)
        )
    except OSError:
        return 0


def _extensionless_leftovers() -> int:
    """Count leftover `arcelle-ql-*` copies with NO extension — the shape
    `temp_path_for` produces for an extension-less name.
    """
    try:
        return sum(
            1
            for entry in os.listdir(_TMP_DIR)
            if entry.startswith("arcelle-ql-") and "." not in entry
        )
    except OSError:
        return 0


# ------------------------------------------------ (1) empty bytes -> no disk


def test_empty_bytes_are_not_written_to_disk_at_all(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The fast refusal must not even ask for a temp path.

    This used to snapshot the shared OS temp directory, which made the test
    race unrelated tests creating directories such as ``relay-deploy-*``.
    An isolated directory plus seams that fail on a write-path call checks the
    actual contract more directly: empty bytes do not allocate a temp name or
    write a file at all.
    """

    def _unexpected_temp_access(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("empty input must not access the temp-file path")

    monkeypatch.setattr(ql, "temp_path_for", _unexpected_temp_access)
    monkeypatch.setattr(ql, "write_private", _unexpected_temp_access)
    before = set(tmp_path.iterdir())
    assert ql.preview_png("thing.key", b"") is None
    after = set(tmp_path.iterdir())
    assert after == before, "empty input touched the temp directory"


# ------------------------------------------------ (2) always cleaned up


def test_the_temp_copy_is_always_removed() -> None:
    # Whatever QuickLook does with it — render, refuse, or time out — the
    # decrypted copy must not survive the call.
    assert _leftovers(".qltest") == 0, "a previous run leaked"
    _ = ql.preview_png("probe.qltest", b"hello")
    assert _leftovers(".qltest") == 0, (
        "a decrypted preview copy was left in the temp directory"
    )


# ------------------------------------------------ (2b) cleaned up even on a
# mid-render EXCEPTION — the specific thing a trailing cleanup line (rather
# than a `finally`) would fail to guarantee.


def test_the_temp_copy_is_removed_even_if_the_render_raises(monkeypatch) -> None:
    """`preview_png` wraps the render call in `try/finally`, not a trailing
    `_remove()` after it. Prove that distinction: force the render step to
    raise instead of returning, and confirm the temp file is still gone and
    the exception still propagates. A `result = thumbnail_png(...); _remove
    (path); return result` shape would leak the temp file here because the
    line after the raising call never runs.
    """

    def _boom(path: str, max_edge: float) -> bytes | None:
        raise RuntimeError("simulated render failure")

    monkeypatch.setattr(ql, "thumbnail_png", _boom)

    assert _leftovers(".qlboom") == 0, "a previous run leaked"
    with pytest.raises(RuntimeError, match="simulated render failure"):
        ql.preview_png("probe.qlboom", b"hello")
    assert _leftovers(".qlboom") == 0, (
        "the temp copy survived an exception raised mid-render"
    )


# ------------------------------------------------ (3) unique + no collision


def test_a_file_with_no_extension_still_gets_a_unique_temp_name() -> None:
    # Two renders must never collide on one path: the exclusive-create would
    # make the second fail and silently return no preview.
    a = ql.temp_path_for("noext")
    b = ql.temp_path_for("noext")
    assert a != b, "two renders of the same name reused one temp path"

    assert _extensionless_leftovers() == 0, "a previous run leaked"
    _ = ql.preview_png("noext", b"hello")
    assert _extensionless_leftovers() == 0, (
        "a decrypted preview copy of an extension-less file was left behind"
    )


# ------------------------------------------------ (4) owner-only while alive


def test_the_temp_copy_is_owner_only_while_it_exists() -> None:
    from arcelle_sidecar.media.decode import write_private

    path = _TMP_DIR / f"arcelle-ql-{uuid.uuid4()}.qlperm"
    write_private(path, b"secret")
    try:
        mode = stat.S_IMODE(os.stat(path).st_mode)
        assert mode == 0o600, "a decrypted preview copy was readable by other users"
    finally:
        ql._remove(path)


# ------------------------------------------------ (5) exclusive-create


def test_writing_twice_to_one_path_is_refused_rather_than_overwriting() -> None:
    # The exclusive create is deliberate: an existing file at that path is
    # someone else's, and clobbering it would be worse than skipping the
    # preview.
    from arcelle_sidecar.media.decode import write_private

    path = _TMP_DIR / f"arcelle-ql-{uuid.uuid4()}.qlonce"
    write_private(path, b"first")
    try:
        with pytest.raises(OSError):
            write_private(path, b"second")
    finally:
        ql._remove(path)


# ------------------------------------------------ (6) real renders


def test_thumbnail_png_produces_a_real_decodable_png_for_a_text_file(
    tmp_path: Path,
) -> None:
    """A plain `.txt` is a format every Mac can genuinely QuickLook."""
    if not ql._QUICKLOOK_AVAILABLE:
        pytest.skip("PyObjC QuickLookThumbnailing framework is not importable here")

    src = tmp_path / "sample.txt"
    src.write_text("Hello from a real QuickLook render.\n" * 40)

    png_bytes = ql.thumbnail_png(str(src), 400.0)
    if png_bytes is None:
        pytest.skip(
            "QuickLook produced no representation for a .txt file on this "
            "machine (environment-dependent, not a bug in this module)"
        )

    assert isinstance(png_bytes, (bytes, bytearray))
    assert len(png_bytes) > 0
    assert png_bytes[:8] == b"\x89PNG\r\n\x1a\n", "not a valid PNG signature"

    # Actually decode it back — confirms real, valid image bytes, not just
    # "got some bytes". PIL is a project dependency, so this proves the same
    # thing an external, independent decoder would.
    from io import BytesIO

    from PIL import Image

    with Image.open(BytesIO(png_bytes)) as img:
        img.verify()

    # And re-open (verify() invalidates the handle) to check real dimensions.
    with Image.open(BytesIO(png_bytes)) as img:
        assert img.format == "PNG"
        assert img.width > 0 and img.height > 0
        assert max(img.width, img.height) <= round(400.0 * 2.0), (
            "thumbnail exceeded max_edge * scale"
        )


def test_preview_png_end_to_end_for_a_real_png_image() -> None:
    """Round-trips a real PNG through `preview_png` — the whole path: temp
    write, QuickLook render, temp removal.
    """
    if not ql._QUICKLOOK_AVAILABLE:
        pytest.skip("PyObjC QuickLookThumbnailing framework is not importable here")

    from io import BytesIO

    from PIL import Image

    src_img = Image.new("RGB", (64, 64), color=(200, 60, 60))
    buf = BytesIO()
    src_img.save(buf, format="PNG")
    raw = buf.getvalue()

    assert _leftovers(".qlimg") == 0, "a previous run leaked"
    out = ql.preview_png("photo.qlimg", raw)
    assert _leftovers(".qlimg") == 0, "preview_png left its temp copy behind"

    if out is None:
        pytest.skip(
            "QuickLook produced no representation for a bare custom extension "
            "on this machine (environment-dependent, not a bug in this module)"
        )

    with Image.open(BytesIO(out)) as img:
        img.verify()
    with Image.open(BytesIO(out)) as img:
        assert img.format == "PNG"
        assert img.width > 0 and img.height > 0


def test_preview_png_end_to_end_for_a_real_pdf_document() -> None:
    """Round-trips a real one-page PDF — generated with pymupdf itself, no
    fixture on disk required — through `preview_png`. PDF is one of the
    long-tail formats this module's docstring calls out by name, and it needs
    the genuine `.pdf` extension (QuickLook dispatches on it) rather than one
    of the other tests' arbitrary custom suffixes.
    """
    if not ql._QUICKLOOK_AVAILABLE:
        pytest.skip("PyObjC QuickLookThumbnailing framework is not importable here")

    import pymupdf

    doc = pymupdf.open()
    try:
        page = doc.new_page()
        page.insert_text((72, 72), "Hello from a real QuickLook PDF render.")
        raw = doc.tobytes()
    finally:
        doc.close()

    assert _leftovers(".pdf") == 0, "a previous run leaked"
    out = ql.preview_png("arcelle-quicklook-fixture.pdf", raw)
    assert _leftovers(".pdf") == 0, "preview_png left its temp copy behind"

    if out is None:
        pytest.skip(
            "QuickLook produced no representation for a PDF on this machine "
            "(environment-dependent, not a bug in this module)"
        )

    from io import BytesIO

    from PIL import Image

    with Image.open(BytesIO(out)) as img:
        img.verify()
    with Image.open(BytesIO(out)) as img:
        assert img.format == "PNG"
        assert img.width > 0 and img.height > 0


# ------------------------------------------------ (7) the mov fixture, best-effort


def test_thumbnail_png_on_the_shared_mov_fixture() -> None:
    """The same short video fixture the Rust test suite uses. Skips
    gracefully if it's absent on this machine — that mirrors the Rust tests'
    own behavior, not a bug here.
    """
    fixture = Path(
        "/System/Library/Desktop Pictures/.wallpapers/Sonoma/"
        "Sonoma Graphic Light Landscape.mov"
    )
    if not fixture.exists():
        pytest.skip("shared .mov fixture is not present on this machine")
    if not ql._QUICKLOOK_AVAILABLE:
        pytest.skip("PyObjC QuickLookThumbnailing framework is not importable here")

    png_bytes = ql.thumbnail_png(str(fixture), ql.PREVIEW_EDGE)
    if png_bytes is None:
        pytest.skip("QuickLook produced no representation for the .mov fixture")

    from io import BytesIO

    from PIL import Image

    with Image.open(BytesIO(png_bytes)) as img:
        img.verify()
    with Image.open(BytesIO(png_bytes)) as img:
        assert img.format == "PNG"
        assert img.width > 0 and img.height > 0
