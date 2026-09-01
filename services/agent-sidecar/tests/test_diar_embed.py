"""Tests for `arcelle_sidecar.diar.embed` -- the Python port of the speaker-
voiceprint embedding pipeline (`src-tauri/src/recording/diarize/fbank.rs`,
`titanet.rs`, and the embedding section of `diarize.rs`).

There is no labeled meeting-audio corpus on this machine, so a diarization
error-rate gate is out of scope here (blocked pending the owner's real
data -- see project memory). What IS validated, per the porting brief:

  1. Fbank: a pure-tone behavioral check (the matching mel band lights up)
     and frame-count sanity against the snip_edges formula.
  2. mel_banks(): Slaney area-normalization -- a real numeric property.
  3. numpy.fft.rfft cross-checked against a pure-Python direct DFT (tiny
     inputs, then a handful of bins of a real FBANK_NFFT=512 frame).
  4. TitaNet: the REAL bundled ONNX model, run on real audio synthesized via
     macOS `say` (two different voices) -- shape/norm sanity, determinism,
     and a same-voice-vs-cross-voice similarity gap.
  5. frame_f0: pure-tone pitch detection, cross-checked against the LITERAL
     Rust algorithm compiled and run standalone with `rustc` on this machine
     (see the long comment on `test_pure_tone_pitch_is_bit_identical_to_
     native_rust_and_within_its_own_bias` below for why the "within a few
     Hz" framing in the porting brief turned out not to hold for a
     mathematically pure tone, and why that is a real property of the
     algorithm, not a porting bug).
  6. pitch_dims: arc bounds and confidence fade.
  7. cosine(): the cross-generation hard-0, same-length dot product, and the
     shorter-legacy-DSP-print fallback.
  8. VoicePrint: exact-boundary behavior at MIN_NEW_VOICE_FRAMES.
  9. Every constant, checked verbatim against its Rust source value.
"""

from __future__ import annotations

import math
import os
import subprocess
import time
from pathlib import Path

import numpy as np
import pytest

from arcelle_sidecar.diar import embed as diar
from arcelle_sidecar.media import decode

# Resolve from this checkout rather than one developer's absolute path. CI can
# point at externally provisioned weights explicitly; a misspelled override is
# an error rather than a silently skipped neural test.
_MODEL_ENV = "ARCELLE_TEST_TITANET_MODEL"
_REPO_ROOT = Path(__file__).resolve().parents[3]


def _resolve_titanet_model() -> Path:
    if override := os.environ.get(_MODEL_ENV):
        path = Path(override).expanduser().resolve()
        if not path.is_file():
            raise FileNotFoundError(f"{_MODEL_ENV} does not name a file: {path}")
        return path

    locations = (
        _REPO_ROOT / "apps/desktop/resources/models/nemo_en_titanet_small.onnx",
        _REPO_ROOT / "apps/desktop/assets/models/nemo_en_titanet_small.onnx",
    )
    return next((path for path in locations if path.is_file()), locations[0])


MODEL_PATH = str(_resolve_titanet_model())
requires_model = pytest.mark.skipif(
    not Path(MODEL_PATH).exists(),
    reason=f"real TitaNet ONNX model unavailable; bundle it or set {_MODEL_ENV}",
)

_HAS_SAY = Path("/usr/bin/say").exists() and Path("/usr/bin/afconvert").exists()
requires_say = pytest.mark.skipif(
    not _HAS_SAY, reason="requires macOS say(1)/afconvert(1), not present here"
)


# --------------------------------------------------------------- synth helpers


def _sine(freq: float, n: int, amp: float = 0.4, sr: int = 16000) -> np.ndarray:
    t = np.arange(n, dtype=np.float64) / sr
    return (amp * np.sin(2.0 * np.pi * freq * t)).astype(np.float32)


