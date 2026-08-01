"""Neural spoken voice: the /tts route and the BS.1770 loudness normalizer."""

from __future__ import annotations

import base64
import io
import math
import wave
from typing import Any

import httpx
import pytest
from conftest import FakeChatModel, FakeMCP, Round

from arcelle_sidecar import tts
from arcelle_sidecar.server import create_app


def app() -> Any:
    return create_app(
        chat_factory=lambda req: FakeChatModel([Round(content="hi")]),
        mcp_factory=lambda req: FakeMCP(),
    )


def client_for(a: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=a), base_url="http://sidecar"
    )


def sine_wav(
    seconds: float = 2.0, amp: float = 0.1, freq: float = 440.0, fs: int = 24_000
) -> bytes:
    """Mono 16-bit WAV of a sine — a deterministic loudness fixture."""
    n = int(seconds * fs)
    frames = bytearray()
    for i in range(n):
        v = int(amp * 32767 * math.sin(2 * math.pi * freq * i / fs))
        frames += v.to_bytes(2, "little", signed=True)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(fs)
        w.writeframes(bytes(frames))
    return buf.getvalue()


def wav_samples(wav_bytes: bytes) -> tuple[list[float], int]:
    with wave.open(io.BytesIO(wav_bytes), "rb") as r:
        fs = r.getframerate()
        raw = r.readframes(r.getnframes())
    vals = [
        int.from_bytes(raw[i : i + 2], "little", signed=True) / 32768.0
        for i in range(0, len(raw), 2)
    ]
    return vals, fs


# --- the normalizer ---------------------------------------------------------


def test_normalize_hits_target_lufs() -> None:
    out = tts.normalize_wav(sine_wav(amp=0.05), target_lufs=-16.0)
    samples, fs = wav_samples(out)
    measured = tts.measure_lufs(samples, fs)
    assert abs(measured - (-16.0)) < 0.5


def test_normalize_attenuates_hot_input() -> None:
    # A near-full-scale sine is way above -16 LUFS; gain must be negative.
    out = tts.normalize_wav(sine_wav(amp=0.9), target_lufs=-16.0)
    samples, fs = wav_samples(out)
    measured = tts.measure_lufs(samples, fs)
    assert abs(measured - (-16.0)) < 0.5
    assert max(abs(v) for v in samples) < 0.9


def test_normalize_boosts_quiet_input_to_target() -> None:
    # Very quiet input takes a huge boost and still reaches the target —
    # a -16 LUFS sine peaks well under the limiter knee, so it's untouched.
    out = tts.normalize_wav(sine_wav(amp=0.001), target_lufs=-16.0)
    samples, fs = wav_samples(out)
    assert abs(tts.measure_lufs(samples, fs) - (-16.0)) < 0.5
    assert max(abs(v) for v in samples) < 1.0


