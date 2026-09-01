from typing import AsyncIterator, cast

import httpx
import pytest

from arcelle_sidecar import provider_api


class _FakeSseResponse:
    def __init__(self, lines: list[str]) -> None:
        self._lines = lines

    async def aiter_lines(self) -> AsyncIterator[str]:
        for line in self._lines:
            yield line


def _response(*lines: str) -> httpx.Response:
    return cast(httpx.Response, _FakeSseResponse(list(lines)))


@pytest.mark.asyncio
async def test_sse_events_skips_noise_malformed_frames_and_done() -> None:
    events = [
        event
        async for event in provider_api._sse_events(
            _response(
                ": provider keepalive",
                "data:",
                "data: [DONE]",
                "data: {truncated",
                'data: ["not", "an", "event"]',
                'data: {"choices":[{"delta":{"content":"kept"}}]}',
            )
        )
    ]

    assert events == [{"choices": [{"delta": {"content": "kept"}}]}]


@pytest.mark.asyncio
async def test_sse_events_surfaces_a_provider_error_frame() -> None:
    with pytest.raises(provider_api.ProviderApiError, match="rate limited"):
        async for _event in provider_api._sse_events(
            _response('data: {"error":{"message":"rate limited"}}')
        ):
            pass
