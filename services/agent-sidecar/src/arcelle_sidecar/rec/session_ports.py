"""Encrypted spool, host correlation, and recording engine ports."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import struct
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import WebSocket

from arcelle_sidecar import llm
from arcelle_sidecar.messages import compact_json, user_message
from arcelle_sidecar.model_text import strip_think_spans
from arcelle_sidecar.rec.engine import Engine, PersistFailed, RoomClosed, Save
from arcelle_sidecar.rec.lanes import Source

log = logging.getLogger("arcelle_sidecar.rec.session_ws")
_GCM_NONCE_LEN = 12
_SPOOL_LEN_STRUCT = struct.Struct("<I")
_TERMINAL_STATES = frozenset({"saved", "failed"})
_EVENT_MAP = {
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
_WHOLE_APP_EVENT = "room-files-changed"
_TRANSLATE_PROMPT = "Translate this into {lang}. Output ONLY the translation, nothing else.\\n\\n{text}"
_TRANSLATE_TEMPERATURE = 0.2
_TRANSLATE_KEEP_ALIVE = "5m"


def _facade_module() -> Any:
    from arcelle_sidecar.rec import session_ws

    return session_ws


class SpoolWriter:
    """Append-only, owner-only (0600), AES-256-GCM-framed on-disk buffer for one
    live session's raw-PCM checkpoints and its full WAVs. See §5 for the frame
    shape and the unlink/recreate lifecycle.

    Raises :class:`OSError` (or ``FileExistsError`` for a stale spool from a
    crashed session) like any other file object would -- :meth:`WsEnginePorts.persist`
    is the one place that turns those into :class:`PersistFailed`, because that
    is the only shape ``Engine.flush`` knows how to survive.
    """

    def __init__(self, path: Path, key: bytes) -> None:
        self.path = Path(path)
        self._aead = AESGCM(key)
        self._fh: Any = None
        self._open()

    def _open(self) -> None:
        """Create THIS session's spool file. ``O_EXCL``: a file already at this
        path is a previous, crashed session's spool, and it is Electron's to
        recover from -- overwriting it silently would destroy exactly the audio
        the crash story is meant to save."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(self.path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        self._fh = os.fdopen(fd, "wb")

    def append(self, plaintext: bytes) -> tuple[int, int]:
        """Encrypt under a FRESH random nonce and append as one independent
        frame. Returns the frame's ``(start, end)`` BYTE range in the file --
        what ``persist()`` reports as ``spoolRange``.

        ``fsync``: this file IS the crash story. Bytes that only reached the
        page cache are bytes a power cut takes with it, and Electron will have
        already ACKed them into the room's row."""
        if self._fh is None:
            self._open()
        nonce = os.urandom(_GCM_NONCE_LEN)
        frame = nonce + self._aead.encrypt(nonce, plaintext, None)
        start = self._fh.tell()
        self._fh.write(_SPOOL_LEN_STRUCT.pack(len(frame)))
        self._fh.write(frame)
        self._fh.flush()
        os.fsync(self._fh.fileno())
        return start, self._fh.tell()

    def truncate_to(self, offset: int) -> None:
        """Drop everything from ``offset`` on -- the frame of a save that was
        never ACKed (see §5). Best-effort: a file already gone took the frame
        with it."""
        if self._fh is None:
            return
        with contextlib.suppress(OSError, ValueError):
            self._fh.seek(offset)
            self._fh.truncate()
            self._fh.flush()

    def close(self) -> None:
        if self._fh is not None:
            with contextlib.suppress(OSError, ValueError):
                self._fh.close()
            self._fh = None

    def unlink(self) -> None:
        """Close and remove. Safe to call more than once; the next
        :meth:`append` recreates the file from byte 0, 0600 again."""
        self.close()
        with contextlib.suppress(OSError):
            os.remove(self.path)


# =============================================================================
# ---- WS /rec/host correlation ------------------------------------------------
# =============================================================================

#: What a pending save is told when its host socket goes away. Deliberately a
#: PersistFailed, not a RoomClosed: Electron reconnecting, reloading, or dying
#: is not the room closing, and only Electron can say that it did (see §3).
_HOST_GONE = "The room's host is not connected."


