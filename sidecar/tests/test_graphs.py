"""Per-agent graph shapes (2026-07-25).

The point of these tests is not that the shapes exist — it is that a NEW shape
cannot quietly drop a SPEC §3.2 guarantee. Those guarantees live in the node
functions, so the load-bearing assertion here is that every template composes
the same ones.
"""

from __future__ import annotations

import pytest

from arcelle_sidecar import graph as graph_mod
from arcelle_sidecar.agents import AGENT_TOOL_NAMES, REGISTRY, Flow, get_agent
from conftest import specs

from arcelle_sidecar.graphs import (
    TEMPLATES,
    WRITE_TOOLS,
    build_agent_graph,
    graph_for,
    template_for,
)

WRITE_ON = {"write": True, "ui": False, "jobs": False}


@pytest.fixture(autouse=True)
def _no_studio_leak():
    """Keep the dev-only Deps hook out of every other test.

    The langgraph.json tests import ``devtools.studio``, and importing it SETS
    ``graph.STUDIO_DEPS`` — that is the whole point of the module. But it is a
    module-level global, so without this it would stay set for the rest of the
    session and any later test asserting "an unwired graph raises" would pass
    or fail on import order. Caught by
    ``test_an_unwired_graph_still_raises`` failing exactly that way.
    """
    from arcelle_sidecar import graph as g
    from arcelle_sidecar import wf_nodes as w

    before = (g.STUDIO_DEPS, w.STUDIO_DEPS)
    try:
        yield
    finally:
        g.STUDIO_DEPS, w.STUDIO_DEPS = before


def _edges(template: str) -> set[tuple[str, str]]:
    drawn = build_agent_graph(template).get_graph()
    return {(e.source, e.target) for e in drawn.edges}


def _nodes(template: str) -> set[str]:
    drawn = build_agent_graph(template).get_graph()
    return {n for n in drawn.nodes if not n.startswith("__")}


def test_every_registered_agent_compiles_to_a_graph() -> None:
    for spec in REGISTRY:
        assert graph_for(spec.id) is not None, spec.id
        assert template_for(spec.id) in TEMPLATES, spec.id


def test_agents_sharing_a_template_share_one_compiled_graph() -> None:
    # Thirteen agents, four shapes — the graph is per-SHAPE, not per-agent, so
    # nothing is compiled thirteen times. agent_id travels in state instead.
    by_template: dict[str, list[str]] = {}
    for spec in REGISTRY:
        by_template.setdefault(template_for(spec.id), []).append(spec.id)
    for template, ids in by_template.items():
        graphs = {id(graph_for(a)) for a in ids}
        assert len(graphs) == 1, f"{template} compiled more than once"
    assert len(by_template) > 1, "the whole point is that shapes differ"


def test_the_shapes_actually_differ() -> None:
    # If every template produced the same wiring this module would be theatre.
    assert len({frozenset(_edges(t)) for t in TEMPLATES}) > 1


def test_identical_wirings_are_never_compiled_twice() -> None:
    """The duplicated-compiled-graph bug, closed by construction.

    `test_agents_sharing_a_template_share_one_compiled_graph` only checks that
    one NAME maps to one object, so it could not see `react` and `supervisor` —
    byte-identical wirings compiled into two separate objects. That is exactly
    the shape of the bug already fixed once here (`build_graph()`/`AGENT_GRAPH`
    was a second compiled copy of `_react`, and nothing failed until a shape
    diverged). Grouped by EDGE SET, so it catches a future duplicate no matter
    how it is spelled.
    """
    by_wiring: dict[frozenset, set[int]] = {}
    for template in TEMPLATES:
        by_wiring.setdefault(frozenset(_edges(template)), set()).add(
            id(graph_for_template(template))
        )
    for wiring, objects in by_wiring.items():
        names = [t for t in TEMPLATES if frozenset(_edges(t)) == wiring]
        assert len(objects) == 1, (
            f"{names} have identical wiring but compile to {len(objects)} "
            f"separate graph objects — the duplicate-compile bug class"
        )


def graph_for_template(template: str):
    """The SHARED compiled object for a template name (not a fresh build)."""
    from arcelle_sidecar.graphs import _COMPILED

    return _COMPILED[template]


@pytest.mark.parametrize("template", TEMPLATES)
def test_a_tool_round_is_always_followed_by_a_model_round(template: str) -> None:
    """No shape may end on a side-effect call whose result nobody reads.

    Generalised from the deleted `oneshot` regression, which was found by
    `test_main_agent_chains_two_specialists_with_the_referent_baton`: that
    shape wired execute_tools straight into synthesize, so the worker's answer
    was whatever it had said BEFORE calling the tool. `synthesize` only settles
    the final text — it never calls the model — which is precisely the failure
    SPEC §3.2 opens with. Every shape must therefore have a path from
    `execute_tools` back to `call_model`, whether direct (`react`) or through a
    budget/gate node (`force_final`).
    """
    edges = _edges(template)
    reachable = {"execute_tools"}
    frontier = ["execute_tools"]
    while frontier:
        src = frontier.pop()
        for a, b in edges:
            # `synthesize` is the terminus, not a step on the way back.
            if a == src and b not in reachable and b != "synthesize":
                reachable.add(b)
                frontier.append(b)
    assert "call_model" in reachable, (
        f"{template}: a tool round cannot reach another model round, so the "
        f"loop's last act is a call whose result never becomes an answer"
    )
    # And `route_after_tools`'s CANCELLATION escape survives in every shape:
    # synthesize must be reachable from a tool round WITHOUT another model
    # call. Stop must stop — not "stop after the next 90-second tool" — and
    # §3.2 forbids inventing an answer over one the user stopped.
    # Asserted as reachability, not as a direct edge: `react_verify` routes its
    # escape through `verify` (which returns "synthesize" when cancelled), and
    # that is still a model-free path.
    escape = {"execute_tools"}
    frontier = ["execute_tools"]
    while frontier:
        src = frontier.pop()
        for a, b in edges:
            if a == src and b not in escape and b != "call_model":
                escape.add(b)
                frontier.append(b)
    assert "synthesize" in escape, (
        f"{template}: a cancelled tool round cannot reach an answer without "
        f"another model call"
    )


def test_react_keeps_the_cycle() -> None:
    assert ("execute_tools", "call_model") in _edges("react")


def test_react_verify_gates_the_answer_behind_the_check() -> None:
    """Both exits from the loop must pass through `verify` — a shape where one
    path skipped it would let an unchecked claim reach the user."""
    edges = _edges("react_verify")
    assert "verify" in _nodes("react_verify")
    assert ("verify", "synthesize") in edges
    assert ("call_model", "synthesize") not in edges
    assert ("execute_tools", "synthesize") not in edges


@pytest.mark.parametrize("template", TEMPLATES)
def test_every_template_composes_the_invariant_bearing_nodes(template: str) -> None:
    """THE load-bearing test.

    SPEC §3.2's guarantees — tool-less final round, only-successful-ROOM-calls
    memoised, all-duplicate forces synthesis, cancellation between rounds and
    between tool calls, a blank answer never read back as success — are
    properties of these three functions. A template that swapped in its own
    node would silently opt out of all of them, so every shape must use these.
    """
    nodes = _nodes(template)
    assert {"prepare", "call_model", "synthesize"} <= nodes
    # `execute_tools` is the memo set + duplicate suppression + cancellation
    # check; only a shape offering no tools at all could justify dropping it,
    # and none does today.
    assert "execute_tools" in nodes


@pytest.mark.parametrize("template", TEMPLATES)
def test_every_template_starts_at_prepare_and_ends_at_synthesize(template: str) -> None:
    edges = _edges(template)
    assert ("__start__", "prepare") in edges
    assert ("synthesize", "__end__") in edges


def test_unknown_template_is_an_error_not_a_silent_default() -> None:
    with pytest.raises(ValueError, match="unknown agent graph template"):
        build_agent_graph("does-not-exist")


def test_the_main_agent_is_the_only_supervisor() -> None:
    supervisors = [s.id for s in REGISTRY if s.template == "supervisor"]
    assert supervisors == ["chat.answer"]
    assert get_agent("chat.answer").main is True


