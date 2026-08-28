"""Tests for `arcelle_sidecar.docs.epub` (port of
`src-tauri/src/extraction.rs` lines 439-534: `extract_epub`,
`epub_spine_order`).

The Rust source's own `#[cfg(test)]` module has exactly one EPUB case
(`reads_an_epub_in_reading_order`), and its fixture's spine order happens
to already match alphabetical order (`one.xhtml` < `two.xhtml`, and the
spine lists `c1`/one before `c2`/two) -- so it never actually proves the
spine can override the fallback ordering. These tests are written fresh
per the porting brief to cover that gap plus the other documented
behaviors: no-OPF fallback (with case-insensitive META-INF exclusion), a
spine that reverses two chapters' alphabetical order, an entry missing
from the spine, and the two "return None" paths (unreadable input,
all-blank content).
"""

from __future__ import annotations

import io
import zipfile

from arcelle_sidecar.docs import epub


def build_zip(entries: dict[str, str]) -> bytes:
    """Build an in-memory zip with one entry per (name, text) pair, in
    insertion order -- the Python-side equivalent of the Rust tests' inline
    `zip::ZipWriter` blocks. A `mimetype` entry isn't needed for these
    tests since `extract_epub` never checks it.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as writer:
        for name, body in entries.items():
            writer.writestr(name, body.encode("utf-8"))
    return buf.getvalue()


def test_no_opf_falls_back_to_alphabetical_order_excluding_meta_inf() -> None:
    data = build_zip(
        {
            # Alphabetically "aaa" < "bbb", so a no-OPF book must read
            # Alpha before Bravo.
            "OEBPS/bbb.xhtml": "<html><body><p>Bravo chapter body.</p></body></html>",
            "OEBPS/aaa.xhtml": "<html><body><p>Alpha chapter body.</p></body></html>",
            # Same extension, but under META-INF/ (mixed case, to prove the
            # exclusion is case-insensitive) -- must never appear at all.
            "META-INF/container.xhtml": "<html><body><p>Should never appear.</p></body></html>",
        }
    )
    text = epub.extract_epub(data)
    assert text is not None, "epub text"
    assert "Should never appear" not in text, f"META-INF leaked: {text}"
    alpha = text.find("Alpha chapter body")
    bravo = text.find("Bravo chapter body")
    assert alpha != -1 and bravo != -1, f"chapter missing: {text}"
    assert alpha < bravo, f"alphabetical order not honored: {text}"


def test_real_opf_spine_overrides_alphabetical_order() -> None:
    # The spine lists bbb before aaa -- the reverse of alphabetical order --
    # so a correct reader must follow the spine, not the filenames.
    opf = """<package><manifest>
        <item id="c2" href="bbb.xhtml" media-type="application/xhtml+xml"/>
        <item id="c1" href="aaa.xhtml" media-type="application/xhtml+xml"/>
    </manifest><spine>
        <itemref idref="c2"/><itemref idref="c1"/>
    </spine></package>"""
    data = build_zip(
        {
            "OEBPS/content.opf": opf,
            "OEBPS/aaa.xhtml": "<html><body><p>Alpha chapter body.</p></body></html>",
            "OEBPS/bbb.xhtml": "<html><body><p>Bravo chapter body.</p></body></html>",
        }
    )
    text = epub.extract_epub(data)
    assert text is not None, "epub text"
    alpha = text.find("Alpha chapter body")
    bravo = text.find("Bravo chapter body")
    assert alpha != -1 and bravo != -1, f"chapter missing: {text}"
    assert bravo < alpha, f"spine order ignored: {text}"


def test_entry_absent_from_spine_appears_after_every_spine_entry() -> None:
    # Spine only knows about aaa/bbb (and lists them reversed); ccc and ddd
    # are ordinary doc-list entries the OPF never mentions. Both must
    # follow every entry that IS in the spine, keeping their own
    # alphabetical order relative to each other (ccc before ddd).
    opf = """<package><manifest>
        <item id="c1" href="aaa.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="bbb.xhtml" media-type="application/xhtml+xml"/>
    </manifest><spine>
        <itemref idref="c2"/><itemref idref="c1"/>
    </spine></package>"""
    data = build_zip(
        {
            "OEBPS/content.opf": opf,
            "OEBPS/aaa.xhtml": "<html><body><p>Alpha chapter body.</p></body></html>",
            "OEBPS/bbb.xhtml": "<html><body><p>Bravo chapter body.</p></body></html>",
            "OEBPS/ccc.xhtml": "<html><body><p>Charlie chapter body.</p></body></html>",
            "OEBPS/ddd.xhtml": "<html><body><p>Delta chapter body.</p></body></html>",
        }
    )
    text = epub.extract_epub(data)
    assert text is not None, "epub text"
    positions = {
        label: text.find(f"{label} chapter body")
        for label in ("Bravo", "Alpha", "Charlie", "Delta")
    }
    assert all(pos != -1 for pos in positions.values()), f"chapter missing: {text}"
    assert positions["Bravo"] < positions["Alpha"], f"spine order ignored: {text}"
    assert positions["Alpha"] < positions["Charlie"], (
        f"non-spine entry not pushed to the end: {text}"
    )
    assert positions["Charlie"] < positions["Delta"], (
        f"non-spine entries lost their alphabetical order: {text}"
    )


def test_non_spine_entries_tie_broken_by_alphabetical_order_not_zip_order() -> None:
    # The spine names only "mmm" (idref "m"). "zzz" and "aaa" are both
    # absent from the spine and must fall back to ALPHABETICAL order
    # relative to each other -- but the zip inserts zzz BEFORE aaa, the
    # REVERSE of alphabetical order. This is the adversarial case the other
    # "absent from spine" test doesn't cover: there, the non-spine entries'
    # zip-insertion order happened to already match their alphabetical
    # order, so it couldn't tell a (buggy) fallback to raw archive order
    # apart from a (correct) fallback to the alphabetically-presorted list.
    # A reader that stable-sorts the RAW `zip_entry_names` order by spine
    # position -- instead of stable-sorting the already-alphabetized doc
    # list, as the Rust source's `docs.sort(); docs.sort_by_key(...)` does
    # -- would put Zulu before Alpha here.
    opf = """<package><manifest>
        <item id="m" href="mmm.xhtml" media-type="application/xhtml+xml"/>
    </manifest><spine>
        <itemref idref="m"/>
    </spine></package>"""
    data = build_zip(
        {
            "OEBPS/content.opf": opf,
            "OEBPS/zzz.xhtml": "<html><body><p>Zulu chapter body.</p></body></html>",
            "OEBPS/mmm.xhtml": "<html><body><p>Mike chapter body.</p></body></html>",
            "OEBPS/aaa.xhtml": "<html><body><p>Alpha chapter body.</p></body></html>",
        }
    )
    text = epub.extract_epub(data)
    assert text is not None, "epub text"
    positions = {
        label: text.find(f"{label} chapter body") for label in ("Mike", "Alpha", "Zulu")
    }
    assert all(pos != -1 for pos in positions.values()), f"chapter missing: {text}"
    assert positions["Mike"] < positions["Alpha"], f"spine entry not first: {text}"
    assert positions["Alpha"] < positions["Zulu"], (
        f"non-spine entries fell back to zip insertion order instead of "
        f"alphabetical order: {text}"
    )


def test_unreadable_input_returns_none() -> None:
    assert epub.extract_epub(b"not a zip archive at all") is None


def test_all_blank_content_returns_none() -> None:
    data = build_zip(
        {
            "OEBPS/blank1.xhtml": "<html><body>   </body></html>",
            "OEBPS/blank2.xhtml": "<html><body><p></p><p>\n\t</p></body></html>",
        }
    )
    assert epub.extract_epub(data) is None
