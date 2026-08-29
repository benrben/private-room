"""Private, derived one-frame-per-second indexes for room videos.

The transcript is text evidence; it is not a substitute for pixels.  This
module builds a small JPEG index while Electron already has a decrypted video
staged for local transcription, then serves one timestamped image back to the
host.  Frames live only below the app's derived-cache directory: they are never
put in a transcript, SQLite database, agent checkpoint, or model message until
the user actually asks to inspect that timestamp.

The format is intentionally pinned.  An index id binds the source's SHA-256 to
the exact capture profile, so changing either the file or the encoder creates a
different immutable directory.  A build happens in a private sibling directory
and is renamed into place only after every frame and the manifest are complete.

Production capture uses AVFoundation/PyObjC, already bundled for media probing.
There is no ffmpeg executable or other production dependency.

TRUST BOUNDARY: cached JPEGs are plaintext derived pixels.  The authenticated
Electron host may warm this cache only from an ordinary workspace-backed media
file.  It must never stage a legacy embedded/encrypted room blob here.  This
endpoint can prove that a path is in the host's private staging directory, but
only the host that decrypted/read the room knows the source storage class.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from PIL import Image

from arcelle_sidecar.media.decode import write_private

try:
    import AppKit
    import AVFoundation
    import CoreMedia as CM
    import Foundation
    import objc

    # Registers CGImageRef's bridge before AVAssetImageGenerator returns one.
    import Quartz  # noqa: F401

    _AVFOUNDATION_AVAILABLE = True
except ImportError:  # pragma: no cover - the sidecar ships only on macOS
    _AVFOUNDATION_AVAILABLE = False


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


def _seconds_of(time: object) -> float | None:
    if not bool(time.flags & CM.kCMTimeFlags_Valid) or time.timescale <= 0:
        return None
    seconds = time.value / time.timescale
    return seconds if math.isfinite(seconds) and seconds >= 0.0 else None


def _cm_time(seconds: float) -> object:
    return CM.CMTime(
        value=int(math.floor(seconds * 600.0 + 0.5)),
        timescale=600,
        flags=CM.kCMTimeFlags_Valid,
        epoch=0,
    )


def _requested_second(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise VisualIndexError(
            "VISUAL_INDEX_BAD_REQUEST", "second must be a non-negative integer", 400
        )
    return value


def _copy_frame(generator: object, at: object) -> object | None:
    zero = _cm_time(0.0)
    generator.setRequestedTimeToleranceBefore_(zero)
    generator.setRequestedTimeToleranceAfter_(zero)
    image, _error = generator.copyCGImageAtTime_actualTime_error_(at, None, None)
    if image is not None:
        return image

    # Odd/fragmented containers sometimes reject a zero-tolerance request.
    # Half a second stays inside this frame's one-second cache bucket while
    # still yielding real pixels rather than failing back to transcript text.
    half_second = _cm_time(0.5)
    generator.setRequestedTimeToleranceBefore_(half_second)
    generator.setRequestedTimeToleranceAfter_(half_second)
    image, _error = generator.copyCGImageAtTime_actualTime_error_(at, None, None)
    return image


def _video_timing(asset: object) -> tuple[float, float]:
    tracks = asset.tracksWithMediaType_(AVFoundation.AVMediaTypeVideo)
    if len(tracks) == 0:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "the file has no readable video track", 422
        )
    time_range = tracks[0].timeRange()
    start_secs = _seconds_of(time_range.start)
    duration_secs = _seconds_of(time_range.duration)
    if start_secs is None or duration_secs is None or duration_secs <= 0.0:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "the video track has no usable duration", 422
        )
    return start_secs, duration_secs


def _image_generator(asset: object, profile: VisualIndexProfile) -> object:
    generator = AVFoundation.AVAssetImageGenerator.alloc().initWithAsset_(asset)
    generator.setAppliesPreferredTrackTransform_(True)
    generator.setMaximumSize_((profile.max_dimension, profile.max_dimension))
    return generator


def _jpeg_from_cg_image(image: object, profile: VisualIndexProfile) -> tuple[bytes, int, int]:
    bitmap = AppKit.NSBitmapImageRep.alloc().initWithCGImage_(image)
    if bitmap is None:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "the video frame could not be encoded", 422
        )
    encoded = bitmap.representationUsingType_properties_(
        AppKit.NSBitmapImageFileTypeJPEG,
        {AppKit.NSImageCompressionFactor: profile.jpeg_quality},
    )
    if encoded is None:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "the video frame could not be encoded", 422
        )
    data = bytes(encoded)
    if not data or len(data) > MAX_FRAME_BYTES:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "the video frame has an invalid size", 422
        )
    width = int(bitmap.pixelsWide())
    height = int(bitmap.pixelsHigh())
    if width <= 0 or height <= 0:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "the video frame has no usable size", 422
        )
    return data, width, height


def capture_frame_avfoundation(
    source: Path, requested_second: int, profile: VisualIndexProfile = PROFILE
) -> dict[str, Any]:
    """Capture one cold timestamp without waiting for the full index."""
    requested_second = _requested_second(requested_second)
    if not _AVFOUNDATION_AVAILABLE:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "AVFoundation is unavailable", 422
        )
    with objc.autorelease_pool():
        url = Foundation.NSURL.fileURLWithPath_(str(source))
        asset = AVFoundation.AVURLAsset.URLAssetWithURL_options_(url, None)
        start_secs, duration_secs = _video_timing(asset)
        resolved_second = min(requested_second, len(_frame_seconds(duration_secs)) - 1)
        image = _copy_frame(
            _image_generator(asset, profile),
            _cm_time(start_secs + float(resolved_second)),
        )
        if image is None:
            raise VisualIndexError(
                "VISUAL_INDEX_UNREADABLE",
                f"the video frame at second {resolved_second} could not be decoded",
                422,
            )
        data, width, height = _jpeg_from_cg_image(image, profile)
    return {
        "requested_second": requested_second,
        "resolved_second": resolved_second,
        "actual_second": resolved_second,
        "mime": profile.mime,
        "image_b64": base64.b64encode(data).decode("ascii"),
        "sha256": hashlib.sha256(data).hexdigest(),
        "byte_size": len(data),
        "width": width,
        "height": height,
        "duration_secs": duration_secs,
    }


def capture_frames_avfoundation(
    source: Path, destination: Path, profile: VisualIndexProfile
) -> CaptureInfo:
    """Write the pinned JPEG index using the bundled macOS media stack."""
    if not _AVFOUNDATION_AVAILABLE:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "AVFoundation is unavailable", 422
        )

    with objc.autorelease_pool():
        url = Foundation.NSURL.fileURLWithPath_(str(source))
        asset = AVFoundation.AVURLAsset.URLAssetWithURL_options_(url, None)
        start_secs, duration_secs = _video_timing(asset)
        generator = _image_generator(asset, profile)

        width = 0
        height = 0
        seconds = _frame_seconds(duration_secs)
        for second in seconds:
            # Addressing is relative to the displayed clip.  A non-zero track
            # start is an edit-list detail, not a reason frame 0 should fail.
            image = _copy_frame(generator, _cm_time(start_secs + float(second)))
            if image is None:
                raise VisualIndexError(
                    "VISUAL_INDEX_UNREADABLE",
                    f"the video frame at second {second} could not be decoded",
                    422,
                )
            data, frame_width, frame_height = _jpeg_from_cg_image(image, profile)
            write_private(destination / f"frame-{second:06d}.jpg", data)
            if second == 0:
                width = frame_width
                height = frame_height

        if width <= 0 or height <= 0:
            raise VisualIndexError(
                "VISUAL_INDEX_UNREADABLE", "the video frames have no usable size", 422
            )
        return CaptureInfo(
            duration_secs=duration_secs,
            frame_count=len(seconds),
            width=width,
            height=height,
        )


def _validated_ffmpeg() -> Path | None:
    """An optional local accelerator, never a runtime requirement."""
    candidates: list[Path] = []
    found = shutil.which("ffmpeg")
    if found:
        candidates.append(Path(found))
    candidates.extend(_FFMPEG_CANDIDATES)
    seen: set[Path] = set()
    for candidate in candidates:
        try:
            resolved = candidate.resolve(strict=True)
        except OSError:
            continue
        if resolved in seen or not resolved.is_file() or not os.access(resolved, os.X_OK):
            continue
        seen.add(resolved)
        try:
            probe = subprocess.run(
                [str(resolved), "-version"],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=3,
                check=False,
                umask=0o077,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if probe.returncode == 0 and probe.stdout.startswith(b"ffmpeg version "):
            return resolved
    return None


def _remove_generated_frames(destination: Path) -> None:
    try:
        entries = list(destination.iterdir())
    except OSError:
        return
    for frame in entries:
        if _FRAME_NAME_RE.fullmatch(frame.name) is not None and not frame.is_symlink():
            try:
                frame.unlink()
            except OSError:
                pass


def capture_frames_ffmpeg(
    source: Path,
    destination: Path,
    profile: VisualIndexProfile,
    executable: Path,
) -> CaptureInfo:
    """Fast optional decoder; output is verified before it can be published."""
    if not _AVFOUNDATION_AVAILABLE:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "AVFoundation is unavailable", 422
        )
    with objc.autorelease_pool():
        url = Foundation.NSURL.fileURLWithPath_(str(source))
        asset = AVFoundation.AVURLAsset.URLAssetWithURL_options_(url, None)
        _start_secs, duration_secs = _video_timing(asset)
    seconds = _frame_seconds(duration_secs)
    output = destination / "frame-%06d.jpg"
    fixed_filter = (
        "setpts=PTS-STARTPTS,"
        "fps=1:eof_action=pass,"
        f"scale={profile.max_dimension}:{profile.max_dimension}:"
        "force_original_aspect_ratio=decrease:flags=area"
    )
    timeout = max(30.0, min(1800.0, duration_secs * 0.1 + 10.0))
    try:
        result = subprocess.run(
            [
                str(executable),
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-i",
                str(source),
                "-map",
                "0:v:0",
                "-an",
                "-vf",
                fixed_filter,
                "-fps_mode",
                "passthrough",
                "-frame_pts",
                "1",
                "-q:v",
                str(_FFMPEG_QSCALE),
                str(output),
            ],
            stdout=subprocess.DEVNULL,
            # No path/content-bearing decoder diagnostics are retained, and a
            # malicious container cannot make stderr grow without bound.
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
            umask=0o077,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "the accelerated video decode failed", 422
        ) from exc
    if result.returncode != 0:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "the accelerated video decode failed", 422
        )

    expected_names = {f"frame-{second:06d}.jpg" for second in seconds}
    actual_names = {
        entry.name
        for entry in destination.iterdir()
        if _FRAME_NAME_RE.fullmatch(entry.name) is not None
    }
    if actual_names != expected_names:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE",
            "the accelerated video decode returned an incomplete timeline",
            422,
        )
    first = destination / "frame-000000.jpg"
    try:
        with Image.open(first) as image:
            if image.format != "JPEG":
                raise ValueError("not JPEG")
            width, height = image.size
        for second in seconds:
            frame = destination / f"frame-{second:06d}.jpg"
            size = frame.stat().st_size
            if not (4 <= size <= MAX_FRAME_BYTES):
                raise ValueError("bad frame size")
            frame.chmod(0o600)
    except (OSError, ValueError) as exc:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "the accelerated video frames are invalid", 422
        ) from exc
    return CaptureInfo(
        duration_secs=duration_secs,
        frame_count=len(seconds),
        width=width,
        height=height,
    )


def capture_frames(
    source: Path, destination: Path, profile: VisualIndexProfile
) -> CaptureInfo:
    """Use a verified local ffmpeg when present, otherwise bundled AVFoundation."""
    executable = _validated_ffmpeg()
    if executable is not None:
        try:
            return capture_frames_ffmpeg(source, destination, profile, executable)
        except VisualIndexError:
            # Optional means optional: an old build, unsupported codec, timeout,
            # or incomplete output falls back to the bundled decoder.
            _remove_generated_frames(destination)
    return capture_frames_avfoundation(source, destination, profile)


class VisualIndexStore:
    """Content-addressed persistent store for the pinned visual profile."""

    def __init__(
        self,
        root: Path | None = None,
        capture_frames: CaptureFrames = capture_frames,
        *,
        max_cache_bytes: int = MAX_CACHE_BYTES,
        max_indexes: int = MAX_CACHE_INDEXES,
    ) -> None:
        self.root = (root or _default_cache_root()).resolve()
        self.capture_frames = capture_frames
        self.max_cache_bytes = max(1, int(max_cache_bytes))
        self.max_indexes = max(1, int(max_indexes))
        self._active_lock = threading.Lock()
        self._active_ids: dict[str, int] = {}
        self._active_stages: set[Path] = set()
        if self.root.is_dir():
            self._cleanup_orphans()

    @contextmanager
    def _active(self, index_id: str):
        with self._active_lock:
            self._active_ids[index_id] = self._active_ids.get(index_id, 0) + 1
        try:
            yield
        finally:
            with self._active_lock:
                remaining = self._active_ids.get(index_id, 1) - 1
                if remaining > 0:
                    self._active_ids[index_id] = remaining
                else:
                    self._active_ids.pop(index_id, None)

    def _index_dir(self, index_id: str) -> Path:
        if not isinstance(index_id, str) or _INDEX_ID_RE.fullmatch(index_id) is None:
            raise VisualIndexError(
                "VISUAL_INDEX_BAD_REQUEST", "the visual index id is invalid", 400
            )
        return self.root / index_id

    def _manifest(self, index_id: str) -> dict[str, Any] | None:
        directory = self._index_dir(index_id)
        manifest_path = directory / MANIFEST_NAME
        try:
            raw = manifest_path.read_bytes()
            if len(raw) > 64 << 10:
                return None
            manifest = json.loads(raw)
        except (OSError, ValueError, TypeError):
            return None
        if not isinstance(manifest, dict) or not self._valid_manifest(index_id, manifest):
            return None
        return manifest

    @staticmethod
    def _valid_manifest(index_id: str, manifest: Mapping[str, Any]) -> bool:
        try:
            count = int(manifest["frame_count"])
            first = int(manifest["first_second"])
            last = int(manifest["last_second"])
            width = int(manifest["width"])
            height = int(manifest["height"])
            source = manifest["source"]
            profile = manifest["profile"]
            return bool(
                manifest.get("schema_version") == 1
                and manifest.get("index_id") == index_id
                and isinstance(source, dict)
                and isinstance(profile, dict)
                and source.get("sha256") == index_id.partition(".")[0]
                and profile == asdict(PROFILE)
                and count >= 1
                and first == 0
                and last == count - 1
                and width >= 1
                and height >= 1
                and int(manifest["total_bytes"]) >= 1
            )
        except (KeyError, TypeError, ValueError):
            return False

    def _complete(self, index_id: str) -> dict[str, Any] | None:
        manifest = self._manifest(index_id)
        if manifest is None:
            return None
        directory = self.root / index_id
        for second in range(int(manifest["frame_count"])):
            frame = directory / f"frame-{second:06d}.jpg"
            try:
                size = frame.stat().st_size
                if not frame.is_file() or not (4 <= size <= MAX_FRAME_BYTES):
                    return None
                # Validate every persisted frame, not only the bookends.  JPEG
                # SOI/EOI catches truncation and wrong-file replacement without
                # paying for 3,400 full Pillow decodes on every sidecar restart.
                with frame.open("rb") as source:
                    if source.read(2) != b"\xff\xd8":
                        return None
                    source.seek(-2, os.SEEK_END)
                    if source.read(2) != b"\xff\xd9":
                        return None
            except OSError:
                return None
        return manifest

    def _touch(self, index_id: str) -> None:
        directory = self.root / index_id
        try:
            os.utime(directory, None, follow_symlinks=False)
        except OSError:
            pass

    def _index_size(self, directory: Path) -> int:
        manifest = self._manifest(directory.name)
        if manifest is not None:
            try:
                manifest_size = (directory / MANIFEST_NAME).stat().st_size
                return max(0, int(manifest["total_bytes"])) + manifest_size
            except (KeyError, TypeError, ValueError):
                pass
        total = 0
        try:
            for item in directory.iterdir():
                if item.is_file() and not item.is_symlink():
                    total += item.stat().st_size
        except OSError:
            return 0
        return total

    def _cleanup_orphans(self) -> None:
        cutoff_ns = time.time_ns() - int(ORPHAN_MAX_AGE_SECS * 1_000_000_000)
        try:
            entries = list(self.root.iterdir())
        except OSError:
            return
        for directory in entries:
            if (
                directory.is_symlink()
                or not directory.is_dir()
                or not directory.name.startswith((".building-", ".stale-"))
            ):
                continue
            with self._active_lock:
                active = directory in self._active_stages
            try:
                old = directory.stat().st_mtime_ns < cutoff_ns
            except OSError:
                continue
            if old and not active:
                shutil.rmtree(directory, ignore_errors=True)

    def _prune(self) -> None:
        """Bound this plaintext derived cache by age, bytes, and index count.

        Building/stale directories are lifecycle internals and never LRU
        candidates.  An index serving another request in this process is also
        skipped; a later successful warm/frame retries pruning.
        """
        self._cleanup_orphans()
        try:
            entries = list(self.root.iterdir())
        except OSError:
            return
        candidates: list[tuple[int, int, Path]] = []
        for directory in entries:
            if (
                directory.is_symlink()
                or not directory.is_dir()
                or _INDEX_ID_RE.fullmatch(directory.name) is None
            ):
                continue
            try:
                touched = directory.stat().st_mtime_ns
            except OSError:
                continue
            candidates.append((touched, self._index_size(directory), directory))

        count = len(candidates)
        total = sum(size for _touched, size, _directory in candidates)
        for _touched, size, directory in sorted(candidates):
            if count <= self.max_indexes and total <= self.max_cache_bytes:
                break
            with self._active_lock:
                active = self._active_ids.get(directory.name, 0) > 0
            if active:
                continue
            shutil.rmtree(directory, ignore_errors=True)
            if not directory.exists():
                count -= 1
                total -= size

    def _touch_and_prune(self, index_id: str) -> None:
        self._touch(index_id)
        self._prune()

    def warm(self, source: Path) -> dict[str, Any]:
        source = source.resolve()
        before = _snapshot(source)
        source_sha = _sha256_file(source)
        if _snapshot(source) != before:
            raise SourceChangedError()

        index_id = f"{source_sha}.{PROFILE.id}"
        _private_directory(self.root)
        with self._active(index_id):
            complete = self._complete(index_id)
            if complete is not None:
                payload = self._warm_payload(complete, reused=True)
                self._touch_and_prune(index_id)
                return payload

            stage = self.root / f".building-{uuid.uuid4().hex}"
            _private_directory(stage)
            with self._active_lock:
                self._active_stages.add(stage)
            try:
                info = self.capture_frames(source, stage, PROFILE)
                expected_seconds = _frame_seconds(info.duration_secs)
                if info.frame_count != len(expected_seconds):
                    raise VisualIndexError(
                        "VISUAL_INDEX_FAILED",
                        "the visual index frame count is inconsistent",
                        500,
                    )
                total_bytes = 0
                for second in expected_seconds:
                    frame = stage / f"frame-{second:06d}.jpg"
                    if not frame.is_file() or not (
                        0 < frame.stat().st_size <= MAX_FRAME_BYTES
                    ):
                        raise VisualIndexError(
                            "VISUAL_INDEX_FAILED",
                            f"the visual index is missing frame {second}",
                            500,
                        )
                    total_bytes += frame.stat().st_size

                # Hash again after the long capture.  Stat fingerprints catch
                # most races cheaply; the second digest catches a same-size
                # rewrite with restored timestamps too.  A mixed-source index
                # is never published.
                after = _snapshot(source)
                if after != before or _sha256_file(source) != source_sha:
                    raise SourceChangedError()

                manifest: dict[str, Any] = {
                    "schema_version": 1,
                    "index_id": index_id,
                    "source": {"sha256": source_sha, "size": before.size},
                    "profile": asdict(PROFILE),
                    "duration_secs": info.duration_secs,
                    "frame_count": info.frame_count,
                    "first_second": 0,
                    "last_second": info.frame_count - 1,
                    "width": info.width,
                    "height": info.height,
                    "total_bytes": total_bytes,
                }
                manifest_bytes = json.dumps(
                    manifest, ensure_ascii=True, sort_keys=True, separators=(",", ":")
                ).encode("utf-8")
                manifest_temp = stage / f"{MANIFEST_NAME}.tmp"
                write_private(manifest_temp, manifest_bytes)
                os.replace(manifest_temp, stage / MANIFEST_NAME)

                final = self.root / index_id
                # Another simultaneous warm may have won while this captured.
                complete = self._complete(index_id)
                if complete is not None:
                    payload = self._warm_payload(complete, reused=True)
                    self._touch_and_prune(index_id)
                    return payload
                if final.exists():
                    stale = self.root / f".stale-{uuid.uuid4().hex}"
                    os.replace(final, stale)
                    try:
                        os.replace(stage, final)
                    finally:
                        shutil.rmtree(stale, ignore_errors=True)
                else:
                    os.replace(stage, final)
                payload = self._warm_payload(manifest, reused=False)
                self._touch_and_prune(index_id)
                return payload
            except VisualIndexError:
                raise
            except (OSError, RuntimeError, ValueError) as exc:
                raise VisualIndexError(
                    "VISUAL_INDEX_FAILED", "the visual index could not be built", 500
                ) from exc
            finally:
                with self._active_lock:
                    self._active_stages.discard(stage)
                shutil.rmtree(stage, ignore_errors=True)

    @staticmethod
    def _warm_payload(manifest: Mapping[str, Any], reused: bool) -> dict[str, Any]:
        source = manifest["source"]
        return {
            "status": "ready",
            "index_id": manifest["index_id"],
            "source_sha256": source["sha256"],
            "source_size": source["size"],
            "duration_secs": manifest["duration_secs"],
            "frame_count": manifest["frame_count"],
            "first_second": manifest["first_second"],
            "last_second": manifest["last_second"],
            "width": manifest["width"],
            "height": manifest["height"],
            "profile": manifest["profile"],
            "reused": reused,
        }

    def frame(self, index_id: str, requested_second: int) -> dict[str, Any]:
        requested_second = _requested_second(requested_second)
        directory = self._index_dir(index_id)
        with self._active(index_id):
            manifest = self._manifest(index_id)
            if manifest is None:
                raise VisualIndexError(
                    "VISUAL_INDEX_NOT_FOUND", "the visual index was not found", 404
                )
            resolved_second = min(requested_second, int(manifest["last_second"]))
            frame_path = directory / f"frame-{resolved_second:06d}.jpg"
            try:
                data = frame_path.read_bytes()
            except OSError as exc:
                raise VisualIndexError(
                    "VISUAL_INDEX_FRAME_NOT_FOUND",
                    "the indexed video frame was not found",
                    404,
                ) from exc
            if not data or len(data) > MAX_FRAME_BYTES:
                raise VisualIndexError(
                    "VISUAL_INDEX_FRAME_NOT_FOUND", "the indexed video frame is invalid", 404
                )
            try:
                with Image.open(frame_path) as image:
                    if image.format != "JPEG":
                        raise ValueError("not JPEG")
                    width, height = image.size
            except (OSError, ValueError) as exc:
                raise VisualIndexError(
                    "VISUAL_INDEX_FRAME_NOT_FOUND", "the indexed video frame is invalid", 404
                ) from exc
            digest = hashlib.sha256(data).hexdigest()
            payload = {
                "index_id": index_id,
                "requested_second": requested_second,
                "resolved_second": resolved_second,
                "actual_second": resolved_second,
                "mime": PROFILE.mime,
                "image_b64": base64.b64encode(data).decode("ascii"),
                "sha256": digest,
                "byte_size": len(data),
                "width": width,
                "height": height,
            }
            self._touch_and_prune(index_id)
            return payload


def _staged_video_path(value: Any) -> Path:
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise VisualIndexError(
            "VISUAL_INDEX_BAD_REQUEST", "path must name one staged video", 400
        )
    try:
        staged = Path(value).resolve()
        temp_root = Path(tempfile.gettempdir()).resolve()
    except (OSError, RuntimeError) as exc:
        raise VisualIndexError(
            "VISUAL_INDEX_BAD_REQUEST", "the staged video path was refused", 400
        ) from exc
    if (
        staged.parent.parent != temp_root
        or not staged.parent.name.startswith(_STAGED_DIR_PREFIXES)
    ):
        raise VisualIndexError(
            "VISUAL_INDEX_BAD_REQUEST", "the staged video path was refused", 400
        )
    _snapshot(staged)
    return staged


def _error_response(error: VisualIndexError) -> JSONResponse:
    return JSONResponse(
        {"code": error.code, "error": str(error)}, status_code=error.status_code
    )


def register_visual_index_routes(
    app: FastAPI, store: VisualIndexStore | None = None
) -> VisualIndexStore:
    """Attach the authenticated visual-cache HTTP surface to the sidecar."""
    initial_store = store or VisualIndexStore()
    app.state.visual_index_store = initial_store

    @app.post("/media/visual-index/warm")
    async def visual_index_warm(request: Request) -> Any:
        try:
            body = await request.json()
            if not isinstance(body, dict) or set(body) != {"path"}:
                raise VisualIndexError(
                    "VISUAL_INDEX_BAD_REQUEST", "the warm request is invalid", 400
                )
            source = _staged_video_path(body["path"])
            active_store: VisualIndexStore = request.app.state.visual_index_store
            return await asyncio.to_thread(active_store.warm, source)
        except VisualIndexError as exc:
            return _error_response(exc)
        except (ValueError, TypeError):
            return _error_response(
                VisualIndexError(
                    "VISUAL_INDEX_BAD_REQUEST", "the warm request is invalid", 400
                )
            )

    @app.post("/media/visual-index/frame")
    async def visual_index_frame(request: Request) -> Any:
        try:
            body = await request.json()
            if not isinstance(body, dict) or set(body) != {"index_id", "second"}:
                raise VisualIndexError(
                    "VISUAL_INDEX_BAD_REQUEST", "the frame request is invalid", 400
                )
            active_store: VisualIndexStore = request.app.state.visual_index_store
            return await asyncio.to_thread(
                active_store.frame, body["index_id"], body["second"]
            )
        except VisualIndexError as exc:
            return _error_response(exc)
        except (ValueError, TypeError):
            return _error_response(
                VisualIndexError(
                    "VISUAL_INDEX_BAD_REQUEST", "the frame request is invalid", 400
                )
            )

    @app.post("/media/visual-index/capture")
    async def visual_index_capture(request: Request) -> Any:
        try:
            body = await request.json()
            if not isinstance(body, dict) or set(body) != {"path", "second"}:
                raise VisualIndexError(
                    "VISUAL_INDEX_BAD_REQUEST", "the capture request is invalid", 400
                )
            source = _staged_video_path(body["path"])
            second = _requested_second(body["second"])
            return await asyncio.to_thread(
                capture_frame_avfoundation, source, second, PROFILE
            )
        except VisualIndexError as exc:
            return _error_response(exc)
        except (ValueError, TypeError):
            return _error_response(
                VisualIndexError(
                    "VISUAL_INDEX_BAD_REQUEST", "the capture request is invalid", 400
                )
            )

    return initial_store


__all__ = [
    "CACHE_ENV",
    "CaptureInfo",
    "PROFILE",
    "SourceChangedError",
    "VisualIndexError",
    "VisualIndexProfile",
    "VisualIndexStore",
    "capture_frame_avfoundation",
    "capture_frames",
    "capture_frames_avfoundation",
    "capture_frames_ffmpeg",
    "register_visual_index_routes",
]
