"""Deep Agents adapter for Arcelle's existing model and specialist runtime.

This module never opens a room path. Workspace operations cross the existing
authenticated MCP bridge, so the Electron Workspace Service remains the only
process that can touch live files. LocalShellBackend is intentionally absent.
"""

from __future__ import annotations

import json
import posixpath
import re
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
from langchain_core.tools import BaseTool, StructuredTool
from langchain_core.utils.function_calling import convert_to_openai_tool
from langgraph.graph import END, START, StateGraph
from pydantic import ConfigDict, Field

from .agents import REGISTRY, get_agent
from .config import RunRequest
from .graph import Deps
from .graphs import graph_for, recursion_limit_for
from .llm import capabilities as ollama_capabilities
from .mcp_client import McpClient
from .messages import Message
from .privacy import is_nonlocal_model

MODEL_SEPARATOR = ":" * 2
SAFE_WORKSPACE_FAILURE = "Workspace operation failed. Raw diagnostics were omitted to protect room data."


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

        content, calls, usage = await self.inner.stream(
            _arcelle_messages(messages), self.bound_tools, on_delta, self.cancel
        )
        tool_calls = [
            {"name": call.name, "args": call.arguments, "id": call.id or f"call_{index}"}
            for index, call in enumerate(calls)
        ]
        input_tokens = max(0, int(usage.input_tokens or 0))
        return ChatResult(
            generations=[
                ChatGeneration(
                    message=AIMessage(
                        content=content,
                        tool_calls=tool_calls,
                        usage_metadata={
                            "input_tokens": input_tokens,
                            "output_tokens": 0,
                            "total_tokens": input_tokens,
                        },
                    )
                )
            ]
        )


@dataclass(frozen=True, slots=True)
class DeepHarnessDecision:
    """One explicit runtime choice for a requested Deep Harness turn."""

    mode: str
    reason: str
    small_model: bool = False

    @property
    def use_deep_agent(self) -> bool:
        return self.mode == "deep"


_PARAMETER_SIZE = re.compile(r"(?:^|[-:])(?P<size>\d+(?:\.\d+)?)b(?:$|[-:])", re.IGNORECASE)


def is_small_parameter_model(model: str) -> bool:
    """Conservative small-model hint used by the existing deterministic graph."""
    match = _PARAMETER_SIZE.search(model.split(MODEL_SEPARATOR)[-1])
    return match is not None and float(match.group("size")) <= 8.0


async def select_deep_harness(req: RunRequest) -> DeepHarnessDecision:
    """Choose standard Deep Agents or Arcelle's deterministic graph.

    Capability data is authoritative. A provider that cannot call tools is
    never placed in a filesystem loop. The compatibility graph remains behind
    the same event contract, preserving its cancellation, compaction,
    duplicate protection and final synthesis behavior for weak models.
    """
    small = is_small_parameter_model(req.model)
    if req.harness != "deep":
        return DeepHarnessDecision("deterministic", "The classic harness was requested.", small)
    if req.mcp is None:
        return DeepHarnessDecision("deterministic", "No authenticated workspace bridge is available.", small)
    if req.provider is not None:
        if req.provider.supports_tools:
            return DeepHarnessDecision("deep", "The provider declares tool support.", small)
        return DeepHarnessDecision("deterministic", "The provider does not support tool calling.", small)
    # Native Codex/Claude own their rich harnesses. Requests that reach this
    # compatibility endpoint stay on the proven deterministic adapter.
    if MODEL_SEPARATOR in req.model:
        return DeepHarnessDecision("deterministic", "This engine uses its native or compatibility harness.", small)
    caps = await ollama_capabilities(req.model, req.ollama_base_url)
    if "tools" not in {str(cap).casefold() for cap in caps}:
        location = "cloud" if is_nonlocal_model(req.model) else "local"
        return DeepHarnessDecision(
            "deterministic",
            f"The {location} Ollama model does not declare tool support.",
            small,
        )
    return DeepHarnessDecision("deep", "The Ollama model declares tool support.", small)


class WorkspaceBridge(Protocol):
    async def call(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]: ...


