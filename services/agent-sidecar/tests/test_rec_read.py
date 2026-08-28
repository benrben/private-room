"""The recording READING step (rec_read.rs / rec_read.py).

No network, no Ollama: :func:`arcelle_sidecar.llm.generate` is monkeypatched
with a scripted fake, so every test asserts the prompt actually built, the parse
of the reply into the artifact Rust stores, the single retry, and the
fatal-vs-transient split the job runner relies on.

The property these exist for: a window the model cannot read comes back
``skipped=True`` with the thread flowing on — never silently empty, because a
read that missed part of a meeting must not report itself as complete. That is
the `#minutes` failure (a recording read for its first five minutes and
presented as read) restated at the window level.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from arcelle_sidecar import llm, rec_read


class FakeGenerate:
    """A scripted ``llm.generate``: each call consumes the next reply (a string
    to return, or an Exception to raise) and records how it was invoked."""

    def __init__(self, *replies: Any) -> None:
        self.replies = list(replies)
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, model: str, messages: Any, base_url: str, **kwargs: Any) -> str:
        self.calls.append({"model": model, "messages": messages, "base_url": base_url, **kwargs})
        item = (
            self.replies[len(self.calls) - 1]
            if len(self.calls) <= len(self.replies)
            else self.replies[-1]
        )
        if isinstance(item, Exception):
            raise item
        return item

    def user_of(self, i: int = -1) -> str:
        return self.calls[i]["messages"][-1]["content"]

    def system_of(self, i: int = -1) -> str:
        return self.calls[i]["messages"][0]["content"]


def set_replies(monkeypatch: pytest.MonkeyPatch, *replies: Any) -> FakeGenerate:
    fake = FakeGenerate(*replies)
    monkeypatch.setattr(llm, "generate", fake)
    return fake


def req(**kw: Any) -> rec_read.RecReadMapRequest:
    base = {
        "model": "qwen3.5:4b",
        "file_name": "Monday standup",
        "part": 0,
        "total": 2,
        "turns": "#0 [0:00] Dana: we should ship on thursday\n#1 [0:05] Yossi: i will send the notes\n",
    }
    base.update(kw)
    return rec_read.RecReadMapRequest(**base)


FOUND = json.dumps(
    {
        "chapters": [{"turn": 0, "title": "Release date"}],
        "highlights": [{"turn": 0, "until": 1}],
        "notes": [
            {"turn": 0, "kind": "decision", "text": "ship on Thursday", "who": None},
            {"turn": 1, "kind": "action", "text": "send the notes", "who": "Yossi"},
        ],
        "thread": "They agreed a ship date.",
    }
)


@pytest.mark.asyncio
async def test_a_window_becomes_the_artifact_rust_stores(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = set_replies(monkeypatch, FOUND)
    out = await rec_read.read_window(req())

    assert out["skipped"] is False
    assert out["chapters"] == [{"turn": 0, "title": "Release date"}]
    assert out["notes"][1]["who"] == "Yossi"
    assert out["thread"] == "They agreed a ship date."
    # The numbered lines reach the model, and it is told to answer with numbers
    # rather than times — the whole reason a made-up moment is impossible.
    assert "#0 [0:00] Dana:" in fake.user_of()
    assert "NUMBER" in fake.system_of()
    assert "Never write a time yourself" in fake.system_of()


@pytest.mark.asyncio
async def test_the_thread_from_the_previous_part_is_carried_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = set_replies(monkeypatch, FOUND)
    await rec_read.read_window(req(part=1, thread="Earlier they argued about scope."))
    assert "Earlier they argued about scope." in fake.user_of()
    assert "Part 2 of 2" in fake.user_of()


@pytest.mark.asyncio
async def test_an_unreadable_reply_retries_once_then_reports_the_window_lost(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = set_replies(monkeypatch, "not json at all", "still not json")
    out = await rec_read.read_window(req(thread="context so far"))
    assert len(fake.calls) == 2, "the single retry did not happen"
    assert out["skipped"] is True, "a lost window reported itself as read"
    assert out["chapters"] == [] and out["notes"] == []
    # The INCOMING thread flows on, so the next part still reads in context.
    assert out["thread"] == "context so far"


@pytest.mark.asyncio
async def test_a_retry_that_succeeds_keeps_the_window(monkeypatch: pytest.MonkeyPatch) -> None:
    set_replies(monkeypatch, "junk", FOUND)
    out = await rec_read.read_window(req())
    assert out["skipped"] is False
    assert len(out["notes"]) == 2


@pytest.mark.asyncio
async def test_a_fatal_engine_error_raises_so_the_job_can_park(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # OLLAMA_DOWN / MODEL_MISSING mean the whole read should park for Resume,
    # not quietly skip every window one at a time.
    set_replies(monkeypatch, llm.LlmError("OLLAMA_DOWN", "down"))
    with pytest.raises(llm.LlmError):
        await rec_read.read_window(req())


@pytest.mark.asyncio
async def test_a_transient_engine_error_costs_only_this_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    set_replies(monkeypatch, llm.LlmError("HTTP_500", "hiccup"), llm.LlmError("HTTP_500", "hiccup"))
    out = await rec_read.read_window(req())
    assert out["skipped"] is True


@pytest.mark.asyncio
async def test_half_a_reply_costs_the_broken_half_not_the_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Rust validates every turn number and drops what it cannot place, so being
    # forgiving here is safe — and losing a good list to a bad sibling is not.
    set_replies(
        monkeypatch,
        json.dumps({"chapters": "nonsense", "notes": [{"turn": 0, "kind": "decision", "text": "ok"}]}),
    )
    out = await rec_read.read_window(req())
    assert out["skipped"] is False
    assert out["chapters"] == []
    assert out["notes"] == [{"turn": 0, "kind": "decision", "text": "ok"}]


@pytest.mark.asyncio
async def test_an_empty_window_asks_the_model_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = set_replies(monkeypatch, FOUND)
    out = await rec_read.read_window(req(turns="   \n  "))
    assert fake.calls == [], "a silent stretch was sent to the model anyway"
    assert out["skipped"] is False


@pytest.mark.asyncio
async def test_the_window_is_clamped_in_bytes_not_characters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Rust counts bytes; clamping in characters would let a Hebrew meeting
    # overflow the budget it fits under on the other side.
    fake = set_replies(monkeypatch, FOUND)
    hebrew = "#0 [0:00] דנה: " + ("שלום " * 20_000)
    await rec_read.read_window(req(turns=hebrew))
    assert len(fake.user_of().encode()) < rec_read.TURNS_CAP + 4_000
