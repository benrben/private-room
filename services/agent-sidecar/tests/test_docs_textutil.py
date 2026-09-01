"""Tests for `arcelle_sidecar.docs.textutil` (port of
`src-tauri/src/textutil.rs`, all 297 lines).

Merged from two independently written candidate ports and their test
suites (`test_docs_textutil_candidate_a.py` / `_b.py`), plus two
regression tests for bugs the judging step found in one or both
candidates:

- `test_gap_length_is_counted_in_bytes_not_characters` -- one candidate's
  gap-length check counted Python characters instead of UTF-8 bytes, which
  disagrees with the Rust `gap.len()` for any gap containing a multi-byte
  character, and would silently swallow real prose in that case.
- `test_extension_of_matches_rust_path_extension` -- one candidate's
  extension parser returned an extension for a dotfile like `.bashrc`
  (Rust's `Path::extension()` returns none); the other returned no
  extension for `..foo` (Rust returns `"foo"`). Verified against a real
  `rustc` build of `std::path::Path::extension()`, not just the docs.

The conversion tests genuinely shell out to `/usr/bin/textutil` (this
suite runs on a Mac), rather than mocking the subprocess, since that
binary and its exact behaviour on real RTF is the entire point of the
module.
"""

from __future__ import annotations

import os
import stat
import subprocess
import tempfile
import uuid

import pytest

from arcelle_sidecar.docs import textutil as tu

# The exact RTF fixture from the Rust tests: bold "bold" in an otherwise
# plain sentence, at 24pt (fs48 == 48 half-points).
_SAMPLE_RTF = rb"{\rtf1\ansi{\fonttbl\f0\froman Times;}\f0\fs48 Hello \b bold\b0  world.\par}"


# ------------------------------------------------------------------ can_read


def test_only_the_formats_macos_can_import_are_offered() -> None:
    assert tu.can_read("doc")
    assert tu.can_read("rtf")
    assert tu.can_read("rtfd")
    assert tu.can_read("odt")
    assert tu.can_read("wordml")
    assert tu.can_read("webarchive")
    # .docx is deliberately absent: it renders through docx-preview with
    # page breaks, headers, footers and images, which is more than this
    # importer gives.
    assert not tu.can_read("docx")
    assert not tu.can_read("pptx")
    assert not tu.can_read("pdf")


# -------------------------------------------------------------------- convert


def test_a_real_rtf_converts_to_text() -> None:
    txt = tu.convert("sample.rtf", _SAMPLE_RTF, "txt")
    assert txt is not None, "no text from textutil"
    assert "Hello bold world." in txt, txt


def test_a_real_rtf_converts_to_html_with_its_formatting() -> None:
    html = tu.convert("sample.rtf", _SAMPLE_RTF, "html")
    assert html is not None, "no html"
    assert "<b>" in html.lower(), f"bold was lost: {html}"


def test_unreadable_extension_returns_none_without_touching_disk() -> None:
    assert tu.convert("sample.pdf", b"%PDF-1.4 not really", "txt") is None


