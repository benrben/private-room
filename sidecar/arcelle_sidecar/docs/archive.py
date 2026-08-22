"""Zip archive text extraction: a table of contents, one entry per line with
its uncompressed size.

Port of the archive section of `src-tauri/src/extraction/data.rs`
(`extract_zip_listing`, lines 390-408).

An archive had no preview and no text whatsoever, so a room full of
downloaded bundles was a room full of opaque rows. The listing alone makes
them searchable by the names of the files inside.

Deliberately NOT ported here: `push_capped`'s `MAX_DERIVED_CHARS` (8 MiB) cap
that the Rust source applies via a shared module-level helper. The task this
module was ported from scoped `extract_zip_listing` on its own terms (walk
entries in archive order, skip directories, join surviving lines, return
`None` if blank) with no mention of the cap, and a zip listing large enough
to hit an 8 MiB derived-text ceiling would need an archive with an enormous
number of entries -- not a case this port needs to defend against on its
own. See the sibling `arcelle_sidecar.docs.subtitles` module for the same
call made the same way, and `arcelle_sidecar.docs.mail` / `.notebook` for a
from-scratch reimplementation of that cap where it *was* in scope.
"""

from __future__ import annotations

import io
import zipfile


def extract_zip_listing(data: bytes) -> str | None:
    """A zip's table of contents: `"{name}\\t{uncompressed_size}\\n"` per
    file entry, in archive order, directory entries skipped. `None` if
    `data` isn't a readable zip at all, or if every entry was a directory
    (or the archive was empty) leaving nothing to report.
    """
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
    except (zipfile.BadZipFile, OSError, NotImplementedError):
        # `NotImplementedError` covers a central directory record that
        # declares a "version needed to extract" beyond what `zipfile`
        # implements (raised while just parsing the table of contents,
        # before any entry is opened) -- another way a byte string can
        # fail to be "a readable zip at all", matching Rust's `.ok()?`
        # on `zip::ZipArchive::new`, which folds every `ZipError` variant
        # into `None` the same way.
        return None

    out: list[str] = []
    for info in infos:
        if info.is_dir():
            continue
        out.append(f"{info.filename}\t{info.file_size}\n")

    result = "".join(out)
    return result if result.strip() else None
