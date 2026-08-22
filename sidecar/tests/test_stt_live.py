"""Tests for `arcelle_sidecar.stt.live` — the live-recording word-timestamp
transcription path ported from `src-tauri/src/stt.rs` lines 311-628
(`SegOut`, `LangMode`, `PhraseOut`, `transcribe_segments`).

NOT re-ported here (already covered elsewhere, per the batch instructions):
`merge_words_reassembles_utf8_split_across_tokens` and
`merge_words_ascii_subwords_and_punctuation` (`stt.rs` lines 757-799) —
`merge_token_words` lives in `arcelle_sidecar/stt/hallucination.py` and is
tested in `tests/test_hallucination.py`, along with `is_junk_segment`/
`is_stock_hallucination`. `segment_mean_p` likewise has no standalone port
here — `transcribe_segments` needs its own inline per-token walk (it also
needs `plog`, which `engine.py`'s `_segment_mean_p` never computes), and that
walk is exercised directly by the fake-decode tests below.

`test_e2e_segments_with_words` and `test_e2e_hebrew_words_no_mojibake` are
direct ports of the real `#[test]` functions of the same name in `stt.rs`'s
`mod tests` (lines 837-901) — same audio, same assertions. They need the
real, Metal-enabled model and are skipped (not merely marked) when it is not
present on this machine, exactly like the Rust tests are `#[ignore]`d without
`cargo test -- --ignored`.

Everything else here is additional coverage the ground rules ask for beyond
the two named e2e tests: the <3200-sample early return, the
stock-hallucination-vs-confidence interaction, the reference silence rule's
AND (no-speech-probability together with low avg-logprob), and `LangMode`'s
four cases each producing the right forced-language/strategy/detection
combination. These use a small in-memory fake for the low-level `_pw`
surface `transcribe_segments` calls directly (see `live.py`'s module
docstring's DECISION note for why it calls `_pw.whisper_full` directly rather
than `Model.transcribe()`) — real branching logic in `transcribe_segments`
runs on every one of these, only the C decode itself is faked.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from pywhispercpp.model import Model

from arcelle_sidecar.media.decode import MediaKind, decode_to_pcm
from arcelle_sidecar.stt import engine
from arcelle_sidecar.stt import live

# The model for on-device tests: the user-downloaded copy if present, else
# the repo's bundled-resource copy — port of `stt.rs`'s own `test_model()`
# helper (lines 674-685).
_DOWNLOADED_MODEL = (
    Path.home()
    / "Library/Application Support/com.benreich.privateroom/models"
    / "ggml-large-v3-turbo-q5_0.bin"
)
_BUNDLED_MODEL = Path(
    "/Users/benreich/private-room/src-tauri/resources/models/ggml-large-v3-turbo-q5_0.bin"
)
MODEL_PATH = str(_DOWNLOADED_MODEL if _DOWNLOADED_MODEL.exists() else _BUNDLED_MODEL)
_HAS_MODEL = Path(MODEL_PATH).exists()
_HAS_SAY = Path("/usr/bin/say").exists()
_HAS_AFCONVERT = Path("/usr/bin/afconvert").exists()
_HAS_MODEL_AND_TOOLS = _HAS_MODEL and _HAS_SAY and _HAS_AFCONVERT

requires_model = pytest.mark.skipif(
    not _HAS_MODEL_AND_TOOLS,
    reason=f"requires the downloaded model at {MODEL_PATH} + macOS `say`/`afconvert`",
)


@pytest.fixture(autouse=True)
def _clean_warm_cache():
    """Same discipline as `test_engine.py`'s fixture of the same name: a warm
    Metal context left resident at process exit is what `unload_ctx` exists
    to avoid, and cache-sharing tests need a known starting state.
    """
    engine.unload_ctx()
    yield
    engine.unload_ctx()


@pytest.fixture(scope="module")
def say_pcm(tmp_path_factory: pytest.TempPathFactory) -> np.ndarray:
    """Real 16 kHz mono PCM for "the quick brown fox..." via macOS `say` +
    the sidecar's own `decode_to_pcm` — what `stt.rs`'s own
    `e2e_segments_with_words` test uses.
    """
    if not _HAS_MODEL_AND_TOOLS:
        pytest.skip("requires the downloaded model + macOS `say`/`afconvert`")
    d = tmp_path_factory.mktemp("stt_live_audio")
    aiff = d / "quick_fox.aiff"
    proc = subprocess.run(
        ["/usr/bin/say", "-o", str(aiff), "The quick brown fox jumps over the lazy dog."],
        capture_output=True,
    )
    if proc.returncode != 0 or not aiff.exists():
        pytest.skip(f"`say` failed: {proc.stderr!r}")
    pcm = decode_to_pcm(aiff, MediaKind.AUDIO)
    assert pcm.shape[0] > 16000, "decoded under a second of audio"
    return pcm


# ------------------------------------------------------------- fake _pw layer
#
# `transcribe_segments` talks to `_pw.whisper_full*` DIRECTLY (see `live.py`'s
# module docstring), never through `Model.transcribe()` — so faking those
# functions exercises the real branching logic in `transcribe_segments`
# itself (is_junk_segment/is_stock_hallucination/silence-rule skips,
# merge_token_words, LangMode -> strategy/language/detection), with only the
# C decode faked out. `_pw.whisper_full_default_params` and
# `whisper_sampling_strategy` are left REAL (unpatched): they don't need
# Metal, and asserting against the genuine enum/params object is stronger
# than asserting against a hand-rolled stand-in.


@dataclass
class _FakeToken:
    id: int
    raw: bytes
    p: float
    plog: float
    t0: int
    t1: int


@dataclass
class _FakeSegment:
    text: bytes
    t0: int
    t1: int
    tokens: list[_FakeToken] = field(default_factory=list)


class _FakeModel:
    """Stands in for `pywhispercpp.model.Model` in the cache — no Metal, no
    real weights. `transcribe_segments` never calls `.transcribe()` on this
    (see `live.py`'s DECISION note), only reads `._ctx`, so the fake needs
    nothing else.
    """

    def __init__(self, *_args, **_kwargs) -> None:
        self._ctx = object()


@pytest.fixture
def fake_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(engine, "Model", _FakeModel)


def _install_fake_pw(
    monkeypatch: pytest.MonkeyPatch,
    segments: list[_FakeSegment],
    *,
    decoded_lang_id: int = 0,
    lang_map: dict[int, str] | None = None,
    detect_id: int | None = None,
    detect_prob: float = 0.0,
) -> dict:
    """Installs fakes for the low-level `_pw` decode surface and returns a
    `calls` dict recording what `whisper_full` was actually invoked with
    (read off the REAL params object `transcribe_segments` built — only the
    decode call itself, not the params machinery, is faked).

    `lang_map` answers `whisper_lang_str` for both the post-decode
    `whisper_full_lang_id` readback (`decoded_lang_id`) and a `lang_detect`
    hit (`detect_id`) — deliberately separate ids so a Watch test can prove
    the decode language and the detected language are read independently and
    can genuinely disagree, exactly as the Rust doc comment on `Watch`
    describes.
    """
    lang_map = lang_map or {0: "en"}
    calls: dict = {}

    def fake_whisper_full(ctx, params, samples, n):  # noqa: ARG001
        calls["language"] = params.language
        calls["strategy"] = params.strategy
        calls["token_timestamps"] = params.token_timestamps
        calls["suppress_blank"] = params.suppress_blank
        calls["suppress_nst"] = params.suppress_nst
        calls["no_context"] = params.no_context
        calls["n_threads"] = params.n_threads
        return 0

    def fake_n_segments(ctx) -> int:  # noqa: ARG001
        return len(segments)

    def fake_segment_text(ctx, i: int) -> bytes:  # noqa: ARG001
        return segments[i].text

    def fake_segment_t0(ctx, i: int) -> int:  # noqa: ARG001
        return segments[i].t0

    def fake_segment_t1(ctx, i: int) -> int:  # noqa: ARG001
        return segments[i].t1

    def fake_n_tokens(ctx, i: int) -> int:  # noqa: ARG001
        return len(segments[i].tokens)

    def fake_token_id(ctx, i: int, j: int) -> int:  # noqa: ARG001
        return segments[i].tokens[j].id

    def fake_token_bytes(ctx, token_id: int) -> bytes:  # noqa: ARG001
        for seg in segments:
            for tok in seg.tokens:
                if tok.id == token_id:
                    return tok.raw
        raise AssertionError(f"unknown token id {token_id}")

    def fake_token_data(ctx, i: int, j: int):  # noqa: ARG001
        tok = segments[i].tokens[j]
        return SimpleNamespace(p=tok.p, plog=tok.plog, t0=tok.t0, t1=tok.t1)

    def fake_lang_id(ctx) -> int:  # noqa: ARG001
        return decoded_lang_id

    def fake_lang_str(lang_id: int) -> str | None:
        return lang_map.get(lang_id)

    def fake_lang_auto_detect(ctx, offset_ms, n_threads, probs):  # noqa: ARG001
        if detect_id is None:
            return -1
        probs[detect_id] = detect_prob
        return detect_id

    monkeypatch.setattr(live._pw, "whisper_full", fake_whisper_full)
    monkeypatch.setattr(live._pw, "whisper_full_n_segments", fake_n_segments)
    monkeypatch.setattr(live._pw, "whisper_full_get_segment_text", fake_segment_text)
    monkeypatch.setattr(live._pw, "whisper_full_get_segment_t0", fake_segment_t0)
    monkeypatch.setattr(live._pw, "whisper_full_get_segment_t1", fake_segment_t1)
    monkeypatch.setattr(live._pw, "whisper_full_n_tokens", fake_n_tokens)
    monkeypatch.setattr(live._pw, "whisper_full_get_token_id", fake_token_id)
    monkeypatch.setattr(live._pw, "whisper_token_to_bytes", fake_token_bytes)
    monkeypatch.setattr(live._pw, "whisper_full_get_token_data", fake_token_data)
    monkeypatch.setattr(live._pw, "whisper_full_lang_id", fake_lang_id)
    monkeypatch.setattr(live._pw, "whisper_lang_str", fake_lang_str)
    monkeypatch.setattr(live._pw, "whisper_lang_auto_detect", fake_lang_auto_detect)
    monkeypatch.setattr(live._pw, "whisper_lang_max_id", lambda: 99)

    return calls


# --------------------------------------------------------------- SegOut/PhraseOut


def test_seg_out_and_phrase_out_defaults() -> None:
    seg = live.SegOut()
    assert seg == live.SegOut(t0=0, t1=0, text="", words=[], lang=None, mean_p=0.0)
    phrase = live.PhraseOut()
    assert phrase.segs == []
    assert phrase.detected is None


# --------------------------------------------------------------------- LangMode


def test_lang_mode_four_cases_shape() -> None:
    auto = live.Auto()
    sniff = live.Sniff()
    forced = live.Forced("he")
    watch = live.Watch("he")

    assert isinstance(auto, (live.Sniff, live.Forced, live.Watch)) is False
    assert forced.lang == "he"
    assert watch.lang == "he"

    for mode, expect_forced, expect_beam, expect_detect in [
        (auto, None, False, False),
        (sniff, None, True, True),
        (forced, "he", False, False),
        (watch, "he", True, True),
    ]:
        lang = mode.lang if isinstance(mode, (live.Forced, live.Watch)) else None
        assert lang == expect_forced, mode
        assert isinstance(mode, (live.Sniff, live.Watch)) == expect_beam, mode
        assert isinstance(mode, (live.Sniff, live.Watch)) == expect_detect, mode


# ----------------------------------------------- (a) <3200 samples early return


def test_transcribe_segments_under_3200_samples_returns_empty_without_touching_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = {"n": 0}
    orig_init = Model.__init__

    def counting_init(self, *a, **kw):
        calls["n"] += 1
        return orig_init(self, *a, **kw)

    monkeypatch.setattr(Model, "__init__", counting_init)

    tiny = np.zeros(3199, dtype=np.float32)
    for mode in (live.Auto(), live.Sniff(), live.Forced("he"), live.Watch("he")):
        out = live.transcribe_segments("/nonexistent/whisper-model.bin", tiny, 500, mode)
        assert out == live.PhraseOut(), mode

    assert calls["n"] == 0, "sub-3200-sample audio touched the model"
    assert engine._cache is None


# --------------------------------------------------- (b) stock hallucination vs confidence


def test_stock_hallucination_dropped_only_when_confidence_is_low(
    fake_model: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    def make_seg(p: float) -> _FakeSegment:
        return _FakeSegment(
            text=b" Thank you.",
            t0=0,
            t1=100,
            tokens=[
                _FakeToken(id=1, raw=b" Thank", p=p, plog=-0.1, t0=0, t1=50),
                _FakeToken(id=2, raw=b" you.", p=p, plog=-0.1, t0=50, t1=100),
            ],
        )

    pcm = np.zeros(4000, dtype=np.float32)

    # High confidence (mean_p >= STOCK_MAX_CONFIDENCE) -- a real "thank you"
    # stays, even though it matches the stock-phrase list.
    _install_fake_pw(monkeypatch, [make_seg(0.9)])
    kept = live.transcribe_segments("/fake/model.bin", pcm, 0, live.Auto())
    assert len(kept.segs) == 1
    assert kept.segs[0].text == "Thank you."
    assert kept.segs[0].mean_p == pytest.approx(0.9)

    # Low confidence -- the same text is the classic hallucination and drops.
    _install_fake_pw(monkeypatch, [make_seg(0.1)])
    dropped = live.transcribe_segments("/fake/model.bin", pcm, 0, live.Auto())
    assert dropped.segs == []


# ----------------------------------------------------- (c) reference silence rule


def test_silence_rule_requires_both_no_speech_and_low_avg_logprob(
    fake_model: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Neither signal alone may drop a segment -- only BOTH together, exactly
    as `stt.rs`'s doc comment on this rule insists. `_segment_no_speech_prob`
    always returns `None` in production (see `live.py`'s DEVIATION note), so
    this test monkeypatches it directly to exercise the conjunction for real
    -- the only way this branch is reachable at all.
    """
    low_conf_seg = _FakeSegment(
        text=b" garbled noise",
        t0=0,
        t1=100,
        tokens=[
            _FakeToken(id=1, raw=b" garbled", p=0.05, plog=-3.0, t0=0, t1=50),
            _FakeToken(id=2, raw=b" noise", p=0.05, plog=-3.0, t0=50, t1=100),
        ],
    )
    pcm = np.zeros(4000, dtype=np.float32)

    # Both true -> dropped.
    _install_fake_pw(monkeypatch, [low_conf_seg])
    monkeypatch.setattr(live, "_segment_no_speech_prob", lambda ctx, i: 0.9)  # noqa: ARG005
    out = live.transcribe_segments("/fake/model.bin", pcm, 0, live.Auto())
    assert out.segs == [], "high no-speech-prob + low avg-logprob must drop the segment"

    # High no-speech-prob but avg_logprob NOT below the floor -> kept.
    confident_seg = _FakeSegment(
        text=b" garbled noise",
        t0=0,
        t1=100,
        tokens=[
            _FakeToken(id=1, raw=b" garbled", p=0.9, plog=-0.1, t0=0, t1=50),
            _FakeToken(id=2, raw=b" noise", p=0.9, plog=-0.1, t0=50, t1=100),
        ],
    )
    _install_fake_pw(monkeypatch, [confident_seg])
    monkeypatch.setattr(live, "_segment_no_speech_prob", lambda ctx, i: 0.9)  # noqa: ARG005
    out2 = live.transcribe_segments("/fake/model.bin", pcm, 0, live.Auto())
    assert len(out2.segs) == 1, "high confidence must survive even a high no-speech-prob"

    # Low avg_logprob but no-speech-prob NOT above the threshold -> kept (low
    # confidence ALONE must never delete real words).
    _install_fake_pw(monkeypatch, [low_conf_seg])
    monkeypatch.setattr(live, "_segment_no_speech_prob", lambda ctx, i: 0.1)  # noqa: ARG005
    out3 = live.transcribe_segments("/fake/model.bin", pcm, 0, live.Auto())
    assert len(out3.segs) == 1, "low confidence alone must not drop a segment"


def test_segment_no_speech_prob_is_permanently_none() -> None:
    """Documents the DEVIATION directly: this can never report "probably no
    speech" in this build, so the AND-rule can never fire on its own in
    production -- only the test above (via monkeypatch) exercises it.
    """
    assert live._segment_no_speech_prob(object(), 0) is None


# ---------------------------------------------- (d) LangMode -> decode wiring


def test_lang_mode_branches_language_strategy_and_detection(
    fake_model: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    seg = _FakeSegment(
        text=b" hi",
        t0=0,
        t1=50,
        tokens=[_FakeToken(id=1, raw=b" hi", p=0.9, plog=-0.05, t0=0, t1=50)],
    )
    pcm = np.zeros(4000, dtype=np.float32)
    GREEDY = live._pw.whisper_sampling_strategy.WHISPER_SAMPLING_GREEDY
    BEAM = live._pw.whisper_sampling_strategy.WHISPER_SAMPLING_BEAM_SEARCH

    # AUTO: no forced language, greedy, no detection.
    calls = _install_fake_pw(monkeypatch, [seg], decoded_lang_id=0, lang_map={0: "en"})
    out = live.transcribe_segments("/fake/auto.bin", pcm, 0, live.Auto())
    assert calls["strategy"] == GREEDY
    assert calls["language"] == ""  # "auto" round-trips to "" -- whisper.cpp's own convention
    assert calls["token_timestamps"] is True
    assert calls["suppress_blank"] is True
    assert calls["suppress_nst"] is True
    assert calls["no_context"] is True
    assert out.segs[0].lang == "en"
    assert out.detected is None

    # SNIFF: no forced language, BEAM, detection requested.
    calls = _install_fake_pw(
        monkeypatch, [seg], decoded_lang_id=0, lang_map={0: "en"}, detect_id=0, detect_prob=0.87
    )
    out = live.transcribe_segments("/fake/sniff.bin", pcm, 0, live.Sniff())
    assert calls["strategy"] == BEAM
    assert calls["language"] == ""
    assert out.segs[0].lang == "en"
    assert out.detected == ("en", pytest.approx(0.87))

    # FORCED("he"): forced language, greedy, no detection -- and the decoded
    # language read back on the segment is the FORCED one, not guessed.
    calls = _install_fake_pw(monkeypatch, [seg], decoded_lang_id=1, lang_map={1: "he"})
    out = live.transcribe_segments("/fake/forced.bin", pcm, 0, live.Forced("he"))
    assert calls["strategy"] == GREEDY
    assert calls["language"] == "he"
    assert out.segs[0].lang == "he"
    assert out.detected is None

    # WATCH("he"): forced language, BEAM, AND a detection report -- the two
    # can genuinely disagree (that is the entire point of Watch: catching a
    # real language change), so the fake deliberately makes them disagree.
    calls = _install_fake_pw(
        monkeypatch,
        [seg],
        decoded_lang_id=1,
        lang_map={1: "he", 2: "en"},
        detect_id=2,
        detect_prob=0.5,
    )
    out = live.transcribe_segments("/fake/watch.bin", pcm, 0, live.Watch("he"))
    assert calls["strategy"] == BEAM
    assert calls["language"] == "he"
    assert out.segs[0].lang == "he", "the segment persists what it actually decoded as"
    assert out.detected == ("en", pytest.approx(0.5)), "detection is independent of the decode"


def test_lang_detect_failure_is_best_effort_none(
    fake_model: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A detect failure (negative id) must report `None`, never raise."""
    seg = _FakeSegment(
        text=b" hi",
        t0=0,
        t1=50,
        tokens=[_FakeToken(id=1, raw=b" hi", p=0.9, plog=-0.05, t0=0, t1=50)],
    )
    pcm = np.zeros(4000, dtype=np.float32)
    _install_fake_pw(monkeypatch, [seg], decoded_lang_id=0, lang_map={0: "en"}, detect_id=None)
    out = live.transcribe_segments("/fake/sniff-fail.bin", pcm, 0, live.Sniff())
    assert out.detected is None


def test_lang_detect_exception_is_swallowed(
    fake_model: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Even a raised exception from the detection binding must not escape
    `transcribe_segments` -- best-effort by contract.
    """
    seg = _FakeSegment(
        text=b" hi",
        t0=0,
        t1=50,
        tokens=[_FakeToken(id=1, raw=b" hi", p=0.9, plog=-0.05, t0=0, t1=50)],
    )
    pcm = np.zeros(4000, dtype=np.float32)
    _install_fake_pw(monkeypatch, [seg], decoded_lang_id=0, lang_map={0: "en"})

    def boom(ctx, offset_ms, n_threads, probs):
        raise RuntimeError("boom")

    monkeypatch.setattr(live._pw, "whisper_lang_auto_detect", boom)
    out = live.transcribe_segments("/fake/sniff-boom.bin", pcm, 0, live.Sniff())
    assert out.detected is None


# ------------------------------------------------------------- junk segments


def test_junk_segment_is_dropped(fake_model: None, monkeypatch: pytest.MonkeyPatch) -> None:
    seg = _FakeSegment(
        text=b" [BLANK_AUDIO]",
        t0=0,
        t1=50,
        tokens=[_FakeToken(id=1, raw=b" [BLANK_AUDIO]", p=0.9, plog=-0.05, t0=0, t1=50)],
    )
    pcm = np.zeros(4000, dtype=np.float32)
    _install_fake_pw(monkeypatch, [seg])
    out = live.transcribe_segments("/fake/junk.bin", pcm, 0, live.Auto())
    assert out.segs == []


# ---------------------------------------------------- offset + word timing wiring


def test_words_get_offset_and_words_survive_merge(
    fake_model: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    seg = _FakeSegment(
        text=b" Hello world",
        t0=10,
        t1=90,
        tokens=[
            _FakeToken(id=1, raw=b" Hello", p=0.9, plog=-0.05, t0=10, t1=40),
            _FakeToken(id=2, raw=b" world", p=0.9, plog=-0.05, t0=40, t1=90),
        ],
    )
    pcm = np.zeros(4000, dtype=np.float32)
    _install_fake_pw(monkeypatch, [seg])
    out = live.transcribe_segments("/fake/offset.bin", pcm, 500, live.Auto())
    assert len(out.segs) == 1
    got = out.segs[0]
    assert got.t0 == 510 and got.t1 == 590
    assert got.words == [("Hello", 510, 540), ("world", 540, 590)]


def test_words_exclude_special_tokens_from_mean_p_and_merge(
    fake_model: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    seg = _FakeSegment(
        text=b" Hello world",
        t0=0,
        t1=100,
        tokens=[
            _FakeToken(id=1, raw=b"[_BEG_]", p=0.99, plog=-0.01, t0=0, t1=0),
            _FakeToken(id=2, raw=b" Hello", p=0.9, plog=-0.1, t0=5, t1=15),
            _FakeToken(id=3, raw=b" world", p=0.8, plog=-0.2, t0=15, t1=25),
            _FakeToken(id=4, raw=b"<|endoftext|>", p=0.99, plog=-0.01, t0=25, t1=25),
        ],
    )
    pcm = np.zeros(4000, dtype=np.float32)
    _install_fake_pw(monkeypatch, [seg])
    out = live.transcribe_segments("/fake/specials.bin", pcm, 300, live.Auto())
    assert len(out.segs) == 1
    got = out.segs[0]
    assert got.words == [("Hello", 305, 315), ("world", 315, 325)]
    # mean_p is the arithmetic mean over the two NON-special tokens only.
    assert got.mean_p == pytest.approx((0.9 + 0.8) / 2)


# --------------------------------------------------------------------- (1) real say roundtrip


@requires_model
def test_e2e_segments_with_words(say_pcm: np.ndarray) -> None:
    """Direct port of `stt.rs`'s `e2e_segments_with_words` (lines 837-862)."""
    out = live.transcribe_segments(MODEL_PATH, say_pcm, 500, live.Auto())
    assert out.segs, "no segments"
    all_text = "".join(s.text for s in out.segs).lower()
    assert "quick brown fox" in all_text, all_text

    words = [w for s in out.segs for w in s.words]
    assert len(words) >= 6, f"expected word-level timing, got {words!r}"
    # Timestamps carry the offset and are monotonic.
    assert words[0][1] >= 500
    assert all(a[1] <= b[1] for a, b in zip(words, words[1:]))


@requires_model
def test_e2e_low_confidence_real_speech_is_kept_not_dropped(tmp_path: Path) -> None:
    """Adversarial: real (never faked) speech, synthesized through a
    distorting voice+rate combination that reliably drives Whisper's own
    confidence for this exact sentence down to ~0.40 on this model
    (`say -v Bahh -r 350`, confirmed by hand across repeated runs to render
    deterministically to "I should sort of lazy talk." at `mean_p ~= 0.3955`
    every time) -- genuinely below even the OLD unconditional mean-p floors
    this module's docstring says were removed on purpose (Rust: 0.30
    short-segment floor), and below `STOCK_MAX_CONFIDENCE` (0.5) too.

    This proves, on real audio rather than a monkeypatched fake, that low
    confidence ALONE never deletes real words: nothing in this sentence is a
    stock-hallucination phrase, so only a bare (re-introduced) confidence
    floor could drop it -- exactly the regression
    `test_silence_rule_requires_both_no_speech_and_low_avg_logprob` proves
    the code *structurally* cannot do (both signals required, and one is
    permanently unreadable) but never exercises against real, hard-to-decode
    speech. If a future change ever added `if mean_p < X: continue` back in
    as a shortcut, this is the test that would actually notice.
    """
    aiff = tmp_path / "pr-stt-e2e-lowconf.aiff"
    proc = subprocess.run(
        [
            "/usr/bin/say",
            "-v",
            "Bahh",
            "-r",
            "350",
            "-o",
            str(aiff),
            "The quick brown fox jumps over the lazy dog",
        ],
        capture_output=True,
    )
    if proc.returncode != 0:
        pytest.skip("`say -v Bahh` (distorted voice) unavailable")
    pcm = decode_to_pcm(aiff, MediaKind.AUDIO)
    out = live.transcribe_segments(MODEL_PATH, pcm, 0, live.Auto())
    assert out.segs, "no segments -- distorted-but-real speech was dropped entirely"
    seg = out.segs[0]
    assert seg.mean_p < 0.5, (
        f"fixture drifted off its low-confidence target, got mean_p={seg.mean_p} "
        f"for {seg.text!r} -- pick a new voice/rate that still lands under 0.5"
    )
    assert seg.words, f"words were stripped from a low-confidence real segment: {seg!r}"
    # Real (if garbled) speech about a fox/dog, never a stock-hallucination
    # phrase -- so `is_stock_hallucination` never even factors into keeping
    # this segment; only a bare confidence floor could drop it.
    assert not any(phrase in seg.text.lower() for phrase in ("thank you", "please subscribe"))


@requires_model
def test_e2e_hebrew_words_no_mojibake(tmp_path: Path) -> None:
    """Direct port of `stt.rs`'s `e2e_hebrew_words_no_mojibake` (lines
    864-901). Skips cleanly when the Carmit (Hebrew) voice isn't installed,
    matching the Rust test's own skip-if-unavailable behavior.
    """
    aiff = tmp_path / "pr-stt-e2e-heb.aiff"
    proc = subprocess.run(
        ["/usr/bin/say", "-v", "Carmit", "-o", str(aiff), "שלום עולם, מה שלומך היום?"],
        capture_output=True,
    )
    if proc.returncode != 0:
        pytest.skip("`say -v Carmit` (Hebrew voice) unavailable")

    pcm = decode_to_pcm(aiff, MediaKind.AUDIO)
    out = live.transcribe_segments(MODEL_PATH, pcm, 0, live.Auto())
    assert out.segs, "no segments"
    words = [w for s in out.segs for w in s.words]
    assert words, f"no words: {out.segs!r}"
    for word_text, _t0, _t1 in words:
        assert "�" not in word_text, f"corrupted word {word_text!r} in {words!r}"
    assert any(
        any("א" <= c <= "ת" for c in word_text) for word_text, _t0, _t1 in words
    ), f"no Hebrew letters in {words!r}"


# ------------------------------------------- shared-cache isolation (real model)


@requires_model
def test_forced_language_readback_is_read_not_assumed(say_pcm: np.ndarray) -> None:
    """`SegOut.lang` for a FORCED decode must come from the real post-decode
    `whisper_full_lang_id` state, not merely echo back the string that was
    passed in -- forcing Hebrew on ENGLISH audio must still read back "he",
    proving this is a real readback and not an assumption baked into the
    code.
    """
    out = live.transcribe_segments(MODEL_PATH, say_pcm, 0, live.Forced("he"))
    assert out.segs, "no segments"
    assert all(s.lang == "he" for s in out.segs)


@requires_model
def test_sharing_engine_cache_leaves_engine_transcribe_params_untouched() -> None:
    """Validates `live.py`'s module docstring DECISION note:
    `transcribe_segments` builds its own fresh low-level params struct and
    must never mutate `entry.model._params` -- the SAME object
    `engine.transcribe()` reads from on this shared cache entry. A Watch
    decode (beam search, token timestamps, suppress_nst, no_context, forced
    language) is the most invasive mode; if any of it leaked, this would
    catch it. Real model, real shared cache -- the actual thing the ground
    rules asked to be verified.
    """
    model = engine.warm_context(MODEL_PATH)
    before = (
        model._params.language,
        model._params.strategy,
        model._params.token_timestamps,
        model._params.suppress_nst,
        model._params.no_context,
    )
    pcm = np.zeros(4000, dtype=np.float32)
    live.transcribe_segments(MODEL_PATH, pcm, 0, live.Watch("he"))
    after = (
        model._params.language,
        model._params.strategy,
        model._params.token_timestamps,
        model._params.suppress_nst,
        model._params.no_context,
    )
    assert before == after, "transcribe_segments leaked state into the shared Model's params"
    assert engine._cache is not None and engine._cache.path == MODEL_PATH, (
        "transcribe_segments did not reuse engine.py's warm-context cache"
    )


@requires_model
def test_shares_same_warm_model_as_engine_transcribe(say_pcm: np.ndarray) -> None:
    """The whole point of reusing `engine.py`'s cache: a live phrase and a
    whole-file transcription against the SAME model path hit the identical
    warm `Model` instance -- no second load, no doubled resident memory.
    """
    live.transcribe_segments(MODEL_PATH, say_pcm, 0, live.Auto())
    entry_after_live = engine._cache
    assert entry_after_live is not None

    text = engine.transcribe(MODEL_PATH, say_pcm, False)
    assert "quick brown fox" in text.lower(), text
    assert engine._cache is entry_after_live, "engine.transcribe() reloaded a separate model"
