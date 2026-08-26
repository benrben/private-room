"""Deep Agents adapter for Arcelle's existing model and specialist runtime.

This module never opens a room path. Workspace operations cross the existing
authenticated MCP bridge, so the Electron Workspace Service remains the only
process that can touch live files. LocalShellBackend is intentionally absent.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Protocol, TypedDict

from deepagents import CompiledSubAgent, FilesystemPermission, create_deep_agent
from deepagents.backends import BackendProtocol, StateBackend
from deepagents.backends.protocol import (
    DeleteResult,
    EditResult,
    GlobResult,
    GrepResult,
    LsResult,
    ReadResult,
    WriteResult,
)
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import BaseTool
from langchain_core.utils.function_calling import convert_to_openai_tool
from langgraph.graph import END, START, StateGraph
from pydantic import ConfigDict, Field

from .agents import REGISTRY, get_agent
from .graph import Deps
from .graphs import graph_for, recursion_limit_for
from .mcp_client import McpClient
from .messages import Message


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            str(block.get("text", ""))
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return str(content or "")


def _arcelle_messages(messages: list[BaseMessage]) -> list[Message]:
    out: list[Message] = []
    for message in messages:
        if isinstance(message, SystemMessage):
            out.append({"role": "system", "content": _text(message.content)})
        elif isinstance(message, HumanMessage):
            out.append({"role": "user", "content": _text(message.content)})
        elif isinstance(message, ToolMessage):
            out.append(
                {
                    "role": "tool",
                    "content": _text(message.content),
                    "tool_name": message.name or "tool",
                    "tool_call_id": message.tool_call_id,
                }
            )
        elif isinstance(message, AIMessage):
            raw_calls = [
                {
                    "id": call.get("id", ""),
                    "type": "function",
                    "function": {"name": call.get("name", ""), "arguments": call.get("args", {})},
                }
                for call in message.tool_calls
            ]
            item: Message = {"role": "assistant", "content": _text(message.content)}
            if raw_calls:
                item["tool_calls"] = raw_calls
            out.append(item)
    return out


class ArcelleHarnessModelAdapter(BaseChatModel):
    """Expose Arcelle's streaming ChatModel through LangChain's model contract."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    inner: Any = Field(exclude=True)
    cancel: Any = Field(default=None, exclude=True)
    bound_tools: list[dict[str, Any]] = Field(default_factory=list, exclude=True)

    @property
    def _llm_type(self) -> str:
        return "arcelle-harness-model"

    def bind_tools(
        self,
        tools: list[dict[str, Any] | type | BaseTool | Any],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Any:
        del tool_choice, kwargs
        return self.model_copy(
            update={"bound_tools": [convert_to_openai_tool(tool) for tool in tools]}
        )

    def _generate(self, messages: list[BaseMessage], stop: list[str] | None = None, **kwargs: Any) -> ChatResult:
        del messages, stop, kwargs
        raise RuntimeError("Arcelle's harness model is async-only.")

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        del stop, kwargs

        async def on_delta(delta: str) -> None:
            if run_manager is not None:
                await run_manager.on_llm_new_token(delta)

        content, calls, _usage = await self.inner.stream(
            _arcelle_messages(messages), self.bound_tools, on_delta, self.cancel
        )
        tool_calls = [
            {"name": call.name, "args": call.arguments, "id": call.id or f"call_{index}"}
            for index, call in enumerate(calls)
        ]
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=content, tool_calls=tool_calls))])


class WorkspaceBridge(Protocol):
    async def call(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]: ...


