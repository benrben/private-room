"""Streaming dictation capture and session transport.

The module keeps the Rust capture semantics: one native-rate buffer, periodic
whole-buffer partial decoding, a bounded leak guard, and one final decode on
Stop.  Text shaping lives in :mod:`dictation_shape`; this module remains the
public facade for its constants, seams, and helpers.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import struct
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from arcelle_sidecar.media.wav import resample_to_16k
from arcelle_sidecar.messages import compact_json
from arcelle_sidecar.stt import engine as stt_engine
from arcelle_sidecar.stt.dictation_shape import (
    DICT_PROMPT_OPTIMIZER as DICT_PROMPT_OPTIMIZER,
    DICT_REWRITE as DICT_REWRITE,
    DICT_TAIL as DICT_TAIL,
    DICT_TRANSLATE as DICT_TRANSLATE,
    LocalModelHooks as LocalModelHooks,
    ShapeResult as ShapeResult,
    dict_mode_guidance as dict_mode_guidance,
    dict_pass_text as dict_pass_text,
    run_dict_pass as run_dict_pass,
    shape_text as shape_text,
)

log = logging.getLogger("arcelle_sidecar.stt.dictation")


# =============================================================================
# ---- repaint cadence + the leak guard (stt_cmds.rs:499-521) ------------------
# =============================================================================

#: ~0.7 s of fresh audio between partial repaints: short enough to feel live,
#: long enough that each repaint (a whole-buffer redecode — the partial IS the
#: full text so far) outpaces the microphone on Metal. The FLOOR, not the step:
#: see :func:`dict_partial_step`.
DICT_PARTIAL_STEP_SECS: float = 0.7

#: Leak guard, not a UX limit: audio past this is dropped (10 min of speech in
#: one dictation is a stuck mic, not a user). Read as a bare module-level name
#: inside :meth:`_NativeBuffer.extend` on purpose — never captured into a local
#: at import time — so a test can ``monkeypatch.setattr`` it down and have a
#: RUNNING worker honour the new value.
DICT_MAX_SECS: int = 600


def dict_partial_step(rate: int, last_decode_secs: float) -> int:
    """How much fresh audio (in samples at ``rate``) must arrive before the
    next preview repaint.

    Each repaint re-decodes the dictation FROM THE START, so its cost grows
    with how long the person has been speaking. At a fixed 0.7 s step a
    minutes-long dictation spends every spare cycle redecoding, the Mac runs
    hot, and the preview falls further and further behind anyway. Requiring at
    least as much new audio as the last decode consumed holds the decoder to
    roughly half the machine: the preview updates less often as the dictation
    grows, but it stops losing ground. The final text is unaffected — that is
    one whole-utterance decode at Stop. (stt_cmds.rs ``dict_partial_step``.)
    """
    base = int(rate * DICT_PARTIAL_STEP_SECS)
    return max(base, int(rate * last_decode_secs))


class _NativeBuffer:
    """The worker's growing audio buffer, at the sender's native rate — Rust's
    ``Vec<f32> native`` plus its leak guard (``if native.len() < rate as usize
    * DICT_MAX_SECS { native.extend(samples) }``, stt_cmds.rs:641).

    The gate is a boolean "is the buffer ALREADY at the cap?" asked BEFORE the
    message, never a trim: a message that straddles the cap is accepted whole
    (so the buffer may end up one chunk over), and every message after that is
    dropped whole. Deliberately identical to the Rust source, overshoot
    included.

    Chunks are concatenated lazily and collapsed in place on :meth:`array`, so
    an incoming message never pays for a full-buffer copy — only a decode does,
    exactly as expensive as Rust's own ``&native`` slice read.
    """

    def __init__(self) -> None:
        self._chunks: list[np.ndarray] = []
        self._len = 0

    def __len__(self) -> int:
        return self._len

    def extend(self, samples: np.ndarray, rate: int) -> None:
        if self._len < rate * DICT_MAX_SECS:
            self._chunks.append(np.asarray(samples, dtype=np.float32))
            self._len += len(samples)

    def array(self) -> np.ndarray:
        if not self._chunks:
            return np.zeros(0, dtype=np.float32)
        if len(self._chunks) > 1:
            self._chunks = [np.concatenate(self._chunks)]
        return self._chunks[0]


# =============================================================================
# ---- Stop's wait — the CALLER's, not ours (stt_cmds.rs:566-581) --------------
# =============================================================================

#: The wait a caller should allow the final decode before concluding it is
#: wedged. Covers a short dictation merely queued behind a busy STT context.
DICT_STOP_BASE: float = 120.0
#: Seconds of grace per second of audio — a decode slower than this is wedged,
#: not working. Rust's ``u32``; an int here for the same reason.
DICT_STOP_PER_AUDIO_SEC: int = 2


def dict_stop_timeout(captured_secs: float) -> float:
    """The wait a CALLER (Electron main) should allow ``stop``'s answer, given
    how many seconds of audio it pushed.

    The final decode is ONE whole-utterance pass over everything spoken, so its
    cost grows with the dictation while a flat ceiling does not: at 120 s flat,
    stopping a several-minute dictation threw away a transcript that was still
    being produced. Exported pure for the caller to reuse verbatim; see the
    module docstring §4 for why this module does not apply it to itself.
    """
    return DICT_STOP_BASE + captured_secs * DICT_STOP_PER_AUDIO_SEC


# =============================================================================
# ---- the /dict/session frame protocol ----------------------------------------
# =============================================================================

#: rate, n — 8 bytes, little-endian. See the module docstring §1.
_AUDIO_HEADER_STRUCT = struct.Struct("<II")


@dataclass
class _MsgAudio:
    rate: int
    samples: np.ndarray


class _MsgStop:
    """Sentinel. Unlike Rust's ``DictMsg::Stop { done: Sender<…> }`` it carries
    no reply channel: the worker answers over the websocket itself, so nothing
    outside the worker is ever left waiting on it."""


def _decode_audio_frame(data: bytes) -> tuple[int, np.ndarray] | None:
    """Parse one binary ``/dict/session`` frame. ``None`` for anything
    malformed; never raises."""
    if len(data) < _AUDIO_HEADER_STRUCT.size:
        return None
    rate, n = _AUDIO_HEADER_STRUCT.unpack_from(data, 0)
    if len(data) != _AUDIO_HEADER_STRUCT.size + n * 4:
        return None
    samples = np.frombuffer(data, dtype="<f4", count=n, offset=_AUDIO_HEADER_STRUCT.size)
    return int(rate), samples.astype(np.float32, copy=True)


def _handle_audio_frame(queue: "asyncio.Queue", data: bytes) -> None:
    try:
        decoded = _decode_audio_frame(data)
    except Exception:  # noqa: BLE001 - a bad frame must never kill the socket
        log.warning("dict/session: could not parse a binary audio frame", exc_info=True)
        return
    if decoded is None:
        log.warning("dict/session: dropped a malformed binary audio frame (%d bytes)", len(data))
        return
    rate, samples = decoded
    queue.put_nowait(_MsgAudio(rate=rate, samples=samples))


def _handle_control_text(queue: "asyncio.Queue", text: str) -> bool:
    """Apply one control text frame. Returns True when the connection should
    end NOW without a final decode (``cancel``).

    ``stop`` deliberately returns False: the worker owns the answer and the
    close, and ending the receive loop here would run the route's teardown —
    cancelling the worker — before it could finalize.
    """
    try:
        parsed = json.loads(text)
    except Exception:  # noqa: BLE001 - a bad control frame must never kill the socket
        log.warning("dict/session: dropped a malformed control text frame")
        return False
    if not isinstance(parsed, dict):
        return False
    msg_type = parsed.get("type")
    if msg_type == "stop":
        queue.put_nowait(_MsgStop())
        return False
    if msg_type == "cancel":
        return True
    log.debug("dict/session: ignoring unknown control message type %r", msg_type)
    return False


async def _send_json(websocket: WebSocket, payload: dict) -> None:
    """Best-effort: a send that fails (the caller already gave up and went
    away) is never this module's own error."""
    with contextlib.suppress(Exception):
        await websocket.send_text(compact_json(payload))


