"""Speaker embedding, neural inference, and DSP fallback for meeting lanes.

The numerical pipeline remains a faithful Python port of the Rust fbank,
TitaNet, and diarization implementations. Embedding-space value types and
comparison rules live in :mod:`arcelle_sidecar.diar.embed_types`.
"""

from __future__ import annotations

import math
import time

import numpy as np
import onnxruntime as ort

from arcelle_sidecar.diar.embed_types import (
    DSP_GATES as DSP_GATES,
    EMB_DIM,
    MIN_NEW_VOICE_FRAMES as MIN_NEW_VOICE_FRAMES,
    NEURAL_GATES as NEURAL_GATES,
    Gates as Gates,
    VoicePrint,
    cosine as cosine,
    gates_for as gates_for,
    is_neural as is_neural,
)

# ---- Fbank: the exact log-mel front end TitaNet was trained with -----------
# Ported from fbank.rs. Change nothing here without re-validating against the
# onnxruntime parity check the Rust comment describes (max feature diff
# < 1e-4, embedding cosine 1.000000).

# Fbank constants are prefixed because its 400-sample window differs from the
# DSP fallback's 512-sample window below.
FBANK_SR: float = 16000.0
FBANK_WIN: int = 400  # 25 ms
FBANK_SHIFT: int = 160  # 10 ms
FBANK_NFFT: int = 512
NBINS: int = 80  # `pub const NBINS` in fbank.rs -- shared with titanet.rs.

_TAU = 2.0 * math.pi


def mel_slaney(f: float) -> float:
    """Slaney-scale Hz -> mel (librosa's scale, NOT the HTK scale below)."""
    if f <= 1000.0:
        return f * 3.0 / 200.0
    return 15.0 + 14.545_078 * math.log(f / 1000.0)


def inv_mel_slaney(m: float) -> float:
    """Slaney-scale mel -> Hz, the inverse of :func:`mel_slaney`."""
    if m <= 15.0:
        return 200.0 / 3.0 * m
    return 1000.0 * math.exp((m - 15.0) * 0.068_751_777)


def _mel_triangle_weight(hz: float, left: float, center: float, right: float) -> float:
    if hz <= center:
        weight = (hz - left) / (center - left)
    else:
        weight = (right - hz) / (right - center)
    return weight * 2.0 / (right - left)  # Slaney norm


