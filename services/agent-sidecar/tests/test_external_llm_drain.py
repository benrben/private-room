"""Pure async-pipe coverage for the external command drain.

These doubles never create a process or connect to a model/provider: they only
implement the reader, writer, and wait seams consumed by ``drain_with_idle``.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from arcelle_sidecar import external_llm


class _FakeStdin:
    def __init__(self) -> None:
        self.payload = b""
        self.closed = False

    def write(self, payload: bytes) -> None:
        self.payload += payload

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True


class _ChunkReader:
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    async def read(self, _size: int) -> bytes:
        return self._chunks.pop(0) if self._chunks else b""


class _PendingReader:
    async def read(self, _size: int) -> bytes:
        await asyncio.Event().wait()
        return b""


class _BrokenReader:
    async def read(self, _size: int) -> bytes:
        raise RuntimeError("stdout pipe broke")


class _FinishedProc:
    def __init__(self, stdout: Any, stderr: Any) -> None:
        self.stdin = _FakeStdin()
        self.stdout = stdout
        self.stderr = stderr
        self.killed = False

    def kill(self) -> None:
        self.killed = True

    async def wait(self) -> int:
        return 0


class _PendingProc:
    def __init__(self) -> None:
        self.stdin = _FakeStdin()
        self.stdout = _PendingReader()
        self.stderr = _PendingReader()
        self.killed = False
        self._stopped = asyncio.Event()

    def kill(self) -> None:
        self.killed = True
        self._stopped.set()

    async def wait(self) -> int:
        await self._stopped.wait()
        return -9


class _Tap:
    def __init__(self) -> None:
        self.chunks: list[bytes] = []

    async def feed(self, chunk: bytes) -> None:
        self.chunks.append(chunk)


@pytest.mark.asyncio
async def test_drain_feeds_closes_and_collects_fake_streams() -> None:
    proc = _FinishedProc(_ChunkReader([b"out", b"put"]), _ChunkReader([b"warn"]))
    tap = _Tap()

    stdout, stderr = await external_llm.drain_with_idle(proc, b"prompt", 1, tap=tap)

    assert (stdout, stderr) == (b"output", b"warn")
    assert proc.stdin.payload == b"prompt"
    assert proc.stdin.closed
    assert tap.chunks == [b"out", b"put"]
    assert not proc.killed


@pytest.mark.asyncio
async def test_drain_surfaces_a_fake_pipe_failure_without_returning_partial_output() -> None:
    proc = _FinishedProc(_BrokenReader(), _ChunkReader([]))

    with pytest.raises(RuntimeError, match="stdout pipe broke"):
        await external_llm.drain_with_idle(proc, b"prompt", 1)

    assert not proc.killed


@pytest.mark.asyncio
async def test_drain_kills_fake_silent_processes_for_stop_or_idle(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(external_llm, "_POLL_SECS", 0.001)
    stopped = _PendingProc()
    assert await external_llm.drain_with_idle(
        stopped,
        b"prompt",
        1,
        cancel=SimpleNamespace(cancelled=True),
    ) == (b"", b"")
    assert stopped.killed

    wedged = _PendingProc()
    with pytest.raises(external_llm._Wedged):
        await external_llm.drain_with_idle(wedged, b"prompt", 0.0001)
    assert wedged.killed


@pytest.mark.asyncio
async def test_cancelling_the_drain_reaps_the_fake_process() -> None:
    proc = _PendingProc()
    task = asyncio.create_task(external_llm.drain_with_idle(proc, b"prompt", 1))
    await asyncio.sleep(0)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert proc.killed
