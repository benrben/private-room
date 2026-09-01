"""In-memory WAV normalization coverage; no synthesis or audio service."""

from __future__ import annotations

import array
import io
import wave

import pytest

from arcelle_sidecar import tts


def _wav(
    raw: bytes, *, channels: int = 1, sample_width: int = 2, sample_rate: int = 8_000
) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(sample_width)
        writer.setframerate(sample_rate)
        writer.writeframes(raw)
    return buffer.getvalue()


def _frames(wav_bytes: bytes) -> tuple[list[int], int, int, int]:
    with wave.open(io.BytesIO(wav_bytes), "rb") as reader:
        channels = reader.getnchannels()
        sample_width = reader.getsampwidth()
        sample_rate = reader.getframerate()
        raw = reader.readframes(reader.getnframes())
    values = array.array("h")
    values.frombytes(raw)
    return list(values), channels, sample_width, sample_rate


def test_normalize_wav_returns_an_empty_valid_wav_byte_for_byte() -> None:
    silent = _wav(b"")

    assert tts.normalize_wav(silent) == silent


@pytest.mark.parametrize(
    ("raw", "channels", "sample_width"),
    [
        (b"\x00\x00\x00\x00", 2, 2),
        (b"\x80", 1, 1),
    ],
)
def test_normalize_wav_refuses_non_mono_or_non_16_bit_input(
    raw: bytes, channels: int, sample_width: int
) -> None:
    with pytest.raises(tts.TtsError, match="expected mono 16-bit WAV"):
        tts.normalize_wav(_wav(raw, channels=channels, sample_width=sample_width))


def test_normalize_wav_preserves_format_and_unlimited_samples_at_unity_gain(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = array.array("h", [1_000, -1_000, 0]).tobytes()
    monkeypatch.setattr(tts, "measure_lufs", lambda _samples, _rate: -18.0)

    normalized = tts.normalize_wav(_wav(source, sample_rate=12_000), target_lufs=-18.0)

    assert _frames(normalized) == ([1_000, -1_000, 0], 1, 2, 12_000)


def test_normalize_wav_soft_limits_amplified_integer_peaks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = array.array("h", [-32_768, 32_767]).tobytes()
    monkeypatch.setattr(tts, "measure_lufs", lambda _samples, _rate: -100.0)

    values, channels, sample_width, sample_rate = _frames(
        tts.normalize_wav(_wav(source, sample_rate=24_000), target_lufs=0.0)
    )

    assert (channels, sample_width, sample_rate) == (1, 2, 24_000)
    assert values
    assert min(values) >= -32_767
    assert max(values) <= 32_767


def test_normalize_wav_exposes_malformed_wav_data() -> None:
    with pytest.raises(wave.Error):
        tts.normalize_wav(b"not a WAV")
