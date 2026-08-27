"""Tests for `arcelle_sidecar.rec.vad` — the Python port of the "VAD lane"
section of `src-tauri/src/recording.rs` (lines 750-809: `VAD_MODEL_PATH`/
`VAD_MODEL_FILE`/`set_vad_model_path`/`vad_model_path`, `VAD_TAIL`,
`NeuralVad::new`/`NeuralVad::probs`).

This file is the FINAL merge of two independent candidate test suites (see
the final report for what was taken from each and why). Uses the REAL
Silero VAD v5 ONNX graph (via `onnxruntime`) and real `say`-synthesized
speech for the model-dependent tests — no mocking of the actual detection.
See `arcelle_sidecar.rec.vad`'s module docstring for the full, evidence-
backed account of why this is an ONNX graph rather than whisper.cpp's native
VAD path (confirmed broken on the installed `pywhispercpp`, independently,
three separate times), and why `VAD_MODEL_FILE`'s value had to change
accordingly.

The real model file this port needs (`silero_vad.onnx`) is NOT vendored
anywhere in this repo's own `src-tauri/resources/models` — `_vad_model_path()`'s
fallback correctly points at where it would eventually belong (alongside the
repo's other vendored models), matching Rust's own `CARGO_MANIFEST_DIR`-
relative fallback, but nothing places the file there today. For this test
file to genuinely exercise the real model on THIS machine (rather than only
asserting the port "would" work), the real, official, MIT-licensed
`silero_vad.onnx` (the exact file the upstream `snakers4/silero-vad` PyPI
package bundles as data) is cached at `VAD_ONNX_PATH` below, OUTSIDE this git
repo entirely (macOS's own per-user Caches directory — never committed,
never touched by `git status`), and wired in per-test via an explicit
`model_path=`/`set_vad_model_path` call — never hardcoded into the module
itself. Every model-dependent test skips cleanly if that cache is empty,
matching this whole migration's established pattern for model-dependent
tests (`tests/test_engine.py`, `tests/test_diar_embed.py`).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import pytest

from arcelle_sidecar.media.decode import MediaKind, decode_to_pcm
from arcelle_sidecar.rec import vad
from arcelle_sidecar.rec.meta import FRAME

REPO_ROOT = Path(__file__).resolve().parents[2]

# The real, official Silero VAD v5 ONNX graph, cached outside the repo for
# this test session only — see the module docstring above.
VAD_ONNX_PATH = str(Path.home() / "Library" / "Caches" / "arcelle-sidecar" / "models" / "silero_vad.onnx")
_HAS_VAD_MODEL = Path(VAD_ONNX_PATH).exists()
_HAS_SAY = Path("/usr/bin/say").exists()
_HAS_AFCONVERT = Path("/usr/bin/afconvert").exists()
_HAS_MODEL_AND_TOOLS = _HAS_VAD_MODEL and _HAS_SAY and _HAS_AFCONVERT

requires_model = pytest.mark.skipif(
    not _HAS_MODEL_AND_TOOLS,
    reason=f"requires the cached Silero VAD ONNX model at {VAD_ONNX_PATH} + macOS `say`/`afconvert`",
)


@pytest.fixture(autouse=True)
def _clean_path_override():
    """`set_vad_model_path` mutates process-global state — every test starts
    and ends with no override set, matching `test_engine.py`'s
    `_clean_warm_cache` fixture pattern for the sibling `stt.engine` cache.
    """
    vad._vad_model_path_override = None
    yield
    vad._vad_model_path_override = None


@pytest.fixture(scope="module")
def say_pcm(tmp_path_factory: pytest.TempPathFactory) -> np.ndarray:
    """Real 16 kHz mono PCM for "the quick brown fox..." via macOS `say` +
    the sidecar's own `decode_to_pcm` — same real-audio approach as
    `tests/test_engine.py`'s own `say_pcm` fixture.
    """
    if not _HAS_MODEL_AND_TOOLS:
        pytest.skip("requires the cached VAD model + macOS `say`/`afconvert`")
    d = tmp_path_factory.mktemp("vad_audio")
    aiff = d / "quick_fox.aiff"
    proc = subprocess.run(
        ["/usr/bin/say", "-o", str(aiff), "the quick brown fox jumps over the lazy dog"],
        capture_output=True,
    )
    if proc.returncode != 0 or not aiff.exists():
        pytest.skip(f"`say` failed: {proc.stderr!r}")
    pcm = decode_to_pcm(aiff, MediaKind.AUDIO)
    assert pcm.shape[0] > 16000, "decoded under a second of audio"
    return pcm


def _trim_to_frame(x: np.ndarray) -> np.ndarray:
    """Truncate to a whole multiple of FRAME (the `probs()` precondition)."""
    n = (x.shape[0] // FRAME) * FRAME
    return np.asarray(x[:n], dtype=np.float32)


def _bare_vad() -> vad.NeuralVad:
    """A `NeuralVad` with `tail` initialized but NO real `onnxruntime`
    session — for testing behavior that runs before `_score_buffer` is ever
    touched (the malformed-`fresh` guard), or with `_score_buffer` itself
    monkeypatched, without needing the real (possibly absent) model file on
    disk. Bypasses `__init__` deliberately, the same way a hand-rolled fake
    stands in for a real object elsewhere in this migration
    (`tests/test_engine.py`'s `_FakeModel`).
    """
    obj = object.__new__(vad.NeuralVad)
    obj.tail = np.zeros(0, dtype=np.float32)
    return obj


# --------------------------------------------------------------- constants


def test_constants_match_rust_source() -> None:
    # VAD_MODEL_FILE's VALUE deliberately differs from the Rust source's
    # "ggml-silero-v5.1.2.bin" — see the module docstring for why (a
    # different serialization format the fallback mechanism can actually
    # load). VAD_TAIL is unchanged: FRAME * 22, same value, same reasoning,
    # and FRAME itself is imported from rec.meta, not redefined.
    assert vad.FRAME == FRAME == 512
    assert vad.VAD_MODEL_FILE == "silero_vad.onnx"
    assert vad.VAD_TAIL == FRAME * 22 == 11264


# ------------------------------------------------------- _vad_model_path()


def test_vad_model_path_fallback_is_the_electron_development_models_dir() -> None:
    """No override set -> the CARGO_MANIFEST_DIR-relative fallback,
    independently verified against this exact checkout's real layout (not
    merely re-deriving the module's own computation) — the SAME directory
    `test_engine.py`/`test_diar_embed.py` already hardcode their own model
    paths against.
    """
    assert vad._vad_model_path_override is None
    expected = str(REPO_ROOT / "electron-migration" / "electron-app" / "assets" / "models" / "silero_vad.onnx")
    assert vad._vad_model_path() == expected


def test_set_vad_model_path_overrides_and_is_callable_repeatedly() -> None:
    """Mirrors the Rust `OnceLock`'s `set` semantics for the OVERRIDE value
    itself, but — deliberately, per the module docstring — does not enforce
    "only once": tests (and this test itself) call it more than once in the
    same process.
    """
    vad.set_vad_model_path("/tmp/one.onnx")
    assert vad._vad_model_path() == "/tmp/one.onnx"
    vad.set_vad_model_path("/tmp/two.onnx")
    assert vad._vad_model_path() == "/tmp/two.onnx"


# --------------------------------------------------- NeuralVad construction


def test_new_returns_none_for_a_missing_model_file() -> None:
    """The Rust `Option`-returning idiom: a VAD problem must never break a
    recording, so a missing model is `None`, never an exception, through
    `.new()`."""
    assert vad.NeuralVad.new("/nonexistent/silero_vad.onnx") is None


def test_direct_constructor_raises_cleanly_for_a_missing_model_file() -> None:
    """The OTHER idiom the porting brief explicitly allows: `__init__`
    itself raises a clear, documented exception rather than failing silently
    or crashing unpredictably."""
    with pytest.raises(FileNotFoundError):
        vad.NeuralVad("/nonexistent/silero_vad.onnx")


def test_new_returns_none_for_a_present_but_invalid_model_file(tmp_path: Path) -> None:
    """A file that EXISTS but is not a valid ONNX graph must still come back
    `None` through `.new()` — whatever `onnxruntime.InferenceSession` raises
    for a corrupt file is swallowed exactly like a missing one."""
    bogus = tmp_path / "garbage.onnx"
    bogus.write_bytes(b"this is not an onnx model\x00\x01\x02")
    assert vad.NeuralVad.new(str(bogus)) is None


def test_new_uses_vad_model_path_override_when_no_explicit_path_given() -> None:
    """`NeuralVad.new()` with no argument reaches for `_vad_model_path()`
    itself — exactly Rust's zero-argument `NeuralVad::new()`, which calls
    the module's own `vad_model_path()` internally rather than taking a path
    parameter."""
    vad.set_vad_model_path("/nonexistent/silero_vad.onnx")
    assert vad.NeuralVad.new() is None


# ------------------------------------------------- malformed `fresh` guard


def test_probs_rejects_fresh_not_a_whole_multiple_of_frame() -> None:
    """Deliberate strengthening past the Rust source (see module docstring):
    a `ValueError`, not silent floor-division truncation."""
    nv = _bare_vad()
    with pytest.raises(ValueError, match="multiple of FRAME"):
        nv.probs(np.zeros(FRAME - 1, dtype=np.float32))
    with pytest.raises(ValueError, match="multiple of FRAME"):
        nv.probs(np.zeros(FRAME + 100, dtype=np.float32))


def test_probs_rejects_non_1d_fresh() -> None:
    nv = _bare_vad()
    with pytest.raises(ValueError, match="1-D"):
        nv.probs(np.zeros((2, FRAME), dtype=np.float32))


def test_probs_accepts_an_empty_fresh_buffer() -> None:
    """0 IS technically a whole multiple of FRAME — a degenerate but valid
    call, not an error (see the module docstring's "Malformed `fresh`"
    section: this is a literal reading of Rust's own stated precondition,
    not a stricter one)."""
    nv = _bare_vad()
    nv._score_buffer = lambda buf: np.zeros(buf.shape[0] // FRAME, dtype=np.float32)  # type: ignore[method-assign]
    out = nv.probs(np.zeros(0, dtype=np.float32))
    assert out is not None
    assert out.shape == (0,)


# --------------------------------------------------- tail bookkeeping (fake)


def test_tail_bookkeeping_across_two_consecutive_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    """Deterministic, model-free test of the exact rule: `tail` becomes the
    last `min(len(tail + fresh), VAD_TAIL)` samples of the concatenated
    buffer, carried into the NEXT call — checked across two calls so the
    "carried across calls" part is actually exercised, not merely the
    single-call arithmetic.
    """

    def fake_score(self: vad.NeuralVad, buf: np.ndarray) -> np.ndarray:
        return np.arange(buf.shape[0] // FRAME, dtype=np.float32)

    monkeypatch.setattr(vad.NeuralVad, "_score_buffer", fake_score)
    nv = _bare_vad()

    fresh1 = np.full(FRAME * 3, 1.0, dtype=np.float32)
    out1 = nv.probs(fresh1)
    assert out1 is not None and out1.shape == (3,)
    # 3 frames * FRAME < VAD_TAIL (22 frames) -> the whole thing is kept.
    assert nv.tail.shape[0] == FRAME * 3
    assert np.array_equal(nv.tail, fresh1)

    # 20 frames: `fresh1 + fresh2` (23 frames = 11776 samples) is bigger than
    # VAD_TAIL (22 frames = 11264 samples), so the tail DOES get capped --
    # but fresh2 ALONE (10240 samples) is still short of VAD_TAIL, so the cap
    # point falls inside fresh1's region and the resulting tail straddles
    # both: some trailing `1.0` samples of fresh1 plus all of fresh2's `2.0`
    # samples.
    fresh2 = np.full(FRAME * 20, 2.0, dtype=np.float32)
    out2 = nv.probs(fresh2)
    assert out2 is not None and out2.shape == (20,)
    expected_buf = np.concatenate([fresh1, fresh2])
    expected_tail = expected_buf[-vad.VAD_TAIL :]
    assert nv.tail.shape[0] == vad.VAD_TAIL
    assert np.array_equal(nv.tail, expected_tail)
    n_ones = int(np.sum(expected_tail == 1.0))
    assert n_ones == 1024, (
        f"test setup: expected exactly 1024 trailing fresh1 samples in the "
        f"capped tail, got {n_ones} -- the tail should straddle both calls"
    )


def test_tail_updates_even_when_scoring_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """The tail update is UNCONDITIONAL — it happens even when detection
    itself failed, exactly matching the Rust source's control flow (the
    tail-update line runs after, not inside, the `.ok().map(...)` chain)."""

    def raising_score(self: vad.NeuralVad, buf: np.ndarray) -> np.ndarray:
        raise RuntimeError("simulated detection failure")

    monkeypatch.setattr(vad.NeuralVad, "_score_buffer", raising_score)
    nv = _bare_vad()

    fresh = np.full(FRAME * 2, 3.0, dtype=np.float32)
    result = nv.probs(fresh)
    assert result is None
    assert nv.tail.shape[0] == FRAME * 2
    assert np.array_equal(nv.tail, fresh)


def test_probs_returns_none_when_scored_length_mismatches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`out.filter(|p| p.len() == fresh.len() / FRAME)` in Rust — a scored
    array of the wrong length is treated as a failure, exactly like a raised
    exception."""

    def wrong_length_score(self: vad.NeuralVad, buf: np.ndarray) -> np.ndarray:
        return np.zeros(1, dtype=np.float32)

    monkeypatch.setattr(vad.NeuralVad, "_score_buffer", wrong_length_score)
    nv = _bare_vad()
    assert nv.probs(np.zeros(FRAME * 3, dtype=np.float32)) is None
    # ...but the tail STILL updates (unconditional, see the test above).
    assert nv.tail.shape[0] == FRAME * 3


