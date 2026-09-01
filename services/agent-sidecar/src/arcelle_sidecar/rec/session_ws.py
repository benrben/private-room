"""HTTP and WebSocket transport for recording and retranscription."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse

from arcelle_sidecar import llm as llm
from arcelle_sidecar.diar.embed import neural_ready as neural_ready
from arcelle_sidecar.media.decode import MediaKind as MediaKind, decode_to_pcm as decode_to_pcm
from arcelle_sidecar.rec.engine import Engine, EngineConfig, EngineOutcome, MsgAudio, MsgEditMeta, MsgPause, MsgResume, MsgSetLiveStt, MsgSetLiveTranslate, MsgStop, MsgSysTapResult, create_engine, retranscribe as retranscribe
from arcelle_sidecar.rec.lanes import Source
from arcelle_sidecar.rec.meta import RecMeta
from arcelle_sidecar.rec.session_models import DEFAULT_OLLAMA_BASE_URL as DEFAULT_OLLAMA_BASE_URL, EDIT_APPLY_BUILDERS as EDIT_APPLY_BUILDERS, CutIn as CutIn, EditMetaRequest as EditMetaRequest, FileIdBody as FileIdBody, KnownVoiceIn as KnownVoiceIn, PriorNamingIn as PriorNamingIn, RetranscribeRequest as RetranscribeRequest, SetLiveSttBody as SetLiveSttBody, SetLiveTranslateBody as SetLiveTranslateBody, StartSessionRequest as StartSessionRequest, _CamelModel as _CamelModel, _add_chapter_apply as _add_chapter_apply, _add_highlight_apply as _add_highlight_apply, _add_note_apply as _add_note_apply, _apply_add_chapter as _apply_add_chapter, _apply_add_highlight as _apply_add_highlight, _apply_add_note as _apply_add_note, _apply_delete_item as _apply_delete_item, _apply_rename_speaker as _apply_rename_speaker, _apply_set_chapter as _apply_set_chapter, _apply_set_note as _apply_set_note, _at_time as _at_time, _build_apply as _build_apply, _clean as _clean, _decode_base_samples as _decode_base_samples, _deletable_meta_items as _deletable_meta_items, _delete_item_apply as _delete_item_apply, _engine_config as _engine_config, _remove_meta_item as _remove_meta_item, _rename_speaker_apply as _rename_speaker_apply, _rename_speaker_refusal as _rename_speaker_refusal, _replace_speaker_name as _replace_speaker_name, _set_chapter_apply as _set_chapter_apply, _set_note_apply as _set_note_apply
from arcelle_sidecar.rec.session_ports import SpoolWriter as SpoolWriter, WsEnginePorts as WsEnginePorts, _HOST_GONE as _HOST_GONE, _HostLink as _HostLink, _PersistSpoolData as _PersistSpoolData, _append_persist_spool_data as _append_persist_spool_data, _checkpoint_spool_data as _checkpoint_spool_data, _connected_host_socket as _connected_host_socket, _full_spool_data as _full_spool_data, _map_event as _map_event, _persist_message as _persist_message, _persist_spool_data as _persist_spool_data, _persist_with_rollback as _persist_with_rollback, _raise_for_host_ack as _raise_for_host_ack, _send_host_request as _send_host_request, _wait_for_host_ack as _wait_for_host_ack
from arcelle_sidecar.rec.session_retranscribe import _RetranscribeJob as _RetranscribeJob, _VIDEO_SUFFIXES as _VIDEO_SUFFIXES, _cancel_retranscription as _cancel_retranscription, _decode_retranscribe_input as _decode_retranscribe_input, _drain_retranscribe_progress as _drain_retranscribe_progress, _inputs_exist as _inputs_exist, _known_retranscribe_voices as _known_retranscribe_voices, _media_kind_for as _media_kind_for, _ndjson_line as _ndjson_line, _resolved_model_path as _resolved_model_path, _retranscribe_job as _retranscribe_job, _retranscribe_prior as _retranscribe_prior, _retranscribe_refused as _retranscribe_refused, _retranscribe_settings as _retranscribe_settings, _retranscribe_stream as _retranscribe_stream, _retranscribe_terminal_line as _retranscribe_terminal_line, _staged_media_path as _staged_media_path, _start_retranscription as _start_retranscription, _stream_retranscribe_progress as _stream_retranscribe_progress, _swallow_outcome as _swallow_outcome

log = logging.getLogger("arcelle_sidecar.rec.session_ws")

#: How long ``persist()`` waits for ONE acknowledgement over ``WS /rec/host``.
#: Comfortably past a real DB write (even a slow one through Electron's
#: encrypted store), far short of how long a user would sit wondering whether
#: the room is still saving. Not a connect timeout: a host that is not
#: connected fails immediately instead (see :meth:`_HostLink.call`).
PERSIST_TIMEOUT: float = 15.0

#: How long ``/rec/edit_meta`` waits for the engine to answer THIS request. Well
#: above the longest routine thing that can be queued in front of an edit (a
#: relabel/split pass), short enough that a wedged engine cannot hang a UI
#: action indefinitely. A timeout abandons the reply, never the edit: the engine
#: still applies it. Unlike ``/rec/stop`` there is no Rust "no deadline"
#: precedent here.
EDIT_META_TIMEOUT: float = 10.0

#: How often the streaming ``/rec/retranscribe`` rebuild looks up to ask
#: whether its caller is still on the line -- the same idiom as
#: ``server.until_hangup``, for the same reason (a rebuild is minutes of CPU
#: nobody will ever read once the caller is gone), deliberately looser than
#: that function's 0.25 s: it guards a model call holding the one resident
#: model slot, while this guards a job whose own unit of work -- one decoded
#: phrase -- is already about a second long. Also the granularity at which
#: queued progress lines are flushed.
RETRANSCRIBE_POLL_SECS: float = 1.0

#: The Rust source's own live-translation call shape (``recording.rs``'s
#: ``spawn_live_translator``), reused verbatim rather than re-derived.
_TRANSLATE_PROMPT = "Translate this into {lang}. Output ONLY the translation, nothing else.\n\n{text}"
_TRANSLATE_TEMPERATURE: float = 0.2
_TRANSLATE_KEEP_ALIVE: str = "5m"

#: This sidecar's normal default endpoint (``config.py``'s request models all
#: default ``base_url`` the same way). ``EngineConfig`` carries no base URL:
#: model RESOLUTION is Electron's job, but the endpoint to call is ours.
_GCM_NONCE_LEN: int = 12
_SPOOL_LEN_STRUCT = struct.Struct("<I")
#: lane, pad, seq, rate, n -- 12 bytes, little-endian (see §2).
_AUDIO_HEADER_STRUCT = struct.Struct("<BBHII")

#: Terminal recording statuses -- the ones that end the session (see §2's table).
_TERMINAL_STATES = frozenset({"saved", "failed"})

_EVENT_MAP: dict[str, str] = {
    "rec-level": "level",
    "rec-partial": "partial",
    "rec-segment": "final",
    "rec-segment-drop": "segment-drop",
    "rec-relabel": "relabel",
    "rec-save-progress": "save-status",
    "rec-source": "source-health",
    "rec-error": "error",
    "rec-live-translation": "live-translation",
}

#: The one Engine event that is NOT forwarded over ``/rec/session`` -- see §2.
_WHOLE_APP_EVENT: str = "room-files-changed"


# =============================================================================
# ---- request bodies (camelCase on the wire) ---------------------------------
#
# This module's own JSON convention, deliberately: it feeds (and is fed by)
# `Engine`'s emitted events and `RecMeta.to_dict()`/`from_dict()`, which are all
# camelCase already -- unlike the sidecar's older LLM-gateway bodies
# (`config.py`), which predate this migration and stayed snake_case to match
# their own Python call sites one for one.
# =============================================================================


# =============================================================================
# ---- the spool file ---------------------------------------------------------
# =============================================================================


# =============================================================================
# ---- the single-session slot -------------------------------------------------
# =============================================================================


class SessionAlreadyLive(Exception):
    """A second ``/rec/start`` arrived while one session is already live."""


@dataclass
class LiveSession:
    file_id: str
    engine: Engine
    ports: WsEnginePorts
    run_task: "asyncio.Task[EngineOutcome | None] | None" = None
    finalized: bool = False
    #: Reply futures a request is still blocked on, so teardown can answer them
    #: rather than leave an HTTP caller waiting for ever (see
    #: :meth:`RecSessionManager.finalize`).
    waiting: list["asyncio.Future[RecMeta]"] = field(default_factory=list)


class RecSessionManager:
    """The single-live-session slot -- Rust's ``RecState``, whose own comment
    says it: at most one recording is ever live at a time.

    Per APP (held on ``app.state.rec_manager``), not per process: a module
    global would make two ``create_app()`` instances share one recording, and
    bind any lock it used to whichever event loop touched it first."""

    def __init__(self) -> None:
        self.current: LiveSession | None = None
        self._lock = asyncio.Lock()

    async def start(self, cfg: EngineConfig, ports: WsEnginePorts) -> LiveSession:
        """Build and launch a session, or raise :class:`SessionAlreadyLive`.
        The lock spans the whole body, ``create_engine`` included, so two
        concurrent ``/rec/start`` calls cannot both find the slot empty."""
        async with self._lock:
            if self.current is not None and not self.current.finalized:
                raise SessionAlreadyLive()
            engine = await create_engine(cfg, ports)
            ports.bind_engine(engine)
            session = LiveSession(file_id=cfg.file_id, engine=engine, ports=ports)
            session.run_task = asyncio.create_task(self._drive(session))
            self.current = session
            return session

    async def _drive(self, session: LiveSession) -> EngineOutcome | None:
        """The engine's run loop as a background task, finalized however it
        ends. INCLUDING an end nobody asked for -- the 3-hour ceiling, the room
        closing under the recording -- which would otherwise leave the slot
        occupied and every later ``/rec/start`` answering 409 for ever."""
        try:
            return await session.engine.run()
        finally:
            await self.finalize(session)

    async def finalize(self, session: LiveSession) -> None:
        """Idempotent teardown: called from ``/rec/stop`` and from
        :meth:`_drive`'s ``finally``; whichever runs second is a no-op.
        Best-effort throughout -- the session is ending either way, and a
        failure closing a socket must not become the thing the user hears
        about."""
        # Startup uses this same lock. Keep the slot unavailable until its
        # spool and sockets are gone, otherwise an immediate same-file restart
        # can collide with the predecessor's still-existing O_EXCL spool.
        async with self._lock:
            if session.finalized:
                return
            session.finalized = True
            with contextlib.suppress(Exception):
                await session.engine.aclose()
            with contextlib.suppress(Exception):
                session.ports.spool.unlink()
            host_ws = session.ports.host.ws
            session.ports.host.detach()
            if host_ws is not None:
                with contextlib.suppress(Exception):
                    await host_ws.close()
            # `Engine.run` answers everything still in its inbox when its loop ends;
            # this catches the case where it could not -- a run task that died on an
            # unexpected error -- so an HTTP caller gets a failure instead of a
            # request that never returns.
            for fut in session.waiting:
                if not fut.done():
                    fut.set_exception(
                        RuntimeError("The recording engine stopped before it could save.")
                    )
            if self.current is session:
                self.current = None

    def for_file(self, file_id: str) -> LiveSession | None:
        session = self.current
        if session is None or session.finalized or session.file_id != file_id:
            return None
        return session


def _not_live() -> JSONResponse:
    return JSONResponse(
        {"error": "No live recording session for that file.", "code": "REC_NOT_LIVE"},
        status_code=404,
    )


def _start_config_or_error(req: StartSessionRequest) -> EngineConfig | JSONResponse:
    if not req.file_id or "/" in req.file_id or req.file_id in (".", ".."):
        return JSONResponse({"error": "invalid fileId", "code": "REC_BAD_REQUEST"}, status_code=400)
    try:
        return _engine_config(req)
    except Exception as exc:  # noqa: BLE001 -- a bad body is a 400, not a 500
        return JSONResponse(
            {"error": f"Bad /rec/start request: {exc}", "code": "REC_BAD_REQUEST"}, status_code=400
        )


def _create_start_spool(path: Path, key: bytes) -> SpoolWriter | JSONResponse:
    try:
        return SpoolWriter(path, key)
    except FileExistsError:
        # A previous, crashed session's spool is Electron's to recover from,
        # never ours to overwrite (see §5).
        return JSONResponse(
            {"error": "A spool file for this recording already exists.", "code": "REC_SPOOL_EXISTS"},
            status_code=409,
        )
    except OSError as exc:
        return JSONResponse(
            {"error": f"The spool file could not be created: {exc}", "code": "REC_SPOOL_FAILED"},
            status_code=500,
        )


async def _start_live_session(
    manager: RecSessionManager, cfg: EngineConfig, ports: WsEnginePorts, spool: SpoolWriter
) -> LiveSession | JSONResponse:
    try:
        return await manager.start(cfg, ports)
    except SessionAlreadyLive:
        spool.unlink()
        return JSONResponse(
            {"error": "A recording is already in progress.", "code": "REC_ALREADY_LIVE"}, status_code=409
        )
    except Exception as exc:  # noqa: BLE001 -- the engine could not be built
        # A failed start must not leave a spool that blocks every later start.
        spool.unlink()
        log.exception("rec/start: the recording engine could not be started")
        return JSONResponse(
            {"error": f"The recording could not be started: {exc}", "code": "REC_START_FAILED"},
            status_code=500,
        )


def _started_session_response(session: LiveSession, path: Path, key: bytes) -> dict[str, Any]:
    return {
        "ok": True,
        "fileId": session.file_id,
        "spoolKey": base64.b64encode(key).decode("ascii"),
        "spoolPath": str(path),
    }


# =============================================================================
# ---- the /rec/session frame protocol ----------------------------------------
# =============================================================================


def _decode_audio_frame(data: bytes) -> tuple[Source, int, np.ndarray] | None:
    """Parse one binary ``/rec/session`` frame (§2). ``None`` for anything
    malformed; never raises."""
    if len(data) < _AUDIO_HEADER_STRUCT.size:
        return None
    lane, _pad, _seq, rate, n = _AUDIO_HEADER_STRUCT.unpack_from(data, 0)
    if lane not in (0, 1):
        return None
    if len(data) != _AUDIO_HEADER_STRUCT.size + n * 4:
        return None
    samples = np.frombuffer(data, dtype="<f4", count=n, offset=_AUDIO_HEADER_STRUCT.size)
    source = Source.MIC if lane == 0 else Source.SYS
    return source, int(rate), samples.astype(np.float32, copy=True)


def _handle_audio_frame(engine: Engine, data: bytes) -> None:
    try:
        decoded = _decode_audio_frame(data)
    except Exception:  # noqa: BLE001 -- a bad frame must never kill the socket
        log.warning("rec/session: could not parse a binary audio frame", exc_info=True)
        return
    if decoded is None:
        log.warning("rec/session: dropped a malformed binary audio frame (%d bytes)", len(data))
        return
    source, rate, samples = decoded
    engine.send(MsgAudio(source=source, rate=rate, samples=samples))


def _handle_control_text(engine: Engine, text: str) -> None:
    try:
        parsed = json.loads(text)
    except Exception:  # noqa: BLE001 -- a bad control frame must never kill the socket
        log.warning("rec/session: dropped a malformed control text frame")
        return
    if not isinstance(parsed, dict):
        return
    if parsed.get("type") == "sys-tap-result":
        engine.send(MsgSysTapResult(ok=bool(parsed.get("ok")), error=parsed.get("error")))
    else:
        log.debug("rec/session: ignoring unknown control message type %r", parsed.get("type"))


async def _pump_session_socket(ws: Any, queue: "asyncio.Queue[str]") -> None:
    """Drain one attached socket's outgoing queue, IN ORDER, for as long as it
    stays open (see §2's delivery note). A send failure just ends the pump --
    the route's own receive loop notices the disconnect and detaches."""
    while True:
        line = await queue.get()
        try:
            await ws.send_text(line)
        except Exception:  # noqa: BLE001 -- best-effort, fire-and-forget delivery
            return


# =============================================================================
# ---- /rec/retranscribe helpers ----------------------------------------------
# =============================================================================


async def _attach_rec_host(
    manager: RecSessionManager, websocket: WebSocket
) -> _HostLink | None:
    session = manager.for_file(websocket.query_params.get("fileId") or "")
    if session is None:
        await websocket.close(code=4404)
        return None
    host = session.ports.host
    if host.ws is not None:
        await websocket.close(code=4409)
        return None
    await websocket.accept()
    if not host.attach(websocket):  # pragma: no cover - lost the race above
        await websocket.close(code=4409)
        return None
    return host


def _resolve_host_ack(host: _HostLink, text: str | None) -> None:
    if text is None:
        return
    try:
        ack = json.loads(text)
    except Exception:  # noqa: BLE001 -- a bad ack must never kill the socket
        log.warning("rec/host: dropped a malformed ack frame")
        return
    if isinstance(ack, dict):
        host.resolve(ack)


async def _receive_host_acks(websocket: WebSocket, host: _HostLink) -> None:
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return
        _resolve_host_ack(host, message.get("text"))


async def _attach_rec_session(
    manager: RecSessionManager, websocket: WebSocket
) -> LiveSession | None:
    session = manager.for_file(websocket.query_params.get("fileId") or "")
    if session is None:
        await websocket.close(code=4404)
        return None
    await websocket.accept()
    return session


def _handle_rec_session_message(engine: Engine, message: dict) -> None:
    data = message.get("bytes")
    if data is not None:
        _handle_audio_frame(engine, data)
        return
    text = message.get("text")
    if text is not None:
        _handle_control_text(engine, text)


async def _receive_rec_session_messages(websocket: WebSocket, engine: Engine) -> None:
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return
        _handle_rec_session_message(engine, message)


async def _detach_rec_session_socket(
    ports: WsEnginePorts, websocket: WebSocket, pump: "asyncio.Task[None]"
) -> None:
    ports.detach_session_socket(websocket)
    pump.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await pump


# =============================================================================
# ---- route registration -------------------------------------------------------
# =============================================================================


def register_rec_routes(app: FastAPI) -> RecSessionManager:
    """Mount the recording engine's HTTP + WebSocket surface onto the sidecar's
    existing FastAPI app. Called once from ``server.create_app``.

    Auth is NOT re-implemented here: the HTTP routes ride the existing
    ``Authorization`` header check and the two WebSocket routes ride
    ``TokenAuthMiddleware``'s ``?token=`` websocket branch (§6).

    Returns the :class:`RecSessionManager` -- also stashed on
    ``app.state.rec_manager`` -- so a caller (chiefly a test) can see the live
    session without a second, parallel way to reach it.
    """
    manager = RecSessionManager()
    app.state.rec_manager = manager

    @app.post("/rec/start")
    async def rec_start(req: StartSessionRequest) -> Any:
        cfg = _start_config_or_error(req)
        if isinstance(cfg, JSONResponse):
            return cfg
        spool_path = Path(req.spool_dir) / f"{req.file_id}.spool"
        key = AESGCM.generate_key(bit_length=256)
        spool = _create_start_spool(spool_path, key)
        if isinstance(spool, JSONResponse):
            return spool
        ports = WsEnginePorts(file_id=req.file_id, spool=spool, base_url=req.base_url)
        session = await _start_live_session(manager, cfg, ports, spool)
        if isinstance(session, JSONResponse):
            return session
        return _started_session_response(session, spool_path, key)

    @app.post("/rec/pause")
    async def rec_pause(req: FileIdBody) -> Any:
        session = manager.for_file(req.file_id)
        if session is None:
            return _not_live()
        session.engine.send(MsgPause())
        return {"ok": True}

    @app.post("/rec/resume")
    async def rec_resume(req: FileIdBody) -> Any:
        session = manager.for_file(req.file_id)
        if session is None:
            return _not_live()
        session.engine.send(MsgResume())
        return {"ok": True}

    @app.post("/rec/set_live_stt")
    async def rec_set_live_stt(req: SetLiveSttBody) -> Any:
        session = manager.for_file(req.file_id)
        if session is None:
            return _not_live()
        session.engine.send(MsgSetLiveStt(on=req.on))
        return {"ok": True}

    @app.post("/rec/set_live_translate")
    async def rec_set_live_translate(req: SetLiveTranslateBody) -> Any:
        session = manager.for_file(req.file_id)
        if session is None:
            return _not_live()
        session.engine.send(MsgSetLiveTranslate(lang=req.lang))
        return {"ok": True}

    @app.post("/rec/edit_meta")
    async def rec_edit_meta(req: EditMetaRequest) -> Any:
        session = manager.for_file(req.file_id)
        if session is None:
            return _not_live()
        try:
            apply_fn = _build_apply(req, session.engine)
        except ValueError as exc:
            return JSONResponse({"error": str(exc), "code": "REC_BAD_EDIT_OP"}, status_code=400)
        fut: "asyncio.Future[RecMeta]" = asyncio.get_running_loop().create_future()
        session.engine.send(MsgEditMeta(apply=apply_fn, done=fut))
        try:
            meta = await asyncio.wait_for(fut, timeout=EDIT_META_TIMEOUT)
        except asyncio.TimeoutError:
            return JSONResponse(
                {
                    "error": "The recording did not answer in time.",
                    "code": "REC_EDIT_META_TIMEOUT",
                },
                status_code=504,
            )
        except Exception as exc:  # noqa: BLE001 -- `apply`'s own Result-shaped refusal
            return JSONResponse(
                {"error": str(exc), "code": "REC_EDIT_META_FAILED"}, status_code=400
            )
        return {"ok": True, "meta": meta.to_dict()}

    @app.post("/rec/stop")
    async def rec_stop(req: FileIdBody) -> Any:
        session = manager.for_file(req.file_id)
        if session is None:
            return _not_live()
        fut: "asyncio.Future[RecMeta]" = asyncio.get_running_loop().create_future()
        session.waiting.append(fut)
        session.engine.send(MsgStop(done=fut))
        try:
            meta = await fut  # no deadline of its own -- see §1
        except Exception as exc:  # noqa: BLE001 -- the documented failed-save path
            result: Any = JSONResponse(
                {"error": str(exc), "code": "REC_SAVE_FAILED"}, status_code=502
            )
        else:
            result = {"ok": True, "meta": meta.to_dict()}
        # The reply resolves inside `finish()`, so the run loop is a few lines
        # from done: waiting for it (rather than racing it) means the slot is
        # provably free before this response is read, and the next /rec/start
        # cannot collide with this session's own teardown.
        with contextlib.suppress(Exception):
            await session.run_task
        await manager.finalize(session)
        return result

    @app.post("/rec/retranscribe")
    async def rec_retranscribe(req: RetranscribeRequest, request: Request) -> Any:
        """Rebuild one host-staged media file's transcript offline (§7).

        The ONE route here with no :class:`LiveSession` behind it: there is no
        engine, no lanes, no spool and no socket -- just the pure
        :func:`~arcelle_sidecar.rec.engine.retranscribe` pass over a decoded
        file, streamed. It is mounted here rather than in ``server.py``
        because everything it needs (the camelCase ``/rec/*`` body convention,
        :class:`KnownVoiceIn`, ``RecMeta``) already lives in this module, and
        because a caller reading ``/rec/*`` should find every recording verb
        in one place.

        Failures split by WHEN they happen, which is forced by HTTP: a refusal
        decided before the first byte is a 400 (:func:`_retranscribe_refused`),
        while anything that goes wrong once the 200 is committed can only be a
        terminal ``error`` line. Both bodies carry the same ``{"kind": "error",
        "code", "error"}`` keys so the host parses one shape.
        """
        job = _retranscribe_job(req)
        if isinstance(job, str):
            return _retranscribe_refused(job)
        return StreamingResponse(
            _retranscribe_stream(request, job),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    @app.websocket("/rec/session")
    async def rec_session_ws(websocket: WebSocket) -> None:
        session = await _attach_rec_session(manager, websocket)
        if session is None:
            return
        ports = session.ports
        queue = ports.attach_session_socket(websocket)
        pump = asyncio.create_task(_pump_session_socket(websocket, queue))
        try:
            await _receive_rec_session_messages(websocket, session.engine)
        except WebSocketDisconnect:
            pass
        finally:
            await _detach_rec_session_socket(ports, websocket, pump)

    @app.websocket("/rec/host")
    async def rec_host_ws(websocket: WebSocket) -> None:
        host = await _attach_rec_host(manager, websocket)
        if host is None:
            return
        try:
            await _receive_host_acks(websocket, host)
        except WebSocketDisconnect:
            pass
        finally:
            host.detach(websocket)

    return manager
