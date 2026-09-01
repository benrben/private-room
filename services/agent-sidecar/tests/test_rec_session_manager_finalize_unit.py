"""In-memory teardown coverage for the recording session slot."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from arcelle_sidecar.rec.session_ws import LiveSession, RecSessionManager


class _Engine:
    def __init__(self, failure: BaseException | None = None) -> None:
        self.failure = failure
        self.close_calls = 0

    async def aclose(self) -> None:
        self.close_calls += 1
        if self.failure is not None:
            raise self.failure


class _Spool:
    def __init__(self, failure: BaseException | None = None) -> None:
        self.failure = failure
        self.unlink_calls = 0

    def unlink(self) -> None:
        self.unlink_calls += 1
        if self.failure is not None:
            raise self.failure


class _Socket:
    def __init__(self, failure: BaseException | None = None) -> None:
        self.failure = failure
        self.close_calls = 0

    async def close(self) -> None:
        self.close_calls += 1
        if self.failure is not None:
            raise self.failure


class _Host:
    def __init__(self, ws: _Socket | None) -> None:
        self.ws = ws
        self.detach_calls = 0

    def detach(self) -> None:
        self.detach_calls += 1
        self.ws = None


def _session(
    file_id: str = "recording-1",
    *,
    engine: _Engine | None = None,
    spool: _Spool | None = None,
    host: _Host | None = None,
) -> tuple[LiveSession, _Engine, _Spool, _Host]:
    fake_engine = engine or _Engine()
    fake_spool = spool or _Spool()
    fake_host = host or _Host(_Socket())
    session = LiveSession(
        file_id=file_id,
        engine=fake_engine,  # type: ignore[arg-type] - fully fabricated close-only double
        ports=SimpleNamespace(spool=fake_spool, host=fake_host),
    )
    return session, fake_engine, fake_spool, fake_host


async def test_finalize_releases_the_slot_closes_fakes_and_fails_only_pending_waiters() -> None:
    manager = RecSessionManager()
    session, engine, spool, host = _session()
    manager.current = session
    pending = asyncio.get_running_loop().create_future()
    completed = asyncio.get_running_loop().create_future()
    completed.set_result("already saved")
    session.waiting.extend([pending, completed])
    socket = host.ws

    await manager.finalize(session)
    await manager.finalize(session)

    assert session.finalized is True
    assert manager.current is None
    assert engine.close_calls == 1
    assert spool.unlink_calls == 1
    assert host.detach_calls == 1
    assert socket is not None and socket.close_calls == 1
    with pytest.raises(RuntimeError, match="stopped before it could save"):
        pending.result()
    assert completed.result() == "already saved"


async def test_finalize_leaves_a_newer_session_in_place_and_handles_no_host_socket() -> None:
    manager = RecSessionManager()
    stale, _, _, stale_host = _session("stale", host=_Host(None))
    newer, _, _, _ = _session("newer")
    manager.current = newer

    await manager.finalize(stale)

    assert stale.finalized is True
    assert manager.current is newer
    assert stale_host.detach_calls == 1


async def test_finalize_suppresses_fabricated_cleanup_failures_before_failing_waiters() -> None:
    manager = RecSessionManager()
    socket = _Socket(RuntimeError("fake socket close failure"))
    session, engine, spool, host = _session(
        engine=_Engine(RuntimeError("fake engine close failure")),
        spool=_Spool(RuntimeError("fake spool unlink failure")),
        host=_Host(socket),
    )
    manager.current = session
    waiting = asyncio.get_running_loop().create_future()
    session.waiting.append(waiting)

    await manager.finalize(session)

    assert manager.current is None
    assert engine.close_calls == spool.unlink_calls == host.detach_calls == socket.close_calls == 1
    with pytest.raises(RuntimeError, match="stopped before it could save"):
        waiting.result()
