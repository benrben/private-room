"""Live-model e2e harness.

These tests run the REAL sidecar app (in-process ASGI) against the REAL local
Ollama model and a scripted room bridge, at production turn shapes. They are
the guard for the failure class unit tests cannot see: live QA 2026-07-23
proved twice that a phrase which passes 4/4 in small synthetic turns can fail
100% inside a production-size turn (retrieval gravity; the 4k-window
context-shift "Done." regression).

Opt-in by design — they need a running Ollama daemon and minutes of model
time:

    ARCELLE_E2E=1 uv run pytest tests/e2e_live -q

Skipped silently otherwise, so the fast suite stays fast and CI stays
network-free (SPEC §7).
"""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Callable

import httpx
import pytest

E2E_MODEL = os.environ.get("ARCELLE_E2E_MODEL", "qwen3.5:4b")
OLLAMA = os.environ.get("ARCELLE_E2E_OLLAMA", "http://127.0.0.1:11434")

#: The system prompt shape agent.rs composes (doctrine + tool teaching +
#: inventory). Kept representative, not byte-identical — the invariants under
#: test are behavioural (grounded answer, right tools, one final).
BASE_SYSTEM = (
    'You are the private AI assistant inside "Arcelle", a local encrypted workspace. '
    "Answer using the file excerpts provided as context when relevant, and mention "
    "the file names. You can control the app with your tools. Use them when the user "
    "asks you to open, show, find or create something - then answer in plain text.\n\n"
    "You can create and edit files in this room with your tools: create_file saves a "
    "new note or document, write_file overwrites an editable file, edit_file replaces "
    "text inside one, rename_file renames, annotate_file attaches a note, add_memory "
    "saves a memory. Use them whenever the user asks you to save, write, edit or "
    "remember something - do not claim you cannot."
)


def skip_unless_live() -> None:
    """Skip local-LLM end-to-end suites in every automated run.

    These modules call a real Ollama daemon and consume local model time. They
    are intentionally excluded from the repository quality loop, even when a
    developer has ``ARCELLE_E2E`` set in their shell.
    """
    pytest.skip(
        "live e2e: skipped because this suite invokes a real local LLM",
        allow_module_level=True,
    )


def tool_spec(tool: str, description: str, /, **props: dict[str, Any]) -> dict[str, Any]:
    # kwargs become schema properties; positional-only params ("/") mean a
    # property may be named anything — even "tool" or "description".
    return {
        "name": tool,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": dict(props),
            "required": list(props),
        },
    }


#: A representative production catalog subset: CORE read/write + one box each
#: for jobs and connectors, so plans can be executed for real.
CATALOG = [
    tool_spec("list_room_files", "List every file stored in this room."),
    tool_spec("search_room", "Search the room's files; returns verbatim excerpts.", query={"type": "string"}),
    tool_spec("open_file", "Open a file in the viewer.", name={"type": "string"}),
    tool_spec("create_file", "Save a NEW note/document into the room.", name={"type": "string"}, content={"type": "string"}),
    tool_spec("write_file", "Overwrite an existing editable file.", name={"type": "string"}, content={"type": "string"}),
    tool_spec("annotate_file", "Attach a note to a file.", name={"type": "string"}, note={"type": "string"}),
    tool_spec("add_memory", "Save a memory for this room.", text={"type": "string"}),
    tool_spec("list_memories", "List saved memories."),
    tool_spec("start_file_pass", "Durable background pass covering an entire file.", name={"type": "string"}, instruction={"type": "string"}),
    tool_spec("job_status", "How background jobs are doing."),
    tool_spec("search_mcp_tools", "Find a connected third-party tool.", query={"type": "string"}),
    tool_spec("run_mcp_tool", "Run a connected third-party tool by id.", tool={"type": "string"}, arguments={"type": "object"}),
]


class RecordingBridge:
    """A scripted room-MCP bridge: serves a catalog, records tools/call."""

    def __init__(
        self,
        tools: list[dict[str, Any]] | None = None,
        reply: Callable[[str, dict[str, Any]], str] | None = None,
    ) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        tools = tools if tools is not None else CATALOG
        reply = reply or (lambda name, args: "OK.")
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a: Any) -> None:  # noqa: N802
                pass

            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(
                    self.rfile.read(int(self.headers["Content-Length"])) or b"{}"
                )
                rid, method = body.get("id"), body.get("method", "")
                if rid is None:
                    self.send_response(202)
                    self.end_headers()
                    return
                if method == "initialize":
                    result: Any = {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "e2e-room", "version": "0"},
                    }
                elif method == "tools/list":
                    result = {"tools": tools}
                elif method == "tools/call":
                    p = body.get("params", {})
                    name = p.get("name", "")
                    args = p.get("arguments", {}) or {}
                    bridge.calls.append((name, args))
                    result = {
                        "content": [{"type": "text", "text": reply(name, args)}],
                        "isError": False,
                    }
                else:
                    result = {}
                data = json.dumps(
                    {"jsonrpc": "2.0", "id": rid, "result": result}
                ).encode()
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    # The CLI hung up before reading the reply. Same reason as
                    # hub_mcp._send: a traceback per occurrence buries the real
                    # failures in a long recording run's log.
                    pass

        self._server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_port}/mcp"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


