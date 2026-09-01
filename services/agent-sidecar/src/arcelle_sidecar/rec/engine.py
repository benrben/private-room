"""Live recording orchestration, decoding, and persistence."""
from __future__ import annotations

import asyncio
import copy
import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Awaitable, Callable, Protocol, Union

import numpy as np

from arcelle_sidecar.diar.cluster import SpeakerBook
from arcelle_sidecar.diar.embed import VoicePrint, embed as embed
from arcelle_sidecar.diar.label import relabel as relabel, split_by_voice as split_by_voice
from arcelle_sidecar.diar.recognize import KnownVoice
from arcelle_sidecar.diar.windows import window_prints as window_prints
from arcelle_sidecar.rec.lanes import Lane, LaneLang, Source, SysLane as SysLane
from arcelle_sidecar.rec.engine_ingest import EngineIngestMixin
from arcelle_sidecar.rec.engine_lifecycle import EngineLifecycleMixin
from arcelle_sidecar.rec.engine_persist import EnginePersistMixin
from arcelle_sidecar.rec.engine_workers import LIVE_TRANSLATE_QUEUE as LIVE_TRANSLATE_QUEUE, LiveTranslateQueue as LiveTranslateQueue, RetranscribeStopped as RetranscribeStopped, _Retranscription as _Retranscription, _decode_job_error as _decode_job_error, _decode_job_mode as _decode_job_mode, _decode_retranscription_phrase as _decode_retranscription_phrase, _drain_live_translations as _drain_live_translations, _feed_retranscription_lane as _feed_retranscription_lane, _final_speaker_analysis as _final_speaker_analysis, _mark_retranscribed_cut_words as _mark_retranscribed_cut_words, _new_retranscription as _new_retranscription, _record_retranscribed_phrase as _record_retranscribed_phrase, _retranscribed_meta as _retranscribed_meta, _retranscription_mode as _retranscription_mode, _retranscription_windows as _retranscription_windows, _run_decode_job as _run_decode_job, _stop_retranscription_if_requested as _stop_retranscription_if_requested, _transcribe_decode_job as _transcribe_decode_job, _translate_live_item as _translate_live_item, _word_is_in_retranscribed_cut as _word_is_in_retranscribed_cut, retranscribe as retranscribe, room_translation_model as room_translation_model, spawn_live_translator as spawn_live_translator
from arcelle_sidecar.rec.meta import (
    LANE_RESYNC_GAP,
    RELABEL_EVERY_SEGMENTS,
    SAMPLE_RATE,
    RecMeta,
    RecWord,
    cs_of_samples,
    relabel_interval as relabel_interval,
    time_overlap as time_overlap,
)
from arcelle_sidecar.stt.live import (
    PhraseOut as PhraseOut,
    SegOut,
    transcribe_segments as transcribe_segments,
)

class Save(Enum):
    """What a save is asked to make durable."""

    #: Periodic: append the audio recorded since the last save as a checkpoint.
    CHECKPOINT = "checkpoint"
    #: Pause/stop: assemble and write the real WAV, and drop the checkpoints.
    FULL = "full"
    #: The transcript and the meta only.
    #:
    #: The pause follow-up: the sentence Pause force-closed lands a moment
    #: after Pause's own save, and re-running a `Save.FULL` for it re-encoded
    #: and re-encrypted the WHOLE recording a second time, with the room mutex
    #: held -- hundreds of MB of write amplification per pause on a long
    #: meeting, and a visible freeze of everything else the room does. The
    #: audio was made durable by the first write and cannot have grown: the
    #: engine is paused.
    TRANSCRIPT = "transcript"


#: How long a failing save waits before it says so again. The retry itself is
#: driven by the ingest trigger, which is true for every batch once the dirty
#: tail is past a minute. Seconds (Rust: `Duration::from_secs(5)`), compared
#: against `time.monotonic()` deltas -- there is no `Instant`/`Duration` pair
#: in this port, just float seconds.
FLUSH_RETRY_BACKOFF: float = 5.0

#: What a stop reports when the final write into the room did not happen.
SAVE_FAILED: str = "The recording could not be saved into the room."

#: What a caller still waiting on a reply is told once the engine has finished
#: and there is nobody left to answer it -- see :meth:`Engine._answer_orphan`.
#: Rust's own copy, verbatim, from ``recording_cmds.rs``'s ``stop_verdict``
#: give-up branch, so nothing new is invented at this seam.
ENGINE_GONE: str = "The recording engine stopped before it could save."


