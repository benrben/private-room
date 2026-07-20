"""Neural TTS backend (spoken answers, default engine).

The room's default spoken voice is Microsoft Edge neural TTS via the
``edge-tts`` package — voice ``en-US-AndrewMultilingualNeural`` at +22% rate
and -2 Hz pitch, loudness-normalized to approximately -16 LUFS. It is a
neural synthetic voice, not a human recording, and Settings says so.

Privacy: this is the ONE seam where reply text leaves the Mac for speech —
the sentence to be spoken goes to Microsoft's service (same doctrine as
external_llm: an explicitly surfaced cloud engine, switchable to the
on-device AVSpeech voice in Settings → Spoken voice). Nothing else rides
along: no room name, no files, no history — only the sentence text.

Pipeline: edge-tts streams MP3 → ``/usr/bin/afconvert`` (ships with macOS,
same no-ffmpeg doctrine as recording) decodes to mono 16-bit WAV →
:func:`normalize_wav` applies BS.1770-4 K-weighted gated loudness
measurement (pure stdlib — the audio-EQ-cookbook biquads with the ITU
filter parameters, 400 ms gating blocks) and gains to the target, tanh
soft-limiting peaks above -1 dBFS so nothing clips. The webview decodes the returned WAV
with the same Web Audio chain the on-device voice uses, so archetype DSP
still applies.
"""

from __future__ import annotations

import array
import asyncio
import base64
import io
import math
import tempfile
import wave
from pathlib import Path

#: The product-default neural voice (a synthetic voice, not a human).
DEFAULT_VOICE = "en-US-AndrewMultilingualNeural"
#: Default prosody, per the voice spec.
DEFAULT_RATE = "+22%"
DEFAULT_PITCH = "-2Hz"
#: Loudness target for the final mix.
TARGET_LUFS = -16.0
#: Soft-limiter knee: gained samples above this magnitude are tanh-bent so
#: the mix reaches the loudness target without digital clipping. Speech at
#: +22% rate has a high enough crest factor that a plain gain cap would land
#: ~3 LU short; bending just the peaks keeps the body at -16 LUFS.
LIMITER_KNEE = 10.0 ** (-1.0 / 20.0)  # -1 dBFS
#: Mirror of Rust speech::MAX_SPEAK_CHARS — chunks arrive sentence-sized.
MAX_TTS_CHARS = 1_000

AFCONVERT = "/usr/bin/afconvert"


class TtsError(RuntimeError):
    """Synthesis failed (offline, service refused, decode failed)."""


# --- synthesis ---------------------------------------------------------------


async def synthesize_mp3(text: str, voice: str, rate: str, pitch: str) -> bytes:
    """Fetch MP3 audio for ``text`` from the Edge neural TTS service."""
    import edge_tts  # deferred: keeps module import (and tests) offline-safe

    chunks: list[bytes] = []
    try:
        communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
        async for message in communicate.stream():
            if message["type"] == "audio":
                chunks.append(message["data"])
    except Exception as exc:  # offline, WS refused, bad voice — one surface
        raise TtsError(f"neural voice unavailable: {exc}") from exc
    if not chunks:
        raise TtsError("neural voice returned no audio")
    return b"".join(chunks)


def mp3_to_wav(mp3_bytes: bytes) -> bytes:
    """Decode MP3 → mono 16-bit WAV with macOS's own afconvert."""
    import subprocess

    with tempfile.TemporaryDirectory(prefix="pr-tts-") as td:
        src = Path(td) / "in.mp3"
        dst = Path(td) / "out.wav"
        src.write_bytes(mp3_bytes)
        proc = subprocess.run(
            [AFCONVERT, "-f", "WAVE", "-d", "LEI16", "-c", "1", str(src), str(dst)],
            capture_output=True,
            timeout=60,
        )
        if proc.returncode != 0 or not dst.exists():
            raise TtsError(
                f"afconvert failed: {proc.stderr.decode(errors='replace')[:200]}"
            )
        return dst.read_bytes()


async def synthesize_wav(
    text: str,
    voice: str = DEFAULT_VOICE,
    rate: str = DEFAULT_RATE,
    pitch: str = DEFAULT_PITCH,
) -> bytes:
    """text → normalized mono WAV bytes (the endpoint's whole job)."""
    mp3 = await synthesize_mp3(text, voice, rate, pitch)
    wav = await asyncio.to_thread(mp3_to_wav, mp3)
    return await asyncio.to_thread(normalize_wav, wav, TARGET_LUFS)


# --- BS.1770 loudness --------------------------------------------------------

# K-weighting = high shelf + high pass, ITU-R BS.1770-4 parameters. The
# standard tabulates 48 kHz coefficients; designing from these parameters via
# the audio-EQ cookbook reproduces them at any sample rate (pyloudnorm does
# the same), which matters because Edge audio arrives at 24 kHz.
_SHELF_F0, _SHELF_GAIN_DB, _SHELF_Q = 1681.9744509555319, 3.999843853973347, 0.7071752369554193
_HP_F0, _HP_Q = 38.13547087613982, 0.5003270373253953


