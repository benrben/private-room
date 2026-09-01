"""SUMMARIZE feature (MIGRATION Phase 2): the map-reduce ported from
summarize.rs.

Three layers, all in-process (no network, no Ollama, no weights):
  * pure helpers (text windowing byte-for-byte, reply cleanup, arg parsing);
  * the map/reduce orchestration against a scripted fake model;
  * the /summarize_file and /combine_summary HTTP routes.
"""

from __future__ import annotations

import re
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from arcelle_sidecar import model_text, summarize
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


def test_smart_filter_noise_boundaries_measure_utf8_bytes() -> None:
    # Rust's boundary is bytes: 39 symbols are retained, while 40 are filtered.
    assert summarize.smart_filter("~" * 39) == "~" * 39 + "\n"
    assert summarize.smart_filter("~" * 40) == ""

    # An unbroken multi-byte word is also measured in bytes, not Python chars.
    assert summarize.smart_filter("א" * 40) == "א" * 40 + "\n"  # 80 bytes
    assert summarize.smart_filter("א" * 41) == ""  # 82 bytes


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


def test_clean_one_liner_cut_stops_at_a_sentence_or_a_word() -> None:
    # This line is the Room summary's file list AND what the assistant reads when
    # listing files, so a hard slice at exactly 200 ended it mid-word, unmarked.
    first = "A " + "long " * 30 + "lease agreement."  # ends well inside 200
    over = first + " " + "And then a second sentence that pushes it past the cap. " * 4
    cut = summarize.clean_one_liner(over)
    assert len(cut) <= summarize.ONE_LINER_MAX
    assert cut.endswith(".") and not cut.endswith("…")
    assert cut == first  # cut at the sentence end, no ellipsis needed

    # No sentence end in reach -> word boundary + a visible ellipsis.
    runon = "supercalifragilistic " * 30
    cut2 = summarize.clean_one_liner(runon)
    assert len(cut2) <= summarize.ONE_LINER_MAX
    assert cut2.endswith("…")
    assert cut2.rstrip("…").endswith("supercalifragilistic")  # never mid-word

    # A short line is untouched (no ellipsis, no cut).
    assert summarize.clean_one_liner("A lease.") == "A lease."


def test_clean_one_liner_truncation_boundaries() -> None:
    # A terminator at exactly half the limit is usable; one before it is not.
    usable = "x" * 99 + "." + " remaining words " * 20
    assert summarize.clean_one_liner(usable) == "x" * 99 + "."

    early = "x" * 98 + "." + " tail" * 30
    assert summarize.clean_one_liner(early).endswith("…")

    # A single unbroken word keeps one character free for the ellipsis.
    assert summarize.clean_one_liner("x" * 201) == "x" * 199 + "…"


def test_strip_think_spans() -> None:
    # The helper now lives in model_text (one copy for all six callers); the
    # assertions stay here because this module's reply parsing depends on them.
    assert model_text.strip_think_spans("<think>hmm</think>answer") == "answer"
    # An unterminated <think> truncates everything after it.
    assert model_text.strip_think_spans("visible<think>leaked") == "visible"


def test_recover_json_unwraps_fence_and_think() -> None:
    assert model_text.recover_json('```json\n{"a":1}\n```') == '{"a":1}'
    assert model_text.recover_json('<think>x</think> ["a","b"] trailing') == '["a","b"]'
    assert model_text.recover_json("no json here") == "no json here"


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


def test_read_window_max_is_64k() -> None:
    assert summarize.READ_WINDOW_MAX == 64_000


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


# --- OllamaModelClient's engine split --------------------------------------


def _privacy_payload() -> dict[str, Any]:
    return {"active": True, "rules": [{"real": "Ben Reich", "placeholder": "[Person A]"}]}


