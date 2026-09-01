"""Port of the WAV-related tests in src-tauri/src/recording.rs (mod tests):
wav_roundtrip_preserves_samples, resample_lengths_and_endpoints,
a_zero_rate_is_passed_through_instead_of_dividing_by_it — plus decode_wav
error-path and multi-channel coverage the Rust side exercises via
stt::parse_wav_to_mono_f32 sharing the same parser, and a bucket-walk
cross-check for resample_to_16k on lengths that don't divide evenly.
"""

from __future__ import annotations

import math
import struct

import numpy as np
import pytest

from arcelle_sidecar.media.wav import SAMPLE_RATE, decode_wav, encode_wav, resample_to_16k


def test_wav_roundtrip_preserves_samples():
    samples = np.array([math.sin(i / 100.0) * 0.5 for i in range(1600)], dtype=np.float32)
    wav = encode_wav(samples)
    back = decode_wav(wav)
    assert len(back) == len(samples)
    for a, b in zip(samples, back):
        assert abs(float(a) - float(b)) < 1e-3, f"{a} vs {b}"


def test_resample_lengths_and_endpoints():
    input_ = np.array([float(i) for i in range(4800)], dtype=np.float32)  # 100 ms @ 48 kHz
    out = resample_to_16k(input_, 48000)
    assert len(out) == 1600
    assert out[0] == 0.0
    assert abs(float(out[1]) - 3.0) < 1e-4
    assert len(resample_to_16k(input_, 16000)) == len(input_)


def test_a_zero_rate_is_passed_through_instead_of_dividing_by_it():
    """A rate of zero comes off the IPC seam, not off the tap. Divided by, it
    panics the engine thread in Rust — here it must simply pass through.
    """
    input_ = np.array([float(i) for i in range(8)], dtype=np.float32)
    np.testing.assert_array_equal(resample_to_16k(input_, 0), input_)

    # The empty batch, at the same rate, is still empty.
    assert len(resample_to_16k(np.array([], dtype=np.float32), 0)) == 0

    # One sample, at a rate that really does resample: the loop must not
    # index past the end of a single-element input. n_out floors to 0.
    assert len(resample_to_16k(np.array([0.5], dtype=np.float32), 48000)) == 0

    out = resample_to_16k(np.array([0.5], dtype=np.float32), 8000)
    np.testing.assert_array_equal(out, np.array([0.5, 0.5], dtype=np.float32))


def _reference_resample(input_: np.ndarray, from_rate: int) -> np.ndarray:
    """Direct transliteration of the Rust loop (scalar, no numpy vectorization)
    — a second, independent implementation of the bucket-walk arithmetic to
    cross-check the vectorized version against, especially on lengths that
    don't divide evenly.
    """
    if from_rate == 0 or from_rate == SAMPLE_RATE or input_.size == 0:
        return input_.copy()
    n_in = input_.size
    n_out = (n_in * SAMPLE_RATE) // from_rate
    step = from_rate / SAMPLE_RATE
    out = np.zeros(n_out, dtype=np.float32)
    for j in range(n_out):
        x = j * step
        i = int(x)
        frac = np.float32(x - i)
        a = input_[min(i, n_in - 1)]
        b = input_[min(i + 1, n_in - 1)]
        out[j] = a + (b - a) * frac
    return out


@pytest.mark.parametrize(
    "n_in,from_rate",
    [
        (7, 48000),  # doesn't divide evenly: 7*16000//48000 = 2
        (1, 48000),  # single sample, downsampling rate
        (3, 8000),  # upsampling, odd length
        (997, 44100),  # prime length, non-divisor rate
        (100, 22050),
        (5, 3),  # from_rate smaller than SAMPLE_RATE by a huge factor
    ],
)
def test_resample_matches_scalar_reference_on_non_dividing_lengths(n_in, from_rate):
    rng = np.random.default_rng(0)
    input_ = rng.random(n_in).astype(np.float32)
    vectorized = resample_to_16k(input_, from_rate)
    reference = _reference_resample(input_, from_rate)
    assert vectorized.shape == reference.shape
    np.testing.assert_allclose(vectorized, reference, rtol=0, atol=1e-6)


@pytest.mark.parametrize(
    "data",
    [
        b"garbage",
        b"NOPE" + b"\x00" * 4 + b"WAVE" + b"\x00" * 32,
        b"RIFF" + b"\x00" * 4 + b"NOPE" + b"\x00" * 32,
    ],
)
def test_decode_wav_garbage_bytes_raises_not_a_wav_file(data: bytes):
    with pytest.raises(ValueError, match="not a WAV file"):
        decode_wav(data)


def test_decode_wav_no_data_chunk_raises_and_skips_an_odd_sized_chunk():
    # RIFF/WAVE + a real "fmt " chunk, followed by an ODD-sized "JUNK" chunk
    # (3-byte body, so the `size & 1` pad byte is actually exercised) and
    # still no "data" chunk anywhere — the walk must correctly step over the
    # pad byte without landing mid-chunk.
    fmt_body = struct.pack("<HHIIHH", 1, 1, SAMPLE_RATE, SAMPLE_RATE * 2, 2, 16)
    junk_body = b"\x01\x02\x03"
    body_after_riff = (
        b"WAVE"
        + b"fmt "
        + struct.pack("<I", len(fmt_body))
        + fmt_body
        + b"JUNK"
        + struct.pack("<I", len(junk_body))
        + junk_body
        + b"\x00"  # RIFF pad byte for the odd-sized JUNK chunk
    )
    header = b"RIFF" + struct.pack("<I", len(body_after_riff)) + body_after_riff
    assert len(header) >= 44
    with pytest.raises(ValueError, match="WAV has no data chunk"):
        decode_wav(header)


def test_decode_wav_averages_multiple_channels():
    # Build a 2-channel, 16-bit PCM WAV by hand: 3 stereo frames whose two
    # channels differ, so an averaging bug (e.g. picking channel 0 only)
    # would be caught.
    channels = 2
    frames = [(1000, 2000), (-500, 500), (32000, -32000)]
    data_bytes = b"".join(struct.pack("<hh", l, r) for l, r in frames)

    fmt_body = struct.pack(
        "<HHIIHH", 1, channels, 48000, 48000 * 2 * channels, 2 * channels, 16
    )
    body_after_riff = (
        b"WAVE"
        + b"fmt "
        + struct.pack("<I", len(fmt_body))
        + fmt_body
        + b"data"
        + struct.pack("<I", len(data_bytes))
        + data_bytes
    )
    wav = b"RIFF" + struct.pack("<I", len(body_after_riff)) + body_after_riff

    out = decode_wav(wav)
    assert len(out) == 3
    for (l, r), got in zip(frames, out):
        expected = (l + r) / 2.0 / 32768.0
        assert abs(float(got) - expected) < 1e-6


def test_decode_wav_empty_data_chunk_is_an_empty_float32_array():
    out = decode_wav(encode_wav(np.array([], dtype=np.float32)))
    assert out.dtype == np.float32
    assert out.size == 0