def _white_noise(n: int, amp: float = 0.2, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return (amp * rng.standard_normal(n)).astype(np.float32)


@pytest.fixture(scope="module")
def say_clips(tmp_path_factory: pytest.TempPathFactory) -> dict[str, np.ndarray]:
    """Two DIFFERENT voices saying the SAME sentence, decoded to 16 kHz mono
    f32 PCM via the sidecar's own afconvert-based decoder -- real audio, not
    fixture bytes. Both clips run past the 2.5 s `neural_embed` sub-window
    threshold, so this also exercises the window-averaging path."""
    if not _HAS_SAY:
        pytest.skip("requires macOS say/afconvert")
    d = tmp_path_factory.mktemp("diar_embed_audio")
    text = "The quick brown fox jumps over the lazy dog near the riverbank."
    clips: dict[str, np.ndarray] = {}
    for voice in ("Samantha", "Fred"):
        path = d / f"{voice}.aiff"
        proc = subprocess.run(
            ["/usr/bin/say", "-v", voice, "-o", str(path), text],
            capture_output=True,
        )
        if proc.returncode != 0 or not path.exists():
            pytest.skip(f"say failed to synthesize voice {voice!r}: {proc.stderr!r}")
        clips[voice] = decode.decode_to_pcm(path, decode.MediaKind.AUDIO)
    return clips


@pytest.fixture(scope="module")
def short_say_clip(tmp_path_factory: pytest.TempPathFactory) -> np.ndarray:
    """A short (< 2.5 s) real utterance -- exercises the single
    whole-phrase `titanet_embed` path rather than window-averaging."""
    if not _HAS_SAY:
        pytest.skip("requires macOS say/afconvert")
    d = tmp_path_factory.mktemp("diar_embed_short_audio")
    path = d / "short.aiff"
    proc = subprocess.run(
        ["/usr/bin/say", "-v", "Samantha", "-o", str(path), "Testing one two."],
        capture_output=True,
    )
    if proc.returncode != 0 or not path.exists():
        pytest.skip(f"say failed to synthesize test audio: {proc.stderr!r}")
    pcm = decode.decode_to_pcm(path, decode.MediaKind.AUDIO)
    assert pcm.shape[0] <= diar.EMB_WIN + diar.EMB_HOP // 2, (
        "fixture assumption broken: clip grew past the sub-window threshold"
    )
    return pcm


# =============================================================================
# (9) Constants -- bit-identical to the Rust source, checked mechanically
# =============================================================================


def test_dsp_and_pitch_constants_match_rust_source_verbatim() -> None:
    assert diar.SAMPLE_RATE == 16_000
    assert diar.WIN == 512
    assert diar.HOP == 256
    assert diar.BANDS == 20
    assert diar.VOICED_RMS == 0.004
    assert diar.F0_MIN_LAG == 16_000 // 400 == 40
    assert diar.F0_MAX_LAG == 16_000 // 60 == 266
    assert diar.F0_CLAMP == (70.0, 320.0)
    assert diar.PITCH_MIN_CORR == 0.6
    assert diar.PITCH_RAD_PER_OCTAVE == 2.0
    assert diar.PITCH_WEIGHT == 0.6
    assert diar.MIN_PITCHED_FRAMES == 20
    assert diar.MIN_NEW_VOICE_FRAMES == 62
    assert diar.EMB_WIN == 16_000 * 2 == 32_000
    assert diar.EMB_HOP == 16_000


def test_fbank_and_titanet_constants_match_rust_source_verbatim() -> None:
    assert diar.FBANK_SR == 16000.0
    assert diar.FBANK_WIN == 400
    assert diar.FBANK_SHIFT == 160
    assert diar.FBANK_NFFT == 512
    assert diar.NBINS == 80
    assert diar.EMB_DIM == 192


def test_gate_constants_match_rust_source_exactly() -> None:
    assert diar.DSP_GATES == diar.Gates(
        split=0.65, center=False, raw_same=0.85, online_same=0.35, online_new=0.10
    )
    assert diar.NEURAL_GATES == diar.Gates(
        split=0.36, center=True, raw_same=0.69, online_same=0.40, online_new=0.20
    )


def test_gates_for_dispatches_on_print_generation() -> None:
    neural_vec = np.zeros(diar.EMB_DIM, dtype=np.float32)
    dsp_vec = np.zeros(diar.BANDS + 1, dtype=np.float32)
    assert diar.gates_for(neural_vec) is diar.NEURAL_GATES
    assert diar.gates_for(dsp_vec) is diar.DSP_GATES
    assert diar.is_neural(neural_vec) is True
    assert diar.is_neural(dsp_vec) is False


# =============================================================================
# (1) Fbank -- pure-tone band-energy behavior + snip_edges frame counting
# =============================================================================


