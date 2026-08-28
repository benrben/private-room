"""END-TO-END: real user asks, driven through the REAL compiled graphs.

The rest of the suite tests mechanisms — one router, one predicate, one node.
This file tests ERRANDS: the things a person actually types into this app, each
run through `run_agent` (the Main agent's real supervisor graph), delegating to
real worker graphs, over a fake room whose tools behave the way the Rust bridge
behaves. Nothing here stubs a node or a router.

Why deterministic rather than live: `tests/e2e_live/` already drives a real
Ollama and is the right place for "does a 4B actually choose this". These run on
every commit, so what they pin is what must NEVER regress no matter which model
is behind the seam — the shape of a multi-step errand, and above all that the
app does not tell the user something untrue.

Each test names the errand in plain words, then asserts on what the USER would
see: the final answer, the agent strip, and whether a claim was backed.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

import pytest
from conftest import FakeMCP, drive, make_request, specs

from arcelle_sidecar.chat import RoundUsage
from arcelle_sidecar.mcp_client import ToolResult
from arcelle_sidecar.messages import Message, ToolCall

# --------------------------------------------------------------------------- #
# a fake room that behaves like the Rust bridge
# --------------------------------------------------------------------------- #

#: Everything a fully-served LOCAL room offers, derived from the registry
#: rather than hand-listed. A hand-listed catalog silently drifts from the real
#: verb names — the first draft of this file served `make_flashcards`, which is
#: not a tool, so `creator.studio`'s box never intersected the room and every
#: Studio errand was routed to the File agent instead. Deriving it means the
#: room automatically serves any tool a new agent declares.
def _room_catalog() -> list[str]:
    from arcelle_sidecar.agents import ALL_REGISTRY_TOOLS, AGENT_TOOL_NAMES, BATCH_TOOL_NAME

    hub_internal = set(AGENT_TOOL_NAMES) | {BATCH_TOOL_NAME, "request_tools"}
    return sorted(ALL_REGISTRY_TOOLS - hub_internal)


ROOM_TOOLS = _room_catalog()


class Room(FakeMCP):
    """A room whose tools answer like the real ones, and remember writes.

    Deliberately stateful: the whole point of an errand test is that step two
    can see what step one did, which a `results={}` dict cannot express.
    """

    def __init__(self, files: dict[str, str] | None = None, **kw: Any) -> None:
        super().__init__(tools=specs(ROOM_TOOLS), **kw)
        self.files: dict[str, str] = dict(files or {})
        self.sent: list[dict[str, Any]] = []
        self.fail: set[str] = set()

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> ToolResult:
        self.calls.append((name, dict(arguments)))
        if name in self.fail:
            return ToolResult(text=f"{name} failed: the room refused", is_error=True)

        if name == "list_room_files":
            return ToolResult(text=", ".join(sorted(self.files)) or "(empty room)")
        if name == "search_room":
            q = str(arguments.get("query", "")).lower()
            hits = [f"{n}: {t}" for n, t in self.files.items() if q in t.lower()]
            return ToolResult(text="\n".join(hits) or "no matches")
        if name == "open_file":
            n = str(arguments.get("name", ""))
            match = next((k for k in self.files if n.lower() in k.lower()), None)
            return ToolResult(
                text=self.files[match] if match else f"no file matching {n!r}"
            )
        if name in ("create_file", "write_file"):
            self.files[str(arguments.get("name"))] = str(arguments.get("content", ""))
            return ToolResult(text=f"saved {arguments.get('name')}")
        if name == "edit_files":
            for e in arguments.get("edits") or []:
                if isinstance(e, dict) and e.get("name"):
                    self.files.setdefault(str(e["name"]), "")
            return ToolResult(text="applied atomically")
        if name == "run_mcp_tool":
            self.sent.append(dict(arguments))
            return ToolResult(text=f"{arguments.get('tool')} ok")
        if name == "web_search":
            return ToolResult(text="boi.org.il — the rate is 4.25%")
        if name == "fetch_page":
            return ToolResult(text="Effective 2026-07-07 the rate is 4.25% (boi.org.il)")
        if name == "stt_status":
            return ToolResult(text="speech model ready (whisper-large)")
        return ToolResult(text=f"{name} ok")


# --------------------------------------------------------------------------- #
# a scripted engine addressed by AGENT, not by call index
# --------------------------------------------------------------------------- #


class Engine:
    """Answers by WHO is asking — parallel children interleave, so a flat
    positional script (``FakeChatModel``) cannot express a multi-agent errand.

    A script is ``{agent_key: [turn, turn, ...]}`` where a turn is either a list
    of ToolCalls or a string. Anything past the end of an agent's script becomes
    a plain text answer, so a shape that inserts an extra round (a verify gate, a
    repair pass, a re-offered stage) degrades to "answer" instead of desyncing.
    """

    def __init__(self, script: dict[str, list[Any]], allow_drift: bool = False) -> None:
        self.script = script
        #: Normally a scripted call the round was not offered is dropped, so a
        #: narrowed catalog cannot desync the script. A DRIFT test needs the
        #: opposite: it is checking what the graph does when the model emits a
        #: tool it was never given.
        self.allow_drift = allow_drift
        self.turns: dict[str, int] = {}
        self.offered: list[list[dict[str, Any]]] = []
        self.seen_messages: list[list[Message]] = []
        self.seen_by: dict[str, list[list[Message]]] = {}
        self.cancels: list[Any] = []

    def who(self, names: set[str], messages: list[Message] | None = None) -> str:
        """Which AGENT is asking, resolved from the catalog it was offered.

        Keyed on each agent's real box (`toolbox_for` over the served room), not
        on hand-picked marker tools: two agents share CORE, several shapes NARROW
        the catalog mid-run, and a marker-based guess silently mislabels a worker
        — which makes the script answer as the wrong agent and the test assert
        against a run that never happened.
        """
        if any(n.startswith("ask_") for n in names):
            return "main"
        # A forced synthesis round intentionally offers no tools. The product
        # still knows this is the Main agent from state; the scripted harness
        # must use the same system identity instead of guessing File agent from
        # an empty-catalog Jaccard tie.
        if not names and messages:
            system = str(messages[0].get("content") or "")
            if "You are the MAIN AGENT" in system:
                return "main"
        from arcelle_sidecar.agents import REGISTRY, toolbox_for

        served = set(ROOM_TOOLS)
        best, best_score = "files.read", -1.0
        for spec in REGISTRY:
            if spec.main:
                continue
            box = set(toolbox_for(spec.id, served))
            if not box:
                continue
            # Jaccard against the offered set: an exact box wins outright, and a
            # NARROWED round (route_act, chain_stage) still lands on its owner
            # because its distinctive verbs are the ones that survive narrowing.
            score = len(box & names) / len(box | names)
            # Prefer an agent the script actually mentions, so two agents sharing
            # a box (both CORE-only) resolve to the one under test.
            if spec.id in self.script:
                score += 0.05
            if score > best_score:
                best, best_score = spec.id, score
        return best

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
        names = {t["function"]["name"] for t in tools}
        who = self.who(names, messages)
        self.seen_by.setdefault(who, []).append([dict(m) for m in messages])
        turn = self.turns.get(who, 0)
        self.turns[who] = turn + 1
        usage = RoundUsage(
            input_tokens=None, max_context=8192, is_real=False
        )

        steps = self.script.get(who, [])
        step = steps[turn] if turn < len(steps) else f"FOUND: {who} finished."
        if isinstance(step, list) and tools:
            # Only offer calls the round actually has — a narrowed stage or a
            # scoped box may not carry the scripted verb, and inventing one
            # would test the fake instead of the graph.
            live = step if self.allow_drift else [c for c in step if c.name in names]
            if live:
                return "", live, usage
            step = f"FOUND: {who} could not do that here."
        text = step if isinstance(step, str) else f"FOUND: {who} finished."
        await on_delta(text)
        return text, [], usage


def tc(_tool: str, /, **args: Any) -> ToolCall:
    # positional-only, like conftest.call: a tool arg named `name` is common.
    return ToolCall(name=_tool, arguments=dict(args), id=f"c_{_tool}")


CLOUD = "qwen3:cloud"  # opts out of nothing now, but keeps intent explicit


async def run(question: str, script: dict[str, list[Any]], room: Room, **kw: Any):
    return await drive(
        make_request(question, web_enabled=True, model=CLOUD, **kw),
        Engine(script),  # type: ignore[arg-type]
        mcp=room,
    )


# --------------------------------------------------------------------------- #
# ERRAND 1 — "what does my lease say about pets?"
# --------------------------------------------------------------------------- #


async def test_errand_answer_a_question_about_a_file() -> None:
    """The commonest ask in the product: one question, one specialist, one
    grounded answer. If this breaks, the app is broken."""
    room = Room(files={"lease.pdf": "Clause 7: no pets of any kind are permitted."})
    out = await run(
        "what does my lease say about pets?",
        {
            "main": [[tc("ask_file_agent", instruction="what does the lease say about pets")],
                     "Your lease forbids pets (clause 7)."],
            "files.read": [[tc("search_room", query="pets")],
                     'FOUND: "no pets of any kind are permitted" (lease.pdf, clause 7).'],
        },
        room,
    )

    assert "pets" in out.final.lower()
    assert [c[0] for c in room.calls] == ["search_room"]
    # The user sees which specialist worked, and that it finished.
    roster = out.of("plan")[-1]["v"]
    assert [e["agent"] for e in roster] == ["files.read", "chat.answer"]
    assert roster[0]["status"] == "done"
    assert all(e.get("ok") is True for e in out.of("step_status"))


# --------------------------------------------------------------------------- #
# ERRAND 2 — "compare my rent to the market" (two specialists, in parallel)
# --------------------------------------------------------------------------- #


async def test_errand_two_independent_specialists_run_at_once() -> None:
    """Two halves that do not depend on each other must not cost two waits."""
    room = Room(files={"lease.pdf": "Rent: 1200/mo."})
    out = await run(
        "is my rent above market?",
        {
            "main": [
                [
                    tc("ask_file_agent", instruction="what is my rent"),
                    tc("ask_web_agent", instruction="what is the market rate"),
                ],
                "Your rent is 1200; the market is 4.25%-indexed — you are below it.",
            ],
            "files.read": [[tc("open_file", name="lease.pdf")], "FOUND: rent is 1200/mo."],
            "chat.web": [[tc("web_search", query="market rent")],
                    [tc("fetch_page", url="https://boi.org.il")],
                    "FOUND: 4.25% (boi.org.il)."],
        },
        room,
    )

    assert out.final
    roster = out.of("plan")[-1]["v"]
    kids = [e for e in roster if e["key"] != "main"]
    assert {e["agent"] for e in kids} == {"files.read", "chat.web"}
    # Dispatched together => one batch. That is the fact the UI draws.
    assert len({e["batch"] for e in kids}) == 1
    # The web chain is not skippable: a snippet is not a source.
    ran = [c[0] for c in room.calls]
    assert "fetch_page" in ran and ran.index("web_search") < ran.index("fetch_page")


# --------------------------------------------------------------------------- #
# ERRAND 3 — "summarize the lease and save it" (a dependent chain)
# --------------------------------------------------------------------------- #


async def test_errand_a_dependent_chain_passes_findings_forward() -> None:
    """Step two needs what step one FOUND — not the name of a file it wrote."""
    room = Room(files={"lease.pdf": "Rent 1200. Notice 60 days. No pets."})
    out = await run(
        "read my lease and save a summary of it",
        {
            "main": [
                [
                    tc(
                        "ask_agents",
                        tasks=[
                            {"agent": "files.read", "instruction": "read lease.pdf and list its key terms"},
                            {"agent": "files.read", "instruction": "save those terms as summary.md",
                             "depends_on": [0]},
                        ],
                    )
                ],
                "Saved the summary.",
            ],
            "files.read": [
                [tc("open_file", name="lease.pdf")],
                "FOUND: rent 1200, 60 days notice, no pets.",
                [tc("create_file", name="summary.md", content="rent 1200; 60 days; no pets")],
                "DID: saved summary.md.",
            ],
        },
        room,
    )

    assert "summary.md" in room.files, "the second step never wrote the file"
    # The dependent task was TOLD what the first one found, verbatim.
    kickoffs = [
        str(m.get("content") or "")
        for msgs in out.chat.seen_by.get("files.read", [])
        for m in msgs
        if "depends on" in str(m.get("content") or "")
    ]
    assert kickoffs, "the dependent task got no upstream findings"
    assert "rent 1200" in " ".join(kickoffs)
    assert out.final


# --------------------------------------------------------------------------- #
# ERRAND 4 — the app must not claim a write that failed
# --------------------------------------------------------------------------- #


async def test_errand_a_failed_save_is_never_reported_as_saved() -> None:
    """THE invariant of this product. A room that refuses the write must not
    produce an answer that says it saved."""
    room = Room(files={"lease.pdf": "Rent 1200."})
    room.fail.add("create_file")
    out = await run(
        "save a summary of my lease",
        {
            "main": [[tc("ask_file_agent", instruction="save a summary of the lease")],
                     "I could not save it."],
            "files.read": [
                [tc("create_file", name="summary.md", content="rent 1200")],
                "DID: saved summary.md.",  # the lie the gate must catch
                "MISSING: the save failed, nothing was written.",
            ],
        },
        room,
    )

    assert "summary.md" not in room.files
    # The worker was sent back to restate rather than allowed through.
    file_turns = out.chat.seen_by.get("files.read", [])
    corrections = [
        m for msgs in file_turns for m in msgs
        if "did not land" in str(m.get("content") or "")
    ]
    assert corrections, "a failed write was accepted as done"


async def test_errand_a_failed_email_is_never_reported_as_sent() -> None:
    """Same invariant, on the least reversible action in the app."""
    room = Room()
    room.fail.add("run_mcp_tool")
    out = await run(
        "email the summary to sam@example.com",
        {
            "main": [[tc("ask_connector_agent", instruction="email the summary to sam@example.com")],
                     "The send failed."],
            "connectors.use": [
                [tc("run_mcp_tool", tool="gmail.send", arguments={"to": "sam@example.com"})],
                "DID: sent the email.",  # the lie
                "MISSING: the send failed.",
            ],
        },
        room,
    )

    assert room.sent == [], "the fixture must not have actually sent anything"
    turns = out.chat.seen_by.get("connectors.use", [])
    assert [
        m for msgs in turns for m in msgs if "did not land" in str(m.get("content") or "")
    ], "a failed SEND was accepted as sent"


# --------------------------------------------------------------------------- #
# ERRAND 5 — a specialist falls over mid-errand
# --------------------------------------------------------------------------- #


async def test_errand_one_broken_specialist_does_not_lose_the_others() -> None:
    """A model error in one lane must cost that lane, not the user's whole ask."""
    room = Room(files={"lease.pdf": "Rent 1200."})

    class _WebExplodes(Engine):
        async def stream(self, messages, tools, on_delta, cancel=None):  # type: ignore[no-untyped-def]
            # By VERB, not by box similarity: chain_stage narrows the web lane's
            # catalog on its first round, so the box-shaped guess is unreliable
            # here and would make the fixture explode in the wrong lane.
            if "web_search" in {t["function"]["name"] for t in tools}:
                raise RuntimeError("the web model fell over")
            return await super().stream(messages, tools, on_delta, cancel)

    engine = _WebExplodes(
        {
            "main": [
                [
                    tc("ask_file_agent", instruction="what is my rent"),
                    tc("ask_web_agent", instruction="what is the market rate"),
                ],
                "Your rent is 1200. I could not check the market.",
            ],
            "files.read": [[tc("open_file", name="lease.pdf")], "FOUND: rent is 1200/mo."],
        }
    )
    out = await drive(
        make_request("is my rent above market?", web_enabled=True, model=CLOUD),
        engine,  # type: ignore[arg-type]
        mcp=room,
    )

    assert out.final, "one broken specialist killed the whole ask"
    tools = [m for m in out.messages if m.get("role") == "tool"]
    assert any("could not finish" in (m.get("content") or "") for m in tools)
    assert any("Report from the" in (m.get("content") or "") for m in tools)
    # The strip tells the truth about which one broke.
    roster = out.of("plan")[-1]["v"]
    assert any(e["status"] == "failed" for e in roster if e["key"] != "main")
    assert any(e["status"] == "done" for e in roster if e["key"] != "main")