class _HostLink:
    """The correlation layer over ``WS /rec/host``. At most one physical
    connection per live session; request ids exist defensively -- ``Engine``
    only ever awaits one ``persist()`` at a time in practice."""

    def __init__(self) -> None:
        self.ws: WebSocket | None = None
        self._pending: dict[str, "asyncio.Future[dict]"] = {}

    def attach(self, ws: WebSocket) -> bool:
        """Take this connection as THE host link, unless one is already
        attached -- a stray second connection (a reconnect racing a stale
        close) is refused rather than silently taking over, which would strand
        the acks addressed to the first."""
        if self.ws is not None:
            return False
        self.ws = ws
        return True

    def detach(self, ws: WebSocket | None = None) -> None:
        """The host connection ended. Anything still waiting for an ack is
        failed NOW, rather than sitting out the rest of :data:`PERSIST_TIMEOUT`
        with the engine's run loop blocked inside ``flush``."""
        if ws is not None and self.ws is not ws:
            return
        self.ws = None
        pending, self._pending = self._pending, {}
        for fut in pending.values():
            if not fut.done():
                fut.set_exception(PersistFailed(_HOST_GONE))

    def resolve(self, ack: dict) -> None:
        req_id = ack.get("reqId")
        if isinstance(req_id, str):
            fut = self._pending.get(req_id)
            if fut is None:
                # AN ID NOBODY IS WAITING ON IS A STALE ACK -- the late answer
                # to a save that already gave up at PERSIST_TIMEOUT, or a host
                # that acked twice -- NOT this save's answer. Handing it to
                # whatever happens to be outstanding is worse than dropping it:
                # an `ok: true` marks a chunk durable that Electron never wrote
                # (`Engine` advances `flushed_samples` past it and nothing ever
                # writes it again -- that audio is gone from the room while the
                # recording carries on looking healthy), and a `reason:
                # "closed"` ends a live recording that nothing closed.
                log.warning("rec/host: dropped an ack for a save nobody is waiting on")
                return
        elif len(self._pending) == 1:
            # A host that does not echo the id back, with exactly one request
            # outstanding: there is no ambiguity about what it is answering.
            fut = next(iter(self._pending.values()))
        else:
            return
        if not fut.done():
            fut.set_result(ack)

    async def call(self, message: dict, *, timeout: float) -> None:
        """One save, one ack. Returns on success; raises :class:`RoomClosed`
        for an ack that says the room closed and :class:`PersistFailed` for
        everything else (see §3 for why those two are not interchangeable)."""
        ws = _connected_host_socket(self)
        req_id = message["reqId"]
        fut: "asyncio.Future[dict]" = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        try:
            await _send_host_request(ws, message)
            ack = await _wait_for_host_ack(fut, timeout)
        finally:
            self._pending.pop(req_id, None)
        _raise_for_host_ack(ack)


def _connected_host_socket(host: _HostLink) -> WebSocket:
    ws = host.ws
    if ws is None:
        raise PersistFailed(_HOST_GONE)
    return ws


async def _send_host_request(ws: WebSocket, message: dict) -> None:
    try:
        await ws.send_text(compact_json(message))
    except Exception as exc:  # noqa: BLE001 -- a dead socket is a failed save
        raise PersistFailed(f"Could not reach the room's host: {exc}") from exc


async def _wait_for_host_ack(fut: "asyncio.Future[dict]", timeout: float) -> dict:
    try:
        return await asyncio.wait_for(fut, timeout=timeout)
    except asyncio.TimeoutError as exc:
        raise PersistFailed("The room's host did not answer in time.") from exc


def _raise_for_host_ack(ack: dict) -> None:
    if ack.get("ok"):
        return
    if ack.get("reason") == "closed":
        raise RoomClosed()
    raise PersistFailed(str(ack.get("message") or "The recording could not be saved."))


# =============================================================================
# ---- WsEnginePorts -----------------------------------------------------------
# =============================================================================


def _map_event(event: str, payload: dict) -> dict | None:
    """One engine event -> one wire message, or ``None`` for the one event that
    is deliberately not forwarded. See §2's table."""
    if event == _WHOLE_APP_EVENT:
        return None
    if event == "rec-state":
        wire = "stopped" if payload.get("status") in _TERMINAL_STATES else "state"
        return {"type": wire, **payload}
    wire_type = _EVENT_MAP.get(event)
    if wire_type is None:
        # Never silently dropped by omission -- forwarded under its own name so
        # a renderer taught about it still sees it. The NAME only: a payload is
        # the user's own words (SPEC §6).
        log.warning("session_ws: no wire mapping for engine event %r", event)
        wire_type = event
    return {"type": wire_type, **payload}


