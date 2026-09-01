"""Offline retranscription, decode worker, and live translation helpers."""

from __future__ import annotations

import asyncio
import copy
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable

import numpy as np

from arcelle_sidecar.diar.cluster import SpeakerBook
from arcelle_sidecar.diar.embed import VoicePrint
from arcelle_sidecar.diar.label import Naming
from arcelle_sidecar.diar.recognize import KnownVoice
from arcelle_sidecar.rec.lanes import Lane, LaneLang, Source
from arcelle_sidecar.rec.meta import RETRANSCRIBE_DECODE_PCT, RETRANSCRIBE_STOPPED, SAMPLE_RATE, RecCut, RecMeta, RecSegment, RecWord, cs_of_samples, format_stamp
from arcelle_sidecar.stt.live import Auto, Forced, LangMode, PhraseOut, Sniff, Watch

if TYPE_CHECKING:
    from arcelle_sidecar.rec.engine import DecodeJob, DecodeOut, EnginePorts


def _facade_module() -> Any:
    from arcelle_sidecar.rec import engine

    return engine


class RetranscribeStopped(Exception):
    """Raised by :func:`retranscribe` when its ``stop`` callback fires
    mid-pass. Mirrors Rust's ``Err(RETRANSCRIBE_STOPPED.into())`` early
    returns, but as a dedicated exception type rather than a stringly-typed
    ``Result`` a caller would have to string-compare -- a decode failure
    (``Transcribing at ... failed: ...``) raises a plain ``RuntimeError``
    instead, so callers can tell "stopped on purpose" from "genuinely broken"
    by exception type alone. ``str(exc) == RETRANSCRIBE_STOPPED`` always."""

    def __init__(self, message: str = RETRANSCRIBE_STOPPED) -> None:
        super().__init__(message)


@dataclass
class _Retranscription:
    """Mutable state for the one-lane offline rebuild.

    Keeping the cursor, carry buffer, and rebuilt metadata together makes the
    decode loop read as its three real steps: fill the lane, decode one final,
    then finish the speaker pass. It intentionally owns no external resource;
    all model work remains in the established transcribe/diarization seams.
    """

    samples: np.ndarray
    total_cs: int
    diarize_model_path: str
    meta: RecMeta
    lang: LaneLang
    book: SpeakerBook
    lane: Lane
    pos: int = 0
    ready: deque[tuple[int, list[float]]] = field(default_factory=deque)
    fed_everything: bool = False


def _retranscribed_meta(samples: np.ndarray, prior: RecMeta) -> RecMeta:
    """Create the rebuilt metadata while retaining only durable user edits."""
    return RecMeta(
        duration_cs=cs_of_samples(len(samples)),
        cuts=copy.deepcopy(prior.cuts),
        max_speakers=prior.max_speakers,
        speaker_names={
            label: name
            for label, name in prior.speaker_names.items()
            if name not in prior.recognized
        },
        chapters=copy.deepcopy(prior.chapters),
        highlights=copy.deepcopy(prior.highlights),
        notes=copy.deepcopy(prior.notes),
    )


def _new_retranscription(
    samples: np.ndarray, prior: RecMeta, diarize_model_path: str | None
) -> _Retranscription:
    """Initialize the single VAD lane and speaker book for an offline pass."""
    meta = _retranscribed_meta(samples, prior)
    return _Retranscription(
        samples=samples,
        total_cs=meta.duration_cs,
        diarize_model_path=diarize_model_path or "",
        meta=meta,
        lang=LaneLang(),
        book=_facade_module()._new_speaker_book(meta.max_speakers),
        lane=_facade_module().Lane(0),
    )


def _stop_retranscription_if_requested(stop: Callable[[], bool]) -> None:
    """Abort before starting the next uninterruptible unit of work."""
    if stop():
        raise RetranscribeStopped()


def _feed_retranscription_lane(rebuild: _Retranscription) -> None:
    """Give the VAD its next second, or flush its final carry buffer once."""
    if rebuild.pos < len(rebuild.samples):
        end = min(rebuild.pos + SAMPLE_RATE, len(rebuild.samples))
        rebuild.ready.extend(rebuild.lane.push(rebuild.samples[rebuild.pos:end]))
        rebuild.pos = end
        return
    rebuild.fed_everything = True
    flushed = rebuild.lane.flush_active()
    if flushed is not None:
        rebuild.ready.append(flushed)


