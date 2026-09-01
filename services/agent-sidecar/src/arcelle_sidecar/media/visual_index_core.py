"""Visual-index profile, source identity, and cache primitives."""

from __future__ import annotations

import hashlib
import math
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

CACHE_ENV = "ARCELLE_VISUAL_INDEX_DIR"
CACHE_DIR_NAME = "visual-index-v1"
MANIFEST_NAME = "manifest.json"
MAX_FRAME_BYTES = 4 << 20
MAX_CACHE_BYTES = 2 << 30
MAX_CACHE_INDEXES = 128
ORPHAN_MAX_AGE_SECS = 60 * 60
_FFMPEG_QSCALE = 12
_FFMPEG_CANDIDATES = (
    Path("/opt/homebrew/bin/ffmpeg"),
    Path("/usr/local/bin/ffmpeg"),
)


@dataclass(frozen=True)
class VisualIndexProfile:
    """The wire and disk contract.  Clients cannot override these values."""

    id: str = "jpeg-320-1fps-q42-v1"
    fps: int = 1
    max_dimension: int = 320
    jpeg_quality: float = 0.42
    mime: str = "image/jpeg"


PROFILE = VisualIndexProfile()
_INDEX_ID_RE = re.compile(rf"^[0-9a-f]{{64}}\.{re.escape(PROFILE.id)}$")
_FRAME_NAME_RE = re.compile(r"^frame-[0-9]{6}\.jpg$")
_STAGED_DIR_PREFIXES = ("arcelle-stt-", "arcelle-visual-index-")


class VisualIndexError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class SourceChangedError(VisualIndexError):
    def __init__(self) -> None:
        super().__init__(
            "VISUAL_INDEX_SOURCE_CHANGED",
            "the staged video changed while its visual index was being built",
            409,
        )


@dataclass(frozen=True)
class CaptureInfo:
    duration_secs: float
    frame_count: int
    width: int
    height: int


@dataclass(frozen=True)
class SourceSnapshot:
    device: int
    inode: int
    size: int
    mtime_ns: int


CaptureFrames = Callable[[Path, Path, VisualIndexProfile], CaptureInfo]


def _default_cache_root() -> Path:
    configured = os.environ.get(CACHE_ENV, "").strip()
    if configured:
        # This environment value comes from the authenticated Electron host at
        # sidecar spawn.  It is deliberately not accepted in HTTP request data.
        return Path(configured).expanduser().resolve()
    return (
        Path.home()
        / "Library"
        / "Caches"
        / "com.benreich.privateroom"
        / CACHE_DIR_NAME
    ).resolve()


def _snapshot(path: Path) -> SourceSnapshot:
    try:
        stat = path.stat()
    except OSError as exc:
        raise VisualIndexError(
            "VISUAL_INDEX_BAD_REQUEST", "the staged video is missing", 400
        ) from exc
    if not path.is_file() or stat.st_size <= 0:
        raise VisualIndexError(
            "VISUAL_INDEX_BAD_REQUEST",
            "the staged video must be a non-empty regular file",
            400,
        )
    return SourceSnapshot(
        device=stat.st_dev,
        inode=stat.st_ino,
        size=stat.st_size,
        mtime_ns=stat.st_mtime_ns,
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            while chunk := source.read(1 << 20):
                digest.update(chunk)
    except OSError as exc:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "the staged video could not be read", 422
        ) from exc
    return digest.hexdigest()


def _private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.chmod(0o700)
    except OSError:
        # The files themselves are still created owner-only.  Some unusual
        # mounted filesystems refuse chmod even for an already-private root.
        pass


def _frame_seconds(duration_secs: float) -> range:
    """Every integer timestamp inside the clip, including a partial tail.

    A 2.0-second clip has frames 0 and 1; a 2.01-second clip also has frame 2.
    AVFoundation durations are rationals converted to floats, so values within
    one microsecond of an integer are treated as that integer rather than
    inventing a one-microsecond final frame.
    """
    if not math.isfinite(duration_secs) or duration_secs <= 0.0:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "the video has no usable duration", 422
        )
    whole = math.floor(duration_secs)
    count = whole if math.isclose(duration_secs, whole, abs_tol=1e-6) else whole + 1
    return range(max(1, count))