def _shelf_coeffs(fs: float) -> tuple[float, float, float, float, float]:
    a = 10.0 ** (_SHELF_GAIN_DB / 40.0)
    w0 = 2.0 * math.pi * _SHELF_F0 / fs
    alpha = math.sin(w0) / (2.0 * _SHELF_Q)
    cos = math.cos(w0)
    b0 = a * ((a + 1) + (a - 1) * cos + 2 * math.sqrt(a) * alpha)
    b1 = -2 * a * ((a - 1) + (a + 1) * cos)
    b2 = a * ((a + 1) + (a - 1) * cos - 2 * math.sqrt(a) * alpha)
    a0 = (a + 1) - (a - 1) * cos + 2 * math.sqrt(a) * alpha
    a1 = 2 * ((a - 1) - (a + 1) * cos)
    a2 = (a + 1) - (a - 1) * cos - 2 * math.sqrt(a) * alpha
    return b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0


def _highpass_coeffs(fs: float) -> tuple[float, float, float, float, float]:
    w0 = 2.0 * math.pi * _HP_F0 / fs
    alpha = math.sin(w0) / (2.0 * _HP_Q)
    cos = math.cos(w0)
    b0 = (1 + cos) / 2
    b1 = -(1 + cos)
    b2 = (1 + cos) / 2
    a0 = 1 + alpha
    a1 = -2 * cos
    a2 = 1 - alpha
    return b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0


def _biquad(samples: list[float], c: tuple[float, float, float, float, float]) -> list[float]:
    b0, b1, b2, a1, a2 = c
    out = [0.0] * len(samples)
    x1 = x2 = y1 = y2 = 0.0
    for i, x in enumerate(samples):
        y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        out[i] = y
        x2, x1 = x1, x
        y2, y1 = y1, y
    return out


def measure_lufs(samples: list[float], fs: int) -> float:
    """Integrated loudness (LUFS) of mono float samples, BS.1770-4 gated.

    Signals shorter than one 400 ms gating block fall back to the ungated
    mean square — sentence fragments must still normalize sanely.
    """
    k = _biquad(_biquad(samples, _shelf_coeffs(fs)), _highpass_coeffs(fs))
    block = int(0.4 * fs)
    if len(k) < block or block == 0:
        ms = sum(v * v for v in k) / max(1, len(k))
        return -0.691 + 10.0 * math.log10(ms) if ms > 0 else -70.0
    hop = block // 4  # 75% overlap
    blocks: list[float] = []
    for start in range(0, len(k) - block + 1, hop):
        seg = k[start : start + block]
        blocks.append(sum(v * v for v in seg) / block)
    loud = [-0.691 + 10.0 * math.log10(z) if z > 0 else -200.0 for z in blocks]
    # Absolute gate at -70 LUFS.
    kept = [z for z, lz in zip(blocks, loud) if lz > -70.0]
    if not kept:
        return -70.0
    # Relative gate 10 LU under the absolute-gated mean.
    rel = -0.691 + 10.0 * math.log10(sum(kept) / len(kept)) - 10.0
    final = [z for z, lz in zip(blocks, loud) if lz > -70.0 and lz > rel]
    if not final:
        final = kept
    return -0.691 + 10.0 * math.log10(sum(final) / len(final))


def _soft_limit(v: float, knee: float = LIMITER_KNEE) -> float:
    """Transparent below the knee; tanh-bends everything above it so output
    magnitude stays strictly under 1.0 (no digital clipping)."""
    mag = abs(v)
    if mag <= knee:
        return v
    bent = knee + (1.0 - knee) * math.tanh((mag - knee) / (1.0 - knee))
    return math.copysign(bent, v)


def normalize_wav(wav_bytes: bytes, target_lufs: float = TARGET_LUFS) -> bytes:
    """Gain a mono 16-bit WAV to ``target_lufs``, soft-limiting the peaks."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as r:
        if r.getsampwidth() != 2 or r.getnchannels() != 1:
            raise TtsError("expected mono 16-bit WAV from afconvert")
        fs = r.getframerate()
        raw = r.readframes(r.getnframes())
    ints = array.array("h")
    ints.frombytes(raw)
    if not ints:
        return wav_bytes
    samples = [v / 32768.0 for v in ints]
    measured = measure_lufs(samples, fs)
    g = 10.0 ** ((target_lufs - measured) / 20.0)
    # Scale by 32767 (not 32768) so a fully-bent limiter peak can never
    # round to full scale — the no-clipping guarantee holds in the ints too.
    out = array.array(
        "h",
        (
            max(-32767, min(32767, round(_soft_limit(v * g) * 32767.0)))
            for v in samples
        ),
    )
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(fs)
        w.writeframes(out.tobytes())
    return buf.getvalue()


def wav_b64(wav_bytes: bytes) -> str:
    return base64.b64encode(wav_bytes).decode("ascii")