def checkpoint_mark(lanes_at: int, head: int, flushed: int) -> int:
    """How far up the mixed timeline a checkpoint may carry the audio, given
    the lowest position either capture lane can still write to (``lanes_at``,
    the smaller of the two :meth:`Lane.write_floor`s), the timeline's ``head``
    and the last checkpoint (``flushed``).

    NOT the head. The two lanes write at their own positions -- a
    quarter-second batch apart is the normal case -- so the trailing one still
    owes samples BELOW the head. Checkpointing to the head marked those
    flushed, and they were never written to the room at all: in a
    crash-recovered recording the meeting lane dropped out for a fraction of a
    second at every one-minute boundary, while the leading lane was intact.

    A lane that stopped delivering mid-session must not stall the checkpoints,
    though: its position is frozen wherever it died, and waiting on it would
    lose a whole recording instead of a fifth of a second. ``LANE_RESYNC_GAP``
    is the bar -- below it the honest watermark wins, past it the head does. (A
    lane that never started at all is not this case; :meth:`Lane.write_floor`
    answers the head for it, because it will be re-anchored before it writes.)
    """
    # Rust: `lanes_at.max(head.saturating_sub(GAP)).min(head).max(flushed)` --
    # `saturating_sub` is what the max(0, ...) reproduces.
    v = max(lanes_at, max(0, head - LANE_RESYNC_GAP))
    v = min(v, head)
    return max(v, flushed)


@dataclass(frozen=True, slots=True)
class MsgAudio:
    """A batch of raw audio pushed from one capture lane, at whatever sample
    rate it actually arrived at (:meth:`Engine.ingest` resamples to 16 kHz)."""

    source: Source
    rate: int
    samples: np.ndarray


@dataclass(frozen=True, slots=True)
class MsgSysTapResult:
    """The renderer-owned meeting-audio tap came up (``ok=True``) or failed
    (``ok=False``, ``error`` set) -- the async RESULT of a ``request_sys_tap()``
    call, arriving back as its own message exactly like Rust's
    ``EngineMsg::SysTap(Result<sck::SysAudioTap, String>)`` is a separate
    message from the request that triggered it. There is no tap OBJECT to
    carry here (see the module docstring's ``EnginePorts`` section) -- only
    whether one came up."""

    ok: bool
    error: str | None = None


@dataclass(frozen=True, slots=True)
class MsgSetLiveTranslate:
    """Change the live-translation target language (``None`` = off)."""

    lang: str | None


@dataclass(frozen=True, slots=True)
class MsgSetLiveStt:
    """Live transcription on/off. Off: audio keeps recording (the lanes still
    ingest and mix into the timeline) but nothing is decoded -- closed phrases
    are dropped, no partials are scheduled, and the ghost lines clear. Back on:
    decoding resumes for NEW phrases only; the gap simply has no transcript
    (recoverable later via :func:`retranscribe`)."""

    on: bool


@dataclass(frozen=True, slots=True)
class MsgPause:
    pass


@dataclass(frozen=True, slots=True)
class MsgResume:
    pass


@dataclass(frozen=True, slots=True)
class MsgStop:
    """``done``, if given, is resolved with the final :class:`RecMeta` on a
    clean save or has an exception set on a failed one -- Rust's
    ``mpsc::Sender<Result<RecMeta, String>>`` reply channel, as an
    ``asyncio.Future``. ``None`` mirrors Rust's
    ``done.unwrap_or_else(|| mpsc::channel().0)`` dummy channel: a
    self-triggered stop with nobody waiting on the answer (the verdict is still
    readable at :attr:`Engine.outcome`)."""

    done: "asyncio.Future[RecMeta] | None" = None


@dataclass(frozen=True, slots=True)
class MsgDecodeDone:
    out: "DecodeOut"


@dataclass(frozen=True, slots=True)
class MsgEditMeta:
    """Change the recording's metadata WHILE it is being recorded -- a speaker
    renamed, a note written, a moment marked.

    THE BUG THIS EXISTS FOR: :meth:`Engine.flush` serializes ``self.meta`` --
    the engine's OWN copy -- over the room's row every few phrases. A command
    that wrote to that row directly was therefore erased seconds later, in
    silence. Nothing may edit a LIVE recording's meta except through here.

    ``apply`` mutates the meta in place and returns an error message on
    failure, ``None`` on success (the Python shape of Rust's
    ``FnOnce(&mut RecMeta) -> Result<(), String>``, without needing an
    exception for control flow -- though one that raises anyway is caught and
    reported like any other failure). ``done``, when given, is resolved with
    the post-flush meta on success, or has the error raised into it."""

    apply: "Callable[[RecMeta], str | None]"
    done: "asyncio.Future[RecMeta] | None" = None


