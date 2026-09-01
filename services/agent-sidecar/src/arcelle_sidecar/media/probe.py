"""What a video ACTUALLY is: duration, display size, codec, frame rate and
whether it carries sound.

Port of `src-tauri/src/media_probe.rs`. Nothing in this app used to ask a
video file anything: `decode.py`'s media-kind dispatch answers "audio or
video?" from the mime type and extension without ever opening the
container, so a room could tell you an MP4 was 40 MB and nothing else. This
module opens it — through AVFoundation, the same OS media stack `avconvert`
already decodes audio tracks with (`decode.py`), so there is no ffmpeg to
bundle, sign or notarize. The PyObjC bridge (`AVFoundation`/`CoreMedia`/
`AppKit` via `objc`) stands in for the Rust source's `objc2`/
`objc2_av_foundation`/`objc2_core_media` bindings.

EVERY FIELD IS OPTIONAL AND MEANS IT. A container that does not state its
frame rate leaves `frame_rate` None and the viewer says "unknown"; it never
shows a plausible default. A file AVFoundation refuses entirely probes to
`None`, not to a struct full of zeros — "0 x 0, 0 s" is a claim, and it would
be a false one.

PRIVACY NOTE, the same bargain `quicklook.py` and `decode.decode_bytes_to_pcm`
already make: AVFoundation takes a file URL, so `probe_bytes`/`last_frame_png`
write the decrypted bytes to an owner-only temp file for the moment the probe
or capture takes and remove it on every exit path. The path-based functions
(`probe_path`/`last_frame`) never need that — the user's own file is already
on disk there, so it is probed in place.
"""

from __future__ import annotations

import math
import os
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from arcelle_sidecar.media.decode import write_private

try:
    import AppKit
    import AVFoundation
    import CoreMedia as CM
    import Foundation
    import objc

    # Importing Quartz registers CGImageRef's toll-free CoreFoundation
    # bridging with the ObjC runtime. Without it (verified empirically on a
    # real Mac), AVAssetImageGenerator's `copyCGImageAtTime:actualTime:
    # error:` hands back an opaque raw pointer object instead of a CGImage
    # PyObjC can pass on to NSBitmapImageRep, and the frame capture fails
    # silently. `probe()` itself never touches a CGImage, but importing it
    # unconditionally alongside AVFoundation keeps one availability flag for
    # the whole module rather than a second one only `last_frame` checks.
    import Quartz  # noqa: F401

    _AVFOUNDATION_AVAILABLE = True
except ImportError:  # pragma: no cover - this sidecar only ships on macOS
    _AVFOUNDATION_AVAILABLE = False


@dataclass
class MediaMeta:
    """The technical facts about one media file. Every field is
    independently unknown-able: AVFoundation may read a duration from a
    container that states no frame rate, and both answers are honest.
    """

    duration_secs: Optional[float] = None
    #: DISPLAY size — the track's natural size with its preferred transform
    #: applied. A portrait iPhone clip stores 1920x1080 plus a 90 degree
    #: rotation; reporting the stored size would contradict both the player
    #: and the user's eyes.
    width: Optional[int] = None
    height: Optional[int] = None
    #: Human name where we know one ("H.264"), otherwise the container's own
    #: four-character code verbatim. Never a guess.
    video_codec: Optional[str] = None
    frame_rate: Optional[float] = None
    bitrate_kbps: Optional[int] = None
    #: True/False once the track list has been read. None only when the
    #: asset would not open at all.
    has_audio: Optional[bool] = None
    audio_codec: Optional[str] = None

    def is_empty(self) -> bool:
        """Nothing was learned. Storing this would put a row of "unknown" in
        the database that a later, better probe could never tell apart from
        a real answer, so callers drop it instead."""
        return self == MediaMeta()