@dataclass
class _DictWorkerState:
    buffer: _NativeBuffer = field(default_factory=_NativeBuffer)
    rate: int = 16000
    decoded_len: int = 0
    last_text: str = ""
    last_decode_secs: float = 0.0


async def _finalize_dictation(
    websocket: WebSocket, model_path: str, state: _DictWorkerState
) -> None:
    """Decode and send the one terminal result, including any failure."""
    try:
        pcm = resample_to_16k(state.buffer.array(), state.rate)
        text = await asyncio.to_thread(stt_engine.transcribe, model_path, pcm, False)
    except Exception as exc:  # noqa: BLE001 - reported over the wire, never raised
        log.warning("dict/session: the final decode failed", exc_info=True)
        payload = {"type": "final", "ok": False, "error": str(exc)}
    else:
        payload = {"type": "final", "ok": True, "text": text}
    await _send_json(websocket, payload)
    with contextlib.suppress(Exception):
        await websocket.close()


def _append_dictation_audio(state: _DictWorkerState, message: _MsgAudio) -> None:
    state.rate = message.rate
    state.buffer.extend(message.samples, state.rate)


def _drain_dictation_queue(
    queue: "asyncio.Queue[_MsgAudio | _MsgStop]", state: _DictWorkerState
) -> bool:
    """Add queued audio in order, stopping only when the sentinel is found."""
    while True:
        try:
            message = queue.get_nowait()
        except asyncio.QueueEmpty:
            return False
        if isinstance(message, _MsgStop):
            return True
        _append_dictation_audio(state, message)


