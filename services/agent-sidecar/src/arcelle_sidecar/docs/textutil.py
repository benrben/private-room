"""macOS's own Word/RTF importer -- the one behind TextEdit -- at
`/usr/bin/textutil`.

Port of `src-tauri/src/textutil.rs` (all 297 lines): `can_read`, `convert`,
`resolve_field_codes`, `looks_like_url`, `escape_attr`, `escape_text`.

Judged and merged from two independent candidate ports
(`textutil_candidate_a.py` / `textutil_candidate_b.py`) -- see the sidecar
task report for the comparison. This file keeps candidate A's byte-exact
field-gap length check and candidate B's more exhaustive cleanup tests, and
fixes an extension-parsing bug present in both candidates.

WHY THIS EXISTS AS A SHARED MODULE: the legacy `.doc` path needs the same
converter twice, for two different outputs. The PREVIEW wants HTML (fonts,
weights, colours, lists); the EXTRACTED TEXT -- what search, RAG and the
editor all read -- wants plain text. textutil ships with every Mac at a
fixed path, works offline, and is nothing to bundle, sign or notarize.

------------------------------------------------------------------ convert

Same bargain as the Quick Look bridge and the audio decoder: a system
converter takes a path, so the decrypted bytes touch the disk for the
moment it runs -- owner-only, created exclusively -- and are removed
straight after, on every exit path (success, subprocess failure, missing
output file, any exception). This is a self-contained bridge: the source
extension is derived locally rather than importing the sibling
extraction/office modules' `extension_of`.

`_write_private` uses `os.open` with `O_CREAT | O_EXCL | O_WRONLY` and mode
`0o600` -- the Python analogue of the Rust `OpenOptions::create_new(true)`
plus `mode(0o600)` -- so two concurrent conversions can never collide on
the same random name or clobber one another's plaintext, and the file is
never briefly world/group readable between creation and the permission
being applied (unlike a `chmod` after the fact). Cleanup is a `try/finally`
around the whole conversion, standing in for the Rust `TempPath` `Drop`
guard: both temp files are removed whether `convert` returns normally,
returns early, or an exception propagates through.

------------------------------------------------------------- extensions

`_extension_of` mirrors `std::path::Path::extension()` exactly (verified
against a real `rustc` build, not just read off the docs): the final path
component, split at its LAST `.`, EXCEPT that a name which starts with `.`
and has no OTHER `.` has no extension at all (`.bashrc` -> `""`, matching
a real dotfile having no "extension"; but `..foo` -> `"foo"`, since the
second dot is not the leading character). A naive `rpartition(".")` gets
`.bashrc` wrong (returns `"bashrc"`); a naive `os.path.splitext` gets
`..foo` wrong (returns `""`) -- both were bugs found in the two candidate
ports during review. Neither is likely to matter for a real document's
display name, but the whole point of a port is to match the source
exactly rather than to be right by chance on the cases that came up.

--------------------------------------------------------------- field codes

`resolve_field_codes` ports the exact "gap" heuristic from the Rust source:
a `HYPERLINK` field only reads as a REAL field -- not a word in prose --
when everything between the keyword and its first quote is at most
`MAX_FIELD_GAP` BYTES (not characters -- see below) AND every
whitespace-separated token in that gap starts with a backslash (a Word
field switch like `\\l` or `\\o`). Neither condition alone is enough: a
short gap can still be ordinary prose ("The HYPERLINK is \"great\""), and
a long run of switches is still a real field. When it's not a real field,
"HYPERLINK" and everything before it are copied out verbatim, and the scan
resumes from just past the bare keyword -- NOT past the quote, so a later
real field in the same text still gets found, and a quote that belongs to
a later sentence is never swallowed.

The gap-length check MUST count UTF-8 bytes, matching the Rust `gap.len()`
(a byte length), not Python characters: one of the two candidates used
`len(gap)` (characters) instead and documented it as "a faithful-but-inexact
spot ... the two disagree only if the gap contains a multi-byte character,
which real .doc field instructions never do." That reasoning does not hold
in general -- a gap of 5 non-ASCII characters is under the 8-character
bound but 10+ UTF-8 bytes, over the byte bound Rust actually enforces, and
would be misclassified as a real field where Rust would leave it as prose.
This port counts `len(gap.encode("utf-8"))`, so it agrees with the Rust
source byte-for-byte rather than merely on the inputs someone happened to
try -- exactly the "silently deletes real prose" failure mode this
function exists to prevent.

`_looks_like_url` is a conservative allow-list (https/http/mailto only):
only those schemes may become a clickable `href` in the HTML rendering,
so a document can never smuggle a `javascript:` URL into the reader.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import uuid

# The formats `textutil` can import. `.docx` is deliberately absent from
# the PREVIEW path (docx-preview renders more) but it can still be
# converted, so this list is about what the importer understands, not
# about who uses it.
_READABLE_EXTENSIONS = frozenset({"doc", "rtf", "rtfd", "odt", "wordml", "webarchive"})

# How much may sit between the `HYPERLINK` keyword and its target quote --
# room for a space and a switch, and nothing like a clause of prose. Counted
# in UTF-8 BYTES to match the Rust `gap.len()` exactly -- see module
# docstring.
_MAX_FIELD_GAP = 8


def can_read(ext: str) -> bool:
    return ext in _READABLE_EXTENSIONS


def _extension_of(name: str) -> str:
    """Self-contained, lowercased extension of a filename -- deliberately
    not imported from the sibling extraction/office modules (see module
    docstring). Mirrors `std::path::Path::extension()` exactly: the part of
    the final path component after its LAST `.`, lowercased -- except that
    a name which starts with `.` and has no OTHER `.` (a dotfile like
    `.bashrc`) has no extension at all.
    """
    file_name = name.rsplit("/", 1)[-1]
    if "." not in file_name:
        return ""
    before, _, after = file_name.rpartition(".")
    return after.lower() if before else ""


def _write_private(path: str, data: bytes) -> bool:
    """Create `path` exclusively and owner-only (0o600), then write `data`.

    False on any failure -- mirrors the Rust `write_private(...).ok()`
    pattern in `convert` below. `O_CREAT | O_EXCL` means two concurrent
    calls can never collide or clobber an existing file, and the mode is
    part of the same `open` syscall, so the file is never briefly
    world-readable between creation and permission-tightening.
    """
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except OSError:
        return False
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
    except OSError:
        return False
    return True


def _remove(path: str) -> None:
    """Best-effort delete -- mirrors the Rust `TempPath::drop`'s
    `let _ = std::fs::remove_file(&self.0);`. Removing a file that was
    never created (or already removed) is a no-op, not an error worth
    surfacing.
    """
    try:
        os.remove(path)
    except OSError:
        pass


def convert(name: str, data: bytes, to: str) -> str | None:
    """Convert `data` (the bytes of `name`) to `to` ("txt" or "html") via
    `/usr/bin/textutil`. `None` when the format isn't importable, the
    converter fails, or the result is empty/all-whitespace.

    The decrypted bytes touch disk only for the moment the converter runs;
    both the source and destination temp files are removed on every exit
    path -- success, a write failure, a subprocess that fails to start or
    exits non-zero, a missing/unreadable output file, or any exception --
    via `try/finally`, never a happy-path-only cleanup.
    """
    ext = _extension_of(name)
    if not can_read(ext):
        return None

    stem = uuid.uuid4()
    tmp_dir = tempfile.gettempdir()
    src = os.path.join(tmp_dir, f"arcelle-tu-{stem}.{ext}")
    dst = os.path.join(tmp_dir, f"arcelle-tu-{stem}.{to}")

    try:
        if not _write_private(src, data):
            return None
        try:
            proc = subprocess.run(
                ["/usr/bin/textutil", "-convert", to, "-output", dst, src],
                capture_output=True,
            )
        except OSError:
            # The converter failed to even start -- same "no text" outcome
            # as a non-zero exit, mirroring the Rust `Ok(o) if o.status.
            # success() => ..., _ => None` match, which folds a `Command`
            # spawn error into the same `None` as a bad exit status.
            return None
        if proc.returncode != 0:
            return None
        try:
            with open(dst, encoding="utf-8") as fh:
                out = fh.read()
        except (OSError, UnicodeDecodeError):
            return None
        return out if out.strip() else None
    finally:
        _remove(src)
        _remove(dst)


def resolve_field_codes(text: str, as_html: bool) -> str:
    """Turn Word FIELD CODES that survived the `.doc` import into what they
    mean.

    A `.doc` stores a hyperlink as a field: the instruction
    `HYPERLINK "url"` followed by the display text. textutil imports the
    instruction as literal characters, so the reader saw the machinery of
    the document leaking into its prose, and the actual link not a link at
    all.

    Only the codes that carry user-visible meaning are handled. Everything
    else is left exactly as it came, because guessing at an unknown field
    is how a converter starts eating real text.
    """
    out: list[str] = []
    rest = text
    while True:
        at = rest.find("HYPERLINK")
        if at == -1:
            break
        before = rest[:at]
        after = rest[at + len("HYPERLINK") :]

        # The target is the first quoted string after the keyword.
        q1 = after.find('"')
        if q1 == -1:
            out.append(before)
            out.append("HYPERLINK")
            rest = after
            continue
        q2rel = after[q1 + 1 :].find('"')
        if q2rel == -1:
            out.append(before)
            out.append("HYPERLINK")
            rest = after
            continue

        # Only treat it as a field if what sits between the keyword and the
        # quote looks like the rest of a field instruction -- otherwise the
        # word "HYPERLINK" is just a word someone wrote. Everything Word
        # puts there before the target is a SWITCH, and every switch starts
        # with a backslash (`\l`, `\o`), so a bare word in that gap means
        # the next quote belongs to a later sentence and swallowing it
        # would delete every word in between.
        gap = after[:q1]
        # Byte length, to match the Rust `gap.len()` exactly -- see module
        # docstring for why a character count is not equivalent.
        if len(gap.encode("utf-8")) > _MAX_FIELD_GAP or not all(
            tok.startswith("\\") for tok in gap.split()
        ):
            out.append(before)
            out.append("HYPERLINK")
            rest = after
            continue

        target = after[q1 + 1 : q1 + 1 + q2rel]
        out.append(before)
        # Trailing whitespace before the field belongs to the prose, not
        # the link.
        if as_html and _looks_like_url(target):
            out.append(f'<a href="{_escape_attr(target)}">{_escape_text(target)}</a>')
        elif not as_html:
            out.append(target)
        else:
            out.append(_escape_text(target))
        rest = after[q1 + 1 + q2rel + 1 :]
    out.append(rest)
    return "".join(out)


def _looks_like_url(s: str) -> bool:
    """Conservative: only schemes a document viewer should ever make
    clickable. `javascript:` and friends must never become an `href`.
    """
    lower = s.strip().lower()
    return lower.startswith("https://") or lower.startswith("http://") or lower.startswith("mailto:")


def _escape_attr(s: str) -> str:
    return s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


def _escape_text(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
