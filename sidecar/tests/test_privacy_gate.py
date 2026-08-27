"""PRIV-1/PRIV-2 — the privacy gatekeeper.

The door is mechanical (privacy.py): redaction/restore must be exact, counted,
and engaged for every non-local model on every path out (llm.generate /
generate_stream, the agent chat model, the summarize client). The judgment
(privacy_scan.py) is a local model whose findings are verbatim-verified.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from arcelle_sidecar import llm, privacy, privacy_scan
from arcelle_sidecar.chat import OllamaChatModel
from arcelle_sidecar.messages import system_message, user_message


def make_policy(active: bool = True) -> privacy.PrivacyPolicy:
    return privacy.PrivacyPolicy(
        active=active,
        rules=[
            ("Ben Reich", "[Person A]"),
            ("Ben", "[Person B]"),
            ("12 Herzl St", "[Address A]"),
        ],
        concepts=["my health"],
    )


# --- detection ---------------------------------------------------------------


def test_nonlocal_detection() -> None:
    assert privacy.is_nonlocal_model("minimax-m3:cloud")
    assert privacy.is_nonlocal_model("qwen3.5:397b-instruct:cloud")
    assert not privacy.is_nonlocal_model("qwen3.5:4b")
    assert not privacy.is_nonlocal_model("cloud")  # a bare name is a local model
    # The CLI engines (double-colon separated composite ids) are non-local.
    sep = chr(58) * 2
    assert privacy.is_nonlocal_model(f"claude-cli{sep}opus")
    assert privacy.is_nonlocal_model(f"codex-cli{sep}gpt{sep}high")


# --- mechanics ---------------------------------------------------------------


def test_redact_longest_first_and_case_insensitive() -> None:
    p = make_policy()
    out = p.redact_text("BEN REICH lives at 12 herzl st. Ben was here.")
    assert out == "[Person A] lives at [Address A]. [Person B] was here."
    assert p.report.replacements == 3
    assert p.report.entities_hidden == 3


def test_restore_roundtrip_including_case_drift() -> None:
    p = make_policy()
    # Models sometimes echo placeholders in a different case.
    assert p.restore_text("[person a] met [Person B]") == "Ben Reich met Ben"


def test_redact_messages_strips_images_and_tool_call_args(policy=None) -> None:
    p = make_policy()
    msgs = [
        system_message("About Ben Reich"),
        {"role": "user", "content": "hello", "images": ["QUJD"]},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"function": {"name": "search_room", "arguments": {"q": "Ben Reich"}}}
            ],
        },
    ]
    out = p.redact_messages(msgs)
    assert out[0]["content"] == "About [Person A]"
    assert "images" not in out[1]
    assert p.report.images_blocked == 1
    assert out[2]["tool_calls"][0]["function"]["arguments"]["q"] == "[Person A]"
    # Non-mutating: originals untouched.
    assert msgs[1]["images"] == ["QUJD"]


def test_stream_restorer_rejoins_split_placeholder() -> None:
    p = make_policy()
    r = p.restorer()
    out = r.feed("met [Per") + r.feed("son A] at [Add") + r.feed("ress A]") + r.flush()
    assert out == "met Ben Reich at 12 Herzl St"


def test_stream_restorer_releases_plain_brackets() -> None:
    p = make_policy()
    r = p.restorer()
    # A lone '[' that can't be a placeholder must not buffer forever.
    text = "see [note 1] and [a very long bracketed aside that exceeds lengths]"
    out = r.feed(text) + r.flush()
    assert out == text


def test_guard_open_for_local_model_and_inactive_policy() -> None:
    p = make_policy()
    msgs = [user_message("Ben Reich")]
    same, imgs, engaged = privacy.guard_outbound("qwen3.5:4b", msgs, p, ["img"])
    assert engaged is None and same is msgs and imgs == ["img"]
    off = make_policy(active=False)
    same, imgs, engaged = privacy.guard_outbound("m:cloud", msgs, off, None)
    assert engaged is None and same is msgs


def test_add_rules_recompiles_and_dedupes() -> None:
    p = make_policy()
    p.add_rules([("Acme Corp", "[Hidden 1]"), ("ben reich", "[Hidden 2]")])
    out = p.redact_text("Ben Reich of Acme Corp")
    # The existing rule wins over the duplicate; the new entity redacts.
    assert out == "[Person A] of [Hidden 1]"


def test_ollama_writes_the_relay_marker_inside_the_tag_too() -> None:
    # Ollama tags its hosted entries BOTH ways. An exact ":cloud" suffix test
    # sees the first and calls the second a local model, which is the one
    # direction of error that costs the user their content.
    assert privacy.is_nonlocal_model("gpt-oss:120b-cloud")
    assert privacy.is_nonlocal_model("qwen3-coder:480b-cloud")
    assert privacy.is_nonlocal_model("qwen3-vl:235b-cloud")
    # A local tag that merely ends in the word stays local.
    assert not privacy.is_nonlocal_model("thundercloud")
    assert not privacy.is_nonlocal_model("nimbus:cloudy")


def test_door_engages_for_a_size_cloud_tag() -> None:
    p = make_policy()
    msgs = [user_message("Ben Reich")]
    send, imgs, engaged = privacy.guard_outbound("gpt-oss:120b-cloud", msgs, p, ["img"])
    assert engaged is p, "the door must engage for a relayed tag"
    assert imgs is None, "pixels must not ride along to a relayed model"
    assert "Ben Reich" not in send[0]["content"]


def test_door_engages_when_the_transport_is_relayed() -> None:
    # The Closet points a local-NAMED model at another computer. The name
    # cannot answer "does this leave the Mac"; Rust resolved it and said so.
    p = privacy.PrivacyPolicy(
        active=True, rules=[("Ben Reich", "[Person A]")], relayed=True
    )
    msgs = [user_message("Ben Reich")]
    send, imgs, engaged = privacy.guard_outbound("qwen3.5:4b", msgs, p, ["img"])
    assert engaged is p, "a relayed transport must engage the door"
    assert imgs is None
    assert "Ben Reich" not in send[0]["content"]


def test_relayed_flag_rides_the_wire() -> None:
    assert privacy.policy_from_payload({"active": True, "relayed": True}).relayed is True
    # Absent means "not relayed" — an older host that never sends it is unchanged.
    assert privacy.policy_from_payload({"active": True}).relayed is False


# --- the door on every path --------------------------------------------------


def payload() -> dict[str, Any]:
    return {
        "active": True,
        "rules": [{"real": "Ben Reich", "placeholder": "[Person A]"}],
        "concepts": [],
    }


async def test_llm_generate_cloud_path_redacts_and_restores(monkeypatch) -> None:
    seen: dict[str, Any] = {}

    async def fake_generate(self, messages, *, format=None, images=None):  # noqa: A002
        seen["messages"] = messages
        seen["images"] = images
        return "I met [Person A]."

    monkeypatch.setattr(OllamaChatModel, "generate", fake_generate)
    out = await llm.generate(
        "m:cloud",
        [user_message("Tell me about Ben Reich", images=["QUJD"])],
        "http://127.0.0.1:11434",
        privacy=payload(),
    )
    assert seen["messages"][0]["content"] == "Tell me about [Person A]"
    assert "images" not in seen["messages"][0] and seen["images"] is None
    assert out == "I met Ben Reich."


async def test_llm_generate_local_model_untouched(monkeypatch) -> None:
    seen: dict[str, Any] = {}

    async def fake_generate(self, messages, *, format=None, images=None):  # noqa: A002
        seen["messages"] = messages
        return "raw"

    monkeypatch.setattr(OllamaChatModel, "generate", fake_generate)
    await llm.generate(
        "qwen3.5:4b",
        [user_message("Tell me about Ben Reich")],
        "http://127.0.0.1:11434",
        privacy=payload(),
    )
    assert seen["messages"][0]["content"] == "Tell me about Ben Reich"


async def test_llm_generate_external_cli_redacts_and_restores(monkeypatch) -> None:
    from arcelle_sidecar import external_llm

    seen: dict[str, Any] = {}

    async def fake_external(model, messages, *, format=None):  # noqa: A002
        seen["messages"] = messages
        return "About [Person A]: fine."

    monkeypatch.setattr(external_llm, "generate_external", fake_external)
    sep = chr(58) * 2
    out = await llm.generate(
        f"claude-cli{sep}opus",
        [user_message("Who is Ben Reich?")],
        "http://127.0.0.1:11434",
        privacy=payload(),
    )
    assert seen["messages"][0]["content"] == "Who is [Person A]?"
    assert out == "About Ben Reich: fine."


async def test_llm_generate_stream_restores_split_placeholder(monkeypatch) -> None:
    async def fake_stream(self, messages, *, format=None, images=None):  # noqa: A002
        for chunk in ["Hello [Per", "son A]", " bye"]:
            yield chunk

    monkeypatch.setattr(OllamaChatModel, "generate_stream", fake_stream)
    parts = []
    async for delta in llm.generate_stream(
        "m:cloud",
        [user_message("hi")],
        "http://127.0.0.1:11434",
        privacy=payload(),
    ):
        parts.append(delta)
    assert "".join(parts) == "Hello Ben Reich bye"


async def test_summarize_client_engages_door(monkeypatch) -> None:
    from arcelle_sidecar import summarize

    seen: dict[str, Any] = {}

    class FakeResp:
        class message:  # noqa: N801 - mimic ollama response shape
            content = "notes on [Person A]"
            tool_calls: list[Any] = []

    class FakeClient:
        def __init__(self, host):  # noqa: D107
            pass

        async def chat(self, **kwargs):
            seen["messages"] = kwargs["messages"]
            return FakeResp()

    import ollama

    monkeypatch.setattr(ollama, "AsyncClient", FakeClient)
    client = summarize.OllamaModelClient("http://127.0.0.1:11434", payload())
    text = await client.generate(
        "m:cloud",
        [user_message("summarize Ben Reich's lease")],
        temperature=None,
        num_ctx=1024,
        keep_alive="30m",
    )
    assert "[Person A]" in seen["messages"][0]["content"]
    assert text == "notes on Ben Reich"


# --- the scanner -------------------------------------------------------------


def test_parse_findings_accepts_bare_list_shapes() -> None:
    # Small local models ignore the format grammar and answer with a bare
    # array — of dicts or of plain strings. Shape-tolerant, content-strict.
    chunk = "Ben Reich, phone 054-1234567, email ben@example.com"
    bare_strings = '["Ben Reich", "054-1234567", "ben@example.com", "Alice"]'
    found = privacy_scan._parse_findings(bare_strings, chunk)
    by_text = {f["text"]: f["category"] for f in found}
    assert set(by_text) == {"Ben Reich", "054-1234567", "ben@example.com"}
    assert by_text["054-1234567"] == "phone"
    assert by_text["ben@example.com"] == "email"
    bare_dicts = '[{"text": "Ben Reich", "category": "person"}]'
    found = privacy_scan._parse_findings(bare_dicts, chunk)
    assert found == [{"text": "Ben Reich", "category": "person"}]


def test_parse_findings_drops_hallucinations_and_bad_categories() -> None:
    chunk = "Ben Reich lives at 12 Herzl St."
    raw = (
        '{"entities": ['
        '{"text": "Ben Reich", "category": "person"},'
        '{"text": "Alice", "category": "person"},'
        '{"text": "12 Herzl St", "category": "made-up"},'
        '{"text": "B", "category": "person"}]}'
    )
    found = privacy_scan._parse_findings(raw, chunk)
    assert {f["text"] for f in found} == {"Ben Reich", "12 Herzl St"}
    by_text = {f["text"]: f["category"] for f in found}
    assert by_text["12 Herzl St"] == "concept"  # unknown category folds to concept


async def test_scan_refuses_nonlocal_model() -> None:
    with pytest.raises(ValueError):
        await privacy_scan.scan_text(
            "text", model="m:cloud", base_url="http://127.0.0.1:11434"
        )


async def test_scan_chunks_and_dedupes(monkeypatch) -> None:
    calls: list[str] = []

    async def fake_generate(model, messages, base_url, **kwargs):
        calls.append(messages[-1]["content"])
        return '{"entities": [{"text": "Ben Reich", "category": "person"}]}'

    monkeypatch.setattr(privacy_scan.llm, "generate", fake_generate)
    text = ("Ben Reich " + "x" * 200 + "\n") * 40  # forces multiple chunks
    scan = await privacy_scan.scan_text(
        text, model="qwen3.5:4b", base_url="http://127.0.0.1:11434"
    )
    assert len(calls) > 1
    assert scan.entities == [{"text": "Ben Reich", "category": "person"}]
    assert scan.complete and scan.chunks_failed == 0


async def test_scan_excludes_known(monkeypatch) -> None:
    async def fake_generate(model, messages, base_url, **kwargs):
        return '{"entities": [{"text": "Ben Reich", "category": "person"}]}'

    monkeypatch.setattr(privacy_scan.llm, "generate", fake_generate)
    scan = await privacy_scan.scan_text(
        "Ben Reich",
        model="qwen3.5:4b",
        base_url="http://127.0.0.1:11434",
        known=["ben reich"],
    )
    assert scan.entities == []


async def test_scan_keeps_what_it_found_when_a_chunk_fails(monkeypatch) -> None:
    """A failure part-way used to raise, losing every earlier chunk's findings —
    and the host reported it with the engine's wording ("local AI unreachable")
    for what was a timeout on one chunk of a long document."""
    calls = {"n": 0}

    async def flaky_generate(model, messages, base_url, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("read timeout")
        return '{"entities": [{"text": "Ben Reich", "category": "person"}]}'

    monkeypatch.setattr(privacy_scan.llm, "generate", flaky_generate)
    text = ("Ben Reich " + "x" * 200 + "\n") * 40
    scan = await privacy_scan.scan_text(
        text, model="qwen3.5:4b", base_url="http://127.0.0.1:11434"
    )
    assert scan.entities == [{"text": "Ben Reich", "category": "person"}]
    assert scan.chunks_failed == 1
    # …and it must NOT claim the document was read to the end, or the host
    # records the file as protected while its tail never was.
    assert scan.complete is False


@pytest.mark.parametrize("code", ["MODEL_MISSING", "OLLAMA_DOWN"])
async def test_scan_propagates_structural_engine_errors(monkeypatch, code) -> None:
    """A missing model/dead daemon applies to the whole run, not one file.

    Swallowing it once per chunk made the host retry every room file and report
    only a misleading count of incomplete documents.
    """

    async def unavailable_generate(model, messages, base_url, **kwargs):
        raise llm.LlmError(code, "engine unavailable")

    monkeypatch.setattr(privacy_scan.llm, "generate", unavailable_generate)
    with pytest.raises(llm.LlmError) as caught:
        await privacy_scan.scan_text(
            "Ben Reich", model="qwen3.5:4b", base_url="http://127.0.0.1:11434"
        )
    assert caught.value.code == code


async def test_scan_reports_itself_incomplete_when_capped(monkeypatch) -> None:
    """MAX_FINDINGS stops the pass mid-document. The host used to mark the file
    fully scanned anyway, so everything past the cap went to the cloud as-is."""
    monkeypatch.setattr(privacy_scan, "MAX_FINDINGS", 2)

    async def fake_generate(model, messages, base_url, **kwargs):
        return (
            '{"entities": [{"text": "Ben Reich", "category": "person"},'
            '{"text": "Alice Kay", "category": "person"},'
            '{"text": "Dana Levi", "category": "person"}]}'
        )

    monkeypatch.setattr(privacy_scan.llm, "generate", fake_generate)
    scan = await privacy_scan.scan_text(
        "Ben Reich Alice Kay Dana Levi",
        model="qwen3.5:4b",
        base_url="http://127.0.0.1:11434",
    )
    assert len(scan.entities) == 2
    assert scan.capped is True
    assert scan.complete is False


async def test_scan_cancellation_is_not_swallowed(monkeypatch) -> None:
    """`until_hangup` cancels this coroutine when the client disconnects — that
    is not a bad chunk to skip, it is the caller going away."""

    async def cancelled_generate(model, messages, base_url, **kwargs):
        raise asyncio.CancelledError

    monkeypatch.setattr(privacy_scan.llm, "generate", cancelled_generate)
    with pytest.raises(asyncio.CancelledError):
        await privacy_scan.scan_text(
            "Ben Reich", model="qwen3.5:4b", base_url="http://127.0.0.1:11434"
        )


def test_mint_ephemeral_rules_avoids_taken() -> None:
    taken = {"[Hidden 1]"}
    rules = privacy_scan.mint_ephemeral_rules(
        [{"text": "a", "category": "person"}, {"text": "b", "category": "concept"}],
        taken,
    )
    assert rules == [("a", "[Hidden 2]"), ("b", "[Hidden 3]")]


# --- audit: every content-bearing request model carries the policy ----------


def test_every_content_request_model_has_privacy_field() -> None:
    """A future endpoint that ships content without a privacy field would be a
    silent hole in the door — fail loudly here instead."""
    from arcelle_sidecar import ai_actions, config, file_pass, summarize

    models = [
        config.RunRequest,
        config.GenerateRequest,
        config.EmbedRequest,
        config.LabelRequest,
        config.FeedbackDraftRequest,
        config.VisionLocateRequest,
        config.KnowledgeExtractRequest,
        config.GenerateDocRequest,
        ai_actions.AiActionRequest,
        ai_actions.MemorySuggestionRequest,
        ai_actions.FileMetaRequest,
        file_pass.FilePassMapRequest,
        file_pass.FilePassSectionRequest,
        summarize.SummarizeFileRequest,
        summarize.CombineSummaryRequest,
    ]
    for m in models:
        assert "privacy" in m.model_fields, f"{m.__name__} lacks the privacy field"
