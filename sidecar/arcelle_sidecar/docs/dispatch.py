"""Port of `src-tauri/src/extraction.rs`, lines 29-58 (`TEXT_EXTENSIONS`,
`text_extensions`, `extension_of`, `is_image`, `is_text_extension`), lines
284-371 (`extract_text` itself -- the full extension-to-extractor match),
lines 383-396 (`sniff_text_bytes`), and lines 398-403
(`contain_parser_panic`).

This is a WIRING module, not an extraction module: every reader
`extract_text` dispatches to already exists (and is fully tested)
elsewhere in `arcelle_sidecar.docs` -- this file imports every one of them
rather than redefining any extraction logic. The risk here is getting the
extension table and the per-format decode strategy exactly right, matching
the Rust source's own ordering, its asymmetric encoding choices (full
BOM/UTF-8/detection cascade for html/htm and the extension-less sniff path,
a plain lossy UTF-8 decode for rtf/eml/srt/vtt/svg), and its panic
containment.
"""

from __future__ import annotations

from typing import Callable

from arcelle_sidecar.docs.archive import extract_zip_listing
from arcelle_sidecar.docs.article import read_page
from arcelle_sidecar.docs.docx import extract_docx
from arcelle_sidecar.docs.epub import extract_epub
from arcelle_sidecar.docs.html import strip_html
from arcelle_sidecar.docs.iwork import extract_iwork
from arcelle_sidecar.docs.legacy import (
    extract_legacy_doc,
    extract_legacy_ppt,
    extract_legacy_spreadsheet,
)
from arcelle_sidecar.docs.mail import extract_eml
from arcelle_sidecar.docs.notebook import extract_ipynb
from arcelle_sidecar.docs.pdf import extract_pdf
from arcelle_sidecar.docs.pptx import extract_pptx
from arcelle_sidecar.docs.rtf import extract_rtf
from arcelle_sidecar.docs.subtitles import extract_subtitles
from arcelle_sidecar.docs.svg import extract_svg
from arcelle_sidecar.docs.text_decode import EncodingSource, decode_text_bytes, decode_text_detail
from arcelle_sidecar.docs.xlsx import extract_xlsx
from arcelle_sidecar.docs.xml_utils import normalize_whitespace

# ------------------------------------------------------------ extension table

# The exact list from `extraction.rs` lines 29-35, same order (59 entries,
# verified against the Rust source directly -- the porting brief's own
# count of "45" does not match the actual array there, but every entry
# below is copied verbatim from it). This IS the format registry's "what
# can this app open as plain text" table -- every other reader below
# handles a specific binary/markup container, this list is everything that
# is already text on disk and just needs decoding.
TEXT_EXTENSIONS: tuple[str, ...] = (
    "txt", "md", "markdown", "json", "jsonl", "ndjson", "csv", "tsv", "log", "xml", "yml",
    "yaml", "toml", "ini", "rs", "py", "js", "jsx", "ts", "tsx", "java", "c", "h", "cpp", "hpp",
    "cs", "go", "rb", "php", "swift", "kt", "sh", "zsh", "bash", "sql", "r", "m", "scala",
    "lua", "pl", "css", "scss", "less", "vue", "svelte", "tex", "org", "rst", "diff", "patch",
    "dockerfile", "graphql", "gql", "proto", "properties", "env", "gitignore", "cfg", "conf",
)


def text_extensions() -> tuple[str, ...]:
    """The text extensions, for the format registry's "what can this app
    open?" listing. Kept behind a function -- matching the Rust source's own
    stated reasoning -- so the table itself stays private to this module and
    there is still exactly one copy of it.
    """
    return TEXT_EXTENSIONS


def extension_of(name: str) -> str:
    """The canonical lowercase-extension extractor for this docs/ package,
    matching `std::path::Path::extension()` semantics exactly (verified
    against real `rustc` output, not guessed):

    - A dotfile with exactly one leading dot and no other dot has NO
      extension (`.bashrc` -> `""`) -- Rust's own rule is that the sole dot
      in a name that starts with it never counts.
    - Two or more leading dots DO count once there's another dot to take the
      last segment after (`..foo` -> `"foo"`).
    - The extension is whatever follows the LAST dot in the file's BASE name
      (a directory prefix is stripped first): `"a.b.c"` -> `"c"`.
    - No dot at all, or a dot with nothing after it, both yield `""`
      (`"noext"` -> `""`, `"trailing."` -> `""`).

    Concretely: take the last `.` in the base name. If it doesn't exist, or
    it sits at index 0 (the base name starts with its only dot), there is no
    extension. Otherwise the extension is everything after that dot,
    lowercased.

    NOTE: `arcelle_sidecar.docs.textutil` has its own small PRIVATE
    duplicate of this logic for historical reasons from an earlier port
    batch -- do not touch that one or import from it. This is the real,
    public, canonical extension extractor for the whole `docs/` package.
    """
    base = name.rsplit("/", 1)[-1]
    dot = base.rfind(".")
    if dot <= 0:
        return ""
    return base[dot + 1 :].lower()


def is_image(mime: str) -> bool:
    return mime.startswith("image/")


def is_text_extension(ext: str) -> bool:
    return ext in TEXT_EXTENSIONS


# ------------------------------------------------------------------- sniffing


