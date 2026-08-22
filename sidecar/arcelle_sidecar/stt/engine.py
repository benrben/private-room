"""On-device speech-to-text: the whole-file transcription path.

Port of `src-tauri/src/stt.rs` — module doc + `MODEL_FILE`/`MODEL_URL`/
`MODEL_SIZE_MB` (lines 1-30), and the warm-context cache, `unload_ctx`,
`unload_model`, `transcribe` (lines 173-309).

Deliberately NOT ported here: `transcribe_segments`, the live-recording
word-timestamp path (a later batch's job) — nor `decode_to_pcm`/
`decode_bytes_to_pcm`, which already live in `arcelle_sidecar/media/decode.py`;
nor `is_junk_segment`/`is_stock_hallucination`/`STOCK_MAX_CONFIDENCE`/
`merge_token_words`, which are pure text/byte helpers already ported to the
sibling `arcelle_sidecar/stt/hallucination.py` (imported below).

Uses the real `pywhispercpp` package (Metal-enabled build already installed,
`GGML_METAL_EMBED_LIBRARY=1`) via `from pywhispercpp.model import Model`.

This file is a merge of two independent ports of the same Rust module.
See the final report for what was taken from each and why; the two points
worth a permanent comment are below.

------------------------------------------------------ DIVERGENCE 1: geometric
vs arithmetic mean for segment confidence

Rust's `segment_mean_p` is an ARITHMETIC mean of per-token probabilities,
skipping tokens whose raw bytes start with `[_` or `<|` (specials/control
tokens carry no evidence about the text). pywhispercpp's high-level
`Segment.probability` (populated via `extract_probability=True`) is instead a
GEOMETRIC mean — `exp(mean(log(p)))` — computed over *every* token in the
segment, specials included (`pywhispercpp/model.py::_get_segments`). That
high-level field is deliberately NOT used here.

Instead, `_segment_mean_p()` below reaches past the high-level `Model` API
into pywhispercpp's low-level bindings (`import _pywhispercpp as _pw`) and
walks `whisper_full_get_token_id` + `whisper_token_to_bytes` (RAW bytes) /
`whisper_full_get_token_p` directly, skipping any token whose bytes start with
`[_` or `<|` — the exact same rule, the exact same arithmetic mean, as the
Rust source. This is a byte-faithful port of `segment_mean_p`, not an
approximation.

Deliberately NOT `whisper_full_get_token_text`, despite the name: that binding
returns a Python `str`, decoded strict-UTF-8 on the C side. whisper.cpp's BPE
routinely splits a multi-byte UTF-8 character across two tokens (Hebrew/CJK,
same fact `merge_token_words` exists to handle), so a single token's bytes are
frequently NOT valid UTF-8 on their own — confirmed by hand against the real
model: transcribing Hebrew speech and calling
`whisper_full_get_token_text` on the resulting mid-character tokens raises
`UnicodeDecodeError` (e.g. `'utf-8' codec can't decode byte 0xd7 ... unexpected
end of data`), which would crash `transcribe()` outright the moment a Hebrew/
CJK/Russian segment happened to match `is_stock_hallucination` (several
`STOCK`/`CREDIT_MARKS` entries are exactly those scripts) — silent, best-effort
filtering turning into an unhandled exception on ordinary non-English audio.
Rust's `tok.to_bytes()` never has this problem because it never decodes to
`str` for this check at all. `whisper_token_to_bytes` is the low-level binding
that returns the same raw bytes without decoding, so this port now matches
Rust's crash-safety as well as its arithmetic.

The cost of that fidelity: it reads `Model._ctx`, an attribute pywhispercpp
does not document as public API (confirmed present and populated immediately
after `.transcribe()` returns, on the installed 1.5.0). If a future
pywhispercpp release renames or removes `_ctx`, the documented fallback is
`extract_probability=True` plus `segment.probability` — strictly worse
fidelity to the Rust source (geometric mean, specials included), but it only
needs the public API surface.

--------------------------------------------------------- DIVERGENCE 2: no
per-decode `WhisperState`

Rust's `whisper-rs` keeps one `Arc<WhisperContext>` (read-only weights) and
hands each decode its OWN `WhisperState` via `ctx.create_state()`, so
concurrent decodes on the same model are safe and were the whole point of the
`CTX` design (see the doc comment above it in `stt.rs` — a single mutex around
`full()` once stalled a live meeting's transcript behind a 45-minute import).
`pywhispercpp.Model.transcribe()` has no equivalent "create a fresh decode
state" call in its public API: it mutates `self._params`/`self._ctx` directly
on every `.transcribe()` call. Concurrent `.transcribe()` calls on the SAME
`Model` instance are therefore NOT safe here the way they are in Rust — a
real, library-shape-forced divergence, not an oversight. Nothing in this
sidecar currently calls `.transcribe()` from two threads on the same model at
once, so it is not exercised in practice, but a future caller must not assume
Rust's parallel-decode guarantee holds on this side.

What IS preserved exactly is the *bookkeeping* contract around that shared
`Model`: `_checkout`/`_checkin` below increment/decrement a reference count on
the SAME lock acquisition that looks up (or constructs) the cache entry —
mirroring how Rust's `warm_context` clones the `Arc` while `CTX`'s guard is
still held, so a decode's reference is visible to `unload_model` the instant
`warm_context`/`_checkout` returns, with no gap in which "come back later"
could be answered "yes, all clear" one instruction too early.
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from typing import Optional

import numpy as np

# Low-level bindings — see "DIVERGENCE 1" above. This is the same extension
# module `pywhispercpp.model` itself imports as `pw`.
import _pywhispercpp as _pw
from pywhispercpp.model import Model

from arcelle_sidecar.stt.hallucination import (
    STOCK_MAX_CONFIDENCE,
    is_junk_segment,
    is_stock_hallucination,
)

# Whisper large-v3-turbo, 5-bit quantized: the Hebrew-capable sweet spot
# (~574 MB download, ~1 GB working set, fast on Metal).
MODEL_FILE: str = "ggml-large-v3-turbo-q5_0.bin"
MODEL_URL: str = (
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"
)
MODEL_SIZE_MB: int = 574


def format_stamp(cs: int) -> str:
    """The "[m:ss]" (or "[h:mm:ss]" past an hour) transcript stamp.

    Port of `recording::format_stamp` (`src-tauri/src/recording.rs`), which
    `stt.rs` itself imports under the alias `format_ts` — ONE implementation
    for the whole app: the player, search, and the AI all parse this exact
    shape. `cs` is centiseconds (10 ms units); negative values clamp to 0.
    """
    s = max(cs, 0) // 100
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    if h > 0:
        return f"[{h}:{m:02d}:{sec:02d}]"
    return f"[{m}:{sec:02d}]"


def _n_threads() -> int:
    """`available_parallelism().min(8)`, `unwrap_or(4)` on failure — computed
    fresh on every call, exactly as Rust calls
    `std::thread::available_parallelism()` inside `transcribe()` itself
    rather than once at context-construction time.
    """
    n = os.cpu_count()
    return min(n, 8) if n else 4


# ---------------------------------------------------------------- warm context


@dataclass
class _CacheEntry:
    """One warm `Model`, keyed by the path it was loaded from.

    `refs` is the Python stand-in for Rust's `Arc::strong_count`: the cache
    slot itself is the baseline holder (Rust's `Arc::new` starts a strong
    count of 1 for that same reason), and every in-flight `transcribe()` call
    bumps `refs` by one for the duration of its decode, dropping it back in a
    `finally`. `unload_model` reads this count (never Python's raw refcount,
    which would also count incidental local-variable references and isn't a
    portable signal) to decide whether a decode currently holds the weights
    open.
    """

    path: str
    model: Model
    refs: int = 0


# whisper.cpp mmaps the weights, so keeping the context loaded costs address
# space, not resident RAM the OS can't reclaim — and saves the multi-second
# reload on every dictation. The lock below covers the LOOKUP/construction
# (and, in `_checkout`, the ref-count bump) only, never a decode itself: held
# across a whole transcription, this one lock would serialize every speech
# job in the app exactly as Rust's `CTX` doc comment describes — a 45-minute
# import parking a live recording's decoder thread.
_lock = threading.Lock()
_cache: Optional[_CacheEntry] = None


def warm_context(model_path: str) -> Model:
    """The warm `Model` for `model_path`, loading it if this is a different
    model (replacing — and letting Python's GC eventually free — whatever was
    cached before, once nothing else still references it). Mirrors Rust's
    `warm_context`, minus the ref-count bump: a bare call here (as opposed to
    one made through `transcribe()`/`_checkout`) does not keep anything
    "checked out", so it is safe to use for warming/tests without pinning the
    cache against `unload_model`.
    """
    return _checkout_locked(model_path, bump=False).model


def _checkout_locked(model_path: str, *, bump: bool) -> _CacheEntry:
    global _cache
    with _lock:
        if _cache is None or _cache.path != model_path:
            model = Model(model_path, redirect_whispercpp_logs_to=False)
            _cache = _CacheEntry(path=model_path, model=model)
        if bump:
            _cache.refs += 1
        return _cache


def _checkout(model_path: str) -> _CacheEntry:
    """Like `warm_context`, but ALSO takes out one reference on the returned
    entry, in the very same lock acquisition that does the lookup/construction
    — the Python stand-in for the extra `Arc` clone a Rust decode holds across
    `state.full()`, made under the same `CTX` guard that Rust's `warm_context`
    still holds when it calls `.clone()`. That "same critical section" detail
    is load-bearing: it is what stops `unload_model` from ever observing "just
    constructed, nobody holds it yet" for an entry a decode is about to use.

    MUST be paired with exactly one `_checkin` call, even on error (a
    `try`/`finally` around the decode).
    """
    return _checkout_locked(model_path, bump=True)


def _checkin(entry: _CacheEntry) -> None:
    with _lock:
        entry.refs -= 1


def unload_ctx() -> None:
    """Drop the cache's own hold on the warm context — called on app exit in
    Rust because Metal/ggml asserts during process teardown if GPU buffers
    are still resident. `try_lock`, not `lock`: blocking exit behind a long
    transcription would read as a hang; a decode in flight keeps its own
    reference (see `_CacheEntry.refs`) and finishes normally either way.

    Python has no equivalent of that teardown-time assert — pywhispercpp's
    `Model.__del__` calls `whisper_free()` deterministically (verified: under
    CPython, dropping the last reference frees the Metal context immediately,
    no crash, no assert) whenever the last reference to a `Model` goes away,
    process exit included. The non-blocking, don't-yank-a-live-decode
    discipline is kept anyway, because a concurrent decode holding the model
    must not have it pulled out from under it.
    """
    global _cache
    if not _lock.acquire(blocking=False):
        return
    try:
        _cache = None
    finally:
        _lock.release()


def unload_model(path: str) -> bool:
    """Release the warm context when it is the copy loaded from `path` — what
    "delete the model and give the space back" actually needs, since unlinking
    an mmapped file frees nothing while the mapping is open.

    Three-way result, exactly mirroring Rust's `unload_model`:
    - the lock could not be acquired at all (a lookup/construction is
      mid-flight) -> `False`, "come back later";
    - the lock was acquired and nothing is cached, or the cached model is for
      a DIFFERENT path -> `True`, nothing to do, cache left untouched;
    - the lock was acquired, the path matches, but a decode is still holding
      a reference (`refs > 0`, the Python stand-in for
      `Arc::strong_count(ctx) > 1`) -> `False`, "come back later": unlinking
      an mmapped model file frees nothing while a decode still holds it open,
      so a single silent attempt here would leak the weights for the rest of
      the session;
    - the lock was acquired, the path matches, and nothing else holds it ->
      cache cleared, `True`.
    """
    global _cache
    if not _lock.acquire(blocking=False):
        return False
    try:
        if _cache is None:
            return True
        if _cache.path != path:
            return True
        if _cache.refs > 0:
            return False
        _cache = None
        return True
    finally:
        _lock.release()


# -------------------------------------------------------------------- decode


def _segment_mean_p(ctx: object, seg_index: int) -> float:
    """Arithmetic mean of one segment's token probabilities, skipping
    specials/control tokens — see "DIVERGENCE 1" in the module docstring for
    why this bypasses pywhispercpp's own (geometric-mean) `Segment.probability`.

    Specials ("[_BEG_]", "<|endoftext|>") are not words and carry no evidence
    about the text — skipped exactly like Rust's
    `tok.to_bytes().is_ok_and(|b| b.starts_with(b"[_") || b.starts_with(b"<|"))`.
    0.0 for a segment with no scored tokens (Rust: `n == 0 => 0.0`).

    Reads RAW bytes per token via `whisper_token_to_bytes`, never
    `whisper_full_get_token_text` (a `str`-returning binding that strict-UTF-8
    decodes on the C side and raises `UnicodeDecodeError` on a token that is
    half of a multi-byte character — routine for Hebrew/CJK BPE; see the
    module docstring's DIVERGENCE 1 note for the confirmed crash this avoids).
    """
    n_tokens = _pw.whisper_full_n_tokens(ctx, seg_index)
    total = 0.0
    n = 0
    for j in range(n_tokens):
        token_id = _pw.whisper_full_get_token_id(ctx, seg_index, j)
        raw = _pw.whisper_token_to_bytes(ctx, token_id)
        if raw.startswith(b"[_") or raw.startswith(b"<|"):
            continue
        total += _pw.whisper_full_get_token_p(ctx, seg_index, j)
        n += 1
    return total / n if n > 0 else 0.0


def transcribe(model_path: str, pcm: np.ndarray, timestamps: bool) -> str:
    """Transcribe mono 16 kHz samples. Language is auto-detected (Hebrew
    included). With `timestamps`, each Whisper segment becomes a "[m:ss] …"
    line — the contract the audio viewer's clickable transcript reads.
    Blocking and heavy: callers should run it on a background thread, never
    the UI or an async event loop.

    Whisper's inventions are filtered exactly as the live recording engine
    filters them: bracketed noise markers (`is_junk_segment`) always, and the
    stock silence phrases (`is_stock_hallucination`) only when the model
    itself wasn't confident (`_segment_mean_p(...) < STOCK_MAX_CONFIDENCE`).
    This is the whole-file path — imports, voice messages, dictation — so
    what it keeps is what search and the AI read as spoken.

    Deliberately NO translate task here, matching the Rust source: the
    shipped model is a *-turbo distilled Whisper, not trained on translation,
    and silently emits near-source text when asked. Translation runs in the
    dictation-shaping LLM stage instead (out of scope for this module).
    """
    if len(pcm) < 1600:
        return ""  # < 0.1s of audio: nothing to hear

    pcm32 = np.asarray(pcm, dtype=np.float32)
    threads = _n_threads()

    # The lock ends inside `_checkout`: a whole-file import must not park the
    # live recording's decoder thread for the length of the file (see the
    # `_lock` doc comment above).
    entry = _checkout(model_path)
    try:
        segments = entry.model.transcribe(
            pcm32,
            language="auto",
            n_threads=threads,
            greedy={"best_of": 1},
            print_special=False,
            print_progress=False,
            print_realtime=False,
            print_timestamps=False,
        )

        # `model._ctx` is valid immediately after `.transcribe()` returns and
        # indexes the SAME segments 0..n just returned (pywhispercpp's own
        # `_get_segments` builds that list by walking 0..n in this exact
        # order) — see `_segment_mean_p`'s divergence note.
        ctx = entry.model._ctx  # noqa: SLF001 - see module docstring

        lines: list[str] = []
        for i, seg in enumerate(segments):
            text = seg.text.strip()
            # Drop silence hallucinations the same way the live path does —
            # a near-silent clip otherwise decodes to a lone "." or
            # "[BLANK_AUDIO]" and gets stored as a real (misleading)
            # transcript. An all-junk clip -> "".
            if is_junk_segment(text):
                continue
            # …and the stock phrases whisper invents over silence and music
            # ("Thank you.", "Subtitles by the Amara.org community"), on the
            # same terms as the live path: only when the model itself wasn't
            # sure. Imported audio/video, voice messages and dictation all
            # come through here, and a sentence nobody said must not reach
            # search or the AI.
            if is_stock_hallucination(text) and _segment_mean_p(ctx, i) < STOCK_MAX_CONFIDENCE:
                continue
            if timestamps:
                # seg.t0 is in centiseconds (10 ms units), same as Rust's
                # `seg.start_timestamp()`.
                lines.append(f"{format_stamp(seg.t0)} {text}")
            else:
                lines.append(text)
        return "\n".join(lines) if timestamps else " ".join(lines)
    finally:
        _checkin(entry)