EngineMsg = Union[
    MsgAudio,
    MsgSysTapResult,
    MsgSetLiveTranslate,
    MsgSetLiveStt,
    MsgPause,
    MsgResume,
    MsgStop,
    MsgDecodeDone,
    MsgEditMeta,
]


class JobKind(Enum):
    PARTIAL = "partial"
    FINAL = "final"


@dataclass
class DecodeJob:
    kind: JobKind
    source: Source
    start: int
    samples: np.ndarray
    #: The lane's sticky language at dispatch time (``None`` = auto-detect).
    #: Stamped by :meth:`Engine.dispatch_next`, not at enqueue time (see that
    #: method).
    lang: str | None = None

    @staticmethod
    def final_job(source: Source, start: int, samples: np.ndarray) -> "DecodeJob":
        return DecodeJob(kind=JobKind.FINAL, source=source, start=start, samples=samples)


@dataclass
class DecodeOut:
    kind: JobKind
    source: Source
    start: int
    n_samples: int
    segs: list[SegOut]
    #: What the language detector heard (language, confidence) -- the sticky
    #: policy's input, independent of any forced decode language.
    detected: tuple[str, float] | None
    #: Voiceprint of the phrase (final jobs only) for speaker clustering.
    emb: VoicePrint | None
    #: Sub-window prints for the stop-time split pass (ADD-28), computed on the
    #: decode thread because that is the last place the phrase's audio exists
    #: per lane.
    wins: list[tuple[int, int, VoicePrint]]
    #: Why the speech engine could not decode this phrase, when it could not.
    #: A phrase the engine choked on is NOT silence -- swallowing this made a
    #: damaged model produce a recording in which nobody ever spoke.
    err: str | None


class PersistFailed(Exception):
    """A real write failure while persisting -- disk full, deleted row,
    encryption trouble. Mirrors Rust's ``Err(Some(db_err))``; ``str(exc)`` and
    ``exc.message`` are both the human message Rust interpolates as
    ``{db_err}``."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class RoomClosed(Exception):
    """The room closed or switched under the recording. Mirrors Rust's
    ``Err(None)`` -- deliberately carries no payload: there is nothing more to
    say than "stop quietly"."""


class EnginePorts(Protocol):
    """Everything :class:`Engine` reaches outside itself through -- see the
    module docstring's ``EnginePorts`` section."""

    def emit(self, event: str, payload: dict) -> None:
        """Same event names/payload shapes as the Rust source's
        ``app.emit(...)`` call sites, verbatim: ``rec-level``, ``rec-partial``,
        ``rec-state``, ``rec-segment``, ``rec-segment-drop``, ``rec-relabel``,
        ``rec-save-progress``, ``rec-source``, ``rec-error``,
        ``rec-live-translation``, ``room-files-changed``. Synchronous and
        fire-and-forget, matching Rust's own ``let _ = self.app.emit(...)`` --
        a delivery failure is never itself an error worth propagating."""
        ...

    async def persist(
        self,
        save: Save,
        *,
        wav: bytes | None,
        checkpoint_pcm: np.ndarray | None,
        meta_json: str,
        text: str,
    ) -> None:
        """Make one save durable, as ONE transaction (Rust's own comment on
        why: a checkpoint that got its audio in and then failed on the
        transcript left a chunk row behind, and every later retry appended
        another copy of the same samples).

        ``wav`` is set only for ``Save.FULL`` -- write it as the file's bytes
        and DROP the audio checkpoints, in the same transaction.
        ``checkpoint_pcm`` is set only for ``Save.CHECKPOINT``, and only when
        there is genuinely new audio to append: ``None`` on a ``CHECKPOINT``
        means "append nothing, still write the transcript and the meta",
        mirroring Rust's ``if mark > self.flushed_samples { append_rec_chunk(..) }``
        guard. It is always an independent COPY, never a view onto the live
        timeline, so it stays valid across the await.
        ``Save.TRANSCRIPT`` carries neither: the audio is already durable and
        cannot have grown (the engine is paused), only the words moved.

        Raises :class:`PersistFailed` for a real write failure,
        :class:`RoomClosed` for the room having closed/switched under the
        recording -- :meth:`Engine.flush` tells these apart exactly the way
        Rust's ``match`` on ``Err(Some(..))``/``Err(None)`` does."""
        ...

    async def request_sys_tap(self) -> None:
        """Ask the renderer to bring the meeting-audio tap up. Real capture
        start is renderer-owned in this rewrite (``getDisplayMedia`` loopback)
        -- this is a REQUEST signal only; the result (up, or failed) arrives
        back as a :class:`MsgSysTapResult`, separately."""
        ...

    async def stop_sys_tap(self) -> None:
        """Release a tap that is UP. Only ever called when one is (Rust:
        ``if let Some(tap) = self.sys_tap.take() { tap.stop(); }``)."""
        ...

    async def translate(self, text: str, lang: str, model: str) -> str | None:
        """One live-translation call on an already-resolved model. Returns the
        translated text, or ``None`` on any failure -- :class:`Engine` treats
        every failure as "try again on the next sentence", never as fatal.

        THE PORT OWNS THE CLEAN-UP, and must: Rust does
        ``strip_think_spans(&out).trim()`` before deciding whether there is
        anything to show, and the room's default model is a REASONING one, so
        an implementation that hands back raw ``/generate`` output paints
        ``<think>...</think>`` into the live translation. Return the finished
        line -- stripped of think spans and trimmed -- or ``None``/``""`` when
        nothing is left; :class:`Engine` emits whatever comes back, verbatim,
        and only skips the empty answer (Rust's ``if !text.is_empty()``)."""
        ...