def _retranscription_mode(lang: LaneLang) -> LangMode:
    """Decode under the same sticky language policy as live recording."""
    hint = lang.hint()
    return Watch(hint) if hint is not None else Sniff()


def _decode_retranscription_phrase(
    model_path: str, audio: list[float], t0: int, mode: LangMode
) -> PhraseOut:
    """Decode one VAD final while preserving the rebuild-specific error text."""
    try:
        return _facade_module().transcribe_segments(model_path, np.asarray(audio, dtype=np.float32), t0, mode)
    except Exception as exc:  # noqa: BLE001 -- mirrors Rust's Result -> Err(String)
        raise RuntimeError(f"Transcribing at {format_stamp(t0)} failed: {exc}") from exc


def _record_retranscribed_phrase(
    rebuild: _Retranscription,
    phrase: PhraseOut,
    t0: int,
    t1: int,
    audio: list[float],
) -> None:
    """Keep a non-empty final and update sticky language/speaker state."""
    text, words, seg_lang, _mean_p = _facade_module().merge_phrase(phrase.segs)
    if not text.strip():
        rebuild.lang.note_empty_final()
        return
    rebuild.lang.observe(phrase.detected, len(words), t1 - t0)
    emb = _facade_module().embed(rebuild.diarize_model_path, np.asarray(audio, dtype=np.float32))
    rebuild.meta.segments.append(
        RecSegment(
            id=str(uuid.uuid4()),
            source=Source.SYS.as_str(),
            speaker=rebuild.book.assign(emb),
            t0=t0,
            t1=t1,
            text=text,
            words=words,
            lang=seg_lang,
            voice=emb,
        )
    )