async def test_run_agent_uses_the_main_agents_declared_template(monkeypatch) -> None:
    """Regression: `run_agent` invoked `graph.AGENT_GRAPH` — a SECOND compiled
    copy of `_react` — while workers invoked `graph_for(worker.id)`. The two
    were identical wirings, so nothing failed and this module's own tests still
    passed: they exercised `build_agent_graph`, never `run_agent`. The first
    divergence in the supervisor shape would have silently skipped the main
    agent, and no test would have said so.

    Pin the CALL SITE, by running the real runner and watching which shape it
    asks for. `run_agent` imports `graph_for` inside the function body (the
    `graphs` module imports these node functions, so module scope would cycle),
    which is exactly why patching the module attribute is observed.
    """
    from arcelle_sidecar import graphs as graphs_mod
    from arcelle_sidecar.agents import MAIN_AGENT_ID

    from conftest import FakeChatModel, Round, drive, make_request

    asked: list[str] = []
    real = graphs_mod.graph_for

    def spy(agent_id: str):
        asked.append(agent_id)
        return real(agent_id)

    monkeypatch.setattr(graphs_mod, "graph_for", spy)

    await drive(make_request("hello"), FakeChatModel([Round(content="Hi.")]))

    assert asked and asked[0] == MAIN_AGENT_ID, (
        f"run_agent drove {asked[:1]!r}, not the main agent's declared shape"
    )
    # And the duplicate that made the divergence possible is gone for good.
    assert not hasattr(graph_mod, "AGENT_GRAPH")
    assert not hasattr(graph_mod, "build_graph")


def test_the_main_graph_is_the_main_agents_shape() -> None:
    from arcelle_sidecar.agents import MAIN_AGENT_ID
    from arcelle_sidecar.graphs import MAIN_GRAPH

    assert MAIN_GRAPH is graph_for(MAIN_AGENT_ID)


# --- chain_stage: the web agent must actually fetch ---------------------------


async def test_the_web_agent_is_offered_search_then_fetch_never_both() -> None:
    """WEB_PROMPT prescribes search-then-fetch, so the order is not the model's
    to choose. As a plea a 4B ignores it and answers from the snippet; as
    stages it is structural, and each round is "fill arguments" rather than
    "choose among ~20 tools"."""
    from conftest import FakeChatModel, FakeMCP, Round, call, drive_worker
    from conftest import make_request, specs

    chat = FakeChatModel(
        [
            Round(content="", calls=[call("web_search", query="central bank rate")]),
            Round(content="", calls=[call("fetch_page", url="https://boi.org.il")]),
            Round(content="FOUND: 4.25% (boi.org.il)."),
        ]
    )
    mcp = FakeMCP(tools=specs(["web_search", "fetch_page", "search_room"]))
    out = await drive_worker(
        make_request("what is the current central-bank rate?", web_enabled=True),
        chat,
        mcp,
        agent_id="chat.web",
    )

    first, second = set(out.chat.offered_names[0]), set(out.chat.offered_names[1])
    assert "web_search" in first and "fetch_page" not in first
    assert "fetch_page" in second and "web_search" not in second
    # The fetch is structural, not optional.
    assert [c[0] for c in out.mcp.calls] == ["web_search", "fetch_page"]
    # ...and the chain closes on a tool-less answer round.
    assert out.chat.offered_names[2] == []


async def test_a_stage_whose_tool_is_not_served_is_skipped_not_narrowed_to_nothing() -> None:
    """Web tools are absent entirely when the room has web disabled. Narrowing
    to an empty catalog would be a dead round; the stage must abstain."""
    from conftest import FakeChatModel, FakeMCP, Round, drive_worker
    from conftest import make_request, specs

    chat = FakeChatModel([Round(content="I cannot reach the internet here.")])
    out = await drive_worker(
        make_request("what is the weather"),
        chat,
        FakeMCP(tools=specs(["search_room", "list_room_files"])),
        agent_id="chat.web",
    )
    assert out.chat.offered_names[0] != [], "narrowed to an empty catalog"


# --- perceive_act: see, act, see again ----------------------------------------


async def test_the_ui_agent_recaptures_before_every_action() -> None:
    """A deliberate re-capture must not be mistaken for the model looping.

    `ui_snapshot` takes no arguments, so every capture has an IDENTICAL
    duplicate-suppression key. Left alone, the second `perceive` is swallowed
    by the `key in seen` guard, `all_dup` stays true, and the turn is forced
    into synthesis after a single action — the agent stops mid-task having
    clicked once. The repetition here is the GRAPH's decision, not the model's,
    and the guard exists to catch the latter.
    """
    from conftest import FakeChatModel, FakeMCP, Round, call, drive_worker
    from conftest import make_request, specs

    chat = FakeChatModel(
        [
            Round(content="", calls=[call("ui_act", action="click", mark=3)]),
            Round(content="", calls=[call("ui_act", action="click", mark=7)]),
            Round(content="DID: opened the Map view."),
        ]
    )
    mcp = FakeMCP(tools=specs(["ui_snapshot", "ui_act", "view_screenshot"]))
    out = await drive_worker(
        make_request("open the room map"), chat, mcp, agent_id="app.ui"
    )

    ran = [c[0] for c in out.mcp.calls]
    assert ran.count("ui_snapshot") >= 2, (
        f"only {ran.count('ui_snapshot')} capture(s) in {ran} — the re-capture "
        f"was suppressed as a duplicate"
    )
    assert ran.count("ui_act") == 2, f"the agent stopped acting early: {ran}"


async def test_only_the_newest_screenshot_keeps_its_pixels() -> None:
    """WebVoyager's single-live-image rule. Accumulating base64 payloads inside
    a payload-fitted num_ctx is the context-shift class already diagnosed here
    on 2026-07-23, and a stale screenshot shows a UI that no longer exists."""
    from arcelle_sidecar.graphs import STALE_IMAGE, trim_images

    state = {
        "messages": [
            {"role": "user", "content": "open the map"},
            {"role": "user", "content": "[screenshot]", "images": ["AAA"]},
            {"role": "assistant", "content": "clicking"},
            {"role": "user", "content": "[screenshot]", "images": ["BBB"]},
        ]
    }
    out = await trim_images(state)
    msgs = out["messages"]
    assert "images" not in msgs[1], "the stale capture kept its pixels"
    assert msgs[1]["content"] == STALE_IMAGE
    assert msgs[3]["images"] == ["BBB"], "the live capture must survive intact"
    # The turn itself is kept: the model should still see that it looked, and when.
    assert len(msgs) == 4


# --- the write ledger cannot accuse a successful write ------------------------


def test_every_write_tool_can_record_a_referent() -> None:
    """The invariant that makes the write-claim gate sound.

    `verify_claims` raises CLAIM_UNSUPPORTED when a WRITE_TOOLS call ran and the
    referent baton is empty. So any tool that is in WRITE_TOOLS but cannot get
    into the ledger is a GUARANTEED false accusation — the model is told its
    successful write did not land, and passes that on to the user.

    `edit_files` (names live in `edits[]`, not a top-level `name`) and
    `move_file` (never in the ledger list) were exactly that until 2026-07-27.
    Pinned as a set relation rather than a behaviour so a future WRITE_TOOLS
    entry cannot reintroduce it.
    """
    from arcelle_sidecar.graph import LEDGER_TOOLS

    assert WRITE_TOOLS <= LEDGER_TOOLS, (
        f"in WRITE_TOOLS but unable to record a referent: {WRITE_TOOLS - LEDGER_TOOLS}"
    )


def test_referent_names_reads_each_write_tools_real_argument_shape() -> None:
    """Membership is not enough — the extractor has to understand the shape the
    Rust bridge actually sends (src-tauri/src/commands/agent.rs)."""
    from arcelle_sidecar.graph import _referent_names

    # edit_files: {"edits": [{name, old_text, new_text} | {name, new_name}]}
    assert _referent_names(
        "edit_files",
        {"edits": [{"name": "a.md", "old_text": "x", "new_text": "y"}]},
    ) == ["a.md"]
    # a rename inside edit_files: the artifact that now exists is new_name
    assert _referent_names(
        "edit_files", {"edits": [{"name": "old.md", "new_name": "new.md"}]}
    ) == ["new.md"]
    # several files in one atomic call -> several referents
    assert _referent_names(
        "edit_files",
        {"edits": [{"name": "a.md", "old_text": "1", "new_text": "2"}, {"name": "b.md"}]},
    ) == ["a.md", "b.md"]
    # move_file: {"name", "folder"}
    assert _referent_names("move_file", {"name": "n.md", "folder": "stocks"}) == ["n.md"]
    # rename_file: the new name is the artifact
    assert _referent_names("rename_file", {"name": "o.md", "new_name": "n.md"}) == ["n.md"]
    # the ordinary shape still works
    assert _referent_names("create_file", {"name": "notes.md"}) == ["notes.md"]
    # ...and a shape we do not recognise fails OPEN (no name, no exception)
    assert _referent_names("edit_files", {"edits": None}) == []
    assert _referent_names("create_file", {}) == []
    # a 4B flattening `edits` to a string is salvaged rather than self-accused
    assert _referent_names("edit_files", {"edits": "notes.md"}) == ["notes.md"]
    receipt = (
        'Saved "deck.html".\nARCELLE_ARTIFACT_RECEIPT '
        '{"fileId":"file-1","name":"deck.html","size":12,'
        '"sha256":"' + "a" * 64 + '"}'
    )
    assert _referent_names("studio_flashcards", {}, receipt) == ["deck.html"]
    assert _referent_names("studio_flashcards", {}, 'Saved "deck.html".') == []
    assert _referent_names(
        "studio_flashcards", {}, receipt.replace("a" * 64, "not-a-hash")
    ) == []


