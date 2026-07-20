"""The whole-file PASS step endpoints (MIGRATION Phase 2, file_pass.rs).

No network, no Ollama: :func:`arcelle_sidecar.llm.generate` is monkeypatched
with a scripted fake, so every test asserts the exact prompt built, the parse/
clamp of the reply into the ``{result, thread, skipped}`` artifact, model_call's
single-retry, and the fatal-vs-transient error split the Rust host relies on.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from arcelle_sidecar import file_pass, llm
from arcelle_sidecar.server import create_app


# --- fake generate ----------------------------------------------------------


class FakeGenerate:
    """A scripted ``llm.generate``. Each call consumes the next reply (a string to
    return, or an Exception to raise) and records how it was invoked."""

    def __init__(self, *replies: Any) -> None:
        self.replies = list(replies)
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, model: str, messages: Any, base_url: str, **kwargs: Any) -> str:
        self.calls.append({"model": model, "messages": messages, "base_url": base_url, **kwargs})
        item = self.replies[len(self.calls) - 1] if len(self.calls) <= len(self.replies) else self.replies[-1]
        if isinstance(item, Exception):
            raise item
        return item

    @property
    def last_messages(self) -> list[dict[str, Any]]:
        return self.calls[-1]["messages"]

    def system_of(self, i: int = -1) -> str:
        return self.calls[i]["messages"][0]["content"]

    def user_of(self, i: int = -1) -> str:
        return self.calls[i]["messages"][-1]["content"]


@pytest.fixture
def gen(monkeypatch: pytest.MonkeyPatch) -> FakeGenerate:
    """Default: one successful reply per shape. Tests override ``.replies``."""
    fake = FakeGenerate()
    monkeypatch.setattr(llm, "generate", fake)
    return fake


def set_replies(monkeypatch: pytest.MonkeyPatch, *replies: Any) -> FakeGenerate:
    fake = FakeGenerate(*replies)
    monkeypatch.setattr(llm, "generate", fake)
    return fake


def client_for(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://sidecar")


# --- clamp_bytes / recover_json (byte-safe helpers) -------------------------


def test_clamp_bytes_never_splits_a_char() -> None:
    # "é" is 2 bytes in UTF-8; a 3-byte cap must drop the whole second char, not
    # half of it — matching agent.rs floor_boundary walking back to a boundary.
    assert file_pass.clamp_bytes("éé", 3) == "é"
    assert file_pass.clamp_bytes("éé", 4) == "éé"
    assert file_pass.clamp_bytes("abc", 10) == "abc"
    # A 4-byte emoji cut at 2 bytes yields nothing, never mojibake.
    assert file_pass.clamp_bytes("🙂x", 2) == ""


def test_recover_json_strips_fence_and_think() -> None:
    assert json.loads(file_pass.recover_json('```json\n{"a":1}\n```')) == {"a": 1}
    assert json.loads(file_pass.recover_json("<think>reasoning</think>{\"a\":2}")) == {"a": 2}
    # An unterminated think span truncates the rest — recover_json then finds no
    # brackets and returns "" (the caller's parse fails → retry/skip).
    assert file_pass.recover_json("<think>no end") == ""
    assert json.loads(file_pass.recover_json('{"a":3}')) == {"a": 3}


# --- map --------------------------------------------------------------------


async def test_map_merge_mode_builds_notes_prompt_and_artifact(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = set_replies(monkeypatch, json.dumps({"notes": "  dense notes  ", "thread": " a running thread "}))
    art = await file_pass.run_map(
        model="qwen3.5:9b",
        base_url="http://h:1",
        mode="merge",
        file_name="book.txt",
        instruction="summarize thoroughly",
        part=0,
        total=3,
        start=0,
        end=16000,
        text_len=40000,
        thread="",
        window_text="the text of part one",
    )
    # trimmed, not skipped, thread carried
    assert art == {"result": "dense notes", "thread": "a running thread", "skipped": False}
    # exact system + user prompt
    assert fake.system_of() == file_pass.MAP_SYSTEM_MERGE
    user = fake.user_of()
    assert user.startswith("File: book.txt\nGoal: summarize thoroughly\n")
    assert "This is part 1 of 3 — characters 0-16000 of 40000." in user
    assert "Thread from the earlier parts:\n(this is the first part)" in user
    assert "Text of THIS part:\nthe text of part one" in user
    # schema primed onto the last user turn, merge-mode "notes" key
    assert "Reply with ONLY JSON matching this schema" in user
    assert fake.calls[0]["format"]["required"] == ["notes", "thread"]
    assert fake.calls[0]["temperature"] == file_pass.PASS_TEMPERATURE


async def test_calls_pass_an_output_cap_to_stop_runaway_generation(monkeypatch: pytest.MonkeyPatch) -> None:
    # Every pass model call sets num_predict so a degenerate loop can't fill the
    # whole num_ctx window (~72 min on a 4B). Map uses the small notes cap; the
    # doc-level step (section) uses the larger one.
    fake = set_replies(monkeypatch,
                       json.dumps({"notes": "n", "thread": "t"}),   # map
                       json.dumps({"html": "<p>s</p>"}))             # section
    await file_pass.run_map(model="m", base_url="http://h:1", mode="merge", file_name="f",
                            instruction="i", part=0, total=1, start=0, end=10, text_len=10,
                            thread="", window_text="w")
    assert fake.calls[-1]["num_predict"] == file_pass.PASS_MAP_PREDICT
    await file_pass.run_section(model="m", base_url="http://h:1", instruction="g", file_name="f",
                                section=0, total=1, sections=["s"])
    assert fake.calls[-1]["num_predict"] == file_pass.PASS_DOC_PREDICT
    assert file_pass.PASS_MAP_PREDICT < file_pass.PASS_DOC_PREDICT


async def test_map_stitch_mode_uses_result_key_and_byte_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    big = "x" * 5000
    fake = set_replies(monkeypatch, json.dumps({"result": big, "thread": "t"}))
    art = await file_pass.run_map(
        model="m",
        base_url="http://h:1",
        mode="stitch",
        file_name="doc.txt",
        instruction="translate",
        part=1,
        total=2,
        start=100,
        end=200,
        text_len=300,
        thread="prev thread",
        window_text="short",  # 5 bytes → cap = max(15, PASS_NOTES_MAX) = PASS_NOTES_MAX
    )
    assert art["skipped"] is False
    assert len(art["result"].encode("utf-8")) == file_pass.PASS_NOTES_MAX
    assert fake.system_of() == file_pass.MAP_SYSTEM_STITCH
    assert fake.calls[0]["format"]["required"] == ["result", "thread"]
    # a carried thread replaces the "(this is the first part)" placeholder
    assert "Thread from the earlier parts:\nprev thread" in fake.user_of()


async def test_map_stitch_cap_grows_with_window(monkeypatch: pytest.MonkeyPatch) -> None:
    window = "y" * 2000  # 2000 bytes → cap = max(6000, PASS_NOTES_MAX) = 6000
    big = "z" * 9000
    set_replies(monkeypatch, json.dumps({"result": big, "thread": ""}))
    art = await file_pass.run_map(
        model="m", base_url="http://h:1", mode="stitch", file_name="f", instruction="i",
        part=0, total=1, start=0, end=2000, text_len=2000, thread="", window_text=window,
    )
    assert len(art["result"].encode("utf-8")) == 6000


async def test_map_thread_is_clamped(monkeypatch: pytest.MonkeyPatch) -> None:
    set_replies(monkeypatch, json.dumps({"notes": "n", "thread": "q" * 5000}))
    art = await file_pass.run_map(
        model="m", base_url="http://h:1", mode="merge", file_name="f", instruction="i",
        part=0, total=1, start=0, end=10, text_len=10, thread="", window_text="w",
    )
    assert len(art["thread"].encode("utf-8")) == file_pass.PASS_THREAD_MAX


async def test_map_double_parse_failure_falls_back_to_raw_window_text(monkeypatch: pytest.MonkeyPatch) -> None:
    # A double parse failure (e.g. a small model can't wrap code/CSV in the forced
    # JSON) no longer drops the window: the raw window text is used so the content
    # is still COVERED, and the incoming thread flows on for the next window.
    fake = set_replies(monkeypatch, "not json", "still not json")
    art = await file_pass.run_map(
        model="m", base_url="http://h:1", mode="merge", file_name="f", instruction="i",
        part=2, total=5, start=0, end=10, text_len=100, thread="carried context",
        window_text="the real content of this part",
    )
    assert art == {"result": "the real content of this part", "thread": "carried context", "skipped": False}
    assert len(fake.calls) == 2  # one retry


async def test_map_empty_window_with_failed_reply_is_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    # Only a GENUINELY empty window (no text to fall back to) is marked skipped.
    fake = set_replies(monkeypatch, "not json", "still not json")
    art = await file_pass.run_map(
        model="m", base_url="http://h:1", mode="merge", file_name="f", instruction="i",
        part=2, total=5, start=0, end=10, text_len=100, thread="carried context", window_text="   ",
    )
    assert art == {"result": "", "thread": "carried context", "skipped": True}
    assert len(fake.calls) == 2


async def test_map_retries_once_then_succeeds(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = set_replies(monkeypatch, "garbage", json.dumps({"notes": "recovered", "thread": "x"}))
    art = await file_pass.run_map(
        model="m", base_url="http://h:1", mode="merge", file_name="f", instruction="i",
        part=0, total=1, start=0, end=10, text_len=10, thread="", window_text="w",
    )
    assert art["result"] == "recovered"
    assert art["skipped"] is False
    assert len(fake.calls) == 2


async def test_map_fatal_error_propagates(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = set_replies(monkeypatch, llm.LlmError("OLLAMA_DOWN", "daemon down"))
    with pytest.raises(llm.LlmError) as ei:
        await file_pass.run_map(
            model="m", base_url="http://h:1", mode="merge", file_name="f", instruction="i",
            part=0, total=1, start=0, end=10, text_len=10, thread="", window_text="w",
        )
    assert ei.value.code == "OLLAMA_DOWN"
    assert len(fake.calls) == 1  # fatal: no retry


async def test_map_transient_engine_error_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = set_replies(
        monkeypatch,
        llm.LlmError("ENGINE_ERROR", "hiccup"),
        json.dumps({"notes": "ok", "thread": "t"}),
    )
    art = await file_pass.run_map(
        model="m", base_url="http://h:1", mode="merge", file_name="f", instruction="i",
        part=0, total=1, start=0, end=10, text_len=10, thread="", window_text="w",
    )
    assert art["result"] == "ok"
    assert len(fake.calls) == 2


async def test_map_empty_reply_falls_back_to_raw_window_text(monkeypatch: pytest.MonkeyPatch) -> None:
    # A valid-but-empty map reply (a small model returning {"notes": ""} on a hard
    # window) falls back to the raw window text so the content is still covered,
    # keeping the INCOMING thread flowing for the next window.
    fake = set_replies(monkeypatch, json.dumps({"notes": "  ", "thread": "ignored"}))
    art = await file_pass.run_map(
        model="m", base_url="http://h:1", mode="merge", file_name="f", instruction="i",
        part=3, total=6, start=0, end=10, text_len=100, thread="carried", window_text="raw part text",
    )
    assert art == {"result": "raw part text", "thread": "carried", "skipped": False}
    assert len(fake.calls) == 1  # parsed fine, no retry


# --- section (sectioned compose) --------------------------------------------


async def test_section_empty_sections_skips_without_a_model_call(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = set_replies(monkeypatch, RuntimeError("must not be called"))
    art = await file_pass.run_section(
        model="m", base_url="http://h:1", instruction="i", file_name="f",
        section=0, total=1, sections=[],
    )
    assert art == {"result": "", "thread": "", "skipped": True}
    assert fake.calls == []


async def test_section_builds_ordered_prompt_and_html(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = set_replies(monkeypatch, json.dumps({"html": "  <h2>Ch 3</h2><p>Functions.</p>  "}))
    art = await file_pass.run_section(
        model="m", base_url="http://h:1", instruction="the goal", file_name="book.txt",
        section=2, total=5, sections=["notes A", "notes B"], missing=1,
    )
    assert art == {"result": "<h2>Ch 3</h2><p>Functions.</p>", "thread": "", "skipped": False}
    user = fake.user_of()
    assert user.startswith("Goal: the goal\n\n")
    assert "section 3 of 5 of the file book.txt" in user
    assert "notes A\n\nnotes B" in user
    assert "(1 note-block(s) in this section were unreadable and are absent.)" in user
    assert fake.system_of() == file_pass.SECTION_SYSTEM
    assert fake.calls[0]["format"]["required"] == ["html"]


async def test_section_no_absent_line_when_zero_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = set_replies(monkeypatch, json.dumps({"html": "<p>ok</p>"}))
    await file_pass.run_section(
        model="m", base_url="http://h:1", instruction="g", file_name="f",
        section=0, total=1, sections=["a"], missing=0,
    )
    assert "unreadable and are absent" not in fake.user_of()


async def test_section_empty_reply_falls_back_to_raw_notes(monkeypatch: pytest.MonkeyPatch) -> None:
    # A valid-but-empty (or double-failed) section keeps the reading: the group's
    # raw notes are published rather than an empty section being dropped.
    set_replies(monkeypatch, json.dumps({"html": "   "}))
    art = await file_pass.run_section(
        model="m", base_url="http://h:1", instruction="g", file_name="f",
        section=0, total=1, sections=["alpha", "beta"],
    )
    assert art == {"result": "alpha\n\nbeta", "thread": "", "skipped": False}


async def test_section_result_is_clamped(monkeypatch: pytest.MonkeyPatch) -> None:
    set_replies(monkeypatch, json.dumps({"html": "h" * (file_pass.PASS_SECTION_MAX + 5000)}))
    art = await file_pass.run_section(
        model="m", base_url="http://h:1", instruction="g", file_name="f",
        section=0, total=1, sections=["s"],
    )
    assert len(art["result"].encode("utf-8")) == file_pass.PASS_SECTION_MAX


async def test_section_fatal_error_propagates(monkeypatch: pytest.MonkeyPatch) -> None:
    set_replies(monkeypatch, llm.LlmError("OLLAMA_DOWN", "down"))
    with pytest.raises(llm.LlmError) as ei:
        await file_pass.run_section(
            model="m", base_url="http://h:1", instruction="g", file_name="f",
            section=0, total=1, sections=["s"],
        )
    assert ei.value.code == "OLLAMA_DOWN"


# --- HTTP routes ------------------------------------------------------------


async def test_route_file_pass_map_returns_artifact(monkeypatch: pytest.MonkeyPatch) -> None:
    set_replies(monkeypatch, json.dumps({"notes": "n", "thread": "t"}))
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/file_pass_map",
            json={
                "model": "m", "base_url": "http://h:1", "mode": "merge",
                "file_name": "f", "instruction": "i", "part": 0, "total": 1,
                "start": 0, "end": 10, "text_len": 10, "thread": "", "window_text": "w",
            },
        )
    assert resp.status_code == 200
    assert resp.json() == {"result": "n", "thread": "t", "skipped": False}


async def test_route_file_pass_map_fatal_is_502_with_code(monkeypatch: pytest.MonkeyPatch) -> None:
    set_replies(monkeypatch, llm.LlmError("OLLAMA_DOWN", "down"))
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/file_pass_map",
            json={"model": "m", "base_url": "http://h:1", "mode": "merge", "file_name": "f",
                  "instruction": "i", "part": 0, "total": 1, "start": 0, "end": 10,
                  "text_len": 10, "thread": "", "window_text": "w"},
        )
    assert resp.status_code == 502
    assert resp.json()["code"] == "OLLAMA_DOWN"


async def test_route_file_pass_section_returns_artifact(monkeypatch: pytest.MonkeyPatch) -> None:
    set_replies(monkeypatch, json.dumps({"html": "<h2>Ch 1</h2><p>ok</p>"}))
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/file_pass_section",
            json={"model": "m", "base_url": "http://h:1", "instruction": "g",
                  "file_name": "f", "section": 0, "total": 2,
                  "sections": ["notes a", "notes b"], "missing": 0},
        )
    assert resp.status_code == 200
    assert resp.json() == {"result": "<h2>Ch 1</h2><p>ok</p>", "thread": "", "skipped": False}


async def test_route_file_pass_section_fatal_is_502(monkeypatch: pytest.MonkeyPatch) -> None:
    set_replies(monkeypatch, llm.LlmError("MODEL_MISSING", "not found"))
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/file_pass_section",
            json={"model": "m", "base_url": "http://h:1", "instruction": "g",
                  "file_name": "f", "section": 0, "total": 1, "sections": ["s"]},
        )
    assert resp.status_code == 502
    assert resp.json()["code"] == "MODEL_MISSING"