#: Four-character codes we can name. Anything absent stays a raw fourcc in
#: the UI — an unrecognized codec is a fact about our table, not about the
#: file, and "unknown codec" would hide information the container did give
#: us.
_CODEC_NAMES: dict[str, str] = {
    "avc1": "H.264",
    "avc3": "H.264",
    "hvc1": "HEVC",
    "hev1": "HEVC",
    "vp09": "VP9",
    "av01": "AV1",
    "mp4v": "MPEG-4",
    "jpeg": "Motion JPEG",
    "apch": "Apple ProRes",
    "apcn": "Apple ProRes",
    "apcs": "Apple ProRes",
    "apco": "Apple ProRes",
    "ap4h": "Apple ProRes",
    "ap4x": "Apple ProRes",
    "aac": "AAC",
    "mp4a": "AAC",
    ".mp3": "MP3",
    "mp3": "MP3",
    "lpcm": "Linear PCM",
    "alac": "Apple Lossless",
    "opus": "Opus",
}


def codec_name(fourcc: str) -> str:
    """The human name for `fourcc`, or `fourcc` itself when we don't have
    one."""
    return _CODEC_NAMES.get(fourcc, fourcc)


def fourcc_string(code: int) -> Optional[str]:
    """A CoreMedia FourCharCode as its four ASCII bytes, trimmed. Codes are
    space-padded ('aac ') and a non-ASCII code is not a name we can show."""
    raw = (code & 0xFFFFFFFF).to_bytes(4, "big")
    if any(not (0x20 <= b <= 0x7E) for b in raw):
        return None
    s = raw.decode("ascii").strip()
    return s or None


def _round_half_away_from_zero(x: float) -> int:
    """Match Rust's `f64::round()` — ties round away from zero, unlike
    Python's builtin `round()`, which rounds half-to-even on the (rare)
    binary floats that land exactly on a tie. Callers must have already
    confirmed `x` is finite: unlike Rust's `f64::round()` (which passes NaN/
    Infinity through unchanged), Python's `math.floor`/`math.ceil` raise on
    them, so this deliberately does not try to "round" a non-finite value."""
    return int(math.floor(x + 0.5)) if x >= 0.0 else int(math.ceil(x - 0.5))


def sane_frame_rate(fps: float) -> Optional[float]:
    """A nominal frame rate worth reporting. AVFoundation returns 0 for a
    container that states none, and the value is a float that can arrive as
    NaN; the upper bound rejects nonsense without rejecting real high-speed
    capture (240 fps slow motion is a normal iPhone file)."""
    fps = float(fps)
    if math.isfinite(fps) and fps > 0.0 and fps <= 1000.0:
        return _round_half_away_from_zero(fps * 100.0) / 100.0
    return None


def _track_codec(track: object) -> Optional[str]:
    """The first track's codec fourcc, named where we know it."""
    descs = track.formatDescriptions()
    if len(descs) == 0:
        return None
    subtype = CM.CMFormatDescriptionGetMediaSubType(descs[0])
    fourcc = fourcc_string(int(subtype))
    if fourcc is None:
        return None
    return codec_name(fourcc)


def _display_size(track: object) -> Optional[tuple[int, int]]:
    """The size the track is meant to be SEEN at: the natural size run
    through the preferred transform's bounding box. A 90/270 degree rotation
    swaps the axes, which is why a portrait phone clip that stores
    1920x1080 must be reported as 1080x1920.

    Checks finiteness BEFORE rounding — a deliberate reordering from the Rust
    source, which rounds first (`f64::round()` passes NaN/Infinity through
    unchanged) and checks `is_finite()` after. A malformed/adversarial
    `preferredTransform` (NaN or Infinity entries) is untrusted-input territory
    this module must survive, and rounding first in Python would raise
    `ValueError`/`OverflowError` out of `math.floor`/`math.ceil` before the
    finiteness check ever ran — confirmed by direct reproduction with a NaN
    transform component. Checking first makes the two orderings equivalent in
    outcome (a finite input rounds to a finite result either way) while never
    calling the rounding helper on a non-finite value."""
    size = track.naturalSize()
    t = track.preferredTransform()
    w = abs(t.a) * size.width + abs(t.c) * size.height
    h = abs(t.b) * size.width + abs(t.d) * size.height
    if not (math.isfinite(w) and math.isfinite(h)):
        return None
    w_i = _round_half_away_from_zero(w)
    h_i = _round_half_away_from_zero(h)
    if w_i >= 1 and h_i >= 1:
        return w_i, h_i
    return None


