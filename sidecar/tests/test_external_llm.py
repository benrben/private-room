"""Engine parity: the external-CLI generation backend (external_llm.py).

The contract mirrors Rust's external.rs — same engine-id split, same prompt
flattening, same CLI flags — so these tests pin that mirror down, plus the
llm.generate / summarize-client routing seams (subprocess mocked)."""

from __future__ import annotations

import asyncio

import pytest

from privateroom_sidecar import external_llm, llm
from privateroom_sidecar.external_llm import (
    build_cmdline,
    flatten_messages,
    is_external_model,
    split_external_model,
)


# ---------------------------------------------------------------- split/detect


def test_split_handles_bare_model_and_effort() -> None:
    assert split_external_model("codex-cli") == ("codex-cli", None, None)
    assert split_external_model("claude-cli") == ("claude-cli", None, None)
    assert split_external_model("codex-cli::gpt-5.6-sol") == (
        "codex-cli",
        "gpt-5.6-sol",
        None,
    )
    assert split_external_model("codex-cli::gpt-5.6-sol::high") == (
        "codex-cli",
        "gpt-5.6-sol",
        "high",
    )
    assert split_external_model("claude-cli::opus::xhigh") == (
        "claude-cli",
        "opus",
        "xhigh",
    )


def test_split_passes_local_ollama_names_through() -> None:
    # A single ":" is an Ollama tag, not the "::" engine separator.
    assert split_external_model("qwen3.5:4b") == ("qwen3.5:4b", None, None)
    assert split_external_model("minimax-m3:cloud") == ("minimax-m3:cloud", None, None)


def test_is_external_model_matches_rust_predicate() -> None:
    assert is_external_model("claude-cli")
    assert is_external_model("codex-cli::gpt-5.6-sol::max")
    assert not is_external_model("qwen3.5:4b")
    assert not is_external_model("minimax-m3:cloud")
    assert not is_external_model("nomic-embed-text")


# ---------------------------------------------------------------- prompt shape


def test_flatten_uses_rust_role_labels_and_answer_tail() -> None:
    prompt = flatten_messages(
        [
            {"role": "system", "content": "Be brief."},
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": "Hello"},
            {"role": "user", "content": "Translate this"},
        ],
        None,
    )
    assert "Instructions:\nBe brief." in prompt
    assert "User: Hi" in prompt
    assert "Assistant: Hello" in prompt
    assert prompt.rstrip().endswith("Reply with the answer only.")


def test_flatten_folds_schema_into_a_json_only_instruction() -> None:
    schema = {"type": "object", "properties": {"markdown": {"type": "string"}}}
    prompt = flatten_messages([{"role": "user", "content": "go"}], schema)
    assert "ONLY a single JSON object" in prompt
    assert '"markdown"' in prompt


# ---------------------------------------------------------------- cmdlines


def test_cmdline_claude_matches_rust_flags() -> None:
    assert build_cmdline("claude-cli", None, None) == "claude -p"
    assert (
        build_cmdline("claude-cli", "opus", "xhigh")
        == "claude -p --model 'opus' --effort 'xhigh'"
    )


def test_cmdline_codex_matches_rust_flags() -> None:
    assert (
        build_cmdline("codex-cli", None, None)
        == "codex exec --skip-git-repo-check -"
    )
    assert (
        build_cmdline("codex-cli", "gpt-5.6-sol", "high")
        == "codex exec --skip-git-repo-check --model 'gpt-5.6-sol' -c 'model_reasoning_effort=high' -"
    )


def test_cmdline_rejects_unknown_engine() -> None:
    with pytest.raises(ValueError):
        build_cmdline("gemini-cli", None, None)


# ---------------------------------------------------------------- subprocess


class _FakeProc:
    def __init__(self, stdout: bytes, stderr: bytes = b"", returncode: int = 0):
        self._out = stdout
        self._err = stderr
        self.returncode = returncode
        self.stdin_payload: bytes | None = None

    async def communicate(self, payload: bytes | None = None):
        self.stdin_payload = payload
        return self._out, self._err


