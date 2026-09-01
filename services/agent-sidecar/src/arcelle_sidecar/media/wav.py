"""16 kHz mono 16-bit WAV — port of src-tauri/src/recording.rs (lines ~500-630,
``encode_wav`` / ``decode_wav`` / ``resample_to_16k``) and the
`parse_wav_to_mono_f32` caller in src-tauri/src/stt.rs (lines ~155-175).

ONE parser (`decode_wav`) for both the recorder's own files and anything an
external converter (e.g. `afconvert`) produces — any RIFF/WAVE with a fmt
chunk and a data chunk, any channel count, 16-bit PCM.
"""

from __future__ import annotations

import struct

import numpy as np

SAMPLE_RATE: int = 16_000


def encode_wav(samples: np.ndarray) -> bytes:
    """16 kHz mono 16-bit PCM WAV — the recording file's on-disk shape.

    `samples` is a float32 array (any shape that is effectively 1-D). Each
    sample is clamped to [-1, 1], scaled by 32767, and truncated toward zero
    (matching Rust's `(s.clamp(-1.0, 1.0) * 32767.0) as i16` cast, which
    truncates rather than rounds).
    """
    flat = np.asarray(samples, dtype=np.float32).reshape(-1)
    data_len = flat.size * 2

    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + data_len,
        b"WAVE",
        b"fmt ",
        16,
        1,  # PCM
        1,  # mono
        SAMPLE_RATE,
        SAMPLE_RATE * 2,
        2,
        16,
        b"data",
        data_len,
    )

    # Clamp then truncate toward zero, matching Rust's `(s.clamp(-1.0, 1.0) *
    # 32767.0) as i16` — `as i16` on a float truncates, it does not round.
    # Kept in float32 throughout (not promoted to float64) so the arithmetic
    # matches Rust's f32 math bit-for-bit rather than just approximately.
    clamped = np.clip(flat, np.float32(-1.0), np.float32(1.0)) * np.float32(32767.0)
    truncated = np.trunc(clamped).astype("<i2")

    return header + truncated.tobytes()


def _is_wav(data: bytes) -> bool:
    """Whether ``data`` has the minimum RIFF/WAVE envelope."""
    return len(data) >= 44 and data[0:4] == b"RIFF" and data[8:12] == b"WAVE"


def _chunk_header(data: bytes, pos: int) -> tuple[bytes, int, int]:
    """Return a chunk id, declared body size, and body offset."""
    return data[pos : pos + 4], struct.unpack_from("<I", data, pos + 4)[0], pos + 8


def _chunk_channels(data: bytes, chunk_id: bytes, body: int, n: int, current: int) -> int:
    """Read a usable channel count from a fmt chunk, retaining the default."""
    if chunk_id == b"fmt " and body + 4 <= n:
        return max(1, struct.unpack_from("<H", data, body + 2)[0])
    return current


def _find_data_chunk(data: bytes) -> tuple[int, int | None, int]:
    """Find the first data chunk while accumulating preceding fmt metadata."""
    channels = 1
    pos = 12
    n = len(data)

    while pos + 8 <= n:
        chunk_id, size, body = _chunk_header(data, pos)
        channels = _chunk_channels(data, chunk_id, body, n, channels)
        if chunk_id == b"data":
            return channels, body, min(size, max(0, n - body))
        pos = body + size + (size & 1)
    return channels, None, 0


def _decode_pcm(
    data: bytes, data_start: int, data_size: int, channels: int
) -> np.ndarray:
    """Average complete little-endian int16 frames into mono float32 samples."""
    frame = 2 * channels
    frames = data_size // frame

    if frames == 0:
        return np.zeros(0, dtype=np.float32)

    # Reading exactly `frames * channels` int16s naturally drops any trailing
    # partial-frame bytes, matching the Rust loop's `0..frames` bound.
    raw = np.frombuffer(
        data, dtype="<i2", count=frames * channels, offset=data_start
    )
    samples = raw.astype(np.float32).reshape(frames, channels)
    pcm = samples.sum(axis=1) / channels / 32768.0
    return pcm.astype(np.float32)


def decode_wav(data: bytes) -> np.ndarray:
    """Parse any RIFF/WAVE with a fmt chunk and a data chunk into mono f32.

    Any channel count is averaged down to mono (matching Rust's
    `acc / channels as f32 / 32768.0`). Chunks are walked generically —
    including chunks that appear before `data`, and the odd-size padding byte
    (`size & 1`) required by the RIFF spec. Chunks after `data` are never
    reached: like the Rust code, this stops at the first `data` chunk found.
    """
    if not _is_wav(data):
        raise ValueError("not a WAV file")

    channels, data_start, data_size = _find_data_chunk(data)
    if data_start is None:
        raise ValueError("WAV has no data chunk")
    return _decode_pcm(data, data_start, data_size, channels)


def resample_to_16k(input: np.ndarray, from_rate: int) -> np.ndarray:
    """Per-chunk linear resampler to 16 kHz — no fractional-phase carry across
    calls. Each call is independent, matching how the Rust engine invokes this
    once per quarter-second chunk of live audio.

    `from_rate == 0` (an unset rate off the IPC seam — dividing by it would
    panic the engine thread), `from_rate == SAMPLE_RATE`, or an empty input
    all pass through unchanged.
    """
    arr = np.asarray(input, dtype=np.float32).reshape(-1)

    if from_rate == 0 or from_rate == SAMPLE_RATE or arr.size == 0:
        return arr.copy()

    n_in = arr.size
    # Integer floor division, matching Rust's u64 arithmetic exactly.
    n_out = (n_in * SAMPLE_RATE) // from_rate
    if n_out == 0:
        return np.zeros(0, dtype=np.float32)

    step = from_rate / SAMPLE_RATE
    j = np.arange(n_out, dtype=np.float64)
    x = j * step
    i = x.astype(np.int64)  # x >= 0 always, so truncation == floor
    frac = (x - i.astype(np.float64)).astype(np.float32)

    last = n_in - 1
    i0 = np.clip(i, 0, last)
    i1 = np.clip(i + 1, 0, last)

    a = arr[i0]
    b = arr[i1]
    return a + (b - a) * frac