@dataclass
class EngineConfig:
    file_id: str
    #: The whisper weights, already resolved by the caller.
    model_path: str
    #: Prior audio when resuming an existing recording file (else empty).
    base_samples: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))
    meta: RecMeta = field(default_factory=RecMeta)
    system_audio: bool = False
    live_translate: str | None = None
    #: The room's saved voices, read once at start. A voice enrolled DURING
    #: this recording is not added here on purpose: naming someone mid-meeting
    #: already names every line they said in it, so re-recognising them from
    #: the same audio could only ever agree with the user or contradict them.
    known_voices: list[KnownVoice] = field(default_factory=list)
    #: The TitaNet weights, already resolved -- or ``None`` when no diarize
    #: model was found, which falls back to the DSP print (see the module
    #: docstring's ``EngineConfig`` section).
    diarize_model_path: str | None = None
    #: The resolved fallback model live translation runs on (see
    #: :func:`room_translation_model`).
    default_translation_model: str | None = None


def _new_speaker_book(max_speakers: int) -> SpeakerBook:
    """``0`` discovers however many people are in the meeting; a non-zero value
    pins the count -- the same ``match`` every construction site in the Rust
    source repeats."""
    return SpeakerBook.with_cap(max_speakers) if max_speakers != 0 else SpeakerBook.auto()


def merge_phrase(segs: list[SegOut]) -> tuple[str, list[RecWord], str | None, float]:
    """One VAD phrase -> one transcript row: Whisper's sub-segments are merged,
    keeping the words' own timestamps. Returns (text, words, language, mean
    token probability across the phrase -- the bleed detector's signal)."""
    parts: list[str] = []
    words: list[RecWord] = []
    lang: str | None = None
    p_sum = 0.0
    p_n = 0
    for s in segs:
        stripped = s.text.strip()
        if stripped:
            parts.append(stripped)
            n = max(len(s.words), 1)
            p_sum += s.mean_p * n
            p_n += n
        # Words and language are merged unconditionally -- a sub-segment whose
        # own text is blank still carries both.
        words.extend(RecWord(w=w, t0=a, t1=b) for (w, a, b) in s.words)
        if lang is None:
            lang = s.lang
    mean_p = p_sum / p_n if p_n > 0 else 0.0
    return " ".join(parts), words, lang, mean_p


@dataclass
class EngineOutcome:
    """The finished session's verdict -- the plain-attribute replacement for
    Rust's ``RecShared.outcome: Mutex<Option<Result<RecMeta, String>>>``, set
    once by :meth:`Engine.finish`. A Stop that arrives after the engine already
    stopped itself (the 3-hour ceiling, the room closing) reads its answer here
    instead of finding a dead channel and reporting a timeout for a recording
    that saved fine. ``ok=True`` carries ``meta``; ``ok=False`` carries
    ``error`` (always :data:`SAVE_FAILED`)."""

    ok: bool
    meta: RecMeta | None = None
    error: str | None = None