async def _send_dictation_partial(
    websocket: WebSocket, model_path: str, state: _DictWorkerState
) -> None:
    if len(state.buffer) - state.decoded_len < dict_partial_step(
        state.rate, state.last_decode_secs
    ):
        return
    state.decoded_len = len(state.buffer)
    began = time.monotonic()
    try:
        pcm = resample_to_16k(state.buffer.array(), state.rate)
        decoded = await asyncio.to_thread(stt_engine.transcribe, model_path, pcm, False)
    except Exception:  # noqa: BLE001 - partial failures are cosmetic
        log.warning("dict/session: a partial decode failed", exc_info=True)
        decoded = None
    state.last_decode_secs = time.monotonic() - began
    if decoded is not None and decoded != state.last_text:
        state.last_text = decoded
        await _send_json(websocket, {"type": "partial", "text": decoded})


async def _dict_worker(
    websocket: WebSocket, model_path: str, queue: "asyncio.Queue[_MsgAudio | _MsgStop]"
) -> None:
    """Run one socket's ordered dictation queue and own every socket write."""
    state = _DictWorkerState()

    while True:
        msg = await queue.get()
        if isinstance(msg, _MsgStop):
            await _finalize_dictation(websocket, model_path, state)
            return
        _append_dictation_audio(state, msg)
        if _drain_dictation_queue(queue, state):
            await _finalize_dictation(websocket, model_path, state)
            return
        await _send_dictation_partial(websocket, model_path, state)


# =============================================================================
# ---- the single-session slot + route registration ----------------------------
# =============================================================================


@dataclass
class LiveDictSession:
    """One live dictation — Rust's ``DictSession``, minus the ``captured_ms``
    counter, which existed only so ``dict_stop`` could size its own wait (see
    the module docstring §4: that wait is now the caller's)."""

    websocket: WebSocket
    queue: "asyncio.Queue[_MsgAudio | _MsgStop]"
    worker: "asyncio.Task[None]"

    async def stop_worker(self) -> None:
        """Cancel the worker and wait for it to be gone. Awaiting is safe even
        mid-decode: cancelling a task parked on ``asyncio.to_thread`` returns
        at once (the orphaned thread finishes into nobody's hands), so this
        cannot block on a whole-utterance decode."""
        self.worker.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await self.worker

    async def supersede(self) -> None:
        """A second ``/dict/session`` replaced this one. NO final decode runs
        (``dict_cancel``'s contract, not ``dict_stop``'s): whoever was replaced
        hears nothing back, exactly like the old Tauri session whose sender was
        simply dropped — except the socket is closed rather than left to work
        it out."""
        await self.stop_worker()
        with contextlib.suppress(Exception):
            await self.websocket.close(code=4409)


class DictSessionManager:
    """The single-live-dictation slot — Rust's ``DictState``. Per APP
    (``app.state.dict_manager``), never a module global; see the module
    docstring §2 for that and for why a second session REPLACES rather than
    being refused."""

    def __init__(self) -> None:
        self.current: LiveDictSession | None = None

    async def replace(self, session: LiveDictSession) -> None:
        old, self.current = self.current, session
        if old is not None:
            await old.supersede()

    def clear(self, session: LiveDictSession) -> None:
        """Free the slot, but only if it still holds THIS session — a session
        that was already superseded must not clear its replacement's slot."""
        if self.current is session:
            self.current = None