@dataclass(frozen=True)
class _PersistSpoolData:
    from_sample: int | None
    to_sample: int | None
    spool_range: list[int] | None


def _persist_spool_data(
    save: Save,
    engine: Engine,
    spool: SpoolWriter,
    wav: bytes | None,
    checkpoint_pcm: np.ndarray | None,
) -> _PersistSpoolData:
    try:
        return _append_persist_spool_data(save, engine, spool, wav, checkpoint_pcm)
    except PersistFailed:
        raise
    except Exception as exc:  # noqa: BLE001 -- a full disk, a vanished dir, a stale spool
        raise PersistFailed(f"The recording's spool file could not be written: {exc}") from exc


def _append_persist_spool_data(
    save: Save,
    engine: Engine,
    spool: SpoolWriter,
    wav: bytes | None,
    checkpoint_pcm: np.ndarray | None,
) -> _PersistSpoolData:
    if save is Save.FULL:
        return _full_spool_data(engine, spool, wav)
    if checkpoint_pcm is None:
        return _PersistSpoolData(None, None, None)
    return _checkpoint_spool_data(engine, spool, checkpoint_pcm)


def _full_spool_data(engine: Engine, spool: SpoolWriter, wav: bytes | None) -> _PersistSpoolData:
    if wav is None:
        # `EnginePorts.persist`'s own contract guarantees `wav` for every FULL.
        # Reported as a save failure rather than raised bare: a violated
        # invariant must not unwind through `Engine.flush` and take its run loop.
        raise PersistFailed("Save.FULL was asked to persist with no WAV bytes.")
    return _PersistSpoolData(0, int(len(engine.mixed)), list(spool.append(wav)))


def _checkpoint_spool_data(
    engine: Engine, spool: SpoolWriter, checkpoint_pcm: np.ndarray
) -> _PersistSpoolData:
    # `Engine.flush` advances `flushed_samples` only AFTER this call returns, so
    # it still holds where this chunk starts (see §4).
    from_sample = int(engine.flushed_samples)
    to_sample = from_sample + int(np.asarray(checkpoint_pcm).size)
    pcm = np.ascontiguousarray(checkpoint_pcm, dtype="<f4").tobytes()
    return _PersistSpoolData(from_sample, to_sample, list(spool.append(pcm)))


def _persist_message(save: Save, data: _PersistSpoolData, meta_json: str, text: str) -> dict:
    return {
        "reqId": str(uuid.uuid4()),
        "kind": save.value,
        "fromSample": data.from_sample,
        "toSample": data.to_sample,
        "spoolRange": data.spool_range,
        "metaJson": meta_json,
        "text": text,
    }


async def _persist_with_rollback(host: _HostLink, spool: SpoolWriter, message: dict) -> None:
    spool_range = message["spoolRange"]
    try:
        await host.call(message, timeout=_facade_module().PERSIST_TIMEOUT)
    except (PersistFailed, RoomClosed):
        # Nothing will ever reference an un-ACKed frame, and Engine awaits one
        # persist() at a time, so no later frame needs preserving behind it.
        if spool_range is not None:
            spool.truncate_to(spool_range[0])
        raise