def _sniff_text_bytes(data: bytes) -> str | None:
    """Text from bytes alone, or None -- the last resort for a name that
    says nothing about its contents (no extension at all).

    Only a FACT about the bytes is accepted: a byte-order mark (including
    the UTF-16 pair, whose bytes are full of NULs by construction), or
    bytes that are valid UTF-8 AND contain no literal NUL byte at all (a NUL
    inside otherwise-valid-UTF-8-shaped bytes is a strong signal of a binary
    file that merely happens to decode without error). Any OTHER source --
    a `DETECTED` guess -- is rejected outright: guessing on a nameless file
    is far riskier than guessing on a file whose extension already told you
    what kind of text to expect. A lossy decode, or text that is blank after
    stripping, is also rejected.
    """
    decoded = decode_text_detail(data)
    if decoded.source == EncodingSource.BOM:
        pass
    elif decoded.source == EncodingSource.UTF8 and 0 not in data:
        pass
    else:
        return None
    if decoded.lossy or not decoded.text.strip():
        return None
    return decoded.text


def _contain_parser_panic(read: Callable[[], str | None]) -> str | None:
    """Run one document reader, turning an unexpected exception inside it
    into "no text".

    Python has no `panic`/`catch_unwind` equivalent, but a third-party
    parser fed genuinely untrusted bytes can still raise in unexpected ways
    -- this mirrors the Rust source's own stated intent ("a bad file must
    only cost its own text") by containing any `Exception` here rather than
    letting it propagate and cost the whole import. `BaseException` (and
    therefore `KeyboardInterrupt`/`SystemExit`) is deliberately NOT caught.
    """
    try:
        return read()
    except Exception:
        return None


# --------------------------------------------------------------- the dispatch


def extract_text(name: str, data: bytes) -> str | None:
    """Extract readable text from a file's bytes, best-effort. Returns None
    for formats we can't read (images, unknown binaries).
    """
    ext = extension_of(name)

    # A file whose extension is already in the plain-text registry is
    # decoded directly -- no panic containment needed, `decode_text_bytes`
    # cannot meaningfully "fail" the way a third-party document parser can,
    # matching the Rust source's own early return before the
    # panic-containment closure even begins.
    if ext in TEXT_EXTENSIONS:
        return decode_text_bytes(data)

    # A file with NO extension at all is decided on its bytes alone, also
    # before panic containment begins -- there is no third-party parser
    # involved, just the same encoding-detection machinery every other text
    # file goes through, gated much more conservatively (see
    # `_sniff_text_bytes`).
    if ext == "":
        sniffed = _sniff_text_bytes(data)
        if sniffed is not None:
            return sniffed

    def _read() -> str | None:
        if ext == "pdf":
            return extract_pdf(data)
        if ext == "docx":
            return extract_docx(data)
        if ext == "xlsx":
            return extract_xlsx(data)
        if ext == "pptx":
            return extract_pptx(data)
        if ext in ("html", "htm"):
            # Same decoder as plain text: a legacy-encoded HTML page is
            # exactly as common as a legacy-encoded .txt, and `strip_html`
            # cannot recover a character that was already replaced before
            # it ran. The article reading (Readability-style scoring) goes
            # first, `strip_html` is the fallback for a page with nothing
            # scorable.
            text = decode_text_bytes(data)
            article = read_page(text, None).article
            return article.text if article is not None else strip_html(text)
        if ext == "epub":
            return extract_epub(data)
        if ext == "rtf":
            # Deliberately a SIMPLE lossy UTF-8 decode (matching Rust's
            # `String::from_utf8_lossy` exactly), NOT the full
            # `decode_text_bytes` cascade -- an intentional asymmetry with
            # the html/htm branch above, not an inconsistency to "fix".
            return extract_rtf(data.decode("utf-8", errors="replace"))
        if ext == "doc":
            return extract_legacy_doc(name, data)
        if ext == "ppt":
            return extract_legacy_ppt(data)
        if ext in ("xls", "ods"):
            return extract_legacy_spreadsheet(data, ext)
        if ext in ("pages", "key", "numbers"):
            return extract_iwork(data)
        if ext == "ipynb":
            return extract_ipynb(data)
        if ext == "eml":
            # Same lossy-UTF-8-only note as rtf above.
            return extract_eml(data.decode("utf-8", errors="replace"))
        if ext in ("srt", "vtt"):
            # Same lossy-UTF-8-only note as rtf above.
            return extract_subtitles(data.decode("utf-8", errors="replace"))
        if ext == "svg":
            # Same lossy-UTF-8-only note as rtf above.
            return extract_svg(data.decode("utf-8", errors="replace"))
        if ext == "sketch":
            # DELIBERATE, DOCUMENTED GAP -- not an oversight. The Rust
            # source dispatches this to
            # `commands::sketchdoc::Sketch::from_json(...).extracted_text()`,
            # a whole separate in-house drawing-format feature module that
            # has not been ported to this Python sidecar yet. Revisit once
            # that module exists; until then a `.sketch` import reads as no
            # text, honestly, rather than guessing at one.
            return None
        if ext == "zip":
            return extract_zip_listing(data)
        return None

    result = _contain_parser_panic(_read)
    if result is None:
        return None
    normalized = normalize_whitespace(result)
    if not normalized.strip():
        return None
    return normalized


__all__ = [
    "TEXT_EXTENSIONS",
    "text_extensions",
    "extension_of",
    "is_image",
    "is_text_extension",
    "extract_text",
]
