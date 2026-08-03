"""The composer's ``*`` tag: the user names the specialist a turn goes to.

Owner feature, 2026-08-03 — "the user can ask the specialist agent to run by
tag then using special symbol (like *) and dropdown with all the agents will
appear". The dropdown half is drawn by the host; both halves are DERIVED from
this module's :func:`reachable_domain_keys`, and these tests pin that they
cannot come apart:

* the menu (:func:`specialist_roster`) may only offer what the catalog holds,
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

import pytest

from conftest import FakeChatModel, Round, drive, make_request
from arcelle_sidecar.messages import ToolCall
from arcelle_sidecar.agents import (
    ALL_REGISTRY_TOOLS,
    BATCH_TOOL_NAME,
    CORE_TOOLS,
    DOMAIN_KEYS,
    agent_tool_specs,
    reachable_domain_keys,
    specialist_roster,
    tagged_specialist,
)

_CORE_ONLY = set(CORE_TOOLS)
_EVERYTHING = set(ALL_REGISTRY_TOOLS)

MATRIX = [
    pytest.param(served, web, id=f"{tier}-web{int(web)}")
    for tier, served in (("core_only", _CORE_ONLY), ("everything", _EVERYTHING))
    for web in (True, False)
]


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
# --------------------------------------------------------------------------- #


def test_a_tagged_turn_can_reach_only_that_specialist() -> None:
    """THE routing guarantee. Not "the model is asked nicely" — there is no
    other ask_*_agent tool in the catalog to call."""
    served = _EVERYTHING
    full = _names(agent_tool_specs(web_enabled=True, served_names=served))
    assert len(full) > 2, full
    narrowed = _names(
        agent_tool_specs(web_enabled=True, served_names=served, only="web")
    )
    assert narrowed == ["ask_web_agent"]


def test_a_tagged_turn_gets_no_batch_tool() -> None:
    """A fan-out enum of one is a call the model can only get wrong."""
    narrowed = _names(
        agent_tool_specs(web_enabled=True, served_names=_EVERYTHING, only="file")
    )
    assert BATCH_TOOL_NAME not in narrowed


@pytest.mark.parametrize(("served", "web"), MATRIX)
def test_every_tag_the_menu_offers_narrows_to_a_real_tool(
    served: set[str], web: bool
) -> None:
    """Menu and catalog, checked against each other at every tier."""
    for entry in specialist_roster(web_enabled=web, served_names=served):
        narrowed = _names(
            agent_tool_specs(web_enabled=web, served_names=served, only=entry["key"])
        )
        assert narrowed == [entry["tool"]], (entry, narrowed)


def test_a_tag_can_never_widen_the_catalog() -> None:
    """The web is OFF: tagging the web specialist must not conjure it."""
    served = _EVERYTHING
    off = _names(agent_tool_specs(web_enabled=False, served_names=served))
    assert "ask_web_agent" not in off
    tagged = _names(
        agent_tool_specs(web_enabled=False, served_names=served, only="web")
    )
    assert tagged == off


@pytest.mark.parametrize("only", ["web", "banana"])
def test_an_unreachable_tag_leaves_the_hub_its_real_specialists(only: str) -> None:
    """Narrowing to a domain with no tool would empty the catalog, and an empty
    catalog says "this room is unreachable" — which is not what happened.

    Both flavours of "no such specialist" take this path: the web specialist in
    a web-off room, and a name that is not a specialist anywhere. A tag reaches
    `agent_tool_specs` as typed, so a typo must be as harmless to the catalog as
    an unavailable domain is.
    """
    full = _names(agent_tool_specs(web_enabled=False, served_names=_EVERYTHING))
    tagged = _names(
        agent_tool_specs(web_enabled=False, served_names=_EVERYTHING, only=only)
    )
    assert tagged == full, "a bad tag must not disarm the hub"


# --------------------------------------------------------------------------- #
# the menu
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(("served", "web"), MATRIX)
def test_the_menu_is_exactly_the_reachable_domains(
    served: set[str], web: bool
) -> None:
    keys = [e["key"] for e in specialist_roster(web_enabled=web, served_names=served)]
    assert keys == reachable_domain_keys(web_enabled=web, served_names=served)


def test_a_web_disabled_room_offers_no_web_specialist() -> None:
    """The live 2026-07-24 failure, in menu form: offering it here would let a
    user tag a turn the room then answers from its own documents."""
    keys = [
        e["key"]
        for e in specialist_roster(web_enabled=False, served_names=_EVERYTHING)
    ]
    assert "web" not in keys


@pytest.mark.parametrize(("served", "web"), MATRIX)
def test_every_menu_row_is_complete_and_names_a_real_tool(
    served: set[str], web: bool
) -> None:
    for entry in specialist_roster(web_enabled=web, served_names=served):
        assert entry["tool"] == DOMAIN_KEYS[entry["key"]]
        assert entry["label"].strip()
        assert entry["area"].strip()
        assert entry["description"].strip()


def test_the_menu_label_is_the_agents_own_label() -> None:
    """The words the agent diagram will use for the node that lights up."""
    rows = {
        e["key"]: e["label"]
        for e in specialist_roster(web_enabled=True, served_names=_EVERYTHING)
    }
    assert rows["file"] == "File agent"
    assert rows["web"] == "Web agent"


# --------------------------------------------------------------------------- #
# end to end, through the real graph
# --------------------------------------------------------------------------- #


async def test_a_tagged_question_reaches_the_hub_as_a_narrowed_catalog() -> None:
    """The whole feature, from the text the composer sends to the tools the
    Main agent is actually handed."""
    chat = FakeChatModel([Round(content="ok")])
    await drive(make_request("*web what is the weather", web_enabled=True), chat)
    assert chat.offered_names[0] == ["ask_web_agent"]


async def test_an_untagged_question_still_sees_every_specialist() -> None:
    """The control. Without this the test above would pass on a hub that had
    simply lost its catalog."""
    chat = FakeChatModel([Round(content="ok")])
    await drive(make_request("what is the weather", web_enabled=True), chat)
    offered = chat.offered_names[0]
    assert "ask_web_agent" in offered
    assert "ask_file_agent" in offered
    assert BATCH_TOOL_NAME in offered


async def test_the_hub_is_told_which_specialist_the_user_tagged() -> None:
    chat = FakeChatModel([Round(content="ok")])
    await drive(make_request("*web what is the weather", web_enabled=True), chat)
    system = chat.seen_messages[0][0]["content"] or ""
    assert "THE USER TAGGED ONE SPECIALIST" in system
    assert "Web agent" in system


async def test_tagging_a_specialist_this_room_lacks_is_refused_by_name() -> None:
    """The web is off. The hub keeps its real specialists — an empty catalog
    would tell it the room is unreachable — and is told to say so plainly
    rather than hand the request to whoever is left."""
    chat = FakeChatModel([Round(content="ok")])
    await drive(make_request("*web what is the weather", web_enabled=False), chat)
    offered = chat.offered_names[0]
    assert "ask_web_agent" not in offered
    assert "ask_file_agent" in offered
    system = chat.seen_messages[0][0]["content"] or ""
    assert "'web' SPECIALIST" in system
    assert "no such specialist" in system


async def test_tagging_a_name_no_specialist_answers_to_is_refused_THE_SAME_WAY() -> None:
    """The packet's disagreement, end to end.

    ``*banana`` used to be swallowed by `tagged_specialist` and the turn ran as
    an ordinary one — while the composer, given the same message, refused to
    send it at all. Two layers, one message, opposite policies. Now both refuse
    it, and this side refuses it in the words the composer's toast uses.
    """
    chat = FakeChatModel([Round(content="ok")])
    await drive(make_request("*banana do the thing", web_enabled=True), chat)
    system = chat.seen_messages[0][0]["content"] or ""
    assert "'banana' SPECIALIST" in system
    assert "no such specialist" in system
    # …and it did NOT quietly become an ordinary turn: the hub still holds its
    # real specialists, which is what makes the refusal answerable.
    assert "ask_file_agent" in chat.offered_names[0]


async def test_a_refused_tag_names_the_specialists_the_room_DOES_have() -> None:
    """"No such specialist" alone leaves the user guessing at a vocabulary the
    app already knows. The composer's toast lists them; so does this."""
    chat = FakeChatModel([Round(content="ok")])
    await drive(make_request("*banana do the thing", web_enabled=True), chat)
    system = chat.seen_messages[0][0]["content"] or ""
    assert "*file" in system
    assert "*web" in system


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