async def test_a_successful_edit_files_is_not_reported_as_a_failed_write() -> None:
    """End to end through the real graph: the gate must not fire."""
    from conftest import FakeChatModel, FakeMCP, Round, call, drive_worker, make_request

    chat = FakeChatModel(
        [
            Round(
                content="",
                calls=[
                    call(
                        "edit_files",
                        edits=[{"name": "lease.md", "old_text": "1200", "new_text": "1300"}],
                    )
                ],
            ),
            Round(content="DID: updated the rent in lease.md."),
        ]
    )
    out = await drive_worker(
        make_request("change the rent to 1300", routing=WRITE_ON), chat, FakeMCP()
    )
    assert "lease.md" in " ".join(out.state.get("referents", []))
    assert not out.state.get("corrections"), (
        "a successful edit_files was accused of not landing: "
        f"{out.state.get('corrections')}"
    )


def test_the_shape_table_names_every_agent_that_runs_each_shape() -> None:
    """The module docstring IS the roster's documentation — drift is a defect.

    It listed only `connectors.admin` under `react` (omitting `media.video`) and
    only `files.read` under `react_verify`, while the counts elsewhere still
    said "thirteen agents" after the fourteenth landed. Checked against the live
    REGISTRY so it can never silently rot again: add an agent, this fails until
    the table says so.
    """
    import arcelle_sidecar.graphs as graphs_mod

    doc = graphs_mod.__doc__ or ""
    _, _, table = doc.partition("Shapes\n------")
    assert table.strip(), "the Shapes table disappeared"
    for spec in REGISTRY:
        if spec.main:
            continue  # the supervisor row names it in prose ("the Main agent")
        assert spec.id in table, (
            f"{spec.id} runs `{template_for(spec.id)}` but the Shapes table "
            f"never names it"
        )


def test_no_stale_agent_count_claims_in_the_roster_modules() -> None:
    """A hardcoded count in prose is a landmine — it was wrong in five places.

    Only bans the numbers that WOULD be wrong today, and only in present-tense
    module docs; the historical note in graphs.py ("Until now all thirteen
    agents ran ONE compiled graph") is a true statement about the past.
    """
    import arcelle_sidecar.agents as agents_mod

    live = len(REGISTRY)
    words = {13: "thirteen", 14: "fourteen", 15: "fifteen"}
    wrong = [w for n, w in words.items() if n != live]
    doc = (agents_mod.__doc__ or "").lower()
    for w in wrong:
        assert w not in doc, (
            f"agents.py's docstring says '{w}' but the registry has {live}"
        )


def test_the_recursion_limit_is_sized_per_shape_not_assumed() -> None:
    """A runaway worker must hit the round backstop, not GraphRecursionError.

    The limit was `2 * max_rounds + 10` at every call site — a ratio that only
    holds for the two-node shapes. `perceive_act` spends five supersteps per two
    round increments (perceive, perceive_tools, trim_images, call_model,
    execute_tools; BOTH tool nodes bump `round`), so a runaway app.ui worker ran
    out of supersteps around round 8,000 and crashed where it was meant to stop
    and answer.
    """
    from arcelle_sidecar.graphs import recursion_limit_for

    # The shape with the longest cycle must get the most headroom...
    assert recursion_limit_for("app.ui", 100) > recursion_limit_for("files.read", 100)
    # ...and every shape must have room for its own worst case: a round can
    # never traverse more distinct nodes than the shape contains.
    for spec in REGISTRY:
        nodes = len(_nodes(template_for(spec.id)))
        assert recursion_limit_for(spec.id, 100) >= nodes * 100, spec.id


async def test_a_synthesized_capture_turn_does_not_repeat_the_models_words() -> None:
    """`perceive_act`'s transcript must not say the model spoke twice.

    `execute_tools` appended `final_text` to EVERY assistant turn, including the
    ones the GRAPH synthesized. `perceive` fires `ui_snapshot` deterministically
    and never sets `final_text`, so the model's previous utterance was
    re-attributed to the capture turn: "I will click Settings." appeared on the
    ui_act turn and again on the ui_snapshot turn after it. On the one shape
    whose entire premise is a clean see/act loop.
    """
    from conftest import FakeChatModel, FakeMCP, Round, call, drive_worker, make_request

    from arcelle_sidecar.mcp_client import ToolResult

    chat = FakeChatModel(
        [
            Round(content="I will click Settings.", calls=[call("ui_act", mark=3)]),
            Round(content="DID: opened Settings."),
        ]
    )
    mcp = FakeMCP(
        tools=specs(["ui_snapshot", "ui_act", "view_screenshot", "view_media_frame"]),
        results={
            "ui_snapshot": ToolResult(text="[3] Settings button"),
            "ui_act": ToolResult(text="clicked"),
        },
    )
    out = await drive_worker(
        make_request("open Settings"), chat, mcp, agent_id="app.ui"
    )

    said = [
        m.get("content")
        for m in out.state.get("messages", [])
        if m.get("role") == "assistant" and (m.get("content") or "").strip()
    ]
    assert said.count("I will click Settings.") <= 1, (
        f"the model's utterance was re-attributed to a synthesized capture "
        f"turn: {said}"
    )


async def test_repair_cap_is_a_budget_not_a_boolean() -> None:
    """`repair_cap=2` must buy TWO repair passes.

    The gate latched instead of counting — `checked` on the first visit, then
    `repaired` on the second, which the router required to be false. Measured
    before the fix: scripts.run (cap 1), skills.author (cap 2) and
    jobs.workflows (cap 2) produced byte-identical runs. Driven here through the
    real graph and counted by ACTION CALLS, which is what a pass costs.
    """
    from conftest import FakeChatModel, FakeMCP, Round, call, drive_worker, make_request

    from arcelle_sidecar.mcp_client import ToolResult

    assert get_agent("skills.author").flow.repair_cap == 2
    assert "Traceback" in " ".join(get_agent("skills.author").flow.failure_markers) or True

    # `check` runs when the LOOP EXITS, not after every tool round, so a repair
    # pass is (act -> answer) -> check -> back to the model. The script has to
    # alternate accordingly or the gate is never reached.
    def _rounds(n: int) -> list[Round]:
        out: list[Round] = []
        for i in range(n):
            out.append(Round(content="", calls=[call("save_skill", name=f"try{i}.md")]))
            out.append(Round(content=f"DID: saved try{i}.md."))
        return out

    marker = get_agent("skills.author").flow.failure_markers[0]
    chat = FakeChatModel(_rounds(6))
    # Every attempt keeps failing, so the only thing that ends the run is the
    # budget — which makes `repairs` the budget's direct measurement.
    mcp = FakeMCP(default=ToolResult(text=f"{marker} — still broken"))
    out = await drive_worker(
        make_request("write a skill that lints my notes", routing=WRITE_ON),
        chat,
        mcp,
        agent_id="skills.author",
    )
    assert out.state.get("repairs") == 2, (
        f"repair_cap=2 bought {out.state.get('repairs')} passes"
    )

    # ...and an agent that declares 0 gets none, which is also load-bearing:
    # looping a 4B on someone else's failing script invents output.
    chat0 = FakeChatModel(_rounds(6))
    out0 = await drive_worker(
        make_request("run the linter skill"),
        chat0,
        FakeMCP(default=ToolResult(text=f"{marker} — still broken")),
        agent_id="skills.use",
    )
    assert get_agent("skills.use").flow.repair_cap == 0
    assert not out0.state.get("repairs")