@dataclass(slots=True)
class McpWorkspaceBridge:
    """Language-neutral workspace protocol carried over Arcelle MCP tools."""

    mcp: McpClient

    async def call(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
        result = await self.mcp.call_tool(f"workspace_{operation}", arguments)
        if result.is_error:
            return {"error": SAFE_WORKSPACE_FAILURE}
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

    def __init__(self, bridge: WorkspaceBridge, *, write_enabled: bool, cancel: Any = None) -> None:
        self.bridge = bridge
        self.write_enabled = write_enabled
        self.cancel = cancel
        # One run, one backend. Repeated byte-identical mutations are model
        # retries, not a reason to write/trash twice. Reads stay live.
        self._mutations: dict[str, dict[str, Any]] = {}

    async def _call(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if self.cancel is not None and self.cancel.cancelled:
            return {"error": "This run was cancelled."}
        try:
            payload = await self.bridge.call(operation, arguments)
            if payload.get("error"):
                return {"error": SAFE_WORKSPACE_FAILURE}
            return payload
        except Exception:  # noqa: BLE001 - raw bridge errors can contain private data
            return {"error": SAFE_WORKSPACE_FAILURE}

    async def _mutate(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
        key = f"{operation}:{json.dumps(arguments, sort_keys=True, separators=(',', ':'))}"
        cached = self._mutations.get(key)
        if cached is not None:
            return cached
        payload = await self._call(operation, arguments)
        # A failed operation may become valid after the user resolves a conflict;
        # only successful commits are safe to suppress as duplicates.
        if not payload.get("error"):
            self._mutations[key] = payload
        return payload

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
        payload = await self._mutate("write", {"path": safe, "content": content})
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
        payload = await self._mutate(
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
        payload = await self._mutate("delete", {"path": safe})
        return DeleteResult(error=payload.get("error"), path=payload.get("path"))

    async def amove(self, source_path: str, destination_path: str) -> dict[str, Any]:
        """Move one normal workspace file without reading or rewriting its bytes."""
        if not self.write_enabled:
            return {"error": "This run is read-only."}
        try:
            source = _safe_virtual_path(source_path)
            destination = _safe_virtual_path(destination_path)
        except ValueError as exc:
            return {"error": str(exc)}
        return await self._mutate(
            "move", {"source_path": source, "destination_path": destination}
        )

    async def arename(self, file_path: str, new_name: str) -> dict[str, Any]:
        """Rename one normal workspace file in place without touching its bytes."""
        if not self.write_enabled:
            return {"error": "This run is read-only."}
        try:
            source = _safe_virtual_path(file_path)
        except ValueError as exc:
            return {"error": str(exc)}
        requested = new_name.strip()
        if (
            requested in {"", ".", ".."}
            or "/" in requested
            or "\\" in requested
            or requested.casefold() == ".arcelle"
        ):
            return {"error": "The new name must be one safe file name."}
        destination = posixpath.join(posixpath.dirname(source), requested)
        return await self._mutate(
            "rename",
            {"source_path": source, "new_name": requested, "destination_path": destination},
        )

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


def _workspace_mutation_tools(backend: ArcelleWorkspaceBackend) -> list[BaseTool]:
    """Tools missing from Deep Agents' text-focused filesystem middleware."""

    async def workspace_delete(file_path: str) -> str:
        """Move one normal workspace file to recoverable Arcelle Trash.

        Use this tool when the user asks to delete a file. Do not simulate a
        deletion by renaming or moving the file to another workspace folder.
        Arcelle permits the operation only after a rollback baseline exists.
        """
        result = await backend.adelete(file_path)
        return json.dumps(
            {
                key: value
                for key, value in {"error": result.error, "path": result.path}.items()
                if value is not None
            },
            sort_keys=True,
            separators=(",", ":"),
        )

    async def workspace_move(source_path: str, destination_path: str) -> str:
        """Move or rename a normal workspace file to an exact absolute virtual path.

        This moves the filesystem entry directly, so it also works for PDFs,
        recordings, images, sketches, spreadsheets, and other binary files.
        Arcelle permits the operation only after a rollback baseline exists.
        """
        return json.dumps(
            await backend.amove(source_path, destination_path),
            sort_keys=True,
            separators=(",", ":"),
        )

    async def workspace_rename(file_path: str, new_name: str) -> str:
        """Rename a normal workspace file while keeping it in its current folder.

        Give only the new file name, including its extension. Arcelle moves the
        filesystem entry directly and requires an authorized rollback baseline.
        """
        return json.dumps(
            await backend.arename(file_path, new_name),
            sort_keys=True,
            separators=(",", ":"),
        )

    return [
        StructuredTool.from_function(
            name="workspace_delete",
            description=workspace_delete.__doc__ or "Move a workspace file to Arcelle Trash.",
            coroutine=workspace_delete,
        ),
        StructuredTool.from_function(
            name="workspace_move",
            description=workspace_move.__doc__ or "Move a workspace file.",
            coroutine=workspace_move,
        ),
        StructuredTool.from_function(
            name="workspace_rename",
            description=workspace_rename.__doc__ or "Rename a workspace file.",
            coroutine=workspace_rename,
        ),
    ]


class _SubagentState(TypedDict):
    messages: list[BaseMessage]


def _subagent_initial_state(
    spec_id: str,
    question: str,
    messages: list[Message],
    *,
    write_enabled: bool,
    max_rounds: int,
    small_model: bool,
) -> dict[str, Any]:
    """Build a specialist state with no ambient network or connector access."""
    return {
        "question": question,
        # Deep Harness grants workspace tools only. Browser, advisor, connector
        # and shell access must be explicitly mediated by Arcelle.
        "web_enabled": False,
        "write": write_enabled,
        "advisors": False,
        "max_rounds": max_rounds,
        "run_max_rounds": max_rounds,
        "small_model": small_model,
        "agent_id": spec_id,
        "direct": True,
        "node_key": spec_id,
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


@dataclass(slots=True)
class ArcelleCompiledSubAgentAdapter:
    """Wrap one existing specialist graph as a Deep Agents compiled subagent."""

    deps: Deps
    write_enabled: bool
    max_rounds: int
    small_model: bool = False

    def compile(self, agent_id: str) -> CompiledSubAgent:
        spec = get_agent(agent_id)

        async def run(state: _SubagentState) -> dict[str, list[BaseMessage]]:
            messages = _arcelle_messages(state.get("messages", []))
            question = next(
                (m.get("content", "") for m in reversed(messages) if m.get("role") == "user"),
                "",
            )
            initial = _subagent_initial_state(
                spec.id,
                question,
                messages,
                write_enabled=self.write_enabled,
                max_rounds=self.max_rounds,
                small_model=self.small_model,
            )
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


def build_deep_agent(
    deps: Deps,
    *,
    write_enabled: bool,
    max_rounds: int,
    small_model: bool = False,
) -> Any:
    """Build the provider-neutral Deep Agent for Ollama/OpenRouter runs."""
    if deps.mcp is None:
        raise RuntimeError("Deep Harness needs the authenticated Arcelle MCP bridge.")
    backend = ArcelleWorkspaceBackend(
        McpWorkspaceBridge(deps.mcp),
        write_enabled=write_enabled,
        cancel=deps.cancel,
    )
    adapter = ArcelleCompiledSubAgentAdapter(deps, write_enabled, max_rounds, small_model)
    subagents = [adapter.compile(spec.id) for spec in REGISTRY if spec.id != "chat.answer"]
    permissions = [
        FilesystemPermission(operations=["read"], paths=["/.arcelle/**"], mode="deny"),
        FilesystemPermission(operations=["write"], paths=["/**"], mode="allow" if write_enabled else "deny"),
    ]
    return create_deep_agent(
        model=ArcelleHarnessModelAdapter(inner=deps.chat, cancel=deps.cancel),
        tools=_workspace_mutation_tools(backend),
        system_prompt=get_agent("chat.answer").prompt,
        backend=backend,
        permissions=permissions,
        subagents=subagents,
        name="arcelle-deep-harness",
    )


async def run_deep_agent(
    question: str,
    deps: Deps,
    *,
    write_enabled: bool,
    max_rounds: int,
    small_model: bool = False,
) -> str:
    """Run one Deep Harness turn while keeping Arcelle's existing event wire."""
    await deps.emit({"t": "step", "v": "Deep Harness started"})
    agent = build_deep_agent(
        deps,
        write_enabled=write_enabled,
        max_rounds=max_rounds,
        small_model=small_model,
    )
    result = await agent.ainvoke(
        {"messages": [HumanMessage(content=question)]},
        config={"recursion_limit": max(8, max_rounds * 4)},
    )
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
    "DeepHarnessDecision",
    "McpWorkspaceBridge",
    "build_deep_agent",
    "is_small_parameter_model",
    "run_deep_agent",
    "select_deep_harness",
]