# --------------------------------------------------------------------------- #
# ERRAND 6 — Stop, mid-errand
# --------------------------------------------------------------------------- #


async def test_errand_stop_keeps_finished_work_and_invents_nothing() -> None:
    from arcelle_sidecar.graph import CancelToken

    room = Room(files={"lease.pdf": "Rent 1200."})
    token = CancelToken()

    class _StopAfterReport(Engine):
        async def stream(self, messages, tools, on_delta, cancel=None):  # type: ignore[no-untyped-def]
            names = {t["function"]["name"] for t in tools}
            if self.who(names) == "main" and self.turns.get("main", 0) == 1:
                token.cancel()
            return await super().stream(messages, tools, on_delta, cancel)

    engine = _StopAfterReport(
        {
            "main": [[tc("ask_file_agent", instruction="what is my rent")], ""],
            "files.read": [[tc("open_file", name="lease.pdf")], "FOUND: rent is 1200/mo."],
        }
    )
    out = await drive(
        make_request("what is my rent?", web_enabled=True, model=CLOUD),
        engine,  # type: ignore[arg-type]
        mcp=room,
        cancel=token,
    )

    assert "1200" in out.final, "Stop threw away a specialist's finished work"
    assert "Stopped" in out.final, "a partial answer was dressed up as a complete one"