def _seconds_of(t: object) -> Optional[float]:
    """A CMTime as seconds, or None when it is not a usable, non-negative
    number."""
    if not bool(t.flags & CM.kCMTimeFlags_Valid) or t.timescale <= 0:
        return None
    secs = t.value / t.timescale
    if math.isfinite(secs) and secs >= 0.0:
        return secs
    return None


def _positive_seconds(t: object) -> Optional[float]:
    """A usable CMTime only when it names a strictly positive duration.

    The asset-duration contract is deliberately narrower than `_seconds_of`:
    a zero-length container does not provide a duration worth displaying.
    """
    seconds = _seconds_of(t)
    return seconds if seconds is not None and seconds > 0.0 else None


def _add_video_metadata(meta: MediaMeta, track: object) -> None:
    """Record the facts supplied by the first video track."""
    size = _display_size(track)
    if size is not None:
        meta.width, meta.height = size
    meta.video_codec = _track_codec(track)
    meta.frame_rate = sane_frame_rate(float(track.nominalFrameRate()))
    bits = float(track.estimatedDataRate())
    if not math.isfinite(bits):
        return
    if bits <= 0.0:
        return
    meta.bitrate_kbps = _round_half_away_from_zero(bits / 1000.0)


def _metadata_from_tracks(
    asset: object, video_tracks: object, audio_tracks: object
) -> Optional[MediaMeta]:
    """Build metadata after `probe` has established that media exists."""
    meta = MediaMeta(has_audio=len(audio_tracks) > 0)
    meta.duration_secs = _positive_seconds(asset.duration())
    if len(video_tracks) > 0:
        _add_video_metadata(meta, video_tracks[0])
    if len(audio_tracks) > 0:
        meta.audio_codec = _track_codec(audio_tracks[0])
    return None if meta.is_empty() else meta


def probe(path: str) -> Optional[MediaMeta]:
    """The actual AVFoundation probe: open an `AVURLAsset` at the file URL,
    get its video and audio tracks by media type. If BOTH are empty, `None`
    — a non-media file (a text file renamed `.mp4`) opens as an empty asset
    rather than erroring, and storing "0 tracks, unknown everything" would
    be a false claim of having probed real media.

    `has_audio` is set as soon as we know the track lists aren't both empty
    (it is a plain boolean fact about the container, never unknown from
    here on). Duration comes from the ASSET, not a track — a real clip's
    video and audio track durations differ — and is kept only if it is a
    valid, strictly positive, finite number of seconds (note: strictly `> 0`,
    NOT the `>= 0` that `_seconds_of` uses elsewhere — a container that
    reports a zero-length duration must not be reported as "0 s", it must be
    reported as unknown, matching the Rust source's own inline check rather
    than its `seconds_of` helper). From the first video track (if any): the
    DISPLAY size, the named/verbatim codec, a sane frame rate, and a bitrate
    estimate (kept only if finite and positive). From the first audio track
    (if any): the named/verbatim codec.

    Returns `None` if nothing was learned at all (`MediaMeta.is_empty()`).
    """
    if not _AVFOUNDATION_AVAILABLE:
        # AVFoundation is the only media stack this sidecar ships with. Off
        # macOS (or with the frameworks missing) there is nothing to probe
        # with, mirroring the Rust `#[cfg(not(target_os = "macos"))]` stub.
        return None

    with objc.autorelease_pool():
        url = Foundation.NSURL.fileURLWithPath_(path)
        asset = AVFoundation.AVURLAsset.URLAssetWithURL_options_(url, None)

        video_tracks = asset.tracksWithMediaType_(AVFoundation.AVMediaTypeVideo)
        audio_tracks = asset.tracksWithMediaType_(AVFoundation.AVMediaTypeAudio)
        if len(video_tracks) == 0:
            if len(audio_tracks) == 0:
                return None
        return _metadata_from_tracks(asset, video_tracks, audio_tracks)


