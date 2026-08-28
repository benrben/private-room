"""The HTTP surface (SPEC §4/§5): /health, the NDJSON stream, /cancel."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Awaitable, Callable

import httpx
import pytest
from conftest import FakeChatModel, FakeMCP, Round, call

from arcelle_sidecar import __version__, compaction, server, tts
from arcelle_sidecar.chat import RoundUsage, StreamStalled
from arcelle_sidecar.config import (
    AGENT_ROUND_BACKSTOP,
    CLOUD_WORKER_PARALLEL,
    RunRequest,
    TtsRequest,
)
from arcelle_sidecar.llm import LlmError
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


async def test_agents_answers_the_composer_menu_from_the_served_names() -> None:
    """POST /agents is what draws the composer's `*` menu. The host sends only
    tool NAMES and the room's web switch — no room content ever crosses — and
    gets back the specialists a turn could actually be handed."""
    from arcelle_sidecar.agents import ALL_REGISTRY_TOOLS

    app = app_with(FakeChatModel([]), FakeMCP())
    async with client_for(app) as c:
        resp = await c.post(
            "/agents",
            json={"web_enabled": True, "served_names": sorted(ALL_REGISTRY_TOOLS)},
        )
    assert resp.status_code == 200
    rows = resp.json()["agents"]
    assert len(rows) == 15
    assert {r["key"] for r in rows} >= {"file", "web"}
    # EVERY field, on every row: the host deserializes these into a struct with
    # no optional members (`agent.rs Specialist`), so a row missing one does not
    # degrade the menu — it fails the whole command and the composer shows "the
    # specialist list could not be read".
    assert all(
        {
            "key", "tool", "agent", "label", "area", "description",
            "capability", "capabilityReason", "localHandoff",
        } <= set(r) for r in rows
    )
    # One row per AGENT, not per domain: both internet workers are here, sharing
    # a domain tool and nothing else (owner report 2026-08-03 — the menu showed
    # only "web" and the room's browser was unreachable by name).
    by_key = {r["key"]: r for r in rows}
    assert by_key["web"]["agent"] == "chat.web"
    assert by_key["browse"]["agent"] == "chat.browse"
    assert by_key["browse"]["tool"] == by_key["web"]["tool"] == "ask_web_agent"
    assert by_key["browse"]["description"] != by_key["web"]["description"]


async def test_agents_offers_NEITHER_internet_specialist_to_an_offline_room() -> None:
    """The menu carries the room's own settings, not the registry's ceiling.

    Both rows, now that the browser has one of its own: a Browser agent offered
    to a web-off room is the same untruth the Web agent was, and it is the row
    that did not exist when this test was written.
    """
    from arcelle_sidecar.agents import ALL_REGISTRY_TOOLS

    app = app_with(FakeChatModel([]), FakeMCP())
    async with client_for(app) as c:
        resp = await c.post(
            "/agents",
            json={"web_enabled": False, "served_names": sorted(ALL_REGISTRY_TOOLS)},
        )
    rows = {r["key"]: r for r in resp.json()["agents"]}
    assert rows["web"]["capability"] == "unavailable"
    assert rows["browse"]["capability"] == "unavailable"
    assert rows["web"]["capabilityReason"] == "Turn on room internet"
    assert rows["browse"]["capabilityReason"] == "Turn on room internet"
    assert rows["file"]["capability"] == "full"


async def test_agents_on_a_bridge_that_served_nothing_returns_the_stable_catalog() -> None:
    """Capability discovery is stable even when every route is unavailable."""
    app = app_with(FakeChatModel([]), FakeMCP())
    async with client_for(app) as c:
        resp = await c.post("/agents", json={"web_enabled": True, "served_names": []})
    rows = resp.json()["agents"]
    assert len(rows) == 15
    assert all(r["capability"] == "unavailable" for r in rows)
    assert all(r["localHandoff"] for r in rows if r["key"] != "connector")


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
        # The child's report, kept so the diagram can still show it once the
        # next round has wiped the live text.
        "report",
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
    # Owner replacement #4: every line names its run, so the host can drop a
    # line that belongs to a different one.
    assert events[-1] == {"t": "final", "v": "The rent is 1200.", "run_id": "run-1"}
    assert all(e["run_id"] == "run-1" for e in events), "an unstamped line has no owner"
    assert mcp.closed is True  # the bridge client is released with the run


async def test_run_output_gate_redacts_local_final_and_unmapped_canary() -> None:
    """ARC-002: neither a local model nor a missing scanner rule bypasses it."""
    leak = "canary=abcDEF12345678"
    answer = f"Ben Reich; {leak}"
    mcp = FakeMCP()
    app = app_with(FakeChatModel([Round(content=answer)]), mcp)
    body = {
        **BODY,
        "question": "Do not use tools. Repeat the requested test answer.",
        "messages": [
            {"role": "system", "content": "Answer without tools."},
            {"role": "user", "content": "Repeat the requested test answer."},
        ],
        "routing": {"write": False, "ui": False, "jobs": False},
        "privacy": {
            "active": True,
            "rules": [{"real": "Ben Reich", "placeholder": "[Person A]"}],
        },
    }
    async with client_for(app) as c:
        resp = await c.post("/run", json=body)

    assert resp.status_code == 200
    assert "Ben Reich" not in resp.text
    assert leak not in resp.text
    assert "[Person A]" in resp.text
    assert "[Protected secret]" in resp.text
    assert mcp.list_calls == 0
    assert mcp.calls == []

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


async def test_every_line_names_the_run_it_belongs_to() -> None:
    """Owner replacement #4: identity travels on the wire, not on the screen.

    The host turns these lines into window events that ONE conversation paints,
    so a line that cannot say which run produced it can only be attributed by
    guessing — which is how an answer ended up streaming into whichever chat the
    user had since opened. Every exit of the stream is covered here because
    every one of them is a line the host will attribute: the graph's own events,
    the privacy receipt, and the terminal error.

    An id and nothing else. The chat id stays on the host — the sidecar is never
    told which conversation a run belongs to, and does not need to be.
    """
    chat = FakeChatModel([Round(content="", calls=[call("search_room", query="rent")]),
                          Round(content="The rent is 1200.")])
    app = app_with(chat, FakeMCP())
    async with client_for(app) as c:
        resp = await c.post("/run", json={**BODY, "run_id": "ask-77"})
    events = [json.loads(line) for line in resp.text.strip().split("\n") if line]
    assert events, "the run streamed nothing at all"
    unstamped = [e for e in events if e.get("run_id") != "ask-77"]
    assert not unstamped, f"these lines name no run: {unstamped}"


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
    assert events[-1] == {"t": "error", "v": "ollama is not running", "run_id": "run-1"}


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
    # `stopped` is empty AND `known` is false: a Stop for a run nobody has must
    # not read like a Stop that worked.
    assert resp.json() == {"ok": True, "known": False, "stopped": []}


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
            usage = RoundUsage(input_tokens=None, max_context=8192, is_real=False)
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
        # `stopped` names what the Stop reached: this run had no specialist out,
        # so the run itself is the whole of it.
        assert resp.json() == {"ok": True, "known": True, "stopped": ["this answer"]}
        release.set()
        await asyncio.wait_for(task, timeout=5)

    kinds = [e["t"] for e in events]
    assert "step" not in kinds  # the write_file call never ran
    assert mcp.calls == []
    assert chat.n == 1  # and no second round
    assert events[-1] == {"t": "final", "v": "partial", "run_id": "run-1"}


async def test_a_cloud_room_fans_out_but_not_unbounded(monkeypatch: Any) -> None:
    """How many delegated children may hold a model round at once.

    A LOCAL room pins 1 — one resident model, so concurrency is contention. A
    cloud room used to get `None`, meaning UNBOUNDED, so a plan with twenty
    tasks opened twenty PAID conversations in the same instant: a rate-limit
    wall and a cost spike, not twenty-way speed.
    """
    seen: list[int | None] = []

    async def spy(req: Any, deps_factory: Any) -> Any:
        async def emit(_event: Any) -> None:
            return None

        seen.append(deps_factory(emit).worker_parallel)
        yield {"t": "final", "v": ""}

    monkeypatch.setattr(server, "stream_events", spy)
    app = app_with(FakeChatModel([Round(content="hi")]), FakeMCP())
    async with client_for(app) as c:
        async with c.stream("POST", "/run", json=BODY) as resp:
            async for _line in resp.aiter_lines():
                pass
        async with c.stream("POST", "/run", json={**BODY, "model": "qwen3.5:cloud"}) as resp:
            async for _line in resp.aiter_lines():
                pass

    assert seen == [1, CLOUD_WORKER_PARALLEL]


async def test_a_stalled_run_still_ends_with_a_terminal_error_and_frees_the_run() -> None:
    """The exit path a LONG run actually takes.

    ``iter_with_stop`` raises :class:`StreamStalled` when a provider stream goes
    quiet, and that reaches the driver. It must put a terminal ``error`` event on
    the wire before the stream closes: the host reads that event (sidecar.rs
    ``Some("error")``) and keeps the partial the user watched arrive, whereas a
    stream that simply STOPS is byte-identical to a finished turn. The registry
    entry has to go with it too, or a later ``/cancel`` reports ``known`` for a
    run that no longer exists.
    """

    class Stalling(FakeChatModel):
        async def stream(
            self,
            messages: list[Message],
            tools: list[dict[str, Any]],
            on_delta: Callable[[str], Awaitable[None]],
            cancel: Any = None,
        ) -> Any:
            await on_delta("half an answer")
            raise StreamStalled

    app = app_with(Stalling([Round(content="")]), FakeMCP())
    events: list[dict[str, Any]] = []
    async with client_for(app) as c:
        async with c.stream("POST", "/run", json=BODY) as resp:
            async for line in resp.aiter_lines():
                if line:
                    events.append(json.loads(line))

    assert any(
        e["t"] == "delta" and e["v"] == "half an answer" for e in events
    ), "the partial has to be on the wire for the host to have anything to keep"
    assert not any(e["t"] == "final" for e in events), "a stall never produced an answer"
    assert events[-1]["t"] == "error", events[-1]
    assert events[-1]["v"], "an error event carrying no reason explains nothing"
    assert len(app.state.registry) == 0


def test_registry_lifecycle() -> None:
    from arcelle_sidecar.graph import CancelToken

    reg = RunRegistry()
    token = CancelToken()
    reg.register("a", token)
    assert reg.cancel("a") == ["this answer"]
    assert token.cancelled is True
    reg.release("a")
    assert reg.cancel("a") is None  # an ask that already finished
    assert len(reg) == 0


def test_cancelling_a_run_reports_the_specialists_it_stopped() -> None:
    """Owner replacement #3: one Stop, one truthful account of what it reached.

    The registry holds the ROOT of the run's cancel tree, so a Stop that lands
    while two specialists are mid-task has to say so — and must not re-report
    work a previous Stop already stopped.
    """
    from arcelle_sidecar.graph import CancelToken

    reg = RunRegistry()
    run = CancelToken()
    reg.register("a", run)
    files = run.child("File agent")
    web = run.child("Browser agent")

    assert reg.cancel("a") == ["this answer", "File agent", "Browser agent"]
    assert files.cancelled and web.cancelled

    # A second Stop stopped nothing — known, but with nothing to report.
    assert reg.cancel("a") == []


def test_run_request_defaults_and_routing_fallback() -> None:
    req = RunRequest(model="m", question="edit the lease")
    assert req.ollama_base_url == "http://127.0.0.1:11434"
    # No routing block from the host -> the sidecar runs the routers itself.
    assert req.resolved_routing() == (True, False, False, False, False)
    assert req.resolved_max_rounds() == AGENT_ROUND_BACKSTOP

    req2 = RunRequest(model="m", question="what is the rent", web_enabled=True, max_rounds=24)
    assert req2.resolved_max_rounds() == 24


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        (dict(), AGENT_ROUND_BACKSTOP),
        (dict(advisors=["cloud"]), AGENT_ROUND_BACKSTOP),
        (dict(web_enabled=True), AGENT_ROUND_BACKSTOP),
        (dict(web_enabled=True, max_rounds=8), 8),
        (dict(max_rounds=8), 8),
    ],
)
def test_resolved_max_rounds_over_the_plain_predicate(kwargs: dict, expected: int) -> None:
    # Every lane uses the same high backstop; an explicit test override still wins.
    req = RunRequest(model="m", question="q", **kwargs)
    assert req.resolved_max_rounds() == expected


def test_resolved_max_rounds_ignores_the_routing_flags_a_caller_still_passes() -> None:
    # The lane flags used to narrow this; nothing has read them since the
    # per-lane budgets were removed, so passing them changes nothing.
    req = RunRequest(model="m", question="q")
    assert req.resolved_max_rounds(True, True, True, True) == AGENT_ROUND_BACKSTOP
    assert req.resolved_max_rounds() == req.resolved_max_rounds(False, False)


def test_the_host_may_still_send_retired_run_fields() -> None:
    # `mcp_routes` was dropped from the model; the host is not being changed in
    # lockstep, so an unknown field must be ignored, not a 422.
    req = RunRequest.model_validate(
        {"model": "m", "question": "q", "mcp_routes": 3, "advisors": ["cloud"]}
    )
    assert not hasattr(req, "mcp_routes")
    assert req.advisors == ["cloud"]


@pytest.mark.parametrize(
    ("host_says", "expected"),
    [({"write": False}, False), ({"write": True}, True)],
)
def test_host_routing_wins_over_local_routing(host_says: dict, expected: bool) -> None:
    # The host's decision is authoritative so the two engines can never drift.
    req = RunRequest(model="m", question="edit the lease", routing=host_says)  # type: ignore[arg-type]
    assert req.resolved_routing()[0] is expected
    assert req.resolved_write() is expected


def test_the_agent_run_scans_the_question_for_one_lane_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`resolved_write` must not drag the other four routers along.

    The agent run reads the write lane and nothing else, but it used to ask for
    all five and subscript `[0]` — four full scans of every question whose
    answers went straight into the bin. Booby-trap the four so a revert to
    `resolved_routing()[0]` fails here instead of quietly costing the work.
    """
    from arcelle_sidecar import routing as routing_mod

    def trap(name: str):  # noqa: ANN202 - test-local
        def _boom(_question: str) -> bool:
            raise AssertionError(f"{name} was scanned for an answer nothing reads")

        return _boom

    for fn in ("wants_ui_tools", "wants_job_tools", "wants_skill_tools", "wants_mcp_management_tools"):
        monkeypatch.setattr(routing_mod, fn, trap(fn))

    assert RunRequest(model="m", question="edit the lease").resolved_write() is True
    assert RunRequest(model="m", question="what is a lease?").resolved_write() is False
    # The traps are live: the five-lane call really does pay for all of them,
    # which is what `resolved_routing()[0]` at the agent-run call site was doing.
    with pytest.raises(AssertionError):
        RunRequest(model="m", question="edit the lease").resolved_routing()
    # …so pin the call site too — this is the one place it mattered.
    import inspect
    from pathlib import Path

    from arcelle_sidecar import graph as graph_mod

    graph_src = Path(inspect.getfile(graph_mod)).read_text(encoding="utf-8")
    assert "req.resolved_write()" in graph_src
    assert "req.resolved_routing()" not in graph_src


