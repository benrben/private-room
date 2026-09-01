"""Tests for `arcelle_sidecar.media.probe` (port of
`src-tauri/src/media_probe.rs`).

Uses the real system video fixture every Mac ships
("/System/Library/Desktop Pictures/.wallpapers/Sonoma/Sonoma Graphic Light
Landscape.mov") and, like the Rust test's own `test_fixture` helper, trims it
to ~1s with the real `avconvert(1)`. If either the source wallpaper or
`avconvert` is missing on this machine, the fixture-dependent tests SKIP with
a clear reason rather than failing the suite — that mirrors the Rust test's
own `eprintln!("skipped: ..."); return;` behaviour exactly.

Never mocks the PyObjC/AVFoundation calls themselves: every test that reaches
`probe`/`probe_path`/`probe_bytes`/`last_frame`/`last_frame_png` exercises the
real macOS media stack. The one exception is `test_display_size_survives_a_nan_transform`,
which feeds a tiny duck-typed stand-in for an `AVAssetTrack` (returning real
`Quartz` `CGSize`/`CGAffineTransform` structs) into the pure `_display_size`
helper directly — that helper does no framework I/O of its own, and this is a
regression test for a real crash a NaN transform component reproducibly
triggers, not a stand-in for AVFoundation's own behaviour.
"""

from __future__ import annotations

import subprocess
import tempfile
import uuid
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import pytest

from arcelle_sidecar.media import probe as probe_mod

_SOURCE_FIXTURE = (
    "/System/Library/Desktop Pictures/.wallpapers/Sonoma/Sonoma Graphic Light Landscape.mov"
)
_HAS_SOURCE = Path(_SOURCE_FIXTURE).exists()
_HAS_AVCONVERT = Path("/usr/bin/avconvert").exists()
_HAS_FIXTURE_TOOLS = _HAS_SOURCE and _HAS_AVCONVERT

requires_fixture = pytest.mark.skipif(
    not _HAS_FIXTURE_TOOLS,
    reason=(
        "requires the macOS Sonoma wallpaper fixture and /usr/bin/avconvert, "
        "not present on this machine"
    ),
)


def _build_fixture(tmp_path: Path, name: str, *, duration: str = "1") -> Path | None:
    """Mirrors the Rust `test_fixture` helper: a real ~1s clip cut from the
    system wallpaper via `avconvert`, so nothing binary is checked into the
    repo. Returns None (never fails the test) if the source or the
    converter genuinely isn't present, or the conversion itself fails.
    """
    if not _HAS_FIXTURE_TOOLS:
        return None
    out = tmp_path / f"arcelle-fixture-{uuid.uuid4()}-{name}"
    args = [
        "/usr/bin/avconvert",
        "-p",
        "PresetPassthrough",
        "-s",
        _SOURCE_FIXTURE,
        "-o",
        str(out),
        "--duration",
        duration,
        "--replace",
    ]
    proc = subprocess.run(args, capture_output=True, timeout=60)
    if proc.returncode != 0 or not out.exists():
        return None
    return out


# ------------------------------------------------------------- (1) a real clip


@requires_fixture
def test_a_real_clip_reports_the_facts_it_has(tmp_path: Path) -> None:
    fixture = _build_fixture(tmp_path, "probe.mov")
    if fixture is None:
        pytest.skip("skipped: no system fixture source on this machine")

    meta = probe_mod.probe_path(str(fixture))
    assert meta is not None, "a real .mov must probe"

    assert meta.duration_secs is not None
    assert abs(meta.duration_secs - 1.0) < 0.2, f"asked for 1s, got {meta.duration_secs}"
    assert meta.width is not None and meta.height is not None
    assert meta.width >= 640 and meta.height >= 360, meta
    # The wallpaper is video-only: "no audio track" is a FINDING, not an
    # unknown, and the viewer must be able to say so.
    assert meta.has_audio is False
    assert meta.audio_codec is None
    assert meta.video_codec is not None, "a video track always names a codec"
    assert not meta.is_empty()


# ------------------------------------------------------- (2) non-media probes


def test_a_non_media_file_probes_to_nothing(tmp_path: Path) -> None:
    assert probe_mod.probe_bytes(b"this is not a video", "mp4") is None
    assert probe_mod.probe_bytes(b"", "mp4") is None
    missing = tmp_path / f"arcelle-nope-{uuid.uuid4()}.mp4"
    assert probe_mod.probe_path(str(missing)) is None
    # A zero-byte file on disk must also probe to nothing without AVFoundation
    # ever opening it (the Rust `probe_path` early-return).
    empty = tmp_path / "empty.mp4"
    empty.write_bytes(b"")
    assert probe_mod.probe_path(str(empty)) is None


