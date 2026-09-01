"""Native context-length lookup (`model_limits.native_context_length`) — the
token-budget bar's `max_context` for Ollama-routed models, both local and
`:cloud`. No real Ollama daemon: `httpx.AsyncClient` is swapped for a
`MockTransport`, matching this suite's existing convention (test_mcp_client.py).
"""

from __future__ import annotations

import httpx
import pytest

from arcelle_sidecar import model_limits

#: captured before any test monkeypatches httpx.AsyncClient — the mock
#: factory below must construct the REAL client (with a MockTransport), not
#: recurse into whatever monkeypatch swapped the module attribute for.
_RealAsyncClient = httpx.AsyncClient


def _client_with(handler):
    return lambda *args, **kwargs: _RealAsyncClient(transport=httpx.MockTransport(handler))


async def test_native_context_length_reads_the_matching_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_limits._CACHE.clear()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "models": [
                    {"model": "qwen3.5:4b", "details": {"context_length": 262144}},
                    {"model": "nomic-embed-text:latest", "details": {"context_length": 2048}},
                ]
            },
        )

    monkeypatch.setattr(httpx, "AsyncClient", _client_with(handler))
    length = await model_limits.native_context_length("qwen3.5:4b", "http://127.0.0.1:11434")
    assert length == 262_144


async def test_native_context_length_matches_by_name_field_too(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_limits._CACHE.clear()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"models": [{"name": "gemma4:cloud", "details": {"context_length": 262144}}]},
        )

    monkeypatch.setattr(httpx, "AsyncClient", _client_with(handler))
    length = await model_limits.native_context_length("gemma4:cloud", "http://127.0.0.1:11434")
    assert length == 262_144


async def test_native_context_length_returns_none_for_an_unlisted_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_limits._CACHE.clear()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"models": [{"model": "other:1b", "details": {"context_length": 2048}}]},
        )

    monkeypatch.setattr(httpx, "AsyncClient", _client_with(handler))
    length = await model_limits.native_context_length("mystery:1b", "http://127.0.0.1:11434")
    assert length is None


async def test_native_context_length_rejects_an_invalid_matching_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A model entry without a positive integer window stays unknown."""
    model_limits._CACHE.clear()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"models": [{"model": "mystery:1b", "details": {"context_length": 0}}]},
        )

    monkeypatch.setattr(httpx, "AsyncClient", _client_with(handler))
    length = await model_limits.native_context_length("mystery:1b", "http://127.0.0.1:11434")
    assert length is None


async def test_native_context_length_returns_none_when_the_daemon_is_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_limits._CACHE.clear()

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    monkeypatch.setattr(httpx, "AsyncClient", _client_with(handler))
    length = await model_limits.native_context_length("qwen3.5:4b", "http://127.0.0.1:11434")
    assert length is None


async def test_native_context_length_caches_a_successful_lookup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_limits._CACHE.clear()
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json={"models": [{"model": "qwen3.5:4b", "details": {"context_length": 262144}}]},
        )

    monkeypatch.setattr(httpx, "AsyncClient", _client_with(handler))
    first = await model_limits.native_context_length("qwen3.5:4b", "http://127.0.0.1:11434")
    second = await model_limits.native_context_length("qwen3.5:4b", "http://127.0.0.1:11434")
    assert first == second == 262_144
    assert calls == 1  # the second call was served from cache — no second request


async def test_a_swapped_model_is_noticed_rather_than_remembered_forever(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The entry used to be kept for the life of the process. Re-pull a model,
    or swap it for another quantisation under the same name, and every request
    for the rest of the session was still sized off the OLD window — and so was
    the token bar's ceiling."""
    model_limits._CACHE.clear()
    length = 262_144

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"models": [{"model": "qwen3.5:4b", "details": {"context_length": length}}]},
        )

    monkeypatch.setattr(httpx, "AsyncClient", _client_with(handler))
    monkeypatch.setattr(model_limits, "_CACHE_TTL_SECONDS", 0.0)
    assert await model_limits.native_context_length("qwen3.5:4b", "http://h:1") == 262_144
    length = 32_768
    assert await model_limits.native_context_length("qwen3.5:4b", "http://h:1") == 32_768


