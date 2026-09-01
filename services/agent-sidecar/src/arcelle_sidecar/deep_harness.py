"""Deep Agents adapter for Arcelle's existing model and specialist runtime.

This module never opens a room path. Workspace operations cross the existing
authenticated MCP bridge, so the Electron Workspace Service remains the only
process that can touch live files. LocalShellBackend is intentionally absent.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, TypeGuard, TypedDict

from deepagents import CompiledSubAgent, FilesystemPermission, create_deep_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import BaseTool
from langchain_core.utils.function_calling import convert_to_openai_tool
from langgraph.graph import END, START, StateGraph
from pydantic import ConfigDict, Field

from .agents import REGISTRY, get_agent
from .config import RunRequest
from .deep_harness_workspace import (
    SAFE_WORKSPACE_FAILURE as SAFE_WORKSPACE_FAILURE,
    ArcelleStateBackend as ArcelleStateBackend,
    ArcelleToolBackend as ArcelleToolBackend,
    ArcelleWorkspaceBackend as ArcelleWorkspaceBackend,
    McpWorkspaceBridge as McpWorkspaceBridge,
    WorkspaceBridge as WorkspaceBridge,
    _safe_virtual_path as _safe_virtual_path,
    _workspace_mutation_tools as _workspace_mutation_tools,
)
from .graph import Deps
from .graphs import graph_for, recursion_limit_for
from .llm import capabilities as ollama_capabilities
from .messages import Message
from .privacy import is_nonlocal_model

MODEL_SEPARATOR = ":" * 2


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return _text_blocks(content)
    return str(content or "")


def _text_blocks(content: list[Any]) -> str:
    return "\n".join(str(block.get("text", "")) for block in content if _is_text_block(block))


def _is_text_block(block: Any) -> TypeGuard[dict[str, Any]]:
    return isinstance(block, dict) and block.get("type") == "text"


def _text_message(role: str, message: BaseMessage) -> Message:
    return {"role": role, "content": _text(message.content)}


def _tool_message(message: ToolMessage) -> Message:
    return {
        "role": "tool",
        "content": _text(message.content),
        "tool_name": message.name or "tool",
        "tool_call_id": message.tool_call_id,
    }


def _raw_tool_calls(message: AIMessage) -> list[dict[str, Any]]:
    return [
        {
            "id": call.get("id", ""),
            "type": "function",
            "function": {"name": call.get("name", ""), "arguments": call.get("args", {})},
        }
        for call in message.tool_calls
    ]


def _assistant_message(message: AIMessage) -> Message:
    item: Message = _text_message("assistant", message)
    raw_calls = _raw_tool_calls(message)
    if raw_calls:
        item["tool_calls"] = raw_calls
    return item


def _arcelle_message(message: BaseMessage) -> Message | None:
    if isinstance(message, SystemMessage):
        return _text_message("system", message)
    if isinstance(message, HumanMessage):
        return _text_message("user", message)
    if isinstance(message, ToolMessage):
        return _tool_message(message)
    if isinstance(message, AIMessage):
        return _assistant_message(message)
    return None


def _arcelle_messages(messages: list[BaseMessage]) -> list[Message]:
    out: list[Message] = []
    for message in messages:
        item = _arcelle_message(message)
        if item is not None:
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

    def _generate(
        self, messages: list[BaseMessage], stop: list[str] | None = None, **kwargs: Any
    ) -> ChatResult:
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
    if decision := _base_harness_decision(req, small):
        return decision
    if decision := _provider_or_engine_decision(req, small):
        return decision
    return await _ollama_harness_decision(req, small)


def _base_harness_decision(req: RunRequest, small: bool) -> DeepHarnessDecision | None:
    if req.harness != "deep":
        return DeepHarnessDecision("deterministic", "The classic harness was requested.", small)
    if req.mcp is None:
        return DeepHarnessDecision(
            "deterministic", "No authenticated workspace bridge is available.", small
        )
    return None


def _provider_decision(supports_tools: bool, small: bool) -> DeepHarnessDecision:
    if supports_tools:
        return DeepHarnessDecision("deep", "The provider declares tool support.", small)
    return DeepHarnessDecision(
        "deterministic", "The provider does not support tool calling.", small
    )


def _provider_or_engine_decision(req: RunRequest, small: bool) -> DeepHarnessDecision | None:
    if req.provider is not None:
        return _provider_decision(req.provider.supports_tools, small)
    # Native Codex/Claude own their rich harnesses. Requests that reach this
    # compatibility endpoint stay on the proven deterministic adapter.
    if MODEL_SEPARATOR in req.model:
        return DeepHarnessDecision(
            "deterministic", "This engine uses its native or compatibility harness.", small
        )
    # A tool-capability bit says the API accepts tool schemas; it does not say a
    # small model can reliably complete a multi-step filesystem loop. Arcelle's
    # existing 4B protections are the deterministic specialist graph, which
    # narrows each round to the relevant workspace tools and verifies writes.
    # Keep that protection even when modern Ollama metadata advertises `tools`.
    if small:
        return DeepHarnessDecision(
            "deterministic",
            "Small Ollama models use Arcelle's deterministic workspace harness.",
            True,
        )
    return None


async def _ollama_harness_decision(req: RunRequest, small: bool) -> DeepHarnessDecision:
    caps = await ollama_capabilities(req.model, req.ollama_base_url)
    if "tools" not in {str(cap).casefold() for cap in caps}:
        location = "cloud" if is_nonlocal_model(req.model) else "local"
        return DeepHarnessDecision(
            "deterministic",
            f"The {location} Ollama model does not declare tool support.",
            small,
        )
    return DeepHarnessDecision("deep", "The Ollama model declares tool support.", small)


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
    image_input_available: bool = True,
    privacy_restricted: bool = False,
) -> dict[str, Any]:
    """Build a specialist state with no ambient network or connector access."""
    return {
        "question": question,
        "privacy_restricted": privacy_restricted,
        "image_input_available": image_input_available,
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
    image_input_available: bool = True
    privacy_restricted: bool = False

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
                image_input_available=self.image_input_available,
                privacy_restricted=self.privacy_restricted,
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
    image_input_available: bool = True,
    privacy_restricted: bool = False,
) -> Any:
    """Build the provider-neutral Deep Agent for Ollama/OpenRouter runs."""
    if deps.mcp is None:
        raise RuntimeError("Deep Harness needs the authenticated Arcelle MCP bridge.")
    backend = ArcelleWorkspaceBackend(
        McpWorkspaceBridge(deps.mcp),
        write_enabled=write_enabled,
        cancel=deps.cancel,
    )
    adapter = ArcelleCompiledSubAgentAdapter(
        deps,
        write_enabled,
        max_rounds,
        small_model,
        image_input_available,
        privacy_restricted,
    )
    subagents = [adapter.compile(spec.id) for spec in REGISTRY if spec.id != "chat.answer"]
    permissions = [
        FilesystemPermission(operations=["read"], paths=["/.arcelle/**"], mode="deny"),
        FilesystemPermission(
            operations=["write"], paths=["/**"], mode="allow" if write_enabled else "deny"
        ),
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
    image_input_available: bool = True,
    privacy_restricted: bool = False,
) -> str:
    """Run one Deep Harness turn while keeping Arcelle's existing event wire."""
    await deps.emit({"t": "step", "v": "Deep Harness started"})
    agent = build_deep_agent(
        deps,
        write_enabled=write_enabled,
        max_rounds=max_rounds,
        small_model=small_model,
        image_input_available=image_input_available,
        privacy_restricted=privacy_restricted,
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
