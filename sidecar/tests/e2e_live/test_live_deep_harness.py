"""Live acceptance for the local Arcelle Deep Harness.

This is deliberately opt-in. It exercises the real Deep Agents runtime, the
real selected Ollama model, and a loopback-only workspace MCP bridge. It never
uses a cloud provider, browser tool, shell backend, or external network socket.

    ARCELLE_E2E=1 ARCELLE_E2E_MODEL=qwen3.5:4b \
        uv run pytest tests/e2e_live/test_live_deep_harness.py -q
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import socket
from typing import Any
from urllib.parse import urlparse

import httpx
import pytest

from arcelle_sidecar.chat import OllamaChatModel

from .harness import E2E_MODEL, OLLAMA, RecordingBridge, skip_unless_live, tool_spec

skip_unless_live()

# A pronounceable sentinel avoids turning this harness/tool test into a tiny
# model's random-string copying benchmark. The old `orchid-7ZQ9` was read via
# the tool correctly but qwen3.5:4b once omitted only its final digit.
FIXTURE_VALUE = "ORCHID-SEVEN"

WORKSPACE_TOOLS = [
    # The installed LocalEngine catalog exposes Arcelle's compatibility file
    # surface as well as the exact workspace surface. Small models use the
    # deterministic File agent, whose narrow tool box intentionally speaks
    # these stable compatibility verbs; larger models can use workspace_*.
    tool_spec("list_room_files", "List files in the room."),
    tool_spec("search_room", "Search room file contents.", query={"type": "string"}),
    tool_spec("open_file", "Read a room file.", name={"type": "string"}),
    tool_spec("workspace_list", "List files under a workspace path.", path={"type": "string"}),
    tool_spec(
        "workspace_read",
        "Read a UTF-8 workspace file.",
        path={"type": "string"},
        offset={"type": "integer"},
        limit={"type": "integer"},
    ),
    tool_spec(
        "workspace_glob",
        "Find workspace paths by pattern.",
        path={"type": "string"},
        pattern={"type": "string"},
    ),
    tool_spec(
        "workspace_grep",
        "Search workspace text.",
        path={"type": "string"},
        pattern={"type": "string"},
    ),
]


def workspace_reply(name: str, args: dict[str, Any]) -> str:
    """Small read-only fixture in the Workspace Service wire shape."""
    if name == "list_room_files":
        return "/fixture.md"
    if name == "search_room":
        return f"/fixture.md: The private fixture codename is {FIXTURE_VALUE}."
    if name == "open_file" and args.get("name") in {"/fixture.md", "fixture.md"}:
        return f"The private fixture codename is {FIXTURE_VALUE}."
    if name == "workspace_list":
        return json.dumps(
            {
                "entries": [
                    {
                        "path": "/fixture.md",
                        "is_dir": False,
                        "size": len(FIXTURE_VALUE),
                    }
                ]
            }
        )
    if name == "workspace_read" and args.get("path") == "/fixture.md":
        content = f"The private fixture codename is {FIXTURE_VALUE}."
        return json.dumps(
            {
                "file_data": {
                    "content": content,
                    "encoding": "utf-8",
                    "created_at": "",
                    "modified_at": "",
                },
                "total_lines": 1,
                "start_line": 1,
                "end_line": 1,
            }
        )
    if name == "workspace_glob":
        return json.dumps({"matches": ["/fixture.md"], "truncated": False})
    if name == "workspace_grep":
        return json.dumps(
            {
                "matches": [
                    {
                        "path": "/fixture.md",
                        "line": 1,
                        "text": f"The private fixture codename is {FIXTURE_VALUE}.",
                    }
                ],
                "truncated": False,
            }
        )
    return json.dumps({"error": "unsupported fixture operation"})


def _deep_body(bridge: RecordingBridge, *, run_id: str, question: str) -> dict[str, Any]:
    return {
        "model": E2E_MODEL,
        "question": question,
        "messages": [{"role": "user", "content": question}],
        "temperature": 0,
        "ollama_base_url": OLLAMA,
        "mcp": {"url": bridge.url, "token": "e2e"},
        "routing": {
            "write": False,
            "ui": False,
            "jobs": False,
            "skills": False,
            "connectors": False,
        },
        "web_enabled": False,
        "harness": "deep",
        "run_id": run_id,
        "max_rounds": 4,
    }


@pytest.fixture
def loopback_only(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Fail the test if this local run attempts any non-loopback socket."""
    attempted: list[str] = []
    real_connect = socket.socket.connect

    def guarded_connect(sock: socket.socket, address: Any) -> Any:
        host = address[0] if isinstance(address, tuple) and address else ""
        try:
            local = ipaddress.ip_address(str(host)).is_loopback
        except ValueError:
            local = str(host).casefold() == "localhost"
        if not local:
            attempted.append(str(host))
            raise AssertionError(f"Deep Harness attempted external network access: {host}")
        return real_connect(sock, address)

    monkeypatch.setattr(socket.socket, "connect", guarded_connect)
    return attempted