async def test_a_failed_refresh_keeps_the_length_it_last_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Expiry must not turn a known window into an unknown one: the last real
    answer beats sending the caller to a made-up display default."""
    model_limits._CACHE.clear()
    up = True

    def handler(request: httpx.Request) -> httpx.Response:
        if not up:
            raise httpx.ConnectError("refused", request=request)
        return httpx.Response(
            200,
            json={"models": [{"model": "qwen3.5:4b", "details": {"context_length": 262144}}]},
        )

    monkeypatch.setattr(httpx, "AsyncClient", _client_with(handler))
    monkeypatch.setattr(model_limits, "_CACHE_TTL_SECONDS", 0.0)
    assert await model_limits.native_context_length("qwen3.5:4b", "http://h:1") == 262_144
    up = False
    assert await model_limits.native_context_length("qwen3.5:4b", "http://h:1") == 262_144


# --------------------------------------------------------------------------- #
# Live bytes-per-token calibration
#
# Measured 2026-07-28 with qwen3.5:2b-mlx's own tokenizer (`prompt_eval_count`):
# English prose 5.89 B/token, Hebrew prose 3.62, Hebrew+numbers 2.91,
# English+numbers 2.48, code 3.08. The shipped constant of 3 therefore filled
# 51% of the window for ordinary English chat and overflowed a number-dense
# turn. A constant cannot be right for a spread that wide, so it is measured.
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def _reset_calibration():
    model_limits.reset_token_ratio()
    yield
    model_limits.reset_token_ratio()


def test_cold_start_is_exactly_todays_behaviour() -> None:
    """Nothing observed yet -> the shipped constant, unchanged."""
    assert model_limits.bytes_per_token() == float(model_limits.BYTES_PER_TOKEN)


def test_english_prose_stops_wasting_half_the_window() -> None:
    """The measured English ratio must actually raise the budget — this is the
    whole point of calibrating, and it is the case a constant got most wrong."""
    before = model_limits.bytes_per_token()
    for _ in range(10):
        model_limits.observe_token_ratio(5_890, 1_000)  # 5.89 B/token
    after = model_limits.bytes_per_token()
    assert after > before
    assert after == pytest.approx(5.89 * 0.85, rel=0.02)


def test_it_can_never_grant_less_than_the_constant_did() -> None:
    """A number-dense turn measures 2.48 B/token — below the floor. Clamping up
    keeps this change from being a regression for anyone."""
    for _ in range(10):
        model_limits.observe_token_ratio(2_480, 1_000)
    assert model_limits.bytes_per_token() == float(model_limits.BYTES_PER_TOKEN)


def test_a_wild_ratio_cannot_move_the_window() -> None:
    """Guards a mis-paired payload/usage report, which would otherwise size the
    next window off a number that describes a different call."""
    model_limits.observe_token_ratio(1_000_000, 3)  # 333k B/token
    model_limits.observe_token_ratio(0, 100)
    model_limits.observe_token_ratio(100, 0)
    assert model_limits.bytes_per_token() == float(model_limits.BYTES_PER_TOKEN)


def test_the_ceiling_holds() -> None:
    """Past the clamp the estimate would claim a payload is half as heavy as
    the floor assumes — the silent-context-shift direction."""
    for _ in range(30):
        model_limits.observe_token_ratio(19_000, 1_000)
    assert model_limits.bytes_per_token() == model_limits._CAL_CEILING


def test_calibration_follows_a_conversation_that_changes_content() -> None:
    """English prose, then the user starts pasting code. The estimate must
    move, or the calibration is just a slower constant."""
    for _ in range(10):
        model_limits.observe_token_ratio(5_890, 1_000)
    english = model_limits.bytes_per_token()
    for _ in range(10):
        model_limits.observe_token_ratio(3_080, 1_000)
    assert model_limits.bytes_per_token() < english


def test_both_users_of_the_ratio_move_together() -> None:
    """`pick_num_ctx` divides by it and `window_budget_bytes` multiplies by it.
    They must stay inverses or the app can believe a payload both fits and
    doesn't — the disagreement that ends in a silent context-shift."""
    from arcelle_sidecar.budget import window_budget_bytes

    for _ in range(10):
        model_limits.observe_token_ratio(5_890, 1_000)
    budget = window_budget_bytes(32_768)
    # A payload sized exactly to the window's budget must map back to a window
    # no larger than the one it was derived from.
    assert model_limits.pick_num_ctx(budget, None) <= 32_768
