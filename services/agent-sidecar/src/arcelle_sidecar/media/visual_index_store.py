"""Persistent content-addressed storage for visual indexes."""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable, Mapping

from arcelle_sidecar.media.decode import write_private
from arcelle_sidecar.media.visual_index_core import (
    MANIFEST_NAME,
    MAX_CACHE_BYTES,
    MAX_CACHE_INDEXES,
    MAX_FRAME_BYTES,
    ORPHAN_MAX_AGE_SECS,
    PROFILE,
    CaptureFrames,
    CaptureInfo,
    SourceChangedError,
    SourceSnapshot,
    VisualIndexError,
    _INDEX_ID_RE,
    _default_cache_root,
    _frame_seconds,
    _private_directory,
    _sha256_file,
    _snapshot,
)
from arcelle_sidecar.media.visual_index_manifest import (
    _directory_file_size,
    _frame_payload,
    _index_frame_dimensions,
    _is_expired_orphan,
    _is_orphan_directory,
    _manifest_details_are_valid,
    _manifest_index_size,
    _manifest_number_fields,
    _valid_frame_data,
    _valid_persisted_frame,
)


def _facade_module() -> Any:
    from arcelle_sidecar.media import visual_index

    return visual_index


class _VisualIndexStore:
    """Content-addressed persistent store for the pinned visual profile."""

    def __init__(
        self,
        root: Path | None,
        capture_frames: CaptureFrames,
        *,
        max_cache_bytes: int = MAX_CACHE_BYTES,
        max_indexes: int = MAX_CACHE_INDEXES,
        snapshot: Callable[[Path], SourceSnapshot] = _snapshot,
        sha256_file: Callable[[Path], str] = _sha256_file,
    ) -> None:
        self.root = (root or _default_cache_root()).resolve()
        self.capture_frames = capture_frames
        self.max_cache_bytes = max(1, int(max_cache_bytes))
        self.max_indexes = max(1, int(max_indexes))
        self._snapshot = snapshot
        self._sha256_file = sha256_file
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
            numbers = _manifest_number_fields(manifest)
            source = manifest["source"]
            profile = manifest["profile"]
        except (KeyError, TypeError, ValueError):
            return False
        return _manifest_details_are_valid(index_id, manifest, source, profile, numbers)

    def _complete(self, index_id: str) -> dict[str, Any] | None:
        manifest = self._manifest(index_id)
        if manifest is None:
            return None
        directory = self.root / index_id
        for second in range(int(manifest["frame_count"])):
            frame = directory / f"frame-{second:06d}.jpg"
            # Validate every persisted frame, not only the bookends.  JPEG
            # SOI/EOI catches truncation and wrong-file replacement without
            # paying for 3,400 full Pillow decodes on every sidecar restart.
            if not _valid_persisted_frame(frame):
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
            size = _manifest_index_size(directory, manifest)
            if size is not None:
                return size
        return _directory_file_size(directory)

    def _is_active_stage(self, directory: Path) -> bool:
        with self._active_lock:
            return directory in self._active_stages

    def _remove_expired_orphan(self, directory: Path, cutoff_ns: int) -> None:
        if not _is_orphan_directory(directory):
            return
        active = self._is_active_stage(directory)
        if not _is_expired_orphan(directory, cutoff_ns) or active:
            return
        shutil.rmtree(directory, ignore_errors=True)

    def _cleanup_orphans(self) -> None:
        cutoff_ns = time.time_ns() - int(ORPHAN_MAX_AGE_SECS * 1_000_000_000)
        try:
            entries = list(self.root.iterdir())
        except OSError:
            return
        for directory in entries:
            self._remove_expired_orphan(directory, cutoff_ns)

    @staticmethod
    def _is_prunable_index(directory: Path) -> bool:
        return (
            not directory.is_symlink()
            and directory.is_dir()
            and _INDEX_ID_RE.fullmatch(directory.name) is not None
        )

    def _prune_candidate(self, directory: Path) -> tuple[int, int, Path] | None:
        try:
            return directory.stat().st_mtime_ns, self._index_size(directory), directory
        except OSError:
            return None

    def _prune_candidates(self) -> list[tuple[int, int, Path]]:
        try:
            entries = list(self.root.iterdir())
        except OSError:
            return []
        candidates: list[tuple[int, int, Path]] = []
        for directory in entries:
            if not self._is_prunable_index(directory):
                continue
            candidate = self._prune_candidate(directory)
            if candidate is not None:
                candidates.append(candidate)
        return candidates

    def _is_active_index(self, index_id: str) -> bool:
        with self._active_lock:
            return self._active_ids.get(index_id, 0) > 0

    @staticmethod
    def _cache_is_within_limits(count: int, total: int, indexes: int, bytes_: int) -> bool:
        return count <= indexes and total <= bytes_

    @staticmethod
    def _candidate_total(candidates: list[tuple[int, int, Path]]) -> int:
        return sum(size for _touched, size, _directory in candidates)

    @staticmethod
    def _remove_prune_candidate(directory: Path) -> bool:
        shutil.rmtree(directory, ignore_errors=True)
        return not directory.exists()

    def _prune(self) -> None:
        """Bound this plaintext derived cache by age, bytes, and index count.

        Building/stale directories are lifecycle internals and never LRU
        candidates.  An index serving another request in this process is also
        skipped; a later successful warm/frame retries pruning.
        """
        self._cleanup_orphans()
        candidates = self._prune_candidates()
        count = len(candidates)
        total = self._candidate_total(candidates)
        for _touched, size, directory in sorted(candidates):
            if self._cache_is_within_limits(
                count, total, self.max_indexes, self.max_cache_bytes
            ):
                break
            if self._is_active_index(directory.name):
                continue
            if self._remove_prune_candidate(directory):
                count -= 1
                total -= size

    def _touch_and_prune(self, index_id: str) -> None:
        self._touch(index_id)
        self._prune()

    def _source_identity(self, source: Path) -> tuple[Path, SourceSnapshot, str, str]:
        resolved = source.resolve()
        before = self._snapshot(resolved)
        source_sha = self._sha256_file(resolved)
        if self._snapshot(resolved) != before:
            raise SourceChangedError()
        return resolved, before, source_sha, f"{source_sha}.{PROFILE.id}"

    def _reused_warm_payload(
        self, index_id: str, manifest: Mapping[str, Any]
    ) -> dict[str, Any]:
        payload = self._warm_payload(manifest, reused=True)
        self._touch_and_prune(index_id)
        return payload

    def _new_build_stage(self) -> Path:
        stage = self.root / f".building-{uuid.uuid4().hex}"
        _private_directory(stage)
        with self._active_lock:
            self._active_stages.add(stage)
        return stage

    def _stage_frame_total(self, stage: Path, seconds: range) -> int:
        total_bytes = 0
        for second in seconds:
            frame = stage / f"frame-{second:06d}.jpg"
            if not frame.is_file() or not 0 < frame.stat().st_size <= MAX_FRAME_BYTES:
                raise VisualIndexError(
                    "VISUAL_INDEX_FAILED",
                    f"the visual index is missing frame {second}",
                    500,
                )
            total_bytes += frame.stat().st_size
        return total_bytes

    def _source_is_unchanged(
        self, source: Path, before: SourceSnapshot, source_sha: str
    ) -> None:
        after = self._snapshot(source)
        if after != before or self._sha256_file(source) != source_sha:
            raise SourceChangedError()

    @staticmethod
    def _build_manifest(
        index_id: str,
        source_sha: str,
        before: SourceSnapshot,
        info: CaptureInfo,
        total_bytes: int,
    ) -> dict[str, Any]:
        return {
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

    @staticmethod
    def _write_manifest(stage: Path, manifest: Mapping[str, Any]) -> None:
        manifest_bytes = json.dumps(
            manifest, ensure_ascii=True, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        manifest_temp = stage / f"{MANIFEST_NAME}.tmp"
        write_private(manifest_temp, manifest_bytes)
        os.replace(manifest_temp, stage / MANIFEST_NAME)

    def _capture_manifest(
        self,
        source: Path,
        stage: Path,
        before: SourceSnapshot,
        source_sha: str,
        index_id: str,
    ) -> dict[str, Any]:
        info = self.capture_frames(source, stage, PROFILE)
        expected_seconds = _frame_seconds(info.duration_secs)
        if info.frame_count != len(expected_seconds):
            raise VisualIndexError(
                "VISUAL_INDEX_FAILED",
                "the visual index frame count is inconsistent",
                500,
            )
        total_bytes = self._stage_frame_total(stage, expected_seconds)
        # Hash again after the long capture.  Stat fingerprints catch most races
        # cheaply; the second digest catches a same-size rewrite with restored
        # timestamps too.  A mixed-source index is never published.
        self._source_is_unchanged(source, before, source_sha)
        manifest = self._build_manifest(index_id, source_sha, before, info, total_bytes)
        self._write_manifest(stage, manifest)
        return manifest

    @staticmethod
    def _replace_stale_index(stage: Path, final: Path, stale: Path) -> None:
        os.replace(final, stale)
        try:
            os.replace(stage, final)
        finally:
            shutil.rmtree(stale, ignore_errors=True)

    def _publish_stage(
        self, stage: Path, index_id: str, manifest: dict[str, Any]
    ) -> dict[str, Any]:
        # Another simultaneous warm may have won while this captured.
        complete = self._complete(index_id)
        if complete is not None:
            return self._reused_warm_payload(index_id, complete)
        final = self.root / index_id
        if final.exists():
            stale = self.root / f".stale-{uuid.uuid4().hex}"
            self._replace_stale_index(stage, final, stale)
        else:
            os.replace(stage, final)
        payload = self._warm_payload(manifest, reused=False)
        self._touch_and_prune(index_id)
        return payload

    def _discard_build_stage(self, stage: Path) -> None:
        with self._active_lock:
            self._active_stages.discard(stage)
        shutil.rmtree(stage, ignore_errors=True)

    def _build_warm_index(
        self,
        source: Path,
        before: SourceSnapshot,
        source_sha: str,
        index_id: str,
    ) -> dict[str, Any]:
        stage = self._new_build_stage()
        try:
            manifest = self._capture_manifest(source, stage, before, source_sha, index_id)
            return self._publish_stage(stage, index_id, manifest)
        except VisualIndexError:
            raise
        except (OSError, RuntimeError, ValueError) as exc:
            raise VisualIndexError(
                "VISUAL_INDEX_FAILED", "the visual index could not be built", 500
            ) from exc
        finally:
            self._discard_build_stage(stage)

    def warm(self, source: Path) -> dict[str, Any]:
        source, before, source_sha, index_id = self._source_identity(source)
        _private_directory(self.root)
        with self._active(index_id):
            complete = self._complete(index_id)
            if complete is not None:
                return self._reused_warm_payload(index_id, complete)
            return self._build_warm_index(source, before, source_sha, index_id)

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
        requested_second = _facade_module()._requested_second(requested_second)
        directory = self._index_dir(index_id)
        with self._active(index_id):
            manifest = self._manifest(index_id)
            if manifest is None:
                raise VisualIndexError(
                    "VISUAL_INDEX_NOT_FOUND", "the visual index was not found", 404
                )
            resolved_second = min(requested_second, int(manifest["last_second"]))
            frame_path = directory / f"frame-{resolved_second:06d}.jpg"
            data = _facade_module()._read_index_frame(frame_path)
            if not _valid_frame_data(data):
                raise VisualIndexError(
                    "VISUAL_INDEX_FRAME_NOT_FOUND", "the indexed video frame is invalid", 404
                )
            width, height = _index_frame_dimensions(frame_path)
            payload = _frame_payload(
                index_id, requested_second, resolved_second, data, width, height
            )
            self._touch_and_prune(index_id)
            return payload