@dataclass(slots=True)
class McpWorkspaceBridge:
    """Language-neutral workspace protocol carried over Arcelle MCP tools."""

    mcp: McpClient

    async def call(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
        result = await self.mcp.call_tool(f"workspace_{operation}", arguments)
        if result.is_error:
            return {"error": result.text or "Workspace operation failed."}
        try:
            payload = json.loads(result.text)
        except json.JSONDecodeError:
            return {"error": "The workspace bridge returned an invalid response."}
        return payload if isinstance(payload, dict) else {"error": "Invalid workspace response."}


def _safe_virtual_path(value: str) -> str:
    if not value.startswith("/"):
        raise ValueError("Workspace paths must start with '/'.")
    parts = [part for part in value.replace("\\", "/").split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise ValueError("Workspace paths cannot leave the room.")
    if parts and parts[0].casefold() == ".arcelle":
        raise ValueError("The .arcelle directory is private.")
    return "/" + "/".join(parts)


class ArcelleWorkspaceBackend(BackendProtocol):
    """Deep Agents filesystem backend that delegates every byte to Electron."""

    def __init__(self, bridge: WorkspaceBridge, *, write_enabled: bool) -> None:
        self.bridge = bridge
        self.write_enabled = write_enabled

    async def _call(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
        try:
            return await self.bridge.call(operation, arguments)
        except Exception as exc:  # noqa: BLE001 - backend errors are tool results
            return {"error": str(exc)}

    async def als(self, path: str) -> LsResult:
        try:
            safe = _safe_virtual_path(path)
        except ValueError as exc:
            return LsResult(error=str(exc))
        payload = await self._call("list", {"path": safe})
        return LsResult(error=payload.get("error"), entries=payload.get("entries"))

    async def aread(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        try:
            safe = _safe_virtual_path(file_path)
        except ValueError as exc:
            return ReadResult(error=str(exc))
        payload = await self._call("read", {"path": safe, "offset": offset, "limit": limit})
        if payload.get("error"):
            return ReadResult(error=payload["error"])
        return ReadResult(
            file_data=payload.get("file_data"),
            total_lines=payload.get("total_lines"),
            start_line=payload.get("start_line"),
            end_line=payload.get("end_line"),
            next_offset=payload.get("next_offset"),
        )

    async def awrite(self, file_path: str, content: str) -> WriteResult:
        if not self.write_enabled:
            return WriteResult(error="This run is read-only.")
        try:
            safe = _safe_virtual_path(file_path)
        except ValueError as exc:
            return WriteResult(error=str(exc))
        payload = await self._call("write", {"path": safe, "content": content})
        return WriteResult(error=payload.get("error"), path=payload.get("path"))

    async def aedit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        if not self.write_enabled:
            return EditResult(error="This run is read-only.")
        try:
            safe = _safe_virtual_path(file_path)
        except ValueError as exc:
            return EditResult(error=str(exc))
        payload = await self._call(
            "edit",
            {
                "path": safe,
                "old_string": old_string,
                "new_string": new_string,
                "replace_all": replace_all,
            },
        )
        return EditResult(
            error=payload.get("error"),
            path=payload.get("path"),
            occurrences=payload.get("occurrences"),
        )

    async def adelete(self, file_path: str) -> DeleteResult:
        if not self.write_enabled:
            return DeleteResult(error="This run is read-only.")
        try:
            safe = _safe_virtual_path(file_path)
        except ValueError as exc:
            return DeleteResult(error=str(exc))
        payload = await self._call("delete", {"path": safe})
        return DeleteResult(error=payload.get("error"), path=payload.get("path"))

    async def aglob(self, pattern: str, path: str | None = None) -> GlobResult:
        try:
            safe = _safe_virtual_path(path or "/")
        except ValueError as exc:
            return GlobResult(error=str(exc))
        payload = await self._call("glob", {"path": safe, "pattern": pattern})
        return GlobResult(
            error=payload.get("error"),
            matches=payload.get("matches"),
            truncated=bool(payload.get("truncated", False)),
        )

    async def agrep(
        self,
        pattern: str,
        path: str | None = None,
        glob: str | None = None,
        *,
        max_count: int | None = None,
    ) -> GrepResult:
        try:
            safe = _safe_virtual_path(path or "/")
        except ValueError as exc:
            return GrepResult(error=str(exc))
        payload = await self._call(
            "grep", {"path": safe, "pattern": pattern, "glob": glob, "max_count": max_count}
        )
        return GrepResult(
            error=payload.get("error"),
            matches=payload.get("matches"),
            truncated=bool(payload.get("truncated", False)),
        )


class ArcelleStateBackend(StateBackend):
    """Named Deep Agents state backend for temporary plans and spill files."""


@dataclass(slots=True)
class ArcelleToolBackend:
    """Restricted adapter for Arcelle special tools; no shell or raw paths."""

    mcp: McpClient

    async def call(self, name: str, arguments: dict[str, Any]) -> str:
        result = await self.mcp.call_tool(name, arguments)
        if result.is_error:
            raise RuntimeError(result.text)
        return result.text


class _SubagentState(TypedDict):
    messages: list[BaseMessage]


@dataclass(slots=True)
class ArcelleCompiledSubAgentAdapter:
    """Wrap one existing specialist graph as a Deep Agents compiled subagent."""

    deps: Deps
    write_enabled: bool
    max_rounds: int

    def compile(self, agent_id: str) -> CompiledSubAgent:
        spec = get_agent(agent_id)

        async def run(state: _SubagentState) -> dict[str, list[BaseMessage]]:
            messages = _arcelle_messages(state.get("messages", []))
            question = next(
                (m.get("content", "") for m in reversed(messages) if m.get("role") == "user"),
                "",
            )
            initial: dict[str, Any] = {
                "question": question,
                "web_enabled": False,
                "write": self.write_enabled,
                "advisors": False,
                "max_rounds": self.max_rounds,
                "run_max_rounds": self.max_rounds,
                "small_model": False,
                "agent_id": spec.id,
                "direct": True,
                "node_key": spec.id,
                "plan_multi": False,
                "unlocked_groups": set(),
                "spills": [],
                "referents": [],
                "produced": [],
                "pipeline": [],
                "worker_base_messages": [],
                "messages": messages,
                "seen": set(),
                "force_synthesis": False,
                "stalls": 0,
                "round": 0,
                "calls": [],
                "pending_images": [],
                "final_text": "",
                "progress": [],
                "cancelled": False,
                "stop": False,
            }
            final = await graph_for(spec.id).ainvoke(
                initial,
                config={
                    "configurable": {"deps": self.deps.for_child(spec.id)},
                    "recursion_limit": recursion_limit_for(spec.id, self.max_rounds),
                },
            )
            return {"messages": [AIMessage(content=str(final.get("final_text", "") or "Done."))]}

        graph = StateGraph(_SubagentState)
        graph.add_node("run", run)
        graph.add_edge(START, "run")
        graph.add_edge("run", END)
        return CompiledSubAgent(name=spec.id, description=spec.summary, runnable=graph.compile())


def build_deep_agent(deps: Deps, *, write_enabled: bool, max_rounds: int) -> Any:
    """Build the provider-neutral Deep Agent for Ollama/OpenRouter runs."""
    if deps.mcp is None:
        raise RuntimeError("Deep Harness needs the authenticated Arcelle MCP bridge.")
    backend = ArcelleWorkspaceBackend(McpWorkspaceBridge(deps.mcp), write_enabled=write_enabled)
    adapter = ArcelleCompiledSubAgentAdapter(deps, write_enabled, max_rounds)
    subagents = [adapter.compile(spec.id) for spec in REGISTRY if spec.id != "chat.answer"]
    permissions = [
        FilesystemPermission(operations=["read"], paths=["/.arcelle/**"], mode="deny"),
        FilesystemPermission(operations=["write"], paths=["/**"], mode="allow" if write_enabled else "deny"),
    ]
    return create_deep_agent(
        model=ArcelleHarnessModelAdapter(inner=deps.chat, cancel=deps.cancel),
        system_prompt=get_agent("chat.answer").prompt,
        backend=backend,
        permissions=permissions,
        subagents=subagents,
        name="arcelle-deep-harness",
    )


async def run_deep_agent(question: str, deps: Deps, *, write_enabled: bool, max_rounds: int) -> str:
    """Run one Deep Harness turn while keeping Arcelle's existing event wire."""
    await deps.emit({"t": "step", "v": "Deep Harness started"})
    agent = build_deep_agent(deps, write_enabled=write_enabled, max_rounds=max_rounds)
    result = await agent.ainvoke({"messages": [HumanMessage(content=question)]})
    messages = result.get("messages", [])
    answer = _text(messages[-1].content) if messages else "Done."
    await deps.emit({"t": "final", "v": answer})
    return answer


__all__ = [
    "ArcelleCompiledSubAgentAdapter",
    "ArcelleHarnessModelAdapter",
    "ArcelleStateBackend",
    "ArcelleToolBackend",
    "ArcelleWorkspaceBackend",
    "McpWorkspaceBridge",
    "build_deep_agent",
    "run_deep_agent",
]
