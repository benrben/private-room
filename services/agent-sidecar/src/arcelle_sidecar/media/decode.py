"""Decode audio/video files to mono f32 16 kHz PCM.

Port of `src-tauri/src/stt.rs` (the decoding half — lines 1-150 there; the
Whisper engine itself is a separate module). Decoding uses tools that ship
with macOS itself (`afconvert`; `avconvert` for video audio tracks) — no
ffmpeg, no extra runtime, no external engine. Best-effort by design: any
failure raises a `RuntimeError` the caller may catch and treat as "no text",
exactly as the Rust side returns an `Err` the import path can ignore.

These functions genuinely need macOS (`/usr/bin/afconvert`, `/usr/bin/
avconvert`) to succeed. On any other OS — or if the binaries are simply
missing — the subprocess call fails to start and that is surfaced as a plain
`RuntimeError`, not a hang or a crash.
"""

from __future__ import annotations

import enum
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

import numpy as np

from arcelle_sidecar.media.wav import decode_wav

# The "[m:ss]" transcript stamp lives elsewhere; this module only ever
# produces PCM samples, never timestamps.

#: Cap applied to a failed converter's stderr, matching the Rust side's
#: `.chars().take(200)` — enough to be useful, never enough to flood a log.
_STDERR_CAP = 200


class MediaKind(enum.Enum):
    AUDIO = "audio"
    VIDEO = "video"


def _remove(path: Path) -> None:
    """Best-effort delete — mirrors Rust's `let _ = std::fs::remove_file(...)`.

    Removing a file that was never created (or already removed) is a no-op,
    not an error worth surfacing.
    """
    try:
        path.unlink()
    except OSError:
        pass


def _make_private(path: Path) -> None:
    """Tighten a converter's OUTPUT to owner-only.

    `afconvert`/`avconvert` create their file themselves (under the process
    umask), and it holds the room's decrypted audio. Best-effort: a failure
    here is not a reason to fail the decode, and the file is removed either
    way once we're done with it.
    """
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def write_private(path: str | Path, data: bytes) -> None:
    """Create `path` owner-only from the moment it exists, then write `data`.

    Owner-only from creation (`O_CREAT | O_EXCL` plus mode 0o600 passed to the
    same syscall), rather than created world-readable and tightened
    afterwards: between those two steps another local process could already
    have opened it. Same reasoning — and same shape — as the Rust
    `write_private` (and `quicklook::write_private`): what these files hold is
    the room's decrypted audio, and TMPDIR is not always per-user.
    """
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)


def _extract_audio_track(input_path: Path, m4a_path: Path) -> Path:
    """Run `avconvert` to pull the audio track out of a video into an M4A."""
    try:
        proc = subprocess.run(
            [
                "/usr/bin/avconvert",
                "-p",
                "PresetAppleM4A",
                "-s",
                str(input_path),
                "-o",
                str(m4a_path),
            ],
            capture_output=True,
        )
    except OSError as e:
        raise RuntimeError(f"avconvert failed to start: {e}") from e
    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", errors="replace")[:_STDERR_CAP]
        # Deliberately the raw "no readable audio track: ..." shape (no
        # friendlier translation here) — `peaks.py`'s `describe_decode_error`
        # recognizes this exact prefix and turns it into a nicer sentence.
        raise RuntimeError(f"no readable audio track: {stderr}")
    # The converter made this file under the umask; it holds the room's
    # decrypted audio for the length of the decode.
    _make_private(m4a_path)
    return m4a_path


def _run_afconvert(source: Path, wav_path: Path) -> None:
    try:
        proc = subprocess.run(
            ["/usr/bin/afconvert", "-f", "WAVE", "-d", "LEI16@16000", str(source), str(wav_path)],
            capture_output=True,
        )
    except OSError as e:
        raise RuntimeError(f"afconvert failed to start: {e}") from e
    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", errors="replace")[:_STDERR_CAP]
        raise RuntimeError(f"audio decode failed: {stderr}")


def decode_to_pcm(input_path: str | Path, kind: MediaKind) -> np.ndarray:
    """Decode any audio/video file to mono f32 16 kHz samples.

    Video goes through `avconvert` (audio track -> .m4a) first, then
    everything through `afconvert` (-> 16 kHz LEI16 WAV), then a WAV parse
    (any channel count, averaged to mono). Temp files (both the intermediate
    m4a and the wav) are always removed, on every exit path.
    """
    input_path = Path(input_path)
    tmp_dir = Path(tempfile.gettempdir())
    stamp = uuid.uuid4()
    m4a_path = tmp_dir / f"pr-stt-{stamp}.m4a"
    wav_path = tmp_dir / f"pr-stt-{stamp}.wav"
    try:
        audio_src = input_path
        if kind is MediaKind.VIDEO:
            audio_src = _extract_audio_track(input_path, m4a_path)

        try:
            _run_afconvert(audio_src, wav_path)
        finally:
            # Mirrors the Rust side's `let _ = std::fs::remove_file(&m4a);`
            # immediately after the afconvert call returns (success or not) —
            # this is decrypted audio and must not linger any longer than the
            # afconvert step actually needs it, not merely "eventually" via
            # the outer cleanup below.
            _remove(m4a_path)

        _make_private(wav_path)
        try:
            wav_bytes = wav_path.read_bytes()
            pcm = decode_wav(wav_bytes)
        except (OSError, ValueError) as e:
            # Same error channel as every other failure here (Rust's
            # `parse_wav_to_mono_f32` returns `Result<_, String>` same as the
            # rest of `decode_to_pcm`) — a malformed/unreadable WAV must not
            # leak a different exception type than afconvert failing does.
            raise RuntimeError(str(e)) from e
        return np.asarray(pcm, dtype=np.float32)
    finally:
        _remove(m4a_path)
        _remove(wav_path)


def decode_bytes_to_pcm(data: bytes, ext: str, kind: MediaKind) -> np.ndarray:
    """Same as [`decode_to_pcm`] but starting from in-memory bytes.

    Writes a private temp file with the original extension so the converters
    can sniff the container, then always cleans it up (success or failure).
    """
    safe_ext = ext if ext else "bin"
    tmp_dir = Path(tempfile.gettempdir())
    src_path = tmp_dir / f"pr-stt-src-{uuid.uuid4()}.{safe_ext}"
    try:
        try:
            write_private(src_path, data)
        except OSError as e:
            # A PARTIAL write (disk full mid-file) has already created the
            # file, and it holds the room's decrypted audio. Removed in the
            # outer `finally` below; removing a file that was never created
            # is a no-op.
            raise RuntimeError(str(e)) from e
        return decode_to_pcm(src_path, kind)
    finally:
        _remove(src_path)
