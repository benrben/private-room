"""Fake-only branch coverage for the round-1 visual-index shard."""

from __future__ import annotations

from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import pytest

from arcelle_sidecar.media import visual_index as visual


def _raise(error: BaseException):
    raise error


def _bare_store() -> visual.VisualIndexStore:
    store = visual.VisualIndexStore.__new__(visual.VisualIndexStore)
    store.root = Path("/fabricated/cache")
    store._active_lock = visual.threading.Lock()
    store._active_ids = {}
    store._active_stages = set()
    return store


def test_snapshot_maps_missing_and_non_regular_fake_paths() -> None:
    missing = SimpleNamespace(stat=lambda: _raise(OSError("fabricated missing")))
    with pytest.raises(visual.VisualIndexError, match="staged video is missing"):
        visual._snapshot(missing)

    empty = SimpleNamespace(
        stat=lambda: SimpleNamespace(st_size=0),
        is_file=lambda: True,
    )
    with pytest.raises(visual.VisualIndexError, match="non-empty regular file"):
        visual._snapshot(empty)


def test_sha256_maps_a_fabricated_open_failure() -> None:
    path = SimpleNamespace(open=lambda _mode: _raise(OSError("fabricated unreadable")))
    with pytest.raises(visual.VisualIndexError, match="could not be read"):
        visual._sha256_file(path)


def test_private_directory_keeps_a_chmod_refusal_nonfatal() -> None:
    calls: list[tuple[object, ...]] = []

    class FakeDirectory:
        def mkdir(self, **kwargs: object) -> None:
            calls.append(("mkdir", kwargs))

        def chmod(self, mode: int) -> None:
            calls.append(("chmod", mode))
            raise OSError("fabricated chmod refusal")

    visual._private_directory(FakeDirectory())
    assert calls == [
        ("mkdir", {"parents": True, "exist_ok": True, "mode": 0o700}),
        ("chmod", 0o700),
    ]


def test_cm_time_rounds_through_a_fabricated_core_media_factory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, int]] = []
    monkeypatch.setattr(
        visual,
        "CM",
        SimpleNamespace(
            kCMTimeFlags_Valid=8,
            CMTime=lambda **kwargs: calls.append(kwargs) or "fabricated-time",
        ),
        raising=False,
    )
    assert visual._cm_time(1.234) == "fabricated-time"
    assert calls == [{"value": 740, "timescale": 600, "flags": 8, "epoch": 0}]


def test_copy_frame_retries_with_half_second_tolerance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(visual, "_cm_time", lambda seconds: seconds)

    class FakeGenerator:
        def __init__(self) -> None:
            self.before: list[float] = []
            self.after: list[float] = []
            self.images = [None, "fabricated-image"]

        def setRequestedTimeToleranceBefore_(self, value: float) -> None:
            self.before.append(value)

        def setRequestedTimeToleranceAfter_(self, value: float) -> None:
            self.after.append(value)

        def copyCGImageAtTime_actualTime_error_(
            self, _at: object, _actual: object, _error: object
        ) -> tuple[object | None, None]:
            return self.images.pop(0), None

    generator = FakeGenerator()
    assert visual._copy_frame(generator, "requested-time") == "fabricated-image"
    assert generator.before == [0.0, 0.5]
    assert generator.after == [0.0, 0.5]


def test_copy_frame_returns_the_exact_first_fake_image(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(visual, "_cm_time", lambda seconds: seconds)
    generator = SimpleNamespace(
        setRequestedTimeToleranceBefore_=lambda value: None,
        setRequestedTimeToleranceAfter_=lambda value: None,
        copyCGImageAtTime_actualTime_error_=lambda at, actual, error: ("image", None),
    )
    assert visual._copy_frame(generator, "requested-time") == "image"


def test_image_generator_applies_the_pinned_fake_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, object]] = []
    generator = SimpleNamespace(
        setAppliesPreferredTrackTransform_=lambda value: calls.append(("transform", value)),
        setMaximumSize_=lambda value: calls.append(("size", value)),
    )
    allocated = SimpleNamespace(initWithAsset_=lambda asset: calls.append(("asset", asset)) or generator)
    monkeypatch.setattr(
        visual,
        "AVFoundation",
        SimpleNamespace(AVAssetImageGenerator=SimpleNamespace(alloc=lambda: allocated)),
        raising=False,
    )
    assert visual._image_generator("asset", visual.PROFILE) is generator
    assert calls == [
        ("asset", "asset"),
        ("transform", True),
        ("size", (visual.PROFILE.max_dimension, visual.PROFILE.max_dimension)),
    ]


