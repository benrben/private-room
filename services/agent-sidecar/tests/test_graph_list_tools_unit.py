"""In-memory catalog retrieval coverage for the graph bridge."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from arcelle_sidecar import graph


class _Catalog:
    def __init__(self, replies: list[object]) -> None:
        self._replies = iter(replies)
        self.calls = 0

    async def list_tools(self) -> list[Any]:
        self.calls += 1
        reply = next(self._replies)
        if isinstance(reply, BaseException):
            raise reply
        return reply  # type: ignore[return-value]


def _deps(catalog: _Catalog | None) -> Any:
    return SimpleNamespace(mcp=catalog)


async def test_list_tools_defaults_to_an_empty_catalog_without_a_bridge() -> None:
    assert await graph._list_tools(_deps(None)) == []


async def test_list_tools_returns_the_fabricated_catalog_on_first_attempt() -> None:
    tools = [{"name": "open_file"}, {"name": "search_room"}]
    catalog = _Catalog([tools])

    assert await graph._list_tools(_deps(catalog)) == tools
    assert catalog.calls == 1


async def test_list_tools_retries_one_transient_catalog_failure() -> None:
    tools = [{"name": "open_file"}]
    catalog = _Catalog([ConnectionError("bridge reconnecting"), tools])

    assert await graph._list_tools(_deps(catalog)) == tools
    assert catalog.calls == 2


async def test_list_tools_reports_a_second_failure_with_a_nonempty_reason() -> None:
    catalog = _Catalog([ConnectionError("first failure"), TimeoutError()])

    with pytest.raises(RuntimeError, match="nothing could be done safely: TimeoutError") as exc:
        await graph._list_tools(_deps(catalog))

    assert isinstance(exc.value.__cause__, TimeoutError)
    assert catalog.calls == 2


async def test_list_tools_never_retries_cancellation() -> None:
    catalog = _Catalog([asyncio.CancelledError()])

    with pytest.raises(asyncio.CancelledError):
        await graph._list_tools(_deps(catalog))

    assert catalog.calls == 1


async def test_list_tools_propagates_cancellation_from_the_retry() -> None:
    catalog = _Catalog([ConnectionError("bridge reconnecting"), asyncio.CancelledError()])

    with pytest.raises(asyncio.CancelledError):
        await graph._list_tools(_deps(catalog))

    assert catalog.calls == 2