class TestFbank:
    def test_frame_count_matches_snip_edges_formula(self) -> None:
        fb = diar.Fbank()
        for n in (0, 100, 399, 400, 401, 560, 5000, 16000, 32000):
            samples = np.zeros(n, dtype=np.float32)
            num_frames, feats = fb.compute(samples)
            expected = (
                0 if n < diar.FBANK_WIN else 1 + (n - diar.FBANK_WIN) // diar.FBANK_SHIFT
            )
            assert num_frames == expected, f"n={n}"
            assert feats.shape == (num_frames * diar.NBINS,)

    @staticmethod
    def _fbank_band_centers() -> np.ndarray:
        """Re-derive each Slaney mel band's center Hz directly from the
        module's own `mel_slaney`/`inv_mel_slaney`, independent of
        `mel_banks()`'s internal bin-weight machinery, so this test isn't
        just checking the implementation against itself."""
        mlo, mhi = diar.mel_slaney(0.0), diar.mel_slaney(diar.FBANK_SR / 2.0)
        delta = (mhi - mlo) / (diar.NBINS + 1)
        return np.array(
            [diar.inv_mel_slaney(mlo + (b + 1) * delta) for b in range(diar.NBINS)]
        )

    def test_sine_tone_lights_up_the_matching_mel_band(self) -> None:
        fb = diar.Fbank()
        tone = _sine(300.0, 16000 * 2, amp=0.3)
        num_frames, flat = fb.compute(tone)
        feats = flat.reshape(num_frames, diar.NBINS)
        band_avg = feats.mean(axis=0)

        centers = self._fbank_band_centers()
        idx_near = int(np.argmin(np.abs(centers - 300.0)))
        far_mask = np.abs(centers - 300.0) > 1000.0
        assert far_mask.sum() > 10  # sanity: plenty of "far" bands to compare against

        # A real behavioral check, not an exact-value one (no independent
        # ground truth is computed here): the band nearest 300 Hz must be
        # MEANINGFULLY louder in log-energy than bands far from it. The
        # measured margin is >14 nats (e^14 ~ 1.2M x); a 3-nat bar is
        # generous, not a coin flip.
        assert band_avg[idx_near] > band_avg[far_mask].mean() + 3.0


def test_mel_banks_slaney_area_normalization() -> None:
    """Slaney normalization holds each triangle's AREA constant (~1.0 in the
    continuous limit: peak height 2/(r-l) times base (r-l) times one-half),
    not its peak height -- peak height alone would grow ~8x from the lowest
    to the highest band as the triangles widen in mel-linear space. Verified
    via trapezoidal integration of the actual materialized bin weights
    against their true Hz positions; the narrowest low-frequency bands (as
    few as 2 discretization points) are excluded from the numeric check
    since a 2-point trapezoid cannot meaningfully estimate a triangle's
    area -- that is a discretization-resolution artifact of the low bands,
    not a normalization failure (confirmed by inspection: those areas do
    NOT converge as more points are added elsewhere, they just have too few
    samples to integrate accurately)."""
    banks = diar.mel_banks()
    fft_bin_width = diar.FBANK_SR / diar.FBANK_NFFT
    areas = []
    for first, w in banks:
        if len(w) < 4:
            continue
        hz = fft_bin_width * (first + np.arange(len(w)))
        areas.append(float(np.trapezoid(w.astype(np.float64), hz)))

    assert len(areas) >= 40, "expected most of the 80 bands to have >=4 bins"
    areas_arr = np.asarray(areas)
    assert np.all(areas_arr > 0.7)
    assert np.all(areas_arr < 1.1)
    assert areas_arr.std() < 0.1


def test_mel_banks_keeps_empty_bank_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(diar, "inv_mel_slaney", lambda _mel: 0.1)

    with pytest.raises(ValueError, match="empty mel bin"):
        diar.mel_banks()