def test_high_crest_input_reaches_target_without_clipping() -> None:
    # Speech-like crest: a body that needs ~+6 dB with sparse peaks that the
    # gain pushes past full scale. A plain gain cap would land LUs short; the
    # soft limiter bends only those peaks, so the body reaches the target and
    # nothing hits full scale.
    wav = sine_wav(amp=0.05)
    samples, fs = wav_samples(wav)
    for i in range(0, len(samples), fs // 4):
        samples[i] = 0.7 if samples[i] >= 0 else -0.7
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(fs)
        w.writeframes(
            b"".join(
                int(v * 32767).to_bytes(2, "little", signed=True) for v in samples
            )
        )
    out = tts.normalize_wav(buf.getvalue(), target_lufs=-16.0)
    normed, _ = wav_samples(out)
    assert max(abs(v) for v in normed) < 1.0
    assert abs(tts.measure_lufs(normed, fs) - (-16.0)) < 1.5


def test_short_fragment_normalizes_without_gating() -> None:
    # Shorter than one 400 ms gating block → ungated fallback, still sane.
    out = tts.normalize_wav(sine_wav(seconds=0.2, amp=0.05), target_lufs=-16.0)
    samples, fs = wav_samples(out)
    assert len(samples) > 0
    assert max(abs(v) for v in samples) <= 1.0


def test_measure_lufs_scales_linearly_with_gain() -> None:
    # +6 dB of amplitude must read ~+6 LU louder — the K-filter is linear.
    quiet, fs = wav_samples(sine_wav(amp=0.05))
    loud, _ = wav_samples(sine_wav(amp=0.1))
    delta = tts.measure_lufs(loud, fs) - tts.measure_lufs(quiet, fs)
    assert abs(delta - 6.02) < 0.2


# --- the defaults are the product voice spec --------------------------------


def test_default_voice_spec() -> None:
    assert tts.DEFAULT_VOICE == "en-US-AndrewMultilingualNeural"
    assert tts.DEFAULT_RATE == "+22%"
    assert tts.DEFAULT_PITCH == "-2Hz"
    assert tts.TARGET_LUFS == -16.0


# --- the route --------------------------------------------------------------


async def test_tts_route_returns_audio(monkeypatch: pytest.MonkeyPatch) -> None:
    fixture = sine_wav()
    seen: dict[str, Any] = {}

    async def fake_synthesize(text: str, voice: str, rate: str, pitch: str) -> bytes:
        seen.update(text=text, voice=voice, rate=rate, pitch=pitch)
        return fixture

    monkeypatch.setattr(tts, "synthesize_wav", fake_synthesize)
    async with client_for(app()) as c:
        resp = await c.post("/tts", json={"text": "Hello there."})
    assert resp.status_code == 200
    assert base64.b64decode(resp.json()["audio_b64"]) == fixture
    # The request model carries the spec defaults through to synthesis.
    assert seen == {
        "text": "Hello there.",
        "voice": "en-US-AndrewMultilingualNeural",
        "rate": "+22%",
        "pitch": "-2Hz",
    }


async def test_tts_route_rejects_empty_and_oversize() -> None:
    async with client_for(app()) as c:
        assert (await c.post("/tts", json={"text": "  "})).status_code == 400
        long = "a" * (tts.MAX_TTS_CHARS + 1)
        assert (await c.post("/tts", json={"text": long})).status_code == 400


async def test_tts_route_maps_engine_failure_to_502(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def boom(text: str, voice: str, rate: str, pitch: str) -> bytes:
        raise tts.TtsError("neural voice unavailable: offline")

    monkeypatch.setattr(tts, "synthesize_wav", boom)
    async with client_for(app()) as c:
        resp = await c.post("/tts", json={"text": "Hello."})
    assert resp.status_code == 502
    assert resp.json()["code"] == "TTS_UNAVAILABLE"


# --- the live voice catalog --------------------------------------------------


async def test_voices_route_returns_live_catalog(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    voices = [
        {"id": "he-IL-AvriNeural", "gender": "Male", "locale": "he-IL"},
        {"id": "en-US-AvaMultilingualNeural", "gender": "Female", "locale": "en-US"},
    ]

    async def fake_list() -> list[dict[str, str]]:
        return voices

    monkeypatch.setattr(tts, "list_neural_voices", fake_list)
    async with client_for(app()) as c:
        resp = await c.post("/tts/voices", json={})
    assert resp.status_code == 200
    assert resp.json() == {"voices": voices}


async def test_voices_route_maps_catalog_failure_to_502(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def boom() -> list[dict[str, str]]:
        raise tts.TtsError("voice catalog unavailable: offline")

    monkeypatch.setattr(tts, "list_neural_voices", boom)
    async with client_for(app()) as c:
        resp = await c.post("/tts/voices", json={})
    assert resp.status_code == 502
    assert resp.json()["code"] == "TTS_UNAVAILABLE"


async def test_catalog_trims_sorts_and_serves_last_good_on_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """list_neural_voices: raw service rows -> trimmed sorted dicts; a later
    fetch failure serves the cached catalog instead of erroring."""
    import sys
    import types

    raw = [
        {
            "ShortName": "he-IL-HilaNeural",
            "Gender": "Female",
            "Locale": "he-IL",
            "FriendlyName": "ignored",
        },
        {
            "ShortName": "de-DE-FlorianMultilingualNeural",
            "Gender": "Male",
            "Locale": "de-DE",
        },
        {"Gender": "Male", "Locale": "xx-XX"},  # no ShortName -> dropped
    ]
    calls = {"n": 0}

    async def fake_list_voices() -> list[dict[str, str]]:
        calls["n"] += 1
        if calls["n"] > 1:
            raise RuntimeError("offline")
        return raw

    fake_mod = types.SimpleNamespace(list_voices=fake_list_voices)
    monkeypatch.setitem(sys.modules, "edge_tts", fake_mod)
    monkeypatch.setattr(tts, "_voices_cache", None)

    got = await tts.list_neural_voices()
    assert got == [
        {"id": "de-DE-FlorianMultilingualNeural", "gender": "Male", "locale": "de-DE"},
        {"id": "he-IL-HilaNeural", "gender": "Female", "locale": "he-IL"},
    ]
    # Second call fails at the service -> the last good catalog is served.
    assert await tts.list_neural_voices() == got

    # No cache at all -> the failure surfaces as TtsError.
    monkeypatch.setattr(tts, "_voices_cache", None)
    with pytest.raises(tts.TtsError):
        await tts.list_neural_voices()
