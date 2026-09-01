"""Pure timing coverage for visual-index capture, with no media runtime."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest

from arcelle_sidecar.media import visual_index as visual_index_mod


@dataclass(frozen=True)
class FakeCMTime:
    flags: int
    value: float
    timescale: int


@dataclass(frozen=True)
class FakeTimeRange:
    start: FakeCMTime
    duration: FakeCMTime


class FakeTrack:
    def __init__(self, time_range: FakeTimeRange) -> None:
        self._time_range = time_range

    def timeRange(self) -> FakeTimeRange:
        return self._time_range


class FakeAsset:
    def __init__(self, tracks: list[FakeTrack]) -> None:
        self._tracks = tracks
        self.requests: list[object] = []

    def tracksWithMediaType_(self, media_type: object) -> list[FakeTrack]:
        self.requests.append(media_type)
        return self._tracks


class FakeFramePath:
    def __init__(self, name: str, *, symlink: bool = False, unlink_error: bool = False) -> None:
        self.name = name
        self._symlink = symlink
        self._unlink_error = unlink_error
        self.symlink_checks = 0
        self.unlink_calls = 0

    def is_symlink(self) -> bool:
        self.symlink_checks += 1
        return self._symlink

    def unlink(self) -> None:
        self.unlink_calls += 1
        if self._unlink_error:
            raise OSError("fabricated unlink failure")


class FakeFrameDirectory:
    def __init__(self, entries: list[FakeFramePath], *, iterdir_error: bool = False) -> None:
        self._entries = entries
        self._iterdir_error = iterdir_error
        self.iterdir_calls = 0

    def iterdir(self) -> list[FakeFramePath]:
        self.iterdir_calls += 1
        if self._iterdir_error:
            raise OSError("fabricated directory failure")
        return self._entries


class FakeSizedPath:
    def __init__(
        self,
        *,
        is_file: bool,
        symlink: bool = False,
        size: int = 0,
        stat_error: bool = False,
    ) -> None:
        self._is_file = is_file
        self._symlink = symlink
        self._size = size
        self._stat_error = stat_error
        self.file_checks = 0
        self.symlink_checks = 0
        self.stat_calls = 0

    def is_file(self) -> bool:
        self.file_checks += 1
        return self._is_file

    def is_symlink(self) -> bool:
        self.symlink_checks += 1
        return self._symlink

    def stat(self) -> SimpleNamespace:
        self.stat_calls += 1
        if self._stat_error:
            raise OSError("fabricated stat failure")
        return SimpleNamespace(st_size=self._size)


class FakeSizedDirectory:
    def __init__(self, entries: list[FakeSizedPath], *, iterdir_error: bool = False) -> None:
        self._entries = entries
        self._iterdir_error = iterdir_error
        self.iterdir_calls = 0

    def iterdir(self) -> list[FakeSizedPath]:
        self.iterdir_calls += 1
        if self._iterdir_error:
            raise OSError("fabricated directory listing failure")
        return self._entries


class FakeAutoreleasePool:
    def __init__(self) -> None:
        self.entries = 0
        self.exits: list[type[BaseException] | None] = []

    def __enter__(self) -> "FakeAutoreleasePool":
        self.entries += 1
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        _exc: BaseException | None,
        _traceback: object,
    ) -> bool:
        self.exits.append(exc_type)
        return False


def fake_capture_runtime(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    pool = FakeAutoreleasePool()
    asset = object()
    generator = object()
    image = object()
    urls: list[str] = []
    asset_calls: list[tuple[object, object]] = []
    times: list[float] = []
    copy_calls: list[tuple[object, object]] = []

    def file_url(path: str) -> object:
        urls.append(path)
        return "fake-url"

    def make_asset(url: object, options: object) -> object:
        asset_calls.append((url, options))
        return asset

    def copy_frame(actual_generator: object, at: object) -> object:
        copy_calls.append((actual_generator, at))
        return image

    monkeypatch.setattr(visual_index_mod, "_AVFOUNDATION_AVAILABLE", True)
    monkeypatch.setattr(
        visual_index_mod,
        "objc",
        SimpleNamespace(autorelease_pool=lambda: pool),
        raising=False,
    )
    monkeypatch.setattr(
        visual_index_mod,
        "Foundation",
        SimpleNamespace(NSURL=SimpleNamespace(fileURLWithPath_=file_url)),
        raising=False,
    )
    monkeypatch.setattr(
        visual_index_mod,
        "AVFoundation",
        SimpleNamespace(
            AVURLAsset=SimpleNamespace(URLAssetWithURL_options_=make_asset),
        ),
        raising=False,
    )
    monkeypatch.setattr(visual_index_mod, "_video_timing", lambda actual: (1.25, 3.2))
    monkeypatch.setattr(
        visual_index_mod, "_image_generator", lambda actual, _profile: generator
    )
    monkeypatch.setattr(
        visual_index_mod,
        "_cm_time",
        lambda seconds: times.append(seconds) or f"time:{seconds}",
    )
    monkeypatch.setattr(visual_index_mod, "_copy_frame", copy_frame)
    return {
        "asset": asset,
        "asset_calls": asset_calls,
        "copy_calls": copy_calls,
        "generator": generator,
        "image": image,
        "pool": pool,
        "times": times,
        "urls": urls,
    }


@pytest.fixture
def valid_flag(monkeypatch: pytest.MonkeyPatch) -> int:
    flag = 8
    monkeypatch.setattr(
        visual_index_mod,
        "CM",
        SimpleNamespace(kCMTimeFlags_Valid=flag),
        raising=False,
    )
    monkeypatch.setattr(
        visual_index_mod,
        "AVFoundation",
        SimpleNamespace(AVMediaTypeVideo="fake-video"),
        raising=False,
    )
    return flag


def test_capture_frame_avfoundation_uses_only_fake_framework_objects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = fake_capture_runtime(monkeypatch)
    encoded: list[tuple[object, object]] = []
    images: list[object] = []

    class FakeBitmap:
        def representationUsingType_properties_(
            self, image_type: object, properties: object
        ) -> bytes:
            encoded.append((image_type, properties))
            return b"fabricated-jpeg"

        def pixelsWide(self) -> int:
            return 640

        def pixelsHigh(self) -> int:
            return 360

    bitmap = FakeBitmap()

    class FakeBitmapImageRep:
        @staticmethod
        def alloc() -> "FakeBitmapImageRep":
            return FakeBitmapImageRep()

        def initWithCGImage_(self, image: object) -> FakeBitmap:
            images.append(image)
            return bitmap

    monkeypatch.setattr(
        visual_index_mod,
        "AppKit",
        SimpleNamespace(
            NSBitmapImageRep=FakeBitmapImageRep,
            NSBitmapImageFileTypeJPEG="fake-jpeg-type",
            NSImageCompressionFactor="fake-quality-key",
        ),
        raising=False,
    )

    result = visual_index_mod.capture_frame_avfoundation(Path("/fake/video.mp4"), 99)

    assert result == {
        "requested_second": 99,
        "resolved_second": 3,
        "actual_second": 3,
        "mime": "image/jpeg",
        "image_b64": "ZmFicmljYXRlZC1qcGVn",
        "sha256": "e1dc398da9c0130bfaa5c1540d34cdf6ea6c314539dd0229be5196afe0e307b3",
        "byte_size": 15,
        "width": 640,
        "height": 360,
        "duration_secs": 3.2,
    }
    assert runtime["urls"] == ["/fake/video.mp4"]
    assert runtime["asset_calls"] == [("fake-url", None)]
    assert runtime["times"] == [4.25]
    assert runtime["copy_calls"] == [(runtime["generator"], "time:4.25")]
    assert images == [runtime["image"]]
    assert encoded == [("fake-jpeg-type", {"fake-quality-key": 0.42})]
    pool = runtime["pool"]
    assert isinstance(pool, FakeAutoreleasePool)
    assert pool.entries == 1
    assert pool.exits == [None]


def test_capture_frame_avfoundation_finalizes_the_fake_pool_after_decode_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = fake_capture_runtime(monkeypatch)
    monkeypatch.setattr(visual_index_mod, "_copy_frame", lambda _generator, _time: None)

    with pytest.raises(
        visual_index_mod.VisualIndexError,
        match="frame at second 2 could not be decoded",
    ):
        visual_index_mod.capture_frame_avfoundation(Path("/fake/video.mp4"), 2)

    pool = runtime["pool"]
    assert isinstance(pool, FakeAutoreleasePool)
    assert pool.entries == 1
    assert pool.exits == [visual_index_mod.VisualIndexError]


def test_remove_generated_frames_deletes_only_regular_generated_jpegs() -> None:
    removable = FakeFramePath("frame-000001.jpg")
    failed_unlink = FakeFramePath("frame-000002.jpg", unlink_error=True)
    symlink = FakeFramePath("frame-000003.jpg", symlink=True)
    unrelated = FakeFramePath("preview.jpg")
    malformed = FakeFramePath("frame-3.jpg")
    directory = FakeFrameDirectory(
        [removable, failed_unlink, symlink, unrelated, malformed]
    )

    visual_index_mod._remove_generated_frames(directory)  # type: ignore[arg-type]

    assert directory.iterdir_calls == 1
    assert removable.unlink_calls == 1
    assert failed_unlink.unlink_calls == 1
    assert symlink.unlink_calls == 0
    assert unrelated.unlink_calls == 0
    assert malformed.unlink_calls == 0
    assert symlink.symlink_checks == 1
    assert unrelated.symlink_checks == 0
    assert malformed.symlink_checks == 0


def test_remove_generated_frames_tolerates_a_fake_directory_listing_failure() -> None:
    directory = FakeFrameDirectory([], iterdir_error=True)

    visual_index_mod._remove_generated_frames(directory)  # type: ignore[arg-type]

    assert directory.iterdir_calls == 1


def test_directory_file_size_counts_only_regular_non_symlink_fake_files() -> None:
    first = FakeSizedPath(is_file=True, size=12)
    second = FakeSizedPath(is_file=True, size=7)
    symlink = FakeSizedPath(is_file=True, symlink=True, size=99)
    nested_directory = FakeSizedPath(is_file=False, size=101)
    directory = FakeSizedDirectory([first, second, symlink, nested_directory])

    assert visual_index_mod._directory_file_size(directory) == 19  # type: ignore[arg-type]

    assert directory.iterdir_calls == 1
    assert first.stat_calls == 1
    assert second.stat_calls == 1
    assert symlink.stat_calls == 0
    assert nested_directory.stat_calls == 0
    assert symlink.symlink_checks == 1
    assert nested_directory.symlink_checks == 0


def test_directory_file_size_returns_zero_for_fake_listing_or_stat_errors() -> None:
    listing_failure = FakeSizedDirectory([], iterdir_error=True)
    stat_failure = FakeSizedPath(is_file=True, stat_error=True)
    directory = FakeSizedDirectory([FakeSizedPath(is_file=True, size=12), stat_failure])

    assert visual_index_mod._directory_file_size(listing_failure) == 0  # type: ignore[arg-type]
    assert visual_index_mod._directory_file_size(directory) == 0  # type: ignore[arg-type]
    assert stat_failure.stat_calls == 1


def test_seconds_of_accepts_only_finite_valid_nonnegative_times(valid_flag: int) -> None:
    assert visual_index_mod._seconds_of(FakeCMTime(valid_flag, 45, 2)) == 22.5
    assert visual_index_mod._seconds_of(FakeCMTime(0, 45, 2)) is None
    assert visual_index_mod._seconds_of(FakeCMTime(valid_flag, 45, 0)) is None
    assert visual_index_mod._seconds_of(FakeCMTime(valid_flag, -1, 2)) is None
    assert visual_index_mod._seconds_of(FakeCMTime(valid_flag, float("inf"), 1)) is None
    assert visual_index_mod._seconds_of(FakeCMTime(valid_flag, float("nan"), 1)) is None


def test_video_timing_uses_the_first_fake_video_track(valid_flag: int) -> None:
    asset = FakeAsset(
        [
            FakeTrack(
                FakeTimeRange(
                    start=FakeCMTime(valid_flag, 3, 2),
                    duration=FakeCMTime(valid_flag, 9, 2),
                )
            )
        ]
    )

    assert visual_index_mod._video_timing(asset) == (1.5, 4.5)
    assert asset.requests == ["fake-video"]


@pytest.mark.parametrize(
    ("start", "duration"),
    [
        (FakeCMTime(0, 0, 1), FakeCMTime(8, 2, 1)),
        (FakeCMTime(8, 0, 1), FakeCMTime(0, 2, 1)),
        (FakeCMTime(8, 0, 1), FakeCMTime(8, 0, 1)),
    ],
)
def test_video_timing_refuses_missing_or_unusable_fake_tracks(
    valid_flag: int,
    start: FakeCMTime,
    duration: FakeCMTime,
) -> None:
    no_tracks = FakeAsset([])
    with pytest.raises(visual_index_mod.VisualIndexError, match="no readable video track"):
        visual_index_mod._video_timing(no_tracks)

    asset = FakeAsset([FakeTrack(FakeTimeRange(start=start, duration=duration))])
    with pytest.raises(visual_index_mod.VisualIndexError, match="no usable duration"):
        visual_index_mod._video_timing(asset)
    assert asset.requests == ["fake-video"]


def test_capture_frames_from_asset_uses_fake_timing_and_first_frame_dimensions(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    generator = object()
    calls: list[tuple[object, float, int, object]] = []
    monkeypatch.setattr(visual_index_mod, "_video_timing", lambda _asset: (1.25, 2.01))
    monkeypatch.setattr(
        visual_index_mod, "_image_generator", lambda _asset, _profile: generator
    )

    def capture(destination, actual_generator, start, second, profile):
        calls.append((actual_generator, start, second, profile))
        assert destination == tmp_path / "fake-frames"
        return (320 + second, 180 + second)

    monkeypatch.setattr(visual_index_mod, "_capture_index_frame", capture)
    info = visual_index_mod._capture_frames_from_asset(
        object(), tmp_path / "fake-frames", visual_index_mod.PROFILE
    )

    assert info == visual_index_mod.CaptureInfo(
        duration_secs=2.01, frame_count=3, width=320, height=180
    )
    assert calls == [
        (generator, 1.25, 0, visual_index_mod.PROFILE),
        (generator, 1.25, 1, visual_index_mod.PROFILE),
        (generator, 1.25, 2, visual_index_mod.PROFILE),
    ]


def test_capture_frames_from_asset_names_an_empty_fake_timeline(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(visual_index_mod, "_video_timing", lambda _asset: (0.0, 1.0))
    monkeypatch.setattr(visual_index_mod, "_image_generator", lambda _asset, _profile: object())
    monkeypatch.setattr(visual_index_mod, "_frame_seconds", lambda _duration: ())

    with pytest.raises(visual_index_mod.VisualIndexError, match="frames have no usable size"):
        visual_index_mod._capture_frames_from_asset(
            object(), tmp_path / "fake-frames", visual_index_mod.PROFILE
        )
