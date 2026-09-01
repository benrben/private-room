"""Offline retranscription request validation and streaming."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Callable

import numpy as np
from fastapi import Request
from fastapi.responses import JSONResponse

from arcelle_sidecar.diar.recognize import KnownVoice
from arcelle_sidecar.media.decode import MediaKind
from arcelle_sidecar.messages import compact_json
from arcelle_sidecar.rec.engine import RetranscribeStopped
from arcelle_sidecar.rec.meta import RecCut, RecMeta, cs_of_samples
from arcelle_sidecar.rec.session_models import RetranscribeRequest

log = logging.getLogger("arcelle_sidecar.rec.session_ws")


def _facade_module() -> Any:
    from arcelle_sidecar.rec import session_ws

    return session_ws


def _ndjson_line(event: dict[str, Any]) -> bytes:
    """One NDJSON stream line, the shape ``server.py``'s streaming routes use."""
    return (compact_json(event) + "\n").encode("utf-8")


def _staged_media_path(raw: str) -> Path | None:
    """The host-staged media file `raw` names, or ``None`` when it is refused.

    The SAME rule ``/stt/transcribe_file`` applies, deliberately duplicated
    rather than loosened: the authenticated Electron host decrypts a room file
    into a private ``arcelle-stt-*`` directory directly under the OS temp root
    and deletes it after the call, so the resolved path's parent must be such
    a directory and its grandparent must be the temp root itself. Refusing
    every other path is what keeps this local endpoint from becoming a generic
    file reader if the process token were ever disclosed -- and this route is
    the more attractive of the two to point somewhere else, since it hands
    back a whole transcript.

    ``resolve()`` runs before the check, so ``..`` cannot walk out of the
    staging directory and back in. A path the OS cannot even resolve (an
    embedded NUL) is a refusal, not a 500 -- ``/stt/transcribe_file`` lets
    that one raise, which is a difference in blast radius only.
    """
    try:
        staged = Path(raw).resolve()
    except (OSError, ValueError):
        return None
    temp_root = Path(tempfile.gettempdir()).resolve()
    if staged.parent.parent != temp_root or not staged.parent.name.startswith("arcelle-stt-"):
        return None
    return staged


#: Suffixes whose audio has to be lifted out of a video container (avconvert)
#: before the audio decoder can read it. Deliberately generous: guessing VIDEO
#: for a file that turns out to be plain audio still decodes correctly, while
#: guessing AUDIO for a real video is how a whole meeting recording decodes to
#: "no readable audio track". The list mirrors what the host's own media viewer
#: is willing to open; a caller that KNOWS may send ``kind`` and skip the guess.
_VIDEO_SUFFIXES: frozenset[str] = frozenset(
    {
        ".mp4", ".m4v", ".mov", ".qt", ".mkv", ".webm", ".avi", ".wmv", ".flv",
        ".mpg", ".mpeg", ".m2v", ".ts", ".mts", ".m2ts", ".3gp", ".3g2", ".ogv",
    }
)


def _media_kind_for(staged: Path, declared: str | None) -> MediaKind | None:
    """Which of ``decode_to_pcm``'s two paths this file needs.

    ``declared`` wins when the caller sent one -- it knows the room file's real
    type, which a suffix only approximates. ``None`` means "you work it out",
    and the suffix is all this process has to work with: the sidecar never sees
    the room's file table. Returns ``None`` for a ``kind`` that is neither
    word, which the route turns into a refusal: silently reading an unknown
    value as "audio" is exactly the coercion that would make a video rebuild
    fail for a reason nobody could see.
    """
    if declared is not None:
        if declared == "video":
            return MediaKind.VIDEO
        if declared == "audio":
            return MediaKind.AUDIO
        return None
    return MediaKind.VIDEO if staged.suffix.lower() in _VIDEO_SUFFIXES else MediaKind.AUDIO


def _retranscribe_refused(message: str) -> JSONResponse:
    """A rebuild refused BEFORE the stream starts: a 400 with the ``{"error",
    "code"}`` body every other ``/rec/*`` route answers with.

    The body also carries ``"kind": "error"`` so it is simultaneously a valid
    single-line NDJSON error event. That is not decoration: the caller streams
    this endpoint, and without it a refusal would need a second, differently
    shaped parser on the host side for exactly the failures that are easiest
    to hit while wiring the thing up.
    """
    return JSONResponse(
        {"kind": "error", "code": "REC_BAD_REQUEST", "error": message}, status_code=400
    )


def _swallow_outcome(task: "asyncio.Future[Any]") -> None:
    """Consume an abandoned rebuild's result so asyncio does not log an
    'exception was never retrieved' for a task we deliberately gave up on."""
    with contextlib.suppress(Exception, asyncio.CancelledError):
        task.result()


@dataclass(frozen=True)
class _RetranscribeJob:
    staged: Path
    model_path: Path
    media_kind: MediaKind
    prior: RecMeta
    known: list[KnownVoice]
    diarize_path: str | None


def _resolved_model_path(raw: str) -> Path | None:
    try:
        return Path(raw).resolve()
    except (OSError, ValueError):
        return None


def _inputs_exist(staged: Path, model_path: Path) -> bool:
    return staged.is_file() and model_path.is_file()


def _retranscribe_settings(
    req: RetranscribeRequest, staged: Path
) -> tuple[MediaKind, str | None] | str:
    if req.max_speakers < 0:
        return "maxSpeakers must be 0 (discover) or a positive count"
    media_kind = _media_kind_for(staged, req.kind)
    if media_kind is None:
        return 'kind must be "audio", "video", or omitted'
    return media_kind, req.diarize_model_path or None


