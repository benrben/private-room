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


def _rpc_body(
    method: str, request_id: int, params: dict[str, Any] | None
) -> dict[str, Any]:
    """Build one JSON-RPC request, omitting parameters when absent."""
    body: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        body["params"] = params
    return body


def _require_rpc_success(response: httpx.Response, method: str) -> None:
    """Raise this client's established errors for failed HTTP responses."""
    if response.status_code == 401:
        raise McpError("room bridge rejected the bearer token")
    if response.status_code != 200:
        raise McpError(f"room bridge returned HTTP {response.status_code} for {method}")


def _rpc_payload(response: httpx.Response, method: str) -> Any:
    """Decode the one JSON response required for a JSON-RPC request."""
    try:
        return response.json()
    except ValueError as exc:
        raise McpError(f"room bridge sent a non-JSON reply to {method}") from exc


def _raise_rpc_error(payload: Any) -> None:
    """Turn a JSON-RPC error envelope into this client's protocol error."""
    if not isinstance(payload, dict):
        return
    error = payload.get("error")
    if not error:
        return
    message = error.get("message") if isinstance(error, dict) else str(error)
    raise McpError(str(message))


def _rpc_result(payload: Any, method: str) -> Any:
    """Return a JSON-RPC result, rejecting malformed response envelopes."""
    if not isinstance(payload, dict):
        raise McpError(f"room bridge sent no result for {method}")
    if "result" not in payload:
        raise McpError(f"room bridge sent no result for {method}")
    return payload["result"]


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
        #: whether the MCP lifecycle handshake (initialize + initialized) has run.
        self._initialized = False

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
        body = _rpc_body(method, next(self._ids), params)
        resp = await self.http.post(self.url, json=body, headers=self._headers())
        _require_rpc_success(resp, method)
        payload = _rpc_payload(resp, method)
        _raise_rpc_error(payload)
        return _rpc_result(payload, method)

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
                "clientInfo": {"name": "arcelle-sidecar", "version": "0.1.0"},
            },
        )
        await self.notify("notifications/initialized")
        self._initialized = True
        return result if isinstance(result, dict) else {}

    async def ensure_ready(self) -> None:
        """Run the MCP lifecycle handshake once, before any tool traffic.

        The room's own Leash is lenient and serves tools without it, but a
        stricter third-party MCP server rejects ``tools/list`` / ``tools/call``
        until the client has sent ``initialize`` followed by the
        ``notifications/initialized`` notification (MCP lifecycle). Best-effort
        and idempotent: a server that does not implement ``initialize`` must not
        have its connection torn down over the handshake — swallow that failure
        and let the actual tool call surface any genuine transport/auth error.
        """
        if self._initialized:
            return
        try:
            await self.initialize()
        except McpError:
            # Don't re-handshake on every call; a real failure resurfaces on the
            # actual tools/* request the caller is about to make.
            self._initialized = True

    async def ping(self) -> None:
        await self._rpc("ping")

    async def list_tools(self) -> list[ToolSpec]:
        """The tools the host chose to serve us.

        Never hardcode the catalog: the host decides our trust scope (SPEC §2.1).
        A top-level bridge may include ``consult_advisor``; nested advisor
        bridges omit it at the host boundary.
        """
        await self.ensure_ready()
        result = await self._rpc("tools/list")
        return _tool_specs(result)

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> ToolResult:
        """Run one tool. A tool failure arrives as ``isError: true``, not an exception."""
        try:
            await self.ensure_ready()
            result = await self._rpc("tools/call", {"name": name, "arguments": arguments})
        except McpError as exc:
            # Unknown tool / transport death: surface it to the model the same way
            # a tool failure looks, so the round can still make progress.
            return ToolResult(text=str(exc), is_error=True)
        return _parse_tool_result(result)


def _tool_specs(result: Any) -> list[ToolSpec]:
    """Translate a tools/list result without letting malformed items leak through."""
    raw = result.get("tools", []) if isinstance(result, dict) else []
    tools: list[ToolSpec] = []
    for tool in raw:
        spec = _tool_spec(tool)
        if spec is not None:
            tools.append(spec)
    return tools


def _tool_spec(tool: Any) -> ToolSpec | None:
    if not isinstance(tool, dict):
        return None
    name = tool.get("name")
    if not isinstance(name, str) or not name:
        return None
    schema = tool.get("inputSchema")
    if not isinstance(schema, dict):
        schema = {"type": "object", "properties": {}}
    return ToolSpec(
        name=name,
        description=str(tool.get("description") or ""),
        input_schema=schema,
    )


def _parse_tool_result(result: Any) -> ToolResult:
    if not isinstance(result, dict):
        return ToolResult(text=str(result))
    texts, images = _tool_content(result.get("content", []) or [])
    return ToolResult(
        text="\n".join(texts),
        is_error=bool(result.get("isError", False)),
        images=images,
    )


def _tool_content(content: Any) -> tuple[list[str], list[str]]:
    texts: list[str] = []
    images: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        text = _text_content(block)
        if text is not None:
            texts.append(text)
            continue
        image = _image_content(block)
        if image is not None:
            images.append(image)
    return texts, images


def _text_content(block: dict[str, Any]) -> str | None:
    if block.get("type") != "text":
        return None
    return str(block.get("text", ""))


def _image_content(block: dict[str, Any]) -> str | None:
    data = block.get("data")
    if block.get("type") != "image" or not isinstance(data, str) or not data:
        return None
    return data


__all__ = ["McpClient", "McpError", "ToolResult", "ToolSpec", "PROTOCOL_VERSION"]
