"""The HTTP surface (SPEC §4/§5): /health, the NDJSON stream, /cancel."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Awaitable, Callable

import httpx
import pytest
from conftest import FakeChatModel, FakeMCP, Round, call

from arcelle_sidecar import __version__
from arcelle_sidecar.chat import RoundUsage
from arcelle_sidecar.config import AGENT_ROUND_BACKSTOP, RunRequest
from arcelle_sidecar.messages import Message, ToolCall
from arcelle_sidecar.server import RunRegistry, create_app

BODY: dict[str, Any] = {
    "model": "qwen3.5:9b",
    "question": "edit the lease and fix the rent",
    "messages": [
        {"role": "system", "content": "You are the room assistant."},
        {"role": "user", "content": "edit the lease and fix the rent"},
    ],
    "temperature": 0.7,
    "ollama_base_url": "http://127.0.0.1:11434",
    "mcp": {"url": "http://127.0.0.1:53421/mcp", "token": "tok"},
    "routing": {"write": True, "ui": False, "jobs": False},
    "web_enabled": True,
    "max_rounds": 9,
    "run_id": "run-1",
}


def app_with(chat: Any, mcp: Any) -> Any:
    return create_app(chat_factory=lambda req: chat, mcp_factory=lambda req: mcp)


def client_for(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://sidecar"
    )


async def test_health() -> None:
    app = app_with(FakeChatModel([Round(content="hi")]), FakeMCP())
    async with client_for(app) as c:
        resp = await c.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "version": __version__}


async def test_run_streams_ndjson_in_order() -> None:
    chat = FakeChatModel(
        [
            Round(content="", calls=[call("ask_file_agent", instruction="find the rent")]),
            Round(content="looking", calls=[call("search_room", query="rent")]),
            Round(content="Found it; rent is 1200."),
            Round(content="The rent is 1200."),
        ]
    )
    mcp = FakeMCP()
    app = app_with(chat, mcp)

    lines: list[str] = []
    async with client_for(app) as c:
        async with c.stream("POST", "/run", json=BODY) as resp:
            assert resp.status_code == 200
            assert resp.headers["content-type"].startswith("application/x-ndjson")
            async for line in resp.aiter_lines():
                if line:
                    lines.append(line)

    events = [json.loads(line) for line in lines]
    assert [e["t"] for e in events] == [
        "plan",  # the Main agent, thinking
        "agent",
        "round",
        "usage",
        # The roster is emitted at DISPATCH — the whole batch of children is
        # launched as a unit, before any step chip.
        "plan",  # roster grew
        "agent",
        "step",  # Asked the File agent
        "lane",
        "round",
        "delta",
        "usage",
        "step",
        "step_status",
        "round",
        "delta",
        "usage",
        # A child FINISHED: its own roster slot flips to done the moment its
        # sub-loop ends — not when the parent gets round to collecting it, or a
        # fast sibling would keep pulsing until the slowest one returned.
        "plan",
        "agent",
        "step_status",
        # The Main agent is marked active once the whole batch is collected.
        "plan",  # the Main agent resumes
        "agent",
        "round",
        "delta",
        "usage",
        "final",
    ]
    lanes = [e for e in events if e["t"] == "lane"]
    assert lanes[0]["v"] == "Working on your files"
    steps = [e["v"] for e in events if e["t"] == "step"]
    assert steps == ["Asked the File agent", "Searched the room"]
    assert events[-1] == {"t": "final", "v": "The rent is 1200."}
    assert mcp.closed is True  # the bridge client is released with the run

async def test_every_line_is_one_json_object() -> None:
    chat = FakeChatModel(
        [Round(content="multi\nline\nanswer"), Round(content="multi\nline\nanswer")]
    )
    app = app_with(chat, FakeMCP())
    async with client_for(app) as c:
        resp = await c.post("/run", json=BODY)
    raw = resp.text
    assert raw.endswith("\n")
    for line in raw.strip().split("\n"):
        obj = json.loads(line)  # a newline inside a delta must not split a line
        assert "t" in obj
    assert json.loads(raw.strip().split("\n")[-1])["v"] == "multi\nline\nanswer"


async def test_a_failure_becomes_an_error_event_not_a_500() -> None:
    # The Rust host falls back to the native engine on an error event; a dropped
    # connection would just hang the ask.
    class Exploding:
        async def stream(
            self,
            messages: list[Message],
            tools: list[dict[str, Any]],
            on_delta: Callable[[str], Awaitable[None]],
            cancel: Any = None,
        ) -> tuple[str, list[ToolCall], RoundUsage]:
            raise RuntimeError("ollama is not running")

    app = app_with(Exploding(), FakeMCP())
    async with client_for(app) as c:
        resp = await c.post("/run", json=BODY)
    events = [json.loads(line) for line in resp.text.strip().split("\n")]
    assert resp.status_code == 200
    assert events[-1] == {"t": "error", "v": "ollama is not running"}


async def test_a_torn_down_run_never_looks_like_a_finished_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A BaseException out of run_agent used to leave a clean 200 whose body held only
    # the step chips: no `final`, no `error`. The driver re-raised CancelledError while
    # its `finally` still queued the sentinel, so the generator closed NORMALLY and
    # gather(return_exceptions=True) ate the exception. sidecar.rs then read that as
    # Done("") and `ask` persisted a zero-byte assistant row — a failure that read as
    # success, with no diagnostic anywhere (live QA 2026-07-30, the Yahoo/ETF task).
    from arcelle_sidecar import graph as graph_mod

    async def torn(req: Any, deps: Any) -> str:
        await deps.emit({"t": "step", "v": "Searched the web", "node": "main"})
        raise asyncio.CancelledError()

    monkeypatch.setattr(graph_mod, "run_agent", torn)

    app = app_with(FakeChatModel([Round(content="unused")]), FakeMCP())
    async with client_for(app) as c:
        resp = await c.post("/run", json=BODY)

    assert resp.status_code == 200
    events = [json.loads(line) for line in resp.text.strip().split("\n") if line]
    assert events, "a torn run streamed nothing at all"
    assert events[-1]["t"] == "error", (
        f"stream ended on {events[-1]['t']!r}: the host reads a stream with no "
        "`final` as a successful empty answer"
    )
    assert events[-1]["v"], "an error event with an empty message tells the user nothing"


async def test_cancel_unknown_run_is_a_no_op() -> None:
    app = app_with(FakeChatModel([Round(content="hi")]), FakeMCP())
    async with client_for(app) as c:
        resp = await c.post("/cancel", json={"run_id": "nobody"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "known": False}


async def test_cancel_stops_a_live_run() -> None:
    started = asyncio.Event()
    release = asyncio.Event()
    mcp = FakeMCP()

    class BlockingChat:
        def __init__(self) -> None:
            self.n = 0

        async def stream(
            self,
            messages: list[Message],
            tools: list[dict[str, Any]],
            on_delta: Callable[[str], Awaitable[None]],
            cancel: Any = None,
        ) -> tuple[str, list[ToolCall], RoundUsage]:
            self.n += 1
            await on_delta("partial")
            started.set()
            await release.wait()  # the user presses Stop right about here
            usage = RoundUsage(input_tokens=None, output_tokens=None, max_context=8192, is_real=False)
            return "partial", [ToolCall(name="write_file", arguments={"name": "x"}, id="c1")], usage

    chat = BlockingChat()
    app = app_with(chat, mcp)

    async with client_for(app) as c:
        events: list[dict[str, Any]] = []

        async def consume() -> None:
            async with c.stream("POST", "/run", json=BODY) as resp:
                async for line in resp.aiter_lines():
                    if line:
                        events.append(json.loads(line))

        task = asyncio.create_task(consume())
        await asyncio.wait_for(started.wait(), timeout=5)
        resp = await c.post("/cancel", json={"run_id": "run-1"})
        assert resp.json() == {"ok": True, "known": True}
        release.set()
        await asyncio.wait_for(task, timeout=5)

    kinds = [e["t"] for e in events]
    assert "step" not in kinds  # the write_file call never ran
    assert mcp.calls == []
    assert chat.n == 1  # and no second round
    assert events[-1] == {"t": "final", "v": "partial"}


def test_registry_lifecycle() -> None:
    from arcelle_sidecar.graph import CancelToken

    reg = RunRegistry()
    token = CancelToken()
    reg.register("a", token)
    assert reg.cancel("a") is True
    assert token.cancelled is True
    reg.release("a")
    assert reg.cancel("a") is False  # an ask that already finished
    assert len(reg) == 0


def test_run_request_defaults_and_routing_fallback() -> None:
    req = RunRequest(model="m", question="edit the lease")
    assert req.ollama_base_url == "http://127.0.0.1:11434"
    # No routing block from the host -> the sidecar runs the routers itself.
    assert req.resolved_routing() == (True, False, False, False, False)
    assert req.resolved_max_rounds(ui=False, jobs=False) == AGENT_ROUND_BACKSTOP

    req2 = RunRequest(model="m", question="what is the rent", web_enabled=True, max_rounds=24)
    assert req2.resolved_max_rounds(ui=False, jobs=False) == 24


@pytest.mark.parametrize(
    ("kwargs", "ui", "jobs", "expected"),
    [
        (dict(), False, False, AGENT_ROUND_BACKSTOP),
        (dict(mcp_routes=1), False, False, AGENT_ROUND_BACKSTOP),
        (dict(advisors=["cloud"]), False, False, AGENT_ROUND_BACKSTOP),
        (dict(web_enabled=True), False, False, AGENT_ROUND_BACKSTOP),
        (dict(), True, False, AGENT_ROUND_BACKSTOP),
        (dict(), False, True, AGENT_ROUND_BACKSTOP),
        (dict(web_enabled=True), False, False, AGENT_ROUND_BACKSTOP),
        (dict(web_enabled=True, max_rounds=8), False, False, 8),
        (dict(max_rounds=8), False, False, 8),
    ],
)
def test_resolved_max_rounds_over_the_plain_predicate(
    kwargs: dict, ui: bool, jobs: bool, expected: int
) -> None:
    # Every lane uses the same high backstop; an explicit test override still wins.
    req = RunRequest(model="m", question="q", **kwargs)
    assert req.resolved_max_rounds(ui=ui, jobs=jobs) == expected


@pytest.mark.parametrize(
    ("host_says", "expected"),
    [({"write": False}, False), ({"write": True}, True)],
)
def test_host_routing_wins_over_local_routing(host_says: dict, expected: bool) -> None:
    # The host's decision is authoritative so the two engines can never drift.
    req = RunRequest(model="m", question="edit the lease", routing=host_says)  # type: ignore[arg-type]
    assert req.resolved_routing()[0] is expected
