"""SUMMARIZE feature (MIGRATION Phase 2): the map-reduce ported from
summarize.rs.

Three layers, all in-process (no network, no Ollama, no weights):
  * pure helpers (text windowing byte-for-byte, reply cleanup, arg parsing);
  * the map/reduce orchestration against a scripted fake model;
  * the /summarize_file and /combine_summary HTTP routes.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from arcelle_sidecar import summarize
from arcelle_sidecar.llm import LlmError
from arcelle_sidecar.messages import ToolCall
from arcelle_sidecar.server import create_app


# --- pure helpers -----------------------------------------------------------


def test_smart_filter_keeps_prose_drops_junk() -> None:
    blob = "QmFzZTY0anVuaw" * 9  # 126-char unbroken run
    text = (
        "A normal sentence about a lease agreement.\n"
        f"{blob}\n"
        "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\n"
        "Another useful line."
    )
    f = summarize.smart_filter(text)
    assert "lease agreement" in f
    assert "Another useful line" in f
    assert "QmFzZTY0" not in f
    assert "~~~~" not in f


def test_smart_filter_collapses_repeats_and_blanks() -> None:
    text = (
        "Page header — Annual Report\nBody text one.\n\n\n\n"
        "Page header — Annual Report\nPage header — Annual Report\nBody text two."
    )
    f = summarize.smart_filter(text)
    assert f.count("Annual Report") == 2  # consecutive duplicate collapses
    assert "\n\n\n" not in f


def test_read_window_clamps_and_reports_bounds() -> None:
    data = ("abc " * 3000).encode()  # 12_000 bytes
    w = summarize.read_window(data, 0, 50, None)  # below MIN → clamped up
    assert w.offset == 0
    assert w.end == summarize.READ_WINDOW_MIN
    assert w.total == 12_000
    w = summarize.read_window(data, 11_900, 999_999, None)  # beyond MAX → hits end
    assert w.end == 12_000
    w = summarize.read_window(data, 999_999, 500, None)  # past end → empty tail
    assert w.offset == 12_000
    assert w.text == ""


def test_read_window_never_splits_multibyte_and_find_is_byte_exact() -> None:
    # A Hebrew needle in a multi-byte haystack: byte offsets stay on char
    # boundaries and the decoded window is always valid UTF-8 (Rust parity).
    prefix = "א" * 2_000  # 2 bytes/char → 4_000 bytes
    text = prefix + "the חוזה clause starts here"
    data = text.encode("utf-8")
    w = summarize.read_window(data, 0, 300, "חוזה")
    assert w.found
    assert "חוזה" in w.text
    assert data[w.offset: w.offset + 1] != b"\x80"  # never lands mid-char
    # A miss stays at the requested offset and says so.
    w2 = summarize.read_window(data, 0, 300, "no-such-phrase")
    assert not w2.found
    assert w2.offset == 0


def test_clean_one_liner() -> None:
    assert summarize.clean_one_liner("- A lease agreement.\nExtra") == "A lease agreement."
    assert summarize.clean_one_liner("\n\n  The résumé.  ") == "The résumé."
    assert summarize.clean_one_liner("```boxes\n{junk}\n```\nThe map.") == "The map."


def test_strip_think_spans() -> None:
    assert summarize.strip_think_spans("<think>hmm</think>answer") == "answer"
    # An unterminated <think> truncates everything after it.
    assert summarize.strip_think_spans("visible<think>leaked") == "visible"


def test_recover_json_unwraps_fence_and_think() -> None:
    assert summarize.recover_json('```json\n{"a":1}\n```') == '{"a":1}'
    assert summarize.recover_json('<think>x</think> ["a","b"] trailing') == '["a","b"]'
    assert summarize.recover_json("no json here") == "no json here"


def test_json_str_field() -> None:
    assert summarize.json_str_field('{"summary":"  hi  "}', "summary") == "hi"
    assert summarize.json_str_field("not json", "summary") is None
    assert summarize.json_str_field('{"summary":123}', "summary") is None


def test_parse_string_list_json_and_prose() -> None:
    assert summarize.parse_string_list('Sure: ["A", "B", "C"]') == ["A", "B", "C"]
    assert summarize.parse_string_list("1. Apple\n2. apple\n- Microsoft") == ["Apple", "Microsoft"]
    assert summarize.parse_string_list("<think>x</think>[\"x\"]") == ["x"]


def test_read_args_tolerates_model_typing() -> None:
    assert summarize.read_args({"offset": 500, "limit": 3000, "find": "clause"}) == (500, 3000, "clause")
    assert summarize.read_args({"offset": "12000", "limit": 2.5e3}) == (12_000, 2_500, None)
    assert summarize.read_args({"find": "  "}) == (0, summarize.READ_WINDOW_DEFAULT, None)


def test_num_ctx_tiers_and_job_chars() -> None:
    # Job ignores has_tools and is much larger than the no-tools Chat window.
    assert summarize._num_ctx_for(True, "job") == summarize._num_ctx_for(False, "job")
    assert summarize._num_ctx_for(False, "job") > summarize._num_ctx_for(False, "chat")
    assert summarize._job_context_chars() == summarize._num_ctx_for(True, "job") * 3


# --- a scripted fake model --------------------------------------------------


class FakeModelClient:
    """Scripts chat_tools rounds and generate replies (each may raise LlmError).

    Records every call's messages + num_ctx so the tests can assert the loop fed
    the tool results back and sized the windows at the right tier.
    """

    def __init__(
        self,
        *,
        tool_rounds: list[Any] | None = None,
        generates: list[Any] | None = None,
    ) -> None:
        self._tool_rounds = list(tool_rounds or [])
        self._generates = list(generates or [])
        self.tool_calls_seen: list[dict[str, Any]] = []
        self.generate_seen: list[dict[str, Any]] = []

    async def chat_tools(
        self, model: str, messages: list[Any], tools: list[Any], *, temperature: Any, num_ctx: int, keep_alive: str
    ) -> tuple[str, list[ToolCall]]:
        self.tool_calls_seen.append({"messages": [dict(m) for m in messages], "num_ctx": num_ctx})
        item = self._tool_rounds.pop(0)
        if isinstance(item, LlmError):
            raise item
        return item

    async def generate(
        self, model: str, messages: list[Any], *, temperature: Any, num_ctx: int, keep_alive: str, format: Any = None
    ) -> str:
        self.generate_seen.append(
            {"messages": [dict(m) for m in messages], "num_ctx": num_ctx, "format": format}
        )
        item = self._generates.pop(0)
        if isinstance(item, LlmError):
            raise item
        return item


def _tc(**args: Any) -> ToolCall:
    return ToolCall(name="read_text", arguments=dict(args), id="c0")


# --- summarize_one_file: whole (short) file ---------------------------------


async def test_summarize_short_file_one_call_no_reads() -> None:
    fake = FakeModelClient(generates=['{"summary":"A short lease agreement."}'])
    out = await summarize.summarize_one_file(fake, "m", "lease.txt", "text/plain", "Rent is $2000/mo.", "30m")
    assert out == "A short lease agreement."
    # No gather loop for a whole file; exactly one (final, schema) generate.
    assert fake.tool_calls_seen == []
    assert len(fake.generate_seen) == 1
    # The final call is schema-constrained at the Job tier.
    assert fake.generate_seen[0]["format"]["properties"]["summary"] == {"type": "string"}
    assert fake.generate_seen[0]["num_ctx"] == summarize._num_ctx_for(False, "job")


async def test_summarize_short_file_falls_back_to_raw_when_not_json() -> None:
    # A reply that isn't the JSON envelope still yields the sentence (not lost).
    fake = FakeModelClient(generates=["It is a lease agreement."])
    out = await summarize.summarize_one_file(fake, "m", "f.txt", "text/plain", "hello", "30m")
    assert out == "It is a lease agreement."


# --- summarize_one_file: long file, model drives read_text ------------------


def _long_text_with_manifest() -> str:
    head = (
        "NOTICE: this file's real content is described later. To learn what this "
        "file is, search for MANIFEST and read what follows it.\n\n"
    )
    body = "".join(f"Log entry {i}: heartbeat OK.\n" for i in range(400))
    manifest = "\nMANIFEST: This is the maintenance manual for the Zephyr-9 engine.\n"
    tail = "".join(f"Appendix row {i}: reserved.\n" for i in range(400))
    return head + body + manifest + tail


async def test_summarize_long_file_reads_past_first_window() -> None:
    text = _long_text_with_manifest()
    fake = FakeModelClient(
        tool_rounds=[
            ("", [_tc(find="MANIFEST", limit=400)]),  # round 1: go read the manifest
            ("", []),  # round 2: satisfied, no more calls
        ],
        generates=['{"summary":"The Zephyr-9 engine maintenance manual."}'],
    )
    out = await summarize.summarize_one_file(fake, "m", "big.log", "text/plain", text, "30m")
    assert out == "The Zephyr-9 engine maintenance manual."
    # The tool result fed back into round 2 actually contains the buried MANIFEST.
    round2_msgs = fake.tool_calls_seen[1]["messages"]
    tool_msgs = [m for m in round2_msgs if m.get("role") == "tool"]
    assert tool_msgs and "MANIFEST" in tool_msgs[0]["content"]
    # Gather rounds run at the big Job window.
    assert fake.tool_calls_seen[0]["num_ctx"] == summarize._num_ctx_for(True, "job")


async def test_summarize_long_file_dedupes_identical_reads() -> None:
    text = _long_text_with_manifest()
    same = _tc(offset=0, limit=300)
    fake = FakeModelClient(
        tool_rounds=[
            ("", [same]),  # round 1: reads window
            ("", [_tc(offset=0, limit=300)]),  # round 2: asks for the EXACT same window
            ("", []),  # round 3: gives up
        ],
        generates=['{"summary":"A log file."}'],
    )
    out = await summarize.summarize_one_file(fake, "m", "big.log", "text/plain", text, "30m")
    assert out == "A log file."
    # Round 3 saw the "already read" nudge for the duplicate.
    round3_tool_msgs = [m for m in fake.tool_calls_seen[2]["messages"] if m.get("role") == "tool"]
    assert any("already read" in m["content"] for m in round3_tool_msgs)


async def test_summarize_long_file_degrades_when_model_lacks_tool_support() -> None:
    # A non-transient error during the gather loop must NOT lose the summary: the
    # loop breaks and the final call still answers from the samples.
    text = _long_text_with_manifest()
    fake = FakeModelClient(
        tool_rounds=[LlmError("ENGINE_ERROR", "model does not support tools")],
        generates=['{"summary":"A machine log with an embedded manifest."}'],
    )
    out = await summarize.summarize_one_file(fake, "m", "big.log", "text/plain", text, "30m")
    assert out == "A machine log with an embedded manifest."
    assert len(fake.generate_seen) == 1  # final call still ran


async def test_summarize_long_file_propagates_ollama_down() -> None:
    text = _long_text_with_manifest()
    fake = FakeModelClient(tool_rounds=[LlmError("OLLAMA_DOWN", "refused")])
    with pytest.raises(LlmError) as ei:
        await summarize.summarize_one_file(fake, "m", "big.log", "text/plain", text, "30m")
    assert ei.value.code == "OLLAMA_DOWN"


async def test_summarize_final_call_gets_schema_prompt_priming() -> None:
    fake = FakeModelClient(generates=['{"summary":"x"}'])
    await summarize.summarize_one_file(fake, "m", "f.txt", "text/plain", "hi", "30m")
    last_user = [m for m in fake.generate_seen[0]["messages"] if m.get("role") == "user"][-1]
    assert "Reply with ONLY JSON matching this schema" in last_user["content"]


# --- combine_summary --------------------------------------------------------


async def test_combine_summary_purpose_and_questions() -> None:
    fake = FakeModelClient(
        generates=[
            "This room holds lease and tax documents for a rental property.",  # purpose
            '["What is the rent?", "When is tax due?", "Who is the landlord?"]',  # questions
        ]
    )
    purpose, questions = await summarize.combine_summary(
        fake, "m", "Apartment", ["Landlord is Acme LLC"], "- lease.pdf — a lease\n- w2.pdf — a tax form\n"
    )
    assert purpose == "This room holds lease and tax documents for a rental property."
    assert questions == ["What is the rent?", "When is tax due?", "Who is the landlord?"]
    # Purpose is free-text (no schema); questions is schema-constrained.
    assert fake.generate_seen[0]["format"] is None
    assert fake.generate_seen[1]["format"]["type"] == "array"
    # The memory note rode along in the context handed to both calls.
    assert "Landlord is Acme LLC" in fake.generate_seen[0]["messages"][-1]["content"]


async def test_combine_summary_strips_think_from_purpose() -> None:
    fake = FakeModelClient(generates=["<think>plan</think>A room of recipes.", "[]"])
    purpose, _ = await summarize.combine_summary(fake, "m", "R", [], "- soup.md — a recipe\n")
    assert purpose == "A room of recipes."


async def test_combine_summary_swallows_questions_error() -> None:
    # Rust unwrap_or_default: a failed questions call yields [], not an error.
    fake = FakeModelClient(generates=["A room of notes.", LlmError("ENGINE_ERROR", "boom")])
    purpose, questions = await summarize.combine_summary(fake, "m", "R", [], "- n.md — a note\n")
    assert purpose == "A room of notes."
    assert questions == []


async def test_combine_summary_propagates_purpose_error() -> None:
    # Rust `?` on the purpose call: its failure aborts (no summary written).
    fake = FakeModelClient(generates=[LlmError("OLLAMA_DOWN", "refused")])
    with pytest.raises(LlmError) as ei:
        await summarize.combine_summary(fake, "m", "R", [], "- n.md — a note\n")
    assert ei.value.code == "OLLAMA_DOWN"


# --- HTTP routes ------------------------------------------------------------


def _client(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://sidecar")


@pytest.fixture
def patch_model(monkeypatch: pytest.MonkeyPatch):
    """Swap the real Ollama-backed client for a scripted fake in the routes."""

    def install(fake: FakeModelClient) -> None:
        monkeypatch.setattr(
            summarize, "OllamaModelClient", lambda base_url, privacy=None: fake
        )

    return install


async def test_route_summarize_file_ok(patch_model: Any) -> None:
    patch_model(FakeModelClient(generates=['{"summary":"A lease."}']))
    app = create_app()
    async with _client(app) as c:
        resp = await c.post(
            "/summarize_file",
            json={"model": "m", "name": "lease.txt", "mime": "text/plain", "text": "rent", "base_url": "http://h:1"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"summary": "A lease."}


async def test_route_summarize_file_engine_error_is_502(patch_model: Any) -> None:
    patch_model(FakeModelClient(generates=[LlmError("MODEL_MISSING", "model 'm' not found")]))
    app = create_app()
    async with _client(app) as c:
        resp = await c.post(
            "/summarize_file",
            json={"model": "m", "name": "f.txt", "text": "hi", "base_url": "http://h:1"},
        )
    assert resp.status_code == 502
    assert resp.json()["code"] == "MODEL_MISSING"


async def test_route_combine_summary_ok(patch_model: Any) -> None:
    patch_model(FakeModelClient(generates=["The purpose.", '["a","b","c"]']))
    app = create_app()
    async with _client(app) as c:
        resp = await c.post(
            "/combine_summary",
            json={
                "model": "m",
                "room_name": "Room",
                "memories": [],
                "file_lines": "- a.txt — a file\n",
                "base_url": "http://h:1",
            },
        )
    assert resp.status_code == 200
    assert resp.json() == {"purpose": "The purpose.", "questions": ["a", "b", "c"]}


async def test_route_combine_summary_purpose_error_is_502(patch_model: Any) -> None:
    patch_model(FakeModelClient(generates=[LlmError("OLLAMA_DOWN", "refused")]))
    app = create_app()
    async with _client(app) as c:
        resp = await c.post(
            "/combine_summary",
            json={"model": "m", "room_name": "R", "file_lines": "- a.txt — a file\n", "base_url": "http://h:1"},
        )
    assert resp.status_code == 502
    assert resp.json()["code"] == "OLLAMA_DOWN"
