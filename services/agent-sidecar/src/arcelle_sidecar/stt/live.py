"""On-device speech-to-text: the live-recording word-timestamp path.

Port of `src-tauri/src/stt.rs` — `SegOut`/`LangMode`/`PhraseOut` (lines
311-362) and `transcribe_segments` (lines 496-628). `is_junk_segment`,
`is_stock_hallucination`, `STOCK_MAX_CONFIDENCE` and `merge_token_words`
(lines 364-490) are NOT re-defined here — they already live in the sibling
`arcelle_sidecar/stt/hallucination.py` (final, imported below) and are byte-
for-byte the same rules this module needs. `segment_mean_p` is likewise not
reused from `arcelle_sidecar/stt/engine.py`: this module needs both a
token's `p` AND its `plog` in the same walk (Rust's `mean_p` field and the
silence rule's `avg_logprob` come from the identical per-token loop), so the
arithmetic-mean-over-non-special-tokens shape is duplicated inline rather
than calling `engine._segment_mean_p` (which only computes `p`) and then
re-walking every token a second time just for `plog`.

This file is the merge of two independently-written candidates
(`live_candidate_a.py` / `live_candidate_b.py`, both deleted after this
merge — see the final report for the full comparison). Both candidates
independently confirmed, on this real installed `pywhispercpp`/`_pywhispercpp`
1.5.0, the exact same low-level binding names (`whisper_full_get_token_id`,
`whisper_token_to_bytes`, `whisper_full_get_token_data` for `p`+`plog`+`t0`+
`t1` together, `whisper_full_lang_id`, `whisper_lang_str`,
`whisper_lang_auto_detect`, `whisper_lang_max_id`) and the exact same
conclusion that `whisper_full_get_segment_no_speech_prob` is NOT wrapped by
this build (see "DEVIATION" below) — re-confirmed independently a third time
while merging, by introspecting `dir(_pywhispercpp)` directly.

Where the candidates diverged is the one design decision worth a permanent
comment:

------------------------------------------------------- DECISION: a FRESH
`whisper_full_params` per call, built via `_pw.whisper_full_default_params`
and fed straight to `_pw.whisper_full(ctx, params, samples, n)` — never
`entry.model.transcribe(**kwargs)`.

One candidate drove the decode through the high-level
`entry.model.transcribe(strategy=..., beam_search=..., token_timestamps=True,
...)`, which is how `arcelle_sidecar/stt/engine.py`'s own "DIVERGENCE 2" note
already says `pywhispercpp.Model` works: every kwarg is `setattr()` onto ONE
persistent `self._params` object (`Model._set_params`), and — per
`Model.transcribe`'s own docstring — "remains active for future calls". That
candidate's own module docstring correctly flagged the consequence for
`strategy` (a Sniff/Watch call would leave the SHARED cached model parked in
`BEAM_SEARCH` for whatever `engine.transcribe()` runs next) and added a
`finally` that resets `entry.model._params.strategy` back to `GREEDY` — but
left `token_timestamps`/`suppress_blank`/`suppress_nst`/`no_context` set from
that same call, reasoning that none of the four "change `engine.
transcribe()`'s output text". That reasoning does not hold for `no_context`:
`engine.transcribe()` never sets it itself, so once any live phrase runs on a
model, a whole-file import sharing that same warm model would silently decode
every segment with cross-segment context DISABLED (each segment decoded
standalone) instead of whisper.cpp's normal carried-context behavior for a
long file — a real transcript-quality regression on real multi-segment
imports, not a benign no-op.

The other candidate sidestepped the whole class of leak by never touching
`entry.model._params` at all: it builds its own `_pw.
whisper_full_default_params(strategy)` — confirmed empirically (see below) to
be a genuinely fresh, independent struct, not a handle onto anything cached —
sets every field this function needs directly on THAT struct, and calls
`_pw.whisper_full(ctx, params, samples, n)` itself. This is exactly what
`pywhispercpp.model.Model._transcribe()` does internally
(`pw.whisper_full(self._ctx, self._params, audio, audio.size)` — read from
the installed `pywhispercpp/model.py` source), just against a params object
this function owns instead of the cache's shared one. Verified on this
machine, twice:

    p1 = _pw.whisper_full_default_params(GREEDY)
    p2 = _pw.whisper_full_default_params(GREEDY)
    p1 is p2                    # False -- independent objects
    p1.language = "he"; p2.language  # "en" (p2's own default) -- no aliasing

and, with the real model, that a Watch decode (the most invasive mode: beam
search, token timestamps, `suppress_nst`, `no_context`, forced language) run
through this path leaves `engine.warm_context(...)`'s returned `Model.
_params` byte-for-byte unchanged before and after (see
`test_sharing_leaves_engine_transcribe_params_untouched` below). This module
takes THAT approach. The only state shared with a concurrent/subsequent
`engine.transcribe()` call is the loaded weights (`ctx`) — the whole point of
`engine.py`'s warm cache — never decode parameters, which matches Rust's own
`FullParams::new(strategy)` "fresh struct every decode" guarantee exactly
(Rust hands each decode its own `WhisperState`; pywhispercpp has no such
per-decode state, so a fresh *params* struct plus the shared, read-only `ctx`
is the closest equivalent available here).

The inherited constraint (both candidates' docstrings already noted this,
correctly, from `engine.py`'s "DIVERGENCE 2"): `whisper_full()` is, per
whisper.cpp's own header comment, "Not thread safe for same context" — two
decodes must never run against the same `ctx` concurrently, live phrase or
whole-file. Both paths therefore hold the cache entry's per-context
`decode_lock` through the actual decode and every result read. Cache lookup
itself remains independent and short-lived.

--------------------------------------------------------- DEVIATION: no
`no_speech_probability` binding

Rust's silence rule drops a segment only when BOTH
`seg.no_speech_probability() > 0.6` AND `avg_logprob < -1.0` hold — never on
low confidence alone (the doc comment on that check below is carried over
verbatim from `stt.rs`). whisper.cpp's C header declares
`whisper_full_get_segment_no_speech_prob`/`_from_state`, so the C symbol
exists in the compiled library pywhispercpp built against — but
`_pywhispercpp` never wraps it: confirmed absent from `dir(_pw)` against the
real installed package (re-checked directly while merging, not just taken on
either candidate's word). There is no pointer-level escape hatch either:
`_pw.whisper_context` is an opaque pybind11 object exposing nothing but its
own cross-module interop hook, so there is no raw C pointer to hand to
`ctypes` even as a last resort — and guessing at one would risk a segfault on
a real user's machine for a probability score, which is not an acceptable
trade for a filter that is explicitly documented, in the Rust source itself,
as advisory (never solely load-bearing).

`_segment_no_speech_prob()` below is the seam this reads through — kept as a
real, separately-testable function (not an inlined `None`) so the AND-rule in
`transcribe_segments` stays a genuine, monkeypatch-provable conjunction rather
than dead code. It returns `None` — "unknown", not a fabricated probability —
because `0.0` would silently assert "definitely not silence", a specific,
false claim this port never actually measured. The caller only fires the
silence rule when `no_speech is not None`, so with one half of the AND
permanently unreadable, the rule can never actually drop a segment in this
build. This is the conservative side to be stuck on: the Rust doc comment on
this exact check already establishes that low confidence ALONE must never
delete real words ("the old mean-p floors ... did exactly that on real-world
meetings and are gone on purpose") — a missing no-speech signal defaulting to
"no vote" can, at worst, let a genuine silence artifact survive; it can never
punch a hole in real speech, which is the failure mode the reference rule
exists to prevent in the first place. `avg_logprob` is still computed
faithfully regardless, so a future pywhispercpp release that adds the getter
needs only one change: flip `_segment_no_speech_prob` to a real read.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Union

import numpy as np

# Same low-level extension module `engine.py` reaches into — see its own
# module docstring ("DIVERGENCE 1") for why raw bytes, never
# `whisper_full_get_token_text`, is the only safe per-token accessor.
import _pywhispercpp as _pw

from arcelle_sidecar.stt.engine import _checkin, _checkout, _n_threads
from arcelle_sidecar.stt.hallucination import (
    STOCK_MAX_CONFIDENCE,
    is_junk_segment,
    is_stock_hallucination,
    merge_token_words,
)

_GREEDY = _pw.whisper_sampling_strategy.WHISPER_SAMPLING_GREEDY
_BEAM_SEARCH = _pw.whisper_sampling_strategy.WHISPER_SAMPLING_BEAM_SEARCH


@dataclass
class SegOut:
    """One decoded phrase segment: absolute centisecond span, text, and
    word-level timing for the transcript editor. Port of Rust's `SegOut`
    (`stt.rs` lines 315-329, `#[derive(Default, Clone, Debug)]`).
    """

    t0: int = 0
    t1: int = 0
    text: str = ""
    #: (word, t0, t1) — absolute centiseconds like t0/t1 above.
    words: list[tuple[str, int, int]] = field(default_factory=list)
    #: What the phrase was actually decoded as (the forced language when one
    #: was forced) — this is what persists on the segment.
    lang: str | None = None
    #: Mean token probability — how sure the model was of THIS text. Callers
    #: use it to tell degraded-echo garbage from real speech; it never
    #: deletes anything here on its own.
    mean_p: float = 0.0


# ------------------------------------------------------------------ LangMode
#
# Port of Rust's `LangMode<'a>` enum (`stt.rs` lines 335-352) as a small
# tagged-union class hierarchy — one immutable case class per variant, so
# `isinstance()` reads the same as Rust's `match`. `Forced`/`Watch` carry the
# language string the Rust variants carry as `&'a str`.


@dataclass(frozen=True, slots=True)
class Auto:
    """Let whisper detect the phrase's language and report nothing —
    pre-lock live partials, which are throwaway. The detector must NOT run
    here: a partial fires every ~1.5 s on the one decode worker, and a lane
    can stay unlocked for a long time (music, low-confidence audio).
    """


@dataclass(frozen=True, slots=True)
class Sniff:
    """Auto decode PLUS a confidence-bearing detection report
    (`whisper_lang_auto_detect` on the mel the decode left behind, one extra
    encoder pass) — pre-lock finals, whose report earns the lock.
    """


@dataclass(frozen=True, slots=True)
class Forced:
    """Force the decode to this language and skip detection — locked-lane
    partials.
    """

    lang: str


@dataclass(frozen=True, slots=True)
class Watch:
    """Force the decode to this language but ALSO report what the audio
    sounds like, so the caller can spot a genuine language change.
    """

    lang: str


LangMode = Union[Auto, Sniff, Forced, Watch]


@dataclass
class PhraseOut:
    """A whole decoded phrase plus what the language detector heard. Port of
    Rust's `PhraseOut` (`stt.rs` lines 355-362).
    """

    segs: list[SegOut] = field(default_factory=list)
    #: Top detected language and its probability — the detector's own answer
    #: (`lang_detect` over the phrase's mel), independent of the language the
    #: decode ran in. Forced/Auto: absent.
    detected: tuple[str, float] | None = None


def _segment_no_speech_prob(ctx: object, seg_index: int) -> float | None:  # noqa: ARG001
    """Always `None` — see the module docstring's "DEVIATION: no
    `no_speech_probability` binding" note. Kept as a named seam (rather than
    inlining `None` at the one call site) so a future pywhispercpp release
    that adds `whisper_full_get_segment_no_speech_prob` has exactly one place
    to wire up, and so tests can monkeypatch it to prove the AND-rule it
    feeds is wired correctly.
    """
    return None


def _detect_language(ctx: object, threads: int) -> tuple[str, float] | None:
    """Run `whisper_lang_auto_detect` AGAINST THE SAME CTX a decode just ran
    on — reusing the mel spectrogram `whisper_full` already computed (the
    whole point: one extra encoder pass, not a fresh decode), matching Rust's
    `state.lang_detect(0, threads)`. `offset_ms=0` — verbatim from the Rust
    call site.

    Best-effort: ANY failure (a negative/out-of-range id, an unrecognized
    language string, or a raised exception from the binding itself) reports
    `None`, "no vote", never an exception escaping this function — mirrors
    Rust's `.lang_detect(...).ok().and_then(...)`, which discards the error
    variant the same unconditional way.
    """
    try:
        lang_max = _pw.whisper_lang_max_id()
        probs = np.zeros(lang_max + 1, dtype=np.float32)
        top_id = _pw.whisper_lang_auto_detect(ctx, 0, threads, probs)
        if top_id < 0:
            return None
        lang_str = _pw.whisper_lang_str(top_id)
        if lang_str is None:
            return None
        prob = float(probs[top_id]) if 0 <= top_id < len(probs) else 0.0
        return (lang_str, prob)
    except Exception:  # noqa: BLE001 - best-effort by contract, see docstring
        return None


@dataclass(frozen=True)
class _DecodeSettings:
    forced_language: str | None
    use_beam: bool
    want_detection: bool


@dataclass
class _TokenStats:
    pieces: list[tuple[bytes, int, int]] = field(default_factory=list)
    probability_total: float = 0.0
    logprob_total: float = 0.0
    scored_count: int = 0


def _decode_settings(mode: LangMode) -> _DecodeSettings:
    return _DecodeSettings(
        forced_language=mode.lang if isinstance(mode, (Forced, Watch)) else None,
        use_beam=isinstance(mode, (Sniff, Watch)),
        want_detection=isinstance(mode, (Sniff, Watch)),
    )


def _decode_params(settings: _DecodeSettings, threads: int) -> object:
    strategy = _BEAM_SEARCH if settings.use_beam else _GREEDY
    params = _pw.whisper_full_default_params(strategy)
    params.language = settings.forced_language if settings.forced_language is not None else "auto"
    params.n_threads = threads
    params.print_special = False
    params.print_progress = False
    params.print_realtime = False
    params.print_timestamps = False
    params.token_timestamps = True
    params.suppress_blank = True
    params.suppress_nst = True
    params.no_context = True
    if settings.use_beam:
        params.beam_search = {"beam_size": 5, "patience": -1.0}
    else:
        params.greedy = {"best_of": 5}
    return params


def _run_decode(ctx: object, params: object, pcm: np.ndarray) -> None:
    if _pw.whisper_full(ctx, params, pcm, pcm.size) != 0:
        raise RuntimeError("transcription failed")


def _decoded_language(ctx: object) -> str | None:
    return _pw.whisper_lang_str(_pw.whisper_full_lang_id(ctx))


def _special_token(raw: bytes) -> bool:
    return raw.startswith(b"[_") or raw.startswith(b"<|")


def _token_stats(ctx: object, segment_index: int, offset_cs: int) -> _TokenStats:
    stats = _TokenStats()
    n_tokens = _pw.whisper_full_n_tokens(ctx, segment_index)
    for token_index in range(n_tokens):
        token_id = _pw.whisper_full_get_token_id(ctx, segment_index, token_index)
        raw = _pw.whisper_token_to_bytes(ctx, token_id)
        if _special_token(raw):
            continue
        data = _pw.whisper_full_get_token_data(ctx, segment_index, token_index)
        stats.probability_total += data.p
        stats.logprob_total += data.plog
        stats.scored_count += 1
        t0 = offset_cs + max(data.t0, 0)
        t1 = offset_cs + max(data.t1, max(data.t0, 0))
        stats.pieces.append((raw, t0, t1))
    return stats


def _mean_probability(stats: _TokenStats) -> float:
    if stats.scored_count == 0:
        return 0.0
    return stats.probability_total / stats.scored_count


def _should_drop_stock_hallucination(text: str, mean_probability: float) -> bool:
    return is_stock_hallucination(text) and mean_probability < STOCK_MAX_CONFIDENCE


def _should_drop_silence(ctx: object, segment_index: int, stats: _TokenStats) -> bool:
    if stats.scored_count == 0:
        return False
    avg_logprob = stats.logprob_total / stats.scored_count
    no_speech = _segment_no_speech_prob(ctx, segment_index)
    return no_speech is not None and no_speech > 0.6 and avg_logprob < -1.0


def _segment_output(
    ctx: object,
    segment_index: int,
    offset_cs: int,
    text: str,
    words: list[tuple[str, int, int]],
    language: str | None,
    mean_probability: float,
) -> SegOut:
    return SegOut(
        t0=offset_cs + max(_pw.whisper_full_get_segment_t0(ctx, segment_index), 0),
        t1=offset_cs + max(_pw.whisper_full_get_segment_t1(ctx, segment_index), 0),
        text=text,
        words=words,
        lang=language,
        mean_p=mean_probability,
    )


def _decoded_segments(ctx: object, offset_cs: int, language: str | None) -> list[SegOut]:
    out: list[SegOut] = []
    for segment_index in range(_pw.whisper_full_n_segments(ctx)):
        raw_text = _pw.whisper_full_get_segment_text(ctx, segment_index)
        text = raw_text.decode("utf-8", errors="replace").strip()
        if is_junk_segment(text):
            continue
        stats = _token_stats(ctx, segment_index, offset_cs)
        mean_probability = _mean_probability(stats)
        words = merge_token_words(stats.pieces)
        if _should_drop_stock_hallucination(text, mean_probability):
            continue
        if _should_drop_silence(ctx, segment_index, stats):
            continue
        out.append(
            _segment_output(
                ctx, segment_index, offset_cs, text, words, language, mean_probability
            )
        )
    return out


def _detected_language(ctx: object, threads: int, want_detection: bool) -> tuple[str, float] | None:
    return _detect_language(ctx, threads) if want_detection else None


def _phrase_from_entry(
    entry: object, pcm: np.ndarray, offset_cs: int, threads: int, settings: _DecodeSettings
) -> PhraseOut:
    decode_acquired = False
    try:
        entry.decode_lock.acquire()
        decode_acquired = True
        ctx = entry.model._ctx  # noqa: SLF001 - see module docstring
        _run_decode(ctx, _decode_params(settings, threads), pcm)
        language = _decoded_language(ctx)
        segments = _decoded_segments(ctx, offset_cs, language)
        detected = _detected_language(ctx, threads, settings.want_detection)
        return PhraseOut(segs=segments, detected=detected)
    finally:
        if decode_acquired:
            entry.decode_lock.release()


def transcribe_segments(
    model_path: str, pcm: np.ndarray, offset_cs: int, mode: LangMode
) -> PhraseOut:
    """Transcribe one live phrase (mono 16 kHz) with word timestamps,
    shifting everything by `offset_cs` so timestamps are absolute on the
    recording's timeline. Same warm context as `engine.transcribe()` (see the
    module docstring's DECISION note); equally blocking — the recording
    engine calls it from its dedicated decoder thread only. Port of Rust's
    `transcribe_segments` (`stt.rs` lines 496-628).
    """
    if len(pcm) < 3200:
        return PhraseOut()  # < 0.2s: nothing decodable

    pcm32 = np.asarray(pcm, dtype=np.float32)
    threads = _n_threads()
    settings = _decode_settings(mode)

    # The lock ends inside `_checkout` — see `engine.py`'s own `_lock` doc
    # comment: a live phrase must not park behind a whole-file import's cache
    # lookup, nor vice versa. Same cache slot `engine.transcribe()` itself
    # uses (see the module docstring's DECISION note) — never a second,
    # separate warm model.
    entry = _checkout(model_path)
    try:
        return _phrase_from_entry(entry, pcm32, offset_cs, threads, settings)
    finally:
        _checkin(entry)
