"""The composer's ``*`` tag: the user names the specialist a turn goes to.

Owner feature, 2026-08-03 — "the user can ask the specialist agent to run by
tag then using special symbol (like *) and dropdown with all the agents will
appear". The dropdown half is drawn by the host; both halves are DERIVED from
this module's :func:`reachable_domain_keys`, and these tests pin that they
cannot come apart:

* the menu (:func:`specialist_roster`) may only offer what the room can
  actually RUN — it and routing read one mapping, :func:`specialist_workers`,
  so a row that cannot be dispatched and a dispatch that was never offered are
  both unrepresentable,
* a tagged turn's catalog holds ONLY that specialist — so the hub has no tool
  with which to reach a different one, which is what makes the tag a route
  rather than a suggestion,
* and a tag for a specialist this room cannot serve narrows NOTHING and is
  refused by name, because a hub with an empty catalog reads as "the bridge is
  down" — a different fault with a different answer.

ONE policy on an unrecognised tag, on both sides of the wire (2026-08-03): it
is refused, by name, with the valid names attached. The host refuses the send
outright, exactly as it does for a ``#cmd`` or ``/skill`` typo; a tag that
reaches us anyway (a headless ``agent_run``, or a composer whose roster never
loaded) is refused in the answer. What neither layer may do is treat it as
ordinary prose — it was doing that here, while the composer was refusing the
identical message, and a user would have seen a turn run as though they had
never typed the tag at all.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from conftest import (
    BUILTIN_TOOL_NAMES,
    FakeChatModel,
    FakeMCP,
    Round,
    drive,
    make_request,
    specs,
)
from arcelle_sidecar.messages import ToolCall
from arcelle_sidecar.graph import PIXEL_EVIDENCE_MISSING
from arcelle_sidecar.routing import BROWSE_TOOL_NAMES
from arcelle_sidecar.agents import (
    ALL_REGISTRY_TOOLS,
    BATCH_TOOL_NAME,
    CORE_TOOLS,
    DOMAIN_KEYS,
    REGISTRY,
    agent_tool_specs,
    get_agent,
    reachable_agent_ids,
    reachable_domain_keys,
    specialist_catalog,
    specialist_roster,
    specialist_workers,
    tagged_specialist,
    worker_reachable,
)

_CORE_ONLY = set(CORE_TOOLS)
_EVERYTHING = set(ALL_REGISTRY_TOOLS)

MATRIX = [
    pytest.param(served, web, id=f"{tier}-web{int(web)}")
    for tier, served in (("core_only", _CORE_ONLY), ("everything", _EVERYTHING))
    for web in (True, False)
]


def test_cloud_privacy_catalog_keeps_transcript_status_but_hands_video_local() -> None:
    """ARC-004/024: advertise only useful payloads the cloud model can receive."""
    from arcelle_sidecar.privacy import cloud_privacy_tool_allowed

    effective = {name for name in _EVERYTHING if cloud_privacy_tool_allowed(name)}
    rows = {
        row["key"]: row
        for row in specialist_catalog(web_enabled=True, served_names=effective)
    }
    assert rows["transcribe"]["capability"] == "full"
    assert "stt_status" in effective
    assert "retranscribe_file" not in effective
    assert rows["video"]["capability"] == "unavailable"
    assert rows["video"]["localHandoff"] is True
    assert "On this Mac" in str(rows["video"]["capabilityReason"])
    assert "view_media_frame" not in effective
    for tag in ("scripts", "sketch", "app"):
        assert rows[tag]["capability"] == "unavailable"
        assert rows[tag]["localHandoff"] is True
    assert "view_screenshot" not in effective


def test_catalog_reasons_and_unavailable_workers_stay_unavailable() -> None:
    web_disabled = {
        row["key"]: row
        for row in specialist_catalog(web_enabled=False, served_names=_EVERYTHING)
    }
    assert web_disabled["web"]["capabilityReason"] == "Turn on room internet"

    connector_disabled = {
        row["key"]: row
        for row in specialist_catalog(web_enabled=True, served_names=_CORE_ONLY)
    }
    assert connector_disabled["connector"]["capabilityReason"] == "Install and enable a connector"

    unavailable = replace(get_agent("files.read"), available=False)
    assert not worker_reachable(unavailable, web_enabled=True, served_names=_EVERYTHING)


def _names(specs: list[dict]) -> list[str]:
    return [spec["function"]["name"] for spec in specs]


# --------------------------------------------------------------------------- #
# parsing the tag
# --------------------------------------------------------------------------- #


def test_a_leading_tag_is_read_and_lifted_off_the_question() -> None:
    assert tagged_specialist("*web what is the weather") == (
        "web",
        "what is the weather",
    )


def test_the_tag_may_stand_alone() -> None:
    assert tagged_specialist("*file") == ("file", "")


def test_the_tag_vocabulary_is_the_MENUS_and_only_the_menus() -> None:
    """A model's spellings of a domain are not a person's.

    ``normalize_domain_key`` accepts ``ask_web_agent`` and ``chat.browse``
    because a MODEL emits those; this token is typed by a person out of the
    ``*`` menu, and the menu inserts a domain key. While the tag accepted them
    the host could not lex them at all (``composer.ts`` matches ``[a-z]+``), so
    it sent them as ordinary prose and this side dispatched the Web agent for a
    turn the composer had shown as untagged. Same grammar on both sides, or the
    two layers cannot agree about anything downstream of it.
    """
    for text in ("*ask_web_agent find X", "*chat.browse open the site"):
        assert tagged_specialist(text) == ("", text)


def test_a_star_that_is_not_the_first_token_is_left_alone() -> None:
    """Mid-sentence a '*' is multiplication, a footnote or a bullet."""
    for text in ("2 * 3 = 6", "see the note *web below", "**bold**"):
        assert tagged_specialist(text) == ("", text)


def test_an_unknown_name_comes_back_AS_TYPED_not_as_no_tag() -> None:
    """The disagreement this file was rewritten for (2026-08-03).

    This used to return ``None`` — the same answer as "there was no tag" — so a
    typo ran an ordinary turn and nothing anywhere told the user their
    ``*banana`` had gone nowhere, while the composer refused the identical
    message outright. Reporting the name is what lets `prepare` refuse it by
    name; whether a name is one this room HAS is reachability, and only the
    served catalog knows that.
    """
    assert tagged_specialist("*banana do the thing") == ("banana", "do the thing")


def test_a_tag_is_never_a_PREFIX_of_a_real_specialist() -> None:
    """"*webbing" is the name "webbing", not the "web" specialist.

    It is a tag — a whole word followed by a space is exactly the shape — and
    it is one no room has, so it takes the refusal path by that name. What it
    must never do is quietly reach the Web agent. `composer.ts` reads the same
    string the same way and refuses to send it, which is the point.
    """
    assert tagged_specialist("*webbing is a thing") == ("webbing", "is a thing")


# --------------------------------------------------------------------------- #
# the tag ROUTES the turn
#
# Direct routing (owner report 2026-08-04: "when calling specialist it still
# calls the main agent first not direct to him"). The tag used to NARROW the
# hub's catalog to one ask_*_agent tool — which is not a route: the Main agent
# still ran, still planned and still delegated, and the diagram lit a hub node
# for a decision the user had already made. `graph._run_tagged` now invokes the
# specialist's own graph as the turn, and these pin that nothing else does.
# --------------------------------------------------------------------------- #


def test_the_tag_no_longer_touches_the_hubs_catalog() -> None:
    """The narrowing is GONE, not merely unused.

    `agent_tool_specs` grew an ``only=`` argument for the tag; a tagged turn
    does not reach the hub any more, so an argument that still narrowed it
    would be a second, unreachable route into the same feature — and the next
    reader would have to work out which one runs.
    """
    with pytest.raises(TypeError):
        agent_tool_specs(  # type: ignore[call-arg]
            web_enabled=True, served_names=_EVERYTHING, only="web"
        )


@pytest.mark.parametrize(("served", "web"), MATRIX)
def test_every_tag_the_menu_offers_names_a_worker_that_can_run(
    served: set[str], web: bool
) -> None:
    """Menu and ROUTE, checked against each other at every tier.

    The route is a worker id now, not an ``ask_*_agent`` tool: there is no
    delegation on a tagged turn to aim a tool at.
    """
    live = specialist_workers(web_enabled=web, served_names=served)
    for entry in specialist_roster(web_enabled=web, served_names=served):
        assert live[entry["key"]] == entry["agent"], entry
        assert entry["agent"] in reachable_agent_ids(served, web_enabled=web), entry


def test_a_tag_can_never_reach_a_specialist_the_room_lacks() -> None:
    """The web is OFF: tagging an internet specialist must not conjure one."""
    live = specialist_workers(web_enabled=False, served_names=_EVERYTHING)
    assert "web" not in live
    assert "browse" not in live
    assert "file" in live, "the room still has the specialists it really has"


@pytest.mark.parametrize("tag", ["web", "banana"])
def test_both_flavours_of_no_such_specialist_are_ONE_answer(tag: str) -> None:
    """A real specialist this room cannot serve, and a name that is no
    specialist anywhere, are indistinguishable in the routing table — which is
    what lets both take the single refuse-by-name path."""
    live = specialist_workers(web_enabled=False, served_names=_EVERYTHING)
    assert live.get(tag) is None


# --------------------------------------------------------------------------- #
# the menu
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(("served", "web"), MATRIX)
def test_the_menu_IS_the_routable_set(served: set[str], web: bool) -> None:
    """THE anti-drift assertion, asserted as an equality so it cannot rot.

    The menu is a promise, and a promise is only worth what it can be redeemed
    for. Both sides read `specialist_workers`, so a row the room cannot run and
    a specialist that runs but is never offered are equally unrepresentable —
    and this test is what says so at every tier, rather than spot-checking one.
    """
    rows = specialist_roster(web_enabled=web, served_names=served)
    live = specialist_workers(web_enabled=web, served_names=served)
    assert [e["key"] for e in rows] == list(live)
    assert [e["agent"] for e in rows] == list(live.values())


@pytest.mark.parametrize(("served", "web"), MATRIX)
def test_the_menu_offers_every_agent_this_room_can_actually_reach(
    served: set[str], web: bool
) -> None:
    """…and the routable set is itself the room's real agents.

    The equality above pins menu against routing; without this one BOTH could
    narrow together and the test would still pass. `reachable_agent_ids` is the
    independent answer — the published provider × agent matrix reads it — so an
    agent the room can dispatch to and the menu omits fails here.
    """
    rows = specialist_roster(web_enabled=web, served_names=served)
    assert {e["agent"] for e in rows} == set(
        reachable_agent_ids(served, web_enabled=web)
    )


def test_the_browser_is_its_own_menu_entry_beside_the_web_agent() -> None:
    """THE owner report, 2026-08-03: the `*` menu showed only "web".

    `chat.browse` is a SIBLING of `chat.web` under `ask_web_agent` because the
    Main agent's catalog is capped at six domain tools — a 4B picks reliably
    among no more. That cap is about a MODEL choosing under a context budget
    and has nothing to say about a person reading a dropdown, where "search the
    web" and "drive a page" are two different jobs. A menu built per DOMAIN
    collapsed them and the room's browser was invisible.
    """
    rows = {
        e["key"]: e
        for e in specialist_roster(web_enabled=True, served_names=_EVERYTHING)
    }
    assert "browse" in rows, sorted(rows)
    assert rows["browse"]["agent"] == "chat.browse"
    assert rows["browse"]["label"] == "Browser agent"
    # …and it is DISTINCT from the Web agent, not a second name for it: same
    # domain tool, different worker, different words. Two rows reading alike
    # would be the same failure wearing a second label.
    assert rows["web"]["agent"] == "chat.web"
    assert rows["browse"]["tool"] == rows["web"]["tool"] == "ask_web_agent"
    assert rows["browse"]["area"] != rows["web"]["area"]
    assert rows["browse"]["description"] != rows["web"]["description"]


def test_going_finer_in_the_MENU_left_the_model_facing_catalog_alone() -> None:
    """The other half of the owner's call, and the one with a running cost.

    The menu going per-agent must not drag the CATALOG per-agent with it. The
    ≤6 domain cap is what a 4B picks among reliably, and every entry is paid for
    in each turn's prompt budget — which is close to its ceiling. So: no
    `ask_browse_agent`, the browser still reached through `ask_web_agent`, and
    the menu strictly finer than the catalog (or this pins nothing).
    """
    catalog = _names(agent_tool_specs(web_enabled=True, served_names=_EVERYTHING))
    assert "ask_browse_agent" not in catalog
    assert "ask_web_agent" in catalog
    assert len([n for n in catalog if n.startswith("ask_") and n != BATCH_TOOL_NAME]) <= 6
    rows = specialist_roster(web_enabled=True, served_names=_EVERYTHING)
    assert len(rows) > len(catalog), (len(rows), catalog)


def test_the_two_internet_agents_describe_what_each_ACTUALLY_does() -> None:
    """A distinct row is worth nothing if both sentences say "the internet".

    The user picks from these words alone, and picking the wrong one costs a
    whole turn: the Browser agent holds no search tool and has to guess an
    address, the Web agent cannot click anything. So each says which it is.
    """
    rows = {
        e["key"]: e
        for e in specialist_roster(web_enabled=True, served_names=_EVERYTHING)
    }
    web, browse = rows["web"]["description"].lower(), rows["browse"]["description"].lower()
    assert "search" in web and "fetch" in web
    assert "browser" in browse and ("click" in browse or "operates" in browse)
    assert "search" not in browse, "the Browser agent holds no search tool"


def test_a_web_disabled_room_offers_NEITHER_internet_specialist() -> None:
    """The live 2026-07-24 failure, in menu form: offering either would let a
    user tag a turn the room then answers from its own documents.

    Both, because they are two rows now — the Browser agent was never at risk
    of appearing on its own before, and is exactly the row a per-agent menu
    could newly leak. `worker_reachable` refuses both on the room setting.
    """
    keys = [
        e["key"]
        for e in specialist_roster(web_enabled=False, served_names=_EVERYTHING)
    ]
    assert "web" not in keys
    assert "browse" not in keys


def test_a_tier_that_serves_no_browse_tools_offers_no_Browser_row() -> None:
    """The web is ON and the room still cannot drive a page.

    A cloud-CLI room is served CONTENT tools and no `browse_*` at all, so the
    Browser agent's whole box is missing while the Web agent's search verbs are
    there. Reachability is per AGENT for exactly this: a menu that fell back to
    the domain here would offer "Browser agent" and run the Web agent.
    """
    served = _EVERYTHING - set(BROWSE_TOOL_NAMES)
    keys = [e["key"] for e in specialist_roster(web_enabled=True, served_names=served)]
    assert "web" in keys, "search still works — only the browser is gone"
    assert "browse" not in keys


@pytest.mark.parametrize(("served", "web"), MATRIX)
def test_every_menu_row_is_complete_and_names_a_real_tool(
    served: set[str], web: bool
) -> None:
    for entry in specialist_roster(web_enabled=web, served_names=served):
        assert entry["tool"] in set(DOMAIN_KEYS.values())
        assert entry["agent"] in {spec.id for spec in REGISTRY}
        assert entry["label"].strip()
        assert entry["area"].strip()
        assert entry["description"].strip()


def test_every_tag_a_person_can_be_offered_is_one_the_composer_can_LEX() -> None:
    """The menu inserts its key into the composer, which re-reads it with
    `[a-z]+` (`composer.ts parseComposer` matches the same). A row whose key
    the parser cannot lex would insert text the host then refuses to send."""
    for entry in specialist_roster(web_enabled=True, served_names=_EVERYTHING):
        assert tagged_specialist(f"*{entry['key']} do it") == (entry["key"], "do it")


def test_the_menu_label_is_the_agents_own_label() -> None:
    """The words the agent diagram will use for the node that lights up."""
    rows = {
        e["key"]: e["label"]
        for e in specialist_roster(web_enabled=True, served_names=_EVERYTHING)
    }
    assert rows["file"] == "File agent"
    assert rows["web"] == "Web agent"
    assert rows["browse"] == "Browser agent"


def test_a_domains_default_worker_keeps_the_DOMAIN_key_as_its_tag() -> None:
    """"*web" meant the Web agent before this change and must still mean it.

    Per-agent tags could have renumbered the whole vocabulary; the import-time
    assert in `agents` pins each domain's FIRST member — the one
    `resolve_worker` returns on a tie — to the domain's own key, so every tag
    a user or a saved message already contains still lands where it did.
    """
    live = specialist_workers(web_enabled=True, served_names=_EVERYTHING)
    for key, tool in DOMAIN_KEYS.items():
        assert key in live, (tool, sorted(live))
    assert live["web"] == "chat.web"
    assert live["file"] == "files.read"


# --------------------------------------------------------------------------- #
# end to end, through the real graph
# --------------------------------------------------------------------------- #


def _last_plan(out) -> list[dict]:
    plans = [e for e in out.events if e.get("t") == "plan"]
    return plans[-1]["v"] if plans else []


async def test_a_tagged_turn_runs_the_SPECIALIST_and_no_hub_round() -> None:
    """THE owner report, end to end: "it still calls the main agent first".

    Under the old narrowing the first model round was the Main agent's, holding
    exactly one ``ask_web_agent`` — a hub deciding a route the user had already
    decided. Now the first (and only) round is the Web agent's own, holding the
    Web agent's box, and no ask_*_agent tool exists anywhere in the turn.
    """
    chat = FakeChatModel([Round(content="the lease needs 60 days notice")])
    out = await drive(make_request("*file what notice does the lease need"), chat)
    offered = chat.offered_names[0]
    assert "search_room" in offered, offered
    assert not [n for n in offered if n.startswith("ask_")], offered
    assert BATCH_TOOL_NAME not in offered
    # No hub round anywhere in the turn, not merely not first.
    for round_tools in chat.offered_names:
        assert not [n for n in round_tools if n.startswith("ask_")], round_tools
    # …and the SPECIALIST's own words are the answer: nothing recomposed them.
    assert out.final == "the lease needs 60 days notice"


async def test_a_tagged_video_turn_is_refused_when_the_model_has_no_image_input() -> None:
    """ARC-024: an explicit tag cannot bypass the provider capability gate."""
    req = make_request("*video describe the frame at 1:05").model_copy(
        update={"supports_vision": False}
    )
    chat = FakeChatModel([Round(content="I saw the pixels anyway")])
    mcp = FakeMCP(specs(sorted(ALL_REGISTRY_TOOLS)))

    out = await drive(req, chat, mcp)

    assert chat.offered_names == []
    assert mcp.calls == []
    assert "*video isn't a specialist this room has" in out.final
    assert "On this Mac" in out.final


async def test_a_video_tag_without_video_tools_has_no_capability_diagnosis() -> None:
    """A missing room tool is not a privacy or model-capability failure."""
    chat = FakeChatModel([Round(content="I saw the frame anyway")])
    served = set(ALL_REGISTRY_TOOLS) - {"view_media_frame"}

    out = await drive(
        make_request("*video describe the frame at 1:05"),
        chat,
        FakeMCP(specs(sorted(served))),
    )

    assert chat.offered_names == []
    assert "*video isn't a specialist this room has" in out.final
    assert "Cloud Privacy" not in out.final
    assert "Vision capability" not in out.final


async def test_a_blind_tagged_file_turn_cannot_claim_static_visual_details() -> None:
    req = make_request("*file describe what is shown in photo.png").model_copy(
        update={"supports_vision": False, "max_rounds": 5}
    )
    chat = FakeChatModel(
        [
            Round(content="The OCR says invoice."),
            Round(content="I infer it is an invoice."),
        ]
    )
    mcp = FakeMCP(specs(sorted(ALL_REGISTRY_TOOLS)))

    out = await drive(req, chat, mcp)

    assert all("view_file_image" not in names for names in chat.offered_names)
    assert mcp.calls == []
    assert out.final == PIXEL_EVIDENCE_MISSING


async def test_a_tagged_turn_draws_ONE_node_and_it_is_the_specialist() -> None:
    """Requirement 4: the diagram shows what actually happened.

    The roster used to open with a Main agent node — drawn before any model
    call, so it appeared even on a turn the hub never decided anything in. One
    entry, carrying the specialist's own label, is the honest picture.
    """
    chat = FakeChatModel([Round(content="the lease needs 60 days notice")])
    out = await drive(make_request("*file what notice does the lease need"), chat)
    roster = _last_plan(out)
    assert [e["agent"] for e in roster] == ["files.read"], roster
    assert roster[0]["label"] == "File agent"
    assert roster[0]["status"] == "done"
    assert roster[0]["instruction"] == "what notice does the lease need", "tag lifted"
    assert not [e for e in roster if e["agent"] == "chat.answer"]


async def test_a_tag_can_name_a_SIBLING_worker_its_domain_would_not_pick() -> None:
    """``*browse`` is the Browser agent, not "the web domain's default".

    Routing reads `specialist_workers`, which is per-AGENT, so the menu's finer
    grain is a real route rather than a label. Through `resolve_worker` — which
    scores a domain's members by the instruction's vocabulary — "what is the
    weather" would have landed on the Web agent under the Browser's name.
    """
    chat = FakeChatModel([Round(content="opened it")])
    out = await drive(
        make_request("*browse what is the weather", web_enabled=True),
        chat,
        FakeMCP(specs([*BUILTIN_TOOL_NAMES, *BROWSE_TOOL_NAMES])),
    )
    assert [e["agent"] for e in _last_plan(out)] == ["chat.browse"]


async def test_a_multi_round_specialist_is_still_the_only_agent_that_runs() -> None:
    """The Web agent runs `chain_stage` — several model rounds, one per stage.

    Worth its own case: the single-round shape above could pass on a build that
    only skipped the hub for turns that happen to end immediately.
    """
    chat = FakeChatModel(
        [
            Round(calls=[ToolCall(name="web_search", arguments={"query": "weather"}, id="c1")]),
            Round(content="rain"),
            Round(content="rain"),
        ]
    )
    out = await drive(make_request("*web what is the weather", web_enabled=True), chat)
    assert len(chat.offered_names) > 1, "this shape is supposed to take rounds"
    for round_tools in chat.offered_names:
        assert not [n for n in round_tools if n.startswith("ask_")], round_tools
    assert [e["agent"] for e in _last_plan(out)] == ["chat.web"]


async def test_EVERY_row_the_menu_offers_really_runs_that_agent() -> None:
    """The menu set and the routable set, checked THROUGH THE GRAPH.

    `test_the_menu_IS_the_routable_set` pins that the two derive from one
    mapping; this pins that the mapping is what the turn actually obeys. A row
    in the dropdown that dispatches nothing — or dispatches somebody else — is
    the defect this whole feature exists to remove, only moved one layer down.

    Both directions: every offered tag runs ITS OWN agent, and a name the menu
    does not offer runs nothing at all.
    """
    served = list(ALL_REGISTRY_TOOLS)
    rows = specialist_roster(web_enabled=True, served_names=set(served))
    assert len(rows) > 5, rows
    for row in rows:
        chat = FakeChatModel([Round(content="ok")])
        out = await drive(
            make_request(f"*{row['key']} do the thing", web_enabled=True),
            chat,
            FakeMCP(specs(served)),
        )
        assert [e["agent"] for e in _last_plan(out)] == [row["agent"]], row
    offered = {row["key"] for row in rows}
    for absent in ("banana", "notanagent"):
        assert absent not in offered
        chat = FakeChatModel([Round(content="ok")])
        out = await drive(
            make_request(f"*{absent} do the thing", web_enabled=True),
            chat,
            FakeMCP(specs(served)),
        )
        assert _last_plan(out) == [], absent
        assert chat.offered_names == [], absent


async def test_an_untagged_question_is_UNCHANGED() -> None:
    """The control. Without it every test above would pass on a build that had
    simply lost its hub."""
    chat = FakeChatModel([Round(content="ok")])
    out = await drive(make_request("what is the weather", web_enabled=True), chat)
    offered = chat.offered_names[0]
    assert "ask_web_agent" in offered
    assert "ask_file_agent" in offered
    assert BATCH_TOOL_NAME in offered
    assert [e["agent"] for e in _last_plan(out)] == ["chat.answer"]


async def test_the_tagged_specialist_is_told_to_ANSWER_not_to_report() -> None:
    """The one thing the hub was still contributing.

    A delegated worker writes DID/FOUND/MISSING for the Main agent to turn into
    the user's answer. There is no Main agent on a tagged turn, so without this
    paragraph the user reads the report form itself.
    """
    chat = FakeChatModel([Round(content="ok")])
    await drive(make_request("*file what does the lease say"), chat)
    system = chat.seen_messages[0][0]["content"] or ""
    assert "THE USER TAGGED YOU DIRECTLY" in system
    assert "File agent" in system
    assert "not a DID/FOUND/MISSING report" in system
    # …and the delegation frame is NOT also present: two contracts in one turn
    # is how a model ends up writing half of each.
    assert not any(
        "Arcelle orchestration frame" in (m.get("content") or "")
        for m in chat.seen_messages[0]
    )


async def test_an_untagged_worker_still_gets_the_REPORT_contract() -> None:
    """The other side of the control: a DELEGATED specialist must keep writing
    a report, because there its reader really is the Main agent."""
    chat = FakeChatModel(
        [
            Round(
                calls=[
                    ToolCall(
                        name="ask_file_agent",
                        arguments={"instruction": "read the lease"},
                        id="c1",
                    )
                ]
            ),
            Round(content="FOUND: 60 days"),
            Round(content="the lease needs 60 days"),
        ]
    )
    await drive(make_request("what does the lease say"), chat)
    worker_thread = chat.seen_messages[1]
    assert any(
        "Arcelle orchestration frame" in (m.get("content") or "") for m in worker_thread
    )
    assert "THE USER TAGGED YOU DIRECTLY" not in (worker_thread[0]["content"] or "")


# --------------------------------------------------------------------------- #
# honest failure: a tag this room cannot serve
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("question", "tag", "web"),
    [
        ("*web what is the weather", "web", False),
        ("*browse open the site", "browse", False),
        ("*banana do the thing", "banana", True),
    ],
)
async def test_an_unservable_tag_is_refused_BY_NAME_and_runs_nothing(
    question: str, tag: str, web: bool
) -> None:
    """The fabrication this feature is fenced against.

    "Ask the Web agent what the weather is" in a web-off room was once answered
    out of the user's own documents under a File agent label, because the
    unreachable-domain path fell through to the DEFAULT worker. All three
    flavours of unservable — a room setting off, a tier that serves no such box,
    a name no agent answers to — now end the turn before any model runs.
    """
    chat = FakeChatModel([Round(content="I looked in your files and it is sunny")])
    out = await drive(make_request(question, web_enabled=web), chat)
    assert chat.offered_names == [], "no model round may run at all"
    assert f"*{tag} isn't a specialist this room has" in out.final
    assert _last_plan(out) == [], "nothing ran, so nothing may be drawn as having run"
    # The user is told it was NOT quietly handed to somebody else.
    assert "have not sent this to a different specialist" in out.final


async def test_a_refused_tag_names_the_specialists_the_room_DOES_have() -> None:
    """"No such specialist" alone leaves the user guessing at a vocabulary the
    app already knows. The composer's toast lists them; so does this — in the
    same sentence, so a user cannot tell which layer caught it."""
    chat = FakeChatModel([Round(content="ok")])
    out = await drive(make_request("*banana do the thing", web_enabled=True), chat)
    assert "Try: " in out.final
    assert "*file" in out.final
    assert "*web" in out.final


async def test_the_refusal_is_the_HOSTS_OWN_SENTENCE() -> None:
    """ONE sentence for a refused tag, on both sides of the wire.

    `composer.specialistErrorMessage` refuses the same message before it is ever
    sent; this side refuses the ones that arrive anyway (a headless
    ``agent_run``, a composer whose roster never loaded, a room whose web switch
    changed between the menu and the send). Read against the host's own source
    rather than a copy of it, because a copy is exactly what drifts — and a user
    must not be able to tell which layer caught their typo.
    """
    host = (
        Path(__file__).resolve().parents[3]
        / "apps" / "desktop" / "src" / "renderer" / "workspace" / "composer.ts"
    ).read_text()
    assert "`*${name} isn't a specialist this room has. ${" in host, host[:0]
    assert '`Try: ${names}`' in host
    assert '"This room has no specialists right now."' in host

    chat = FakeChatModel([Round(content="ok")])
    out = await drive(make_request("*banana do the thing", web_enabled=True), chat)
    assert out.final.startswith("*banana isn't a specialist this room has. Try: *")


async def test_a_refused_tag_in_a_room_with_NO_specialists_still_reads_as_prose() -> None:
    """The degenerate tier. "Try: " with nothing after it is not a sentence, and
    a room whose bridge serves nothing is the one place that can happen."""
    chat = FakeChatModel([Round(content="ok")])
    out = await drive(
        make_request("*file read it"), chat, FakeMCP(specs([]))
    )
    assert "This room has no specialists right now." in out.final
    assert "Try:" not in out.final
    assert chat.offered_names == [], "no model round may run at all"


async def test_a_refused_tag_says_why_in_the_step_chip_too() -> None:
    """This app writes no log of its own, so the diagnosis has to travel with
    the turn. A red chip cannot be mistaken for the model's opinion."""
    chat = FakeChatModel([Round(content="ok")])
    out = await drive(make_request("*banana do the thing", web_enabled=True), chat)
    steps = [e for e in out.events if e.get("t") == "step"]
    assert any("No *banana specialist" in str(e.get("v")) for e in steps), steps
    assert any(
        e.get("t") == "step_status" and e.get("ok") is False for e in out.events
    )