# --- request bounds ---------------------------------------------------------


async def test_an_oversized_body_is_refused_before_it_is_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The cap is read when the app is built, so a small one can be pinned here.
    monkeypatch.setattr(server, "MAX_REQUEST_BYTES", 64)
    app = create_app()
    async with client_for(app) as c:
        over = await c.post("/cancel", json={"run_id": "x" * 200})
        under = await c.post("/cancel", json={"run_id": "short"})
    assert over.status_code == 413
    assert over.json()["code"] == "BODY_TOO_LARGE"
    # The bound refuses nothing a real caller sends.
    assert under.status_code == 200
    assert under.json() == {"ok": True, "known": False, "stopped": []}


def test_the_default_body_bound_is_far_above_a_real_request() -> None:
    # A base64 image or a file-pass window is the biggest body the app sends;
    # the bound exists to refuse the absurd, not to clamp a feature.
    assert server.MAX_REQUEST_BYTES >= 64 << 20


# --- who may drive the sidecar ----------------------------------------------


async def test_without_the_hosts_token_nothing_but_health_answers() -> None:
    # The port is loopback, but loopback is not a boundary: any other program
    # running as this user could start runs, generate text, search the web and
    # delete downloaded models. The room MCP bridge and hub_mcp have always
    # required a token; this one answered anybody.
    app = create_app(token="s3cret")
    async with client_for(app) as c:
        anon = await c.post("/cancel", json={"run_id": "x"})
        wrong = await c.post(
            "/cancel", json={"run_id": "x"}, headers={"authorization": "Bearer nope"}
        )
        right = await c.post(
            "/cancel", json={"run_id": "x"}, headers={"authorization": "Bearer s3cret"}
        )
        # The host's liveness probe runs before it knows anything and reveals
        # nothing, so it stays open — deliberately, not by omission.
        health = await c.get("/health")
    assert anon.status_code == 401
    assert anon.json()["code"] == "NO_TOKEN"
    assert wrong.status_code == 401
    assert right.status_code == 200
    assert right.json() == {"ok": True, "known": False, "stopped": []}
    assert health.status_code == 200