def test_last_frame_also_answers_none_rather_than_raising(tmp_path: Path) -> None:
    """Same "None, never a crash" contract for the end-frame capture path."""
    assert probe_mod.last_frame_png(b"this is not a video", "mov") is None
    assert probe_mod.last_frame_png(b"", "mov") is None
    missing = tmp_path / f"arcelle-nope-{uuid.uuid4()}.mov"
    assert probe_mod.last_frame(str(missing)) is None


class _FakeEndFrameGenerator:
    def __init__(self, replies: list[object | None]) -> None:
        self.replies = replies
        self.transform = False
        self.before: list[object] = []
        self.after: list[object] = []
        self.requests: list[object] = []

    def setAppliesPreferredTrackTransform_(self, enabled: bool) -> None:
        self.transform = enabled

    def setRequestedTimeToleranceBefore_(self, value: object) -> None:
        self.before.append(value)

    def setRequestedTimeToleranceAfter_(self, value: object) -> None:
        self.after.append(value)

    def copyCGImageAtTime_actualTime_error_(
        self, value: object, _actual: object, _error: object
    ) -> tuple[object | None, None]:
        self.requests.append(value)
        return self.replies.pop(0), None


class _FakeEndFrameBitmap:
    def __init__(self, encoded: bytes | None) -> None:
        self.encoded = encoded

    def representationUsingType_properties_(self, _kind: object, _options: object) -> bytes | None:
        return self.encoded


def _frame_time(value: float, timescale: int = 100) -> SimpleNamespace:
    return SimpleNamespace(flags=1, timescale=timescale, value=value)


def _install_fake_last_frame_stack(
    monkeypatch: pytest.MonkeyPatch,
    asset: object,
    generator: _FakeEndFrameGenerator,
    bitmap: _FakeEndFrameBitmap | None,
) -> None:
    monkeypatch.setattr(probe_mod, "_AVFOUNDATION_AVAILABLE", True)
    monkeypatch.setattr(probe_mod, "objc", SimpleNamespace(autorelease_pool=nullcontext))
    monkeypatch.setattr(
        probe_mod,
        "Foundation",
        SimpleNamespace(NSURL=SimpleNamespace(fileURLWithPath_=lambda path: path)),
    )
    monkeypatch.setattr(
        probe_mod,
        "CM",
        SimpleNamespace(
            kCMTimeFlags_Valid=1,
            kCMTimeFlags_PositiveInfinity=2,
            CMTime=lambda **values: SimpleNamespace(**values),
        ),
    )
    monkeypatch.setattr(
        probe_mod,
        "AVFoundation",
        SimpleNamespace(
            AVMediaTypeVideo="video",
            AVURLAsset=SimpleNamespace(
                URLAssetWithURL_options_=lambda _url, _options: asset
            ),
            AVAssetImageGenerator=SimpleNamespace(
                alloc=lambda: SimpleNamespace(initWithAsset_=lambda _asset: generator)
            ),
        ),
    )
    monkeypatch.setattr(
        probe_mod,
        "AppKit",
        SimpleNamespace(
            NSBitmapImageFileTypePNG="PNG",
            NSBitmapImageRep=SimpleNamespace(
                alloc=lambda: SimpleNamespace(initWithCGImage_=lambda _image: bitmap)
            ),
        ),
    )


def _last_frame_asset(duration: object, video_tracks: list[object]) -> SimpleNamespace:
    return SimpleNamespace(
        duration=lambda: duration,
        tracksWithMediaType_=lambda media_type: video_tracks if media_type == "video" else [],
    )


def test_last_frame_uses_the_video_track_end_with_exact_tolerance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    track = SimpleNamespace(
        timeRange=lambda: SimpleNamespace(start=_frame_time(100), duration=_frame_time(200))
    )
    asset = _last_frame_asset(_frame_time(2_000), [track])
    generator = _FakeEndFrameGenerator([object()])
    _install_fake_last_frame_stack(monkeypatch, asset, generator, _FakeEndFrameBitmap(b"png"))

    assert probe_mod.last_frame("clip.mov") == b"png"
    assert generator.transform is True
    assert [time.value for time in generator.requests] == [1780]
    assert [time.value for time in generator.before] == [0]
    assert [time.value for time in generator.after] == [0]