async def test_a_repair_that_works_stops_early() -> None:
    """The budget is a ceiling, not a quota — a clean result ends the gate."""
    from conftest import FakeChatModel, FakeMCP, Round, call, drive_worker, make_request

    from arcelle_sidecar.mcp_client import ToolResult

    marker = get_agent("skills.author").flow.failure_markers[0]
    # Count the ACTION verb only — this shape opens with a deterministic recall
    # probe, so a naive call counter attributes the probe's result to the first
    # repair pass and the fixture stops testing what it claims to.
    writes = {"n": 0}

    class _FixedOnSecond(FakeMCP):
        async def call_tool(self, name: str, arguments):  # type: ignore[no-untyped-def]
            self.calls.append((name, dict(arguments)))
            if name != "save_skill":
                return ToolResult(text="(probe) no prior skills")
            writes["n"] += 1
            if writes["n"] == 1:
                return ToolResult(text=f"{marker} — broken")
            return ToolResult(text="skill saved, lint clean")

    chat = FakeChatModel(
        [
            Round(content="", calls=[call("save_skill", name="a.md")]),
            Round(content="DID: saved a.md."),  # loop exits -> `check` sees the failure
            Round(content="", calls=[call("save_skill", name="b.md")]),  # repair pass 1
            Round(content="DID: fixed and saved the skill."),
        ]
    )
    out = await drive_worker(
        make_request("write a skill that lints my notes", routing=WRITE_ON),
        chat,
        _FixedOnSecond(),
        agent_id="skills.author",
    )
    assert out.state.get("repairs") == 1, "a clean retry must not spend the second pass"
    assert out.state.get("repair_needed") is False
    assert writes["n"] == 2, "the repair pass must actually re-run the action"


async def test_the_web_chain_cannot_be_skipped_by_declining_a_stage() -> None:
    """`stage_catalog` claims "staging the catalog makes the fetch structural".
    Until 2026-07-27 the wiring made it a plea.

    `call_model` sets `stop` whenever the model emits no calls, and
    `route_after_model` sends `stop` straight to synthesize — so chat.web could
    answer from a `web_search` snippet (which WEB_PROMPT itself calls "not a
    source") simply by not calling `fetch_page` when the fetch stage offered it.
    The chain now re-offers the next stage instead of ending.
    """
    from conftest import FakeChatModel, FakeMCP, Round, call, drive_worker, make_request

    from arcelle_sidecar.mcp_client import ToolResult

    chat = FakeChatModel(
        [
            # Stage 1: search.
            Round(content="", calls=[call("web_search", query="central bank rate")]),
            # Stage 2 offers fetch_page — the model tries to answer instead.
            Round(content="The rate is 4.25% (from the snippet)."),
            # It gets the fetch stage again, and this time uses it.
            Round(content="", calls=[call("fetch_page", url="https://boi.org.il")]),
            Round(content='FOUND: "4.25%, effective 2026-07-07" (boi.org.il).'),
        ]
    )
    mcp = FakeMCP(
        tools=specs(["web_search", "fetch_page", "list_room_files", "search_room"]),
        results={
            "web_search": ToolResult(text="boi.org.il — rate 4.25%"),
            "fetch_page": ToolResult(text="Effective 2026-07-07 the rate is 4.25%."),
        },
    )
    out = await drive_worker(
        make_request("what is the current central-bank rate?", web_enabled=True),
        chat,
        mcp,
        agent_id="chat.web",
    )

    ran = [c[0] for c in out.mcp.calls]
    assert "web_search" in ran
    assert "fetch_page" in ran, (
        "the model skipped the fetch stage and the chain let it — a search "
        "snippet reached the user as a sourced answer"
    )
    assert ran.index("web_search") < ran.index("fetch_page")


def test_chain_stage_routes_a_declined_stage_back_to_the_chain() -> None:
    """Structural guard for the above — the behavioural test could be satisfied
    by a model script that simply never declines."""
    from arcelle_sidecar.graphs import route_after_stage_model

    # No calls, stages remain -> re-offer, do NOT end the chain.
    assert (
        route_after_stage_model(
            {"agent_id": "chat.web", "calls": [], "stage": 1}  # type: ignore[arg-type]
        )
        == "stage_catalog"
    )
    # Every stage OFFERED but one was never called -> re-offer it once.
    assert (
        route_after_stage_model(
            {  # type: ignore[arg-type]
                "agent_id": "chat.web",
                "calls": [],
                "stage": 99,
                "attempted": {"web_search"},
            }
        )
        == "stage_catalog"
    )
    # ...and only once: a model that declines twice gets to answer.
    assert (
        route_after_stage_model(
            {  # type: ignore[arg-type]
                "agent_id": "chat.web",
                "calls": [],
                "stage": 99,
                "attempted": {"web_search"},
                "stage_retried": True,
            }
        )
        == "synthesize"
    )
    # Every staged verb actually used -> that really is the answer.
    assert (
        route_after_stage_model(
            {  # type: ignore[arg-type]
                "agent_id": "chat.web",
                "calls": [],
                "stage": 99,
                "attempted": set(get_agent("chat.web").flow.stages),
            }
        )
        == "synthesize"
    )
    # Stop must still stop, mid-chain.
    assert (
        route_after_stage_model(
            {"agent_id": "chat.web", "calls": [], "stage": 0, "cancelled": True}  # type: ignore[arg-type]
        )
        == "synthesize"
    )
    # And the forced tool-less answer round is not a "declined stage".
    assert (
        route_after_stage_model(
            {  # type: ignore[arg-type]
                "agent_id": "chat.web",
                "calls": [],
                "stage": 0,
                "force_synthesis": True,
            }
        )
        == "synthesize"
    )


def test_a_side_tool_cannot_quietly_spend_a_staged_web_step() -> None:
    """`stage` counts stages OFFERED, and ANY tool call advances the chain.

    `chat.web` keeps `search_room` and the download verbs offered alongside
    every stage (`flow.keep`), so a round that searched the ROOM consumed the
    "search the web" stage: the chain moved on to `fetch_page`, `web_search` was
    never offered again, and the Web agent could finish a web task having never
    touched the web. Only the DECLINED-stage exit re-offered a missed verb, and
    this case leaves through the exit taken after a tool ran.
    """
    from arcelle_sidecar.graphs import route_after_stage_tools

    stages = get_agent("chat.web").flow.stages
    spent_on_a_side_tool = {
        "agent_id": "chat.web",
        "round": 1,
        "max_rounds": 9,
        "stage": len(stages),  # every stage OFFERED...
        "attempted": {"search_room"},  # ...and none of them called
    }
    assert route_after_stage_tools(spent_on_a_side_tool) == "stage_catalog"  # type: ignore[arg-type]
    # Bounded: the single re-offer, then the answer round.
    assert (
        route_after_stage_tools(
            {**spent_on_a_side_tool, "stage_retried": True}  # type: ignore[arg-type]
        )
        == "force_final"
    )
    # And a chain that really did run its verbs closes as before.
    assert (
        route_after_stage_tools(
            {**spent_on_a_side_tool, "attempted": set(stages)}  # type: ignore[arg-type]
        )
        == "force_final"
    )


async def test_the_missed_stage_order_is_retired_once_it_is_obeyed() -> None:
    """Nothing in `corrections` expires on its own — `call_model` re-injects the
    whole list EVERY round — and the re-offer note is an order to call a tool.

    So the chain's closing round, which offers ZERO tools by design, still
    carried "call fetch_page now, then answer", and a small model answered "I
    will now fetch the page" instead of writing the answer. There were tests
    proving a correction is RAISED and none proving one goes away.
    """
    from conftest import FakeChatModel, FakeMCP, Round, call, drive_worker, make_request

    from arcelle_sidecar.mcp_client import ToolResult

    chat = FakeChatModel(
        [
            Round(content="", calls=[call("web_search", query="central bank rate")]),
            # Stage 2 offers fetch_page — declined, which raises the order.
            Round(content="The rate is 4.25% (from the snippet)."),
            # Re-offered, and obeyed this time.
            Round(content="", calls=[call("fetch_page", url="https://boi.org.il")]),
            Round(content='FOUND: "4.25%, effective 2026-07-07" (boi.org.il).'),
        ]
    )
    mcp = FakeMCP(
        tools=specs(["web_search", "fetch_page", "search_room"]),
        results={
            "web_search": ToolResult(text="boi.org.il — rate 4.25%"),
            "fetch_page": ToolResult(text="Effective 2026-07-07 the rate is 4.25%."),
        },
    )
    out = await drive_worker(
        make_request("what is the current central-bank rate?", web_enabled=True),
        chat,
        mcp,
        agent_id="chat.web",
    )

    assert not out.state.get("corrections"), (
        f"the obeyed order was still in force: {out.state.get('corrections')}"
    )
    # ...and the round that had to WRITE the answer never saw it either.
    last = out.chat.seen_messages[-1]
    assert not any(
        "You have not called" in (m.get("content") or "") for m in last
    ), "the tool-less answer round was still being ordered to call a tool"


