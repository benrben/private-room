"""Dispatch is Arcelle-built, not model-directed (owner decision #2, 2026-08-03).

The defect: the same request produced twelve specialists, then five, then none,
because the MODEL decided the specialist plan. These tests pin the four
properties that make :mod:`arcelle_sidecar.planner` an answer to that rather
than one more thing that can drift:

* **Determinism.** The same request against the same room yields the same plan,
  every time, whatever order the caller's ``served_names`` set happens to
  iterate in.
* **Capability truth.** A plan may only name a specialist this room can actually
  reach, and it derives that from :func:`~arcelle_sidecar.agents.worker_reachable`
  — the same predicate the live catalog is built from. This is the class the
  2026-07-30 harness bug belongs to: when prompt and catalog disagreed, Claude
  Code believed the PROMPT and denied having a browser.
* **Honest degradation.** No specialists at all, a part with no specialist, a
  request whose words name none — three different facts, three different
  answers, and none of them a substituted specialist.
* **Nothing else moved.** ``graph.py``'s four-case honest-answer fallback and
  the degenerate-catalog diagnostic still fire with a plan in play.
"""

from __future__ import annotations

import pytest

from conftest import FakeChatModel, FakeMCP, Round, call, drive, make_request, specs
from arcelle_sidecar.agents import (
    ALL_REGISTRY_TOOLS,
    BATCH_TOOL_NAME,
    CORE_TOOLS,
    DOMAIN_KEYS,
    agent_tool_specs,
    reachable_agent_ids,
    reachable_domain_keys,
)
from arcelle_sidecar.graph import NOTHING_USABLE_TEXT
from arcelle_sidecar.manager import resolve_worker
from arcelle_sidecar.planner import MAX_PLAN_STEPS, build_plan, is_visual_video_intent

# The tiers the Rust bridge really serves (room_mcp::ToolScope), same shape as
# test_capability_truth.py — CloudAdvisor is CORE only, LocalEngine is the lot.
_CORE_ONLY = set(CORE_TOOLS)
_EVERYTHING = set(ALL_REGISTRY_TOOLS)

MATRIX = [
    pytest.param(served, web, id=f"{tier}-web{int(web)}")
    for tier, served in (("core_only", _CORE_ONLY), ("everything", _EVERYTHING))
    for web in (True, False)
]

#: Requests that exercise every domain the registry has, plus the shapes the
#: splitter is meant to handle (sequenced, unsequenced, and plain prose).
REQUESTS = [
    "what does the contract say about rent",
    "search the web for the current rate and then save it as a note",
    "make flashcards from the biology notes",
    "translate the whole book to hebrew",
    "redo the transcript of the standup",
    "go to en.wikipedia.org and read the page about lisbon",
    "create a skill for weekly reports",
    "email dana the summary",
    "summarize new files every morning",
    "open the Room Map",
    "hi there",
]


@pytest.mark.parametrize(
    "question",
    [
        "Use workspace_delete to remove old.txt",
        "Use your own workspace file tools to update notes.txt",
        "Use the filesystem read tool to read /fixture.md",
        "Rename the files in this room with workspace_rename",
    ],
)
def test_explicit_workspace_tool_requests_plan_the_file_agent(question: str) -> None:
    plan = build_plan(question, web_enabled=False, served_names=set(_EVERYTHING))

    assert plan.reason == "planned"
    assert [(step.domain, step.worker) for step in plan.steps] == [
        ("file", "files.read")
    ]
    assert plan.steps[0].instruction == question


@pytest.mark.parametrize(
    "question",
    [
        "delete the weekly skill",
        "move the scheduled job to friday",
        "rename this chat",
    ],
)
def test_broad_mutation_verbs_do_not_force_the_file_domain(question: str) -> None:
    plan = build_plan(question, web_enabled=True, served_names=set(_EVERYTHING))

    assert not plan.steps or plan.steps[0].domain != "file"