def _sparse_mel_bank(
    left: float, center: float, right: float, fft_bin_width: float
) -> tuple[int, np.ndarray]:
    bins = [
        (i, fft_bin_width * i)
        for i in range(FBANK_NFFT // 2 + 1)
        if left < fft_bin_width * i < right
    ]
    if not bins:
        raise ValueError("empty mel bin")
    first = bins[0][0]
    weights = [_mel_triangle_weight(hz, left, center, right) for _, hz in bins]
    return first, np.asarray(weights, dtype=np.float32)


def mel_banks() -> list[tuple[int, np.ndarray]]:
    """Sparse triangular filters: (first FFT bin, weights).

    Slaney-normalized so each triangle integrates to the same area, exactly
    as librosa builds them. Unlike kaldi, the Nyquist bin (index NFFT/2) is
    included.
    """
    fft_bin_width = FBANK_SR / FBANK_NFFT
    mlo, mhi = mel_slaney(0.0), mel_slaney(FBANK_SR / 2.0)
    delta = (mhi - mlo) / (NBINS + 1)
    banks: list[tuple[int, np.ndarray]] = []
    for b in range(NBINS):
        left = inv_mel_slaney(mlo + b * delta)
        center = inv_mel_slaney(mlo + (b + 1) * delta)
        right = inv_mel_slaney(mlo + (b + 2) * delta)
        banks.append(_sparse_mel_bank(left, center, right, fft_bin_width))
    return banks


class Fbank:
    """The log-mel front end: 25 ms/10 ms frames, snip_edges, no dither, no
    DC removal, descending in-place preemphasis (see the comment in
    :meth:`compute`), a periodic Hann window, a 512-point power spectrum
    keeping bins 0..=256, and 80 Slaney-scale mel triangles.
    """

    def __init__(self) -> None:
        # periodic hann: 0.5 - 0.5*cos(2*pi*i/N) -- denominator N, NOT N-1.
        i = np.arange(FBANK_WIN, dtype=np.float64)
        self.window: np.ndarray = (0.5 - 0.5 * np.cos(_TAU * i / FBANK_WIN)).astype(
            np.float32
        )
        self.banks: list[tuple[int, np.ndarray]] = mel_banks()
        # Dense (NBINS, NFFT//2+1) matrix built from the sparse banks so the
        # whole utterance's mel energies are one matmul instead of an
        # 80-bank Python loop per frame.
        n_fft_bins = FBANK_NFFT // 2 + 1
        dense = np.zeros((NBINS, n_fft_bins), dtype=np.float32)
        for row, (first, w) in enumerate(self.banks):
            dense[row, first : first + len(w)] = w
        self._mel_matrix = dense

    def compute(self, samples: np.ndarray) -> tuple[int, np.ndarray]:
        """(num_frames, flat features num_frames*80) for a whole utterance."""
        samples = np.asarray(samples, dtype=np.float32)
        n = samples.shape[0]
        # snip_edges: only frames that fit entirely inside the signal.
        num_frames = 0 if n < FBANK_WIN else 1 + (n - FBANK_WIN) // FBANK_SHIFT
        if num_frames == 0:
            return 0, np.zeros(0, dtype=np.float32)

        idx = np.arange(FBANK_WIN, dtype=np.int64)[None, :] + FBANK_SHIFT * np.arange(
            num_frames, dtype=np.int64
        )[:, None]
        frames = samples[idx]  # (num_frames, FBANK_WIN), fancy-index copy

        # preemphasis 0.97. The Rust loop runs i = WIN-1 downto 1 doing
        # `frame[i] -= 0.97 * frame[i - 1]` IN PLACE, then
        # `frame[0] -= 0.97 * frame[0]`. Read carefully: because the loop is
        # DESCENDING, every read of `frame[i - 1]` happens strictly BEFORE
        # that slot is itself written (a slot k is only ever written at
        # iteration i == k, which — since i counts down — happens AFTER the
        # iteration i == k + 1 that read it). So despite being in-place,
        # every read sees the pristine original sample: this is exactly the
        # ordinary non-recursive FIR filter y[i] = x[i] - 0.97*x[i-1],
        # y[0] = x[0] - 0.97*x[0] = 0.03*x[0] — fully vectorizable per row.
        # (An ASCENDING port of the same-looking loop would instead be a
        # completely different recursive IIR filter — a real trap.)
        pre = np.empty_like(frames)
        pre[:, 1:] = frames[:, 1:] - np.float32(0.97) * frames[:, :-1]
        pre[:, 0] = frames[:, 0] - np.float32(0.97) * frames[:, 0]

        windowed = pre * self.window[None, :]
        full = np.zeros((num_frames, FBANK_NFFT), dtype=np.float32)
        full[:, :FBANK_WIN] = windowed

        # Power spectrum via a real FFT (float64 internally, matching the
        # Rust hand-rolled FFT's own f64 working precision -- see module
        # docstring). rfft naturally returns exactly NFFT//2+1 = 257 bins,
        # i.e. bins 0..=256 inclusive, Nyquist included.
        spectrum = np.fft.rfft(full.astype(np.float64), n=FBANK_NFFT, axis=1)
        power = (spectrum.real**2 + spectrum.imag**2).astype(np.float32)

        energy = power @ self._mel_matrix.T  # (num_frames, NBINS)
        eps = np.finfo(np.float32).eps  # Rust's `f32::EPSILON`, not a bare 1e-9.
        feats = np.log(np.maximum(energy, eps)).astype(np.float32)
        return num_frames, feats.reshape(-1)


# ---- TitaNet-small speaker embedding (ONNX) ---------------------------------
# Ported from titanet.rs. Everything here is infallible-by-None: a missing or
# broken model file must never break a recording, so the caller falls back
# to the DSP print.

# The bundled model file name, for reference only (path RESOLUTION --
# MODEL_FILE/set_model_path/model_path() in diarize.rs lines 89-100 -- is a
# host-app concern in this rewrite, not this module's; callers pass the
# resolved path directly).
MODEL_FILE: str = "nemo_en_titanet_small.onnx"

# One onnxruntime session per model path, loaded once and reused. Mirrors
# the Rust `OnceLock<Mutex<HashMap<PathBuf, Option<Model>>>>` cache, minus the
# mutex: embedding runs on worker threads (the live engine's decode task and
# the offline rebuild both reach here through `asyncio.to_thread`, and the two
# can overlap), but every operation below is a single atomic dict get/set/pop.
# The only thing a race can cost is one duplicated load whose loser is dropped
# -- wasteful, never wrong -- and an onnxruntime session is itself safe to
# `run()` from several threads.
#
# SUCCESSES only. The Rust cache also stored a FAILED load, as `None`, and
# this port used to do the same with a `path in _MODEL_CACHE` membership
# test -- which made ONE failure permanent for the life of the process: a
# model file that was still being copied into place, a path the host had not
# finished resolving, or a transient onnxruntime error during the very first
# phrase of the very first recording silently downgraded EVERY later phrase,
# in every later recording, to the 21-dim DSP print. That is not a cosmetic
# regression: `identity_print` needs 192 dims, so cross-recording recognition
# and saved-voice enrollment stop working entirely, with nothing in the UI to
# say why, until the app is restarted. Failures are now retryable.
_MODEL_CACHE: dict[str, ort.InferenceSession] = {}

#: When the most recent load attempt for a path FAILED (``time.monotonic()``),
#: so the retry above can be rate-limited.
_MODEL_FAILED_AT: dict[str, float] = {}

#: How long a failed load suppresses the next attempt for that same path.
#:
#: The reason the old cache existed at all is real and is preserved here:
#: :func:`_model_for` sits on a per-phrase hot path (:func:`titanet_embed`
#: runs it for every 2 s window), and retrying a missing or corrupt 40 MB
#: ONNX file on every window would burn real time to fail the same way.
#: A window of this length costs at most one failed load attempt per half
#: minute of audio -- unmeasurable next to the decode -- while a model that
#: appears (or a path that becomes readable) is picked up within the same
#: recording instead of never.
MODEL_RETRY_SECS: float = 30.0


def _model_for(path: str) -> ort.InferenceSession | None:
    """The loaded ONNX session for `path`, or ``None`` when it cannot be
    loaded right now.

    Never raises: every caller here is infallible-by-``None`` and a broken
    model must degrade to the DSP print, never break a recording.
    """
    session = _MODEL_CACHE.get(path)
    if session is not None:
        return session
    failed_at = _MODEL_FAILED_AT.get(path)
    if failed_at is not None and time.monotonic() - failed_at < MODEL_RETRY_SECS:
        return None
    try:
        session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    except Exception:
        # Stamped AFTER the attempt, not before it: a slow failure (a large
        # corrupt file onnxruntime chews on for seconds) must still leave a
        # full quiet window behind it, or a hot path could spend most of its
        # time inside failing loads.
        _MODEL_FAILED_AT[path] = time.monotonic()
        return None
    _MODEL_CACHE[path] = session
    _MODEL_FAILED_AT.pop(path, None)
    return session


def neural_ready(model_path: str) -> bool:
    """Whether NEURAL embedding is actually active for `model_path` right now.

    :func:`is_neural` answers a different question -- which space a vector
    that already exists lives in -- and cannot be asked before there is a
    vector, or when a phrase was silent. This one asks the model-load state
    directly, which is what a caller needs in order to tell the user whether
    the speakers it just derived carry a real voiceprint (192-dim TitaNet,
    comparable across recordings) or the DSP fallback (which cannot be
    enrolled or recognised later).

    Loads the model if it is not loaded yet -- so ask it once per job, never
    per phrase -- and answers ``False`` for an empty path, a missing file, or
    a path whose last load failed inside :data:`MODEL_RETRY_SECS`. Never
    raises.
    """
    if not model_path:
        return False
    return _model_for(model_path) is not None


# One shared Fbank instance (mirrors the Rust `static FBANK: OnceLock<Fbank>`
# inside titanet::embed) so the mel filterbank isn't rebuilt every phrase.
_FBANK: Fbank | None = None


def _get_fbank() -> Fbank:
    global _FBANK
    if _FBANK is None:
        _FBANK = Fbank()
    return _FBANK


def titanet_embed(model_path: str, samples: np.ndarray) -> np.ndarray | None:
    """The phrase's L2-normalized 192-dim speaker embedding, or ``None`` on
    ANY failure (no model at `model_path`, too little audio, inference
    error) — infallible-by-``None`` exactly like Rust's ``titanet::embed``.
    """
    session = _model_for(model_path)
    if session is None:
        return None

    fbank = _get_fbank()
    t, flat_feats = fbank.compute(np.asarray(samples, dtype=np.float32))
    if t < 2:
        return None  # per-feature normalization needs a distribution

    feats = flat_feats.reshape(t, NBINS)
    # per_feature normalization: over time, per mel bin.
    mean = feats.mean(axis=0)
    sd = np.sqrt(((feats - mean) ** 2).mean(axis=0))
    sd = np.maximum(sd, np.finfo(np.float32).eps)
    feats = (feats - mean) / sd

    # Pad the frame count to a multiple of 16 with zero rows; the "length"
    # input carries the UNPADDED count so the model masks the padding out.
    tt = t + (16 - t % 16) % 16
    if tt > t:
        feats = np.concatenate(
            [feats, np.zeros((tt - t, NBINS), dtype=np.float32)], axis=0
        )

    # transpose (T, 80) -> (1, 80, T)
    x = np.ascontiguousarray(feats.T[np.newaxis, :, :], dtype=np.float32)
    length = np.array([t], dtype=np.int64)

    try:
        # outputs = [logits, embs[1, 192]]; asked for by name (see module
        # docstring) rather than Rust's positional `out.get(1)`.
        (emb_out,) = session.run(["embs"], {"audio_signal": x, "length": length})
    except Exception:
        return None

    emb = np.asarray(emb_out, dtype=np.float32).reshape(-1)
    if emb.shape[0] != EMB_DIM:
        return None
    norm = float(np.sqrt(np.sum(emb.astype(np.float64) ** 2)))
    norm = max(norm, 1e-9)
    return (emb / norm).astype(np.float32)


# ---- The DSP fallback voiceprint --------------------------------------------
# Ported from diarize.rs. Used only when the bundled TitaNet model is
# missing or inference fails -- a missing model must never break a
# recording.

SAMPLE_RATE: int = 16000

# Analysis window for the DSP voiceprint (32 ms) and its hop (16 ms). The hop
# also defines the unit of VoicePrint.voiced_frames for BOTH print
# generations -- the evidence gate must not move when the embedding does.
WIN: int = 512
HOP: int = 256
# Mel-spaced bands between 100 Hz and 4 kHz -- where voices differ.
BANDS: int = 20
# Frames quieter than this contribute nothing (pauses must not dilute a print).
VOICED_RMS: float = 0.004

# Pitch dims of the DSP fallback print. The F0 search runs over 60-400 Hz;
# the phrase statistic is then clamped to 70-320 Hz -- where speech actually
# lives -- before encoding.
F0_MIN_LAG: int = SAMPLE_RATE // 400
F0_MAX_LAG: int = SAMPLE_RATE // 60
F0_CLAMP: tuple[float, float] = (70.0, 320.0)
# A frame's normalized autocorrelation peak must reach this to count as
# pitched -- the shared mic's noise floor stays below it, breathy speech too.
PITCH_MIN_CORR: float = 0.6
# Log2-F0 becomes an angle at this many radians per octave, appended as
# (cos, sin). Steep enough that a few semitones between two speakers scores
# clearly unlike (~0.6 octave -> cos ~= 0.36) while one speaker's own pitch
# wobble stays alike (0.15 octave -> cos ~= 0.95). The clamp above keeps the
# whole arc short of wrapping back to +1.
PITCH_RAD_PER_OCTAVE: float = 2.0
# Norm of the two pitch dims relative to the unit-norm band deltas: pitch
# carries w^2/(1+w^2) ~= 26% of the cosine -- enough to reopen the
# shared-mic split, not enough to let a pitch wobble break a monologue apart.
PITCH_WEIGHT: float = 0.6
# Pitched frames for the pitch dims to carry full weight (~0.3 s); below
# that they fade out linearly rather than assert a pitch from a hiss.
MIN_PITCHED_FRAMES: int = 20
def hz_to_mel(hz: float) -> float:
    """HTK-style mel scale -- DIFFERENT from fbank.rs's Slaney scale above;
    this one is only for the DSP fallback's band centers, never confuse the
    two."""
    return 2595.0 * math.log10(1.0 + hz / 700.0)


def mel_to_hz(mel: float) -> float:
    return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)