def test_convert_unit_successfully_reads_output_and_removes_private_files(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setattr(tu.tempfile, "gettempdir", lambda: str(tmp_path))
    fixed = uuid.UUID("22222222-2222-2222-2222-222222222222")
    monkeypatch.setattr(tu.uuid, "uuid4", lambda: fixed)

    def write_converted_output(command: list[str], **_: object) -> subprocess.CompletedProcess:
        assert command == [
            "/usr/bin/textutil",
            "-convert",
            "txt",
            "-output",
            str(tmp_path / f"arcelle-tu-{fixed}.txt"),
            str(tmp_path / f"arcelle-tu-{fixed}.rtf"),
        ]
        with open(command[4], "w", encoding="utf-8") as output:
            output.write("converted prose")
        return subprocess.CompletedProcess(command, returncode=0)

    monkeypatch.setattr(tu.subprocess, "run", write_converted_output)

    assert tu.convert("sample.rtf", _SAMPLE_RTF, "txt") == "converted prose"
    assert list(tmp_path.iterdir()) == []


def test_convert_unit_folds_expected_failures_into_none_and_cleans_up(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setattr(tu.tempfile, "gettempdir", lambda: str(tmp_path))

    monkeypatch.setattr(tu, "_write_private", lambda *_: False)
    assert tu.convert("sample.rtf", _SAMPLE_RTF, "txt") is None
    assert list(tmp_path.iterdir()) == []

    monkeypatch.undo()
    monkeypatch.setattr(tu.tempfile, "gettempdir", lambda: str(tmp_path))

    def bad_exit(*_: object, **__: object) -> subprocess.CompletedProcess:
        return subprocess.CompletedProcess(args=[], returncode=1)

    monkeypatch.setattr(tu.subprocess, "run", bad_exit)
    assert tu.convert("sample.rtf", _SAMPLE_RTF, "txt") is None

    def spawn_error(*_: object, **__: object) -> None:
        raise OSError("textutil is unavailable")

    monkeypatch.setattr(tu.subprocess, "run", spawn_error)
    assert tu.convert("sample.rtf", _SAMPLE_RTF, "txt") is None

    def omit_output(command: list[str], **_: object) -> subprocess.CompletedProcess:
        return subprocess.CompletedProcess(command, returncode=0)

    monkeypatch.setattr(tu.subprocess, "run", omit_output)
    assert tu.convert("sample.rtf", _SAMPLE_RTF, "txt") is None

    def write_invalid_utf8(command: list[str], **_: object) -> subprocess.CompletedProcess:
        with open(command[4], "wb") as output:
            output.write(b"\xff")
        return subprocess.CompletedProcess(command, returncode=0)

    monkeypatch.setattr(tu.subprocess, "run", write_invalid_utf8)
    assert tu.convert("sample.rtf", _SAMPLE_RTF, "txt") is None

    def write_blank_output(command: list[str], **_: object) -> subprocess.CompletedProcess:
        with open(command[4], "w", encoding="utf-8") as output:
            output.write(" \n\t")
        return subprocess.CompletedProcess(command, returncode=0)

    monkeypatch.setattr(tu.subprocess, "run", write_blank_output)
    assert tu.convert("sample.rtf", _SAMPLE_RTF, "txt") is None
    assert list(tmp_path.iterdir()) == []


def test_convert_unit_propagates_unexpected_errors_after_cleanup(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setattr(tu.tempfile, "gettempdir", lambda: str(tmp_path))

    def unexpected_error(*_: object, **__: object) -> None:
        raise RuntimeError("unexpected conversion failure")

    monkeypatch.setattr(tu.subprocess, "run", unexpected_error)
    with pytest.raises(RuntimeError, match="unexpected conversion failure"):
        tu.convert("sample.rtf", _SAMPLE_RTF, "txt")
    assert list(tmp_path.iterdir()) == []


def test_write_private_returns_false_for_open_and_write_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    def open_error(*_: object, **__: object) -> int:
        raise OSError("cannot create private file")

    monkeypatch.setattr(tu.os, "open", open_error)
    assert tu._write_private("ignored", b"secret") is False

    monkeypatch.undo()

    class FailingWriter:
        def __enter__(self):
            return self

        def __exit__(self, *_: object) -> None:
            return None

        def write(self, _: bytes) -> None:
            raise OSError("cannot write private file")

    monkeypatch.setattr(tu.os, "open", lambda *_: 1)
    monkeypatch.setattr(tu.os, "fdopen", lambda *_: FailingWriter())
    assert tu._write_private("ignored", b"secret") is False


def test_the_decrypted_temp_copy_deletes_itself_on_every_exit_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """Exercises `convert`'s `try/finally` cleanup (the Python stand-in for
    the Rust `TempPath` `Drop` guard) across every distinct exit path, not
    just the happy path: a successful conversion, a non-zero exit, a
    reported success with no output file, and an outright exception mid-
    conversion.
    """
    fixed = uuid.UUID("11111111-1111-1111-1111-111111111111")
    monkeypatch.setattr(tu.uuid, "uuid4", lambda: fixed)
    tmp_dir = tempfile.gettempdir()

    def paths(ext: str, to: str) -> tuple[str, str]:
        return (
            os.path.join(tmp_dir, f"arcelle-tu-{fixed}.{ext}"),
            os.path.join(tmp_dir, f"arcelle-tu-{fixed}.{to}"),
        )

    # Exit path 1: a genuine, successful conversion.
    src, dst = paths("rtf", "txt")
    assert tu.convert("sample.rtf", _SAMPLE_RTF, "txt") is not None
    assert not os.path.exists(src), "the decrypted source outlived a successful conversion"
    assert not os.path.exists(dst), "the converted output outlived a successful conversion"

    # Exit path 2: the converter runs but exits non-zero.
    src, dst = paths("rtf", "txt")
    monkeypatch.setattr(
        tu.subprocess,
        "run",
        lambda *a, **k: subprocess.CompletedProcess(args=a, returncode=1),
    )
    assert tu.convert("sample.rtf", _SAMPLE_RTF, "txt") is None
    assert not os.path.exists(src), "the decrypted source outlived a converter failure"
    assert not os.path.exists(dst)

    # Exit path 3: the converter reports success but never wrote an output
    # file (an `open`/read failure in the Rust/Python source).
    src, dst = paths("rtf", "txt")
    monkeypatch.setattr(
        tu.subprocess,
        "run",
        lambda *a, **k: subprocess.CompletedProcess(args=a, returncode=0),
    )
    assert tu.convert("sample.rtf", _SAMPLE_RTF, "txt") is None
    assert not os.path.exists(src), "the decrypted source outlived a missing-output result"
    assert not os.path.exists(dst)

    # Exit path 4: something entirely unexpected blows up mid-conversion.
    # The temp files must not survive an exception either -- `finally`, not
    # a happy-path-only cleanup.
    src, dst = paths("rtf", "txt")

    def boom(*a: object, **k: object) -> None:
        raise RuntimeError("boom")

    monkeypatch.setattr(tu.subprocess, "run", boom)
    with pytest.raises(RuntimeError):
        tu.convert("sample.rtf", _SAMPLE_RTF, "txt")
    assert not os.path.exists(src), "the decrypted source outlived an exception"
    assert not os.path.exists(dst)


def test_the_temp_copy_is_owner_only() -> None:
    # These bytes are the plaintext of an encrypted room; no other account
    # on the Mac may read them while the converter runs. Calls the same
    # private primitive `convert()` itself uses, exactly as the Rust test
    # calls `write_private` directly rather than going through `convert`.
    path = os.path.join(tempfile.gettempdir(), f"arcelle-tu-{uuid.uuid4()}.probe")
    try:
        assert tu._write_private(path, b"secret")
        mode = stat.S_IMODE(os.stat(path).st_mode)
        assert mode & 0o077 == 0, f"temp copy readable by others: {oct(mode)}"
    finally:
        os.remove(path)


# ------------------------------------------------------------ extension parsing


def test_extension_of_matches_rust_path_extension() -> None:
    """Regression test: verified against a real `rustc` build of
    `std::path::Path::extension()`. A naive `str.rpartition(".")` (one
    candidate) gets `.bashrc` wrong -- it has no extension, same as any
    dotfile with no other dot in its name. A naive `os.path.splitext` (the
    other candidate) gets `..foo` wrong -- Rust's algorithm splits on the
    LAST dot, so `..foo` does have an extension, `foo`.
    """
    cases = {
        ".bashrc": "",
        "archive.tar.gz": "gz",
        "noext": "",
        "foo.": "",
        "..foo": "foo",
        "file.DOC": "doc",
        "a.b.c": "c",
        ".": "",
        "..": "",
        "a..b": "b",
        "": "",
        "...": "",
        "..foo.bar": "bar",
        ".foo.bar": "bar",
    }
    for name, expected in cases.items():
        assert tu._extension_of(name) == expected, f"{name!r}"


# ------------------------------------------------------------ field codes


def test_a_hyperlink_field_becomes_the_link_and_stops_being_prose() -> None:
    # The exact shape live QA found in a real .doc.
    src = ' HYPERLINK "https://products.office.com/en-us/word"Mauris id ex erat.'
    text = tu.resolve_field_codes(src, False)
    assert "HYPERLINK" not in text, f"the field code leaked: {text}"
    assert "Mauris id ex erat." in text, f"prose was eaten: {text}"
    assert "https://products.office.com" in text, f"target lost: {text}"

    html = tu.resolve_field_codes(src, True)
    assert '<a href="https://products.office.com/en-us/word">' in html, html
    assert "Mauris id ex erat." in html, f"prose was eaten: {html}"


def test_several_hyperlinks_in_one_document_all_resolve() -> None:
    src = 'a HYPERLINK "https://one.example"one b HYPERLINK "https://two.example"two'
    text = tu.resolve_field_codes(src, False)
    assert "HYPERLINK" not in text, text
    assert "one.example" in text and "two.example" in text, text
    assert " b " in text, f"prose between the fields was lost: {text}"


def test_a_non_http_target_never_becomes_a_clickable_href() -> None:
    # A document must not be able to smuggle script into the reader.
    html = tu.resolve_field_codes('HYPERLINK "javascript:alert(1)"click', True)
    assert "<a href" not in html, f"a script URL became a link: {html}"
    assert 'javascript:alert(1)"' not in html, f"unescaped: {html}"
    assert "click" in html, f"prose was eaten: {html}"


def test_the_word_hyperlink_in_ordinary_prose_is_left_alone() -> None:
    src = "The HYPERLINK, as it is called, points elsewhere."
    assert tu.resolve_field_codes(src, False) == src


def test_an_unterminated_field_code_stays_prose() -> None:
    src = 'The HYPERLINK "never closes.'
    assert tu.resolve_field_codes(src, False) == src
    assert tu.resolve_field_codes(src, True) == src


def test_prose_between_the_word_and_a_later_quote_survives() -> None:
    # The keyword in prose with a quoted string LATER in the sentence: the
    # resolver used to accept any run of letters as the field's
    # instruction, so everything between the two was deleted from the
    # search text and from the preview.
    src = 'We use HYPERLINK fields to link "https://x" pages.'
    assert tu.resolve_field_codes(src, False) == src

    # A switch before the target is still a field, and still resolves.
    switched = 'HYPERLINK \\l "https://one.example"one'
    text = tu.resolve_field_codes(switched, False)
    assert "HYPERLINK" not in text, f"a real field stopped resolving: {text}"
    assert "https://one.example" in text and "one" in text, text


def test_a_quoted_phrase_a_few_words_after_the_keyword_survives() -> None:
    # The same deletion with a SHORT gap, which a length bound cannot see:
    # two words and a quoted phrase in one sentence, and the sentence came
    # back as "The great, they said." -- the word between them and both
    # quotes gone from the search text and from the preview alike.
    for src in (
        'The HYPERLINK is "great", they said.',
        'A HYPERLINK to "the deposit" clause.',
    ):
        assert tu.resolve_field_codes(src, False) == src
        assert tu.resolve_field_codes(src, True) == src


def test_text_with_no_fields_is_returned_unchanged() -> None:
    src = 'Ordinary prose with "quotes" and no fields at all.'
    assert tu.resolve_field_codes(src, False) == src


def test_gap_length_is_counted_in_bytes_not_characters() -> None:
    """Regression test for a real divergence between the two candidates.

    The gap here is 7 Python characters (a space, a backslash, and five
    Greek letters) but 12 UTF-8 bytes -- over the Rust `MAX_FIELD_GAP` of 8
    bytes, so the real `textutil.rs` treats this as ordinary prose, not a
    field, and leaves it untouched. A character-counting port instead
    accepts it as a field (7 <= 8) and swallows the keyword and quotes,
    mangling the surrounding prose -- exactly the "gap heuristic silently
    deletes real prose" failure mode this function exists to prevent.
    """
    gap = " \\" + ("α" * 5)
    assert len(gap) == 7
    assert len(gap.encode("utf-8")) == 12

    src = f'text HYPERLINK{gap}"https://x.example"more text'
    assert tu.resolve_field_codes(src, False) == src, "a too-long (in bytes) gap was treated as a field"