def test_bitmap_and_jpeg_validation_preserve_fake_encoding_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bitmap_factory = SimpleNamespace(
        alloc=lambda: SimpleNamespace(initWithCGImage_=lambda image: None)
    )
    monkeypatch.setattr(
        visual,
        "AppKit",
        SimpleNamespace(
            NSBitmapImageRep=bitmap_factory,
            NSBitmapImageFileTypeJPEG="jpeg",
            NSImageCompressionFactor="quality",
        ),
        raising=False,
    )
    with pytest.raises(visual.VisualIndexError, match="could not be encoded"):
        visual._bitmap_image_rep("image")

    bitmap = SimpleNamespace(representationUsingType_properties_=lambda kind, props: None)
    with pytest.raises(visual.VisualIndexError, match="could not be encoded"):
        visual._encoded_jpeg(bitmap, visual.PROFILE)
    with pytest.raises(visual.VisualIndexError, match="invalid size"):
        visual._validated_jpeg_data(b"")
    with pytest.raises(visual.VisualIndexError, match="no usable size"):
        visual._bitmap_dimensions(
            SimpleNamespace(pixelsWide=lambda: 0, pixelsHigh=lambda: 10)
        )


def test_avfoundation_unavailability_is_explicit_for_both_capture_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(visual, "_AVFOUNDATION_AVAILABLE", False)
    with pytest.raises(visual.VisualIndexError, match="AVFoundation is unavailable"):
        visual.capture_frame_avfoundation(Path("/fabricated/video.mp4"), 0)
    with pytest.raises(visual.VisualIndexError, match="AVFoundation is unavailable"):
        visual.capture_frames_avfoundation(
            Path("/fabricated/video.mp4"), Path("/fabricated/frames"), visual.PROFILE
        )


def test_avfoundation_asset_uses_only_fabricated_framework_objects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[object, ...]] = []
    monkeypatch.setattr(
        visual,
        "Foundation",
        SimpleNamespace(
            NSURL=SimpleNamespace(
                fileURLWithPath_=lambda path: calls.append(("url", path)) or "url"
            )
        ),
        raising=False,
    )
    monkeypatch.setattr(
        visual,
        "AVFoundation",
        SimpleNamespace(
            AVURLAsset=SimpleNamespace(
                URLAssetWithURL_options_=lambda url, options: calls.append(
                    ("asset", url, options)
                )
                or "asset"
            )
        ),
        raising=False,
    )
    assert visual._avfoundation_asset(Path("/fabricated/video.mp4")) == "asset"
    assert calls == [("url", "/fabricated/video.mp4"), ("asset", "url", None)]


def test_capture_index_frame_writes_only_fabricated_encoded_bytes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    writes: list[tuple[Path, bytes]] = []
    monkeypatch.setattr(visual, "_cm_time", lambda seconds: f"time:{seconds}")
    monkeypatch.setattr(visual, "_copy_frame", lambda generator, at: "image")
    monkeypatch.setattr(
        visual, "_jpeg_from_cg_image", lambda image, profile: (b"jpeg", 64, 36)
    )
    monkeypatch.setattr(
        visual, "write_private", lambda path, data: writes.append((path, data))
    )
    assert visual._capture_index_frame(
        Path("/fabricated/frames"), "generator", 1.25, 2, visual.PROFILE
    ) == (64, 36)
    assert writes == [(Path("/fabricated/frames/frame-000002.jpg"), b"jpeg")]


def test_capture_index_frame_preserves_a_fake_decode_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(visual, "_cm_time", lambda seconds: seconds)
    monkeypatch.setattr(visual, "_copy_frame", lambda generator, at: None)
    with pytest.raises(visual.VisualIndexError, match="second 3 could not be decoded"):
        visual._capture_index_frame(
            Path("/fabricated/frames"), "generator", 0.0, 3, visual.PROFILE
        )