def test_exact_visual_frame_request_plans_video_with_verbatim_instruction() -> None:
    question = "what you see in frame 6:00 in @video.mp4"

    plan = build_plan(
        question,
        web_enabled=False,
        served_names=set(_EVERYTHING),
    )

    assert plan.reason == "planned"
    assert [(step.domain, step.worker) for step in plan.steps] == [
        ("file", "media.video")
    ]
    assert plan.steps[0].instruction == question


@pytest.mark.parametrize(
    "question",
    [
        "transcribe video.mp4",
        "show me the transcript of video.mp4",
        "describe the video transcript",
        "explain video codecs",
        "summarize the framework document",
        "tell me the frame rate of video.mp4",
    ],
)
def test_visual_video_planning_does_not_claim_text_or_metadata_asks(
    question: str,
) -> None:
    assert not is_visual_video_intent(question)


def test_visual_frame_plan_names_video_unavailable_without_its_pixel_tool() -> None:
    plan = build_plan(
        "what you see in frame 6:00 in @video.mp4",
        web_enabled=False,
        served_names=set(CORE_TOOLS),
    )

    assert plan.steps == ()
    assert plan.unavailable == (("Video agent", "what you see in frame 6:00 in @video.mp4"),)


# --------------------------------------------------------------------------- #
# determinism — the defect, stated as a property
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("question", REQUESTS)
def test_the_same_request_always_yields_the_same_plan(question: str) -> None:
    first = build_plan(question, web_enabled=True, served_names=set(_EVERYTHING))
    for _ in range(25):
        assert (
            build_plan(question, web_enabled=True, served_names=set(_EVERYTHING))
            == first
        )


