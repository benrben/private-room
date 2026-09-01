"""Tests for `arcelle_sidecar.stt.engine` — the whole-file transcription path
ported from `src-tauri/src/stt.rs` (module doc + `MODEL_FILE`/`MODEL_URL`/
`MODEL_SIZE_MB` constants, lines 1-30; the `CTX` warm-context `Mutex`,
`warm_context`, `unload_ctx`, `unload_model`, `transcribe`, lines 173-309).

Uses the REAL, Metal-enabled `pywhispercpp` package and the real downloaded
model file — no mocking of the transcription itself. Model-loading tests are
slow (multi-second Metal init); that's expected. A couple of fast auxiliary
tests use a fake `Model` stand-in (via `monkeypatch`) to exercise pure
bookkeeping logic (the busy/ref-count mechanism, `n_threads` clamping) that
doesn't need Metal at all.

Every test starts and ends with an empty warm-context cache (function-scoped
autouse fixture): a warm Metal context left resident at process exit is what
`unload_ctx` exists to avoid on the Rust side (`ggml_metal_device_free`
asserts if GPU buffers are still resident), and tests that check
reload-vs-cache-hit behavior need a known starting state each time.
"""

from __future__ import annotations

import os
import subprocess
import threading
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from arcelle_sidecar.media.decode import MediaKind, decode_to_pcm
from arcelle_sidecar.stt import engine
from pywhispercpp.model import Model

_MODEL_ENV = "ARCELLE_TEST_WHISPER_MODEL"
_REPO_ROOT = Path(__file__).resolve().parents[3]


def _resolve_whisper_model() -> Path:
    if override := os.environ.get(_MODEL_ENV):
        path = Path(override).expanduser().resolve()
        if not path.is_file():
            raise FileNotFoundError(f"{_MODEL_ENV} does not name a file: {path}")
        return path

    downloaded = (
        Path.home()
        / "Library/Application Support/com.benreich.privateroom/models"
        / "ggml-large-v3-turbo-q5_0.bin"
    )
    bundled = (
        _REPO_ROOT / "apps/desktop/resources/models/ggml-large-v3-turbo-q5_0.bin",
        _REPO_ROOT / "apps/desktop/assets/models/ggml-large-v3-turbo-q5_0.bin",
    )
    return next((path for path in (downloaded, *bundled) if path.is_file()), bundled[0])


MODEL_PATH = str(_resolve_whisper_model())
_HAS_MODEL = Path(MODEL_PATH).exists()
_HAS_SAY = Path("/usr/bin/say").exists()
_HAS_AFCONVERT = Path("/usr/bin/afconvert").exists()
_HAS_MODEL_AND_TOOLS = _HAS_MODEL and _HAS_SAY and _HAS_AFCONVERT

requires_model = pytest.mark.skipif(
    not _HAS_MODEL_AND_TOOLS,
    reason=f"requires a Whisper model ({_MODEL_ENV}) + macOS `say`/`afconvert`",
)


@pytest.fixture(autouse=True)
def _clean_warm_cache():
    engine.unload_ctx()
    yield
    engine.unload_ctx()


@pytest.fixture(scope="module")
def say_pcm(tmp_path_factory: pytest.TempPathFactory) -> np.ndarray:
    """Real 16 kHz mono PCM for "the quick brown fox..." via macOS `say` +
    the sidecar's own `decode_to_pcm` — the same decoder `stt.rs`'s own
    `e2e_say_roundtrip` test uses.
    """
    if not _HAS_MODEL_AND_TOOLS:
        pytest.skip("requires the downloaded model + macOS `say`/`afconvert`")
    d = tmp_path_factory.mktemp("stt_engine_audio")
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


# --------------------------------------------------------------- format_stamp


def test_format_stamp_matches_rust_cases() -> None:
    # Same five cases as `stt.rs`'s `timestamp_format` unit test.
    assert engine.format_stamp(0) == "[0:00]"
    assert engine.format_stamp(6_590) == "[1:05]"  # 65.9s, centiseconds
    assert engine.format_stamp(75_400) == "[12:34]"
    assert engine.format_stamp(360_000 + 75_400) == "[1:12:34]"
    assert engine.format_stamp(-300) == "[0:00]"