async def test_an_unobeyed_tool_order_never_reaches_the_tool_less_round() -> None:
    """The retirement `_force_final` used to do had the wrong predicate.

    `_live_corrections` drops an order once the tool HAS been called, but the
    order is raised only because it was NOT — so it survived in exactly the case
    the retirement exists for: the model spends its re-offer round on a
    `flow.keep` side tool, the chain closes, and the tool-less answer round is
    still ordered to "call web_search now". A small model then narrates the call
    it cannot make instead of writing the answer.
    """
    from conftest import FakeChatModel, FakeMCP, Round, call, drive_worker, make_request

    from arcelle_sidecar.mcp_client import ToolResult

    chat = FakeChatModel(
        [
            # Stage 1 offers web_search; a kept side tool is called instead.
            Round(content="", calls=[call("search_room", query="rate")]),
            # Stage 2 offers fetch_page; the side tool again (different args, so
            # it is not suppressed as a duplicate).
            Round(content="", calls=[call("search_room", query="central bank")]),
            # The single re-offer of web_search — declined the same way.
            Round(content="", calls=[call("search_room", query="boi")]),
            # ...and now the tool-less answer round.
            Round(content="From the room's own files: the rate is 4.25%."),
        ]
    )
    mcp = FakeMCP(
        tools=specs(["web_search", "fetch_page", "search_room"]),
        results={"search_room": ToolResult(text="lease.pdf — rate 4.25%")},
    )
    out = await drive_worker(
        make_request("what is the current central-bank rate?", web_enabled=True),
        chat,
        mcp,
        agent_id="chat.web",
    )

    last = out.chat.seen_messages[-1]
    assert not out.chat.offered[-1], "the closing round was supposed to be tool-less"
    assert not any(
        "You have not called" in (m.get("content") or "") for m in last
    ), "the tool-less answer round was ordered to call a tool it was not offered"


def test_a_ground_truth_correction_is_not_retired_by_a_tool_call() -> None:
    """The retirement is narrow on purpose. `CLAIM_UNSUPPORTED` is a fact about
    what the tools did, so it stays true until the model restates its answer —
    only the ORDER to call something is made false by calling it."""
    from arcelle_sidecar.graphs import (
        CLAIM_UNSUPPORTED,
        STAGE_MISSED_NOTE,
        _live_corrections,
    )

    state = {
        "attempted": {"fetch_page", "create_file"},
        "corrections": [
            CLAIM_UNSUPPORTED,
            STAGE_MISSED_NOTE.format(tool="fetch_page"),
            STAGE_MISSED_NOTE.format(tool="web_search"),
        ],
    }
    assert _live_corrections(state) == [  # type: ignore[arg-type]
        CLAIM_UNSUPPORTED,
        STAGE_MISSED_NOTE.format(tool="web_search"),
    ]


def test_stage_and_perceive_routers_fail_open_like_the_shared_one() -> None:
    """Three routers, one missing key, three different answers is a bug factory.

    `route_after_stage_tools` and `route_after_perceive` defaulted `max_rounds`
    to 0 and therefore failed CLOSED — one tool round and out — while
    `graph.route_after_tools` defaults to the backstop and fails open.
    """
    from arcelle_sidecar.graphs import route_after_perceive, route_after_stage_tools

    bare = {"agent_id": "chat.web", "round": 1}
    assert graph_mod.route_after_tools(bare) == "call_model"  # type: ignore[arg-type]
    assert route_after_stage_tools(bare) != "synthesize"  # type: ignore[arg-type]
    bare_ui = {"agent_id": "app.ui", "round": 1}
    assert route_after_perceive(bare_ui) != "synthesize"  # type: ignore[arg-type]


async def test_a_failed_send_is_not_reported_as_sent() -> None:
    """The least reversible action in the roster had no gate at all.

    `connectors.use` is how the app sends email and Slack. It ran plain `react`,
    so a `run_mcp_tool` that ERRORED was still reported to the user as sent —
    the worst instance of the class, because the user then believes a message
    went out that did not. It now runs `react_verify` with `run_mcp_tool` in
    WRITE_TOOLS, so the claim has to be backed by a successful call.
    """
    from conftest import FakeChatModel, FakeMCP, Round, call, drive_worker, make_request

    from arcelle_sidecar.graphs import CLAIM_UNSUPPORTED
    from arcelle_sidecar.mcp_client import ToolResult

    assert template_for("connectors.use") == "react_verify"

    chat = FakeChatModel(
        [
            Round(
                content="",
                calls=[
                    call(
                        "run_mcp_tool",
                        tool="gmail.send",
                        arguments={"to": "a@b.c", "subject": "hi"},
                    )
                ],
            ),
            Round(content="DID: sent the email."),
            Round(content="MISSING: the send failed, nothing went out."),
        ]
    )
    mcp = FakeMCP(
        tools=specs(["search_mcp_tools", "run_mcp_tool"]),
        results={
            "run_mcp_tool": ToolResult(text="connector refused: 401", is_error=True)
        },
    )
    out = await drive_worker(
        make_request("email the summary to a@b.c"), chat, mcp, agent_id="connectors.use"
    )
    assert out.state.get("corrections") == [CLAIM_UNSUPPORTED], (
        "a FAILED send was accepted as sent"
    )


async def test_a_successful_send_is_left_alone() -> None:
    """The other half — the gate must not accuse a send that worked, or the
    Connector agent becomes unusable."""
    from conftest import FakeChatModel, FakeMCP, Round, call, drive_worker, make_request

    from arcelle_sidecar.mcp_client import ToolResult

    chat = FakeChatModel(
        [
            Round(
                content="",
                calls=[call("run_mcp_tool", tool="gmail.send", arguments={"to": "a@b.c"})],
            ),
            Round(content="DID: sent the email to a@b.c."),
        ]
    )
    mcp = FakeMCP(
        tools=specs(["search_mcp_tools", "run_mcp_tool"]),
        results={"run_mcp_tool": ToolResult(text="message id 123 queued")},
    )
    out = await drive_worker(
        make_request("email the summary to a@b.c"), chat, mcp, agent_id="connectors.use"
    )
    assert not out.state.get("corrections")
    # The evidence names WHICH connector tool ran — checkable by a later step.
    assert any("gmail.send" in r for r in out.state.get("produced", []))


async def test_the_write_gate_survives_an_inherited_baton() -> None:
    """The gate must judge what THIS worker wrote, not what it was handed.

    A delegated worker is seeded with the Main agent's referent baton, and the
    gate used to pass whenever `referents` was non-empty — so the SECOND
    specialist in any chain silently lost its write check. That is precisely
    the wrong one to lose: in "summarize the lease, then save the notes", step
    two is the step that writes.

    Both halves are asserted, because only the pair proves the fixture bites:
    the same failed write must raise a correction with an empty baton AND with
    a full one.
    """
    from conftest import FakeChatModel, FakeMCP, Round, call, drive_worker, make_request

    from arcelle_sidecar.mcp_client import ToolResult

    def _run(baton: list[str]):
        chat = FakeChatModel(
            [
                Round(content="", calls=[call("create_file", name="notes.md")]),
                Round(content="DID: saved notes.md."),
            ]
        )
        mcp = FakeMCP(
            results={"create_file": ToolResult(text="disk full", is_error=True)}
        )
        return drive_worker(
            make_request("save the notes", routing=WRITE_ON),
            chat,
            mcp,
            referents=baton,
        )

    empty = await _run([])
    assert empty.state.get("corrections"), (
        "control case broken: a failed write with no baton must be caught"
    )

    inherited = await _run(["create_file: earlier-summary.md"])
    assert inherited.state.get("corrections"), (
        "the inherited baton disabled the write gate — every delegation after "
        "the first could claim a write that never landed"
    )
    # And the baton itself is untouched: it still carries the earlier artifact
    # forward, because suppressing it would break the cross-agent handoff.
    assert "create_file: earlier-summary.md" in inherited.state.get("referents", [])


# --- probe_gate_act: the transcribe agent can finally do its job --------------