def band_centers() -> np.ndarray:
    """Band-center frequencies, mel-spaced (20 bands, 100 Hz-4 kHz)."""
    lo, hi = hz_to_mel(100.0), hz_to_mel(4000.0)
    out = np.zeros(BANDS, dtype=np.float32)
    for i in range(BANDS):
        mel = lo + (hi - lo) * (i + 0.5) / BANDS
        out[i] = mel_to_hz(mel)
    return out


def bin_energy(frame: np.ndarray, freq: float) -> float:
    """Single-bin DFT magnitude at `freq` over a Hann-windowed frame -- 20
    bins x a few dozen frames per phrase is trivially cheap, so no FFT dep
    is needed."""
    frame = np.asarray(frame, dtype=np.float64)
    n = frame.shape[0]
    w = _TAU * freq / SAMPLE_RATE
    i = np.arange(n, dtype=np.float64)
    # Hann window keeps neighboring voices' bands from smearing together.
    hann = 0.5 - 0.5 * np.cos(_TAU * i / n)
    x = frame * hann
    phase = w * i
    re = float(np.sum(x * np.cos(phase)))
    im = -float(np.sum(x * np.sin(phase)))
    return (re * re + im * im) / n


def frame_f0(frame: np.ndarray) -> float | None:
    """Confident F0 of one frame, by normalized autocorrelation over the
    60-400 Hz lag range on the raw (unwindowed) frame. ``None`` for
    unpitched frames -- noise, fricatives, the room's hum. Among near-tied
    peaks the shortest lag wins, which corrects the classic octave-down
    error."""
    frame = np.asarray(frame, dtype=np.float64)
    n = frame.shape[0]
    mean = float(np.mean(frame))
    x = frame - mean
    # Prefix sums make each lag's two energy terms O(1); only the dot is O(n).
    sq = np.concatenate(([0.0], np.cumsum(x * x)))
    hi = min(F0_MAX_LAG, n - 1)
    rs = np.zeros(hi + 1, dtype=np.float64)
    best_r = 0.0
    best_lag = 0
    for lag in range(F0_MIN_LAG, hi + 1):
        m = n - lag
        dot = float(np.dot(x[:m], x[lag : lag + m]))
        denom = math.sqrt(max(sq[m] * (sq[n] - sq[lag]), 0.0))
        denom = max(denom, 1e-9)
        r = dot / denom
        rs[lag] = r
        if r > best_r:
            best_r = r
            best_lag = lag
    if best_r < PITCH_MIN_CORR:
        return None
    lag = best_lag
    for candidate in range(F0_MIN_LAG, best_lag):
        if rs[candidate] >= 0.87 * best_r:
            lag = candidate
            break
    return SAMPLE_RATE / lag


