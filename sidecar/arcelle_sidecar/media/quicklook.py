"""THE UNIVERSAL FALLBACK: macOS's own preview generator.

Port of `src-tauri/src/quicklook.rs`. Whatever this app can't parse itself,
the Mac usually can. QuickLook is the machinery behind pressing space in
Finder, and every format with a Quick Look extension installed — `.key`,
`.pages`, `.numbers`, legacy `.doc` and `.ppt`, RAW photos, PSD and AI
artwork, 3D models — renders through it.

One integration therefore replaces "No preview available for this file type
yet" with a real page for a long tail of formats that would otherwise each
need their own parser. It is image-only: no text selection, no search, no
editing. That is a genuine limit and the UI says so rather than implying the
file is fully supported.

PRIVACY NOTE, stated because it is the one real cost: QuickLook is a system
service and takes a FILE URL, so the decrypted bytes must touch the disk for
the moment it takes to render. They are written to a per-render temp file
with owner-only permissions and removed immediately afterwards, whether the
render succeeded or not. This is the same bargain `decode.decode_bytes_to_pcm`
already makes to hand audio to the OS converters — the alternative is not
"no temp file", it is "no preview at all for these formats".
"""

from __future__ import annotations

import os
import tempfile
import threading
import uuid
from pathlib import Path

from arcelle_sidecar.media.decode import write_private

try:
    import AppKit
    import Foundation
    import QuickLookThumbnailing as QLT
    from Quartz import CGSizeMake

    _QUICKLOOK_AVAILABLE = True
except ImportError:  # pragma: no cover - this sidecar only ships on macOS
    _QUICKLOOK_AVAILABLE = False


#: The longest edge, in points, of the preview handed to the viewer. Large
#: enough that a page of text is legible when the pane is full-width, small
#: enough that the base64 payload stays a few hundred KB.
PREVIEW_EDGE: float = 1400.0

#: A thumbnail request that hasn't answered in this long is abandoned. A
#: third-party Quick Look extension runs out of process and can hang; the
#: preview is a nicety and must never be able to wedge a room operation.
TIMEOUT_SECS: float = 20.0


def _remove(path: str | Path) -> None:
    """Best-effort delete — mirrors Rust's `let _ = std::fs::remove_file(...)`."""
    try:
        os.unlink(path)
    except OSError:
        pass


def preview_png(name: str, data: bytes) -> bytes | None:
    """Render one file's bytes to a PNG preview via QuickLook.

    `name` matters: QuickLook dispatches on the file EXTENSION, so the temp
    copy has to keep it or the OS has no idea which extension should render
    it.
    """
    if not data:
        return None
    path = temp_path_for(name)
    try:
        write_private(path, data)
    except FileExistsError:
        # The exclusive-create refused because something already exists at
        # this uuid-stemmed path — vanishingly unlikely, and since it means
        # WE created nothing, there is nothing of ours to remove.
        return None
    except OSError:
        # `write_private`'s create succeeded but the write itself failed
        # partway (e.g. disk full): the file exists now and holds a partial
        # copy of the room's decrypted bytes, so — unlike the Rust source,
        # which returns here without a cleanup call — this path removes it
        # too. See the module docstring's PRIVACY NOTE: no exit path may
        # leave decrypted bytes on disk, and this is still an exit path.
        _remove(path)
        return None
    try:
        return thumbnail_png(path, PREVIEW_EDGE)
    finally:
        # Always, on every path below this point — success, refusal, or
        # timeout — a preview must not leave decrypted bytes behind.
        _remove(path)


def thumbnail_png(path: str, max_edge: float) -> bytes | None:
    """Render `path` to a PNG at up to `max_edge` points on its longest side.

    Uses `QLThumbnailGenerator` at 2x scale (Retina-sharp) with
    `representationTypes=All`, which lets the OS fall back from a
    full-fidelity render to a lower one rather than returning nothing — a
    document with no Quick Look extension still yields its icon-with-preview.

    The completion handler fires asynchronously on a background queue owned
    by QuickLook, so a `threading.Event` blocks this (already-background)
    thread until it fires or `TIMEOUT_SECS` elapses — the Python analogue of
    the Rust side's `mpsc::channel` + `recv_timeout`.
    """
    if not _QUICKLOOK_AVAILABLE:
        return None

    url = Foundation.NSURL.fileURLWithPath_(str(path))
    size = CGSizeMake(max_edge, max_edge)
    request = QLT.QLThumbnailGenerationRequest.alloc().initWithFileAtURL_size_scale_representationTypes_(
        url,
        size,
        2.0,
        QLT.QLThumbnailGenerationRequestRepresentationTypeAll,
    )

    done = threading.Event()
    outcome: dict[str, object] = {}

    def _handler(rep: object, _err: object) -> None:
        # The event may already be timed out with nobody waiting by the time
        # this fires; that's fine — this is a plain dict write plus a
        # `set()`, not a blocking send that could itself hang.
        outcome["rep"] = rep
        done.set()

    QLT.QLThumbnailGenerator.sharedGenerator().generateBestRepresentationForRequest_completionHandler_(
        request, _handler
    )
    if not done.wait(TIMEOUT_SECS):
        return None
    rep = outcome.get("rep")
    if rep is None:
        return None
    return _png_of(rep)


def _png_of(rep: object) -> bytes | None:
    """The representation's CGImage, encoded as PNG."""
    cg = rep.CGImage()  # type: ignore[attr-defined]
    if cg is None:
        return None
    bitmap = AppKit.NSBitmapImageRep.alloc().initWithCGImage_(cg)
    if bitmap is None:
        return None
    encoded = bitmap.representationUsingType_properties_(AppKit.NSBitmapImageFileTypePNG, {})
    if encoded is None:
        return None
    return bytes(encoded)


def _extension_of(name: str) -> str:
    """Lower-cased extension, mirroring Rust's `extraction::extension_of`
    (itself `Path::extension()`): no extension for a name with no `.`, and a
    dotfile with no OTHER `.` (e.g. `.gitignore`) also counts as
    extension-less rather than having extension `gitignore`.
    """
    base = os.path.basename(name)
    dot = base.rfind(".")
    if dot <= 0:
        return ""
    return base[dot + 1 :].lower()


def temp_path_for(name: str) -> str:
    """A fresh temp path for one render, keeping the original EXTENSION —
    QuickLook dispatches on it, so a copy without it is a file the OS has no
    idea how to draw. The uuid stem means two concurrent renders of the same
    document name never collide.
    """
    ext = _extension_of(name)
    stem = uuid.uuid4()
    tmp_dir = Path(tempfile.gettempdir())
    if ext:
        return str(tmp_dir / f"arcelle-ql-{stem}.{ext}")
    return str(tmp_dir / f"arcelle-ql-{stem}")