async def _accept_dictation_session(websocket: WebSocket) -> str | None:
    """Accept a session only after its model file passes the safety check."""
    model_path = websocket.query_params.get("modelPath") or ""
    if model_path and Path(model_path).is_file():
        await websocket.accept()
        return model_path
    # Rust's `STT_MODEL_MISSING`. A rejected WS handshake has no JSON body to
    # carry that in, so the close code is the whole signal — and this refusal
    # keeps a decode against a deleted model from aborting the process.
    await websocket.close(code=4404, reason="STT_MODEL_MISSING")
    return None


def _new_live_dict_session(websocket: WebSocket, model_path: str) -> LiveDictSession:
    """Create the queue and single writer task for one accepted socket."""
    queue: asyncio.Queue[_MsgAudio | _MsgStop] = asyncio.Queue()
    worker = asyncio.create_task(_dict_worker(websocket, model_path, queue))
    return LiveDictSession(websocket=websocket, queue=queue, worker=worker)


def _dictation_message_ends_session(
    message: dict, queue: "asyncio.Queue[_MsgAudio | _MsgStop]"
) -> bool:
    """Dispatch one received frame and say whether it cancels the session."""
    if message["type"] == "websocket.disconnect":
        return True
    data = message.get("bytes")
    if data is not None:
        _handle_audio_frame(queue, data)
        return False
    text = message.get("text")
    return text is not None and _handle_control_text(queue, text)


async def _receive_dictation_messages(
    websocket: WebSocket, queue: "asyncio.Queue[_MsgAudio | _MsgStop]"
) -> None:
    """Read until the peer disconnects or explicitly cancels the session."""
    try:
        while True:
            if _dictation_message_ends_session(await websocket.receive(), queue):
                return
    except WebSocketDisconnect:
        return


async def _close_dictation_session(
    manager: DictSessionManager, session: LiveDictSession
) -> None:
    """Release the slot, cancel its writer, and leave no live socket behind."""
    manager.clear(session)
    await session.stop_worker()
    # The session is over however we got here, so leave no socket dangling for
    # a client to keep pushing audio into. Both other exits already closed it —
    # the worker after `stop`, the client itself on a disconnect — and closing
    # twice is a no-op.
    with contextlib.suppress(Exception):
        await session.websocket.close()


def register_dict_routes(app: FastAPI) -> DictSessionManager:
    """Mount the dictation WebSocket surface onto the sidecar's existing
    FastAPI app. Called once from ``server.create_app``.

    Auth is NOT re-implemented here: ``/dict/session`` rides
    ``TokenAuthMiddleware``'s ``?token=`` websocket branch, exactly like
    ``/rec/session`` (see the module docstring §2).

    Returns the :class:`DictSessionManager` — also stashed on
    ``app.state.dict_manager`` — so a caller (chiefly a test) can see the live
    session without a second, parallel way to reach it.
    """
    manager = DictSessionManager()
    app.state.dict_manager = manager

    @app.websocket("/dict/session")
    async def dict_session_ws(websocket: WebSocket) -> None:
        model_path = await _accept_dictation_session(websocket)
        if model_path is None:
            return
        session = _new_live_dict_session(websocket, model_path)
        await manager.replace(session)
        try:
            await _receive_dictation_messages(websocket, session.queue)
        finally:
            await _close_dictation_session(manager, session)

    return manager


__all__ = [
    "DICT_MAX_SECS",
    "DICT_PARTIAL_STEP_SECS",
    "DICT_PROMPT_OPTIMIZER",
    "DICT_REWRITE",
    "DICT_STOP_BASE",
    "DICT_STOP_PER_AUDIO_SEC",
    "DICT_TAIL",
    "DICT_TRANSLATE",
    "DictSessionManager",
    "LiveDictSession",
    "LocalModelHooks",
    "ShapeResult",
    "dict_mode_guidance",
    "dict_partial_step",
    "dict_pass_text",
    "dict_stop_timeout",
    "register_dict_routes",
    "run_dict_pass",
    "shape_text",
]
