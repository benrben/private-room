"""Fake-only contracts for digest context-window selection."""

from __future__ import annotations

import pytest

from arcelle_sidecar import chat as chat_module
from arcelle_sidecar.budget import msg_len
from arcelle_sidecar.chat import OllamaChatModel
from arcelle_sidecar.messages import Message
from arcelle_sidecar.model_limits import pick_num_ctx


MESSAGES: list[Message] = [
    {"role": "system", "content": "Keep the summary factual."},
    {"role": "user", "content": "Summarise this fabricated text."},
]


async def test_digest_num_ctx_honours_an_explicit_override_without_lookup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def lookup_must_not_run(_model: str, _base_url: str) -> int | None:
        raise AssertionError("an explicit digest window must not query a model catalog")

    monkeypatch.setattr(chat_module, "native_context_length", lookup_must_not_run)
    model = OllamaChatModel("local-test", "http://fake-ollama", num_ctx=12_345)

    assert await model._digest_num_ctx(MESSAGES) == 12_345


async def test_digest_num_ctx_keeps_a_nonlocal_models_window_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def lookup_must_not_run(_model: str, _base_url: str) -> int | None:
        raise AssertionError("a non-local digest must not query a local catalog")

    monkeypatch.setattr(chat_module, "native_context_length", lookup_must_not_run)
    model = OllamaChatModel("cloud-test:cloud", "http://fake-ollama")

    assert await model._digest_num_ctx(MESSAGES) is None


async def test_digest_num_ctx_uses_the_fabricated_parsed_native_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str]] = []

    async def parsed_catalog(model: str, base_url: str) -> int | None:
        calls.append((model, base_url))
        return 32_768

    monkeypatch.setattr(chat_module, "native_context_length", parsed_catalog)
    model = OllamaChatModel("local-test", "http://fake-ollama")

    assert await model._digest_num_ctx(MESSAGES) == pick_num_ctx(
        sum(msg_len(message) for message in MESSAGES), 32_768
    )
    assert calls == [("local-test", "http://fake-ollama")]


@pytest.mark.parametrize(
    "catalog_outcome",
    ["missing model", "malformed context_length", "unavailable catalog"],
)
async def test_digest_num_ctx_uses_the_fallback_for_catalog_absence(
    monkeypatch: pytest.MonkeyPatch,
    catalog_outcome: str,
) -> None:
    assert catalog_outcome in {
        "missing model", "malformed context_length", "unavailable catalog",
    }

    async def normalized_absence(_model: str, _base_url: str) -> int | None:
        # `native_context_length` normalizes every one of these catalog outcomes
        # to None; the digest path must still choose its payload-fitted fallback.
        return None

    monkeypatch.setattr(chat_module, "native_context_length", normalized_absence)
    model = OllamaChatModel("local-test", "http://fake-ollama")

    assert await model._digest_num_ctx(MESSAGES) == pick_num_ctx(
        sum(msg_len(message) for message in MESSAGES), None
    )