def pitch_dims(f0s: list[float]) -> np.ndarray:
    """The 2 pitch dims: the phrase's lower-quartile F0 as a point on an arc
    (so cosine compares pitch by angular distance), scaled by
    :data:`PITCH_WEIGHT` and faded by how much confidently-pitched speech
    backs it. The lower quartile, not the median: a speaker's pitch FLOOR is
    a trait, while the middle of the range moves with prosody."""
    if not f0s:
        return np.zeros(2, dtype=np.float32)
    ordered = sorted(f0s)
    floor = ordered[len(ordered) // 4]
    floor = max(min(floor, F0_CLAMP[1]), F0_CLAMP[0])  # .clamp(lo, hi)
    theta = PITCH_RAD_PER_OCTAVE * math.log2(floor / F0_CLAMP[0])
    pitch_confidence = PITCH_WEIGHT * min(len(f0s) / MIN_PITCHED_FRAMES, 1.0)
    return np.asarray(
        [pitch_confidence * math.cos(theta), pitch_confidence * math.sin(theta)],
        dtype=np.float32,
    )


def _frame_view(samples: np.ndarray, win: int, hop: int) -> np.ndarray:
    """(num_frames, win) view of `samples` framed at hop `hop`, only frames
    that fit entirely inside the signal (matches the `while pos + WIN <=
    len` loop shape used throughout the Rust DSP fallback)."""
    n = samples.shape[0]
    if n < win:
        return np.zeros((0, win), dtype=samples.dtype)
    num = (n - win) // hop + 1
    idx = np.arange(win, dtype=np.int64)[None, :] + hop * np.arange(num, dtype=np.int64)[:, None]
    return samples[idx]


def count_voiced(samples: np.ndarray) -> int:
    """Voiced 32 ms/16 ms frames in the phrase -- the evidence measure
    behind :meth:`VoicePrint.is_strong`, computed the same way for both
    print generations."""
    frames = _frame_view(np.asarray(samples, dtype=np.float32), WIN, HOP)
    if frames.shape[0] == 0:
        return 0
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
    return int(np.sum(rms >= VOICED_RMS))


# Sub-window for long phrases (2 s, 1 s hop): production diarizers embed
# fixed 1.5-3 s windows, never whole variable-length phrases.
EMB_WIN: int = SAMPLE_RATE * 2
EMB_HOP: int = SAMPLE_RATE


def _window_embedding(model_path: str, samples: np.ndarray) -> np.ndarray | None:
    if len(samples) < EMB_WIN // 2:
        return None
    if count_voiced(samples) * HOP < len(samples) // 4:
        return None
    return titanet_embed(model_path, samples)


def _long_phrase_embeddings(
    model_path: str, samples: np.ndarray
) -> tuple[np.ndarray, int]:
    acc = np.zeros(EMB_DIM, dtype=np.float64)
    count = 0
    pos = 0
    total = samples.shape[0]
    while pos < total:
        end = min(pos + EMB_WIN, total)
        embedding = _window_embedding(model_path, samples[pos:end])
        if embedding is not None:
            acc += embedding.astype(np.float64)
            count += 1
        if end == total:
            break
        pos += EMB_HOP
    return acc, count


def _normalized_embedding_sum(acc: np.ndarray) -> np.ndarray:
    norm = max(float(np.sqrt(np.sum(acc * acc))), 1e-9)
    return (acc / norm).astype(np.float32)


def dsp_embed(samples: np.ndarray) -> VoicePrint:
    """The fallback DSP voiceprint: band-to-band deltas of the mean log-mel
    envelope (differencing removes overall loudness and constant spectral
    tilt, leaving formant shape), then two pitch dims."""
    samples = np.asarray(samples, dtype=np.float32)
    centers = band_centers()
    means = np.zeros(BANDS, dtype=np.float64)
    frames_count = 0
    f0s: list[float] = []
    n = samples.shape[0]
    pos = 0
    while pos + WIN <= n:
        frame = samples[pos : pos + WIN]
        pos += HOP
        rms = math.sqrt(float(np.mean(frame.astype(np.float64) ** 2)))
        if rms < VOICED_RMS:
            continue
        frames_count += 1
        for b in range(BANDS):
            means[b] += math.log(bin_energy(frame, float(centers[b])) + 1e-9)
        f0 = frame_f0(frame)
        if f0 is not None:
            f0s.append(f0)

    if frames_count == 0:
        return VoicePrint(vec=np.zeros(BANDS + 1, dtype=np.float32), voiced_frames=0)

    nf = float(frames_count)
    env = means / nf
    v = np.diff(env).astype(np.float32)  # BANDS-1 dims
    norm = max(float(np.sqrt(np.sum(v.astype(np.float64) ** 2))), 1e-6)
    v = v / norm
    # Band deltas at unit norm, pitch at PITCH_WEIGHT, then the whole vector
    # renormalized so cosine stays a plain dot product.
    v = np.concatenate([v, pitch_dims(f0s)]).astype(np.float32)
    norm2 = max(float(np.sqrt(np.sum(v.astype(np.float64) ** 2))), 1e-6)
    v = (v / norm2).astype(np.float32)
    return VoicePrint(vec=v, voiced_frames=frames_count)


def neural_embed(model_path: str, samples: np.ndarray) -> np.ndarray | None:
    """One neural print for the phrase: the renormalized average of its 2 s
    window embeddings (windows that are mostly silence are skipped -- they
    embed the room, not the person), or a single whole-phrase embedding when
    the phrase is short."""
    samples = np.asarray(samples, dtype=np.float32)
    total = samples.shape[0]
    if total <= EMB_WIN + EMB_HOP // 2:
        return titanet_embed(model_path, samples)

    acc, n = _long_phrase_embeddings(model_path, samples)

    if n == 0:
        return titanet_embed(model_path, samples)

    return _normalized_embedding_sum(acc)


def embed_at(model_path: str, samples: np.ndarray) -> VoicePrint:
    """The phrase's voiceprint: a TitaNet embedding when the bundled model
    is available (at `model_path`), else the DSP print -- silently, because
    a missing model must never break a recording. Silence embeds to
    all-zeros."""
    samples = np.asarray(samples, dtype=np.float32)
    voiced_frames = count_voiced(samples)
    if voiced_frames == 0:
        return VoicePrint(vec=np.zeros(BANDS + 1, dtype=np.float32), voiced_frames=0)
    vec = neural_embed(model_path, samples)
    if vec is not None:
        return VoicePrint(vec=vec, voiced_frames=voiced_frames)
    return dsp_embed(samples)


def embed(model_path: str, samples: np.ndarray) -> VoicePrint:
    """Convenience alias for :func:`embed_at` (Rust's ``embed`` resolves the
    model path itself via a process-wide ``OnceLock``; that path-resolution
    singleton is host-app wiring out of this module's scope in the rewrite,
    so callers pass `model_path` directly instead)."""
    return embed_at(model_path, samples)