def probe_path(path: str) -> Optional[MediaMeta]:
    """Probe a file already on disk. `None` = the file doesn't exist or is
    empty (never opened as media at all), or the OS opened it and told us
    nothing."""
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    if size == 0:
        return None
    return probe(path)


def _remove(path: Path) -> None:
    """Best-effort delete — mirrors Rust's `let _ = std::fs::remove_file(...)`."""
    try:
        Path(path).unlink()
    except OSError:
        pass


def _temp_path(prefix: str, ext: str) -> Path:
    stem = uuid.uuid4()
    name = f"{prefix}-{stem}.{ext}" if ext else f"{prefix}-{stem}"
    return Path(tempfile.gettempdir()) / name


def probe_bytes(data: bytes, ext: str) -> Optional[MediaMeta]:
    """Probe bytes that live encrypted in the room. AVFoundation dispatches
    on the file EXTENSION as well as the container's own magic, so the temp
    copy keeps it — a `.mov` handed over as `.bin` reads as a different (or
    no) container. The temp file is owner-only from creation and removed on
    every exit path, including a partial write (disk full mid-file already
    created the file; removing a file that never got created is a no-op)."""
    if not data:
        return None
    file = _temp_path("arcelle-probe", ext)
    try:
        try:
            write_private(file, data)
        except OSError:
            return None
        return probe(str(file))
    finally:
        # Always, on both paths — a probe must not leave decrypted video
        # behind.
        _remove(file)


def _valid_time(t: object) -> bool:
    return bool(t.flags & CM.kCMTimeFlags_Valid) and t.timescale > 0


def _last_frame_generator(asset: object) -> object:
    generator = AVFoundation.AVAssetImageGenerator.alloc().initWithAsset_(asset)
    # A portrait clip stores landscape pixels plus a rotation; without this the
    # captured frame — and therefore the whole next clip — comes out sideways.
    generator.setAppliesPreferredTrackTransform_(True)
    return generator


def _video_track_end(asset: object) -> Optional[float]:
    video_tracks = asset.tracksWithMediaType_(AVFoundation.AVMediaTypeVideo)
    if len(video_tracks) == 0:
        return None
    time_range = video_tracks[0].timeRange()
    start = _seconds_of(time_range.start)
    length = _seconds_of(time_range.duration)
    if start is None or length is None:
        return None
    return start + length


def _last_frame_end(asset: object, duration: object) -> Optional[float]:
    video_end = _video_track_end(asset)
    if video_end is not None:
        return video_end
    return _seconds_of(duration)


def _last_frame_time(end_secs: float) -> object:
    at_secs = max(end_secs - 1.0 / 30.0, 0.0)
    return CM.CMTime(
        value=_round_half_away_from_zero(at_secs * 600.0),
        timescale=600,
        flags=CM.kCMTimeFlags_Valid,
        epoch=0,
    )


def _zero_time() -> object:
    return CM.CMTime(value=0, timescale=1, flags=CM.kCMTimeFlags_Valid, epoch=0)


def _end_image(generator: object, at: object) -> object | None:
    zero = _zero_time()
    generator.setRequestedTimeToleranceBefore_(zero)
    generator.setRequestedTimeToleranceAfter_(zero)
    image, _err = generator.copyCGImageAtTime_actualTime_error_(at, None, None)
    if image is not None:
        return image
    # Exactness comes first; for odd containers, relax only how early the
    # decoder may answer, never how late.
    any_time = CM.CMTime(
        value=9_223_372_036_854_775_807,
        timescale=1,
        flags=CM.kCMTimeFlags_Valid | CM.kCMTimeFlags_PositiveInfinity,
        epoch=0,
    )
    generator.setRequestedTimeToleranceBefore_(any_time)
    generator.setRequestedTimeToleranceAfter_(zero)
    image, _err = generator.copyCGImageAtTime_actualTime_error_(at, None, None)
    return image