def _retranscription_windows(
    samples: np.ndarray, seg: RecSegment, diarize_model_path: str
) -> list[tuple[int, int, VoicePrint]]:
    """Derive window prints from the mixed timeline for one rebuilt segment."""
    i0 = max(seg.t0, 0) * (SAMPLE_RATE // 100)
    i1 = min(max(seg.t1, 0) * (SAMPLE_RATE // 100), len(samples))
    if i1 <= i0:
        return []
    return _facade_module().window_prints(samples[i0:i1], seg.t0, diarize_model_path)


def _word_is_in_retranscribed_cut(word: RecWord, cuts: list[RecCut]) -> bool:
    """Whether a fresh word overlaps one of the durable deletion intervals."""
    return any(word.t0 < cut.t1 and word.t1 > cut.t0 for cut in cuts)


def _mark_retranscribed_cut_words(meta: RecMeta) -> None:
    """Restore the user's carried-over studio deletions on fresh word timings."""
    for seg in meta.segments:
        for word in seg.words:
            if _word_is_in_retranscribed_cut(word, meta.cuts):
                word.del_ = True


def retranscribe(
    model_path: str,
    samples: np.ndarray,
    prior: RecMeta,
    known: list[KnownVoice],
    diarize_model_path: str | None,
    progress: Callable[[int, int], None],
    stop: Callable[[], bool],
) -> RecMeta:
    """Rebuild a whole recording's transcript from its audio with the CURRENT
    pipeline -- the offline twin of the live engine, for recordings saved with
    corrupted words, a wrong language lock, or older speaker logic. Blocking;
    the caller wraps it in ``asyncio.to_thread`` (or a real thread), matching
    Rust's own "blocking; run it on a worker thread" doc comment.

    The same building blocks, one lane: the VAD chunks the samples into
    phrases, each final decodes under the :class:`LaneLang` sticky policy
    (Sniff -> lock -> Watch, same constants), every phrase gets a voiceprint,
    and one :func:`split_by_voice` at the end derives the speakers from all
    voices at once. Everything is source "sys": the mixed file has no lane
    identity left, so nobody becomes "You" -- speakers are "Speaker N". The old
    meta's ``cuts``, ``max_speakers`` and ``speaker_names`` survive (prior
    studio deletions keep applying to the unchanged timeline, a pinned
    participant count stays pinned, and the names the user TYPED are an overlay
    on the labels); the GUESSES do not outlive the labels they were made about,
    and ``read_of`` deliberately does not survive -- the transcript is about to
    be rewritten, so the room's reading is stale by definition. Annotations
    survive WHOLE: the audio is unchanged, so every time they are anchored on
    is still exactly true.

    A decode failure is an error, never silence -- a broken or missing model
    would otherwise rewrite the whole recording as "nobody spoke".

    ``progress`` is called after each decoded phrase with (done centiseconds,
    total centiseconds), ending at (total, total). ``stop`` is polled between
    phrases AND once more before the speaker pass (which has no inner
    checkpoint and runs for tens of seconds on a long meeting) -- a stopped
    rebuild raises :class:`RetranscribeStopped` and writes nothing, so the
    stored transcript is untouched either way.

    ``known`` is the room's saved voices, so a rebuild recognises people
    exactly as a fresh recording would; ``diarize_model_path`` is ``None`` when
    no diarize model was found.
    """
    samples = np.asarray(samples, dtype=np.float32)

    # DEEP copies, not `list(...)`. Rust carries these over as
    # `prior.cuts.clone()` / `.chapters.clone()` / `.highlights.clone()` /
    # `.notes.clone()`, and `Vec<T>::clone()` clones every ELEMENT -- the
    # rebuilt meta shares nothing with the caller's. A shallow list copy hands
    # back the caller's own `RecCut`/`RecChapter`/`RecHighlight`/`RecNote`
    # objects, so editing a note on the rebuilt transcript silently rewrites
    # the meta the caller kept to fall back on ("a stopped rebuild leaves the
    # recording exactly as it was" has to stay true of a FINISHED one too).
    # Same rule `Engine.__init__` deep-copies `cfg.meta` for.
    rebuild = _new_retranscription(samples, prior, diarize_model_path)
    # Chunked like live capture so the lane's carry buffer stays small, and
    # each phrase is transcribed the moment it closes rather than piling up: a
    # collected phrase list is a SECOND full copy of a 3 h recording's audio
    # (~1 GB) on top of the samples the caller already holds.
    while True:
        # Cheap (one call per second of audio) and checked before the decoder,
        # which is where the minutes go.
        _stop_retranscription_if_requested(stop)
        if not rebuild.ready:
            if rebuild.fed_everything:
                break
            _feed_retranscription_lane(rebuild)
            continue
        start, audio = rebuild.ready.popleft()
        t0, t1 = cs_of_samples(start), cs_of_samples(start + len(audio))
        # The speaker pass below runs after the last phrase and can take tens
        # of seconds; the decode owns only the first slice of the bar, so a
        # rebuild never sits at 100% while it is still working.
        done_cs = t1 * RETRANSCRIBE_DECODE_PCT // 100
        mode = _retranscription_mode(rebuild.lang)
        phrase = _decode_retranscription_phrase(model_path, audio, t0, mode)
        _record_retranscribed_phrase(rebuild, phrase, t0, t1, audio)
        progress(done_cs, rebuild.total_cs)

    # The speaker pass has no inner checkpoint and runs for tens of seconds on
    # a long meeting, so this is the last chance to give up before it starts.
    _stop_retranscription_if_requested(stop)

    naming = Naming(
        names=rebuild.meta.speaker_names,
        recognized=rebuild.meta.recognized,
        known=list(known),
    )
    _facade_module().split_by_voice(
        rebuild.meta.segments,
        rebuild.meta.max_speakers,
        naming,
        lambda seg: _retranscription_windows(samples, seg, rebuild.diarize_model_path),
    )

    # The carried-over cuts are the user's studio deletions. Re-marking the
    # freshly derived words that fall inside them keeps that promise: deleted
    # content must not resurface in the transcript, the search index, or an
    # exported copy just because the words were re-transcribed.
    _mark_retranscribed_cut_words(rebuild.meta)

    progress(rebuild.total_cs, rebuild.total_cs)
    return rebuild.meta


# ============================================================================
# ---- The decode worker's job -> result mapping ----------------------------
# (the body of Rust's decode-thread closure, recording.rs 1564-1601, which has
# no standalone name to port)
# ============================================================================


def _decode_job_mode(job: DecodeJob) -> LangMode:
    """Choose the final/partial language mode before calling the decoder."""
    if job.lang is None:
        return Sniff() if job.kind is _facade_module().JobKind.FINAL else Auto()
    return Watch(job.lang) if job.kind is _facade_module().JobKind.FINAL else Forced(job.lang)


def _transcribe_decode_job(
    model_path: str, job: DecodeJob, offset_cs: int, mode: LangMode
) -> tuple[PhraseOut, str | None]:
    """Make decoder failures explicit without preventing speaker analysis."""
    try:
        return _facade_module().transcribe_segments(model_path, job.samples, offset_cs, mode), None
    except Exception as exc:  # noqa: BLE001 -- mirrors Rust's Ok(p)/Err(e) mapping
        return PhraseOut(), str(exc)


def _final_speaker_analysis(
    diarize_model_path: str | None, job: DecodeJob, offset_cs: int
) -> tuple[VoicePrint | None, list[tuple[int, int, VoicePrint]], str | None]:
    """Derive final-job voice data, preserving its non-fatal error boundary."""
    if job.kind is not _facade_module().JobKind.FINAL:
        return None, [], None
    model_diar = diarize_model_path or ""
    try:
        return (
            _facade_module().embed(model_diar, job.samples),
            _facade_module().window_prints(job.samples, offset_cs, model_diar),
            None,
        )
    except Exception as exc:  # noqa: BLE001 -- a diarization failure must not kill the worker
        return None, [], str(exc)


def _decode_job_error(transcribe_error: str | None, speaker_error: str | None) -> str | None:
    """Keep the decoder's error when both analysis stages failed."""
    if transcribe_error is not None:
        return transcribe_error
    if speaker_error is not None:
        return f"speaker analysis failed: {speaker_error}"
    return None


def _run_decode_job(model_path: str, diarize_model_path: str | None, job: DecodeJob) -> DecodeOut:
    """What the decode worker does with one job: a plain, synchronous,
    independently-testable function, run via ``asyncio.to_thread`` by
    :meth:`Engine._decode_worker`.

    NEVER RAISES. Rust's ``diarize::embed``/``window_prints`` are infallible,
    so its decode thread only has to catch ``transcribe_segments``; the Python
    ports of both CAN raise (a corrupt ONNX model, an onnxruntime failure), and
    an exception here would kill the single decode task with ``decode_busy``
    stuck ``True`` -- the engine would then never drain, so Stop would hang and
    the whole recording would be lost. Both candidate ports had exactly that
    hole. A failure is reported the way the Rust source already reports a
    decode failure: as ``err`` on an otherwise-empty :class:`DecodeOut`, which
    :meth:`Engine.integrate` turns into one honest "could not transcribe part
    of this recording" error while the audio keeps being saved.
    """
    offset_cs = cs_of_samples(job.start)
    # Finals carry a detection report (it is what locks a lane or votes to move
    # it); partials are throwaway and must never pay for the detector.
    mode = _decode_job_mode(job)
    phrase, transcribe_error = _transcribe_decode_job(model_path, job, offset_cs, mode)
    emb, wins, speaker_error = _final_speaker_analysis(diarize_model_path, job, offset_cs)

    return _facade_module().DecodeOut(
        kind=job.kind,
        source=job.source,
        start=job.start,
        n_samples=int(np.asarray(job.samples).size),
        segs=phrase.segs,
        detected=phrase.detected,
        emb=emb,
        wins=wins,
        err=_decode_job_error(transcribe_error, speaker_error),
    )


# ============================================================================
# ---- LiveTranslateQueue / spawn_live_translator / room_translation_model --
# ---- (recording.rs 2657-2778) ---------------------------------------------
# ============================================================================

#: At most this many finished sentences may wait for the translator. Past that
#: the oldest are simply not translated: live translation is a lens over the
#: transcript, never a gate on it, and a queue that outgrew the model would
#: show translations minutes behind the words they belong to.
LIVE_TRANSLATE_QUEUE: int = 8


class LiveTranslateQueue:
    """The hand-off from :meth:`Engine.integrate` to the live-translate worker:
    a newest-wins ring plus a wake-up.

    A bounded channel alone dropped the WRONG end. ``try_send`` on a full
    channel throws away the sentence being offered -- the line just spoken --
    and keeps delivering the stale ones queued behind it, so a fast stretch of
    a meeting is exactly the part that never gets translated. Here the newest
    sentence always gets in and the oldest one still waiting is the one given
    up. ``asyncio.Event`` replaces the ``tauri::async_runtime`` channel used
    purely as a wake-up there -- the sentences themselves live in
    :attr:`waiting`, same as the Rust struct's own field."""

    def __init__(self) -> None:
        self.waiting: deque[tuple[RecSegment, str]] = deque()
        self.wake: asyncio.Event = asyncio.Event()

    def push(self, seg: RecSegment, lang: str) -> None:
        """Offer a finished sentence. Never blocks, never fails; over the cap
        the oldest waiting sentence is dropped to make room."""
        self.waiting.append((seg, lang))
        while len(self.waiting) > LIVE_TRANSLATE_QUEUE:
            self.waiting.popleft()
        self.wake.set()

    def pop(self) -> tuple[RecSegment, str] | None:
        """The oldest waiting sentence, or ``None`` when the ring is empty --
        drained in order, exactly like Rust's ``pop_front`` loop."""
        return self.waiting.popleft() if self.waiting else None


def room_translation_model(default_translation_model: str | None) -> str | None:
    """The model live translation runs on.

    Rust's ``room_translation_model`` reads the room's own model SETTING from
    the DB, falling back to the best local model when the room has none of its
    own. Both of those reads are Electron's job in this rewrite (see
    :meth:`EnginePorts.translate`) -- ``EngineConfig.default_translation_model``
    already carries whatever the caller resolved, so this port reduces to the
    identity function. Kept as its own named function (rather than inlined at
    its one call site) so the SHAPE of the original decision -- "the model live
    translation runs on, resolved from context" -- stays a real, separately
    testable seam."""
    return default_translation_model


async def _translate_live_item(
    ports: EnginePorts,
    file_id: str,
    default_translation_model: str | None,
    item: tuple[RecSegment, str],
    model: str | None,
) -> str | None:
    """Translate one queued final and retain the lazily resolved model."""
    seg, lang = item
    if model is None:
        model = room_translation_model(default_translation_model)
    if model is None:
        return None
    translated = await ports.translate(seg.text, lang, model)
    if translated:
        ports.emit(
            "rec-live-translation",
            {"fileId": file_id, "segId": seg.id, "text": translated},
        )
    return model


async def _drain_live_translations(
    ports: EnginePorts,
    file_id: str,
    default_translation_model: str | None,
    queue: LiveTranslateQueue,
    model: str | None,
) -> str | None:
    """Drain the newest-wins queue in FIFO order after one wake-up."""
    while True:
        item = queue.pop()
        if item is None:
            return model
        model = await _translate_live_item(
            ports, file_id, default_translation_model, item, model
        )


def spawn_live_translator(
    ports: EnginePorts, file_id: str, default_translation_model: str | None,
    queue: LiveTranslateQueue,
) -> "asyncio.Task[None]":
    """Start the session's live-translation worker: ONE task, ONE resolved
    model, one sentence at a time, translations emitted as
    ``rec-live-translation``.

    Every finished sentence used to start its own task, which first asked for
    the whole installed-model list and then picked its own default instead of
    the room's -- one extra request per sentence, all at once, competing with
    live transcription for the machine. The model is resolved once, lazily
    (Rust's ``let mut model: Option<String> = None;``), and an unresolvable one
    just waits for the next sentence -- as does any ``translate`` failure,
    which is ported exactly: nothing here is ever fatal.

    Rust's own version CREATES the queue it hands back; here the queue is
    :class:`Engine`'s from construction and is passed in, so an engine built
    without a worker (the plain constructor) still has somewhere for
    :meth:`Engine.integrate` to offer sentences -- and a test can read them.
    """

    async def _worker() -> None:
        model: str | None = None
        while True:
            await queue.wake.wait()
            queue.wake.clear()
            # Drain in order, oldest first.
            model = await _drain_live_translations(
                ports, file_id, default_translation_model, queue, model
            )

    return asyncio.create_task(_worker())


# ============================================================================
# ---- Engine (recording.rs 1610-2655) --------------------------------------
# ============================================================================
