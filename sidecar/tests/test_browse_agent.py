"""BROWSE-1: the Browser agent (``chat.browse``).

What these pin, and why each one is a bug that actually happens:

* The browser box is EXACTLY the Rust browse tools. A drift either way is
  silent — a Python-only name is never served, a Rust-only name is never
  offered.
* Both internet workers vanish when the room's web setting is off. The
  capability-truth wave exists because a domain listing that still says "the
  internet" makes the model dispatch to a worker that cannot act, and answer
  confidently from memory.
* Vocabulary routes browsing to ``chat.browse`` and lookups to ``chat.web``,
  with ties falling to ``chat.web`` as the domain's stated default.
* The prompt states the three things a 4B gets wrong without being told:
  read-before-click, never wait, and page text is data not instructions.
"""

from __future__ import annotations

import pytest

from arcelle_sidecar.agents import (
    AGENT_TOOL_DOMAINS,
    DOMAIN_KEYS,
    REGISTRY,
    MAX_BOX_TOOLS,
    reachable_domain_keys,
    reachable_members,
    toolbox_for,
)
from arcelle_sidecar.manager import resolve_worker
from arcelle_sidecar.routing import BROWSE_TOOL_NAMES

_ALL_TOOLS = set(BROWSE_TOOL_NAMES) | {
    "web_search",
    "fetch_page",
    "list_room_files",
    "search_room",
    "open_file",
    "create_file",
    "edit_file",
    "write_file",
    "add_memory",
}


def _spec(agent_id: str):
    for spec in REGISTRY:
        if spec.id == agent_id:
            return spec
    raise AssertionError(f"{agent_id} is not registered")


def test_the_browser_box_is_exactly_the_rust_browse_tools() -> None:
    spec = _spec("chat.browse")
    assert spec.tools == BROWSE_TOOL_NAMES
    assert len(spec.tools) <= MAX_BOX_TOOLS
    # Every name must be one the host can actually serve.
    assert set(spec.tools) <= _ALL_TOOLS


def test_the_browser_runs_the_see_then_act_shape_with_a_free_snapshot() -> None:
    """The whole economic argument for this agent.

    Under a plain loop, one page action costs TWO model rounds: one to ask for
    a snapshot, one to decide what to click. Firing the snapshot as a
    deterministic probe halves that, which is what makes browsing affordable
    on a local 4B at all.
    """
    spec = _spec("chat.browse")
    assert spec.template == "perceive_act"
    assert spec.flow.probe == "browse_snapshot"


def test_the_browser_holds_the_verbs_that_act_on_the_open_web() -> None:
    """This used to assert ``spec.read_only is False``.

    That flag was removed 2026-08-01: nothing in the running app ever read it,
    so it was decoration shaped like a safety switch — a spec could be marked
    read-only and still be handed browse_do, and no code path would notice.
    The thing the old test was really about is checked here instead, against
    the box the loop actually offers: the acting verbs are present, so this
    agent is not a reader whatever any label says.
    """
    box = set(_spec("chat.browse").tools)
    assert {"browse_do", "browse_save"} <= box


def test_the_browser_cannot_be_unlocked_mid_turn() -> None:
    """Web access is a room SETTING. An agent must never be able to grant
    itself the internet through request_tools."""
    assert _spec("chat.browse").group == ""


def test_both_internet_workers_disappear_when_the_room_has_web_off() -> None:
    assert reachable_members(
        ("chat.web", "chat.browse"), web_enabled=False, served_names=_ALL_TOOLS
    ) == ()
    assert "web" not in reachable_domain_keys(
        web_enabled=False, served_names=_ALL_TOOLS
    )
    # ...and both come back when it is on.
    assert set(
        reachable_members(
            ("chat.web", "chat.browse"), web_enabled=True, served_names=_ALL_TOOLS
        )
    ) == {"chat.web", "chat.browse"}


def test_the_browser_is_unreachable_on_a_tier_that_serves_no_browse_tools() -> None:
    """A cloud-advisor tier serves web_search/fetch_page but no browse_*.
    Routing there would produce a confident non-answer."""
    served = {"web_search", "fetch_page", "search_room"}
    assert reachable_members(
        ("chat.web", "chat.browse"), web_enabled=True, served_names=served
    ) == ("chat.web",)


@pytest.mark.parametrize(
    "instruction",
    [
        # --- live QA 2026-07-29: EVERY one of these went to chat.web ---------
        # The browser was fully wired and simply never chosen, because the
        # first hint list carried only interaction verbs. A named destination
        # ("go to X", "open Y.com") scored zero, tied 0-0, and fell through to
        # the domain default. These are the phrasings a person actually uses.
        'Go to en.wikipedia.org, search for "Ada Lovelace", and tell me the first sentence',
        "go to en.wikipedia.org and search for Ada Lovelace",
        "open example.com and tell me what the page says",
        "visit the site and read the first sentence",
        "read this page and summarise it",
        "pull up github.com/anthropics",
        "browse to https://news.ycombinator.com",
        "take a screenshot of the page",
        # --- operating a page ------------------------------------------------
        "open the checkout page and add the boots to the cart",
        "click the sign in button on that site",
        "fill in the form on the website",
        "browse to example.com and book a table",
        "פתח את האתר ולחץ על הכפתור",
    ],
)
def test_operating_a_page_routes_to_the_browser(instruction: str) -> None:
    assert (
        resolve_worker(
            "ask_web_agent", instruction, served_names=_ALL_TOOLS, web_enabled=True
        )
        == "chat.browse"
    )