async def run_ask(
    question: str,
    *,
    bridge: RecordingBridge,
    system: str = BASE_SYSTEM,
    user_prefix: str = "",
    history: list[dict[str, str]] | None = None,
    include_current_user: bool = True,
    temperature: float = 0.2,
    timeout: float = 420.0,
    turn_max_rounds: int | None = None,
) -> dict[str, Any]:
    """One /run turn through the real app; returns a parsed event digest.

    The user message mirrors the host's composed shape: optional context
    blocks (``user_prefix``) then ``Question: …``.
    """
    from arcelle_sidecar.server import create_app

    messages: list[dict[str, str]] = [{"role": "system", "content": system}]
    messages += list(history or [])
    if include_current_user:
        messages.append({"role": "user", "content": f"{user_prefix}Question: {question}"})

    app = create_app()
    body = {
        "model": E2E_MODEL,
        "question": question,
        "messages": messages,
        "temperature": temperature,
        "ollama_base_url": OLLAMA,
        "mcp": {"url": bridge.url, "token": "e2e"},
        "web_enabled": False,
        "run_id": "e2e",
    }
    if turn_max_rounds is not None:
        # The whole-ask runaway net (config.TURN_ROUND_BACKSTOP). A test that
        # deliberately starves the model needs this, or the starved run spends
        # its time delegating in circles instead of answering — measured at 32
        # rounds and 890 s before the bound existed.
        body["turn_max_rounds"] = turn_max_rounds
    events: list[dict[str, Any]] = []
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://sidecar",
        timeout=timeout,
    ) as c:
        async with c.stream("POST", "/run", json=body) as r:
            assert r.status_code == 200
            async for line in r.aiter_lines():
                if line.strip():
                    events.append(json.loads(line))
    final = next((e["v"] for e in reversed(events) if e["t"] == "final"), "")
    usages = [e for e in events if e["t"] == "usage"]
    return {
        "events": events,
        "kinds": [e["t"] for e in events],
        "plan": next((e["v"] for e in events if e["t"] == "plan"), None),
        "plan_last": next((e["v"] for e in reversed(events) if e["t"] == "plan"), None),
        "agents": [e["v"] for e in events if e["t"] == "agent"],
        "steps": [e["v"] for e in events if e["t"] == "step"],
        "final": final,
        "tool_calls": [name for name, _ in bridge.calls],
        "last_usage": usages[-1] if usages else None,
    }


async def run_ask_sampled(
    question: str,
    accept: Callable[[dict[str, Any]], bool],
    *,
    attempts: int = 2,
    **kwargs: Any,
) -> dict[str, Any]:
    """Run the same ask up to ``attempts`` times; return the first accepted
    digest, else the last one (the caller's assertions then show the miss).

    For assertions on MODEL CHOICES (did the 4B call start_file_pass?) rather
    than architecture (plan shape, one final — those are deterministic and
    need no retry). One retry squares the per-sample failure rate; more would
    hide a real regression behind persistence.
    """
    reply = kwargs.pop("reply", None) or (lambda n, a: "OK.")
    out: dict[str, Any] = {}
    for _ in range(max(1, attempts)):
        bridge = RecordingBridge(reply=reply)
        try:
            out = await run_ask(question, bridge=bridge, **kwargs)
        finally:
            bridge.close()
        if accept(out):
            return out
    return out