# ------------------------------------------------------------------ n_threads


def test_n_threads_clamps_to_8(monkeypatch: pytest.MonkeyPatch) -> None:
    """`available_parallelism().min(8)`, Python side; `unwrap_or(4)` when
    `os.cpu_count()` can't tell (returns `None`)."""
    monkeypatch.setattr(engine.os, "cpu_count", lambda: 16)
    assert engine._n_threads() == 8
    monkeypatch.setattr(engine.os, "cpu_count", lambda: 4)
    assert engine._n_threads() == 4
    monkeypatch.setattr(engine.os, "cpu_count", lambda: None)
    assert engine._n_threads() == 4


# --------------------------------------------- (2) silence never touches it


def test_transcribe_under_1600_samples_returns_empty_without_touching_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = {"n": 0}
    orig_init = Model.__init__

    def counting_init(self, *a, **kw):
        calls["n"] += 1
        return orig_init(self, *a, **kw)

    monkeypatch.setattr(Model, "__init__", counting_init)

    # Fewer than 1600 samples (< 0.1s @ 16kHz) — and a model path that does
    # not exist, so if the guard were ever bypassed this would raise instead
    # of silently "working".
    tiny = np.zeros(1599, dtype=np.float32)
    assert engine.transcribe("/nonexistent/whisper-model.bin", tiny, False) == ""
    assert engine.transcribe("/nonexistent/whisper-model.bin", tiny, True) == ""
    assert calls["n"] == 0, "silence under the 1600-sample floor touched the model"
    assert engine._cache is None


