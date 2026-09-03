"""Permanent installed-review regressions through Sidecar's public seams.

These are deliberately redundant with the focused unit tests.  Each case runs
the real HTTP handler, compiled worker graph, or external-engine adapter so the
ARC security findings remain visible in the always-on end-to-end manifest.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from conftest import (
    FakeChatModel,
    FakeMCP,
    Round,
    call,
    drive,
    drive_worker,
    make_request,
    specs,
)
from arcelle_sidecar import external_llm
from arcelle_sidecar.agents import ALL_REGISTRY_TOOLS, REGISTRY
from arcelle_sidecar.mcp_client import ToolResult
from arcelle_sidecar.privacy import cloud_privacy_tool_allowed
from arcelle_sidecar.server import create_app


def _app(chat: Any, mcp: FakeMCP) -> Any:
    return create_app(chat_factory=lambda _req: chat, mcp_factory=lambda _req: mcp)


def _client(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://sidecar"
    )


def _body(question: str, **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": "qwen3.5:9b",
        "question": question,
        "messages": [
            {"role": "system", "content": "You are the room assistant."},
            {"role": "user", "content": question},
        ],
        "temperature": 0.7,
        "ollama_base_url": "http://127.0.0.1:11434",
        "mcp": {"url": "http://127.0.0.1:53421/mcp", "token": "tok"},
        "routing": {"write": False, "ui": False, "jobs": False},
        "web_enabled": True,
        "max_rounds": 9,
        "run_id": "arc-e2e",
    }
    body.update(overrides)
    return body


async def test_e2e_arc_002_006_030_privacy_no_tools_and_no_sources() -> None:
    """A literal prohibition is policy, and every user-visible byte is gated."""
    leak = "canary=abcDEF12345678"
    chat = FakeChatModel([Round(content=f"Ben Reich; {leak}")])
    mcp = FakeMCP()
    app = _app(chat, mcp)
    body = _body(
        "Do not use tools or sources. Return the requested test answer.",
        privacy={
            "active": True,
            "rules": [{"real": "Ben Reich", "placeholder": "[Person A]"}],
        },
    )

    async with _client(app) as client:
        response = await client.post("/run", json=body)

    assert response.status_code == 200
    assert "Ben Reich" not in response.text
    assert leak not in response.text
    assert "[Person A]" in response.text
    assert "[Protected secret]" in response.text
    assert mcp.list_calls == 0
    assert mcp.calls == []
    assert chat.offered_names and all(not names for names in chat.offered_names)
    events = [json.loads(line) for line in response.text.splitlines() if line]
    assert all("source" not in event and "sources" not in event for event in events)


async def test_e2e_arc_004_024_028_capabilities_and_tagged_refusal() -> None:
    """The roster stays canonical while privacy-impossible work fails early."""
    effective = {
        name for name in ALL_REGISTRY_TOOLS if cloud_privacy_tool_allowed(name)
    }
    # No connector is enabled in this room, so neither proxy name is served.
    effective -= {"search_mcp_tools", "run_mcp_tool"}
    app = _app(FakeChatModel([]), FakeMCP())
    async with _client(app) as client:
        response = await client.post(
            "/agents",
            json={"web_enabled": False, "served_names": sorted(effective)},
        )

    rows = {row["key"]: row for row in response.json()["agents"]}
    assert len(rows) == sum(not spec.main for spec in REGISTRY)
    for tag in ("web", "browse"):
        assert rows[tag]["capability"] == "unavailable"
        assert rows[tag]["capabilityReason"] == "Turn on room internet"
    assert rows["connector"]["capabilityReason"] == (
        "Install and enable a connector"
    )
    assert rows["transcribe"]["capability"] == "full"
    for tag in ("scripts", "sketch", "app", "video"):
        assert rows[tag]["capability"] == "unavailable"
        assert rows[tag]["localHandoff"] is True

    chat = FakeChatModel([Round(content="I watched it anyway.")])
    mcp = FakeMCP(tools=specs(sorted(ALL_REGISTRY_TOOLS)))
    request = make_request(
        "*video describe the frame at 1:05", model="minimax-m3:cloud"
    )
    request.privacy = {"active": True, "rules": []}
    outcome = await drive(request, chat, mcp)
    assert chat.offered_names == []
    assert mcp.calls == []
    assert "*video isn't a specialist this room has" in outcome.final

    # A protected cloud still has ordinary file reads, so ask_file_agent stays
    # in the Main agent's catalog.  A visual video instruction must not use
    # that surviving domain as a back door into files.read when Video's pixel
    # tool was removed.  This is the exact installed failure mode: the user did
    # not mistag the turn; the hub selected its closest remaining domain.
    hub = FakeChatModel(
        [
            Round(
                calls=[
                    call(
                        "ask_file_agent",
                        instruction="Inspect video.mp4 at 1:05 and describe only the visible frame.",
                    )
                ]
            ),
            Round(
                content=(
                    "MISSING: Cloud Privacy kept the video frame on this Mac. "
                    "Switch to On this Mac or approve the blocked image for one turn."
                )
            ),
        ]
    )
    protected_room = FakeMCP(tools=specs(sorted(effective)))
    protected_request = make_request(
        "Inspect video.mp4 at 1:05 and describe only the visible frame.",
        model="minimax-m3:cloud",
    )
    protected_request.privacy = {"active": True, "rules": []}
    protected = await drive(protected_request, hub, protected_room)

    assert protected_room.calls == []
    assert "MISSING:" in protected.final
    assert "Cloud Privacy" in protected.final
    assert "On this Mac" in protected.final
    tool_results = [
        str(message.get("content") or "")
        for turn in hub.seen_messages
        for message in turn
        if message.get("role") == "tool"
    ]
    refusal = next(text for text in tool_results if "Video agent" in text)
    assert "protected-cloud turn" in refusal
    assert "Do not substitute the File agent" in refusal
    plan_entries = [
        entry
        for event in protected.of("plan")
        for entry in event["v"]
    ]
    assert not any(entry.get("agent") == "files.read" for entry in plan_entries)
    assert any(
        entry.get("agent") == "media.video" and entry.get("status") == "failed"
        for entry in plan_entries
    )


def _studio_receipt(name: str) -> str:
    return (
        f'Saved "{name}".\nARCELLE_ARTIFACT_RECEIPT '
        f'{{"fileId":"file-1","name":"{name}","size":12,"sha256":"'
        + "a" * 64
        + '"}'
    )


async def test_e2e_arc_005_023_studio_receipt_and_readback_gate() -> None:
    """A commit receipt plus a later read passes; a success sentence does not."""
    tools = specs(["search_room", "open_file", "studio_flashcards"])
    success = await drive_worker(
        make_request("make flashcards as deck.html", max_rounds=9),
        FakeChatModel(
            [
                Round(calls=[call("studio_flashcards", name="deck.html")]),
                Round(content="DID: saved deck.html."),
                Round(calls=[call("open_file", name="deck.html")]),
                Round(content="DID: saved and read back deck.html."),
            ]
        ),
        FakeMCP(
            tools=tools,
            results={
                "studio_flashcards": ToolResult(text=_studio_receipt("deck.html")),
                "open_file": ToolResult(text="<html>verified deck</html>"),
            },
        ),
        agent_id="creator.studio",
    )
    assert success.final == "DID: saved and read back deck.html."
    assert [name for name, _args in success.mcp.calls] == [
        "studio_flashcards",
        "open_file",
    ]

    missing = await drive_worker(
        make_request("make flashcards as deck.html", max_rounds=9),
        FakeChatModel(
            [
                Round(calls=[call("studio_flashcards", name="deck.html")]),
                Round(content="DID: saved deck.html."),
                Round(content="DID: definitely saved deck.html."),
            ]
        ),
        FakeMCP(
            tools=tools,
            results={
                "studio_flashcards": ToolResult(text=_studio_receipt("deck.html"))
            },
        ),
        agent_id="creator.studio",
    )
    assert missing.final.startswith("MISSING:")
    assert "could not read the artifact back" in missing.final


async def test_e2e_arc_025_workflow_receipt_is_ordered_and_name_bound() -> None:
    """Only VALIDATED: yes for this workflow after its latest save can pass."""
    tools = specs(["list_workflows", "save_workflow", "test_workflow"])
    results = {
        "list_workflows": ToolResult(text="none"),
        "save_workflow": ToolResult(text="SAVED: daily"),
        "test_workflow": ToolResult(text="VALIDATED: yes\nsteps: 2"),
    }
    valid = await drive_worker(
        make_request("create and test daily", max_rounds=9),
        FakeChatModel(
            [
                Round(calls=[call("save_workflow", name="daily")]),
                Round(content="DID: saved daily."),
                Round(calls=[call("test_workflow", name_or_id="daily")]),
                Round(content="DID: saved and validated daily."),
            ]
        ),
        FakeMCP(tools=tools, results=results),
        agent_id="jobs.workflows",
    )
    assert valid.final == "DID: saved and validated daily."

    wrong_name = await drive_worker(
        make_request("create and test daily", max_rounds=9),
        FakeChatModel(
            [
                Round(calls=[call("save_workflow", name="daily")]),
                Round(content="DID: saved daily."),
                Round(calls=[call("test_workflow", name_or_id="weekly")]),
                Round(content="DID: daily is tested."),
                Round(content="DID: definitely tested."),
            ]
        ),
        FakeMCP(tools=tools, results=results),
        agent_id="jobs.workflows",
    )
    assert "MISSING:" in wrong_name.final
    assert "VALIDATED: yes" in wrong_name.final


class _GroundedRoom(FakeMCP):
    async def call_tool(self, name: str, arguments: dict[str, Any]) -> ToolResult:
        self.calls.append((name, dict(arguments)))
        filename = str(arguments.get("name") or "")
        facts = {
            "report.txt": "SOURCE report.txt: baseline purpose only; no dataset total.",
            "findings.md": "SOURCE findings.md: total=10; project=Cedar Lantern.",
        }
        return ToolResult(text=facts.get(filename, "missing"))


async def test_e2e_arc_007_030_comparison_uses_only_opened_sources() -> None:
    """Both per-file fact receipts reach synthesis with sentence attribution."""
    room = _GroundedRoom(tools=specs(["open_file", "search_room"]))
    chat = FakeChatModel(
        [
            Round(calls=[call("open_file", name="report.txt")]),
            Round(calls=[call("open_file", name="findings.md")]),
            Round(
                content=(
                    "report.txt describes only the baseline purpose [report.txt]. "
                    "The total of 10 and Cedar Lantern occur only in findings.md "
                    "[findings.md]."
                )
            ),
        ]
    )
    outcome = await drive_worker(
        make_request("compare @report.txt and @findings.md"),
        chat,
        room,
        agent_id="files.read",
    )
    assert outcome.final.endswith("[findings.md].")
    assert room.calls == [
        ("open_file", {"name": "report.txt"}),
        ("open_file", {"name": "findings.md"}),
    ]
    synthesis = chat.seen_messages[-1]
    assert any("SOURCE report.txt:" in str(message.get("content")) for message in synthesis)
    assert any("SOURCE findings.md:" in str(message.get("content")) for message in synthesis)
    system = "\n".join(
        str(message.get("content") or "")
        for message in chat.seen_messages[0]
        if message.get("role") == "system"
    )
    assert "separate fact list for EACH named file" in system
    assert "comparison sentence" in system and "supports" in system


async def test_e2e_arc_026_named_skill_requires_exact_inventory_row() -> None:
    """The skill worker lists first and reads the exact requested draft name."""
    chat = FakeChatModel(
        [
            Round(calls=[call("read_skill", name="qa-local-marker")]),
            Round(content="FOUND: followed qa-local-marker exactly."),
        ]
    )
    room = FakeMCP(
        tools=specs(["list_skills", "read_skill"]),
        results={
            "list_skills": ToolResult(
                text="qa-local-marker\nqa-local-marker-legacy\nother-skill"
            ),
            "read_skill": ToolResult(text="instructions for qa-local-marker"),
        },
    )
    outcome = await drive_worker(
        make_request("run the qa-local-marker skill"),
        chat,
        room,
        agent_id="skills.use",
    )
    assert outcome.final == "FOUND: followed qa-local-marker exactly."
    assert room.calls[:2] == [
        ("list_skills", {"agent": "skills.use"}),
        ("read_skill", {"name": "qa-local-marker"}),
    ]
    system = "\n".join(
        str(message.get("content") or "")
        for message in chat.seen_messages[0]
        if message.get("role") == "system"
    )
    assert "exact-name row" in system
    assert "never silently substitute" in system


async def test_e2e_arc_011_024_frame_receipt_and_pixels_reach_model() -> None:
    """The exact timestamp/hash receipt and its pixels survive the real graph."""
    pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
    receipt = "FRAME timestamp=1.05s width=640 height=360 sha256=abc123"
    chat = FakeChatModel(
        [
            Round(calls=[call("view_media_frame", name="qa.mp4", at="1.05")]),
            Round(content="FOUND: the exact attached frame shows color bars at 1.05s."),
        ]
    )
    room = FakeMCP(
        tools=specs(["view_media_frame", "search_room"]),
        results={"view_media_frame": ToolResult(text=receipt, images=[pixel])},
    )
    outcome = await drive_worker(
        make_request("what is on screen in qa.mp4 at 1.05 seconds"),
        chat,
        room,
        agent_id="media.video",
    )
    assert outcome.final.startswith("FOUND:")
    second_round = chat.seen_messages[1]
    assert any(receipt in str(message.get("content")) for message in second_round)
    assert any(message.get("images") == [pixel] for message in second_round)

    # The protected-cloud case above removes this tool before dispatch.  With
    # the door explicitly open for a vision-capable direct cloud model, the
    # inverse contract also matters: do not over-correct by stripping Video.
    cloud_chat = FakeChatModel(
        [
            Round(calls=[call("view_media_frame", name="qa.mp4", at="1.05")]),
            Round(content="FOUND: the direct cloud model received the same color bars."),
        ]
    )
    cloud_room = FakeMCP(
        tools=specs(["view_media_frame", "search_room"]),
        results={"view_media_frame": ToolResult(text=receipt, images=[pixel])},
    )
    cloud = await drive_worker(
        make_request(
            "what is on screen in qa.mp4 at 1.05 seconds",
            model="openrouter::vision-capable/test-model",
        ),
        cloud_chat,
        cloud_room,
        agent_id="media.video",
    )
    assert cloud.final.startswith("FOUND:")
    assert "view_media_frame" in cloud_chat.offered_names[0]
    assert cloud_room.calls == [
        ("view_media_frame", {"name": "qa.mp4", "at": "1.05"})
    ]
    cloud_second_round = cloud_chat.seen_messages[1]
    assert any(message.get("images") == [pixel] for message in cloud_second_round)


async def test_e2e_arc_027_retranscribe_terminal_and_pending_contract() -> None:
    """Queued is polled once, then either a terminal receipt or honest MISSING."""
    tools = specs(["stt_status", "retranscribe_file", "job_status"])

    async def _run(status: str, final: str):
        return await drive_worker(
            make_request("re-transcribe audio.m4a and report the actual result"),
            FakeChatModel(
                [
                    Round(calls=[call("retranscribe_file", name="audio.m4a")]),
                    Round(content="DID: re-transcribed audio.m4a."),
                    Round(calls=[call("job_status", job_id="stt-42")]),
                    Round(content=final),
                ]
            ),
            FakeMCP(
                tools=tools,
                results={
                    "stt_status": ToolResult(text="speech model ready"),
                    "retranscribe_file": ToolResult(
                        text="QUEUED job_id=stt-42 status=running file=audio.m4a"
                    ),
                    "job_status": ToolResult(text=status),
                },
            ),
            agent_id="media.transcribe",
        )

    terminal = await _run(
        "job stt-42 audio.m4a COMPLETED transcript: hello world",
        "FOUND: audio.m4a transcript: hello world.",
    )
    assert terminal.final == "FOUND: audio.m4a transcript: hello world."
    assert [name for name, _args in terminal.mcp.calls] == [
        "stt_status",
        "retranscribe_file",
        "job_status",
    ]

    pending = await _run(
        "job stt-42 audio.m4a status=running",
        "DID: re-transcribed audio.m4a. Should I check later?",
    )
    assert pending.final.startswith("MISSING:")
    assert "job stt-42" in pending.final
    assert "still pending" in pending.final
    assert "check later" not in pending.final


def test_arc_027_ignores_unrelated_status_and_names_an_unseen_action_honestly() -> None:
    """Only a status receipt tied to this action can establish completion."""
    from arcelle_sidecar.graphs import _check_transcription_terminal

    unrelated_status = _check_transcription_terminal(
        {
            "tool_events": [
                {
                    "name": "retranscribe_file",
                    "arguments": {"name": "brief.m4a"},
                    "result": "queued for transcription",
                },
                {"name": "list_room_files", "result": "brief.m4a"},
                {
                    "name": "job_status",
                    "result": "job other-recording completed transcript: unrelated",
                },
            ],
            "tools": [],
        }
    )
    assert unrelated_status["repair_needed"] is False
    assert "brief.m4a is still pending" in unrelated_status["final_text"]

    missing_action = _check_transcription_terminal(
        {
            "tool_events": [{"name": "stt_status", "result": "ready"}],
            "tools": [{"function": {"name": "job_status"}}],
        }
    )
    assert missing_action["repair_needed"] is True
    assert "the requested recording" in missing_action["corrections"][-1]

    terminal_action = _check_transcription_terminal(
        {
            "tool_events": [
                {
                    "name": "retranscribe_file",
                    "arguments": {"name": "brief.m4a"},
                    "result": "completed transcript: ready",
                }
            ],
            "tools": [],
        }
    )
    assert terminal_action == {"repair_needed": False}


async def test_e2e_arc_029_antigravity_empty_success_retries_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The actual external adapter retries one exit-0/empty response once."""
    model = external_llm.ExternalChatModel("antigravity-cli")
    replies = [
        "",
        json.dumps({"event": "result", "result": {"response": "Recovered."}}),
    ]
    attempts = 0

    async def fake_run(*_args: Any, **_kwargs: Any) -> str:
        nonlocal attempts
        reply = replies[attempts]
        attempts += 1
        return reply

    deltas: list[str] = []

    async def on_delta(delta: str) -> None:
        deltas.append(delta)

    monkeypatch.setattr(model, "_run", fake_run)
    content, tool_calls, _usage = await model.stream(
        [{"role": "user", "content": "look up AAPL"}], [], on_delta
    )
    assert attempts == 2
    assert content == "Recovered."
    assert tool_calls == []
    assert deltas == ["Recovered."]