async def test_the_token_comes_from_the_environment_the_host_spawns_us_with(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(server.TOKEN_ENV, "from-env")
    async with client_for(create_app()) as c:
        assert (await c.post("/cancel", json={"run_id": "x"})).status_code == 401
        ok = await c.post(
            "/cancel", json={"run_id": "x"}, headers={"authorization": "Bearer from-env"}
        )
    assert ok.status_code == 200
    # No variable = open, which is how this repo's tests and a hand-run
    # `python -m arcelle_sidecar` reach it. The host always sets it.
    monkeypatch.delenv(server.TOKEN_ENV, raising=False)
    async with client_for(create_app()) as c:
        assert (await c.post("/cancel", json={"run_id": "x"})).status_code == 200


# --- Stop for the one-shot endpoints ----------------------------------------


class _Caller:
    """Just enough of a Starlette request for `until_hangup`: the hang-up check."""

    def __init__(self, *, gone: bool) -> None:
        self.gone = gone

    async def is_disconnected(self) -> bool:
        return self.gone


async def test_a_one_shot_call_is_cancelled_when_the_caller_hangs_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server, "_HANGUP_POLL_SECS", 0.01)
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def work() -> str:
        started.set()
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            cancelled.set()
            raise
        return "nobody is left to read this"

    with pytest.raises(server.ClientGone):
        await server.until_hangup(_Caller(gone=True), work())  # type: ignore[arg-type]
    assert started.is_set()
    # The point of the whole thing: the engine call really stops, so the local
    # model is not still generating for a caller that has gone.
    assert cancelled.is_set()


