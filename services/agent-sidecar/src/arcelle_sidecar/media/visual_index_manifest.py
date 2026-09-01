"""Manifest and persisted-frame validation for visual indexes."""

from __future__ import annotations

import base64
import hashlib
import os
from dataclasses import asdict
from pathlib import Path
from typing import Any, Mapping

from PIL import Image

from .visual_index_core import MANIFEST_NAME, MAX_FRAME_BYTES, PROFILE, VisualIndexError

def _manifest_number_fields(manifest: Mapping[str, Any]) -> tuple[int, int, int, int, int, int]:
    return (
        int(manifest["frame_count"]),
        int(manifest["first_second"]),
        int(manifest["last_second"]),
        int(manifest["width"]),
        int(manifest["height"]),
        int(manifest["total_bytes"]),
    )


def _manifest_identity_matches(index_id: str, manifest: Mapping[str, Any]) -> bool:
    return manifest.get("schema_version") == 1 and manifest.get("index_id") == index_id


def _manifest_source_matches(index_id: str, source: Any) -> bool:
    return isinstance(source, dict) and source.get("sha256") == index_id.partition(".")[0]


def _manifest_profile_matches(profile: Any) -> bool:
    return isinstance(profile, dict) and profile == asdict(PROFILE)


def _manifest_timeline_is_valid(count: int, first: int, last: int) -> bool:
    return count >= 1 and first == 0 and last == count - 1


def _manifest_dimensions_are_valid(width: int, height: int, total_bytes: int) -> bool:
    return width >= 1 and height >= 1 and total_bytes >= 1


def _manifest_details_are_valid(
    index_id: str,
    manifest: Mapping[str, Any],
    source: Any,
    profile: Any,
    numbers: tuple[int, int, int, int, int, int],
) -> bool:
    count, first, last, width, height, total_bytes = numbers
    return (
        _manifest_identity_matches(index_id, manifest)
        and _manifest_source_matches(index_id, source)
        and _manifest_profile_matches(profile)
        and _manifest_timeline_is_valid(count, first, last)
        and _manifest_dimensions_are_valid(width, height, total_bytes)
    )


def _has_valid_persisted_frame_size(frame: Path) -> bool:
    try:
        size = frame.stat().st_size
    except OSError:
        return False
    return frame.is_file() and 4 <= size <= MAX_FRAME_BYTES


def _has_jpeg_markers(frame: Path) -> bool:
    try:
        with frame.open("rb") as source:
            starts_as_jpeg = source.read(2) == b"\xff\xd8"
            source.seek(-2, os.SEEK_END)
            ends_as_jpeg = source.read(2) == b"\xff\xd9"
    except OSError:
        return False
    return starts_as_jpeg and ends_as_jpeg


def _valid_persisted_frame(frame: Path) -> bool:
    return _has_valid_persisted_frame_size(frame) and _has_jpeg_markers(frame)


def _manifest_index_size(directory: Path, manifest: Mapping[str, Any]) -> int | None:
    try:
        manifest_size = (directory / MANIFEST_NAME).stat().st_size
        return max(0, int(manifest["total_bytes"])) + manifest_size
    except (KeyError, TypeError, ValueError):
        return None


def _directory_file_size(directory: Path) -> int:
    total = 0
    try:
        for item in directory.iterdir():
            if item.is_file() and not item.is_symlink():
                total += item.stat().st_size
    except OSError:
        return 0
    return total


def _is_orphan_directory(directory: Path) -> bool:
    return (
        not directory.is_symlink()
        and directory.is_dir()
        and directory.name.startswith((".building-", ".stale-"))
    )


def _is_expired_orphan(directory: Path, cutoff_ns: int) -> bool:
    try:
        return directory.stat().st_mtime_ns < cutoff_ns
    except OSError:
        return False


def _valid_frame_data(data: bytes) -> bool:
    return bool(data) and len(data) <= MAX_FRAME_BYTES


def _read_index_frame(frame_path: Path) -> bytes:
    try:
        return frame_path.read_bytes()
    except OSError as exc:
        raise VisualIndexError(
            "VISUAL_INDEX_FRAME_NOT_FOUND",
            "the indexed video frame was not found",
            404,
        ) from exc


def _index_frame_dimensions(frame_path: Path) -> tuple[int, int]:
    try:
        with Image.open(frame_path) as image:
            if image.format != "JPEG":
                raise ValueError("not JPEG")
            return image.size
    except (OSError, ValueError) as exc:
        raise VisualIndexError(
            "VISUAL_INDEX_FRAME_NOT_FOUND", "the indexed video frame is invalid", 404
        ) from exc


def _frame_payload(
    index_id: str,
    requested_second: int,
    resolved_second: int,
    data: bytes,
    width: int,
    height: int,
) -> dict[str, Any]:
    return {
        "index_id": index_id,
        "requested_second": requested_second,
        "resolved_second": resolved_second,
        "actual_second": resolved_second,
        "mime": PROFILE.mime,
        "image_b64": base64.b64encode(data).decode("ascii"),
        "sha256": hashlib.sha256(data).hexdigest(),
        "byte_size": len(data),
        "width": width,
        "height": height,
    }