async def test_the_transcribe_agent_reaches_its_action_verb() -> None:
    """THE bug this shape exists for.

    `media.transcribe` declared `oneshot` — EXACTLY ONE tool round — while
    TRANSCRIBE_PROMPT says "stt_status ... check it before promising anything".
    An agent that obeyed its own prompt spent its only round on the probe and
    could never reach `retranscribe_file`. Prompt and template contradicted
    each other, and no test said so.
    """
    from conftest import FakeChatModel, FakeMCP, Round, call, drive_worker
    from conftest import make_request, specs

    from arcelle_sidecar.mcp_client import ToolResult

    chat = FakeChatModel(
        [
            # The probe already ran for free, so the model's FIRST round acts.
            Round(content="", calls=[call("retranscribe_file", name="talk.mp4")]),
            Round(content="DID: re-transcribed talk.mp4."),
        ]
    )
    mcp = FakeMCP(
        tools=specs(["stt_status", "retranscribe_file", "list_room_files"]),
        results={"stt_status": ToolResult(text="speech model ready (whisper-large)")},
    )
    out = await drive_worker(
        make_request("re-transcribe talk.mp4"), chat, mcp, agent_id="media.transcribe"
    )

    ran = [c[0] for c in out.mcp.calls]
    assert ran[0] == "stt_status", "the probe must fire first, deterministically"
    assert "retranscribe_file" in ran, (
        "the agent never reached its action verb — the oneshot contradiction"
    )
    # And the probe cost no model round: the model's first turn was the action.
    assert len(out.chat.seen_messages) == 2


async def test_the_transcribe_agent_can_resolve_a_name_and_STILL_act() -> None:
    """The same bug as above, one level up — `oneshot`'s contradiction had been
    rebuilt on this shape's act phase.

    `force_final` sat on the execute_tools back-edge, so the FIRST model-driven
    tool round was also the last. media.transcribe's box holds `list_room_files`
    and its prompt tells it to resolve "the meeting recording" to a real file,
    so the obedient run spent its one round looking — and ended with the file
    found, never transcribed, reported to the user as done. The probe is the
    gate; the act phase is an ordinary cycle.
    """
    from conftest import FakeChatModel, FakeMCP, Round, call, drive_worker
    from conftest import make_request, specs

    from arcelle_sidecar.mcp_client import ToolResult

    chat = FakeChatModel(
        [
            # Round 1: which file is "the meeting recording"?
            Round(content="", calls=[call("list_room_files")]),
            # Round 2: now act on what round 1 found. Under `force_final` this
            # round was tool-less and this call never happened.
            Round(content="", calls=[call("retranscribe_file", name="standup.m4a")]),
            Round(content="DID: re-transcribed standup.m4a."),
        ]
    )
    mcp = FakeMCP(
        tools=specs(["stt_status", "retranscribe_file", "list_room_files"]),
        results={
            "stt_status": ToolResult(text="speech model ready (whisper-large)"),
            "list_room_files": ToolResult(text="standup.m4a, lease.pdf"),
        },
    )
    out = await drive_worker(
        make_request("re-transcribe the meeting recording"),
        chat,
        mcp,
        agent_id="media.transcribe",
    )

    ran = [c[0] for c in out.mcp.calls]
    assert ran[0] == "stt_status", "the probe still fires first, for free"
    assert "list_room_files" in ran
    assert "retranscribe_file" in ran, (
        "resolving a name consumed the only act round — the oneshot "
        "contradiction, rebuilt on probe_gate_act's back-edge"
    )
    assert ran.index("list_room_files") < ran.index("retranscribe_file")


def test_probe_gate_act_does_not_cap_its_act_phase() -> None:
    """Structural guard on the above: no node on this shape may force synthesis
    after a tool round. Pinned on the WIRING, because the behavioural test can
    be made to pass by a model script that happens to act first."""
    g = build_agent_graph("probe_gate_act").get_graph()
    assert "force_final" not in set(g.nodes), (
        "force_final caps the act phase at one round on the ONE shape whose "
        "agent must resolve a file name before it can act"
    )
    edges = {(e.source, e.target) for e in g.edges}
    assert ("execute_tools", "call_model") in edges, "the act cycle must close"


async def test_a_blocked_probe_answers_without_calling_the_model_at_all() -> None:
    """When the capability is missing the answer is a constant, so it should
    cost nothing. Under `react` this path burned two model rounds."""
    from conftest import FakeChatModel, FakeMCP, drive_worker, make_request, specs

    from arcelle_sidecar.agents import get_agent
    from arcelle_sidecar.mcp_client import ToolResult

    chat = FakeChatModel([])  # no scripted rounds: the model must not be called
    mcp = FakeMCP(
        tools=specs(["stt_status", "retranscribe_file"]),
        results={
            "stt_status": ToolResult(text="Speech model is not installed.")
        },
    )
    out = await drive_worker(
        make_request("transcribe the meeting"), chat, mcp, agent_id="media.transcribe"
    )
    assert out.chat.seen_messages == [], "the blocked path must not call the model"
    assert out.final == get_agent("media.transcribe").flow.blocked_answer
    assert [c[0] for c in out.mcp.calls] == ["stt_status"]


async def test_an_unrecognised_probe_result_fails_open() -> None:
    """The blockers match Rust-authored text. If that wording drifts the gate
    must fall through to the normal path — worst case today's behaviour, never
    a false refusal."""
    from conftest import FakeChatModel, FakeMCP, Round, call, drive_worker
    from conftest import make_request, specs

    from arcelle_sidecar.mcp_client import ToolResult

    chat = FakeChatModel(
        [
            Round(content="", calls=[call("retranscribe_file", name="a.mp4")]),
            Round(content="DID: done."),
        ]
    )
    mcp = FakeMCP(
        tools=specs(["stt_status", "retranscribe_file"]),
        # Wording nothing in `blockers` matches.
        results={"stt_status": ToolResult(text="stt subsystem: WARN code 7")},
    )
    out = await drive_worker(
        make_request("re-transcribe a.mp4"), chat, mcp, agent_id="media.transcribe"
    )
    assert "retranscribe_file" in [c[0] for c in out.mcp.calls]


@pytest.mark.parametrize(
    "agent_id", ["media.transcribe", "app.ui", "skills.use", "jobs.workflows"]
)
async def test_an_abstaining_probe_does_not_strip_the_agents_catalog(
    agent_id: str,
) -> None:
    """Regression across every probing shape.

    A probe abstains when the bridge did not serve its tool this run. Routing
    an EMPTY call list into `execute_tools` is not a no-op: `all_dup` starts
    True and nothing clears it, so the node sets `force_synthesis` and the very
    next model round is offered ZERO tools. The agent lost its entire catalog
    because an optional prefetch was unavailable — and it looked like a normal
    tool-less answer, so nothing reported it.
    """
    from conftest import FakeChatModel, FakeMCP, Round, drive_worker
    from conftest import make_request, specs

    # A catalog that deliberately serves NONE of the probe verbs.
    mcp = FakeMCP(tools=specs(["search_room", "list_room_files", "open_file"]))
    chat = FakeChatModel([Round(content="ok")])
    out = await drive_worker(make_request("do something"), chat, mcp, agent_id=agent_id)

    assert out.chat.offered_names, f"{agent_id}: the model was never called"
    assert out.chat.offered_names[0] != [], (
        f"{agent_id}: an abstaining probe stripped the catalog to nothing"
    )


# --- round bounds -------------------------------------------------------------


def test_no_per_agent_round_budget_survives() -> None:
    """The per-agent `Flow.act_rounds` budgets are GONE (owner call).

    Every agent now runs to the shared runaway backstop, so the thing to pin is
    that no clamp crept back in: neither a `Flow` field nor a `budget_for`-style
    helper, and `_run_worker` must hand the worker the REQUEST ceiling whole.
    """
    import inspect

    import arcelle_sidecar.agents as agents_mod

    assert not hasattr(Flow(), "act_rounds")
    assert not hasattr(agents_mod, "budget_for")

    src = inspect.getsource(graph_mod._run_worker)
    assert 'max_rounds = state.get("run_max_rounds"' in src
    assert "budget_for" not in src


# --- the verify gate actually fires (closed 2026-07-25) -----------------------


