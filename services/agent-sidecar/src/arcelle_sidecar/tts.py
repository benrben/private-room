"""Neural TTS backend (spoken answers — the room's only speech engine).

The spoken voice is Microsoft Edge neural TTS via the ``edge-tts`` package —
default voice ``en-US-AndrewMultilingualNeural`` at +22% rate and -2 Hz
pitch, loudness-normalized to approximately -16 LUFS. The Settings picker is
fed from the service's LIVE catalog (:func:`list_neural_voices`) — nothing
is bundled, so new service voices appear without an app update. They are
neural synthetic voices, not human recordings, and Settings says so.

Privacy: this is the ONE seam where reply text leaves the Mac for speech —
the sentence to be spoken goes to Microsoft's service (same doctrine as
external_llm: an explicitly surfaced cloud engine, disclosed in Settings →
Spoken voice). Nothing else rides along: no room name, no files, no history
— only the sentence text. A failure (offline, service refused) surfaces as
an error and the webview skips that sentence; there is no fallback voice.

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
import re
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


# --- the voice catalog -------------------------------------------------------

#: Last catalog successfully fetched from the service — served when a
#: re-fetch fails, so Settings keeps its voice list through a network blip.
#: Process-lifetime only; never persisted, never hard-coded.
_voices_cache: list[dict[str, str]] | None = None


async def list_neural_voices() -> list[dict[str, str]]:
    """The service's full live voice catalog, trimmed to what the picker
    needs — ``{id, gender, locale}`` per voice, sorted by id.

    Dynamic on purpose (user decision 2026-08-01): no bundled roster. A
    voice is vetted by the user listening to it (Settings → Preview), not
    by pre-testing here. The fetch carries no room data — only the request
    itself leaves the Mac. On failure the last good catalog is served if
    one exists; otherwise :class:`TtsError`.
    """
    global _voices_cache
    import edge_tts  # deferred: keeps module import (and tests) offline-safe

    try:
        raw = await edge_tts.list_voices()
    except Exception as exc:  # offline, service refused — one surface
        if _voices_cache is not None:
            return _voices_cache
        raise TtsError(f"voice catalog unavailable: {exc}") from exc
    voices = sorted(
        (
            {
                "id": v.get("ShortName", ""),
                "gender": v.get("Gender", ""),
                "locale": v.get("Locale", ""),
            }
            for v in raw
            if v.get("ShortName")
        ),
        key=lambda v: v["id"],
    )
    _voices_cache = voices
    return voices


# --- synthesis ---------------------------------------------------------------


async def warm_import() -> None:
    """Pull ``edge_tts`` into the interpreter off the request path.

    The import below is deferred so this module stays offline-safe to import —
    that part is right and stays. What was wrong is WHERE it was paid: the first
    spoken sentence of a session ran it synchronously inside the asyncio loop
    that also serves the chat stream, so every in-flight request stalled behind
    a ~130 ms disk-and-bytecode load for a feature only one of them was using.

    A secondary feature must never stall the primary path. Best-effort by
    design: nothing here reaches the network (that is `Communicate`, at call
    time, and pre-opening it would spend the room's internet switch before
    anyone asked for speech). If the import fails, the call site fails exactly
    as it does today and the webview reports it once per turn.
    """
    import importlib

    try:
        await asyncio.to_thread(importlib.import_module, "edge_tts")
    except Exception:  # not installed, or a broken install — the call site says so
        pass


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


def mp3_to_wav(mp3_bytes: bytes, sample_rate: int | None = None) -> bytes:
    """Decode MP3 → mono 16-bit WAV with macOS's own afconvert.

    ``sample_rate`` forces the output rate. Left None (the spoken-answer path)
    afconvert keeps whatever the source had, which is right when the bytes are
    played and discarded one sentence at a time. The PODCAST path must pass a
    rate: it CONCATENATES clips from several different voices, and a stream
    whose header says 24 kHz while some frames were written at another rate
    plays those turns at the wrong speed — a chipmunk halfway through the
    episode, with nothing in any error path to explain it.
    """
    import subprocess

    with tempfile.TemporaryDirectory(prefix="pr-tts-") as td:
        src = Path(td) / "in.mp3"
        dst = Path(td) / "out.wav"
        src.write_bytes(mp3_bytes)
        cmd = [AFCONVERT, "-f", "WAVE", "-d", "LEI16", "-c", "1"]
        if sample_rate:
            cmd += ["-r", str(sample_rate)]
        proc = subprocess.run(
            [*cmd, str(src), str(dst)],
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


# --- podcast: many voices, one episode ---------------------------------------

#: Every clip in an episode is decoded to this rate before being joined. Edge
#: returns 24 kHz; forcing it makes the concatenation correct even if a voice
#: (or the service) ever returns something else.
PODCAST_SAMPLE_RATE = 24_000


#: Mid-clause break characters, the same set the frontend chunker uses
#: (``SOFT_BREAKS`` in workspace/voice.ts). The ideographic and fullwidth forms
#: are what make the last resort work at all in Chinese and Japanese, which
#: write no spaces: cutting on ASCII whitespace alone handed a whole CJK turn
#: back as one over-limit piece.
SOFT_BREAKS = ",;: 、，；："

#: Sentence ends. The ASCII ones are followed by whitespace; the CJK ones are
#: not, so they are matched on their own.
_SENTENCE_END = re.compile(r"(?<=[.!?…])\s+|(?<=[。！？])")


def _break_at(window: str) -> int:
    """Where to cut ``window``: just past its last break character, or its whole
    length when it holds none. Never 0 for a NON-EMPTY window, which is what
    lets :func:`split_for_tts` loop on it — its window is ``chunk[:limit]``
    taken only while ``len(chunk) > limit``, so it is empty only for a
    non-positive ``limit``, which no caller passes."""
    at = max((window.rfind(ch) for ch in SOFT_BREAKS), default=-1)
    return at + 1 if at > 0 else len(window)


def _flush_tts_piece(pieces: list[str], current: str) -> str:
    """Append a buffered piece when it exists and reset that buffer."""
    if current:
        pieces.append(current)
    return ""


def _split_overlimit_tts_chunk(chunk: str, limit: int) -> tuple[list[str], str]:
    """Return complete safe pieces and the final short remainder of ``chunk``."""
    pieces: list[str] = []
    while len(chunk) > limit:
        cut = _break_at(chunk[:limit])
        head = chunk[:cut].strip()
        if head:
            pieces.append(head)
        chunk = chunk[cut:].lstrip()
    return pieces, chunk


def _buffer_tts_chunk(pieces: list[str], current: str, chunk: str, limit: int) -> str:
    """Add a sentence-sized chunk to its piece buffer without crossing ``limit``."""
    if current and len(current) + 1 + len(chunk) > limit:
        pieces.append(current)
        return chunk
    return f"{current} {chunk}".strip()


def _place_tts_chunk(pieces: list[str], current: str, chunk: str, limit: int) -> str:
    """Record an over-limit chunk or buffer a sentence-sized one."""
    if len(chunk) <= limit:
        return _buffer_tts_chunk(pieces, current, chunk, limit)
    current = _flush_tts_piece(pieces, current)
    complete, remainder = _split_overlimit_tts_chunk(chunk, limit)
    pieces.extend(complete)
    return remainder


def split_for_tts(text: str, limit: int = MAX_TTS_CHARS) -> list[str]:
    """Break one turn into pieces the service will accept, on sentence ends.

    A podcast turn is written by a model told to keep it short, but "short" is
    not a guarantee, and one long turn would fail the whole episode at
    :data:`MAX_TTS_CHARS`. Splitting on sentence boundaries keeps the prosody
    right — a cut mid-clause is audible, a cut between sentences is not.

    A single sentence longer than the limit is cut on a break character as a
    last resort, and on the character count when it holds none; there is no way
    to say it in one call, and dropping it would lose the line silently. EVERY
    piece is at most ``limit`` — a turn written in Chinese or Japanese has no
    ASCII space to cut on, and used to come back whole and over the limit.
    """
    text = " ".join(text.split())
    if not text:
        return []
    if len(text) <= limit:
        return [text]
    pieces: list[str] = []
    current = ""
    # Keep the terminator with its sentence — "Yes." must not become "Yes" "."
    for chunk in _SENTENCE_END.split(text):
        # The CJK terminator is matched with no width, so the space after
        # "。 " stays on the front of the next sentence and would be doubled by
        # the join below.
        chunk = chunk.strip()
        if not chunk:
            continue
        current = _place_tts_chunk(pieces, current, chunk, limit)
    _flush_tts_piece(pieces, current)
    return pieces


def _wav_frames(wav_bytes: bytes) -> tuple[bytes, int]:
    """(raw mono 16-bit frames, sample rate) — the joinable part of a WAV."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as r:
        if r.getsampwidth() != 2 or r.getnchannels() != 1:
            raise TtsError("expected mono 16-bit WAV from afconvert")
        return r.readframes(r.getnframes()), r.getframerate()