def _retranscribe_prior(req: RetranscribeRequest) -> RecMeta:
    prior = req.prior
    if prior is None:
        return RecMeta(max_speakers=req.max_speakers)
    return RecMeta(
        max_speakers=req.max_speakers,
        speaker_names=dict(prior.speaker_names),
        recognized=set(prior.recognized),
        cuts=[RecCut(t0=cut.t0, t1=cut.t1) for cut in prior.cuts],
    )


def _known_retranscribe_voices(req: RetranscribeRequest) -> list[KnownVoice]:
    return [voice.to_known_voice() for voice in req.known_voices]


def _retranscribe_job(req: RetranscribeRequest) -> _RetranscribeJob | str:
    staged = _staged_media_path(req.file_path)
    if staged is None:
        return "the staged audio path was refused"
    model_path = _resolved_model_path(req.model_path)
    if model_path is None:
        return "the speech model path was refused"
    if not _inputs_exist(staged, model_path):
        return "the audio file or speech model is missing"
    settings = _retranscribe_settings(req, staged)
    if isinstance(settings, str):
        return settings
    media_kind, diarize_path = settings
    return _RetranscribeJob(
        staged=staged,
        model_path=model_path,
        media_kind=media_kind,
        prior=_retranscribe_prior(req),
        known=_known_retranscribe_voices(req),
        diarize_path=diarize_path,
    )


def _drain_retranscribe_progress(
    updates: "asyncio.Queue[tuple[int, int]]"
) -> list[bytes]:
    lines: list[bytes] = []
    while not updates.empty():
        done_cs, total_cs = updates.get_nowait()
        lines.append(
            _ndjson_line({"kind": "progress", "doneCs": done_cs, "totalCs": total_cs})
        )
    return lines


async def _decode_retranscribe_input(job: _RetranscribeJob) -> tuple[np.ndarray | None, bytes | None]:
    try:
        samples = await asyncio.to_thread(_facade_module().decode_to_pcm, job.staged, job.media_kind)
    except (OSError, RuntimeError, ValueError) as exc:
        return None, _ndjson_line(
            {"kind": "error", "code": "REC_DECODE_FAILED", "error": str(exc)}
        )
    return samples, None


def _start_retranscription(
    job: _RetranscribeJob,
    samples: np.ndarray,
    on_progress: Callable[[int, int], None],
    should_stop: Callable[[], bool],
) -> "asyncio.Future[RecMeta]":
    return asyncio.ensure_future(
        asyncio.to_thread(
            _facade_module().retranscribe,
            str(job.model_path),
            samples,
            job.prior,
            job.known,
            job.diarize_path,
            on_progress,
            should_stop,
        )
    )


async def _stream_retranscribe_progress(
    work: "asyncio.Future[RecMeta]",
    updates: "asyncio.Queue[tuple[int, int]]",
    request: Request,
    stop_flag: threading.Event,
) -> AsyncIterator[bytes]:
    while True:
        done, _pending = await asyncio.wait({work}, timeout=_facade_module().RETRANSCRIBE_POLL_SECS)
        for line in _drain_retranscribe_progress(updates):
            yield line
        if done:
            return
        if await request.is_disconnected():
            stop_flag.set()


async def _retranscribe_terminal_line(
    work: "asyncio.Future[RecMeta]", diarize_path: str | None
) -> bytes:
    try:
        meta = work.result()
    except RetranscribeStopped:
        return _ndjson_line({"kind": "stopped"})
    except Exception as exc:  # noqa: BLE001 -- `retranscribe`'s RuntimeError
        log.exception("rec/retranscribe: the rebuild failed")
        return _ndjson_line(
            {"kind": "error", "code": "REC_RETRANSCRIBE_FAILED", "error": str(exc)}
        )
    neural = await asyncio.to_thread(_facade_module().neural_ready, diarize_path or "")
    return _ndjson_line({"kind": "done", "meta": meta.to_dict(), "neural": neural})


def _cancel_retranscription(
    stop_flag: threading.Event, work: "asyncio.Future[RecMeta] | None"
) -> None:
    stop_flag.set()
    if work is not None and not work.done():
        work.cancel()
        work.add_done_callback(_swallow_outcome)


async def _retranscribe_stream(
    request: Request, job: _RetranscribeJob
) -> AsyncIterator[bytes]:
    loop = asyncio.get_running_loop()
    updates: "asyncio.Queue[tuple[int, int]]" = asyncio.Queue()
    # Read by the worker thread, set by this coroutine -- hence a threading.Event
    # and not an asyncio one.
    stop_flag = threading.Event()

    def on_progress(done_cs: int, total_cs: int) -> None:
        # Runs ON THE WORKER THREAD and must never raise: a closed event loop has
        # nowhere to receive this optional progress line, but must not discard a
        # successful rebuild.
        with contextlib.suppress(RuntimeError):
            loop.call_soon_threadsafe(updates.put_nowait, (done_cs, total_cs))

    def should_stop() -> bool:
        return stop_flag.is_set()

    work: "asyncio.Future[RecMeta] | None" = None
    try:
        samples, decode_error = await _decode_retranscribe_input(job)
        if decode_error is not None:
            yield decode_error
            return
        assert samples is not None
        yield _ndjson_line(
            {"kind": "progress", "doneCs": 0, "totalCs": cs_of_samples(len(samples))}
        )
        work = _start_retranscription(job, samples, on_progress, should_stop)
        async for line in _stream_retranscribe_progress(work, updates, request, stop_flag):
            yield line
        yield await _retranscribe_terminal_line(work, job.diarize_path)
    finally:
        _cancel_retranscription(stop_flag, work)