async def test_an_unsupported_write_claim_is_sent_back_for_restatement() -> None:
    """The File agent's ground-truth check must REACH THE MODEL.

    Regression: `verify_claims` returned ``{"progress": [...]}``. `progress` has
    exactly one reader — `call_model`'s ephemeral re-injection — and `verify`
    runs strictly AFTER the loop has exited, so nothing ever read it. The check
    was inert on every engine, and doubly so on cloud, where the injection is
    gated on `small_model` as well. This test fails on that implementation.
    """
    from conftest import BUILTIN_TOOL_NAMES, FakeChatModel, FakeMCP, Round
    from conftest import call, drive_worker, make_request, specs

    from arcelle_sidecar.graphs import CLAIM_UNSUPPORTED

    chat = FakeChatModel(
        [
            # The write errors, so nothing lands on the referent baton...
            Round(content="", calls=[call("create_file", name="notes.md", content="x")]),
            # ...and the model claims success anyway. This is the real failure.
            Round(content="Saved it to notes.md."),
            # The correction round: tool-less, one chance to restate.
            Round(content="The file was not saved — the write failed."),
        ]
    )
    from arcelle_sidecar.mcp_client import ToolResult

    mcp = FakeMCP(
        tools=specs(BUILTIN_TOOL_NAMES),
        results={"create_file": ToolResult(text="disk full", is_error=True)},
    )
    out = await drive_worker(
        make_request("save a note"), chat, mcp, agent_id="files.read"
    )

    # The correction reached the model as an ephemeral note, on its own round.
    last_seen = out.chat.seen_messages[-1]
    assert any(CLAIM_UNSUPPORTED in (m.get("content") or "") for m in last_seen), (
        "the verify finding never reached the model — the gate is inert"
    )
    # And the user gets the restated answer, not the false claim.
    assert "not saved" in out.final


async def test_a_supported_write_claim_costs_no_extra_round() -> None:
    """The gate must be free when it has nothing to say."""
    from conftest import BUILTIN_TOOL_NAMES, FakeChatModel, FakeMCP, Round
    from conftest import call, drive_worker, make_request, specs

    chat = FakeChatModel(
        [
            Round(content="", calls=[call("create_file", name="notes.md", content="x")]),
            Round(content="Saved it to notes.md."),
        ]
    )
    out = await drive_worker(
        make_request("save a note"),
        chat,
        FakeMCP(tools=specs(BUILTIN_TOOL_NAMES)),
        agent_id="files.read",
    )
    # Exactly two model rounds: no correction round was spent.
    assert len(out.chat.seen_messages) == 2
    assert "Saved it" in out.final


async def test_a_failed_run_gets_its_bounded_repair_round() -> None:
    """`recall_act_check`'s repair gate must actually FIRE.

    Regression (the same class as the `verify_claims` one above, one rung
    down): `check_result` returned ``checked``/``repairs``/``repaired``, none of
    which were declared on `AgentState`. LangGraph filters a node's returned
    dict against the schema and silently drops unknown keys, so every write
    vanished, `route_after_check` always read ``repairs == 0``, and the bounded
    repair the template is NAMED for never ran on any of its four agents — a
    script whose traceback was in the transcript was reported as a success.
    """
    from conftest import BUILTIN_TOOL_NAMES, FakeChatModel, FakeMCP, Round
    from conftest import call, drive_worker, make_request, specs

    from arcelle_sidecar.mcp_client import ToolResult

    chat = FakeChatModel(
        [
            # The run blows up (the probe already fired list_scripts for free).
            Round(content="", calls=[call("run_script", name="etf-report.py")]),
            # The model is about to call it a day…
            Round(content="Ran it."),
            # …but the gate saw the traceback and buys one more round.
            Round(content="etf-report.py failed: no such file book.md."),
        ]
    )
    mcp = FakeMCP(
        tools=specs(BUILTIN_TOOL_NAMES + ["list_scripts", "run_script"]),
        results={
            "run_script": ToolResult(
                text="Traceback (most recent call last): no such file: book.md",
                is_error=False,  # exit-code 0 paths still print tracebacks
            )
        },
    )
    out = await drive_worker(
        make_request("run the ETF report"), chat, mcp, agent_id="scripts.run"
    )
    assert len(out.chat.seen_messages) == 3, "the repair round was never spent"
    assert "failed" in out.final, "the user must hear that the run failed"


async def test_a_clean_run_spends_no_repair_round() -> None:
    """The gate is free when the run worked — `repair_cap` is a ceiling, not a
    schedule."""
    from conftest import BUILTIN_TOOL_NAMES, FakeChatModel, FakeMCP, Round
    from conftest import call, drive_worker, make_request, specs

    from arcelle_sidecar.mcp_client import ToolResult

    chat = FakeChatModel(
        [
            Round(content="", calls=[call("run_script", name="etf-report.py")]),
            Round(content="book.md: 1715 words."),
        ]
    )
    mcp = FakeMCP(
        tools=specs(BUILTIN_TOOL_NAMES + ["list_scripts", "run_script"]),
        results={"run_script": ToolResult(text="book.md: 1715 words")},
    )
    out = await drive_worker(
        make_request("run the ETF report"), chat, mcp, agent_id="scripts.run"
    )
    assert len(out.chat.seen_messages) == 2
    assert "1715" in out.final


def test_no_graph_node_writes_a_state_key_the_schema_would_drop() -> None:
    """The generic guard for the whole hazard class.

    LangGraph drops an undeclared key with no exception and no warning, so a
    node can look correct, pass review, and record nothing — it has now cost
    this codebase three separate bugs (`RefineState.passed`, `probe`'s stray
    `probed`, `check_result`'s whole repair gate). Read the literal keys every
    node function returns and require the schema to know them.
    """
    import ast
    import inspect
    import typing

    from arcelle_sidecar import graphs as graphs_mod

    declared = set(typing.get_type_hints(graph_mod.AgentState))
    offenders: list[str] = []
    for module in (graph_mod, graphs_mod):
        for name, fn in vars(module).items():
            if not (inspect.isfunction(fn) and fn.__module__ == module.__name__):
                continue
            try:
                tree = ast.parse(inspect.getsource(fn).lstrip())
            except (OSError, SyntaxError):  # pragma: no cover - source-less
                continue
            for node in ast.walk(tree):
                # Only `return {"literal": ...}` is checkable; that is also the
                # only shape these nodes use.
                if not (isinstance(node, ast.Return) and isinstance(node.value, ast.Dict)):
                    continue
                for key in node.value.keys:
                    if isinstance(key, ast.Constant) and isinstance(key.value, str):
                        if key.value not in declared:
                            offenders.append(f"{module.__name__}.{name} -> {key.value!r}")
    assert not offenders, (
        "these node returns would be SILENTLY DROPPED — declare them on "
        f"AgentState: {sorted(set(offenders))}"
    )


# --- langgraph.json stays honest ----------------------------------------------


def _studio_config() -> dict:
    import json
    from pathlib import Path

    return json.loads((Path(__file__).parent.parent / "langgraph.json").read_text())


def test_every_langgraph_json_entry_resolves() -> None:
    """A typo here fails only when Studio starts, which is the worst place to
    find out — the roster is documentation, and broken documentation is worse
    than none."""
    import importlib

    for name, ref in _studio_config()["graphs"].items():
        module, _, attr = ref.partition(":")
        obj = getattr(importlib.import_module(module), attr, None)
        assert obj is not None, f"{name} -> {ref} does not resolve"
        assert obj.get_graph() is not None, f"{name} is not a compiled graph"


def test_every_registered_agent_and_template_is_listed() -> None:
    """Drift guard. Adding an agent to the registry without listing it here
    means it silently never appears in Studio, and the roster quietly becomes a
    lie about what the app runs."""
    listed = set(_studio_config()["graphs"])
    for spec in REGISTRY:
        assert f"agent.{spec.id}" in listed, f"{spec.id} is missing from langgraph.json"
    for template in TEMPLATES:
        assert f"template.{template}" in listed, f"{template} is missing"


def test_the_listed_agent_graph_is_the_one_that_agent_actually_runs() -> None:
    """Listing SOMETHING under an agent's name is not enough — it has to be
    that agent's shape, or Studio shows a graph the app never executes.

    Compared by TOPOLOGY, not identity: the Studio entries are the same graphs
    pre-bound to a dev Deps via ``with_config`` (Studio can only send JSON, and
    a ChatModel is not JSON), and that returns a copy.
    """
    import importlib

    for name, ref in _studio_config()["graphs"].items():
        if not name.startswith("agent."):
            continue
        agent_id = name.removeprefix("agent.")
        if agent_id not in {s.id for s in REGISTRY}:
            continue
        module, _, attr = ref.partition(":")
        listed = getattr(importlib.import_module(module), attr)

        def shape(g):
            drawn = g.get_graph()
            return (
                {n for n in drawn.nodes if not n.startswith("__")},
                {(e.source, e.target) for e in drawn.edges},
            )

        assert shape(listed) == shape(graph_for(agent_id)), (
            f"langgraph.json lists {attr} for {agent_id}, whose wiring differs "
            f"from the shape that agent actually runs"
        )