@pytest.mark.parametrize("question", REQUESTS)
def test_set_iteration_order_cannot_reach_the_plan(question: str) -> None:
    """``served_names`` is a SET, so its iteration order varies with insertion
    history. A planner that leaked that order into its output would be
    non-deterministic in exactly the way the defect describes while passing the
    test above, which reuses one set."""
    names = sorted(_EVERYTHING)
    orders = [
        set(names),
        set(reversed(names)),
        set(names[len(names) // 2 :] + names[: len(names) // 2]),
    ]
    plans = [
        build_plan(question, web_enabled=True, served_names=order) for order in orders
    ]
    assert all(p == plans[0] for p in plans)


# --------------------------------------------------------------------------- #
# the plan reflects what the room can actually do
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("served,web", MATRIX)
@pytest.mark.parametrize("question", REQUESTS)
def test_a_plan_only_ever_names_a_reachable_specialist(
    question: str, served: set[str], web: bool
) -> None:
    """The invariant, over every tier × web combination. A plan naming a
    specialist the catalog does not hold is the prompt-vs-catalog disagreement
    that made a harness engine deny having a browser."""
    plan = build_plan(question, web_enabled=web, served_names=served)
    live_domains = reachable_domain_keys(web_enabled=web, served_names=served)
    live_workers = reachable_agent_ids(served, web_enabled=web)
    for step in plan.steps:
        assert step.domain in live_domains, f"{question}: planned a dead domain"
        assert step.worker in live_workers, f"{question}: planned a dead worker"


@pytest.mark.parametrize("question", REQUESTS)
def test_the_planned_worker_is_the_one_the_dispatcher_will_actually_pick(
    question: str,
) -> None:
    """The plan's label is what the agent strip shows, so it has to be the agent
    that really runs. Re-deriving it would be a second answer to a question
    `resolve_worker` already owns."""
    plan = build_plan(question, web_enabled=True, served_names=set(_EVERYTHING))
    for step in plan.steps:
        assert step.worker == resolve_worker(
            DOMAIN_KEYS[step.domain],
            step.instruction,
            served_names=set(_EVERYTHING),
            web_enabled=True,
        )


@pytest.mark.parametrize("served,web", MATRIX)
@pytest.mark.parametrize("question", REQUESTS)
def test_the_note_only_ever_names_a_tool_the_catalog_really_holds(
    question: str, served: set[str], web: bool
) -> None:
    """The note tells the hub which call to make, so every tool it names has to
    be in the catalog `prepare` built from the SAME two inputs. A note naming
    ``ask_agents`` in a room whose catalog dropped it (one reachable domain, or
    a `*` tag) would be an instruction the model can only fail."""
    plan = build_plan(question, web_enabled=web, served_names=served)
    catalog = {
        spec["function"]["name"]
        for spec in agent_tool_specs(web_enabled=web, served_names=served)
    }
    for step in plan.steps:
        assert DOMAIN_KEYS[step.domain] in catalog
    if len(plan.steps) > 1:
        assert BATCH_TOOL_NAME in catalog
        assert BATCH_TOOL_NAME in plan.note
    if plan.default_tool:
        assert plan.default_tool in catalog


def test_a_web_off_room_never_plans_a_web_step() -> None:
    """Web access is a room SETTING, and the planner reads it through the same
    reachability predicate as everything else. The web half is not re-routed to
    whoever is left either — it simply is not in the plan."""
    question = "search the web for the current rate and then save it as a note"
    on = build_plan(question, web_enabled=True, served_names=set(_EVERYTHING))
    off = build_plan(question, web_enabled=False, served_names=set(_EVERYTHING))
    # "save it as a note" names no specialist's vocabulary, so it is NOT planned
    # — it goes back to the hub by name (see the remainder test below).
    assert [s.domain for s in on.steps] == ["web"]
    assert on.unplanned == ("save it as a note",)
    assert "web" not in [s.domain for s in off.steps]
    # With the one clause that named a specialist gone, nothing in the request
    # names one at all — so the planner abstains rather than build a plan out of
    # the leftovers and present it as the whole errand.
    assert off.reason == "abstained"


def test_the_web_switch_is_never_reported_as_a_missing_specialist() -> None:
    """WEB_OFF_NOTE is the app's ONE answer for a web-off room, and it ends on
    where the switch is. A second answer here would say "this room has no
    specialist for that" — the permanence claim that note exists to stop, and
    the one that sent a user looking for a feature they already owned (live QA
    2026-07-30). So the planner stays silent and lets that note speak."""
    plan = build_plan(
        "search the web for the current rate",
        web_enabled=False,
        served_names=set(_EVERYTHING),
    )
    assert plan.unavailable == ()
    assert "NO SPECIALIST" not in plan.note


def test_a_tier_without_the_jobs_box_says_so_instead_of_substituting() -> None:
    """The cloud-advisor tier serves no job or workflow tools at all. Silently
    routing "translate the whole book" to whoever IS reachable is the live
    2026-07-24 failure class (that one re-saved an unrelated earlier answer)."""
    question = "translate the whole book to hebrew"
    local = build_plan(question, web_enabled=True, served_names=set(_EVERYTHING))
    cloud = build_plan(question, web_enabled=True, served_names=set(_CORE_ONLY))
    assert [s.worker for s in local.steps] == ["jobs.run"]
    assert cloud.steps == ()
    assert cloud.unavailable == (("Jobs agent", question),)
    assert "Jobs agent" in cloud.note


@pytest.mark.parametrize(
    "question",
    [
        "open lease.pdf",
        "open the file about rent",
        "open the Room Map",
        "click the Settings button",
    ],
)
def test_a_within_domain_discriminator_never_claims_across_domains(
    question: str,
) -> None:
    """THE BUG THIS TEST EXISTS FOR, found reviewing this module's first cut.

    ``chat.browse``'s hints are documented in the registry as the discriminator
    against its SIBLING, "safe to be this broad because siblings are scored only
    WITHIN their own domain". Read as a cross-domain router, its generic
    ``"open "`` claimed every one of these for the Browser agent — "open
    lease.pdf" planned as a web page. A domain is now scored on its DEFAULT
    member's vocabulary only, so a sibling's tie-breaker can never route a turn.
    """
    plan = build_plan(question, web_enabled=True, served_names=set(_EVERYTHING))
    assert "web" not in [s.domain for s in plan.steps], question


# --------------------------------------------------------------------------- #
# honest degradation
# --------------------------------------------------------------------------- #


def test_a_room_with_no_specialists_is_not_given_a_plan_at_all() -> None:
    """The bridge served nothing. `MAIN_PROMPT_NO_SPECIALISTS` already tells the
    model it can reach nothing; a plan note on top would be a second, louder
    story about the same turn."""
    plan = build_plan(
        "search the web and then save it", web_enabled=True, served_names=set()
    )
    assert plan.reason == "no-specialists"
    assert plan.steps == () and plan.unavailable == ()
    assert plan.note == ""


def test_one_broad_lane_word_is_not_a_plan() -> None:
    """"translate" is a JOB_HINTS word, so a bare hit would send a one-line
    translation to the whole-file background pass. The threshold is what keeps
    the planner from being confidently wrong; the same word with the rest of the
    whole-file vocabulary still lands there."""
    assert (
        build_plan(
            "translate this paragraph", web_enabled=True, served_names=set(_EVERYTHING)
        ).reason
        == "abstained"
    )
    assert [
        s.worker
        for s in build_plan(
            "translate the whole book", web_enabled=True, served_names=set(_EVERYTHING)
        ).steps
    ] == ["jobs.run"]


def test_a_request_whose_words_name_no_specialist_leaves_the_judgement_to_the_hub() -> None:
    """"compare my rent to the market" genuinely needs file AND web, and no
    deterministic vocabulary can see that. Forcing one specialist would lose
    half the request, so the planner says out loud that it abstained."""
    plan = build_plan(
        "compare my rent to the market", web_enabled=True, served_names=set(_EVERYTHING)
    )
    assert plan.reason == "abstained"
    assert plan.steps == ()
    assert "COULD NOT NAME THE SPECIALISTS" in plan.note
    assert "ask_file_agent" in plan.note


def test_an_over_long_plan_is_withdrawn_rather_than_truncated() -> None:
    """Folding the overflow into the last step hands somebody else's clause to
    the wrong specialist and dropping it loses part of the request. Both are
    worse than admitting the plan could not be made."""
    # Every clause CLAIMS a domain, and no two neighbours claim the same one —
    # otherwise the cap would be measuring the splitter rather than itself.
    clauses = [
        "search the web for rents",
        "translate the whole book",
        "create a skill for it",
        "email dana the summary",
        "check the latest news",
        "summarize new files every morning",
        "read the skill instructions",
    ]
    at_the_cap = build_plan(
        "; ".join(clauses[:6]), web_enabled=True, served_names=set(_EVERYTHING)
    )
    assert len(at_the_cap.steps) == MAX_PLAN_STEPS
    # One clause more is the SAME request with one more part, so an abstain here
    # is the cap doing its job rather than the vocabulary running out.
    over = build_plan("; ".join(clauses), web_enabled=True, served_names=set(_EVERYTHING))
    assert over.reason == "abstained"
    assert over.steps == ()


@pytest.mark.parametrize(
    "question,unplanned",
    [
        ("search the web for the current rate and then tell me a joke", "tell me a joke"),
        ("search the web for rents; thanks!", "thanks!"),
        ("hi there; check the latest news", "hi there"),
        ("email dana the summary and then explain quantum tunnelling", "explain quantum tunnelling"),
    ],
)
def test_an_unclaimed_clause_is_never_given_to_the_default_specialist(
    question: str, unplanned: str
) -> None:
    """THE BUG THIS TEST EXISTS FOR (review, 2026-08-03).

    An unclaimed clause used to be handed to the DEFAULT domain and then stated
    as fact under "run exactly these steps … do not drop one it does" — so
    "thanks!" planned a File agent sub-loop, and a general-knowledge question
    planned a File agent that would search this room's content, find nothing and
    report MISSING. "Unclaimed" and "belongs to the File agent" are different
    facts; asserting the second is the substituted specialist every other
    paragraph in prompts.py refuses. The clause is not dropped either — it goes
    back to the hub by name.
    """
    plan = build_plan(question, web_enabled=True, served_names=set(_EVERYTHING))
    assert plan.reason == "planned"
    assert "file" not in [s.domain for s in plan.steps], question
    assert unplanned in plan.unplanned
    assert "ARCELLE DID NOT PLAN" in plan.note
    assert unplanned in plan.note
    # …and the clause is still the user's own words, not a paraphrase.
    for text in plan.unplanned:
        assert text in question


def test_a_web_off_clause_is_not_re_routed_to_whoever_is_left() -> None:
    """The same bug's worse half. With the web off, "search the web for rents;
    email dana" planned the WEB clause as a FILE agent step — a specialist
    substituted for a room SETTING, which is exactly the re-routing that once
    answered "redo the transcript" by re-saving an unrelated reply.

    It is still not reported as a MISSING specialist: `WEB_OFF_NOTE` is the
    app's one answer for a web-off room and it ends on where the switch is.
    """
    plan = build_plan(
        "search the web for rents; email dana the summary",
        web_enabled=False,
        served_names=set(_EVERYTHING),
    )
    assert [s.domain for s in plan.steps] == ["connector"]
    assert plan.unplanned == ("search the web for rents",)
    assert plan.unavailable == ()
    assert "NO SPECIALIST" not in plan.note


def test_the_planner_has_no_tagged_case_because_it_never_sees_one() -> None:
    """The `*` tag used to reach here as a ``tagged=`` argument and return an
    empty plan. It cannot reach here at all now: `graph.run_agent` sends a
    tagged turn straight to the specialist, so the hub — and therefore this
    planner — only ever runs on an untagged one.

    Pinned rather than deleted: an argument that quietly came back would put a
    second route into the feature, and the tagged branch's empty plan would
    then be indistinguishable from the abstain the hub is told to act on.
    """
    with pytest.raises(TypeError):
        build_plan(  # type: ignore[call-arg]
            "*web what is the weather",
            web_enabled=True,
            served_names=set(_EVERYTHING),
            tagged="web",
        )


# --------------------------------------------------------------------------- #
# the planner labels; it never fills a slot
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("question", REQUESTS)
def test_every_instruction_is_the_users_own_words(question: str) -> None:
    """The dispatch proposal's hard line: a label may come from code, a slot may
    not. Every character of every instruction has to appear in what the user
    typed, so a mis-planned step still cannot invent a filename."""
    plan = build_plan(question, web_enabled=True, served_names=set(_EVERYTHING))
    for step in plan.steps:
        for part in step.instruction.split("; "):
            assert part in question, f"{part!r} is not the user's own words"


def test_a_sequenced_clause_is_the_only_thing_that_creates_a_dependency() -> None:
    parallel = build_plan(
        "search the web for rents; email dana the summary",
        web_enabled=True,
        served_names=set(_EVERYTHING),
    )
    assert [s.needs_previous for s in parallel.steps] == [False, False]
    sequenced = build_plan(
        "search the web for rents and then email dana the summary",
        web_enabled=True,
        served_names=set(_EVERYTHING),
    )
    assert [s.needs_previous for s in sequenced.steps] == [False, True]


def test_two_clauses_for_the_same_specialist_are_one_step() -> None:
    """Asking one agent twice in a round is the "twelve specialists" shape in
    miniature, and it costs a whole extra sub-loop."""
    plan = build_plan(
        "search the web for rents; also search the web for local salaries",
        web_enabled=True,
        served_names=set(_EVERYTHING),
    )
    assert len(plan.steps) == 1
    assert "rents" in plan.steps[0].instruction
    assert "salaries" in plan.steps[0].instruction


# --------------------------------------------------------------------------- #
# end to end, through the real graph
# --------------------------------------------------------------------------- #


async def test_the_hub_is_handed_the_plan_arcelle_built() -> None:
    chat = FakeChatModel([Round(content="ok")])
    out = await drive(
        make_request(
            "search the web for the current rate and then email dana the summary",
            web_enabled=True,
        ),
        chat,
        # The default fixture serves the BUILTIN box only, which carries no
        # connector tools — and a plan must never name a specialist the catalog
        # does not hold, so the two-step shape needs a tier that really has both.
        FakeMCP(tools=specs(sorted(_EVERYTHING))),
    )
    system = chat.seen_messages[0][0]["content"] or ""
    assert "THIS TURN'S PLAN IS ALREADY MADE" in system
    assert "1. Web agent" in system
    assert "2. Connector agent" in system and "[needs step 1]" in system
    # …and the plan is visible BEFORE the model acts on it, so a hub that
    # deviates from it can be seen to have deviated.
    assert [e["v"] for e in out.of("step")][0] == "Plan: Web agent → Connector agent"


async def test_an_unplanned_turn_is_told_the_planner_abstained() -> None:
    """The control for the test above: no plan must not look like a plan that
    failed to render."""
    chat = FakeChatModel([Round(content="ok")])
    out = await drive(make_request("compare my rent to the market"), chat)
    system = chat.seen_messages[0][0]["content"] or ""
    assert "THIS TURN'S PLAN IS ALREADY MADE" not in system
    assert "COULD NOT NAME THE SPECIALISTS" in system
    assert not [e for e in out.of("step") if str(e["v"]).startswith("Plan:")]


async def test_a_degenerate_bridge_still_reports_itself_and_is_never_planned() -> None:
    """The diagnostic that survives this packet: when the bridge serves nothing,
    the cause travels with the symptom as a step chip — because the model's own
    words about it describe the MODEL, not the fault. And a turn with no
    specialists gets no plan paragraph to contradict it."""
    chat = FakeChatModel([Round(content="ok")])
    out = await drive(
        make_request("search the web and then save it", web_enabled=True),
        chat,
        FakeMCP(tools=specs([])),
    )
    steps = [e["v"] for e in out.of("step")]
    assert steps == ["No specialists available — the room tool bridge served 0 tools this run"]
    assert [e["ok"] for e in out.of("step_status")] == [False]
    system = chat.seen_messages[0][0]["content"] or ""
    assert "THIS TURN'S PLAN IS ALREADY MADE" not in system
    assert "COULD NOT NAME THE SPECIALISTS" not in system
    assert "you have NO specialist agents" in system


async def test_the_four_case_fallback_still_fires_under_a_plan() -> None:
    """`_fallback_answer`'s fourth case, on a turn that WAS planned.

    A CORE-only bridge with the web off: the plan refuses the whole-file half by
    name, the hub asks for a web specialist anyway, the ask is refused, and the
    hub writes nothing. No report, no referent — and still not "nothing was run
    and nothing was changed", which is what the user used to read beside a red
    step chip.
    """
    chat = FakeChatModel(
        [
            Round(content="", calls=[call("ask_web_agent", instruction="the rate")]),
            Round(content=""),
        ]
    )
    out = await drive(
        make_request(
            "translate the whole book to hebrew and then search the web for the rate",
            web_enabled=False,
        ),
        chat,
        FakeMCP(tools=specs(sorted(_CORE_ONLY))),
    )
    system = chat.seen_messages[0][0]["content"] or ""
    assert "NO SPECIALIST for part of what was asked" in system
    assert "Jobs agent" in system
    assert out.final == NOTHING_USABLE_TEXT
    assert any(e["t"] == "step_status" and not e["ok"] for e in out.events)