# --------------------------------------------------------------------------- #
# every shape survives a real errand
# --------------------------------------------------------------------------- #

#: (agent, the domain tool that reaches it, the errand, its action verb).
#:
#: The wording is load-bearing: `resolve_worker` picks the concrete worker from
#: the instruction's VOCABULARY, so each errand here is phrased the way a person
#: would phrase it AND verified to route where it claims. That makes this table
#: a routing test as much as a shape test — if a rename ever strands an agent,
#: its row fails rather than silently running the File agent instead.
SHAPE_ERRANDS = [
    ("files.read", "ask_file_agent", "what does my lease say",
     [tc("search_room", query="rent")]),
    ("chat.web", "ask_web_agent", "what is the central bank rate",
     [tc("web_search", query="rate")]),
    ("app.ui", "ask_app_agent", "open the Room Map for me",
     [tc("ui_act", mark=2)]),
    ("jobs.run", "ask_jobs_agent", "translate the entire book",
     [tc("start_file_pass", name="book.pdf", instruction="translate")]),
    ("jobs.workflows", "ask_jobs_agent", "make a workflow that runs every morning",
     [tc("save_workflow", name="morning")]),
    ("skills.author", "ask_skills_agent", "create a new skill for linting notes",
     [tc("save_skill", name="lint.md")]),
    ("scripts.run", "ask_file_agent", "run my cleanup script",
     [tc("run_script", name="cleanup.py")]),
    ("connectors.use", "ask_connector_agent", "send this to slack",
     [tc("run_mcp_tool", tool="slack.post", arguments={"text": "hi"})]),
    ("media.transcribe", "ask_file_agent", "re-transcribe the meeting recording",
     [tc("retranscribe_file", name="standup.m4a")]),
    ("creator.studio", "ask_file_agent", "turn my notes into flashcards",
     [tc("studio_flashcards", name="notes.md")]),
]