#: Starting capacity of the mixed timeline's growth buffer, and the floor of
#: its doubling (see :attr:`Engine.mixed`). One minute of 16 kHz f32 = 3.8 MB.
_MIXED_MIN_CAPACITY: int = SAMPLE_RATE * 60


def _sys_tap_error(error: str | None) -> str:
    """Normalize the renderer's optional tap-start failure message."""
    return error or ""


class Engine(EngineLifecycleMixin, EngineIngestMixin, EnginePersistMixin):
    """The live-recording orchestrator -- port of Rust's ``Engine`` struct and
    its full ``impl``. See the module docstring for the threading-model
    simplifications (no ``RecShared``/``Mutex``, the decode thread -> one
    ``asyncio.Task``, ``EngineHandle`` -> the object itself).

    Construct with the plain constructor for tests that drive
    ``handle()``/``tick()`` directly (no loop required, no workers running), or
    with :func:`create_engine` for the full production shape.
    """

    def __init__(self, cfg: EngineConfig, ports: EnginePorts) -> None:
        self.cfg = cfg
        self.ports = ports

        base_arr = np.asarray(cfg.base_samples, dtype=np.float32).reshape(-1)
        self._mixed_buf: np.ndarray = np.array(base_arr, dtype=np.float32, copy=True)
        self._mixed_len: int = int(base_arr.size)
        base = self._mixed_len

        # The engine owns its OWN copy of the meta (Rust's `cfg.meta.clone()`):
        # the caller's object must never be mutated out from under it, and a
        # `#[derive(Clone)]` on a tree of structs is a DEEP clone -- a shallow
        # per-field copy shares the `RecWord`/`VoicePrint` objects, which is
        # what one candidate did and what let the engine mark words in the
        # caller's meta as deleted.
        self.meta: RecMeta = copy.deepcopy(cfg.meta)
        # The participant count discovers itself unless a room pinned one.
        self.book: SpeakerBook = _new_speaker_book(self.meta.max_speakers)
        # Re-seed the numbering from prior segments so a resumed meeting keeps
        # naming new voices after the ones it already knows.
        self.book.seed_labels([s.speaker for s in self.meta.segments])
        self.known: list[KnownVoice] = list(cfg.known_voices)

        self.mic = Lane(base)
        self.sys = Lane(base)
        self.live_translate: str | None = cfg.live_translate
        #: Live transcription gate (see :class:`MsgSetLiveStt`); ON at start.
        self.live_stt: bool = True
        #: Per-lane sticky language, indexed by ``Source.value``.
        self.lane_lang: list[LaneLang] = [LaneLang(), LaneLang()]

        self.decode_busy: bool = False
        self.final_queue: deque[DecodeJob] = deque()
        self.partial_pending: DecodeJob | None = None
        #: Start sample of the newest phrase finalized on each lane (indexed by
        #: ``Source.value``). A partial that comes back from the decoder for a
        #: phrase at or before it is stale and must not be shown.
        self.last_final_start: list[int | None] = [None, None]

        #: Renderer-owned tap state -- see :class:`MsgSysTapResult`.
        self.sys_tap_up: bool = False
        #: A meeting-audio tap is being set up. Bringing one up takes seconds,
        #: so a pause/resume inside that window would otherwise start a SECOND
        #: one -- two taps, everything recorded and transcribed twice, and the
        #: abandoned one capturing for the rest of the session.
        self.sys_tap_starting: bool = False
        self.paused: bool = False
        #: Pause force-closed a sentence that is still in the decoder; the run
        #: loop saves once more when it lands, so quitting while paused cannot
        #: lose the last thing that was said.
        self.pause_pending: bool = False
        #: See the module docstring for why this is a bool plus a separate
        #: reply future, and why :meth:`finish` leaves it ``True``.
        self.stopping: bool = False
        self.stop_reply: "asyncio.Future[RecMeta] | None" = None
        #: A decode failure has already been reported. A model that cannot
        #: decode fails on EVERY phrase; one honest error is the signal, a
        #: hundred is noise -- but silence would look like nobody spoke.
        self.decode_error_reported: bool = False
        #: Phrases still to arrive before the next whole-recording re-cluster.
        #: Adaptive: re-clustering is the engine's only heavy step and it grows
        #: with the meeting, so the interval grows with how long the last pass
        #: took (see :func:`relabel_interval`).
        self.relabel_countdown: int = RELABEL_EVERY_SEGMENTS

        self.segments_since_flush: int = 0
        #: Mixed-timeline length at the last flush -- the time-based flush
        #: trigger (audio must persist even when no segments land to count).
        #: Resumed base audio is already durable in the stored WAV, so
        #: checkpoints must cover only samples recorded after resume.
        self.flushed_samples: int = base
        #: ``time.monotonic()`` of the last failed save, so a persistent
        #: failure is retried -- and reported -- at a human rate rather than
        #: four times a second. ``None`` once a save lands.
        self.flush_failed_at: float | None = None
        self.last_level_emit: float = time.monotonic()
        #: Watchdog: when the last microphone batch arrived. The tap can die
        #: without a sound -- worklet error, throttled page, revoked device --
        #: and silence-on-purpose still SENDS frames, so "no pushes" is the
        #: reliable dead-mic signal.
        self.last_mic_push: float = time.monotonic()
        self.mic_flagged: bool = False
        #: Has ANY microphone batch arrived this session? A mic that never
        #: connected needs different advice from one that connected and died.
        self.mic_ever_pushed: bool = False
        #: Sub-window prints per live segment id, collected from the decode
        #: worker for the stop/pause split pass (ADD-28). Segments not in here
        #: -- resumed history, pieces of an earlier split -- are re-embedded
        #: from the mixed timeline when the pass runs.
        self.win_cache: dict[str, list[tuple[int, int, VoicePrint]]] = {}

        # RecShared-equivalent plain attributes (see the module docstring) --
        # no lock: nothing else runs on a separate OS thread that could race.
        #: "recording" | "paused" | "saving" | "saved" | "failed". The last two
        #: are terminal.
        self.status: str = "recording"
        self.duration_cs: int = cs_of_samples(base)
        #: Latest per-source health, [mic, sys]: ("on" | "error" | "off",
        #: human message). Kept HERE so a status read can answer at any time --
        #: the rec-source events alone are lost on a viewer that mounts after a
        #: fast failure, which is exactly when the user most needs the banner.
        self.sources: list[tuple[str, str]] = [("on", ""), ("off", "")]
        self.outcome: EngineOutcome | None = None

        self.translate_tx = LiveTranslateQueue()
        #: Inbound message queue (Rust's ``mpsc::Receiver<EngineMsg>``).
        self.inbox: "asyncio.Queue[EngineMsg]" = asyncio.Queue()
        #: :meth:`run` has returned -- nobody drains :attr:`inbox` any more.
        #: Rust gets this for free (the engine THREAD ends, dropping the
        #: `mpsc::Receiver`); here it has to be a flag. See
        #: :meth:`_answer_orphan`.
        self._ended: bool = False
        self._job_queue: "asyncio.Queue[DecodeJob]" = asyncio.Queue()
        self._background_tasks: list["asyncio.Task[None]"] = []
        # Message routing is data rather than a long branch chain so `handle`
        # remains the small, single entry point for engine state mutations.
        # Every handler preserves the corresponding Rust message arm's order.
        self._message_handlers: dict[type[object], Callable[..., Awaitable[None]]] = {
            MsgAudio: self._handle_audio,
            MsgSysTapResult: self._handle_sys_tap_result,
            MsgSetLiveTranslate: self._handle_live_translate,
            MsgSetLiveStt: self._handle_live_stt,
            MsgPause: self._handle_pause,
            MsgResume: self._handle_resume,
            MsgStop: self._handle_stop,
            MsgEditMeta: self._handle_edit_meta,
            MsgDecodeDone: self._handle_decode_done,
        }

    # ------------------------------------------------------------- the timeline

async def create_engine(cfg: EngineConfig, ports: EnginePorts) -> Engine:
    """The ``start_engine``-equivalent factory: builds the :class:`Engine` (the
    synchronous setup ``Engine::new`` did) and spawns its two background
    ``asyncio.Task``s -- the decode worker and the live-translate worker. Must
    run inside a live event loop; that is the whole reason this is a factory
    and not the constructor (see the module docstring's threading-model
    section).

    An ``Engine`` built with the plain constructor instead is fully usable for
    everything that does not need a real decode -- ``handle()``/``tick()``/
    ``flush()`` all work -- but a job dispatched with no decode worker running
    simply sits in the queue with ``decode_busy`` set, which is what a test
    that feeds :class:`MsgDecodeDone` by hand wants anyway.
    """
    engine = Engine(cfg, ports)
    engine._background_tasks.append(asyncio.create_task(engine._decode_worker()))
    engine._background_tasks.append(
        spawn_live_translator(
            ports, cfg.file_id, cfg.default_translation_model, engine.translate_tx
        )
    )
    return engine