async def test_local_deep_harness_reads_workspace_finishes_once_and_cancels(
    monkeypatch: pytest.MonkeyPatch,
    loopback_only: list[str],
) -> None:
    """One live gate for model locality, tool isolation, MCP, final, and Stop."""
    from arcelle_sidecar.server import create_app

    selected_models: list[tuple[str, str]] = []
    offered_tools: list[set[str]] = []
    real_stream = OllamaChatModel.stream

    async def observed_stream(
        self: OllamaChatModel,
        messages: list[Any],
        tools: list[dict[str, Any]],
        on_delta: Any,
        cancel: Any = None,
    ) -> Any:
        selected_models.append((self.model, self.base_url))
        offered_tools.append(
            {
                str(tool.get("function", {}).get("name", ""))
                for tool in tools
                if isinstance(tool, dict)
            }
        )
        return await real_stream(self, messages, tools, on_delta, cancel)

    monkeypatch.setattr(OllamaChatModel, "stream", observed_stream)
    bridge = RecordingBridge(tools=WORKSPACE_TOOLS, reply=workspace_reply)
    app = create_app()
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://sidecar",
            timeout=420.0,
        ) as client:
            response = await client.post(
                "/run",
                json=_deep_body(
                    bridge,
                    run_id="e2e-local-deep-read",
                    question=(
                        "Use the filesystem read tool to read /fixture.md. "
                        "Report the codename found in that file. Do not guess."
                    ),
                ),
            )
            assert response.status_code == 200
            events = [json.loads(line) for line in response.text.splitlines() if line]
            finals = [event["v"] for event in events if event.get("t") == "final"]

            assert len(finals) == 1, f"expected one final result, got: {events}"
            assert FIXTURE_VALUE.casefold() in finals[0].casefold()
            assert any(
                (
                    name == "workspace_read"
                    and args.get("path") == "/fixture.md"
                )
                or (
                    name == "open_file"
                    and args.get("name") in {"/fixture.md", "fixture.md"}
                )
                for name, args in bridge.calls
            )

            cancel_id = "e2e-local-deep-cancel"

            async def start_slow_run() -> httpx.Response:
                return await client.post(
                    "/run",
                    json=_deep_body(
                        bridge,
                        run_id=cancel_id,
                        question=(
                            "Read /fixture.md, then write a very long character-by-character "
                            "explanation of its codename."
                        ),
                    ),
                )

            running = asyncio.create_task(start_slow_run())
            await asyncio.sleep(0.25)
            stopped = await client.post("/cancel", json={"run_id": cancel_id})
            assert stopped.status_code == 200
            assert stopped.json()["known"] is True
            await asyncio.wait_for(running, timeout=30.0)
    finally:
        bridge.close()

    assert selected_models
    assert all(model == E2E_MODEL for model, _base in selected_models)
    assert all(urlparse(base).hostname in {"127.0.0.1", "localhost", "::1"} for _, base in selected_models)

    forbidden = {
        "execute",
        "shell",
        "web_search",
        "browser",
        "search_mcp_tools",
        "run_mcp_tool",
    }
    assert offered_tools and all(not (names & forbidden) for names in offered_tools)
    assert all(
        name.startswith("workspace_")
        or name in {"list_room_files", "search_room", "open_file"}
        for name, _args in bridge.calls
    )
    assert loopback_only == []
