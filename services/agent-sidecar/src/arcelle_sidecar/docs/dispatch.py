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


def _sniff_source_is_safe(source: EncodingSource, data: bytes) -> bool:
    if source == EncodingSource.BOM:
        return True
    return source == EncodingSource.UTF8 and 0 not in data


def _sniffed_text_is_usable(text: str, lossy: bool) -> bool:
    return not lossy and bool(text.strip())


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
    if not _sniff_source_is_safe(decoded.source, data):
        return None
    if not _sniffed_text_is_usable(decoded.text, decoded.lossy):
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


FormatReader = Callable[[str, bytes], str | None]


def _read_pdf(_: str, data: bytes) -> str | None:
    return extract_pdf(data)


def _read_docx(_: str, data: bytes) -> str | None:
    return extract_docx(data)


def _read_xlsx(_: str, data: bytes) -> str | None:
    return extract_xlsx(data)


def _read_pptx(_: str, data: bytes) -> str | None:
    return extract_pptx(data)


def _read_html(_: str, data: bytes) -> str | None:
    """Read legacy-encoded HTML before choosing the article or plain-text view."""
    text = decode_text_bytes(data)
    article = read_page(text, None).article
    return article.text if article is not None else strip_html(text)


def _read_epub(_: str, data: bytes) -> str | None:
    return extract_epub(data)


def _read_rtf(_: str, data: bytes) -> str | None:
    return extract_rtf(data.decode("utf-8", errors="replace"))


def _read_doc(name: str, data: bytes) -> str | None:
    return extract_legacy_doc(name, data)


def _read_ppt(_: str, data: bytes) -> str | None:
    return extract_legacy_ppt(data)


def _read_xls(_: str, data: bytes) -> str | None:
    return extract_legacy_spreadsheet(data, "xls")


def _read_ods(_: str, data: bytes) -> str | None:
    return extract_legacy_spreadsheet(data, "ods")


def _read_iwork(_: str, data: bytes) -> str | None:
    return extract_iwork(data)


def _read_notebook(_: str, data: bytes) -> str | None:
    return extract_ipynb(data)


def _read_eml(_: str, data: bytes) -> str | None:
    return extract_eml(data.decode("utf-8", errors="replace"))


def _read_subtitles(_: str, data: bytes) -> str | None:
    return extract_subtitles(data.decode("utf-8", errors="replace"))


def _read_svg(_: str, data: bytes) -> str | None:
    return extract_svg(data.decode("utf-8", errors="replace"))


def _read_sketch(_: str, __: bytes) -> str | None:
    return None


def _read_zip(_: str, data: bytes) -> str | None:
    return extract_zip_listing(data)


FORMAT_READERS: dict[str, FormatReader] = {
    "pdf": _read_pdf,
    "docx": _read_docx,
    "xlsx": _read_xlsx,
    "pptx": _read_pptx,
    "html": _read_html,
    "htm": _read_html,
    "epub": _read_epub,
    "rtf": _read_rtf,
    "doc": _read_doc,
    "ppt": _read_ppt,
    "xls": _read_xls,
    "ods": _read_ods,
    "pages": _read_iwork,
    "key": _read_iwork,
    "numbers": _read_iwork,
    "ipynb": _read_notebook,
    "eml": _read_eml,
    "srt": _read_subtitles,
    "vtt": _read_subtitles,
    "svg": _read_svg,
    "sketch": _read_sketch,
    "zip": _read_zip,
}


def _plain_text_for_extension(ext: str, data: bytes) -> str | None:
    if ext not in TEXT_EXTENSIONS:
        return None
    return decode_text_bytes(data)


def _sniffed_text_for_extension(ext: str, data: bytes) -> str | None:
    if ext != "":
        return None
    return _sniff_text_bytes(data)


def _normalized_format_text(ext: str, name: str, data: bytes) -> str | None:
    reader = FORMAT_READERS.get(ext)
    if reader is None:
        return None
    result = _contain_parser_panic(lambda: reader(name, data))
    if result is None:
        return None
    normalized = normalize_whitespace(result)
    if not normalized.strip():
        return None
    return normalized


def extract_text(name: str, data: bytes) -> str | None:
    """Extract readable text from a file's bytes, best-effort. Returns None
    for formats we can't read (images, unknown binaries).
    """
    ext = extension_of(name)

    direct = _plain_text_for_extension(ext, data)
    if direct is not None:
        return direct

    sniffed = _sniffed_text_for_extension(ext, data)
    if sniffed is not None:
        return sniffed

    return _normalized_format_text(ext, name, data)


__all__ = [
    "TEXT_EXTENSIONS",
    "text_extensions",
    "extension_of",
    "is_image",
    "is_text_extension",
    "extract_text",
]