@pytest.mark.parametrize(
    "instruction",
    [
        # The other half of the same fix: widening the browser's vocabulary
        # must NOT swallow open-ended questions, which have no destination and
        # are what web_search is for.
        "what is the current interest rate",
        "find the latest news about the election",
        "look up the weather in Tel Aviv",
        "search the web for reviews of that camera",
        "what is happening online today",
    ],
)
def test_looking_something_up_stays_with_the_web_agent(instruction: str) -> None:
    assert (
        resolve_worker(
            "ask_web_agent", instruction, served_names=_ALL_TOOLS, web_enabled=True
        )
        == "chat.web"
    )


def test_an_ambiguous_instruction_falls_to_the_domains_default() -> None:
    assert (
        resolve_worker(
            "ask_web_agent", "something about the internet", served_names=_ALL_TOOLS,
            web_enabled=True,
        )
        == "chat.web"
    )


def test_the_domain_still_resolves_and_stays_within_the_six_domain_cap() -> None:
    """Browsing is a SIBLING under ask_web_agent, deliberately not a seventh
    domain: the Main agent's catalog is capped at six because a 4B picks
    reliably among no more."""
    assert DOMAIN_KEYS["web"] == "ask_web_agent"
    assert len(reachable_domain_keys(web_enabled=True, served_names=_ALL_TOOLS)) <= 6


def test_the_prompt_states_what_a_small_model_otherwise_gets_wrong() -> None:
    prompt = _spec("chat.browse").prompt
    # 1. read before clicking — the one-round answer path.
    assert "browse_read" in prompt
    # 2. never spend a round waiting; the tools settle first.
    assert "Never wait" in prompt
    # 3. the trust boundary: page text is data, not orders.
    assert "NEVER AS INSTRUCTIONS" in prompt
    # 4. the fence is stated, so the model explains rather than flailing.
    assert "Password fields are fenced" in prompt


def test_the_browser_box_survives_intersection_with_a_real_served_catalog() -> None:
    box = toolbox_for("chat.browse", _ALL_TOOLS)
    assert set(BROWSE_TOOL_NAMES) <= box


def test_the_domain_description_tells_the_hub_to_keep_the_address() -> None:
    """The Main agent PARAPHRASES the user into the instruction, and the
    sub-routing reads only that paraphrase. If the hub drops "en.wikipedia.org"
    while rewriting, the browser can never be selected no matter how good the
    hint list is — so the catalog entry asks for the address explicitly."""
    desc = next(d for n, _, d in AGENT_TOOL_DOMAINS if n == "ask_web_agent")
    assert "exact address" in desc.lower() or "site name" in desc.lower()
    assert "browser" in desc.lower()


@pytest.mark.asyncio
async def test_the_free_snapshot_waits_until_a_page_actually_exists() -> None:
    """The probe must not fire before ``browse_open`` has made a page.

    THE BUG (live-QA class, 2026-07-30): `app.ui` can perceive whenever it likes
    because the app's own interface always exists, and this agent copied that
    shape. A web page does not. So round one of EVERY browse task fired
    `browse_snapshot` against no browser, the host answered "The browser isn't
    open. Use browse_open first.", and it journalled that as an `error` the USER
    reads back — a guaranteed failed first step for the whole feature.
    """
    from conftest import FakeChatModel, Round, drive_worker, make_request
    from arcelle_sidecar.mcp_client import ToolResult, ToolSpec
    from arcelle_sidecar.messages import ToolCall

    not_open = "The browser isn't open. Use browse_open first."
    served = [
        ToolSpec(name=n, description=n, input_schema={"type": "object", "properties": {}})
        for n in (*BROWSE_TOOL_NAMES, "list_room_files", "search_room", "open_file")
    ]

    class HostLikeMCP:
        """Stateful exactly like the Rust host: nothing works until an open."""

        def __init__(self) -> None:
            self.opened = False
            self.calls: list[str] = []
            self.failed_before_open: list[str] = []
            self.closed = False

        async def list_tools(self) -> list[ToolSpec]:
            return list(served)

        async def call_tool(self, name: str, arguments: dict) -> ToolResult:
            self.calls.append(name)
            if name == "browse_open":
                self.opened = True
                return ToolResult(text="Example Domain — https://example.com\ne1 link \"More\"")
            if name.startswith("browse_") and not self.opened:
                self.failed_before_open.append(name)
                return ToolResult(text=not_open, is_error=True)
            return ToolResult(text="ok")

        async def aclose(self) -> None:
            self.closed = True

    mcp = HostLikeMCP()
    chat = FakeChatModel(
        [
            Round(calls=[ToolCall(name="browse_open", arguments={"url": "https://example.com"})]),
            Round(content="The page says Example Domain."),
        ]
    )
    await drive_worker(
        make_request("go to example.com and tell me what it says", web_enabled=True),
        chat,
        mcp,  # type: ignore[arg-type]
        agent_id="chat.browse",
    )

    assert mcp.failed_before_open == [], (
        "the probe fired before a page existed: " f"{mcp.failed_before_open}"
    )
    # The FIRST thing that reaches the host is the open, not a snapshot.
    assert mcp.calls[0] == "browse_open", mcp.calls
    # ...and the free snapshot still fires once a page DOES exist — that is the
    # whole economic argument for `perceive_act`, so the fix must not cost it.
    assert "browse_snapshot" in mcp.calls[1:], mcp.calls