async def test_summarize_client_external_path_restores_a_private_reply(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_generate_external(model: str, messages: list[Any], *, format: Any = None) -> str:
        assert model == "claude-cli"
        assert messages == [{"role": "user", "content": "summarize [Person A]"}]
        assert format == {"type": "object"}
        return "notes on [Person A]"

    monkeypatch.setattr("arcelle_sidecar.external_llm.generate_external", fake_generate_external)
    client = summarize.OllamaModelClient("http://127.0.0.1:11434", _privacy_payload())
    text, calls = await client._chat(
        "claude-cli",
        [{"role": "user", "content": "summarize Ben Reich"}],
        tools=None,
        format={"type": "object"},
        temperature=None,
        num_ctx=None,
        keep_alive="30m",
        think_on=False,
    )
    assert text == "notes on Ben Reich"
    assert calls == []


async def test_summarize_client_provider_paths_restore_tools_and_classify_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from arcelle_sidecar import provider_api

    made: list[Any] = []

    class FakeProviderChat:
        def __init__(self, model: str, provider: Any, temperature: float | None) -> None:
            self.model = model
            self.provider = provider
            self.temperature = temperature
            made.append(self)

        async def stream(self, messages: list[Any], tools: list[Any], on_delta: Any) -> tuple[str, list[ToolCall], Any]:
            assert messages == [{"role": "user", "content": "find [Person A]"}]
            assert tools == [{"type": "function", "function": {"name": "search_room"}}]
            assert await on_delta("ignored") is None
            return "Found [Person A].", [ToolCall("search_room", {"q": "[Person A]"})], object()

        async def generate(self, messages: list[Any], *, format: Any = None) -> str:
            assert messages == [{"role": "user", "content": "find [Person A]"}]
            assert format == {"type": "object"}
            return "[Person A]'s summary"

    monkeypatch.setattr(provider_api, "OpenAICompatibleChatModel", FakeProviderChat)
    client = summarize.OllamaModelClient(
        "http://127.0.0.1:11434", _privacy_payload(), provider=object()
    )
    messages = [{"role": "user", "content": "find Ben Reich"}]
    text, calls = await client.chat_tools(
        "openrouter::vendor/model",
        messages,
        [{"type": "function", "function": {"name": "search_room"}}],
        temperature=0.2,
        num_ctx=8_192,
        keep_alive="30m",
    )
    assert text == "Found Ben Reich."
    assert [(call.name, call.arguments) for call in calls] == [("search_room", {"q": "Ben Reich"})]
    assert made[0].temperature == 0.2

    text = await client.generate(
        "openrouter::vendor/model",
        messages,
        temperature=None,
        num_ctx=8_192,
        keep_alive="30m",
        format={"type": "object"},
    )
    assert text == "Ben Reich's summary"

    class BrokenProviderChat(FakeProviderChat):
        async def generate(self, messages: list[Any], *, format: Any = None) -> str:
            raise RuntimeError("provider failed")

    monkeypatch.setattr(provider_api, "OpenAICompatibleChatModel", BrokenProviderChat)
    with pytest.raises(LlmError, match="provider failed") as caught:
        await client.generate(
            "openrouter::vendor/model",
            messages,
            temperature=None,
            num_ctx=8_192,
            keep_alive="30m",
        )
    assert caught.value.code == "ENGINE_ERROR"


async def test_summarize_client_local_path_sizes_requests_and_preserves_tool_wire_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ollama

    sent: list[dict[str, Any]] = []
    replies = [
        SimpleNamespace(
            message=SimpleNamespace(
                content="Found [Person A].",
                tool_calls=[
                    SimpleNamespace(function=SimpleNamespace(name="", arguments={})),
                    SimpleNamespace(
                        function=SimpleNamespace(name="search_room", arguments={"q": "[Person A]"})
                    ),
                ],
            )
        ),
        SimpleNamespace(message=SimpleNamespace(content=None, tool_calls=None)),
    ]

    class FakeAsyncClient:
        def __init__(self, host: str) -> None:
            assert host == "http://127.0.0.1:11434"

        async def chat(self, **kwargs: Any) -> Any:
            sent.append(kwargs)
            return replies.pop(0)

    async def native_context_length(model: str, base_url: str) -> int:
        assert (model, base_url) == ("qwen3:cloud", "http://127.0.0.1:11434")
        return 8_192

    monkeypatch.setattr(ollama, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(summarize, "native_context_length", native_context_length)
    client = summarize.OllamaModelClient("http://127.0.0.1:11434", _privacy_payload())
    text, calls = await client.chat_tools(
        "qwen3:cloud",
        [{"role": "user", "content": "find Ben Reich"}],
        [{"type": "function", "function": {"name": "search_room"}}],
        temperature=0.2,
        num_ctx=None,
        keep_alive="30m",
    )
    assert text == "Found Ben Reich."
    assert [(call.name, call.arguments, call.id) for call in calls] == [
        ("search_room", {"q": "Ben Reich"}, "call_1")
    ]
    assert sent[0]["messages"] == [{"role": "user", "content": "find [Person A]"}]
    assert sent[0]["options"] == {"num_ctx": 8_192, "temperature": 0.2}
    assert sent[0]["think"] is True
    assert sent[0]["stream"] is False

    text = await client.generate(
        "qwen3-instruct:latest",
        [{"role": "user", "content": "plain"}],
        temperature=None,
        num_ctx=1_024,
        keep_alive="30m",
    )
    assert text == ""
    assert sent[1]["options"] == {"num_ctx": 1_024}
    assert sent[1]["think"] is None


async def test_summarize_client_local_transport_failure_keeps_the_ollama_error_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ollama

    class FailedAsyncClient:
        def __init__(self, host: str) -> None:
            assert host == "http://127.0.0.1:11434"

        async def chat(self, **_kwargs: Any) -> Any:
            raise ConnectionRefusedError("refused")

    monkeypatch.setattr(ollama, "AsyncClient", FailedAsyncClient)
    client = summarize.OllamaModelClient("http://127.0.0.1:11434")
    with pytest.raises(LlmError, match="refused") as caught:
        await client.generate(
            "m",
            [{"role": "user", "content": "hello"}],
            temperature=None,
            num_ctx=1_024,
            keep_alive="30m",
        )
    assert caught.value.code == "OLLAMA_DOWN"


# --- summarize_one_file: whole (short) file ---------------------------------


async def test_summarize_short_file_one_call_no_reads() -> None:
    fake = FakeModelClient(generates=['{"summary":"A short lease agreement."}'])
    out = await summarize.summarize_one_file(fake, "m", "lease.txt", "text/plain", "Rent is $2000/mo.", "30m")
    assert out == "A short lease agreement."
    # No gather loop for a whole file; exactly one (final, schema) generate.
    assert fake.tool_calls_seen == []
    assert len(fake.generate_seen) == 1
    # The final call is schema-constrained without an app-imposed context tier.
    assert fake.generate_seen[0]["format"]["properties"]["summary"] == {"type": "string"}
    assert fake.generate_seen[0]["num_ctx"] is None


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
    assert fake.tool_calls_seen[0]["num_ctx"] is None


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


async def test_summarize_all_noise_file_is_not_described_from_its_name() -> None:
    # Everything is stripped by smart_filter (a base64 dump, a binary blob). The
    # model used to be asked "what is this file about?" with NO text attached,
    # so it guessed from the file NAME and the guess was stored as the file's
    # description. An empty one-liner is the honest answer; summarize.rs already
    # falls back to the mime type when the description is blank.
    junk = "\n".join(
        f"{i}QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk="
        for i in range(20)
    )
    assert summarize.smart_filter(junk).strip() == ""
    fake = FakeModelClient()
    out = await summarize.summarize_one_file(
        fake, "m", "Q3 revenue report.bin", "application/octet-stream", junk, "30m"
    )
    assert out == ""
    assert fake.generate_seen == [] and fake.tool_calls_seen == []  # no model call


async def test_summarize_samples_never_repeat_the_head_window() -> None:
    # Just past the 4 KB head, the "middle" and "end" samples both landed INSIDE
    # the head, so the same passage was sent three times and the file's real tail
    # was never shown.
    text = "".join(f"Sentence number {i} about the quarterly report.\n" for i in range(90))
    total = len(text.encode("utf-8"))
    assert summarize.READ_WINDOW_DEFAULT < total < 2 * summarize.READ_WINDOW_DEFAULT
    fake = FakeModelClient(tool_rounds=[("", [])], generates=['{"summary":"A report."}'])
    await summarize.summarize_one_file(fake, "m", "r.txt", "text/plain", text, "30m")
    user = fake.tool_calls_seen[0]["messages"][1]["content"]
    spans = [(int(a), int(b)) for a, b in re.findall(r"Characters (\d+)-(\d+) \(", user)]
    assert spans[0][0] == 0, "the first sample is still the head"
    assert all(nxt[0] >= cur[1] for cur, nxt in zip(spans, spans[1:])), spans
    assert spans[-1][1] == total, "the file's tail is still covered"


async def test_summarize_answers_every_tool_call_when_the_budget_runs_out() -> None:
    # A model that asks for several windows at once used to leave the calls past
    # the read budget with NO tool reply. A local Ollama shrugs that off; an
    # OpenAI-compatible provider rejects the turn and the summary fails.
    text = _long_text_with_manifest()
    batch = [
        ToolCall(name="read_text", arguments={"offset": i * 500, "limit": 300}, id=f"c{i}")
        for i in range(summarize.MAX_READS + 2)
    ]
    fake = FakeModelClient(
        tool_rounds=[("", batch)],
        generates=['{"summary":"A log file."}'],
    )
    await summarize.summarize_one_file(fake, "m", "big.log", "text/plain", text, "30m")
    sent = fake.generate_seen[0]["messages"]
    requested = sum(len(m.get("tool_calls") or []) for m in sent if m.get("role") == "assistant")
    answered = sum(1 for m in sent if m.get("role") == "tool")
    assert requested == len(batch)
    assert answered == requested, "every tool call must carry a reply"
    assert any("read budget for this file is used up" in m["content"] for m in sent if m.get("role") == "tool")


async def test_summarize_answers_an_unknown_tool_call() -> None:
    # A provider requires one reply for every announced call, including a call
    # outside the narrow read_text contract.
    text = _long_text_with_manifest()
    unknown = ToolCall(name="read_binary", arguments={}, id="unknown")
    fake = FakeModelClient(
        tool_rounds=[("", [unknown]), ("", [])],
        generates=['{"summary":"A log file."}'],
    )
    await summarize.summarize_one_file(fake, "m", "big.log", "text/plain", text, "30m")
    replies = [m["content"] for m in fake.generate_seen[0]["messages"] if m.get("role") == "tool"]
    assert replies == ["Unknown tool: only read_text is available."]


class _LocalModelClient(FakeModelClient):
    """A scripted fake that LOOKS local: it carries the Ollama base_url, so the
    gather budget can resolve the model's own native window."""

    base_url = "http://127.0.0.1:11434"


async def test_the_gather_budget_follows_the_model_not_the_mac(monkeypatch: Any) -> None:
    """`max_num_ctx()` is the biggest window this MAC may ask for; `pick_num_ctx`
    then clamps every actual call to the model's own native length. Budgeting the
    reads off the RAM ceiling alone gave a small-window model roughly double what
    fits, and an oversized prompt loses its FRONT — the system prompt and the
    instruction — so the summary came back rambling or empty with no error."""

    async def _tiny(model: str, base_url: str) -> int | None:
        return 8_192

    monkeypatch.setattr(summarize, "native_context_length", _tiny)
    assert await summarize._gather_window(_LocalModelClient(), "m") == 8_192
    # Nothing to size against — no base_url, a provider that states no window,
    # or a cloud CLI — keeps the ceiling, which is what those engines got before.
    assert await summarize._gather_window(FakeModelClient(), "m") == summarize.max_num_ctx()
    via_provider = _LocalModelClient()
    via_provider.provider = object()  # type: ignore[attr-defined]
    assert await summarize._gather_window(via_provider, "m") == summarize.max_num_ctx()
    assert await summarize._gather_window(_LocalModelClient(), "claude-cli") == summarize.max_num_ctx()


async def test_the_gather_budget_follows_a_providers_stated_window() -> None:
    """A cloud room's window is a published number, not a guess about this Mac.

    Budgeting an 8k OpenRouter model's reads off the RAM ceiling spent ~380 KB
    of file text on a window that holds a fraction of it; `_fit_one_shot` then
    cut the reads back on the provider side with nothing saying so, so the
    one-liner was written from a truncated read the app had called a full one.
    """

    class _Provider:
        context_window = 8_192

    small = FakeModelClient()
    small.provider = _Provider()  # type: ignore[attr-defined]
    assert await summarize._gather_window(small, "m") == 8_192

    class _Huge:
        context_window = 2_000_000

    # The RAM ceiling still caps: the gathered text is held in THIS process
    # before it is sent, so a provider window larger than the Mac's ceiling
    # cannot license a bigger read than a local model would get.
    huge = FakeModelClient()
    huge.provider = _Huge()  # type: ignore[attr-defined]
    assert await summarize._gather_window(huge, "m") == summarize.max_num_ctx()


async def test_a_small_window_model_reads_less_of_a_long_file(monkeypatch: Any) -> None:
    text = _long_text_with_manifest()

    def _scripted(cls: Any) -> Any:
        return cls(
            tool_rounds=[("", [_tc(offset=5_000, limit=summarize.READ_WINDOW_MAX)]), ("", [])],
            generates=['{"summary":"A log file."}'],
        )

    async def _tiny(model: str, base_url: str) -> int | None:
        return 8_192

    monkeypatch.setattr(summarize, "native_context_length", _tiny)
    small = _scripted(_LocalModelClient)
    await summarize.summarize_one_file(small, "m", "big.log", "text/plain", text, "30m")
    ceiling = _scripted(FakeModelClient)  # no base_url -> the RAM ceiling, as before
    await summarize.summarize_one_file(ceiling, "m", "big.log", "text/plain", text, "30m")

    def _read_bytes(fake: Any) -> int:
        tool_msgs = [m for m in fake.generate_seen[0]["messages"] if m.get("role") == "tool"]
        return len(tool_msgs[0]["content"].encode("utf-8"))

    assert _read_bytes(small) < _read_bytes(ceiling)


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
            summarize,
            "OllamaModelClient",
            lambda base_url, privacy=None, provider=None: fake,
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