def _wav_from_frames(frames: bytes, fs: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(fs)
        w.writeframes(frames)
    return buf.getvalue()


def _podcast_gap(gap_ms: int) -> bytes:
    return b"\x00\x00" * int(PODCAST_SAMPLE_RATE * max(0, gap_ms) / 1000)


def _podcast_offset_ms(frames: bytearray) -> int:
    return int(len(frames) / 2 / PODCAST_SAMPLE_RATE * 1000)


def _podcast_turn_settings(turn: dict[str, str]) -> tuple[str, str, str]:
    return (
        turn.get("voice") or DEFAULT_VOICE,
        turn.get("rate") or DEFAULT_RATE,
        turn.get("pitch") or DEFAULT_PITCH,
    )


async def _append_podcast_pieces(
    frames: bytearray, text: str, voice: str, rate: str, pitch: str
) -> None:
    for piece in split_for_tts(text):
        mp3 = await synthesize_mp3(piece, voice, rate, pitch)
        wav = await asyncio.to_thread(mp3_to_wav, mp3, PODCAST_SAMPLE_RATE)
        clip, fs = await asyncio.to_thread(_wav_frames, wav)
        if fs != PODCAST_SAMPLE_RATE:  # afconvert was asked; belt and braces
            raise TtsError(f"voice {voice} decoded at {fs} Hz, expected {PODCAST_SAMPLE_RATE}")
        frames.extend(clip)


async def _append_podcast_turn(
    frames: bytearray, turn: dict[str, str], index: int, gap_frames: bytes
) -> int:
    text = (turn.get("text") or "").strip()
    offset = _podcast_offset_ms(frames)
    if not text:
        return offset
    if index:
        frames.extend(gap_frames)
        offset = _podcast_offset_ms(frames)
    voice, rate, pitch = _podcast_turn_settings(turn)
    await _append_podcast_pieces(frames, text, voice, rate, pitch)
    return offset


async def _normalized_podcast(frames: bytearray) -> tuple[bytes, int]:
    duration_ms = _podcast_offset_ms(frames)
    mixed = _wav_from_frames(bytes(frames), PODCAST_SAMPLE_RATE)
    normalized = await asyncio.to_thread(normalize_wav, mixed, TARGET_LUFS)
    return normalized, duration_ms


async def synthesize_podcast(
    turns: list[dict[str, str]],
    gap_ms: int = 420,
) -> tuple[bytes, list[int], int]:
    """A whole episode: ``(wav_bytes, per-turn start offsets in ms, duration ms)``.

    Each turn is synthesized in ITS OWN voice, the clips are joined with a beat
    of silence between them, and the finished mix is loudness-normalized ONCE.

    That last word is the design. Normalizing per turn — which is what looping
    ``/tts`` would do — sets every clip to the same target independently, so
    each change of speaker lands at a slightly different level and the result
    sounds assembled rather than recorded. Measuring the whole episode instead
    keeps the relative dynamics between the two voices intact.

    Offsets are computed from the frames actually written, not from an estimate,
    so the transcript the caller builds from them lines up with the audio to the
    sample.
    """
    if not turns:
        raise TtsError("a podcast needs at least one turn")
    gap_frames = _podcast_gap(gap_ms)
    frames = bytearray()
    offsets: list[int] = []
    for index, turn in enumerate(turns):
        offsets.append(await _append_podcast_turn(frames, turn, index, gap_frames))
    if not frames:
        raise TtsError("every turn was empty — nothing to record")
    wav, duration_ms = await _normalized_podcast(frames)
    return wav, offsets, duration_ms


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


def _mean_square(samples: list[float]) -> float:
    return sum(sample * sample for sample in samples) / max(1, len(samples))


def _mean(values: list[float]) -> float:
    return sum(values) / max(1, len(values))


def _lufs_for_power(mean_square: float, silence_lufs: float) -> float:
    if mean_square > 0:
        return -0.691 + 10.0 * math.log10(mean_square)
    return silence_lufs


def _k_weighted_samples(samples: list[float], fs: int) -> list[float]:
    return _biquad(_biquad(samples, _shelf_coeffs(fs)), _highpass_coeffs(fs))


def _block_powers(samples: list[float], block: int) -> list[float]:
    hop = block // 4  # 75% overlap
    return [
        _mean_square(samples[start : start + block])
        for start in range(0, len(samples) - block + 1, hop)
    ]


def _block_loudness(powers: list[float]) -> list[float]:
    return [_lufs_for_power(power, -200.0) for power in powers]


def _absolute_gated_powers(powers: list[float], loudness: list[float]) -> list[float]:
    return [power for power, lufs in zip(powers, loudness) if lufs > -70.0]


def _relative_gate(powers: list[float]) -> float:
    return _lufs_for_power(_mean(powers), -200.0) - 10.0


def _relative_gated_powers(
    powers: list[float], loudness: list[float], relative_gate: float
) -> list[float]:
    return [
        power
        for power, lufs in zip(powers, loudness)
        if lufs > -70.0 and lufs > relative_gate
    ]


def _gated_lufs(samples: list[float], block: int) -> float:
    powers = _block_powers(samples, block)
    loudness = _block_loudness(powers)
    absolute_gated = _absolute_gated_powers(powers, loudness)
    if not absolute_gated:
        return -70.0
    relative_gated = _relative_gated_powers(
        powers, loudness, _relative_gate(absolute_gated)
    )
    selected = relative_gated or absolute_gated
    return _lufs_for_power(_mean(selected), -200.0)


def measure_lufs(samples: list[float], fs: int) -> float:
    """Integrated loudness (LUFS) of mono float samples, BS.1770-4 gated.

    Signals shorter than one 400 ms gating block fall back to the ungated
    mean square — sentence fragments must still normalize sanely.
    """
    k_weighted = _k_weighted_samples(samples, fs)
    block = int(0.4 * fs)
    if len(k_weighted) < block or block == 0:
        return _lufs_for_power(_mean_square(k_weighted), -70.0)
    return _gated_lufs(k_weighted, block)


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
