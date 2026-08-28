"""Context handoff: the "hand off" button's summarization backend.

No network, no Ollama, no FastAPI app construction — `.llm.generate` (the
engine-agnostic gateway) is monkeypatched directly at the name imported into
`handoff`'s own namespace, so these tests exercise the prompt-building and
gateway-calling contract in isolation.
"""

from __future__ import annotations

from typing import Any

import pytest

from arcelle_sidecar import handoff


def test_transcript_labels_user_and_assistant_turns_and_skips_others() -> None:
    messages = [
        {"role": "system", "content": "system prompt — never part of a recap"},
        {"role": "user", "content": "what's the rent?"},
        {"role": "assistant", "content": "1200/mo"},
        {"role": "tool", "content": "irrelevant tool scratchpad", "tool_name": "search_room"},
        {"role": "user", "content": ""},  # empty content is skipped
        {"role": "assistant", "content": "anything else?"},
    ]
    text = handoff._transcript(messages)
    assert text == (
        "User: what's the rent?\n\n"
        "Assistant: 1200/mo\n\n"
        "Assistant: anything else?"
    )
    assert "system prompt" not in text
    assert "tool scratchpad" not in text


def test_transcript_of_no_messages_is_empty() -> None:
    assert handoff._transcript([]) == ""


async def test_summarize_for_handoff_builds_system_and_user_prompt_and_calls_gateway(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    async def fake_generate(model, messages, base_url, *, temperature=None, privacy=None):
        captured["model"] = model
        captured["messages"] = messages
        captured["base_url"] = base_url
        captured["temperature"] = temperature
        captured["privacy"] = privacy
        return "Recap: the user asked about rent; assistant said 1200/mo."

    monkeypatch.setattr(handoff, "generate", fake_generate)

    req = handoff.HandoffSummaryRequest(
        model="qwen3.5:9b",
        base_url="http://127.0.0.1:11434",
        messages=[
            {"role": "user", "content": "what's the rent?"},
            {"role": "assistant", "content": "1200/mo"},
        ],
        temperature=0.3,
        privacy={"active": True},
    )
    summary = await handoff.summarize_for_handoff(req)

    assert summary == "Recap: the user asked about rent; assistant said 1200/mo."
    assert captured["model"] == "qwen3.5:9b"
    assert captured["base_url"] == "http://127.0.0.1:11434"
    assert captured["temperature"] == 0.3
    assert captured["privacy"] == {"active": True}
    # system + one user turn holding the labelled transcript.
    assert len(captured["messages"]) == 2
    assert captured["messages"][0]["role"] == "system"
    assert captured["messages"][0]["content"] == handoff.HANDOFF_SYSTEM_PROMPT
    assert captured["messages"][1]["role"] == "user"
    assert "what's the rent?" in captured["messages"][1]["content"]
    assert "1200/mo" in captured["messages"][1]["content"]


async def test_summarize_for_handoff_placeholders_an_empty_conversation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_generate(model, messages, base_url, *, temperature=None, privacy=None):
        return messages[1]["content"]  # echo the user turn back for inspection

    monkeypatch.setattr(handoff, "generate", fake_generate)

    req = handoff.HandoffSummaryRequest(model="qwen3.5:9b", messages=[])
    summary = await handoff.summarize_for_handoff(req)
    assert summary == "(nothing said yet)"