def test_transcribe_uses_a_fake_recognizer_for_segment_filtering_and_timestamps(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []

    class _FakeModel:
        def __init__(self, *_args, **_kwargs) -> None:
            self._ctx = object()

        def transcribe(self, _pcm: np.ndarray, **kwargs: object):
            calls.append(kwargs)
            return [
                SimpleNamespace(text=" [BLANK_AUDIO] ", t0=0),
                SimpleNamespace(text=" Thank you. ", t0=100),
                SimpleNamespace(text=" Thank you. ", t0=200),
                SimpleNamespace(text="  Real speech  ", t0=300),
            ]

    monkeypatch.setattr(engine, "Model", _FakeModel)
    monkeypatch.setattr(engine, "_n_threads", lambda: 3)
    monkeypatch.setattr(
        engine,
        "_segment_mean_p",
        lambda _ctx, index: 0.1 if index == 1 else 0.9,
    )
    pcm = np.zeros(1600, dtype=np.int16)

    assert engine.transcribe("/fake/whisper.bin", pcm, False) == "Thank you. Real speech"
    assert engine.transcribe("/fake/whisper.bin", pcm, True) == (
        "[0:02] Thank you.\n[0:03] Real speech"
    )
    assert calls == [
        {
            "language": "auto",
            "n_threads": 3,
            "greedy": {"best_of": 1},
            "print_special": False,
            "print_progress": False,
            "print_realtime": False,
            "print_timestamps": False,
        },
    ] * 2


# --------------------------------------------------- (1) real say roundtrip


@requires_model
def test_say_roundtrip_with_and_without_timestamps(say_pcm: np.ndarray) -> None:
    text = engine.transcribe(MODEL_PATH, say_pcm, False).lower()
    assert "quick brown fox" in text, f"unexpected transcript: {text!r}"

    stamped = engine.transcribe(MODEL_PATH, say_pcm, True)
    assert "quick brown fox" in stamped.lower(), f"unexpected transcript: {stamped!r}"
    assert stamped.startswith("[0:00]"), f"missing timestamp: {stamped!r}"


# ------------------------------------------------------- (3) unload_model


@requires_model
def test_unload_model_wrong_path_leaves_cache_warm_then_real_path_clears_it(
    say_pcm: np.ndarray, monkeypatch: pytest.MonkeyPatch
) -> None:
    construction_count = 0
    real_init = Model.__init__

    def counting_init(self, *args, **kwargs):
        nonlocal construction_count
        construction_count += 1
        return real_init(self, *args, **kwargs)

    monkeypatch.setattr(Model, "__init__", counting_init)

    text1 = engine.transcribe(MODEL_PATH, say_pcm, False)
    assert construction_count == 1
    assert "quick brown fox" in text1.lower()

    # A different model path is nothing to do — the real cache must stay warm.
    assert engine.unload_model("/nonexistent/other-model.bin") is True
    assert construction_count == 1, "unload_model touched the wrong cache entry"
    assert engine._cache is not None and engine._cache.path == MODEL_PATH

    # Transcribing the SAME model again must be a cache hit: no reconstruction.
    text2 = engine.transcribe(MODEL_PATH, say_pcm, False)
    assert construction_count == 1, "transcribing the SAME model reconstructed it"
    assert text2 == text1

    # Now release the real one: must report success and actually clear it.
    assert engine.unload_model(MODEL_PATH) is True
    assert engine._cache is None

    text3 = engine.transcribe(MODEL_PATH, say_pcm, False)
    assert construction_count == 2, "unload_model didn't actually release the cached context"
    assert text3 == text1


def test_unload_model_returns_false_while_the_lock_itself_is_held() -> None:
    """Literal port of the Rust unit test
    `unload_model_says_when_a_decode_still_holds_the_weights`
    (`src-tauri/src/stt.rs` lines 647-661): holds the bookkeeping lock
    directly to simulate contention, exactly as the Rust test holds
    `CTX.lock()` directly rather than fabricating a real in-flight decode.
    """
    fake = "/nonexistent/whisper-model.bin"
    # Nothing warm — or somebody else's model warm — is nothing to do.
    assert engine.unload_model(fake) is True, "an idle context read as busy"

    held = engine._lock.acquire(blocking=False)
    assert held, "test setup: lock should have been free"
    try:
        assert engine.unload_model(fake) is False, (
            "a busy lock read as free, and a genuinely in-flight lookup "
            "could be yanked out from under itself"
        )
    finally:
        engine._lock.release()
    assert engine.unload_model(fake) is True


def test_unload_model_defers_while_a_real_decode_is_in_flight(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exercises the ref-count mechanism that stands in for Rust's
    `Arc::strong_count(ctx) > 1` check: a transcription that has released the
    bookkeeping lock but is still decoding must make `unload_model` answer
    "come back later", not report a false success that would leak the weights
    for the rest of the session. Uses a fake `Model` (no Metal needed) to
    control timing deterministically, with a real background thread so the
    check exercises actual concurrent locking rather than a hand-simulated
    ref bump — this is the scenario that would catch a `_checkout` that bumps
    `refs` in a SEPARATE lock acquisition from the cache lookup/construction
    (a race: `unload_model` could see "just constructed, refs == 0" and free
    the entry a decode is about to use).
    """
    path = "/fake/model-for-busy-test.bin"
    started = threading.Event()
    release_gate = threading.Event()

    class _FakeModel:
        def __init__(self, *_args, **_kwargs) -> None:
            self._ctx = None

        def transcribe(self, *_args, **_kwargs):
            started.set()
            assert release_gate.wait(timeout=5), "test never released the fake decode"
            return []

    monkeypatch.setattr(engine, "Model", _FakeModel)

    pcm = np.ones(2000, dtype=np.float32)
    result: dict[str, str] = {}

    def run() -> None:
        result["text"] = engine.transcribe(path, pcm, False)

    thread = threading.Thread(target=run)
    thread.start()
    try:
        assert started.wait(timeout=5), "fake decode never started"
        # The decode has released the bookkeeping lock (see `transcribe`) but
        # is still "in flight" — unload_model must defer, not free the slot.
        assert engine.unload_model(path) is False
    finally:
        release_gate.set()
        thread.join(timeout=5)
    assert not thread.is_alive()
    assert result["text"] == ""

    # Now that the decode is done, the same call must succeed.
    assert engine.unload_model(path) is True


# --------------------------------------------------------- (4) unload_ctx


@requires_model
def test_unload_ctx_then_transcribe_reloads_transparently(say_pcm: np.ndarray) -> None:
    text1 = engine.transcribe(MODEL_PATH, say_pcm, False)
    assert "quick brown fox" in text1.lower()

    engine.unload_ctx()
    assert engine._cache is None

    text2 = engine.transcribe(MODEL_PATH, say_pcm, True)
    assert "quick brown fox" in text2.lower()
    assert text2.startswith("[0:00]")


# ------------------------------------------------- segment_mean_p divergence


@requires_model
def test_segment_mean_p_matches_manual_arithmetic_mean_over_real_tokens(
    say_pcm: np.ndarray,
) -> None:
    """`_segment_mean_p` is a byte-faithful port of Rust's `segment_mean_p`
    (an ARITHMETIC mean of token probabilities, skipping specials) computed
    via the low-level `_pywhispercpp` bindings — NOT
    `pywhispercpp.Segment.probability`, which is a GEOMETRIC mean (see the
    module docstring's divergence note). Recomputes the same arithmetic mean
    by hand from the same bindings and checks they agree exactly, and that it
    lands in [0, 1].

    The hand recompute below reads RAW bytes via `whisper_token_to_bytes`,
    like `_segment_mean_p` itself — never `whisper_full_get_token_text`,
    which raises `UnicodeDecodeError` on a token that is half of a
    multi-byte UTF-8 character (see `test_segment_mean_p_survives_hebrew_
    multibyte_token_split` below for the real crash this must not reintroduce
    into the test's own "expected" computation).
    """
    import _pywhispercpp as pw

    model = engine.warm_context(MODEL_PATH)
    segments = model.transcribe(
        say_pcm,
        n_threads=engine._n_threads(),
        language="auto",
        greedy={"best_of": 1},
        print_special=False,
        print_progress=False,
        print_realtime=False,
        print_timestamps=False,
    )
    assert len(segments) >= 1
    ctx = model._ctx
    for i in range(len(segments)):
        n = pw.whisper_full_n_tokens(ctx, i)
        probs = [
            pw.whisper_full_get_token_p(ctx, i, j)
            for j in range(n)
            if not pw.whisper_token_to_bytes(
                ctx, pw.whisper_full_get_token_id(ctx, i, j)
            ).startswith((b"[_", b"<|"))
        ]
        expected = sum(probs) / len(probs) if probs else 0.0
        got = engine._segment_mean_p(ctx, i)
        assert got == pytest.approx(expected)
        assert 0.0 <= got <= 1.0


@requires_model
def test_segment_mean_p_survives_hebrew_multibyte_token_split(tmp_path: Path) -> None:
    """Regression test for a real crash: whisper.cpp's BPE routinely splits a
    multi-byte UTF-8 character across two tokens (confirmed on this exact
    phrase against the real model — Hebrew tokens like a lone `\\xd7` or a
    trailing continuation byte are common). `whisper_full_get_token_text`
    (a `str`-returning binding, strict-UTF-8 decode on the C side) raises
    `UnicodeDecodeError` on such a token; `_segment_mean_p` must not use it
    for exactly that reason (see the module docstring's DIVERGENCE 1 note).
    This synthesizes real Hebrew speech, transcribes it, and asserts
    `_segment_mean_p` returns a plain float in [0, 1] for every segment
    without raising — skipped if the Hebrew `Carmit` voice isn't installed,
    like the Rust source's own `e2e_hebrew_words_no_mojibake` test.
    """
    aiff = tmp_path / "pr-stt-heb-mp.aiff"
    ok = subprocess.run(  # noqa: S603
        [
            "/usr/bin/say",
            "-v",
            "Carmit",
            "-o",
            str(aiff),
            "שלום עולם, מה שלומך היום? אני רוצה לבדוק את המודל הזה עם טקסט ארוך יותר בעברית.",
        ],
        capture_output=True,
    )
    if ok.returncode != 0:
        pytest.skip("`say -v Carmit` (Hebrew voice) unavailable")

    pcm = decode_to_pcm(aiff, MediaKind.AUDIO)
    model = engine.warm_context(MODEL_PATH)
    segments = model.transcribe(
        pcm,
        n_threads=engine._n_threads(),
        language="auto",
        greedy={"best_of": 1},
        print_special=False,
        print_progress=False,
        print_realtime=False,
        print_timestamps=False,
    )
    assert len(segments) >= 1
    ctx = model._ctx
    for i in range(len(segments)):
        got = engine._segment_mean_p(ctx, i)  # must not raise UnicodeDecodeError
        assert 0.0 <= got <= 1.0
