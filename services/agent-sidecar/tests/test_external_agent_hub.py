"""Engine parity, end to end: the agent hub running ON a cloud CLI.

The user's report was "I don't see the agents / sub agents / domain agents when
the engine is Claude or Codex" — and they were right: a CLI engine used to skip
the hub entirely and drive the room itself as one opaque agent, so no roster
ever existed to show. These tests drive the REAL hub (``run_agent``) with a REAL
:class:`ExternalChatModel`, stubbing only the CLI subprocess, and assert the
same pipeline a local model produces: main agent → domain agent → report →
answer, with the roster events the agent strip renders.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from conftest import FakeMCP, drive, make_request

from arcelle_sidecar import external_llm


class _ScriptedCli:
    """The CLI, scripted: one queued stdout envelope per process spawn."""

    def __init__(self, replies: list[str]) -> None:
        self.replies = list(replies)
        self.prompts: list[str] = []
        #: What each round's --system-prompt-file actually contained. The tool
        #: catalog lives there now, not in the stdin prompt.
        self.systems: list[str] = []
        self._argv: tuple = ()
        self.returncode = 0
        #: This spawn's stdout, built when the prompt is written.
        self._pending: bytes = b""

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def fake_exec(*argv, **_kwargs):
            self._argv = argv
            return self

        monkeypatch.setattr(
            external_llm.asyncio, "create_subprocess_exec", fake_exec
        )

    # The seam drains real pipes now (silence, not elapsed time, is what stops a
    # CLI — see `external_llm.EXTERNAL_IDLE_SECS`), so this double presents
    # stdin/stdout/stderr instead of answering `communicate`. It emits the
    # STREAMED envelope the engine really produces: preamble events, then the
    # terminal `type: result` line.
    @property
    def stdin(self) -> "_ScriptedCli":
        return self

    def write(self, payload: bytes) -> None:
        cmdline = self._argv[2] if len(self._argv) > 2 else ""
        match = re.search(r"--system-prompt-file '([^']+)'", cmdline)
        # Read it while the call is still in flight — `_run` deletes it after.
        self.systems.append(
            Path(match.group(1)).read_text(encoding="utf-8") if match else ""
        )
        self.prompts.append((payload or b"").decode())
        reply = self.replies.pop(0) if self.replies else ""
        self._pending = (
            json.dumps({"type": "system", "subtype": "init"}).encode()
            + b"\n"
            + json.dumps({"type": "assistant", "message": {"content": []}}).encode()
            + b"\n"
            + json.dumps(
                {"type": "result", "result": reply, "usage": {"input_tokens": 100}}
            ).encode()
            + b"\n"
        )

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        return None

    @property
    def stdout(self) -> "_ScriptedCli":
        return self

    @property
    def stderr(self) -> "_Empty":
        return _Empty()

    async def read(self, _n: int = -1) -> bytes:
        out, self._pending = self._pending, b""
        return out

    async def wait(self) -> int:
        return self.returncode

    def kill(self) -> None:  # pragma: no cover - only the Stop path calls this
        pass


class _Empty:
    """A pipe that is immediately at EOF (this CLI writes no stderr)."""

    async def read(self, _n: int = -1) -> bytes:
        return b""


def _tool_call(name: str, **arguments) -> str:
    return json.dumps({"tool_calls": [{"name": name, "arguments": arguments}]})


@pytest.mark.asyncio
async def test_cli_engine_runs_the_same_main_agent_to_domain_agent_pipeline(
    monkeypatch,
) -> None:
    cli = _ScriptedCli(
        [
            # Main agent: delegate to the File agent.
            _tool_call("ask_file_agent", instruction="find what the contract says about rent"),
            # The File agent's own loop: read the room, then report.
            _tool_call("search_room", query="rent"),
            "The contract says the rent is 1200.",
            # Main agent: the one user-facing answer.
            "The rent is 1200.",
        ]
    )
    cli.install(monkeypatch)

    out = await drive(
        make_request("what does the contract say about rent", model="claude-cli"),
        external_llm.ExternalChatModel("claude-cli"),
        FakeMCP(),
    )

    # The roster the agent strip renders — the whole point of the report.
    plans = [e["v"] for e in out.of("plan")]
    assert [p["agent"] for p in plans[0]] == ["chat.answer"]
    assert [p["agent"] for p in plans[-1]] == ["files.read", "chat.answer"]
    walk = [(a["v"]["id"], a["v"]["step"], a["v"]["total"]) for a in out.of("agent")]
    # Two trailing main markers: the child's own completion flip, then the
    # batch collection (see test_main_agent_delegates_to_the_file_agent...).
    assert walk == [
        ("chat.answer", 1, 1),
        ("files.read", 1, 2),
        ("chat.answer", 2, 2),
        ("chat.answer", 2, 2),
    ]

    # The domain agent really ran a room tool through the bridge.
    assert [name for name, _args in out.mcp.calls] == ["search_room"]
    # Only the specialist's report crossed back into the main thread — read off
    # the last prompt, which is what this engine actually received.
    final_prompt = cli.prompts[-1]
    assert "Report from the File agent:" in final_prompt
    assert "The contract says the rent is 1200." in final_prompt
    assert out.final == "The rent is 1200."
    assert sum(1 for k in out.kinds if k == "final") == 1


@pytest.mark.asyncio
async def test_cli_main_agent_is_offered_specialists_and_no_room_tools(
    monkeypatch,
) -> None:
    cli = _ScriptedCli(["Hey! How can I help?"])
    cli.install(monkeypatch)

    out = await drive(
        make_request("hello", model="claude-cli"),
        external_llm.ExternalChatModel("claude-cli"),
        FakeMCP(),
    )

    # The hub's contract holds whoever the engine is: the main agent delegates,
    # it never touches the room itself.
    main_system = cli.systems[0]
    assert "ask_file_agent" in main_system
    assert "search_room" not in main_system
    assert out.final == "Hey! How can I help?"
    # A single-step turn still emits a 1-item roster, so the strip is never blank.
    assert [p["agent"] for p in out.of("plan")[0]["v"]] == ["chat.answer"]


@pytest.mark.asyncio
async def test_cli_worker_is_offered_room_tools_in_prompt_text(monkeypatch) -> None:
    cli = _ScriptedCli(
        [
            _tool_call("ask_file_agent", instruction="list the files"),
            "There are three files.",
            "There are three files.",
        ]
    )
    cli.install(monkeypatch)

    await drive(
        make_request("what files are here", model="claude-cli"),
        external_llm.ExternalChatModel("claude-cli"),
        FakeMCP(),
    )

    # The worker's prompt carries its scoped box — the tools the hub decided it
    # may use, rendered for an engine that has no tool-calling API of its own.
    worker_system = cli.systems[1]
    assert "list_room_files" in worker_system or "search_room" in worker_system
    assert '{"tool_calls":' in worker_system.replace(" ", "")
    # And the protocol explicitly disowns the CLI's OWN tools, which is what
    # made a worker answer "the tool list contains no search_mcp_tools".
    assert "NOT connected to this task" in worker_system