class WsEnginePorts:
    """The real, network-backed ``EnginePorts`` -- see §2-§5 for the contract
    each method satisfies."""

    def __init__(self, *, file_id: str, spool: SpoolWriter, base_url: str) -> None:
        self.file_id = file_id
        self.spool = spool
        self.base_url = base_url
        self.host = _HostLink()
        #: One ORDERED outgoing queue per attached renderer socket (see §2).
        self._queues: dict[Any, "asyncio.Queue[str]"] = {}
        #: Set by :meth:`bind_engine` right after ``create_engine`` returns --
        #: the ``Engine`` does not exist yet when its ports are constructed, and
        #: nothing in ``Engine.__init__`` calls back into here.
        self.engine: Engine | None = None
        self._last_lang: list[str | None] = [None, None]

    def bind_engine(self, engine: Engine) -> None:
        self.engine = engine

    # -- EnginePorts -----------------------------------------------------------

    def emit(self, event: str, payload: dict) -> None:
        wire = _map_event(event, payload)
        if wire is not None:
            self._broadcast(wire)
        self._emit_lang_locked()

    async def persist(
        self,
        save: Save,
        *,
        wav: bytes | None,
        checkpoint_pcm: np.ndarray | None,
        meta_json: str,
        text: str,
    ) -> None:
        engine = self.engine
        if engine is None:  # pragma: no cover - bind_engine always runs first
            raise PersistFailed("persist() ran before the session's engine was bound.")
        data = _persist_spool_data(save, engine, self.spool, wav, checkpoint_pcm)
        message = _persist_message(save, data, meta_json, text)
        await _persist_with_rollback(self.host, self.spool, message)
        if save is Save.FULL:
            # `call` only returns on `ok: true`, so Electron has durably written
            # this WAV into the room: every checkpoint this spool holds -- and
            # the WAV frame just written -- is superseded. As true at a pause's
            # full save as at the session's last one.
            self.spool.unlink()

    async def request_sys_tap(self) -> None:
        self._broadcast({"type": "sys-tap-request", "fileId": self.file_id, "action": "start"})

    async def stop_sys_tap(self) -> None:
        self._broadcast({"type": "sys-tap-request", "fileId": self.file_id, "action": "stop"})

    async def translate(self, text: str, lang: str, model: str) -> str | None:
        """One live-translation call on an already-resolved model.

        THE PORT OWNS THE CLEAN-UP (``EnginePorts.translate``'s own docstring):
        the room's default model is a REASONING one, so handing back raw output
        paints ``<think>...</think>`` into the live translation. Stripped and
        trimmed here; ``None`` for any failure and for an answer with nothing
        left in it, which ``Engine`` treats as "try again on the next
        sentence"."""
        prompt = _TRANSLATE_PROMPT.format(lang=lang, text=text)
        try:
            raw = await llm.generate(
                model,
                [user_message(prompt)],
                self.base_url,
                temperature=_TRANSLATE_TEMPERATURE,
                keep_alive=_TRANSLATE_KEEP_ALIVE,
            )
        except Exception:  # noqa: BLE001 -- never fatal, see this method's docstring
            # The failure, never the sentence: a log line is a copy of the
            # user's own words that outlives the run (SPEC §6).
            log.warning("session_ws: live translation failed", exc_info=True)
            return None
        return strip_think_spans(raw).strip() or None

    # -- wiring, not part of EnginePorts ---------------------------------------

    def attach_session_socket(self, ws: Any) -> "asyncio.Queue[str]":
        queue: "asyncio.Queue[str]" = asyncio.Queue()
        self._queues[ws] = queue
        # A TAP REQUEST THIS SOCKET COULD NOT HAVE HEARD. `Engine.run` asks for
        # the meeting tap the moment the session's run task is scheduled, which
        # is ALWAYS before the renderer -- it cannot connect until /rec/start's
        # response has reached it -- so the session's own startup request is
        # broadcast to an empty set and lost. `start_sys_tap` is a one-shot
        # (`sys_tap_starting` refuses a second request, so not even a
        # pause/resume recovers it): the meeting lane stayed "starting" for the
        # whole recording and captured nothing, silently.
        #
        # DERIVED from the engine's own state rather than remembered here, the
        # same way `lang-locked` is: it therefore stops as soon as the result
        # lands, so a socket joining a session whose tap is already up is never
        # asked to start a second one (two taps = the meeting recorded and
        # transcribed twice).
        engine = self.engine
        if engine is not None and engine.sys_tap_starting:
            queue.put_nowait(
                compact_json(
                    {"type": "sys-tap-request", "fileId": self.file_id, "action": "start"}
                )
            )
        return queue

    def detach_session_socket(self, ws: Any) -> None:
        self._queues.pop(ws, None)

    def _broadcast(self, message: dict) -> None:
        line = compact_json(message)
        for queue in list(self._queues.values()):
            queue.put_nowait(line)

    def _emit_lang_locked(self) -> None:
        """Derived, because no ``emit()`` call announces a lane's language lock
        (see §2)."""
        engine = self.engine
        if engine is None:
            return
        for source in (Source.MIC, Source.SYS):
            hint = engine.lane_lang[source.value].hint()
            if hint != self._last_lang[source.value]:
                self._last_lang[source.value] = hint
                self._broadcast(
                    {
                        "type": "lang-locked",
                        "fileId": self.file_id,
                        "source": source.as_str(),
                        "lang": hint,
                    }
                )
