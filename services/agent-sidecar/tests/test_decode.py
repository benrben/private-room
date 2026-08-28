"""Tests for `arcelle_sidecar.media.decode` (port of `src-tauri/src/stt.rs`
lines 1-150 — the macOS-native `afconvert`/`avconvert` decode path).

Actually shells out to macOS `say(1)`/`afconvert(1)` to synthesize and decode
real audio. Skips gracefully if those binaries are not present (e.g. a future
non-macOS CI runner) rather than failing the suite.
"""

from __future__ import annotations

import importlib
import sys
import types
import uuid
from pathlib import Path

import numpy as np
import pytest


def _install_wav_stub_if_missing() -> None:
    """`arcelle_sidecar.media.wav` is a sibling port (the RIFF-walk /
    `decode_wav` module `decode.py` imports — the Python counterpart of
    `recording::decode_wav`, src-tauri/src/recording.rs lines 531-563) that may
    not exist yet depending on scheduling. If it's missing, install a minimal
    local stand-in here — for THESE TESTS ONLY — so `decode.py`'s
    `from arcelle_sidecar.media.wav import decode_wav` succeeds.

    This is not the module of record: once the real `media/wav.py` lands,
    `importlib.import_module` above finds it first and this shim is skipped
    entirely. Delete this function once that reconciliation has happened.
    """
    try:
        importlib.import_module("arcelle_sidecar.media.wav")
        return
    except ModuleNotFoundError:
        pass

    stub = types.ModuleType("arcelle_sidecar.media.wav")

    def decode_wav(data: bytes) -> np.ndarray:
        if len(data) < 44 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
            raise ValueError("not a WAV file")
        channels = 1
        pos = 12
        data_chunk = None
        while pos + 8 <= len(data):
            chunk_id = data[pos : pos + 4]
            size = int.from_bytes(data[pos + 4 : pos + 8], "little")
            body = pos + 8
            if chunk_id == b"fmt " and body + 4 <= len(data):
                channels = max(1, int.from_bytes(data[body + 2 : body + 4], "little"))
            elif chunk_id == b"data":
                data_chunk = (body, min(size, max(0, len(data) - body)))
                break
            pos = body + size + (size & 1)
        if data_chunk is None:
            raise ValueError("WAV has no data chunk")
        start, chunk_size = data_chunk
        frame = 2 * channels
        frames = chunk_size // frame
        if frames == 0:
            return np.zeros(0, dtype=np.float32)
        raw = np.frombuffer(data, dtype="<i2", count=frames * channels, offset=start)
        raw = raw.reshape(frames, channels).astype(np.float32)
        return (raw.mean(axis=1) / 32768.0).astype(np.float32)

    stub.decode_wav = decode_wav
    sys.modules["arcelle_sidecar.media.wav"] = stub


_install_wav_stub_if_missing()
decode = importlib.import_module("arcelle_sidecar.media.decode")


# `say`/`afconvert` genuinely need macOS. Skip gracefully rather than fail
# on a hypothetical future non-macOS CI runner.
_HAS_MACOS_STT_TOOLS = Path("/usr/bin/say").exists() and Path("/usr/bin/afconvert").exists()
requires_macos_stt_tools = pytest.mark.skipif(
    not _HAS_MACOS_STT_TOOLS,
    reason="requires macOS `say`/`afconvert`, not present on this machine",
)

_SPEECH_TEXT = "Testing one two three four five."
_SPEECH_WORDS = len(_SPEECH_TEXT.rstrip(".").split())
_SPEECH_RATE_WPM = 180


