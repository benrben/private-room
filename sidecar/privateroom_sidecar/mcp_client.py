"""Async JSON-RPC client for the room MCP bridge (SPEC §2).

The bridge is the Rust host's own tool dispatch, exposed on loopback with a
per-run bearer token (``src-tauri/src/room_mcp.rs``). Every tool the sidecar can
call goes through here — the sidecar itself never touches the room database,
never sees the encryption key and never opens a file.

Two protocol details that bite if you miss them:

* A JSON-RPC request **without an id is a notification**: the bridge answers
  ``202 Accepted`` with an *empty body*. Parsing that as JSON throws.
* A **tool failure is not a JSON-RPC error**. It comes back as a normal result
  with ``isError: true`` — deliberately, so the model can see the failure and
  react to it. Only protocol-level failures (unknown method, unknown tool) are
  JSON-RPC errors.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from typing import Any

import httpx

from .routing import FORBIDDEN_TOOL_NAMES

#: The MCP revision the bridge speaks (room_mcp.rs:156).
PROTOCOL_VERSION = "2024-11-05"


class McpError(RuntimeError):
    """A protocol-level failure (JSON-RPC error, auth, transport)."""


@dataclass(slots=True)
class ToolResult:
    """One ``tools/call`` outcome."""

    text: str
    is_error: bool = False
    #: base64 image payloads the tool captured (view_screenshot / view_media_frame).
    images: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ToolSpec:
    """One tool as served by ``tools/list``."""

    name: str
    description: str = ""
    input_schema: dict[str, Any] = field(default_factory=lambda: {"type": "object", "properties": {}})

    def to_ollama(self) -> dict[str, Any]:
        """The Ollama/OpenAI function shape the chat model wants."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.input_schema,
            },
        }


class McpClient:
    """Minimal MCP client: initialize, tools/list, tools/call."""

    def __init__(
        self,
        url: str,
        token: str,
        *,
        client: httpx.AsyncClient | None = None,
        timeout: float = 600.0,
    ) -> None:
        self.url = url
        self.token = token
        self._timeout = timeout
        self._client = client
        self._owns_client = client is None
        self._ids = itertools.count(1)

    async def __aenter__(self) -> McpClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    @property
    def http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout)
            self._owns_client = True
        return self._client

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }

    async def _rpc(self, method: str, params: dict[str, Any] | None = None) -> Any:
        """One JSON-RPC call. Raises McpError on a protocol failure."""
        body: dict[str, Any] = {"jsonrpc": "2.0", "id": next(self._ids), "method": method}
        if params is not None:
            body["params"] = params
        resp = await self.http.post(self.url, json=body, headers=self._headers())
        if resp.status_code == 401:
            raise McpError("room bridge rejected the bearer token")
        if resp.status_code != 200:
            raise McpError(f"room bridge returned HTTP {resp.status_code} for {method}")
        try:
            payload = resp.json()
        except ValueError as exc:  # pragma: no cover - malformed bridge reply
            raise McpError(f"room bridge sent a non-JSON reply to {method}") from exc
        if isinstance(payload, dict) and payload.get("error"):
            err = payload["error"]
            msg = err.get("message") if isinstance(err, dict) else str(err)
            raise McpError(str(msg))
        if not isinstance(payload, dict) or "result" not in payload:
            raise McpError(f"room bridge sent no result for {method}")
        return payload["result"]

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        """Fire a notification (no id). The bridge answers 202 with no body."""
        body: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            body["params"] = params
        resp = await self.http.post(self.url, json=body, headers=self._headers())
        if resp.status_code == 401:
            raise McpError("room bridge rejected the bearer token")
        if resp.status_code not in (200, 202):
            raise McpError(f"room bridge returned HTTP {resp.status_code} for {method}")
        # No body to parse: 202 Accepted, empty. Do not call resp.json() here.

    async def initialize(self) -> dict[str, Any]:
        result = await self._rpc(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "privateroom-sidecar", "version": "0.1.0"},
            },
        )
        await self.notify("notifications/initialized")
        return result if isinstance(result, dict) else {}

    async def ping(self) -> None:
        await self._rpc("ping")

    async def list_tools(self) -> list[ToolSpec]:
        """The tools the host chose to serve us.

        Never hardcode the catalog: the host decides our trust scope (SPEC §2.1).
        ``consult_advisor`` must never appear — if it ever does, drop it, so the
        recursion path stays closed even if the host regresses.
        """
        result = await self._rpc("tools/list")
        raw = result.get("tools", []) if isinstance(result, dict) else []
        tools: list[ToolSpec] = []
        for t in raw:
            if not isinstance(t, dict):
                continue
            name = t.get("name")
            if not isinstance(name, str) or not name:
                continue
            if name in FORBIDDEN_TOOL_NAMES:
                continue
            schema = t.get("inputSchema")
            if not isinstance(schema, dict):
                schema = {"type": "object", "properties": {}}
            tools.append(
                ToolSpec(
                    name=name,
                    description=str(t.get("description") or ""),
                    input_schema=schema,
                )
            )
        return tools

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> ToolResult:
        """Run one tool. A tool failure arrives as ``isError: true``, not an exception."""
        try:
            result = await self._rpc("tools/call", {"name": name, "arguments": arguments})
        except McpError as exc:
            # Unknown tool / transport death: surface it to the model the same way
            # a tool failure looks, so the round can still make progress.
            return ToolResult(text=str(exc), is_error=True)
        return _parse_tool_result(result)


def _parse_tool_result(result: Any) -> ToolResult:
    if not isinstance(result, dict):
        return ToolResult(text=str(result))
    is_error = bool(result.get("isError", False))
    texts: list[str] = []
    images: list[str] = []
    for block in result.get("content", []) or []:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "text":
            texts.append(str(block.get("text", "")))
        elif kind == "image":
            data = block.get("data")
            if isinstance(data, str) and data:
                images.append(data)
    return ToolResult(text="\n".join(texts), is_error=is_error, images=images)


__all__ = ["McpClient", "McpError", "ToolResult", "ToolSpec", "PROTOCOL_VERSION"]