def test_last_frame_falls_back_earlier_when_exact_decode_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    asset = _last_frame_asset(_frame_time(600), [])
    generator = _FakeEndFrameGenerator([None, object()])
    _install_fake_last_frame_stack(monkeypatch, asset, generator, _FakeEndFrameBitmap(b"png"))

    assert probe_mod.last_frame("clip.mov") == b"png"
    assert [time.value for time in generator.requests] == [3580, 3580]
    assert [time.value for time in generator.before] == [0, 9_223_372_036_854_775_807]
    assert [time.value for time in generator.after] == [0, 0]
    assert generator.before[1].flags == 3


def test_last_frame_keeps_a_zero_length_video_range_over_asset_duration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    track = SimpleNamespace(
        timeRange=lambda: SimpleNamespace(start=_frame_time(0), duration=_frame_time(0))
    )
    asset = _last_frame_asset(_frame_time(600), [track])
    generator = _FakeEndFrameGenerator([object()])
    _install_fake_last_frame_stack(monkeypatch, asset, generator, _FakeEndFrameBitmap(b"png"))

    assert probe_mod.last_frame("clip.mov") == b"png"
    assert generator.requests[0].value == 0


def test_last_frame_uses_asset_duration_for_an_unusable_track_range(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bad_start = SimpleNamespace(flags=0, timescale=100, value=0)
    track = SimpleNamespace(
        timeRange=lambda: SimpleNamespace(start=bad_start, duration=_frame_time(100))
    )
    asset = _last_frame_asset(_frame_time(200), [track])
    generator = _FakeEndFrameGenerator([object()])
    _install_fake_last_frame_stack(monkeypatch, asset, generator, _FakeEndFrameBitmap(b"png"))

    assert probe_mod.last_frame("clip.mov") == b"png"
    assert generator.requests[0].value == 1180

    nan_duration_asset = _last_frame_asset(_frame_time(float("nan")), [])
    no_capture = _FakeEndFrameGenerator([])
    _install_fake_last_frame_stack(monkeypatch, nan_duration_asset, no_capture, None)
    assert probe_mod.last_frame("clip.mov") is None


def test_last_frame_returns_none_for_unavailable_invalid_or_undecodable_input(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(probe_mod, "_AVFOUNDATION_AVAILABLE", False)
    assert probe_mod.last_frame("clip.mov") is None

    invalid_asset = _last_frame_asset(SimpleNamespace(flags=0, timescale=100, value=1), [])
    invalid_generator = _FakeEndFrameGenerator([])
    _install_fake_last_frame_stack(monkeypatch, invalid_asset, invalid_generator, None)
    assert probe_mod.last_frame("clip.mov") is None

    no_frame_asset = _last_frame_asset(_frame_time(100), [])
    no_frame_generator = _FakeEndFrameGenerator([None, None])
    _install_fake_last_frame_stack(monkeypatch, no_frame_asset, no_frame_generator, None)
    assert probe_mod.last_frame("clip.mov") is None


def test_last_frame_png_encoder_can_decline_a_decoded_image(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    asset = _last_frame_asset(_frame_time(100), [])
    generator = _FakeEndFrameGenerator([object()])
    _install_fake_last_frame_stack(monkeypatch, asset, generator, None)
    assert probe_mod.last_frame("clip.mov") is None

    _install_fake_last_frame_stack(monkeypatch, asset, generator, _FakeEndFrameBitmap(None))
    assert probe_mod._png_bytes(object()) is None


# ------------------------------------------------- (3) no decrypted leftovers


def test_probing_bytes_leaves_no_decrypted_copy_behind() -> None:
    def leftovers() -> int:
        tmp_dir = Path(tempfile.gettempdir())
        return sum(
            1
            for entry in tmp_dir.iterdir()
            if entry.name.startswith("arcelle-probe-") and entry.name.endswith(".probetest")
        )

    assert leftovers() == 0, "a previous run leaked"
    probe_mod.probe_bytes(b"secret video bytes", "probetest")
    assert leftovers() == 0, "a decrypted probe copy survived the call"


@requires_fixture
def test_probing_real_bytes_leaves_no_decrypted_copy_behind(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # AVFoundation dispatches on the file EXTENSION as well as the
    # container's own magic (the module's own privacy-note docstring), so
    # this uses a REAL ".mov" extension -- a made-up one like ".probetest"
    # would make AVFoundation refuse to open it at all, which is a fact
    # about extension sniffing, not about temp-file hygiene. A fixed uuid
    # pins down the exact temp path to check for a leftover, so this checks
    # the SUCCESS path (a real probe that actually learns something), not
    # just the garbage-bytes failure path above.
    fixture = _build_fixture(tmp_path, "probebytes.mov")
    if fixture is None:
        pytest.skip("skipped: no system fixture source on this machine")

    fixed = uuid.UUID("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    monkeypatch.setattr(probe_mod.uuid, "uuid4", lambda: fixed)
    expected = Path(tempfile.gettempdir()) / f"arcelle-probe-{fixed}.mov"
    assert not expected.exists(), "a previous run leaked"

    data = fixture.read_bytes()
    meta = probe_mod.probe_bytes(data, "mov")
    assert meta is not None
    assert not expected.exists(), "a decrypted probe copy survived the call"


# ------------------------------------------------------ (4) sane_frame_rate


def test_unreadable_fields_stay_unknown_rather_than_defaulting() -> None:
    # 0 fps is what AVFoundation reports for a container that states no
    # frame rate; it must read as "we don't know", never as "0 fps".
    assert probe_mod.sane_frame_rate(0.0) is None
    assert probe_mod.sane_frame_rate(-1.0) is None
    assert probe_mod.sane_frame_rate(float("nan")) is None
    assert probe_mod.sane_frame_rate(float("inf")) is None
    assert probe_mod.sane_frame_rate(1e6) is None
    assert probe_mod.sane_frame_rate(29.97) == 29.97
    assert probe_mod.sane_frame_rate(240.0) == 240.0  # real slow-motion

    # An all-unknown struct is not a probe result.
    assert probe_mod.MediaMeta().is_empty()
    assert not probe_mod.MediaMeta(has_audio=False).is_empty()


def _fake_asset(
    video_tracks: list[object], audio_tracks: list[object], duration: object
) -> SimpleNamespace:
    return SimpleNamespace(
        duration=lambda: duration,
        tracksWithMediaType_=lambda media_type: (
            video_tracks if media_type == "video" else audio_tracks
        ),
    )


def _install_fake_probe_stack(
    monkeypatch: pytest.MonkeyPatch, asset: SimpleNamespace
) -> None:
    """Make the public probe path deterministic without standing in for its
    metadata rules. The real-framework tests above retain the AVFoundation
    integration contract; these fakes let the error and malformed-container
    cases reach the same public API on every developer machine.
    """
    monkeypatch.setattr(probe_mod, "_AVFOUNDATION_AVAILABLE", True)
    monkeypatch.setattr(probe_mod, "objc", SimpleNamespace(autorelease_pool=nullcontext))
    monkeypatch.setattr(
        probe_mod,
        "Foundation",
        SimpleNamespace(NSURL=SimpleNamespace(fileURLWithPath_=lambda path: path)),
    )
    monkeypatch.setattr(
        probe_mod,
        "AVFoundation",
        SimpleNamespace(
            AVMediaTypeVideo="video",
            AVMediaTypeAudio="audio",
            AVURLAsset=SimpleNamespace(
                URLAssetWithURL_options_=lambda _url, _options: asset
            ),
        ),
    )
    monkeypatch.setattr(probe_mod, "_display_size", lambda track: track.size)
    monkeypatch.setattr(probe_mod, "_track_codec", lambda track: track.codec)


def _fake_video_track(bitrate: float, size: tuple[int, int] | None = (1920, 1080)) -> object:
    return SimpleNamespace(
        codec="H.264",
        size=size,
        nominalFrameRate=lambda: 29.97,
        estimatedDataRate=lambda: bitrate,
    )


def _valid_time(value: float) -> SimpleNamespace:
    return SimpleNamespace(
        flags=probe_mod.CM.kCMTimeFlags_Valid,
        timescale=100,
        value=value,
    )


@pytest.mark.parametrize(
    ("bitrate", "expected_kbps"),
    [(2500.0, 3), (float("nan"), None), (0.0, None)],
)
def test_probe_keeps_track_facts_when_bitrate_is_missing(
    monkeypatch: pytest.MonkeyPatch, bitrate: float, expected_kbps: int | None
) -> None:
    asset = _fake_asset([_fake_video_track(bitrate)], [], _valid_time(150))
    _install_fake_probe_stack(monkeypatch, asset)

    meta = probe_mod.probe("fixture.mov")

    assert meta == probe_mod.MediaMeta(
        duration_secs=1.5,
        width=1920,
        height=1080,
        video_codec="H.264",
        frame_rate=29.97,
        bitrate_kbps=expected_kbps,
        has_audio=False,
    )


def test_probe_keeps_audio_only_assets_and_rejects_empty_assets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    audio = SimpleNamespace(codec="AAC")
    _install_fake_probe_stack(monkeypatch, _fake_asset([], [audio], _valid_time(200)))

    assert probe_mod.probe("audio.m4a") == probe_mod.MediaMeta(
        duration_secs=2.0,
        has_audio=True,
        audio_codec="AAC",
    )

    _install_fake_probe_stack(monkeypatch, _fake_asset([], [], _valid_time(200)))
    assert probe_mod.probe("renamed-text.mp4") is None


@pytest.mark.parametrize(
    "duration",
    [
        _valid_time(0),
        _valid_time(float("nan")),
        SimpleNamespace(flags=0, timescale=100, value=100),
    ],
)
def test_probe_drops_unusable_duration_without_dropping_track_metadata(
    monkeypatch: pytest.MonkeyPatch, duration: SimpleNamespace
) -> None:
    asset = _fake_asset([_fake_video_track(1000.0, size=None)], [], duration)
    _install_fake_probe_stack(monkeypatch, asset)

    meta = probe_mod.probe("durationless.mov")

    assert meta is not None
    assert meta.duration_secs is None
    assert meta.width is None and meta.height is None
    assert meta.video_codec == "H.264"


def test_probe_is_unavailable_off_macos(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(probe_mod, "_AVFOUNDATION_AVAILABLE", False)
    assert probe_mod.probe("fixture.mov") is None


# --------------------------------------------------- (5) fourcc / codec_name


def test_codecs_are_named_where_we_know_them_and_verbatim_where_we_do_not() -> None:
    assert probe_mod.fourcc_string(int.from_bytes(b"avc1", "big")) == "avc1"
    assert probe_mod.fourcc_string(int.from_bytes(b"aac ", "big")) == "aac"
    assert probe_mod.fourcc_string(0) is None
    assert probe_mod.codec_name("hvc1") == "HEVC"
    assert probe_mod.codec_name("hev1") == "HEVC"
    assert probe_mod.codec_name("avc1") == "H.264"
    assert probe_mod.codec_name("avc3") == "H.264"
    assert probe_mod.codec_name("vp09") == "VP9"
    assert probe_mod.codec_name("av01") == "AV1"
    assert probe_mod.codec_name("mp4v") == "MPEG-4"
    assert probe_mod.codec_name("jpeg") == "Motion JPEG"
    for prores_fourcc in ("apch", "apcn", "apcs", "apco", "ap4h", "ap4x"):
        assert probe_mod.codec_name(prores_fourcc) == "Apple ProRes"
    assert probe_mod.codec_name("aac") == "AAC"
    assert probe_mod.codec_name("mp4a") == "AAC"
    assert probe_mod.codec_name(".mp3") == "MP3"
    assert probe_mod.codec_name("mp3") == "MP3"
    assert probe_mod.codec_name("lpcm") == "Linear PCM"
    assert probe_mod.codec_name("alac") == "Apple Lossless"
    assert probe_mod.codec_name("opus") == "Opus"
    # An unmapped code is shown as the file stated it — dropping it would
    # hide a fact the container did give us.
    assert probe_mod.codec_name("xyzw") == "xyzw"


def test_track_codec_leaves_absent_or_unprintable_descriptions_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    no_description = SimpleNamespace(formatDescriptions=lambda: [])
    assert probe_mod._track_codec(no_description) is None

    monkeypatch.setattr(
        probe_mod,
        "CM",
        SimpleNamespace(CMFormatDescriptionGetMediaSubType=lambda _description: 0),
    )
    non_ascii_description = SimpleNamespace(formatDescriptions=lambda: [object()])
    assert probe_mod._track_codec(non_ascii_description) is None


# --------------------------------------------------------- (6) is_empty()


def test_media_meta_is_empty() -> None:
    assert probe_mod.MediaMeta().is_empty()
    assert not probe_mod.MediaMeta(duration_secs=1.0).is_empty()
    assert not probe_mod.MediaMeta(width=100).is_empty()
    assert not probe_mod.MediaMeta(height=100).is_empty()
    assert not probe_mod.MediaMeta(video_codec="H.264").is_empty()
    assert not probe_mod.MediaMeta(frame_rate=30.0).is_empty()
    assert not probe_mod.MediaMeta(bitrate_kbps=1000).is_empty()
    assert not probe_mod.MediaMeta(has_audio=True).is_empty()
    assert not probe_mod.MediaMeta(has_audio=False).is_empty()
    assert not probe_mod.MediaMeta(audio_codec="AAC").is_empty()


# ------------------------------------------------------- (7) last_frame_png


@requires_fixture
def test_last_frame_png_on_real_clip_is_valid_png_and_leaves_no_leftovers(
    tmp_path: Path,
) -> None:
    fixture = _build_fixture(tmp_path, "endframe.mov")
    if fixture is None:
        pytest.skip("skipped: no system fixture source on this machine")

    data = fixture.read_bytes()

    def leftovers() -> int:
        tmp_dir = Path(tempfile.gettempdir())
        return sum(1 for entry in tmp_dir.iterdir() if entry.name.startswith("arcelle-endframe-"))

    assert leftovers() == 0, "a previous run leaked"
    png = probe_mod.last_frame_png(data, "mov")
    assert leftovers() == 0, "a decrypted end-frame copy survived the call"

    assert png is not None, "a real .mov must yield a last frame"
    assert len(png) > 0
    assert png[:8] == b"\x89PNG\r\n\x1a\n", "not a valid PNG signature"

    # Decode it back to confirm it is real, valid image data (not merely a
    # PNG-shaped header) — round-trip through Quartz's own bitmap reader
    # rather than a third-party decoder, since that is what actually
    # produced these bytes.
    import AppKit

    rep = AppKit.NSBitmapImageRep.imageRepWithData_(AppKit.NSData.dataWithBytes_length_(png, len(png)))
    assert rep is not None, "PNG bytes did not decode back into an image"
    assert rep.pixelsWide() > 0
    assert rep.pixelsHigh() > 0


def test_last_frame_png_on_non_media_bytes_returns_none() -> None:
    assert probe_mod.last_frame_png(b"this is not a video", "mp4") is None
    assert probe_mod.last_frame_png(b"", "mp4") is None


# ------------------------------------- (8) _display_size on adversarial input


def test_display_size_survives_a_nan_transform() -> None:
    """Regression test: a NaN/Infinity `preferredTransform` component (a
    malformed or adversarial container's own claim about itself, not
    something this module can control) must make `_display_size` return
    `None`, exactly like the Rust source's own
    `w.is_finite() && h.is_finite()` guard — never raise. Rust's
    `f64::round()` passes NaN/Infinity through unchanged, so its
    finite-AFTER-round order is safe there; the Python port must check
    finiteness BEFORE rounding, since `math.floor`/`math.ceil` raise on a
    non-finite input.
    """
    import Quartz

    class _FakeTrack:
        def __init__(self, size: object, transform: object) -> None:
            self._size = size
            self._transform = transform

        def naturalSize(self) -> object:
            return self._size

        def preferredTransform(self) -> object:
            return self._transform

    size = Quartz.CGSizeMake(1920.0, 1080.0)

    nan_transform = Quartz.CGAffineTransformMake(float("nan"), 0.0, 0.0, 1.0, 0.0, 0.0)
    assert probe_mod._display_size(_FakeTrack(size, nan_transform)) is None

    inf_transform = Quartz.CGAffineTransformMake(float("inf"), 0.0, 0.0, 1.0, 0.0, 0.0)
    assert probe_mod._display_size(_FakeTrack(size, inf_transform)) is None

    # A normal, finite transform still works after the reordering.
    identity = Quartz.CGAffineTransformMake(1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    assert probe_mod._display_size(_FakeTrack(size, identity)) == (1920, 1080)
    zero_size = Quartz.CGSizeMake(0.0, 1080.0)
    assert probe_mod._display_size(_FakeTrack(zero_size, identity)) is None

    # A 90-degree rotation swaps the axes, same as the module docstring says.
    rotated = Quartz.CGAffineTransformMake(0.0, 1.0, -1.0, 0.0, 0.0, 0.0)
    assert probe_mod._display_size(_FakeTrack(size, rotated)) == (1080, 1920)