@pytest.mark.parametrize(
    "agent_id,domain_tool,question,calls",
    SHAPE_ERRANDS,
    ids=[s[0] for s in SHAPE_ERRANDS],
)
async def test_every_agent_completes_a_real_errand(
    agent_id: str, domain_tool: str, question: str, calls: list[ToolCall]
) -> None:
    """One realistic errand per agent, through the hub, over a live-shaped room.

    Not a smoke test: it asserts the specialist ACTED (its verb reached the
    room) and that the turn produced an answer. A shape that cannot reach its
    own action verb — the `oneshot` bug, and the `probe_gate_act` bug it was
    rebuilt as — fails here regardless of which node caused it.
    """
    room = Room(files={"book.pdf": "…", "notes.md": "…", "standup.m4a": "…",
                       "cleanup.py": "…", "lease.pdf": "Rent 1200."})
    out = await run(
        question,
        {
            "main": [[tc(domain_tool, instruction=question)], f"Done: {question}"],
            agent_id: [calls, f"DID: handled {question}."],
        },
        room,
    )

    assert out.final, f"{agent_id} produced no answer"
    # The errand reached the agent it was written for — routing, not just shape.
    roster = out.of("plan")[-1]["v"]
    assert any(e["agent"] == agent_id for e in roster), (
        f"{question!r} routed to {[e['agent'] for e in roster]}, not {agent_id}"
    )
    ran = {c[0] for c in room.calls}
    assert calls[0].name in ran, (
        f"{agent_id} never reached its action verb {calls[0].name!r}; "
        f"the room only saw {sorted(ran)}"
    )
    roster = out.of("plan")[-1]["v"]
    assert roster[-1]["key"] == "main"
    assert any(e["status"] == "done" for e in roster if e["key"] != "main")