def test_tail_slice_does_not_alias_the_scoring_buffer(monkeypatch: pytest.MonkeyPatch) -> None:
    """`self.tail` must be an independent copy, not a numpy VIEW into the
    (potentially much larger) `tail + fresh` buffer `_score_buffer` was
    handed — otherwise the whole buffer stays resident in memory for as long
    as the small tail is kept. Mutating the buffer `_score_buffer` saw must
    not change `self.tail` afterwards."""
    seen: list[np.ndarray] = []

    def capturing_score(self: vad.NeuralVad, buf: np.ndarray) -> np.ndarray:
        seen.append(buf)
        return np.zeros(buf.shape[0] // FRAME, dtype=np.float32)

    monkeypatch.setattr(vad.NeuralVad, "_score_buffer", capturing_score)
    nv = _bare_vad()
    nv.probs(np.full(FRAME * 2, 5.0, dtype=np.float32))
    seen[0][:] = -1.0  # mutate the buffer the scorer saw
    assert not np.any(nv.tail == -1.0), "self.tail aliased the scoring buffer"


# ------------------------------------------------------- (1) real say audio


@requires_model
def test_real_speech_scores_meaningfully_higher_than_real_silence(say_pcm: np.ndarray) -> None:
    nv = vad.NeuralVad.new(VAD_ONNX_PATH)
    assert nv is not None

    speech = _trim_to_frame(say_pcm)
    speech_probs = nv.probs(speech)
    assert speech_probs is not None
    assert speech_probs.shape == (speech.shape[0] // FRAME,)

    nv2 = vad.NeuralVad.new(VAD_ONNX_PATH)
    assert nv2 is not None
    silence = np.zeros(FRAME * 30, dtype=np.float32)
    silence_probs = nv2.probs(silence)
    assert silence_probs is not None

    assert float(speech_probs.mean()) > 0.5, f"speech scored too low: {speech_probs.mean()}"
    assert float(silence_probs.mean()) < 0.1, f"silence scored too high: {silence_probs.mean()}"
    assert float(speech_probs.mean()) > float(silence_probs.mean()) + 0.3


@requires_model
def test_new_returns_a_working_instance_via_set_vad_model_path(say_pcm: np.ndarray) -> None:
    """The production call-site shape: `set_vad_model_path` once, then
    `NeuralVad.new()` with no argument (see the module docstring's note on
    the Rust source's zero-argument `new()`)."""
    vad.set_vad_model_path(VAD_ONNX_PATH)
    nv = vad.NeuralVad.new()
    assert nv is not None
    speech = _trim_to_frame(say_pcm)
    probs = nv.probs(speech)
    assert probs is not None
    assert float(probs.mean()) > 0.5


@requires_model
def test_rolling_tail_makes_the_second_real_call_informed_by_the_first(
    say_pcm: np.ndarray,
) -> None:
    """The rolling-tail behavior with REAL audio and the REAL model: split
    one real utterance into two chunks, feed them as two consecutive
    `probs()` calls on the SAME `NeuralVad`, and confirm the second call's
    result is measurably different from feeding that same second chunk COLD
    (a fresh `NeuralVad`, empty tail) — i.e., the second call is genuinely
    informed by state carried from the first, not merely running the same
    computation twice.
    """
    speech = _trim_to_frame(say_pcm)
    half = (speech.shape[0] // 2 // FRAME) * FRAME
    first_half, second_half = speech[:half], speech[half : half + (speech.shape[0] - half) // FRAME * FRAME]
    assert first_half.shape[0] > 0 and second_half.shape[0] > 0

    warm = vad.NeuralVad.new(VAD_ONNX_PATH)
    assert warm is not None
    warm.probs(first_half)  # establishes tail state
    with_tail = warm.probs(second_half)
    assert with_tail is not None

    cold = vad.NeuralVad.new(VAD_ONNX_PATH)
    assert cold is not None
    without_tail = cold.probs(second_half)
    assert without_tail is not None

    assert with_tail.shape == without_tail.shape
    diff = np.abs(with_tail.astype(np.float64) - without_tail.astype(np.float64))
    # The effect concentrates in the FIRST few frames of `second_half`
    # (exactly where "the state has a runway to settle" predicts it should).
    # A whole-segment mean would dilute this real, concentrated effect into
    # noise for a long `second_half` — so this checks where the mechanism
    # actually predicts the difference shows up, not an arbitrary global
    # average.
    early_mean_diff = float(diff[:3].mean())
    assert early_mean_diff > 0.02, (
        f"the tail-primed and cold-start calls scored the start of the same "
        f"second chunk nearly identically (mean abs diff over the first 3 "
        f"frames: {early_mean_diff}; full-segment diff: {diff}) -- the tail "
        f"is not actually informing the second call"
    )


@requires_model
def test_two_different_tail_histories_make_the_same_fresh_audio_score_differently(
    say_pcm: np.ndarray, tmp_path: Path
) -> None:
    """Adversarial: `test_rolling_tail_makes_the_second_real_call_informed_by_
    the_first` above only proves "some real tail" differs from "no tail at
    all" (cold start) — it does not rule out the tail's mere PRESENCE (vs.
    absence) being the whole story, with its actual CONTENT not mattering.
    This test holds `fresh` completely fixed and swaps only what precedes
    it: a real, distinct utterance ("nine eight seven...") as one tail vs.
    real digital silence as the other, both trimmed to the exact same
    length. If the tail's specific content is genuinely feeding the model's
    state (not just its presence flipping some internal flag), the two
    non-empty, differently-CONTENTED tails must produce measurably
    different probabilities for the identical fresh frames right at the
    boundary — and the difference must fade deeper into `fresh`, exactly
    where "the state settles back down to what the fresh audio itself
    dictates" predicts it should.
    """
    proc = subprocess.run(
        ["/usr/bin/say", "-o", str(tmp_path / "digits.aiff"), "nine eight seven six five four three two one zero"],
        capture_output=True,
    )
    if proc.returncode != 0 or not (tmp_path / "digits.aiff").exists():
        pytest.skip(f"`say` failed: {proc.stderr!r}")
    other_speech = _trim_to_frame(decode_to_pcm(tmp_path / "digits.aiff", MediaKind.AUDIO))
    fresh = _trim_to_frame(say_pcm)
    assert other_speech.shape[0] >= vad.VAD_TAIL and fresh.shape[0] >= vad.VAD_TAIL * 2

    tail_speech = other_speech[-vad.VAD_TAIL :]
    tail_silence = np.zeros_like(tail_speech)
    # Sanity: the two tail histories are genuinely different from each
    # other, and neither is degenerate (all-zero speech would make this a
    # vacuous comparison).
    assert not np.array_equal(tail_speech, tail_silence)
    assert float(np.abs(tail_speech).mean()) > 0.01

    nv_speech_tail = vad.NeuralVad.new(VAD_ONNX_PATH)
    assert nv_speech_tail is not None
    nv_speech_tail.tail = tail_speech.copy()
    scored_after_speech_tail = nv_speech_tail.probs(fresh)

    nv_silence_tail = vad.NeuralVad.new(VAD_ONNX_PATH)
    assert nv_silence_tail is not None
    nv_silence_tail.tail = tail_silence.copy()
    scored_after_silence_tail = nv_silence_tail.probs(fresh)

    assert scored_after_speech_tail is not None
    assert scored_after_silence_tail is not None
    assert scored_after_speech_tail.shape == scored_after_silence_tail.shape

    diff = np.abs(scored_after_speech_tail.astype(np.float64) - scored_after_silence_tail.astype(np.float64))
    early_mean_diff = float(diff[:3].mean())
    late_mean_diff = float(diff[-3:].mean())
    assert early_mean_diff > 0.05, (
        f"identical `fresh` audio scored nearly identically at the chunk "
        f"boundary despite two DIFFERENT non-empty tail histories preceding "
        f"it (speech-tail vs. silence-tail); mean abs diff over the first 3 "
        f"frames: {early_mean_diff}; full diff: {diff} -- the tail's actual "
        f"content is not informing detection, only its presence/absence is"
    )
    # The boundary effect must actually be a BOUNDARY effect, not a constant
    # offset baked into every frame regardless of position -- confirms the
    # rolling tail's influence genuinely concentrates where "state settling"
    # predicts it should, and fades once `fresh` itself dominates the state.
    assert early_mean_diff > late_mean_diff, (
        f"the speech-tail-vs-silence-tail difference did not shrink deeper "
        f"into `fresh` (early: {early_mean_diff}, late: {late_mean_diff}) -- "
        f"expected a transient boundary effect, not a uniform offset"
    )