async def test_a_one_shot_call_that_finishes_returns_its_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server, "_HANGUP_POLL_SECS", 0.01)

    async def work() -> str:
        return "the summary"

    assert await server.until_hangup(_Caller(gone=False), work()) == "the summary"  # type: ignore[arg-type]


async def test_a_one_shot_call_surfaces_its_own_failure_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The wrapper must not swallow or reshape the engine's sentinel contract.
    monkeypatch.setattr(server, "_HANGUP_POLL_SECS", 0.01)

    async def work() -> str:
        raise LlmError("MODEL_MISSING", "model 'm' not found")

    with pytest.raises(LlmError) as caught:
        await server.until_hangup(_Caller(gone=False), work())  # type: ignore[arg-type]
    assert caught.value.code == "MODEL_MISSING"


# --- the spoken-voice defaults ----------------------------------------------


def test_the_tts_request_does_not_restate_the_voice_spec() -> None:
    # tts.py owns the product voice; a second copy here would silently win over
    # it, because this body is the one the app actually goes through.
    body = TtsRequest(text="hello")
    assert (body.voice, body.rate, body.pitch) == (
        tts.DEFAULT_VOICE,
        tts.DEFAULT_RATE,
        tts.DEFAULT_PITCH,
    )


# --- closing a room clears what the service still holds ----------------------


async def test_forget_drops_the_compaction_digests_and_reports_the_count() -> None:
    """The service outlives every room, so a lock has to be able to tell it.

    Without this route the compaction cache — boiled-down summaries of the
    room's own conversation — survived lock, room-switch and chat deletion, and
    nothing anywhere could clear it.
    """
    compaction.clear_cache()
    compaction._cache_put("hash-a", "…a digest of the room's chat…")
    compaction._cache_put("hash-b", "…another…")
    assert compaction.cache_size() == 2

    async with client_for(create_app()) as c:
        resp = await c.post("/forget", json={})

    assert resp.status_code == 200
    # A COUNT, never the digests: everything in that cache is room content.
    assert resp.json() == {"ok": True, "dropped": 2}
    assert compaction.cache_size() == 0
    # Idempotent — a second lock has nothing left to drop and says so.
    async with client_for(create_app()) as c:
        assert (await c.post("/forget", json={})).json()["dropped"] == 0