async def test_a_long_errand_stays_within_one_answer_and_one_roster() -> None:
    """Six delegations across four rounds: exactly ONE final event, and the
    roster only ever grows. The Main agent's delegation budget is gone, so this
    also pins that nothing silently re-imposed a cap."""
    room = Room(files={"lease.pdf": "Rent 1200."})
    script: dict[str, list[Any]] = {
        "main": [
            [tc("ask_file_agent", instruction="step one")],
            [tc("ask_file_agent", instruction="step two")],
            [tc("ask_file_agent", instruction="step three")],
            [tc("ask_file_agent", instruction="step four")],
            [tc("ask_file_agent", instruction="step five")],
            [tc("ask_file_agent", instruction="step six")],
            "All six steps are done.",
        ],
        "files.read": [[tc("search_room", query="rent")], "FOUND: 1200."] * 6,
    }
    out = await run("do six things with my lease", script, room)

    assert out.final == "All six steps are done."
    assert sum(1 for k in out.kinds if k == "final") == 1
    plans = [e["v"] for e in out.of("plan")]
    sizes = [len(p) for p in plans]
    assert sizes == sorted(sizes), "the roster shrank mid-turn"
    workers = [e for e in plans[-1] if e["key"] != "main"]
    assert len(workers) == 6, f"a delegation cap came back: {len(workers)} of 6 ran"
    assert all(e["status"] == "done" for e in workers)