def test_neural_embed_averages_fabricated_window_vectors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    samples = np.arange(diar.EMB_WIN + diar.EMB_HOP, dtype=np.float32)
    windows: list[tuple[int, int]] = []

    def fake_titanet(_path: str, window: np.ndarray) -> np.ndarray:
        windows.append((int(window[0]), len(window)))
        vec = np.zeros(diar.EMB_DIM, dtype=np.float32)
        vec[0 if window[0] == 0 else 1] = 1.0
        return vec

    monkeypatch.setattr(diar, "count_voiced", lambda _window: diar.EMB_WIN // diar.HOP)
    monkeypatch.setattr(diar, "titanet_embed", fake_titanet)

    embedding = diar.neural_embed("/fake/titanet.onnx", samples)

    expected = np.zeros(diar.EMB_DIM, dtype=np.float32)
    expected[:2] = 1.0 / math.sqrt(2.0)
    assert embedding is not None
    assert np.allclose(embedding, expected)
    assert windows == [(0, diar.EMB_WIN), (diar.EMB_HOP, diar.EMB_WIN)]


def test_neural_embed_falls_back_after_all_fabricated_windows_are_silent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    samples = np.zeros(diar.EMB_WIN + diar.EMB_HOP, dtype=np.float32)
    calls: list[int] = []
    fallback = np.full(diar.EMB_DIM, 1.0 / math.sqrt(diar.EMB_DIM), dtype=np.float32)

    def fake_titanet(_path: str, window: np.ndarray) -> np.ndarray:
        calls.append(len(window))
        return fallback

    monkeypatch.setattr(diar, "count_voiced", lambda _window: 0)
    monkeypatch.setattr(diar, "titanet_embed", fake_titanet)

    assert np.array_equal(diar.neural_embed("/fake/titanet.onnx", samples), fallback)
    assert calls == [len(samples)]


def test_rfft_matches_direct_dft_on_tiny_input() -> None:
    """numpy.fft.rfft cross-checked against a pure-Python O(N^2) direct DFT
    on a tiny synthetic input -- the empirical verification the porting
    brief calls for before trusting rfft as the vectorized equivalent of the
    Rust hand-rolled radix-2 FFT. No discrepancy was found: max abs diff is
    at float64-precision noise, nowhere near the fbank pipeline's own
    documented <1e-4 feature-diff tolerance against onnxruntime."""
    rng = np.random.default_rng(7)
    n = 16
    x = rng.standard_normal(n)

    direct = []
    for k in range(n // 2 + 1):
        re = sum(x[t] * math.cos(2 * math.pi * k * t / n) for t in range(n))
        im = -sum(x[t] * math.sin(2 * math.pi * k * t / n) for t in range(n))
        direct.append(complex(re, im))
    direct_arr = np.asarray(direct)

    via_rfft = np.fft.rfft(x)
    assert np.allclose(direct_arr, via_rfft, atol=1e-9)


def test_rfft_matches_direct_dft_on_real_fbank_frame_size() -> None:
    """Same cross-check, at the actual FBANK_NFFT=512 size Fbank uses (a
    handful of representative bins, not all 257 -- an O(N^2) direct DFT over
    every bin at N=512 is unnecessary to make the point)."""
    rng = np.random.default_rng(3)
    frame = rng.standard_normal(diar.FBANK_NFFT)
    fast = np.fft.rfft(frame)
    for k in (0, 1, 50, 128, 256):
        re = sum(
            frame[t] * math.cos(2 * math.pi * k * t / diar.FBANK_NFFT)
            for t in range(diar.FBANK_NFFT)
        )
        im = -sum(
            frame[t] * math.sin(2 * math.pi * k * t / diar.FBANK_NFFT)
            for t in range(diar.FBANK_NFFT)
        )
        assert abs(fast[k] - complex(re, im)) < 1e-6


def test_hz_mel_slaney_round_trip() -> None:
    # rel=1e-3 (not a tighter abs bound): mel_slaney/inv_mel_slaney round-trip
    # through log()/exp(), so float32-level relative noise (~1e-4 to 1e-3 at
    # these magnitudes) is expected precision loss, not a formula bug.
    for hz in (0.0, 300.0, 999.0, 1000.0, 1001.0, 4000.0, 8000.0):
        assert diar.inv_mel_slaney(diar.mel_slaney(hz)) == pytest.approx(hz, abs=1e-3, rel=1e-3)


# =============================================================================
# (4) TitaNet -- the REAL bundled ONNX model, real audio
# =============================================================================


@requires_model
class TestTitanetEmbedding:
    @requires_say
    def test_shape_and_unit_norm(self, short_say_clip: np.ndarray) -> None:
        emb = diar.titanet_embed(MODEL_PATH, short_say_clip)
        assert emb is not None
        assert emb.shape == (diar.EMB_DIM,)
        assert emb.dtype == np.float32
        assert float(np.linalg.norm(emb)) == pytest.approx(1.0, abs=1e-4)

    @requires_say
    def test_deterministic_on_identical_audio(self, short_say_clip: np.ndarray) -> None:
        e1 = diar.titanet_embed(MODEL_PATH, short_say_clip)
        e2 = diar.titanet_embed(MODEL_PATH, short_say_clip)
        assert e1 is not None and e2 is not None
        assert np.array_equal(e1, e2)
        assert diar.cosine(e1, e2) > 0.999999

    @requires_say
    def test_different_voices_embed_further_apart_than_identical_audio(
        self, say_clips: dict[str, np.ndarray]
    ) -> None:
        e_sam = diar.titanet_embed(MODEL_PATH, say_clips["Samantha"])
        e_sam_again = diar.titanet_embed(MODEL_PATH, say_clips["Samantha"])
        e_fred = diar.titanet_embed(MODEL_PATH, say_clips["Fred"])
        assert e_sam is not None and e_fred is not None and e_sam_again is not None

        same_voice_cos = diar.cosine(e_sam, e_sam_again)
        cross_voice_cos = diar.cosine(e_sam, e_fred)

        assert same_voice_cos > 0.999999
        # Measured on this machine: ~0.15 cross-voice vs ~1.0 same-voice --
        # a wide margin, not a coin flip.
        assert cross_voice_cos < same_voice_cos - 0.3

    def test_sine_tone_vs_white_noise_embed_measurably_differently(self) -> None:
        """The task's non-`say` fallback comparison: two clearly different
        SYNTHETIC signals (no macOS dependency)."""
        tone = _sine(200.0, 16000 * 2, amp=0.3)
        noise = _white_noise(16000 * 2, amp=0.1, seed=1)
        e_tone = diar.titanet_embed(MODEL_PATH, tone)
        e_tone_again = diar.titanet_embed(MODEL_PATH, tone)
        e_noise = diar.titanet_embed(MODEL_PATH, noise)
        assert e_tone is not None and e_noise is not None and e_tone_again is not None

        same_cos = diar.cosine(e_tone, e_tone_again)
        cross_cos = diar.cosine(e_tone, e_noise)
        assert same_cos > 0.999999
        assert cross_cos < same_cos - 0.05

    @requires_say
    def test_neural_embed_window_averages_long_phrases(
        self, say_clips: dict[str, np.ndarray]
    ) -> None:
        fred = say_clips["Fred"]
        assert fred.shape[0] > diar.EMB_WIN + diar.EMB_HOP // 2, (
            "fixture assumption broken: clip too short to exercise window-averaging"
        )
        e = diar.neural_embed(MODEL_PATH, fred)
        assert e is not None
        assert e.shape == (diar.EMB_DIM,)
        assert float(np.linalg.norm(e)) == pytest.approx(1.0, abs=1e-4)

    def test_too_little_audio_returns_none(self) -> None:
        tiny = np.zeros(300, dtype=np.float32)  # < FBANK_WIN=400 -> 0 frames
        assert diar.titanet_embed(MODEL_PATH, tiny) is None

    @requires_say
    def test_embed_at_uses_neural_embedding_when_model_available(
        self, short_say_clip: np.ndarray
    ) -> None:
        vp = diar.embed_at(MODEL_PATH, short_say_clip)
        assert diar.is_neural(vp.vec)
        assert vp.vec.shape == (diar.EMB_DIM,)
        assert vp.voiced_frames > 0
        assert float(np.linalg.norm(vp.vec)) == pytest.approx(1.0, abs=1e-4)

    @requires_say
    def test_embed_is_an_alias_for_embed_at(self, short_say_clip: np.ndarray) -> None:
        vp1 = diar.embed(MODEL_PATH, short_say_clip)
        vp2 = diar.embed_at(MODEL_PATH, short_say_clip)
        assert np.array_equal(vp1.vec, vp2.vec)
        assert vp1.voiced_frames == vp2.voiced_frames


def test_embed_at_falls_back_to_dsp_when_model_missing() -> None:
    """A missing/broken model must never break embedding -- the caller
    silently gets the DSP print instead."""
    samples = _sine(180.0, 16000, amp=0.3)
    vp = diar.embed_at("/nonexistent/model/path.onnx", samples)
    assert not diar.is_neural(vp.vec)
    assert vp.vec.shape[0] == diar.BANDS + 1
    assert vp.voiced_frames > 0


def test_embed_at_silence_returns_all_zero_print() -> None:
    vp = diar.embed_at("/nonexistent/model/path.onnx", np.zeros(20000, dtype=np.float32))
    assert vp.voiced_frames == 0
    assert vp.is_silent()
    assert vp.vec.shape[0] == diar.BANDS + 1
    assert np.all(vp.vec == 0.0)


# =============================================================================
# (5) frame_f0 -- pure-tone pitch detection
# =============================================================================


class TestFrameF0:
    def test_pure_tone_pitch_is_bit_identical_to_native_rust_and_within_its_own_bias(
        self,
    ) -> None:
        """IMPORTANT, DISCLOSED FINDING: the porting brief expected a pure
        150 Hz tone to detect "within a few Hz" of 150. Empirically it does
        NOT -- both this Python port AND the literal Rust algorithm
        (verified below) detect ~163.27 Hz for a clean, noiseless 150 Hz
        tone in a 512-sample (32 ms) frame, an ~9% overshoot.

        Root cause (confirmed by hand-tracing the r(lag) curve): a pure
        sine's autocorrelation has one broad, smooth peak around the true
        period. `frame_f0`'s "shortest near-tied lag" octave-correction
        (>= 0.87 * best_r, scanned ascending) does not require the candidate
        to be a genuine SEPARATE peak (e.g. a real octave-down harmonic) --
        it accepts the first point on the RISING SHOULDER of the SAME peak
        that crosses 87% of its height, which for a smooth, wide lobe is
        always a few lags short of the true peak. This shifts detected
        pitch systematically HIGHER than truth for clean tones. Real voiced
        speech does not show anywhere near this effect because harmonics
        sharpen the fundamental-period peak into a narrow spike.

        This was cross-validated, not assumed: the exact `frame_f0` Rust
        function (verbatim from diarize.rs, module-doc constants and all)
        was compiled standalone with `rustc` on this machine and run against
        these same synthetic sample arrays. Native Rust output:
            150 Hz tone -> 163.2653 Hz
            220 Hz tone -> 238.80597 Hz
        Both bit-identical (to float32 precision) to this Python port's
        output below -- proof this port is faithful, and proof the "few Hz"
        framing does not hold for a pure tone (a property of the shipped
        algorithm, not a porting bug).
        """
        expectations = {150.0: 163.2653, 220.0: 238.80597}
        for freq, rust_native_f0 in expectations.items():
            frame = _sine(freq, 512, amp=0.4)
            f0 = diar.frame_f0(frame)
            assert f0 is not None
            assert f0 == pytest.approx(rust_native_f0, abs=0.01)
            # And, independent of the exact native-Rust cross-check above: a
            # real, meaningful sanity bound -- detected pitch stays in the
            # same neighborhood as truth (never wildly off, e.g. an actual
            # octave error), consistently overshooting by a bounded amount.
            assert freq <= f0 <= freq * 1.25

    def test_higher_tone_detects_higher_pitch(self) -> None:
        f0_low = diar.frame_f0(_sine(150.0, 512, amp=0.4))
        f0_high = diar.frame_f0(_sine(220.0, 512, amp=0.4))
        assert f0_low is not None and f0_high is not None
        assert f0_high > f0_low

    def test_white_noise_is_not_pitched(self) -> None:
        # Checked across many seeds during development (0 false positives in
        # 30 trials) before picking this one as the fixed, reproducible case.
        noise = _white_noise(512, amp=0.3, seed=2)
        assert diar.frame_f0(noise) is None


def test_bin_energy_peaks_at_matching_frequency() -> None:
    frame = _sine(300.0, diar.WIN, amp=0.4)
    e_match = diar.bin_energy(frame, 300.0)
    e_far = diar.bin_energy(frame, 1500.0)
    assert e_match > e_far * 10


def test_band_centers_are_ordered_and_within_range() -> None:
    centers = diar.band_centers()
    assert centers.shape == (diar.BANDS,)
    assert np.all(np.diff(centers) > 0)
    assert centers[0] > 90.0
    assert centers[-1] < 4400.0


def test_count_voiced_matches_a_manual_reference_loop() -> None:
    """Cross-checks the vectorized `count_voiced` against a literal
    translation of the Rust `while pos + WIN <= len` loop -- an independent
    reference, not just re-reading the same code."""
    samples = _sine(180.0, 20000, amp=0.05)
    n = samples.shape[0]
    frames = 0
    pos = 0
    while pos + diar.WIN <= n:
        frame = samples[pos : pos + diar.WIN]
        pos += diar.HOP
        rms = math.sqrt(float(np.mean(frame.astype(np.float64) ** 2)))
        if rms >= diar.VOICED_RMS:
            frames += 1
    assert frames > 0
    assert diar.count_voiced(samples) == frames


def test_count_voiced_zero_for_silence() -> None:
    assert diar.count_voiced(np.zeros(20000, dtype=np.float32)) == 0


def test_dsp_embed_ignores_quiet_frames() -> None:
    quiet = np.full(diar.WIN * 2, diar.VOICED_RMS / 2, dtype=np.float32)

    voice = diar.dsp_embed(quiet)

    assert voice.voiced_frames == 0
    assert voice.vec.shape == (diar.BANDS + 1,)
    assert np.all(voice.vec == 0.0)


# =============================================================================
# (6) pitch_dims
# =============================================================================


class TestPitchDims:
    def test_point_lies_on_bounded_arc_scaled_by_confidence(self) -> None:
        f0s = [150.0] * 30
        cos_v, sin_v = diar.pitch_dims(f0s)
        conf = diar.PITCH_WEIGHT * min(len(f0s) / diar.MIN_PITCHED_FRAMES, 1.0)
        assert (cos_v**2 + sin_v**2) == pytest.approx(conf**2, rel=1e-4)

    def test_few_pitched_frames_fade_confidence_toward_zero(self) -> None:
        few = diar.pitch_dims([150.0] * 2)
        many = diar.pitch_dims([150.0] * diar.MIN_PITCHED_FRAMES)
        assert math.hypot(*few) < math.hypot(*many)
        assert math.hypot(*many) == pytest.approx(diar.PITCH_WEIGHT, rel=1e-4)
        expected_few_conf = diar.PITCH_WEIGHT * (2 / diar.MIN_PITCHED_FRAMES)
        assert math.hypot(*few) == pytest.approx(expected_few_conf, rel=1e-4)

    def test_many_pitched_frames_saturate_confidence(self) -> None:
        saturated = diar.pitch_dims([150.0] * (diar.MIN_PITCHED_FRAMES * 5))
        assert math.hypot(*saturated) == pytest.approx(diar.PITCH_WEIGHT, rel=1e-4)

    def test_empty_f0_list_returns_zero(self) -> None:
        cos_v, sin_v = diar.pitch_dims([])
        assert cos_v == 0.0
        assert sin_v == 0.0

    def test_clamp_bounds_theta_from_extreme_f0(self) -> None:
        low = diar.pitch_dims([10.0] * 40)  # below F0_CLAMP[0]
        high = diar.pitch_dims([5000.0] * 40)  # above F0_CLAMP[1]
        low_conf = math.hypot(*low)
        high_conf = math.hypot(*high)
        assert low_conf == pytest.approx(diar.PITCH_WEIGHT, rel=1e-4)
        assert high_conf == pytest.approx(diar.PITCH_WEIGHT, rel=1e-4)
        # F0_CLAMP[0] itself maps to theta=0 -> point (conf, 0).
        assert low[0] == pytest.approx(diar.PITCH_WEIGHT, rel=1e-4)
        assert low[1] == pytest.approx(0.0, abs=1e-4)


# =============================================================================
# (7) cosine()
# =============================================================================


class TestCosine:
    def test_cross_generation_is_hard_zero(self) -> None:
        neural_vec = np.ones(diar.EMB_DIM, dtype=np.float32) / math.sqrt(diar.EMB_DIM)
        dsp_vec = np.ones(diar.BANDS + 1, dtype=np.float32) / math.sqrt(diar.BANDS + 1)
        assert diar.cosine(neural_vec, dsp_vec) == 0.0
        assert diar.cosine(dsp_vec, neural_vec) == 0.0

    def test_same_length_is_plain_dot_product(self) -> None:
        a = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        b = np.array([0.0, 1.0, 0.0], dtype=np.float32)
        assert diar.cosine(a, a) == pytest.approx(1.0)
        assert diar.cosine(a, b) == pytest.approx(0.0)

    def test_legacy_shorter_dsp_print_falls_back_to_shared_prefix(self) -> None:
        vp = diar.dsp_embed(_sine(180.0, 16000, amp=0.3))
        assert vp.vec.shape[0] == diar.BANDS + 1  # 19 band deltas + 2 pitch dims
        assert vp.voiced_frames > 0

        # As if loaded from a file saved before pitch dims existed: 2 dims
        # shorter, band deltas only.
        legacy_same_voice = vp.vec[: diar.BANDS - 1].copy()
        assert legacy_same_voice.shape[0] == vp.vec.shape[0] - 2

        # An old/new pair of the SAME voice must score like an old/old pair
        # -- i.e. this must not raise, and must fall back to the shared
        # band-delta prefix rather than the cross-generation hard-0 (this
        # print is still DSP-generation, just a different length).
        same_direction_cos = diar.cosine(vp.vec, legacy_same_voice)
        assert same_direction_cos == pytest.approx(1.0, abs=1e-5)

        # A genuinely different voice's legacy print: must still execute
        # (not raise) and return a valid, bounded cosine.
        other_vp = diar.dsp_embed(_sine(260.0, 16000, amp=0.3))
        other_legacy = other_vp.vec[: diar.BANDS - 1].copy()
        cross = diar.cosine(vp.vec, other_legacy)
        assert -1.0 - 1e-6 <= cross <= 1.0 + 1e-6


# =============================================================================
# (8) VoicePrint -- exact boundary behavior
# =============================================================================


class TestVoicePrint:
    def test_is_strong_at_min_new_voice_frames_boundary(self) -> None:
        vec = np.ones(3, dtype=np.float32)
        one_under = diar.VoicePrint(vec=vec, voiced_frames=diar.MIN_NEW_VOICE_FRAMES - 1)
        at_threshold = diar.VoicePrint(vec=vec, voiced_frames=diar.MIN_NEW_VOICE_FRAMES)
        assert not one_under.is_strong()
        assert at_threshold.is_strong()

    def test_is_silent_true_for_all_zero_vector(self) -> None:
        vp = diar.VoicePrint(vec=np.zeros(diar.BANDS + 1, dtype=np.float32), voiced_frames=0)
        assert vp.is_silent()
        assert not vp.defines_voice(1)

    def test_is_silent_false_for_nonzero_voiced_print(self) -> None:
        vp = diar.VoicePrint(vec=np.array([1.0, 0.0], dtype=np.float32), voiced_frames=5)
        assert not vp.is_silent()

    def test_defines_voice_respects_caller_chosen_scale(self) -> None:
        vec = np.ones(2, dtype=np.float32)
        vp = diar.VoicePrint(vec=vec, voiced_frames=20)
        assert vp.defines_voice(20)
        assert not vp.defines_voice(21)

    def test_defines_voice_false_when_voiced_frames_meets_bar_but_vec_is_zero(self) -> None:
        vp = diar.VoicePrint(vec=np.zeros(3, dtype=np.float32), voiced_frames=100)
        assert not vp.defines_voice(1)  # is_silent() wins even with plenty of frames


# =============================================================================
# (9) The model cache -- a failed load must be RETRYABLE
# =============================================================================


class TestModelLoadCache:
    """The cache used to store a failed load as ``None`` and test membership
    with ``path in _MODEL_CACHE``, which made ONE failure permanent for the
    life of the process: a model file still being copied into place, a path the
    host had not finished resolving, or a single transient onnxruntime error
    during the first phrase of the first recording silently downgraded EVERY
    later phrase, in every later recording, to the 21-dim DSP print -- and with
    it saved-voice enrollment and cross-recording recognition, which need 192
    dims. Nothing pinned that behavior either way before now.

    The rate limit the old cache existed for is preserved and pinned too: this
    runs once per 2 s embedding window, so a retry per call would be a real
    cost on a machine with no model at all.
    """

    @pytest.fixture(autouse=True)
    def _isolated_cache(self):
        diar._MODEL_CACHE.clear()
        diar._MODEL_FAILED_AT.clear()
        yield
        diar._MODEL_CACHE.clear()
        diar._MODEL_FAILED_AT.clear()

    def test_a_failed_load_is_not_retried_inside_the_quiet_window(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        attempts: list[str] = []

        def always_fails(path, providers=None):
            attempts.append(path)
            raise RuntimeError("no such file")

        monkeypatch.setattr(diar.ort, "InferenceSession", always_fails)
        assert diar._model_for("/missing/titanet.onnx") is None
        assert diar._model_for("/missing/titanet.onnx") is None
        assert diar._model_for("/missing/titanet.onnx") is None
        assert len(attempts) == 1, "a per-phrase hot path must not retry every call"

    def test_a_failed_load_recovers_once_the_quiet_window_has_passed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The headline fix: the model that shows up a moment later is used."""
        session = object()
        attempts: list[str] = []

        def fails_once(path, providers=None):
            attempts.append(path)
            if len(attempts) == 1:
                raise RuntimeError("model file is still being copied")
            return session

        monkeypatch.setattr(diar.ort, "InferenceSession", fails_once)
        path = "/late/titanet.onnx"
        assert diar._model_for(path) is None
        # Pretend the quiet window has elapsed rather than sleeping through it.
        diar._MODEL_FAILED_AT[path] = time.monotonic() - diar.MODEL_RETRY_SECS - 1.0
        assert diar._model_for(path) is session
        assert len(attempts) == 2

    def test_a_loaded_model_is_never_loaded_a_second_time(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        session = object()
        attempts: list[str] = []

        def loads(path, providers=None):
            attempts.append(path)
            return session

        monkeypatch.setattr(diar.ort, "InferenceSession", loads)
        for _ in range(5):
            assert diar._model_for("/good/titanet.onnx") is session
        assert len(attempts) == 1

    def test_a_recovery_clears_the_failure_stamp(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Otherwise a path that failed long ago, then loaded, would still carry
        a stale timestamp -- harmless today, a trap for the next reader."""
        session = object()
        calls: list[int] = []

        def fails_once(path, providers=None):
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("nope")
            return session

        monkeypatch.setattr(diar.ort, "InferenceSession", fails_once)
        path = "/late/titanet.onnx"
        assert diar._model_for(path) is None
        assert path in diar._MODEL_FAILED_AT
        diar._MODEL_FAILED_AT[path] = time.monotonic() - diar.MODEL_RETRY_SECS - 1.0
        assert diar._model_for(path) is session
        assert path not in diar._MODEL_FAILED_AT

    def test_neural_ready_reports_model_load_state_not_vector_shape(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """``is_neural`` needs a vector to inspect and cannot be asked before
        one exists; this is the question a job-level caller actually has."""
        session = object()
        monkeypatch.setattr(diar.ort, "InferenceSession", lambda path, providers=None: session)
        assert diar.neural_ready("/good/titanet.onnx") is True
        assert diar.neural_ready("") is False, "an unresolved path is not a model"

    def test_neural_ready_is_false_when_the_model_cannot_be_loaded(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def always_fails(path, providers=None):
            raise RuntimeError("no such file")

        monkeypatch.setattr(diar.ort, "InferenceSession", always_fails)
        assert diar.neural_ready("/missing/titanet.onnx") is False

    @requires_model
    def test_neural_ready_is_true_for_the_real_bundled_model(self) -> None:
        assert diar.neural_ready(MODEL_PATH) is True