@pytest.mark.asyncio
async def test_generate_external_pipes_prompt_and_strips_output(monkeypatch) -> None:
    seen: dict = {}

    async def fake_exec(*argv, **kwargs):
        seen["argv"] = argv
        return _FakeProc(b"  the answer \n")

    monkeypatch.setattr(external_llm.asyncio, "create_subprocess_exec", fake_exec)
    out = await external_llm.generate_external(
        "claude-cli::opus", [{"role": "user", "content": "hi"}]
    )
    assert out == "the answer"
    assert seen["argv"][0] == "zsh"
    assert seen["argv"][1] == "-ilc"
    assert seen["argv"][2] == "claude -p --model 'opus'"


@pytest.mark.asyncio
async def test_generate_external_raises_sentinel_on_failure(monkeypatch) -> None:
    async def fake_exec(*argv, **kwargs):
        return _FakeProc(b"", b"quota exhausted", returncode=1)

    monkeypatch.setattr(external_llm.asyncio, "create_subprocess_exec", fake_exec)
    with pytest.raises(llm.LlmError) as exc:
        await external_llm.generate_external(
            "codex-cli", [{"role": "user", "content": "hi"}]
        )
    assert exc.value.code == "ENGINE_ERROR"
    assert "quota exhausted" in exc.value.message


class _HangingProc:
    """A CLI subprocess that never returns from ``communicate`` — the wedge case
    the timeout guard exists for. ``kill``/``wait`` are cheap so the reap is fast."""

    def __init__(self) -> None:
        self.returncode: int | None = None
        self.killed = False

    async def communicate(self, payload: bytes | None = None):
        await asyncio.sleep(3600)  # hangs until the wait_for timeout cancels it
        return b"", b""

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    async def wait(self) -> int | None:
        return self.returncode


@pytest.mark.asyncio
async def test_generate_external_times_out_and_kills_the_process(monkeypatch) -> None:
    proc = _HangingProc()

    async def fake_exec(*argv, **kwargs):
        return proc

    monkeypatch.setattr(external_llm.asyncio, "create_subprocess_exec", fake_exec)
    # Shrink the ceiling so a wedged CLI trips the guard fast instead of hanging.
    monkeypatch.setattr(external_llm, "EXTERNAL_TIMEOUT_SECS", 0.1)

    with pytest.raises(llm.LlmError) as exc:
        await external_llm.generate_external(
            "claude-cli", [{"role": "user", "content": "hi"}]
        )
    assert exc.value.code == "ENGINE_ERROR"
    assert "timed out" in exc.value.message
    assert proc.killed  # the guard stopped the wedged subprocess


# ---------------------------------------------------------------- llm seams


@pytest.mark.asyncio
async def test_llm_generate_routes_external_models_to_the_cli(monkeypatch) -> None:
    async def fake_generate_external(model, messages, *, format=None):
        return "cli says hi"

    monkeypatch.setattr(external_llm, "generate_external", fake_generate_external)
    out = await llm.generate(
        "claude-cli::sonnet",
        [{"role": "user", "content": "hi"}],
        "http://127.0.0.1:11434",
    )
    assert out == "cli says hi"


@pytest.mark.asyncio
async def test_llm_generate_stream_yields_one_final_delta_for_external(
    monkeypatch,
) -> None:
    async def fake_generate_external(model, messages, *, format=None):
        return "whole reply"

    monkeypatch.setattr(external_llm, "generate_external", fake_generate_external)
    chunks = [
        c
        async for c in llm.generate_stream(
            "codex-cli",
            [{"role": "user", "content": "hi"}],
            "http://127.0.0.1:11434",
        )
    ]
    assert chunks == ["whole reply"]


@pytest.mark.asyncio
async def test_summarize_client_returns_text_and_no_tool_calls_for_external(
    monkeypatch,
) -> None:
    from privateroom_sidecar import summarize

    async def fake_generate_external(model, messages, *, format=None):
        return "a summary"

    # summarize's client imports the symbols lazily inside _chat.
    monkeypatch.setattr(
        "privateroom_sidecar.external_llm.generate_external", fake_generate_external
    )
    client = summarize.OllamaModelClient("http://127.0.0.1:11434")
    text, calls = await client.chat_tools(
        "claude-cli",
        [{"role": "user", "content": "summarize"}],
        [{"type": "function", "function": {"name": "read_text"}}],
        temperature=0.2,
        num_ctx=8192,
        keep_alive="30m",
    )
    assert text == "a summary"
    assert calls == []
