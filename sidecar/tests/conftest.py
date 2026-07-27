"""Test doubles: a scripted chat model and a recording MCP bridge.

No network, no Ollama, no weights. Every test in this suite runs in-process.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import pytest

from arcelle_sidecar.chat import RoundUsage
from arcelle_sidecar.config import McpConfig, RunRequest
from arcelle_sidecar.graph import CancelToken, Deps, Event, run_agent
from arcelle_sidecar.mcp_client import ToolResult, ToolSpec
from arcelle_sidecar.messages import Message, ToolCall

@pytest.fixture(autouse=True)
def _no_native_context_lookup(monkeypatch: pytest.MonkeyPatch):
    """Keep the suite network-free (SPEC §7): the payload-fitted num_ctx path
    consults Ollama's catalog for the model's native length on every local
    call — stub it to "unknown" so no test depends on a reachable daemon.
    Tests that care about the lookup patch ``arcelle_sidecar.chat.
    native_context_length`` themselves (their patch simply overwrites this one).
    """

    async def _none(model: str, base_url: str) -> int | None:
        return None

    monkeypatch.setattr("arcelle_sidecar.chat.native_context_length", _none)


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
    "list_memories",
    "list_skills",
    "read_skill",
    "read_skill_resource",
    "save_skill",
    "write_skill_resource",
    "run_skill_script",
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
    ) -> tuple[str, list[ToolCall], RoundUsage]:
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
        # No real engine behind this fake — every test exercises the
        # char-estimate fallback path unless a test overrides `stream` itself.
        usage = RoundUsage(input_tokens=None, output_tokens=None, max_context=8192, is_real=False)
        return rnd.content, calls, usage


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
    # A local model name engages small-model mode (single call per round +
    # progress re-injection); tests that need parallel calls in one round pass
    # a ':cloud' name to opt out, same as the product does.
    model: str = "qwen3.5:9b",
) -> RunRequest:
    return RunRequest(
        model=model,
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
    #: The worker sub-loop's FINAL AgentState (``drive_worker`` only; ``drive``
    #: goes through ``run_agent``, which returns text). The structural facts a
    #: shape test cares about — did the verify gate raise a correction, what
    #: landed in the referent baton, how many repair passes ran — live in state
    #: and are invisible in the event stream.
    state: dict[str, Any] = field(default_factory=dict)

    def of(self, kind: str) -> list[Event]:
        return [e for e in self.events if e["t"] == kind]

    @property
    def kinds(self) -> list[str]:
        return [e["t"] for e in self.events]

    @property
    def messages(self) -> list[Message]:
        """The PERSISTED thread as of the last round — i.e. what the last model
        round saw minus turn machinery: the ephemeral small-model progress note
        and the main agent's synthesis-kickoff note (both are pipeline plumbing,
        not conversation; tests that target them read ``chat.seen_messages``
        directly)."""
        seen = self.chat.seen_messages[-1] if self.chat.seen_messages else []
        return [
            m
            for m in seen
            if "Progress this turn" not in (m.get("content") or "")
            and "The Main agent delegated this task" not in (m.get("content") or "")
        ]


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


async def drive_worker(
    req: RunRequest,
    chat: FakeChatModel,
    mcp: FakeMCP | None = None,
    cancel: CancelToken | None = None,
    agent_id: str = "files.read",
    referents: list[str] | None = None,
) -> RunOutcome:
    """Run ONE worker sub-loop directly (hub v3): the loop-mechanics tests
    (catalog gating, duplicates, retries, budgets, prompts) target the WORKER
    graph — through ``run_agent`` they would first need the Main agent to
    delegate, which is a different contract (tested separately).

    Drives THIS agent's declared shape, not a shared one: `files.read` runs
    `react_verify`, `creator.studio` runs `oneshot`. A harness that pinned one
    graph would silently test the wrong wiring for every agent but one."""
    from arcelle_sidecar.graphs import graph_for

    mcp = mcp if mcp is not None else FakeMCP()
    cancel = cancel if cancel is not None else CancelToken()
    events: list[Event] = []

    async def emit(event: Event) -> None:
        events.append(event)

    deps = Deps(chat=chat, emit=emit, cancel=cancel, mcp=mcp)  # type: ignore[arg-type]
    write, ui, jobs, skills, connectors = req.resolved_routing()
    max_rounds = req.resolved_max_rounds(ui, jobs, skills, connectors)
    messages: list[Message] = [dict(m) for m in req.messages]  # type: ignore[misc]
    if req.question.strip() and not any(m.get("role") == "user" for m in messages):
        messages.append({"role": "user", "content": req.question})
    initial = {
        "question": req.question,
        "web_enabled": req.web_enabled,
        "write": write,
        "ui": ui,
        "jobs": jobs,
        "skills": skills,
        "connectors": connectors,
        "advisors": bool(req.advisors),
        "max_rounds": max_rounds,
        "run_max_rounds": max_rounds,
        "small_model": req.provider is None and ":cloud" not in req.model,
        "agent_id": agent_id,
        "plan_multi": False,
        "unlocked_groups": set(),
        # The baton a DELEGATED worker would be seeded with. `produced` stays
        # empty regardless — that is the distinction the write gate turns on.
        "referents": list(referents or []),
        "produced": [],
        "pipeline": [],
        "worker_base_messages": [],
        "messages": messages,
        "seen": set(),
        "force_synthesis": False,
        "round": 0,
        "calls": [],
        "pending_images": [],
        "final_text": "",
        "progress": [],
        "cancelled": False,
        "stop": False,
    }
    from arcelle_sidecar.graphs import recursion_limit_for

    final_state = await graph_for(agent_id).ainvoke(
        initial,
        config={
            "configurable": {"deps": deps},
            "recursion_limit": recursion_limit_for(agent_id, max_rounds),
        },
    )
    return RunOutcome(
        final=final_state.get("final_text", "") or "",
        events=events,
        chat=chat,
        mcp=mcp,
        cancel=cancel,
        state=dict(final_state),
    )


@pytest.fixture
def cancel() -> CancelToken:
    return CancelToken()