async def test_a_model_spelling_of_a_domain_is_NOT_a_tag_here_either() -> None:
    """`composer.ts` cannot lex "*ask_web_agent", so it travels as prose. If
    this side read it as a tag the turn would be routed to a specialist the
    composer never showed the user picking."""
    chat = FakeChatModel([Round(content="ok")])
    await drive(make_request("*ask_web_agent find X", web_enabled=True), chat)
    offered = chat.offered_names[0]
    assert "ask_file_agent" in offered
    assert BATCH_TOOL_NAME in offered, "an untagged turn keeps its whole catalog"
    system = chat.seen_messages[0][0]["content"] or ""
    assert "TAGGED" not in system


async def test_the_hub_still_refuses_a_phantom_specialist_of_its_own() -> None:
    """`_unavailable_note`'s guard is untouched by direct routing.

    It covers a different case — the hub itself naming a domain this room
    cannot serve — and it is the one that must keep falling nowhere. Web off,
    so an ``ask_web_agent`` call is a domain the hub was never offered.
    """
    chat = FakeChatModel(
        [
            Round(
                calls=[
                    ToolCall(
                        name="ask_web_agent",
                        arguments={"instruction": "what is the weather"},
                        id="c1",
                    )
                ]
            ),
            Round(content="ok"),
        ]
    )
    out = await drive(make_request("what is the weather", web_enabled=False), chat)
    results = [
        str(m.get("content") or "")
        for m in chat.seen_messages[-1]
        if m.get("role") == "tool"
    ]
    assert any("no 'web' specialist" in r for r in results), results
    assert all(
        e["status"] == "failed"
        for e in _last_plan(out)
        if e["agent"].startswith("chat.web")
    )
