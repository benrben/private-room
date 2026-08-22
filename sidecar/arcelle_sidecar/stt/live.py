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
whole-file. Nothing in this sidecar currently calls into either path
concurrently on the same model.

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

    forced = mode.lang if isinstance(mode, (Forced, Watch)) else None
    use_beam = isinstance(mode, (Sniff, Watch))
    want_detect = isinstance(mode, (Sniff, Watch))

    # The lock ends inside `_checkout` — see `engine.py`'s own `_lock` doc
    # comment: a live phrase must not park behind a whole-file import's cache
    # lookup, nor vice versa. Same cache slot `engine.transcribe()` itself
    # uses (see the module docstring's DECISION note) — never a second,
    # separate warm model.
    entry = _checkout(model_path)
    try:
        ctx = entry.model._ctx  # noqa: SLF001 - see module docstring

        # Finals (Sniff/Watch) decode with beam search — the reference
        # quality setting (openai/faster-whisper default beam 5), barely
        # slower on Metal. Partials (Auto/Forced) stay greedy: they are
        # repainted every ~1.5s, so latency wins; best_of=5 still lets
        # whisper.cpp's temperature fallback sample candidates when a hard
        # phrase makes the greedy pick fail.
        strategy = _BEAM_SEARCH if use_beam else _GREEDY
        # A FRESH params struct, never `entry.model._params` — see the
        # module docstring's DECISION note for why that isolation matters.
        params = _pw.whisper_full_default_params(strategy)
        params.language = forced if forced is not None else "auto"
        params.n_threads = threads
        params.print_special = False
        params.print_progress = False
        params.print_realtime = False
        params.print_timestamps = False
        params.token_timestamps = True
        params.suppress_blank = True
        # Never emit music/sound-effect token spans (♪, bracketed noise) as
        # words.
        params.suppress_nst = True
        # Each phrase stands alone; carrying context across them makes the
        # model repeat the previous phrase over silence.
        params.no_context = True
        if use_beam:
            params.beam_search = {"beam_size": 5, "patience": -1.0}
        else:
            params.greedy = {"best_of": 5}

        if _pw.whisper_full(ctx, params, pcm32, pcm32.size) != 0:
            raise RuntimeError("transcription failed")

        # full_lang_id is the language the decode ran in — the forced one
        # when one was forced — which is exactly what each segment must
        # persist. Read from the real post-decode state, never assumed: a
        # decode forced to a language that does not match the audio still
        # reads back as the FORCED language here (verified against the real
        # model — see `test_forced_language_readback_is_read_not_assumed`),
        # independent of what `_detect_language` (below) says the audio
        # actually sounds like.
        lang_id = _pw.whisper_full_lang_id(ctx)
        lang = _pw.whisper_lang_str(lang_id)

        n_segments = _pw.whisper_full_n_segments(ctx)
        out: list[SegOut] = []
        for i in range(n_segments):
            raw_text = _pw.whisper_full_get_segment_text(ctx, i)
            text = raw_text.decode("utf-8", errors="replace").strip()
            if is_junk_segment(text):
                continue

            # RAW bytes per token, never per-token strings: BPE splits
            # multi-byte characters across tokens, and lossy-decoding each
            # half yields "�" (see hallucination.py's `merge_token_words`
            # doc and engine.py's DIVERGENCE 1 note for the same fact hit
            # twice already in this codebase). This also needs `plog` per
            # token (engine.py's `_segment_mean_p` never computes that — see
            # this module's own docstring for why that helper is not reused
            # here).
            pieces: list[tuple[bytes, int, int]] = []
            p_sum = 0.0
            plog_sum = 0.0
            n_scored = 0
            n_tokens = _pw.whisper_full_n_tokens(ctx, i)
            for j in range(n_tokens):
                token_id = _pw.whisper_full_get_token_id(ctx, i, j)
                raw = _pw.whisper_token_to_bytes(ctx, token_id)
                # Specials like "[_BEG_]" / "<|endoftext|>" carry no words.
                if raw.startswith(b"[_") or raw.startswith(b"<|"):
                    continue
                data = _pw.whisper_full_get_token_data(ctx, i, j)
                p_sum += data.p
                plog_sum += data.plog
                n_scored += 1
                t0 = offset_cs + max(data.t0, 0)
                t1 = offset_cs + max(data.t1, max(data.t0, 0))
                pieces.append((raw, t0, t1))

            words = merge_token_words(pieces)
            mean_p = p_sum / n_scored if n_scored > 0 else 0.0

            # A stock hallucination the model itself wasn't sure about is
            # noise dressed as text. A REAL "thank you" decodes confidently
            # and stays — this pair of conditions is what the old
            # unconditional confidence floor got wrong in both directions.
            if is_stock_hallucination(text) and mean_p < STOCK_MAX_CONFIDENCE:
                continue

            # The REFERENCE silence rule (openai / faster-whisper /
            # whisper.cpp all agree): text is dropped only when the model
            # says "probably no speech here" AND the decode is
            # low-confidence — both together. Low confidence alone is NOT a
            # reason to delete: hard audio — accented, far-mic, compressed —
            # decodes correct words at low probability, and deleting them
            # punches holes in real speech. The old mean-p floors (0.30
            # short / 0.18 long) did exactly that on real-world meetings and
            # are gone on purpose. See the module docstring's DEVIATION note:
            # `_segment_no_speech_prob` can only ever return `None` in this
            # build, so this branch never actually fires in production — the
            # conservative side of that gap.
            if n_scored > 0:
                avg_logprob = plog_sum / n_scored
                no_speech = _segment_no_speech_prob(ctx, i)
                if no_speech is not None and no_speech > 0.6 and avg_logprob < -1.0:
                    continue

            seg_t0 = offset_cs + max(_pw.whisper_full_get_segment_t0(ctx, i), 0)
            seg_t1 = offset_cs + max(_pw.whisper_full_get_segment_t1(ctx, i), 0)
            out.append(
                SegOut(t0=seg_t0, t1=seg_t1, text=text, words=words, lang=lang, mean_p=mean_p)
            )

        # The ctx still holds this phrase's mel from `whisper_full()` above
        # (whisper.cpp computes+stores mel as the first step of
        # `whisper_full`, regardless of forced/auto language), so detection
        # only costs one extra encoder pass, not a fresh mel/decode.
        # Best-effort: a detect failure just reports nothing, which the
        # sticky policy treats as no vote — never an exception escaping this
        # function.
        detected = _detect_language(ctx, threads) if want_detect else None

        return PhraseOut(segs=out, detected=detected)
    finally:
        _checkin(entry)