def test_nothing_in_the_package_sets_the_studio_deps_hook() -> None:
    """`STUDIO_DEPS` exists so `langgraph dev` can run a graph — Studio sends
    JSON, and a ChatModel is not JSON.

    It is safe ONLY while nothing in the shipped package assigns it: the moment
    something does, an unwired graph stops raising and starts silently running
    against whatever deps happened to be lying around. `devtools/` is excluded
    from the PyInstaller bundle (verify_bundle_clean.py), so the app always
    leaves it None — this test is what keeps that true.
    """
    from pathlib import Path

    pkg = Path(__file__).parent.parent / "arcelle_sidecar"
    offenders = []
    for path in pkg.rglob("*.py"):
        for i, line in enumerate(path.read_text().splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("#") or stripped.startswith("#:"):
                continue
            # An assignment, not the declaration (`STUDIO_DEPS: X | None = None`)
            # and not a read.
            if "STUDIO_DEPS" in stripped and "=" in stripped:
                if stripped.startswith("STUDIO_DEPS:") and stripped.endswith("= None"):
                    continue
                if "==" in stripped or "is not None" in stripped:
                    continue
                offenders.append(f"{path.name}:{i}: {stripped}")
    assert not offenders, f"the shipped package assigns STUDIO_DEPS: {offenders}"


def test_an_unwired_graph_still_raises() -> None:
    """The hook must not weaken the real error for a genuine wiring bug."""
    import arcelle_sidecar.graph as g

    assert g.STUDIO_DEPS is None, "a test or import set the dev hook"
    with pytest.raises(RuntimeError, match="without Deps"):
        g._deps({"configurable": {}})


# --- the tool-catalog leak (closed 2026-07-25) --------------------------------


def test_no_agent_is_offered_a_tool_outside_its_own_box() -> None:
    """Each agent sees its box and nothing else.

    Regression: `_select_tools` decided "is this a registry tool?" against the
    GROUPED names only, so eleven ungrouped registry tools (web_search,
    fetch_page, list_scripts, run_script, stt_status, retranscribe_file, the
    three studio verbs, and the connector proxy pair) fell through the
    third-party escape hatch and were offered to every agent — including the
    Main agent, whose whole design is that it touches no room tool. Measured
    at 132 leaked tool-offers across the thirteen agents before the fix.
    """
    from arcelle_sidecar.agents import ALL_REGISTRY_TOOLS, toolbox_for
    from arcelle_sidecar.graph import _select_tools

    served = [
        {"type": "function", "function": {"name": n}}
        for n in sorted(ALL_REGISTRY_TOOLS)
    ]
    for spec in REGISTRY:
        box = toolbox_for(spec.id, set(ALL_REGISTRY_TOOLS))
        offered = {
            t["function"]["name"]
            for t in _select_tools(
                served, agent_id=spec.id, unlocked=set(), advisors=False
            )
        }
        extra = offered - box - set(AGENT_TOOL_NAMES)
        assert not extra, f"{spec.id} was offered tools outside its box: {sorted(extra)}"


def test_connected_third_party_mcp_tools_still_pass_through() -> None:
    """Closing the leak must not close the door the escape hatch exists for.

    A user's connected MCP server exposes namespaced tools the registry has
    never heard of. Those are deliberate and must still reach the agent.
    """
    from arcelle_sidecar.agents import ALL_REGISTRY_TOOLS
    from arcelle_sidecar.graph import _select_tools

    served = [
        {"type": "function", "function": {"name": n}}
        for n in sorted(ALL_REGISTRY_TOOLS)
    ] + [{"type": "function", "function": {"name": "slack_send_message"}}]
    offered = {
        t["function"]["name"]
        for t in _select_tools(
            served, agent_id="files.read", unlocked=set(), advisors=False
        )
    }
    assert "slack_send_message" in offered


def test_all_registry_tools_covers_every_box() -> None:
    """The guard is only as good as the set it tests against."""
    from arcelle_sidecar.agents import ALL_REGISTRY_TOOLS, CORE_TOOLS

    assert set(CORE_TOOLS) <= ALL_REGISTRY_TOOLS
    assert set(AGENT_TOOL_NAMES) <= ALL_REGISTRY_TOOLS
    for spec in REGISTRY:
        missing = set(spec.tools) - ALL_REGISTRY_TOOLS
        assert not missing, f"{spec.id} has tools outside the registry set: {missing}"


# --- the Main agent must not deny its own specialists (2026-07-25) -----------


def test_the_main_prompt_does_not_teach_the_agent_to_deny_its_specialists() -> None:
    """Live QA: asked "what agents do you have?", the Main agent answered
    "I don't have a set of 'agents' to show you here, I'm just one assistant".

    The old clause — "Never show ... the agents, their names, or any reasoning
    about them" — was written to stop the model NARRATING plumbing mid-answer,
    which is right. But it over-generalised into denying the capability exists,
    which is (a) false and (b) contradicted on screen: the app renders an
    "AGENT · <label>" chip and a live pipeline roster while specialists run. The
    model was telling the user something their own screen disproved.

    Same failure class as the catalog/prompt mismatch that made it say "I can't
    save files": teach it to disown a capability and it will.
    """
    from arcelle_sidecar.agents import DOMAIN_KEY_ORDER, main_prompt

    # The all-domains rendering: these clauses are structural and must survive
    # whatever the reachable set is.
    low = main_prompt(DOMAIN_KEY_ORDER).lower()
    # It must still be told not to narrate the machinery...
    assert "do not narrate the machinery" in low
    assert "as if you did the work yourself" in low
    # ...but it must be told to answer honestly when ASKED, and never to deny.
    assert "if the user asks what you can do" in low
    assert "never deny having specialists" in low
    # ...but honestly does NOT mean leaking plumbing. The first fix swung too
    # far and the agent answered with raw tool names ("**ask_file_agent**:"),
    # which is meaningless to a user and is the very thing the old clause
    # existed to hide. Areas, not tool names.
    assert "never the tool names" in low
    # The blanket prohibition that caused the denial must be gone.
    assert "never show that format, the agents" not in low


# --- the catalog rebuilds a spilled result has to survive ---------------------


def test_every_node_that_rebuilds_the_catalog_keeps_the_spill_reader() -> None:
    """`read_result` is minted mid-round by `execute_tools`, so it is in no
    agent's box and in nothing the bridge serves (`results.py`). Any node that
    returns a `tools` key rebuilds the catalog from a box — and would retire the
    reader unless it goes through `graphs.narrowed`.

    Pinned as the SET of such nodes rather than as behaviour: a new narrowing
    shape is exactly the case a behavioural test cannot reach, and this makes
    adding one a deliberate act.
    """
    import ast
    import inspect

    from arcelle_sidecar import graphs as graphs_mod

    def returned_catalogs(fn: ast.AST) -> list[ast.expr]:
        return [
            value
            for ret in ast.walk(fn)
            if isinstance(ret, ast.Return) and isinstance(ret.value, ast.Dict)
            for key, value in zip(ret.value.keys, ret.value.values)
            if isinstance(key, ast.Constant) and key.value == "tools"
        ]

    source = ast.parse(inspect.getsource(graphs_mod))
    rebuilders = {
        fn.name: returned_catalogs(fn)
        for fn in ast.walk(source)
        if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef))
        and returned_catalogs(fn)
    }

    assert set(rebuilders) == {"stage_catalog", "route_action"}, (
        "a node started rebuilding the catalog — route its `tools` value through "
        f"`narrowed(state, …)` and add it here: {sorted(rebuilders)}"
    )
    for name, catalogs in rebuilders.items():
        for catalog in catalogs:
            assert (
                isinstance(catalog, ast.Call)
                and isinstance(catalog.func, ast.Name)
                and catalog.func.id == "narrowed"
            ), f"{name} returns a catalog that did not go through narrowed()"


def test_narrowed_is_a_no_op_until_something_is_parked() -> None:
    """It runs on every narrowing round, so the common case must not change."""
    from arcelle_sidecar.graphs import narrowed

    box = [{"type": "function", "function": {"name": "web_search"}}]
    assert narrowed({}, box) == box
    assert narrowed({"spills": []}, box) == box

    with_reader = narrowed({"spills": ["res_1"]}, box)
    assert [t["function"]["name"] for t in with_reader] == ["web_search", "read_result"]
    # ...and re-narrowing an already-carrying catalog does not double it up.
    assert narrowed({"spills": ["res_1"]}, with_reader) == with_reader