async def run_worker_live(
    agent_id: str,
    instruction: str,
    *,
    bridge: RecordingBridge,
    system: str = BASE_SYSTEM,
    temperature: float = 0.2,
) -> dict[str, Any]:
    """Drive ONE worker's own compiled shape against the real model + bridge.

    ``run_ask`` drives the MAIN agent, so reaching a specific worker through it
    depends on the 4B choosing to delegate there — which makes a SHAPE test
    flaky for a reason that has nothing to do with the shape. This invokes
    ``graph_for(agent_id)`` directly, exactly as ``execute_tools`` does for a
    delegation, so what is under test is the wiring and not the router.

    Returns the final ``AgentState`` plus the digest fields, because the
    structural facts these tests care about — how many model rounds ran, which
    messages still carry image payloads — live in state, not in the event
    stream.
    """
    from arcelle_sidecar.chat import OllamaChatModel
    from arcelle_sidecar.config import ProviderConfig
    from arcelle_sidecar.external_llm import ExternalChatModel, is_external_model
    from arcelle_sidecar.provider_api import OpenAICompatibleChatModel, is_api_provider_model
    from arcelle_sidecar.config import AGENT_ROUND_BACKSTOP
    from arcelle_sidecar.graph import CancelToken, Deps
    from arcelle_sidecar.graphs import graph_for, recursion_limit_for
    from arcelle_sidecar.mcp_client import McpClient

    events: list[dict[str, Any]] = []

    async def emit(event: dict[str, Any]) -> None:
        events.append(event)

    mcp = McpClient(bridge.url, "e2e")
    # A cloud CLI is the same one-method seam, so a strong TEACHER can drive the
    # very same graphs — which is what makes distillation data match inference.
    model = os.environ.get("ARCELLE_E2E_MODEL", E2E_MODEL)
    if is_api_provider_model(model):
        # An OpenRouter-style provider, addressed as `openrouter::<slug>`.
        # In the product the credentials arrive from the Rust host's Keychain;
        # the sidecar has no Keychain access of its own, so a dev-time run
        # reads the key from the environment. It is never written to a file:
        # this repo's data/ and logs are the things most likely to be shared.
        key = os.environ.get("OPENROUTER_API_KEY", "")
        if not key:
            raise RuntimeError("OPENROUTER_API_KEY is not set")
        chat = OpenAICompatibleChatModel(
            model=model,
            provider=ProviderConfig(
                id="openrouter",
                api_key=key,
                base_url=os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
                model=model.split("::", 1)[-1],
            ),
            temperature=temperature,
        )
    elif is_external_model(model):
        # The bridge URL is REQUIRED, not an optimisation. A cloud CLI is an
        # agent harness: without a real endpoint the room tools are offered as a
        # text protocol, and the harness tries to call them natively anyway —
        # its own runtime answers "No such tool available" and the model then
        # writes a truthful "I tried to run tidy.py but it's failing". Measured
        # 2026-07-26: 4 of 24 recorded trajectories ended in that apology, which
        # as training data teaches a student to refuse work the tools support.
        # Production passes `mcp_url` here, so passing it is also what makes the
        # recorded trajectory match the one at inference.
        chat = ExternalChatModel(
            model=model,
            temperature=temperature,
            mcp_url=bridge.url,
            mcp_token="e2e",
        )
    else:
        chat = OllamaChatModel(model=model, base_url=OLLAMA, temperature=temperature)
    deps = Deps(chat=chat, emit=emit, cancel=CancelToken(), mcp=mcp)

    # No per-agent budget any more: the runaway backstop is the only bound,
    # exactly as the product runs it.
    max_rounds = AGENT_ROUND_BACKSTOP
    initial: dict[str, Any] = {
        "question": instruction,
        "web_enabled": True,
        "write": True,
        "advisors": False,
        "max_rounds": max_rounds,
        "run_max_rounds": AGENT_ROUND_BACKSTOP,
        # A plain Ollama tag: small-local mode, exactly as the product runs it.
        "small_model": True,
        "agent_id": agent_id,
        "plan_multi": False,
        "unlocked_groups": set(),
        "referents": [],
        # Seeded empty like the product does: the write-claim gate must judge
        # what THIS worker wrote, not an inherited baton.
        "produced": [],
        "pipeline": [],
        "worker_base_messages": [],
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": instruction},
        ],
        "seen": set(),
        "attempted": set(),
        "force_synthesis": False,
        "round": 0,
        "calls": [],
        "pending_images": [],
        "final_text": "",
        "progress": [],
        "cancelled": False,
        "stop": False,
    }
    final = await graph_for(agent_id).ainvoke(
        initial,
        config={
            "configurable": {"deps": deps},
            # Sized off the SHAPE, like the product — not every shape spends
            # the same number of supersteps per round (graphs.recursion_limit_for).
            "recursion_limit": recursion_limit_for(agent_id, max_rounds),
        },
    )
    try:
        await mcp.close()
    except Exception:  # noqa: BLE001 - best effort teardown
        pass
    return {
        "state": final,
        "final": final.get("final_text", "") or "",
        "tool_calls": [name for name, _ in bridge.calls],
        "rounds": final.get("round", 0),
        "steps": [e["v"] for e in events if e["t"] == "step"],
        "events": events,
    }