async def test_a_tagged_turn_refuses_a_call_to_a_DIFFERENT_specialist() -> None:
    """The delegation GUARD half of the tag, not the catalog half.

    Narrowing `agent_tool_specs` means the hub is never *offered* another
    specialist — but a model that names one anyway (a hallucinated tool call, a
    harness engine echoing a name it saw earlier) used to fall through to
    `resolve_worker`'s DEFAULT worker, which is exactly how a web question got
    answered out of the user's own files. `_live_domains` narrows the guard's
    roster with the catalog so the second path refuses it too, by the same
    sentence a phantom domain gets, and no worker runs.
    """
    chat = FakeChatModel(
        [
            Round(
                calls=[
                    ToolCall(
                        name="ask_file_agent",
                        arguments={"instruction": "what is the weather"},
                        id="c1",
                    )
                ]
            ),
            Round(content="ok"),
        ]
    )
    out = await drive(make_request("*web what is the weather", web_enabled=True), chat)
    # The refusal reached the model as the tool result...
    results = [
        str(m.get("content") or "")
        for m in chat.seen_messages[-1]
        if m.get("role") == "tool"
    ]
    assert results, "the delegation produced no tool result at all"
    assert any("no 'file' specialist" in r for r in results), results
    # ...and the roster it was offered instead is the narrowed one.
    assert any("available: web)" in r for r in results), results
    # ...and no File agent ever ran: the diagram shows the slot as failed.
    plans = [e for e in out.events if e.get("t") == "plan"]
    entries = plans[-1]["v"] if plans else []
    filed = [e for e in entries if e.get("agent", "").startswith("files")]
    assert all(e["status"] == "failed" for e in filed), entries
