"""Focused unit coverage for request-boundary policy defaults."""

from __future__ import annotations

from arcelle_sidecar.config import (
    AGENT_ROUND_BACKSTOP,
    NO_PROGRESS_ROUNDS,
    TURN_ROUND_BACKSTOP,
    McpConfig,
    ProviderConfig,
    Routing,
    RunRequest,
)


def test_nonpositive_turn_stall_limit_disables_the_progress_gate() -> None:
    request = RunRequest(model="m", question="q", turn_max_stalls=0)
    assert request.resolved_turn_stalls() is None


def test_run_request_resolvers_honor_host_boundaries_and_defaults() -> None:
    default = RunRequest(model="m", question="edit this note")
    assert default.resolved_routing()[0] is True
    assert default.resolved_write() is True
    assert default.resolved_max_rounds() == AGENT_ROUND_BACKSTOP
    assert default.resolved_turn_rounds() == TURN_ROUND_BACKSTOP
    assert default.resolved_turn_stalls() == NO_PROGRESS_ROUNDS

    hosted = RunRequest(
        model="m",
        question="ordinary question",
        routing=Routing(write=False, ui=True, jobs=False, skills=True, connectors=False),
        max_rounds=7,
        turn_max_rounds=3,
        turn_max_stalls=2,
    )
    assert hosted.resolved_routing() == (False, True, False, True, False)
    assert hosted.resolved_write() is False
    assert hosted.resolved_max_rounds() == 7
    assert hosted.resolved_turn_rounds() == 3
    assert hosted.resolved_turn_stalls() == 2


def test_run_request_capability_and_policy_guards() -> None:
    provider = ProviderConfig(
        id="provider", api_key="secret", base_url="https://example.test", model="text", supports_vision=False
    )
    assert not RunRequest(model="antigravity-cli::model", question="look", supports_vision=True).image_input_available()
    assert not RunRequest(model="provider::text", question="look", provider=provider).image_input_available()
    assert RunRequest(model="local", question="look", supports_vision=True).image_input_available()

    assert RunRequest(model="m", question="q", tool_policy="none").resolved_tool_policy() == "none"
    assert RunRequest(model="m", question="Please don't use any tools.").resolved_tool_policy() == "none"
    assert RunRequest(model="m", question="q").resolved_tool_policy() == "auto"
    assert RunRequest(model="m:cloud", question="q", privacy={"active": True}).cloud_privacy_restricted()
    assert RunRequest(model="m", question="q", privacy={"active": True, "relayed": True}).cloud_privacy_restricted()


def test_deep_write_and_nonpositive_round_limits_are_fail_closed() -> None:
    request = RunRequest(
        model="m",
        question="edit the note",
        routing=Routing(write=True),
        run_id="run-1",
        mcp=McpConfig(
            url="http://127.0.0.1:1/mcp",
            token="token",
            workspace_write=True,
            baseline_run_id="run-1",
        ),
        max_rounds=0,
        turn_max_rounds=-1,
    )
    assert request.deep_workspace_write_authorized()
    assert request.resolved_max_rounds() == AGENT_ROUND_BACKSTOP
    assert request.resolved_turn_rounds() is None