@pytest.fixture(scope="module")
def synthesized_aiff(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A short AIFF synthesized by `say(1)` — real audio, not a fixture file."""
    if not _HAS_MACOS_STT_TOOLS:
        pytest.skip("requires macOS `say`/`afconvert`, not present on this machine")
    d = tmp_path_factory.mktemp("decode_test_audio")
    aiff_path = d / "sample.aiff"
    import subprocess

    proc = subprocess.run(
        ["/usr/bin/say", "-r", str(_SPEECH_RATE_WPM), "-o", str(aiff_path), _SPEECH_TEXT],
        capture_output=True,
    )
    if proc.returncode != 0 or not aiff_path.exists():
        pytest.skip(f"`say` failed to synthesize test audio: {proc.stderr!r}")
    return aiff_path


# --------------------------------------------------------------- (1) decode


@requires_macos_stt_tools
def test_decode_to_pcm_produces_expected_duration(synthesized_aiff: Path) -> None:
    pcm = decode.decode_to_pcm(synthesized_aiff, decode.MediaKind.AUDIO)

    assert isinstance(pcm, np.ndarray)
    assert pcm.dtype == np.float32
    assert pcm.ndim == 1
    assert pcm.shape[0] > 0

    duration_s = pcm.shape[0] / 16000.0
    expected_s = _SPEECH_WORDS / (_SPEECH_RATE_WPM / 60.0)
    # Generous bounds — `say`'s timing includes punctuation pauses and isn't
    # perfectly linear in word count, but it should land in the same ballpark.
    assert expected_s * 0.3 <= duration_s <= expected_s * 4.0, (
        f"decoded {duration_s:.2f}s of audio, expected roughly {expected_s:.2f}s"
    )


# ------------------------------------------------------- (2) bytes vs. file


@requires_macos_stt_tools
def test_decode_bytes_to_pcm_matches_decode_to_pcm(synthesized_aiff: Path) -> None:
    from_file = decode.decode_to_pcm(synthesized_aiff, decode.MediaKind.AUDIO)
    raw = synthesized_aiff.read_bytes()
    from_bytes = decode.decode_bytes_to_pcm(raw, "aiff", decode.MediaKind.AUDIO)

    assert from_bytes.shape == from_file.shape
    assert np.allclose(from_bytes, from_file, atol=1e-6)


# --------------------------------------------------- (3) nonexistent input


def test_decode_to_pcm_nonexistent_input_raises_clear_error(tmp_path: Path) -> None:
    """Should raise a clear RuntimeError, not hang or crash — on ANY platform:
    if afconvert itself is missing (non-macOS) the "failed to start" branch
    fires instead of the "audio decode failed" branch, but either way this
    must be a clean, prompt exception.
    """
    missing = tmp_path / "does-not-exist.aiff"
    with pytest.raises(RuntimeError) as excinfo:
        decode.decode_to_pcm(missing, decode.MediaKind.AUDIO)
    message = str(excinfo.value)
    assert "audio decode failed" in message or "afconvert failed to start" in message


# ------------------------------------------------------ (4) temp cleanup


@requires_macos_stt_tools
def test_decode_to_pcm_cleans_up_temp_files_on_success(
    monkeypatch: pytest.MonkeyPatch, synthesized_aiff: Path
) -> None:
    fixed = uuid.UUID("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    monkeypatch.setattr(decode.uuid, "uuid4", lambda: fixed)
    import tempfile

    tmp_dir = Path(tempfile.gettempdir())
    wav_path = tmp_dir / f"pr-stt-{fixed}.wav"
    m4a_path = tmp_dir / f"pr-stt-{fixed}.m4a"
    assert not wav_path.exists()
    assert not m4a_path.exists()

    pcm = decode.decode_to_pcm(synthesized_aiff, decode.MediaKind.AUDIO)

    assert pcm.shape[0] > 0
    assert not wav_path.exists(), "wav temp file survived a successful decode"
    assert not m4a_path.exists()


@requires_macos_stt_tools
def test_decode_to_pcm_cleans_up_temp_files_on_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fixed = uuid.UUID("11111111-2222-3333-4444-555555555555")
    monkeypatch.setattr(decode.uuid, "uuid4", lambda: fixed)
    import tempfile

    tmp_dir = Path(tempfile.gettempdir())
    wav_path = tmp_dir / f"pr-stt-{fixed}.wav"
    missing = tmp_path / "does-not-exist.aiff"

    with pytest.raises(RuntimeError):
        decode.decode_to_pcm(missing, decode.MediaKind.AUDIO)

    assert not wav_path.exists(), "wav temp file survived a failed decode"


@requires_macos_stt_tools
def test_decode_bytes_to_pcm_cleans_up_temp_file_on_success(
    monkeypatch: pytest.MonkeyPatch, synthesized_aiff: Path
) -> None:
    fixed = uuid.UUID("22222222-3333-4444-5555-666666666666")
    monkeypatch.setattr(decode.uuid, "uuid4", lambda: fixed)
    import tempfile

    tmp_dir = Path(tempfile.gettempdir())
    src_path = tmp_dir / f"pr-stt-src-{fixed}.aiff"
    raw = synthesized_aiff.read_bytes()

    pcm = decode.decode_bytes_to_pcm(raw, "aiff", decode.MediaKind.AUDIO)

    assert pcm.shape[0] > 0
    assert not src_path.exists(), "src temp file survived a successful decode"


@requires_macos_stt_tools
def test_decode_bytes_to_pcm_cleans_up_temp_file_on_forced_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixed = uuid.UUID("33333333-4444-5555-6666-777777777777")
    monkeypatch.setattr(decode.uuid, "uuid4", lambda: fixed)
    import tempfile

    tmp_dir = Path(tempfile.gettempdir())
    src_path = tmp_dir / f"pr-stt-src-{fixed}.aiff"
    # Garbage bytes afconvert cannot sniff a container out of — a deliberately
    # forced failure path (afconvert exits non-zero, no output file).
    garbage = b"not a real audio file, just garbage bytes afconvert must reject" * 4

    with pytest.raises(RuntimeError):
        decode.decode_bytes_to_pcm(garbage, "aiff", decode.MediaKind.AUDIO)

    assert not src_path.exists(), "src temp file survived a forced-failure decode"