async def test_the_room_never_sees_a_tool_the_main_agent_should_not_have() -> None:
    """Hub invariant, end to end: the Main agent never touches a room tool, even
    when the model drifts and emits one."""
    room = Room(files={"lease.pdf": "Rent 1200."})
    engine = Engine(
        {
            "main": [
                [tc("search_room", query="rent")],  # drift: a room tool
                [tc("ask_file_agent", instruction="what does the lease say")],
                "Your rent is 1200.",
            ],
            "files.read": [[tc("search_room", query="rent")], "FOUND: 1200."],
        },
        allow_drift=True,
    )
    out = await drive(
        make_request("what does my lease say", web_enabled=True, model=CLOUD),
        engine,  # type: ignore[arg-type]
        mcp=room,
    )

    assert out.final
    # The drifted call was rejected before the bridge; the only search_room the
    # room saw came from the FILE agent's own scoped box.
    corrections = [
        m
        for msgs in out.chat.seen_by.get("main", [])
        for m in msgs
        if m.get("role") == "tool" and "you are the Main agent" in (m.get("content") or "")
    ]
    assert corrections, "the Main agent was allowed to touch a room tool"
    assert [c[0] for c in room.calls] == ["search_room"]


# --------------------------------------------------------------------------- #
# ERRAND — "what's the weather" in a room with the internet turned OFF
# --------------------------------------------------------------------------- #


