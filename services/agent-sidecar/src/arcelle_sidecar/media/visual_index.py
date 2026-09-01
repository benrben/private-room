"""Private, derived one-frame-per-second indexes for room videos."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import math
import os
import shutil
import subprocess
import tempfile
import threading as threading
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from PIL import Image

from arcelle_sidecar.media.decode import write_private
from arcelle_sidecar.media.visual_index_core import CACHE_DIR_NAME as CACHE_DIR_NAME, CACHE_ENV as CACHE_ENV, MANIFEST_NAME as MANIFEST_NAME, MAX_CACHE_BYTES as MAX_CACHE_BYTES, MAX_CACHE_INDEXES as MAX_CACHE_INDEXES, MAX_FRAME_BYTES as MAX_FRAME_BYTES, ORPHAN_MAX_AGE_SECS as ORPHAN_MAX_AGE_SECS, PROFILE as PROFILE, CaptureFrames as CaptureFrames, CaptureInfo as CaptureInfo, SourceChangedError as SourceChangedError, SourceSnapshot as SourceSnapshot, VisualIndexError as VisualIndexError, VisualIndexProfile as VisualIndexProfile, _FFMPEG_CANDIDATES as _FFMPEG_CANDIDATES, _FFMPEG_QSCALE as _FFMPEG_QSCALE, _FRAME_NAME_RE as _FRAME_NAME_RE, _INDEX_ID_RE as _INDEX_ID_RE, _STAGED_DIR_PREFIXES as _STAGED_DIR_PREFIXES, _default_cache_root as _default_cache_root, _frame_seconds as _frame_seconds, _private_directory as _private_directory, _sha256_file as _sha256_file, _snapshot as _snapshot
from arcelle_sidecar.media.visual_index_manifest import _directory_file_size as _directory_file_size, _has_jpeg_markers as _has_jpeg_markers, _index_frame_dimensions as _index_frame_dimensions, _is_expired_orphan as _is_expired_orphan, _manifest_index_size as _manifest_index_size, _read_index_frame as _read_index_frame
from arcelle_sidecar.media.visual_index_store import _VisualIndexStore

try:
    import AppKit
    import AVFoundation
    import CoreMedia as CM
    import Foundation
    import objc

    import Quartz  # noqa: F401

    _AVFOUNDATION_AVAILABLE = True
except ImportError:  # pragma: no cover - the sidecar ships only on macOS
    _AVFOUNDATION_AVAILABLE = False


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


def _bitmap_image_rep(image: object) -> object:
    bitmap = AppKit.NSBitmapImageRep.alloc().initWithCGImage_(image)
    if bitmap is not None:
        return bitmap
    raise VisualIndexError(
        "VISUAL_INDEX_UNREADABLE", "the video frame could not be encoded", 422
    )


def _encoded_jpeg(bitmap: object, profile: VisualIndexProfile) -> bytes:
    encoded = bitmap.representationUsingType_properties_(
        AppKit.NSBitmapImageFileTypeJPEG,
        {AppKit.NSImageCompressionFactor: profile.jpeg_quality},
    )
    if encoded is None:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "the video frame could not be encoded", 422
        )
    return bytes(encoded)


def _validated_jpeg_data(data: bytes) -> bytes:
    if not data or len(data) > MAX_FRAME_BYTES:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "the video frame has an invalid size", 422
        )
    return data


def _bitmap_dimensions(bitmap: object) -> tuple[int, int]:
    width = int(bitmap.pixelsWide())
    height = int(bitmap.pixelsHigh())
    if width <= 0 or height <= 0:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "the video frame has no usable size", 422
        )
    return width, height


def _jpeg_from_cg_image(image: object, profile: VisualIndexProfile) -> tuple[bytes, int, int]:
    bitmap = _bitmap_image_rep(image)
    data = _validated_jpeg_data(_encoded_jpeg(bitmap, profile))
    width, height = _bitmap_dimensions(bitmap)
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


def _avfoundation_asset(source: Path) -> object:
    url = Foundation.NSURL.fileURLWithPath_(str(source))
    return AVFoundation.AVURLAsset.URLAssetWithURL_options_(url, None)


def _capture_index_frame(
    destination: Path,
    generator: object,
    start_secs: float,
    second: int,
    profile: VisualIndexProfile,
) -> tuple[int, int]:
    image = _copy_frame(generator, _cm_time(start_secs + float(second)))
    if image is None:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE",
            f"the video frame at second {second} could not be decoded",
            422,
        )
    data, width, height = _jpeg_from_cg_image(image, profile)
    write_private(destination / f"frame-{second:06d}.jpg", data)
    return width, height


def _capture_frames_from_asset(
    asset: object, destination: Path, profile: VisualIndexProfile
) -> CaptureInfo:
    start_secs, duration_secs = _video_timing(asset)
    generator = _image_generator(asset, profile)
    seconds = _frame_seconds(duration_secs)
    first_size: tuple[int, int] | None = None
    for second in seconds:
        size = _capture_index_frame(destination, generator, start_secs, second, profile)
        if second == 0:
            first_size = size
    if first_size is None:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "the video frames have no usable size", 422
        )
    width, height = first_size
    return CaptureInfo(
        duration_secs=duration_secs,
        frame_count=len(seconds),
        width=width,
        height=height,
    )


def capture_frames_avfoundation(
    source: Path, destination: Path, profile: VisualIndexProfile
) -> CaptureInfo:
    """Write the pinned JPEG index using the bundled macOS media stack."""
    if not _AVFOUNDATION_AVAILABLE:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "AVFoundation is unavailable", 422
        )
    with objc.autorelease_pool():
        return _capture_frames_from_asset(_avfoundation_asset(source), destination, profile)


def _ffmpeg_candidates() -> list[Path]:
    candidates = list(_FFMPEG_CANDIDATES)
    found = shutil.which("ffmpeg")
    if found:
        candidates.insert(0, Path(found))
    return candidates


def _resolved_executable(candidate: Path) -> Path | None:
    try:
        resolved = candidate.resolve(strict=True)
    except OSError:
        return None
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        return None
    return resolved


def _has_ffmpeg_version_banner(executable: Path) -> bool:
    try:
        probe = subprocess.run(
            [str(executable), "-version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=3,
            check=False,
            umask=0o077,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return probe.returncode == 0 and probe.stdout.startswith(b"ffmpeg version ")


def _validated_ffmpeg() -> Path | None:
    """An optional local accelerator, never a runtime requirement."""
    seen: set[Path] = set()
    for candidate in _ffmpeg_candidates():
        resolved = _resolved_executable(candidate)
        if resolved is None or resolved in seen:
            continue
        seen.add(resolved)
        if _has_ffmpeg_version_banner(resolved):
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


def _ffmpeg_duration(source: Path) -> float:
    if not _AVFOUNDATION_AVAILABLE:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "AVFoundation is unavailable", 422
        )
    with objc.autorelease_pool():
        url = Foundation.NSURL.fileURLWithPath_(str(source))
        asset = AVFoundation.AVURLAsset.URLAssetWithURL_options_(url, None)
        _start_secs, duration_secs = _video_timing(asset)
    return duration_secs


def _ffmpeg_command(
    executable: Path, source: Path, output: Path, profile: VisualIndexProfile
) -> list[str]:
    fixed_filter = (
        "setpts=PTS-STARTPTS,"
        "fps=1:eof_action=pass,"
        f"scale={profile.max_dimension}:{profile.max_dimension}:"
        "force_original_aspect_ratio=decrease:flags=area"
    )
    return [
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
    ]


def _run_ffmpeg(command: list[str], timeout: float) -> None:
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.DEVNULL,
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


def _expected_ffmpeg_frames(destination: Path, seconds: range) -> None:
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


def _first_ffmpeg_frame_dimensions(first: Path) -> tuple[int, int]:
    with Image.open(first) as image:
        if image.format != "JPEG":
            raise ValueError("not JPEG")
        return image.size


def _validate_ffmpeg_frames(destination: Path, seconds: range) -> tuple[int, int]:
    try:
        width, height = _first_ffmpeg_frame_dimensions(destination / "frame-000000.jpg")
        for second in seconds:
            frame = destination / f"frame-{second:06d}.jpg"
            size = frame.stat().st_size
            if not 4 <= size <= MAX_FRAME_BYTES:
                raise ValueError("bad frame size")
            frame.chmod(0o600)
        return width, height
    except (OSError, ValueError) as exc:
        raise VisualIndexError(
            "VISUAL_INDEX_UNREADABLE", "the accelerated video frames are invalid", 422
        ) from exc


def capture_frames_ffmpeg(
    source: Path,
    destination: Path,
    profile: VisualIndexProfile,
    executable: Path,
) -> CaptureInfo:
    """Fast optional decoder; output is verified before it can be published."""
    duration_secs = _ffmpeg_duration(source)
    seconds = _frame_seconds(duration_secs)
    output = destination / "frame-%06d.jpg"
    timeout = max(30.0, min(1800.0, duration_secs * 0.1 + 10.0))
    _run_ffmpeg(_ffmpeg_command(executable, source, output, profile), timeout)
    _expected_ffmpeg_frames(destination, seconds)
    width, height = _validate_ffmpeg_frames(destination, seconds)
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
            _remove_generated_frames(destination)
    return capture_frames_avfoundation(source, destination, profile)


def _valid_staged_video_value(value: Any) -> bool:
    return isinstance(value, str) and bool(value) and len(value) <= 4096


def _resolved_staged_path(value: str) -> tuple[Path, Path]:
    try:
        return Path(value).resolve(), Path(tempfile.gettempdir()).resolve()
    except (OSError, RuntimeError) as exc:
        raise VisualIndexError(
            "VISUAL_INDEX_BAD_REQUEST", "the staged video path was refused", 400
        ) from exc


def _is_workspace_staged_video(staged: Path, temp_root: Path) -> bool:
    return (
        staged.parent.parent == temp_root
        and staged.parent.name.startswith(_STAGED_DIR_PREFIXES)
    )


class VisualIndexStore(_VisualIndexStore):
    """Facade that keeps the module's injectable source-identity seams."""

    def __init__(
        self,
        root: Path | None = None,
        capture_frames: CaptureFrames = capture_frames,
        *,
        max_cache_bytes: int = MAX_CACHE_BYTES,
        max_indexes: int = MAX_CACHE_INDEXES,
    ) -> None:
        super().__init__(
            root,
            capture_frames,
            max_cache_bytes=max_cache_bytes,
            max_indexes=max_indexes,
            snapshot=lambda path: _snapshot(path),
            sha256_file=lambda path: _sha256_file(path),
        )

def _staged_video_path(value: Any) -> Path:
    if not _valid_staged_video_value(value):
        raise VisualIndexError(
            "VISUAL_INDEX_BAD_REQUEST", "path must name one staged video", 400
        )
    staged, temp_root = _resolved_staged_path(value)
    if not _is_workspace_staged_video(staged, temp_root):
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


__all__ = ["CACHE_ENV", "CaptureInfo", "PROFILE", "SourceChangedError", "VisualIndexError", "VisualIndexProfile", "VisualIndexStore", "capture_frame_avfoundation", "capture_frames", "capture_frames_avfoundation", "capture_frames_ffmpeg", "register_visual_index_routes"]
