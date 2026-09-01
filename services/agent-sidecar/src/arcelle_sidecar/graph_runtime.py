"""Shared imports and stable constants for graph implementation shards."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import sys
import weakref
from dataclasses import dataclass, field, replace
from typing import Any, Awaitable, Callable, NamedTuple, TypedDict

from langchain_core.runnables import RunnableConfig

from .agents import (
    AGENT_TOOL_NAMES,
    ALL_REGISTRY_TOOLS,
    BATCH_TOOL_NAME,
    CORE_TOOLS,
    DOMAIN_KEYS,
    GROUPS,
    MAIN_AGENT_ID,
    AgentSpec,
    agent_tool_specs,
    get_agent,
    group_prompt,
    group_servable,
    group_tools,
    main_prompt,
    normalize_domain_key,
    reachable_domain_keys,
    specialist_workers,
    tagged_specialist,
    toolbox_for,
    worker_reachable,
)
from .budget import byte_len, json_chars
from .chat import ChatModel
from .config import AGENT_ROUND_BACKSTOP, NO_PROGRESS_ROUNDS, RunRequest
from .labels import tool_step_label
from .manager import resolve_worker
from .mcp_client import McpClient, ToolResult
from .messages import Message, ToolCall, assistant_message, tool_message, user_message
from .planner import build_plan, is_static_visual_intent, is_visual_video_intent
from .privacy import cloud_privacy_tool_allowed, is_nonlocal_model
from .prompts import (
    DIRECT_SPECIALIST_NOTE,
    DONE_TEXT,
    EMPTY_PLAN_NOTE,
    IMAGE_HANDOFF,
    READ_RESULT_TOOL,
    SKILLS_NOTE,
    TOOL_GROUP_LABELS,
    TOOL_GROUPS_PROMPT,
    correction_note,
    delegation_note,
    duplicate_call_note,
    request_tools_spec,
    spill_note,
    tag_unavailable_answer,
    turn_progress_note,
    unlocked_note,
    with_read_result,
)
from .results import SPILL_BYTES, ResultStore, read_spill
from .routing import ADVISOR_TOOL_NAMES, lane_label
from .usage import build_usage_event, categorize_messages

_log = logging.getLogger("arcelle_sidecar.graph")
Event = dict[str, Any]
Emit = Callable[[Event], Awaitable[None]]
MAIN_NODE_KEY = "main"
PIXEL_RESULT_TOOLS = frozenset(
    {"view_media_frame", "view_screenshot", "view_file_image", "read_drawing", "browse_look"}
)


def facade() -> Any:
    """Return the public graph module so monkeypatch seams remain live."""
    return sys.modules[f"{__package__}.graph"]


__all__ = ['ADVISOR_TOOL_NAMES', 'AGENT_ROUND_BACKSTOP', 'AGENT_TOOL_NAMES', 'ALL_REGISTRY_TOOLS', 'AgentSpec', 'Any', 'Awaitable', 'BATCH_TOOL_NAME', 'CORE_TOOLS', 'Callable', 'ChatModel', 'DIRECT_SPECIALIST_NOTE', 'DOMAIN_KEYS', 'DONE_TEXT', 'EMPTY_PLAN_NOTE', 'Emit', 'Event', 'GROUPS', 'IMAGE_HANDOFF', 'MAIN_AGENT_ID', 'MAIN_NODE_KEY', 'McpClient', 'Message', 'NO_PROGRESS_ROUNDS', 'NamedTuple', 'PIXEL_RESULT_TOOLS', 'READ_RESULT_TOOL', 'ResultStore', 'RunRequest', 'RunnableConfig', 'SKILLS_NOTE', 'SPILL_BYTES', 'TOOL_GROUPS_PROMPT', 'TOOL_GROUP_LABELS', 'ToolCall', 'ToolResult', 'TypedDict', '_log', 'agent_tool_specs', 'assistant_message', 'asyncio', 'build_plan', 'build_usage_event', 'byte_len', 'categorize_messages', 'cloud_privacy_tool_allowed', 'correction_note', 'dataclass', 'delegation_note', 'duplicate_call_note', 'field', 'get_agent', 'group_prompt', 'group_servable', 'group_tools', 'is_nonlocal_model', 'is_static_visual_intent', 'is_visual_video_intent', 'json', 'json_chars', 'lane_label', 'logging', 'main_prompt', 'normalize_domain_key', 're', 'reachable_domain_keys', 'read_spill', 'replace', 'request_tools_spec', 'resolve_worker', 'specialist_workers', 'spill_note', 'sys', 'tag_unavailable_answer', 'tagged_specialist', 'tool_message', 'tool_step_label', 'toolbox_for', 'turn_progress_note', 'unlocked_note', 'user_message', 'weakref', 'with_read_result', 'worker_reachable']