async def test_web_off_room_refuses_instead_of_answering_from_the_room() -> None:
    """The 2026-07-28 bug, end to end.

    With web disabled, `ask_web_agent` is not in the catalog and `web` is not in
    the batch enum — but `DOMAIN_KEYS` is unfiltered, so a model that still
    emits `agent: "web"` used to resolve to `chat.web`, be found unreachable,
    and fall through to `DEFAULT_AGENT_ID`: the FILE agent, answering a live
    weather question out of room content. The task must be REFUSED and reported
    MISSING instead, so the Main agent tells the user plainly.
    """
    room = Room(files={"trip.md": "Tel Aviv in July is hot and humid."})
    engine = Engine(
        {
            "main": [
                [
                    tc(
                        "ask_agents",
                        tasks=[
                            {"agent": "web", "instruction": "what is the weather in Tel Aviv now"},
                        ],
                    )
                ],
                "I can't browse the internet in this room.",
            ],
            # If the guard ever regresses, the File agent picks this up and the
            # assertions below fire.
            "files.read": [
                [tc("search_room", query="weather Tel Aviv")],
                "FOUND: Tel Aviv in July is hot and humid.",
            ],
        },
        allow_drift=True,
    )
    out = await drive(
        make_request("what's the weather in Tel Aviv", web_enabled=False, model=CLOUD),
        engine,  # type: ignore[arg-type]
        mcp=room,
    )

    assert out.final
    # The refusal reached the Main agent as data it can act on...
    reports = [
        m
        for msgs in out.chat.seen_by.get("main", [])
        for m in msgs
        if m.get("role") == "tool" and "MISSING" in (m.get("content") or "")
    ]
    assert reports, "the unavailable-domain task did not report MISSING"
    assert any("no 'web' specialist" in (m.get("content") or "") for m in reports)
    # ...and no worker was handed the web question. The File agent never ran, so
    # the room was never searched for something the room cannot know.
    assert "files.read" not in out.chat.seen_by
    assert room.calls == []


async def test_web_on_room_still_dispatches_the_same_batch_normally() -> None:
    """The control: identical plan, web enabled — the guard must not fire."""
    room = Room(files={})
    out = await run(
        "what's the weather in Tel Aviv",
        {
            "main": [
                [
                    tc(
                        "ask_agents",
                        tasks=[
                            {"agent": "web", "instruction": "what is the weather in Tel Aviv now"},
                        ],
                    )
                ],
                "It is 31C and humid.",
            ],
            "chat.web": [
                [tc("web_search", query="Tel Aviv weather")],
                [tc("fetch_page", url="https://example.com/tlv")],
                "FOUND: 31C, humid (example.com/tlv).",
            ],
        },
        room,
    )

    assert out.final
    assert "chat.web" in out.chat.seen_by, "the Web agent should have run"
    assert [c[0] for c in room.calls][:1] == ["web_search"]
