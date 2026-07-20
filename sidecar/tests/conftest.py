"""Test doubles: a scripted chat model and a recording MCP bridge.

No network, no Ollama, no weights. Every test in this suite runs in-process.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import pytest

from arcelle_sidecar.config import McpConfig, RunRequest
from arcelle_sidecar.graph import CancelToken, Deps, Event, run_agent
from arcelle_sidecar.mcp_client import ToolResult, ToolSpec
from arcelle_sidecar.messages import Message, ToolCall

#: The built-in catalog the room bridge serves in LocalEngine scope (SPEC §2.1).
BUILTIN_TOOL_NAMES = [
    "list_room_files",
    "search_room",
    "open_file",
    "mark_image",
    "annotate_file",
    "create_file",
    "edit_file",
    "edit_files",
    "write_file",
    "set_cells",
    "rename_file",
    "move_file",
    "add_memory",
    "web_search",
    "fetch_page",
    "ui_snapshot",
    "ui_act",
    "view_screenshot",
    "view_media_frame",
    "start_file_pass",
    "job_status",
]


def specs(names: list[str] | None = None) -> list[ToolSpec]:
    return [
        ToolSpec(name=n, description=f"{n} does a thing")
        for n in (names if names is not None else BUILTIN_TOOL_NAMES)
    ]


def call(_tool: str, /, **arguments: Any) -> ToolCall:
    # positional-only so `call("open_file", name="lease.pdf")` works.
    return ToolCall(name=_tool, arguments=dict(arguments), id=f"c_{_tool}")


@dataclass
class Round:
    """One scripted model turn."""

    content: str = ""
    calls: list[ToolCall] = field(default_factory=list)
    #: Runs while this round is "streaming" — used to press Stop mid-stream.
    on_stream: Callable[[], None] | None = None


class FakeChatModel:
    """Returns a scripted (content, tool_calls) per round and records what it was offered."""

    def __init__(self, rounds: list[Round]) -> None:
        self.rounds = rounds
        self.offered: list[list[dict[str, Any]]] = []
        self.seen_messages: list[list[Message]] = []
        #: the cancel token handed to each stream call — the loop must thread it
        #: through so Stop can break the token stream (F1), not just wait it out.
        self.cancels: list[Any] = []
        self.n = 0

    @property
    def offered_names(self) -> list[list[str]]:
        return [[t["function"]["name"] for t in tools] for tools in self.offered]

    async def stream(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]],
        on_delta: Callable[[str], Awaitable[None]],
        cancel: Any = None,
    ) -> tuple[str, list[ToolCall]]:
        self.offered.append(list(tools))
        self.seen_messages.append([dict(m) for m in messages])
        self.cancels.append(cancel)
        rnd = self.rounds[self.n] if self.n < len(self.rounds) else Round(content="fallback")
        self.n += 1
        if rnd.on_stream is not None:
            rnd.on_stream()
        if rnd.content:
            await on_delta(rnd.content)
        # A round offering zero tools must not be able to produce a tool call.
        calls = list(rnd.calls) if tools else []
        return rnd.content, calls


class FakeMCP:
    """Records tools/call and hands back scripted results."""

    def __init__(
        self,
        tools: list[ToolSpec] | None = None,
        results: dict[str, ToolResult] | None = None,
        default: ToolResult | None = None,
        on_call: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> None:
        self.tools = tools if tools is not None else specs()
        self.results = results or {}
        self.default = default or ToolResult(text="ok")
        self.on_call = on_call
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.list_calls = 0
        self.closed = False

    async def list_tools(self) -> list[ToolSpec]:
        self.list_calls += 1
        return list(self.tools)

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> ToolResult:
        self.calls.append((name, dict(arguments)))
        if self.on_call is not None:
            self.on_call(name, arguments)
        return self.results.get(name, self.default)

    async def aclose(self) -> None:
        self.closed = True


def make_request(
    question: str = "what does the contract say about rent",
    *,
    messages: list[Message] | None = None,
    web_enabled: bool = False,
    max_rounds: int | None = None,
    mcp_routes: int = 0,
    advisors: list[str] | None = None,
    routing: dict[str, bool] | None = None,
    run_id: str = "run-1",
) -> RunRequest:
    return RunRequest(
        model="qwen3.5:9b",
        question=question,
        messages=messages
        if messages is not None
        else [
            {"role": "system", "content": "You are the room assistant."},
            {"role": "user", "content": question},
        ],
        temperature=0.7,
        ollama_base_url="http://127.0.0.1:11434",
        mcp=McpConfig(url="http://127.0.0.1:53421/mcp", token="tok"),
        routing=routing,  # type: ignore[arg-type]
        web_enabled=web_enabled,
        max_rounds=max_rounds,
        mcp_routes=mcp_routes,
        advisors=advisors or [],
        run_id=run_id,
    )


@dataclass
class RunOutcome:
    final: str
    events: list[Event]
    chat: FakeChatModel
    mcp: FakeMCP
    cancel: CancelToken

    def of(self, kind: str) -> list[Event]:
        return [e for e in self.events if e["t"] == kind]

    @property
    def kinds(self) -> list[str]:
        return [e["t"] for e in self.events]

    @property
    def messages(self) -> list[Message]:
        """The message list as the LAST model round saw it."""
        return self.chat.seen_messages[-1] if self.chat.seen_messages else []


async def drive(
    req: RunRequest,
    chat: FakeChatModel,
    mcp: FakeMCP | None = None,
    cancel: CancelToken | None = None,
) -> RunOutcome:
    """Run the real compiled graph against the doubles."""
    mcp = mcp if mcp is not None else FakeMCP()
    cancel = cancel if cancel is not None else CancelToken()
    events: list[Event] = []

    async def emit(event: Event) -> None:
        events.append(event)

    deps = Deps(chat=chat, emit=emit, cancel=cancel, mcp=mcp)  # type: ignore[arg-type]
    final = await run_agent(req, deps)
    return RunOutcome(final=final, events=events, chat=chat, mcp=mcp, cancel=cancel)


@pytest.fixture
def cancel() -> CancelToken:
    return CancelToken()