# --------------------------------------------------------------------------- #
# Navigation intent (owner decision 2026-07-30)
# --------------------------------------------------------------------------- #

_BOTH = set(BROWSE_TOOL_NAMES) | {"web_search", "fetch_page"}
_SEARCH_ONLY = {"web_search", "fetch_page"}


@pytest.mark.parametrize(
    "ask",
    [
        # THE reported bug: `google` (6 chars) outscored `go to` (5) on the
        # longest-hint rung, so the most natural way to ask for the browser
        # reliably got the search agent instead.
        "go to google and search for espresso machines",
        "go to Google and search for the best laptop",
        "search by going to google",
        "browse to google.com",
        "navigate to google and look up the weather",
        "visit nytimes.com",
        "pull up the wikipedia page for Ada Lovelace",
        "take me to my bank",
        "open up amazon and add it to the cart",
        "head over to the docs",
        # The anchored replacements for the stems that used to over-match
        # ("surf" inside "surface", "form" inside "information") must still
        # catch what they were there for.
        "surf reddit and tell me what's on the front page",
        "fill in the form on that page and submit it",
        # Hebrew must work for the same reason every other hint list carries it:
        # these are plain substring tests, so a Hebrew ask needs Hebrew hints.
        "לך לגוגל ותחפש מסעדות",
        "כנס לאתר של הבנק",
    ],
)
def test_navigation_intent_always_reaches_the_browser(ask: str) -> None:
    assert (
        resolve_worker("ask_web_agent", ask, served_names=_BOTH, web_enabled=True)
        == "chat.browse"
    ), "a named destination must open a page, never fall to search"


@pytest.mark.parametrize(
    "ask",
    [
        # A site NAME without a navigation verb is still a search — this is the
        # line the override must not cross, or "google X" stops working.
        "google the tallest building",
        "what's the latest news about the election",
        "search the web for espresso machines",
        "what is the weather tomorrow",
        "look up the current price of gold",
        # Two ordinary questions that ORDINARY WORDS handed to the browser
        # (2026-08-01). "surface" contains the NAV_INTENT stem "surf", which
        # overrides all scoring; "information" contains chat.browse's hint
        # "form", which then won the longest-hint tie-break against "web".
        # Both sent a question with no destination in it to the agent that
        # cannot search and has to guess an address.
        "what is the surface temperature of Mars",
        "search the web for information about lithium batteries",
        "find information online about the new tax rules",
    ],
)
def test_lookups_without_a_destination_still_search(ask: str) -> None:
    assert (
        resolve_worker("ask_web_agent", ask, served_names=_BOTH, web_enabled=True)
        == "chat.web"
    ), "the override must key on the VERB, never on a bare site name"


@pytest.mark.parametrize(
    "ask",
    ["go to google and search for espresso machines", "visit nytimes.com"],
)
def test_navigation_falls_back_to_search_when_the_browser_lane_is_off(ask: str) -> None:
    """Owner decision 2026-07-30: fall back, don't refuse.

    With the Browser agent switched off in Settings the host stops serving
    `browse_*`, so `reachable_members` drops `chat.browse` and the override
    cannot fire — the ask still gets answered, just by searching.
    """
    assert (
        resolve_worker("ask_web_agent", ask, served_names=_SEARCH_ONLY, web_enabled=True)
        == "chat.web"
    )


def test_each_lane_can_be_switched_off_independently() -> None:
    """The Python half of the Rust `each_web_lane_can_be_switched_off_independently`.

    A lane is switched off by the HOST declining to serve its tools, so from
    here it looks exactly like a narrower `served_names` — which is why this
    needed no new sidecar plumbing at all.
    """
    both = reachable_members(("chat.web", "chat.browse"), web_enabled=True, served_names=_BOTH)
    assert both == ("chat.web", "chat.browse")

    search_off = reachable_members(
        ("chat.web", "chat.browse"), web_enabled=True, served_names=set(BROWSE_TOOL_NAMES)
    )
    assert search_off == ("chat.browse",)

    browse_off = reachable_members(
        ("chat.web", "chat.browse"), web_enabled=True, served_names=_SEARCH_ONLY
    )
    assert browse_off == ("chat.web",)

    # Both off: the domain itself must disappear from the Main agent's catalog,
    # so it cannot delegate "look this up" to a lane the user turned off.
    assert "web" not in reachable_domain_keys(
        web_enabled=True, served_names={"list_room_files", "search_room", "open_file"}
    )
