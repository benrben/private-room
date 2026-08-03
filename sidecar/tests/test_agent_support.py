"""The agent half of the published provider x agent matrix (owner decision #3).

The matrix must be DERIVED. A hand-written table of "which engine gets which
agent" is wrong the first time anyone adds an agent, moves a tool between
tiers, or changes an engine's declaration — and it is published to the user, so
being wrong is the anti-fabrication failure, not a documentation nit.

These tests pin the derivation itself: the roster comes off ``REGISTRY``, and
membership comes off the SAME ``worker_reachable`` predicate a live turn uses.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from arcelle_sidecar import agents
from arcelle_sidecar.agents import REGISTRY, agent_roster, reachable_agent_ids
from arcelle_sidecar.server import create_app


def _all_tool_names() -> set[str]:
    """Every built-in tool any worker box declares, plus the core set — a stand-in
    for the most generous tier a host could send."""
    names = set(agents.CORE_TOOLS)
    for spec in REGISTRY:
        names |= set(spec.tools)
    return names


def test_the_roster_is_the_registry_not_a_written_down_list() -> None:
    """Every worker that exists is a row, and nothing else is.

    Derived from ``REGISTRY`` itself, so a new agent joins the published matrix
    the moment it is defined. The Main agent is excluded because it runs no
    tools — a column of unbroken yeses for it would say nothing.
    """
    rows = agent_roster()
    assert [r["id"] for r in rows] == [s.id for s in REGISTRY if not s.main]
    assert all(r["label"] == agents.get_agent(r["id"]).label for r in rows)
    # The one agent deliberately absent is the hub itself.
    assert agents.MAIN_AGENT_ID not in {r["id"] for r in rows}


def test_a_tier_that_serves_nothing_reaches_nobody() -> None:
    """Empty must read as empty.

    The failure mode this forbids is a matrix that prints its full roster for
    every column because the derivation quietly fell back to "all agents" when
    it had no tool list to work from.
    """
    assert reachable_agent_ids(set(), web_enabled=True) == []


def test_the_most_generous_tier_reaches_the_whole_roster() -> None:
    """...and the opposite end is not clamped either: hand it every tool and
    every worker becomes reachable, so a missing agent in a real column means a
    real missing tool rather than a bug in this derivation."""
    everything = reachable_agent_ids(_all_tool_names(), web_enabled=True)
    assert set(everything) == {s.id for s in REGISTRY if not s.main}


def test_the_web_setting_removes_the_internet_workers() -> None:
    """Web access is a ROOM SETTING, and the matrix has to honour it the same
    way a turn does — offering a Web agent a web-disabled room cannot dispatch
    to is exactly the confident non-answer ``worker_reachable`` exists to kill."""
    offline = set(reachable_agent_ids(_all_tool_names(), web_enabled=False))
    assert not (offline & agents.WEB_DEPENDENT_AGENT_IDS)
    online = set(reachable_agent_ids(_all_tool_names(), web_enabled=True))
    assert agents.WEB_DEPENDENT_AGENT_IDS <= online


def test_a_box_missing_its_load_bearing_tools_is_not_offered() -> None:
    """The cloud-CLI trap, re-pinned at the matrix.

    ``app.ui``'s box is four tools, one of which (``view_media_frame``) is room
    CONTENT and IS served to a cloud tier while the three SCREEN tools may not
    be. An any-one-of-them test passes on that single unrelated tool, which is
    how a Claude/Codex room used to be shown an App agent that could not see or
    click anything. ``AgentSpec.requires`` is what closes it, and the matrix
    must inherit that rather than re-deciding.
    """
    ui = agents.get_agent("app.ui")
    assert ui.requires, "app.ui must declare its load-bearing tools"
    partial = set(agents.CORE_TOOLS) | (set(ui.tools) - set(ui.requires))
    assert "app.ui" not in reachable_agent_ids(partial, web_enabled=True)
    # With the load-bearing tools present it IS offered.
    assert "app.ui" in reachable_agent_ids(
        partial | set(ui.requires), web_enabled=True
    )


@pytest.mark.anyio
async def test_agent_support_answers_per_tier_and_never_invents_one() -> None:
    """The route the host calls: one request carrying every distinct tier, one
    answer keyed by the same tier names — so the host never has to guess which
    column it is looking at, and a tier it did not ask about cannot appear."""
    app = create_app(chat_factory=lambda req: None, mcp_factory=lambda req: None)
    body: dict[str, Any] = {
        "web_enabled": True,
        "tiers": {
            "local-engine": sorted(_all_tool_names()),
            "cloud-engine": sorted(agents.CORE_TOOLS),
            "nothing-at-all": [],
        },
    }
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://sidecar"
    ) as client:
        resp = await client.post("/agent_support", json=body)
    assert resp.status_code == 200
    data = resp.json()
    assert set(data["tiers"]) == {"local-engine", "cloud-engine", "nothing-at-all"}
    assert data["tiers"]["nothing-at-all"] == []
    # Core-only still reaches the CORE-only worker (the File agent) and nothing
    # that needs a box of its own.
    assert agents.DEFAULT_AGENT_ID in data["tiers"]["cloud-engine"]
    assert set(data["tiers"]["local-engine"]) == {
        s.id for s in REGISTRY if not s.main
    }
    # Every id answered is a row in the roster — no orphan columns.
    roster = {r["id"] for r in data["agents"]}
    for ids in data["tiers"].values():
        assert set(ids) <= roster
