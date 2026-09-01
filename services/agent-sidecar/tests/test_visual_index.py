"""Regression tests for the local video visual-index cache."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import tempfile
import time
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from typing import Callable

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from arcelle_sidecar.media import visual_index as visual_index_mod
from arcelle_sidecar.media.decode import write_private
from arcelle_sidecar.media.visual_index import (
    CACHE_ENV,
    PROFILE,
    CaptureInfo,
    SourceChangedError,
    VisualIndexError,
    VisualIndexStore,
    _frame_seconds,
)
from arcelle_sidecar.server import create_app


class FakeCapture:
    def __init__(self, duration: float = 2.25, on_capture: Callable[[Path], None] | None = None):
        self.duration = duration
        self.on_capture = on_capture
        self.calls = 0

    def __call__(self, source: Path, destination: Path, _profile: object) -> CaptureInfo:
        self.calls += 1
        if self.on_capture is not None:
            self.on_capture(source)
        seconds = _frame_seconds(self.duration)
        for second in seconds:
            image = Image.new("RGB", (64, 36), (second * 30 % 256, 40, 90))
            encoded = io.BytesIO()
            image.save(encoded, format="JPEG", quality=42)
            write_private(destination / f"frame-{second:06d}.jpg", encoded.getvalue())
        return CaptureInfo(
            duration_secs=self.duration,
            frame_count=len(seconds),
            width=64,
            height=36,
        )


def _source(tmp_path: Path, data: bytes = b"video source") -> Path:
    tmp_path.mkdir(parents=True, exist_ok=True)
    source = tmp_path / "video.mp4"
    source.write_bytes(data)
    return source


def _write_image(path: Path, image_format: str = "JPEG") -> None:
    image = Image.new("RGB", (64, 36), (30, 40, 90))
    encoded = io.BytesIO()
    image.save(encoded, format=image_format)
    write_private(path, encoded.getvalue())


def test_partial_final_second_is_addressable() -> None:
    assert list(_frame_seconds(2.0)) == [0, 1]
    assert list(_frame_seconds(2.0000001)) == [0, 1]
    assert list(_frame_seconds(2.01)) == [0, 1, 2]
    assert list(_frame_seconds(0.1)) == [0]
    with pytest.raises(VisualIndexError):
        _frame_seconds(0.0)


def test_build_is_hash_and_profile_pinned_atomic_and_private(tmp_path: Path) -> None:
    source = _source(tmp_path)
    root = tmp_path / "derived-cache"
    capture = FakeCapture(duration=2.01)
    result = VisualIndexStore(root, capture).warm(source)

    source_sha = hashlib.sha256(source.read_bytes()).hexdigest()
    expected_id = f"{source_sha}.{PROFILE.id}"
    assert result == {
        "status": "ready",
        "index_id": expected_id,
        "source_sha256": source_sha,
        "source_size": len(b"video source"),
        "duration_secs": 2.01,
        "frame_count": 3,
        "first_second": 0,
        "last_second": 2,
        "width": 64,
        "height": 36,
        "profile": {
            "id": "jpeg-320-1fps-q42-v1",
            "fps": 1,
            "max_dimension": 320,
            "jpeg_quality": 0.42,
            "mime": "image/jpeg",
        },
        "reused": False,
    }

    index_dir = root / expected_id
    assert sorted(path.name for path in index_dir.iterdir()) == [
        "frame-000000.jpg",
        "frame-000001.jpg",
        "frame-000002.jpg",
        "manifest.json",
    ]
    assert not list(root.glob(".building-*"))
    assert not list(root.glob(".stale-*"))
    assert os.stat(root).st_mode & 0o077 == 0
    assert os.stat(index_dir).st_mode & 0o077 == 0
    assert all(os.stat(path).st_mode & 0o077 == 0 for path in index_dir.iterdir())

    manifest = json.loads((index_dir / "manifest.json").read_text())
    assert "path" not in json.dumps(manifest).casefold()
    assert "transcript" not in json.dumps(manifest).casefold()
    assert not list(root.rglob("*.sqlite"))
    assert not list(root.rglob("*.db"))


def test_second_store_reuses_the_persistent_complete_index(tmp_path: Path) -> None:
    source = _source(tmp_path)
    root = tmp_path / "cache"
    first_capture = FakeCapture()
    first = VisualIndexStore(root, first_capture).warm(source)
    assert first_capture.calls == 1

    def must_not_capture(_source: Path, _destination: Path, _profile: object) -> CaptureInfo:
        raise AssertionError("a sidecar restart must reuse the persistent index")

    second = VisualIndexStore(root, must_not_capture).warm(source)
    assert second["index_id"] == first["index_id"]
    assert second["reused"] is True


def test_missing_middle_frame_is_rebuilt_instead_of_falsely_reused(tmp_path: Path) -> None:
    source = _source(tmp_path)
    root = tmp_path / "cache"
    first_capture = FakeCapture(duration=3.2)
    first = VisualIndexStore(root, first_capture).warm(source)
    middle = root / first["index_id"] / "frame-000001.jpg"
    middle.unlink()

    repair_capture = FakeCapture(duration=3.2)
    repaired = VisualIndexStore(root, repair_capture).warm(source)
    assert repaired["index_id"] == first["index_id"]
    assert repaired["reused"] is False
    assert repair_capture.calls == 1
    assert middle.is_file()


def test_source_content_change_invalidates_the_index_identity(tmp_path: Path) -> None:
    source = _source(tmp_path, b"first source")
    capture = FakeCapture(duration=1.0)
    store = VisualIndexStore(tmp_path / "cache", capture)
    first = store.warm(source)

    source.write_bytes(b"second source")
    second = store.warm(source)
    assert second["index_id"] != first["index_id"]
    assert second["source_sha256"] == hashlib.sha256(b"second source").hexdigest()
    assert capture.calls == 2


def test_lru_pruning_bounds_old_content_hash_indexes_and_keeps_recent(
    tmp_path: Path,
) -> None:
    root = tmp_path / "cache"
    store = VisualIndexStore(root, FakeCapture(duration=1.0), max_indexes=2)
    first = store.warm(_source(tmp_path / "one", b"one"))
    second = store.warm(_source(tmp_path / "two", b"two"))

    first_dir = root / first["index_id"]
    second_dir = root / second["index_id"]
    os.utime(first_dir, ns=(1, 1))
    os.utime(second_dir, ns=(2, 2))
    store.frame(first["index_id"], 0)  # first is now the recently used index

    third = store.warm(_source(tmp_path / "three", b"three"))
    assert first_dir.is_dir()
    assert not second_dir.exists()
    assert (root / third["index_id"]).is_dir()
    assert len([entry for entry in root.iterdir() if entry.name[0].isalnum()]) == 2


def test_manifest_validation_rejects_each_untrusted_contract_boundary() -> None:
    index_id = "a" * 64 + f".{PROFILE.id}"
    manifest = {
        "schema_version": 1,
        "index_id": index_id,
        "source": {"sha256": "a" * 64, "size": 4},
        "profile": {
            "id": PROFILE.id,
            "fps": PROFILE.fps,
            "max_dimension": PROFILE.max_dimension,
            "jpeg_quality": PROFILE.jpeg_quality,
            "mime": PROFILE.mime,
        },
        "frame_count": 1,
        "first_second": 0,
        "last_second": 0,
        "width": 1,
        "height": 1,
        "total_bytes": 4,
    }
    assert VisualIndexStore._valid_manifest(index_id, manifest)

    bad_source = {**manifest, "source": {"sha256": "b" * 64}}
    bad_timeline = {**manifest, "last_second": 1}
    bad_size = {**manifest, "total_bytes": "not-a-number"}
    assert not VisualIndexStore._valid_manifest(index_id, bad_source)
    assert not VisualIndexStore._valid_manifest(index_id, bad_timeline)
    assert not VisualIndexStore._valid_manifest(index_id, bad_size)


def test_prune_skips_active_indexes_and_ignores_unreadable_candidates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "cache"
    root.mkdir()
    first_id = "a" * 64 + f".{PROFILE.id}"
    second_id = "b" * 64 + f".{PROFILE.id}"
    first = root / first_id
    second = root / second_id
    first.mkdir()
    second.mkdir()
    (root / "not-an-index").mkdir()
    os.utime(first, ns=(1, 1))
    os.utime(second, ns=(2, 2))
    store = VisualIndexStore(root, FakeCapture(), max_indexes=1)
    with store._active(first_id):
        store._prune()
    assert first.is_dir()
    assert not second.exists()

    unreadable = root / ("c" * 64 + f".{PROFILE.id}")
    unreadable.mkdir()

    def unreadable_size(_directory: Path) -> int:
        raise OSError("unreadable index")

    monkeypatch.setattr(store, "_index_size", unreadable_size)
    assert store._prune_candidates() == []

    class UnreadableRoot:
        def iterdir(self) -> list[Path]:
            raise OSError("unreadable cache")

    store.root = UnreadableRoot()  # type: ignore[assignment]
    assert store._prune_candidates() == []


def test_crash_orphans_expire_but_an_active_build_is_protected(tmp_path: Path) -> None:
    root = tmp_path / "cache"
    root.mkdir()
    old_build = root / ".building-crashed"
    old_stale = root / ".stale-crashed"
    fresh_build = root / ".building-fresh"
    for directory in (old_build, old_stale, fresh_build):
        directory.mkdir()
        (directory / "frame-000000.jpg").write_bytes(b"derived pixels")
    old_ns = time.time_ns() - 2 * visual_index_mod.ORPHAN_MAX_AGE_SECS * 1_000_000_000
    os.utime(old_build, ns=(old_ns, old_ns))
    os.utime(old_stale, ns=(old_ns, old_ns))

    store = VisualIndexStore(root, FakeCapture())
    assert not old_build.exists()
    assert not old_stale.exists()
    assert fresh_build.is_dir()

    os.utime(fresh_build, ns=(old_ns, old_ns))
    with store._active_lock:
        store._active_stages.add(fresh_build)
    store._cleanup_orphans()
    assert fresh_build.is_dir()
    with store._active_lock:
        store._active_stages.discard(fresh_build)
    store._cleanup_orphans()
    assert not fresh_build.exists()


def test_optional_ffmpeg_is_version_checked_before_use(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    executable = tmp_path / "ffmpeg"
    executable.write_text("placeholder")
    executable.chmod(0o700)
    calls: list[list[str]] = []

    def fake_run(args: list[str], **_kwargs: object):
        calls.append(args)
        return visual_index_mod.subprocess.CompletedProcess(
            args, 0, stdout=b"ffmpeg version 7.1 test\n"
        )

    monkeypatch.setattr(visual_index_mod.shutil, "which", lambda _name: str(executable))
    monkeypatch.setattr(visual_index_mod, "_FFMPEG_CANDIDATES", ())
    monkeypatch.setattr(visual_index_mod.subprocess, "run", fake_run)
    assert visual_index_mod._validated_ffmpeg() == executable.resolve()
    assert calls == [[str(executable.resolve()), "-version"]]

    monkeypatch.setattr(
        visual_index_mod.subprocess,
        "run",
        lambda args, **_kwargs: visual_index_mod.subprocess.CompletedProcess(
            args, 0, stdout=b"not an ffmpeg executable"
        ),
    )
    assert visual_index_mod._validated_ffmpeg() is None


def test_optional_ffmpeg_skips_unusable_duplicates_and_failed_fake_probes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    missing = tmp_path / "missing"
    unusable = tmp_path / "unusable"
    unusable.write_text("placeholder")
    unusable.chmod(0o600)
    first = tmp_path / "first"
    first.write_text("placeholder")
    first.chmod(0o700)
    duplicate = tmp_path / "duplicate"
    duplicate.symlink_to(first)
    verified = tmp_path / "verified"
    verified.write_text("placeholder")
    verified.chmod(0o700)
    calls: list[str] = []

    def fake_run(args: list[str], **_kwargs: object) -> object:
        calls.append(args[0])
        if args[0] == str(first.resolve()):
            raise OSError("fake probe failure")
        return visual_index_mod.subprocess.CompletedProcess(
            args, 0, stdout=b"ffmpeg version 7.1 fake\n"
        )

    monkeypatch.setattr(visual_index_mod.shutil, "which", lambda _name: None)
    monkeypatch.setattr(
        visual_index_mod,
        "_FFMPEG_CANDIDATES",
        (missing, unusable, first, duplicate, verified),
    )
    monkeypatch.setattr(visual_index_mod.subprocess, "run", fake_run)

    assert visual_index_mod._validated_ffmpeg() == verified.resolve()
    assert calls == [str(first.resolve()), str(verified.resolve())]


def test_ffmpeg_duration_checks_avfoundation_and_reads_the_video_timing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = _source(tmp_path)
    monkeypatch.setattr(visual_index_mod, "_AVFOUNDATION_AVAILABLE", False)
    with pytest.raises(VisualIndexError, match="AVFoundation is unavailable"):
        visual_index_mod._ffmpeg_duration(source)

    seen: list[object] = []
    monkeypatch.setattr(visual_index_mod, "_AVFOUNDATION_AVAILABLE", True)
    monkeypatch.setattr(
        visual_index_mod,
        "objc",
        SimpleNamespace(autorelease_pool=nullcontext),
    )
    monkeypatch.setattr(
        visual_index_mod,
        "Foundation",
        SimpleNamespace(
            NSURL=SimpleNamespace(fileURLWithPath_=lambda path: seen.append(path) or "url")
        ),
    )
    monkeypatch.setattr(
        visual_index_mod,
        "AVFoundation",
        SimpleNamespace(
            AVURLAsset=SimpleNamespace(
                URLAssetWithURL_options_=lambda url, options: seen.append((url, options)) or "asset"
            )
        ),
    )
    monkeypatch.setattr(visual_index_mod, "_video_timing", lambda asset: (0.0, 2.25))

    assert visual_index_mod._ffmpeg_duration(source) == 2.25
    assert seen == [str(source), ("url", None)]


def test_ffmpeg_capture_builds_and_verifies_the_pinned_timeline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = _source(tmp_path)
    destination = tmp_path / "frames"
    destination.mkdir()
    calls: list[tuple[list[str], object]] = []
    monkeypatch.setattr(visual_index_mod, "_ffmpeg_duration", lambda _source: 2.25)

    def fake_run(command: list[str], **kwargs: object) -> object:
        calls.append((command, kwargs["timeout"]))
        for second in range(3):
            _write_image(destination / f"frame-{second:06d}.jpg")
        return visual_index_mod.subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(visual_index_mod.subprocess, "run", fake_run)
    info = visual_index_mod.capture_frames_ffmpeg(
        source, destination, PROFILE, tmp_path / "ffmpeg"
    )

    assert info == CaptureInfo(duration_secs=2.25, frame_count=3, width=64, height=36)
    assert calls[0][1] == 30.0
    command = calls[0][0]
    assert command[command.index("-vf") + 1] == (
        "setpts=PTS-STARTPTS,fps=1:eof_action=pass,"
        "scale=320:320:force_original_aspect_ratio=decrease:flags=area"
    )
    assert all(path.stat().st_mode & 0o077 == 0 for path in destination.iterdir())


@pytest.mark.parametrize("failure", [OSError("no decoder"), 1])
def test_ffmpeg_capture_reports_process_failures(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: object
) -> None:
    source = _source(tmp_path)
    destination = tmp_path / "frames"
    destination.mkdir()
    monkeypatch.setattr(visual_index_mod, "_ffmpeg_duration", lambda _source: 1.0)

    def fake_run(command: list[str], **_kwargs: object) -> object:
        if isinstance(failure, Exception):
            raise failure
        return visual_index_mod.subprocess.CompletedProcess(command, int(failure))

    monkeypatch.setattr(visual_index_mod.subprocess, "run", fake_run)
    with pytest.raises(VisualIndexError, match="accelerated video decode failed"):
        visual_index_mod.capture_frames_ffmpeg(source, destination, PROFILE, tmp_path / "ffmpeg")


def test_ffmpeg_capture_rejects_incomplete_or_non_jpeg_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = _source(tmp_path)
    destination = tmp_path / "frames"
    destination.mkdir()
    monkeypatch.setattr(visual_index_mod, "_ffmpeg_duration", lambda _source: 1.0)
    monkeypatch.setattr(
        visual_index_mod.subprocess,
        "run",
        lambda command, **_kwargs: visual_index_mod.subprocess.CompletedProcess(command, 0),
    )
    with pytest.raises(VisualIndexError, match="incomplete timeline"):
        visual_index_mod.capture_frames_ffmpeg(source, destination, PROFILE, tmp_path / "ffmpeg")

    _write_image(destination / "frame-000000.jpg", "PNG")
    with pytest.raises(VisualIndexError, match="video frames are invalid"):
        visual_index_mod.capture_frames_ffmpeg(source, destination, PROFILE, tmp_path / "ffmpeg")

    (destination / "frame-000000.jpg").unlink()
    _write_image(destination / "frame-000000.jpg")
    write_private(destination / "frame-000001.jpg", b"bad")
    monkeypatch.setattr(visual_index_mod, "_ffmpeg_duration", lambda _source: 2.0)
    with pytest.raises(VisualIndexError, match="video frames are invalid"):
        visual_index_mod.capture_frames_ffmpeg(source, destination, PROFILE, tmp_path / "ffmpeg")


def test_failed_optional_accelerator_cleans_partial_output_and_falls_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    destination = tmp_path / "frames"
    destination.mkdir()

    def failed_accelerator(
        _source: Path, output: Path, _profile: object, _executable: Path
    ) -> CaptureInfo:
        write_private(output / "frame-000000.jpg", b"partial")
        raise VisualIndexError("VISUAL_INDEX_UNREADABLE", "accelerator failed", 422)

    expected = CaptureInfo(duration_secs=1.0, frame_count=1, width=10, height=10)
    monkeypatch.setattr(visual_index_mod, "_validated_ffmpeg", lambda: Path("/ffmpeg"))
    monkeypatch.setattr(visual_index_mod, "capture_frames_ffmpeg", failed_accelerator)
    monkeypatch.setattr(
        visual_index_mod,
        "capture_frames_avfoundation",
        lambda _source, _output, _profile: expected,
    )
    result = visual_index_mod.capture_frames(tmp_path / "source.mp4", destination, PROFILE)
    assert result == expected
    assert not (destination / "frame-000000.jpg").exists()


def test_mutation_during_capture_is_never_published(tmp_path: Path) -> None:
    source = _source(tmp_path, b"before")

    def mutate(path: Path) -> None:
        path.write_bytes(b"after -- changed while decoding")

    root = tmp_path / "cache"
    with pytest.raises(SourceChangedError):
        VisualIndexStore(root, FakeCapture(on_capture=mutate)).warm(source)
    assert not list(root.glob("[0-9a-f]*"))
    assert not list(root.glob(".building-*"))


def test_warm_rejects_a_source_changed_before_capture(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = _source(tmp_path)
    first = visual_index_mod._snapshot(source)
    changed = visual_index_mod.SourceSnapshot(
        device=first.device,
        inode=first.inode,
        size=first.size + 1,
        mtime_ns=first.mtime_ns,
    )
    snapshots = [first, changed]
    store = VisualIndexStore(tmp_path / "cache", FakeCapture())
    monkeypatch.setattr(visual_index_mod, "_snapshot", lambda _source: snapshots.pop(0))
    monkeypatch.setattr(visual_index_mod, "_sha256_file", lambda _source: "a" * 64)

    with pytest.raises(SourceChangedError):
        store._source_identity(source)


def test_warm_rejects_inconsistent_or_missing_capture_output(tmp_path: Path) -> None:
    source = _source(tmp_path)

    def inconsistent(_source: Path, _stage: Path, _profile: object) -> CaptureInfo:
        return CaptureInfo(duration_secs=1.0, frame_count=2, width=64, height=36)

    with pytest.raises(VisualIndexError, match="frame count is inconsistent"):
        VisualIndexStore(tmp_path / "count", inconsistent).warm(source)

    def missing(_source: Path, _stage: Path, _profile: object) -> CaptureInfo:
        return CaptureInfo(duration_secs=1.0, frame_count=1, width=64, height=36)

    with pytest.raises(VisualIndexError, match="missing frame 0"):
        VisualIndexStore(tmp_path / "missing", missing).warm(source)


def test_warm_wraps_unexpected_capture_errors_and_cleans_its_stage(tmp_path: Path) -> None:
    source = _source(tmp_path)

    def broken(_source: Path, _stage: Path, _profile: object) -> CaptureInfo:
        raise RuntimeError("decoder exploded")

    root = tmp_path / "cache"
    with pytest.raises(VisualIndexError, match="could not be built") as caught:
        VisualIndexStore(root, broken).warm(source)
    assert caught.value.code == "VISUAL_INDEX_FAILED"
    assert not list(root.glob(".building-*"))


def test_publish_reuses_an_index_that_another_warm_completed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = VisualIndexStore(tmp_path / "cache", FakeCapture())
    store.root.mkdir()
    index_id = "a" * 64 + f".{PROFILE.id}"
    manifest = {
        "schema_version": 1,
        "index_id": index_id,
        "source": {"sha256": "a" * 64, "size": 4},
        "profile": {
            "id": PROFILE.id,
            "fps": PROFILE.fps,
            "max_dimension": PROFILE.max_dimension,
            "jpeg_quality": PROFILE.jpeg_quality,
            "mime": PROFILE.mime,
        },
        "duration_secs": 1.0,
        "frame_count": 1,
        "first_second": 0,
        "last_second": 0,
        "width": 64,
        "height": 36,
        "total_bytes": 4,
    }
    stage = store.root / ".building-test"
    stage.mkdir()
    monkeypatch.setattr(store, "_complete", lambda _index_id: manifest)
    monkeypatch.setattr(store, "_touch_and_prune", lambda _index_id: None)

    assert store._publish_stage(stage, index_id, manifest)["reused"] is True
    assert stage.is_dir()


def test_frame_returns_verified_jpeg_and_clamps_to_final_partial_second(
    tmp_path: Path,
) -> None:
    source = _source(tmp_path)
    store = VisualIndexStore(tmp_path / "cache", FakeCapture(duration=2.25))
    warm = store.warm(source)
    frame = store.frame(warm["index_id"], 99)

    data = base64.b64decode(frame["image_b64"], validate=True)
    assert frame["requested_second"] == 99
    assert frame["resolved_second"] == 2
    assert frame["actual_second"] == 2
    assert frame["mime"] == "image/jpeg"
    assert frame["sha256"] == hashlib.sha256(data).hexdigest()
    assert frame["byte_size"] == len(data)
    assert (frame["width"], frame["height"]) == (64, 36)


@pytest.mark.parametrize(
    ("index_id", "second"),
    [
        ("../manifest.json", 0),
        ("a" * 64 + ".other-profile", 0),
        ("a" * 64 + f".{PROFILE.id}", -1),
        ("a" * 64 + f".{PROFILE.id}", 1.5),
        ("a" * 64 + f".{PROFILE.id}", True),
        ("a" * 64 + f".{PROFILE.id}", "1"),
    ],
)
def test_frame_rejects_traversal_foreign_profiles_and_invalid_seconds(
    tmp_path: Path, index_id: str, second: object
) -> None:
    store = VisualIndexStore(tmp_path / "cache", FakeCapture())
    with pytest.raises(VisualIndexError) as caught:
        store.frame(index_id, second)  # type: ignore[arg-type]
    assert caught.value.code == "VISUAL_INDEX_BAD_REQUEST"


def test_environment_cache_root_survives_store_recreation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    configured = tmp_path / "persistent" / "visual-index-v1"
    monkeypatch.setenv(CACHE_ENV, str(configured))
    first = VisualIndexStore()
    second = VisualIndexStore()
    assert first.root == configured.resolve()
    assert second.root == configured.resolve()


def test_http_routes_accept_only_host_staged_files_and_exact_bodies(tmp_path: Path) -> None:
    store = VisualIndexStore(tmp_path / "cache", FakeCapture(duration=1.2))
    app = create_app()
    app.state.visual_index_store = store
    client = TestClient(app)

    with tempfile.TemporaryDirectory(prefix="arcelle-stt-") as staged_dir:
        staged = Path(staged_dir) / "video.mp4"
        staged.write_bytes(b"staged video")
        warm_response = client.post("/media/visual-index/warm", json={"path": str(staged)})
        assert warm_response.status_code == 200
        warm = warm_response.json()
        frame_response = client.post(
            "/media/visual-index/frame",
            json={"index_id": warm["index_id"], "second": 1},
        )
        assert frame_response.status_code == 200
        assert frame_response.json()["resolved_second"] == 1

        extra = client.post(
            "/media/visual-index/warm", json={"path": str(staged), "profile": {}}
        )
        assert extra.status_code == 400
        assert extra.json()["code"] == "VISUAL_INDEX_BAD_REQUEST"

    arbitrary = _source(tmp_path / "arbitrary")
    refused = client.post("/media/visual-index/warm", json={"path": str(arbitrary)})
    assert refused.status_code == 400
    assert refused.json()["code"] == "VISUAL_INDEX_BAD_REQUEST"

    traversal = client.post(
        "/media/visual-index/warm",
        json={"path": str(Path(tempfile.gettempdir()) / "arcelle-stt-safe" / ".." / "secret")},
    )
    assert traversal.status_code == 400
    assert traversal.json()["code"] == "VISUAL_INDEX_BAD_REQUEST"


def test_http_cold_capture_uses_the_same_staged_path_and_strict_second_boundary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = {
        "requested_second": 360,
        "resolved_second": 360,
        "actual_second": 360,
        "mime": "image/jpeg",
        "image_b64": base64.b64encode(b"jpeg").decode(),
        "sha256": hashlib.sha256(b"jpeg").hexdigest(),
        "byte_size": 4,
        "width": 320,
        "height": 180,
        "duration_secs": 3399.267,
    }
    seen: list[tuple[Path, int, object]] = []

    def fake_capture(source: Path, second: int, profile: object) -> dict[str, object]:
        seen.append((source, second, profile))
        return payload

    monkeypatch.setattr(visual_index_mod, "capture_frame_avfoundation", fake_capture)
    client = TestClient(create_app())
    with tempfile.TemporaryDirectory(prefix="arcelle-visual-index-") as staged_dir:
        staged = Path(staged_dir) / "video.mp4"
        staged.write_bytes(b"workspace video")
        response = client.post(
            "/media/visual-index/capture", json={"path": str(staged), "second": 360}
        )
        assert response.status_code == 200
        assert response.json() == payload
        assert seen == [(staged.resolve(), 360, PROFILE)]

        invalid = client.post(
            "/media/visual-index/capture", json={"path": str(staged), "second": "360"}
        )
        assert invalid.status_code == 400
        assert invalid.json()["code"] == "VISUAL_INDEX_BAD_REQUEST"

    arbitrary = _source(tmp_path / "not-staged")
    refused = client.post(
        "/media/visual-index/capture", json={"path": str(arbitrary), "second": 0}
    )
    assert refused.status_code == 400
    assert refused.json()["code"] == "VISUAL_INDEX_BAD_REQUEST"


def test_http_frame_validation_has_stable_error_codes(tmp_path: Path) -> None:
    app = create_app()
    app.state.visual_index_store = VisualIndexStore(tmp_path / "cache", FakeCapture())
    client = TestClient(app)
    valid_missing_id = "a" * 64 + f".{PROFILE.id}"

    invalid = client.post(
        "/media/visual-index/frame",
        json={"index_id": "../../private", "second": 0},
    )
    assert invalid.status_code == 400
    assert invalid.json()["code"] == "VISUAL_INDEX_BAD_REQUEST"

    missing = client.post(
        "/media/visual-index/frame",
        json={"index_id": valid_missing_id, "second": 0},
    )
    assert missing.status_code == 404
    assert missing.json()["code"] == "VISUAL_INDEX_NOT_FOUND"

    wrong_type = client.post(
        "/media/visual-index/frame",
        json={"index_id": valid_missing_id, "second": "0"},
    )
    assert wrong_type.status_code == 400
    assert wrong_type.json()["code"] == "VISUAL_INDEX_BAD_REQUEST"