def test_capture_frames_uses_a_fabricated_asset_inside_the_pool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expected = visual.CaptureInfo(1.0, 1, 64, 36)
    monkeypatch.setattr(visual, "_AVFOUNDATION_AVAILABLE", True)
    monkeypatch.setattr(
        visual, "objc", SimpleNamespace(autorelease_pool=nullcontext), raising=False
    )
    monkeypatch.setattr(visual, "_avfoundation_asset", lambda source: "asset")
    monkeypatch.setattr(
        visual,
        "_capture_frames_from_asset",
        lambda asset, destination, profile: expected,
    )
    assert visual.capture_frames_avfoundation(
        Path("/fabricated/video.mp4"), Path("/fabricated/frames"), visual.PROFILE
    ) == expected


def test_fake_path_failures_map_to_stable_frame_and_manifest_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    unreadable = SimpleNamespace(
        open=lambda mode: _raise(OSError("fabricated open failure")),
        read_bytes=lambda: _raise(OSError("fabricated read failure")),
        stat=lambda: _raise(OSError("fabricated stat failure")),
    )
    assert not visual._has_jpeg_markers(unreadable)
    assert not visual._is_expired_orphan(unreadable, 1)
    with pytest.raises(visual.VisualIndexError, match="frame was not found"):
        visual._read_index_frame(unreadable)

    class FakeManifestDirectory:
        def __truediv__(self, _name: str) -> object:
            return SimpleNamespace(stat=lambda: SimpleNamespace(st_size=9))

    assert visual._manifest_index_size(
        FakeManifestDirectory(), {"total_bytes": "not-a-number"}
    ) is None

    class FakeImage:
        format = "PNG"
        size = (64, 36)

        def __enter__(self) -> "FakeImage":
            return self

        def __exit__(self, *_args: object) -> None:
            return None

    monkeypatch.setattr(visual.Image, "open", lambda path: FakeImage())
    with pytest.raises(visual.VisualIndexError, match="frame is invalid"):
        visual._index_frame_dimensions(Path("/fabricated/frame.jpg"))


def test_resolved_stage_path_maps_a_fabricated_resolution_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(visual, "Path", lambda value: _raise(RuntimeError("refused")))
    with pytest.raises(visual.VisualIndexError, match="path was refused"):
        visual._resolved_staged_path("fabricated")


def test_active_index_reference_count_survives_nested_fake_requests() -> None:
    store = _bare_store()
    with store._active("index"):
        with store._active("index"):
            assert store._active_ids == {"index": 2}
        assert store._active_ids == {"index": 1}
    assert store._active_ids == {}


def test_manifest_rejects_oversized_and_invalid_fabricated_data(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _bare_store()

    class FakeDirectory:
        def __init__(self, raw: bytes) -> None:
            self.raw = raw

        def __truediv__(self, _name: str) -> object:
            return SimpleNamespace(read_bytes=lambda: self.raw)

    monkeypatch.setattr(store, "_index_dir", lambda index_id: FakeDirectory(b"x" * 70_000))
    assert store._manifest("index") is None
    monkeypatch.setattr(store, "_index_dir", lambda index_id: FakeDirectory(b"{}"))
    assert store._manifest("index") is None


def test_store_cleanup_and_touch_ignore_fabricated_filesystem_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _bare_store()
    monkeypatch.setattr(
        visual.os, "utime", lambda *args, **kwargs: _raise(OSError("touch failed"))
    )
    store._touch("index")

    store.root = SimpleNamespace(
        iterdir=lambda: _raise(OSError("listing failed"))
    )
    store._cleanup_orphans()


def test_frame_rejects_empty_fabricated_frame_data(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _bare_store()
    monkeypatch.setattr(store, "_index_dir", lambda index_id: Path("/fabricated/index"))
    monkeypatch.setattr(store, "_manifest", lambda index_id: {"last_second": 0})
    monkeypatch.setattr(visual, "_read_index_frame", lambda path: b"")
    with pytest.raises(visual.VisualIndexError, match="frame is invalid"):
        store.frame("index", 0)


def test_staged_video_rejects_a_non_string_before_any_path_access() -> None:
    with pytest.raises(visual.VisualIndexError, match="path must name one staged video"):
        visual._staged_video_path(None)