def _png_bytes(cg_image: object) -> Optional[bytes]:
    bitmap = AppKit.NSBitmapImageRep.alloc().initWithCGImage_(cg_image)
    if bitmap is None:
        return None
    encoded = bitmap.representationUsingType_properties_(AppKit.NSBitmapImageFileTypePNG, {})
    if encoded is None:
        return None
    return bytes(encoded)


def last_frame(path: str) -> Optional[bytes]:
    """The last frame of the clip at `path`, as PNG bytes.

    Anchors the capture to the VIDEO TRACK's own end, NOT the asset
    duration. The asset duration is the max across ALL tracks, and an audio
    track routinely outruns the video by a few dozen milliseconds (AAC
    priming padding — reproduced live with a 76 ms overhang). A
    zero-tolerance request in that gap sits after the last video frame and
    fails outright with "Cannot Open" — which is exactly why this reads the
    video track's OWN `timeRange` rather than trusting `asset.duration()`,
    falling back to the asset duration only when there is no video track's
    own range to read.

    "The last frame" cannot be asked for as the end instant itself: that is
    the boundary AFTER the final frame, so a thirtieth of a second earlier
    is requested instead — inside the final frame's display window. The
    request time is built with timescale 600 (the classic movie timescale —
    exact for every common frame rate), sidestepping a track's own
    (sometimes enormous) timescale.

    Zero tolerance is tried FIRST: the whole point of "last frame" is
    exactness, and with the default tolerance AVFoundation may answer with a
    nearby KEYFRAME, which on a 15 second clip can be half a second early —
    visibly not the frame the clip ends on. If the exact request fails (an
    odd container, a fragmented mp4, a track that lied about its range),
    it's retried with a large/positive-infinity tolerance BEFORE the
    requested time and the tolerance AFTER left at zero — the same
    asymmetric fallback as the Rust source: relax how early AVFoundation may
    answer, never how late.
    """
    if not _AVFOUNDATION_AVAILABLE:
        return None

    with objc.autorelease_pool():
        url = Foundation.NSURL.fileURLWithPath_(path)
        asset = AVFoundation.AVURLAsset.URLAssetWithURL_options_(url, None)
        duration = asset.duration()
        if not _valid_time(duration):
            return None
        generator = _last_frame_generator(asset)
        end_secs = _last_frame_end(asset, duration)
        if end_secs is None:
            return None
        image = _end_image(generator, _last_frame_time(end_secs))
        if image is None:
            return None
        return _png_bytes(image)


def last_frame_png(data: bytes, ext: str) -> Optional[bytes]:
    """The REAL final frame of a clip, as PNG bytes, from encrypted bytes.

    Same privacy bargain as `probe_bytes`: AVFoundation takes a file URL, so
    the decrypted clip sits in an owner-only temp file for the moment the
    capture takes and is removed on every exit path.

    `None` means the frame could not be read — a codec AVFoundation does not
    decode (a WebM, say). The caller falls back to whatever still it already
    had; this is never the only source of a frame.
    """
    if not data:
        return None
    file = _temp_path("arcelle-endframe", ext)
    try:
        try:
            write_private(file, data)
        except OSError:
            # Same promise as probe_bytes: a partial write is still a file,
            # and it holds decrypted clip bytes. Removed in the `finally`
            # below too.
            return None
        return last_frame(str(file))
    finally:
        _remove(file)


__all__ = [
    "MediaMeta",
    "codec_name",
    "fourcc_string",
    "sane_frame_rate",
    "probe",
    "probe_path",
    "probe_bytes",
    "last_frame",
    "last_frame_png",
]
