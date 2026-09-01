"""Per-round external-agent setup, validation, and result handling."""

from __future__ import annotations

import os
import secrets
import sys
import tempfile
from typing import TYPE_CHECKING, Any, Optional, cast

from .external_llm_cli import (
    parse_antigravity_json_stream,
    parse_claude_json_result,
    parse_codex_json_stream,
)
from .external_llm_codex import (
    _CODEX_NATIVE_TOOL_ALIASES,
    _bridge_tools,
    _codex_messages,
    _codex_tool,
    _hub_calls,
    _is_hub_only,
    _tool_name_of,
    mcp_config_json,
)
from .external_llm_messages import IMAGE_ENGINES, collect_images, message_images
from .external_llm_protocol import parse_tool_calls
from .external_llm_stream_events import _DeltaTap
from .hub_mcp import HubToolServer
from .messages import Message, ToolCall
from .prompts import IMAGE_HANDOFF

if TYPE_CHECKING:
    from .external_llm import ExternalChatModel


def _facade_module() -> Any:
    """Return the facade so its established monkeypatch seams remain live."""
    return sys.modules[f"{__package__}.external_llm"]


def _write_call_file(
    paths: list[str], prefix: str, suffix: str, contents: str
) -> str:
    """Create one per-call text file and register it for final cleanup."""
    fd, path = tempfile.mkstemp(prefix=prefix, suffix=suffix)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(contents)
    paths.append(path)
    return path


def _system_prompt_path(system: str, paths: list[str]) -> str | None:
    """Stage Claude's replacement system prompt only when there is one."""
    return _write_call_file(paths, "arcelle-sys-", ".txt", system) if system else None


def _uses_bridge_mcp(bridge_tools: list[str] | None, mcp_url: str) -> bool:
    """Whether this round exposes its room bridge to the CLI."""
    return bool(bridge_tools and mcp_url)


def _requires_mcp_config(
    bridge_tools: list[str] | None, mcp_url: str, hub: HubToolServer | None
) -> bool:
    """Whether either native tool endpoint needs an MCP configuration file."""
    return _uses_bridge_mcp(bridge_tools, mcp_url) or hub is not None


def _bridge_mcp_url(bridge_tools: list[str] | None, mcp_url: str) -> str:
    """Omit an unoffered bridge from a hub-only MCP configuration."""
    return mcp_url if bridge_tools else ""


def _hub_mcp_address(hub: HubToolServer | None) -> tuple[str, str] | None:
    """Make the optional captured-tool endpoint configuration explicit."""
    return (hub.url, hub.token) if hub is not None else None


def _mcp_config_path(
    bridge_tools: list[str] | None,
    mcp_url: str,
    mcp_token: str,
    hub: HubToolServer | None,
    paths: list[str],
) -> str | None:
    """Stage the native-tool configuration for the endpoints this round uses."""
    if not _requires_mcp_config(bridge_tools, mcp_url, hub):
        return None
    return _write_call_file(
        paths,
        "arcelle-mcp-",
        ".json",
        mcp_config_json(
            _bridge_mcp_url(bridge_tools, mcp_url),
            mcp_token,
            hub=_hub_mcp_address(hub),
        ),
    )


def _codex_image_paths(engine: str, images: list[str] | None) -> list[str]:
    """Stage image files only for Codex's file-attachment input channel."""
    if engine != "codex-cli" or not images:
        return []
    return _facade_module()._stage_image_files(images)


def _codex_images_are_ready(
    engine: str, images: list[str] | None, image_paths: list[str]
) -> bool:
    """Confirm Codex received an attachment for every image it must stage."""
    return engine != "codex-cli" or not images or len(image_paths) == len(images)


def _codex_hub_address(
    engine: str, hub: HubToolServer | None
) -> tuple[str, str] | None:
    """Codex receives the hub endpoint directly instead of through Claude MCP."""
    return (hub.url, hub.token) if engine == "codex-cli" and hub is not None else None


def _remove_call_paths(paths: list[str]) -> None:
    """Delete every ephemeral prompt, MCP config, and decrypted image file."""
    for path in paths:
        try:
            os.unlink(path)
        except OSError:  # pragma: no cover - best-effort cleanup
            pass


def _latest_user_message(messages: list[Message]) -> Message | None:
    """Return the final user turn, which owns the current image obligation."""
    for message in reversed(messages):
        if message.get("role") == "user":
            return message
    return None


def _is_image_handoff(message: Message | None) -> bool:
    """Whether one user turn requests interpretation of a captured frame."""
    return bool(
        message is not None
        and str(message.get("content") or "").strip() == IMAGE_HANDOFF
    )


def _validate_frame_request(engine: str, latest_user: Message | None) -> bool:
    """Reject an undeliverable newest frame before starting an external CLI."""
    handoff = _is_image_handoff(latest_user)
    if handoff and not message_images(cast(Message, latest_user)):
        from .llm import LlmError

        raise LlmError(
            "ENGINE_ERROR",
            "The perception tool returned metadata but no valid image pixels, "
            "so visual interpretation stopped before model dispatch.",
        )
    if handoff and engine not in IMAGE_ENGINES:
        from .llm import LlmError

        raise LlmError(
            "ENGINE_ERROR",
            f"{engine} has no image input channel; the captured image "
            "was not dispatched.",
        )
    return handoff


async def _guarded_compacted_messages(
    model: ExternalChatModel,
    messages: list[Message],
    tools: list[dict[str, Any]],
    cancel: Optional[Any],
) -> tuple[list[Message], Any]:
    """Redact and compact one round before its engine-specific preparation."""
    from .privacy import guard_outbound

    send, _, engaged = guard_outbound(model.composite_model, messages, model.privacy)
    return await model._compact(send, tools, model._stated_context, cancel), engaged


def _stream_images(engine: str, messages: list[Message]) -> list[str]:
    """Collect pixels only when this engine has a real image input channel."""
    return collect_images(messages) if engine in IMAGE_ENGINES else []


def _delivered_frame_images(messages: list[Message]) -> list[str]:
    """Read pixels from the newest delivered handoff, not historical frames."""
    latest_user = _latest_user_message(messages)
    return message_images(cast(Message, latest_user)) if _is_image_handoff(latest_user) else []


def _validate_delivered_frame(handoff: bool, images: list[str]) -> None:
    """Stop when privacy or compaction removed a frame the newest turn needs."""
    if handoff and not images:
        from .llm import LlmError

        raise LlmError(
            "ENGINE_ERROR",
            "The captured image's pixels were withheld by Cloud Privacy, so "
            "visual interpretation stopped before model dispatch. Switch "
            "to On this Mac or explicitly allow image sharing.",
        )


def _stream_tap(engine: str, on_delta: Any, engaged: Any) -> _DeltaTap:
    """Create the live feed with the privacy restorer for this one round."""
    return _DeltaTap(engine, on_delta, engaged.restorer() if engaged is not None else None)


def _codex_tool_aliases(
    engine: str, tools: list[dict[str, Any]]
) -> dict[str, str]:
    """Name the room's tools safely inside Codex's own agent harness."""
    if engine != "codex-cli":
        return {}
    aliases: dict[str, str] = {}
    for tool in tools:
        name = _tool_name_of(tool)
        if name:
            aliases[name] = _CODEX_NATIVE_TOOL_ALIASES.get(name, f"arcelle_{name}")
    return aliases


def _rendered_stream_messages(
    engine: str, messages: list[Message], aliases: dict[str, str]
) -> list[Message]:
    """Replace Codex's conflicting harness names without touching other engines."""
    return _codex_messages(messages, aliases) if engine == "codex-cli" else messages


def _native_bridge_tools(
    takes_system_prompt: bool, mcp_url: str, tools: list[dict[str, Any]]
) -> list[str]:
    """Expose room tools natively only on Claude rounds with a bridge URL."""
    return _bridge_tools(tools) if takes_system_prompt and mcp_url else []


def _hub_source_tools(engine: str, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Choose the original tool specs that must be captured by the hub endpoint."""
    if engine == "claude-cli":
        return [tool for tool in tools if _is_hub_only(_tool_name_of(tool))]
    if engine == "codex-cli":
        return list(tools)
    return []


def _hub_tools(
    engine: str, source_tools: list[dict[str, Any]], aliases: dict[str, str]
) -> list[dict[str, Any]]:
    """Apply Codex-only aliases to the tool specs the hub serves."""
    if engine != "codex-cli":
        return source_tools
    return [_codex_tool(tool, aliases) for tool in source_tools]


def _hub_tool_names(tools: list[dict[str, Any]]) -> list[str]:
    """List the exact tool names mounted on a round's capture endpoint."""
    return [_tool_name_of(tool) for tool in tools]


def _protocol_tools(
    tools: list[dict[str, Any]], native: list[str], hub_source_tools: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Keep only tools unavailable on either native endpoint in the text protocol."""
    served = set(native)
    served.update(_tool_name_of(tool) for tool in hub_source_tools)
    return [tool for tool in tools if _tool_name_of(tool) not in served]


def _open_hub(
    tools: list[dict[str, Any]], names: list[str]
) -> HubToolServer | None:
    """Start the per-round capture endpoint only when it serves tools."""
    return HubToolServer(tools, secrets.token_urlsafe(24)) if names else None


def _captured_hub_calls(
    hub: HubToolServer | None,
) -> list[tuple[str, dict[str, Any]]]:
    """Copy calls before closing the per-round capture endpoint."""
    return list(hub.calls) if hub is not None else []


def _close_hub(hub: HubToolServer | None) -> None:
    """Release the optional per-round capture endpoint."""
    if hub is not None:
        hub.close()


def _should_retry_empty_antigravity(
    engine: str, stdout: str, cancel: Optional[Any]
) -> bool:
    """Whether Antigravity's empty successful envelope gets its one retry."""
    return (
        engine == "antigravity-cli"
        and not parse_antigravity_json_stream(stdout)[0].strip()
        and not _facade_module()._stopped(cancel)
    )


def _require_antigravity_output(stdout: str) -> None:
    """Make a second empty successful Antigravity response an adapter error."""
    if not parse_antigravity_json_stream(stdout)[0].strip():
        from .llm import LlmError

        raise LlmError(
            "ENGINE_ERROR",
            "antigravity-cli failed after 2 attempts: no output (exit status 0).",
        )


def _parse_stream_response(engine: str, stdout: str) -> tuple[str, int | None, int | None]:
    """Parse the terminal envelope from the CLI that produced this round."""
    if engine == "claude-cli":
        return parse_claude_json_result(stdout)
    if engine == "antigravity-cli":
        return parse_antigravity_json_stream(stdout)
    return parse_codex_json_stream(stdout)


def _reverse_codex_aliases(engine: str, aliases: dict[str, str]) -> dict[str, str]:
    """Translate a Codex hub call back to the public room tool name."""
    return {alias: name for name, alias in aliases.items()} if engine == "codex-cli" else {}


def _stream_calls(
    captured: list[tuple[str, dict[str, Any]]],
    aliases: dict[str, str],
    engine: str,
    text: str,
    tools: list[dict[str, Any]],
) -> list[ToolCall]:
    """Prefer real endpoint calls, then parse the retained text protocol."""
    calls = _hub_calls(captured, _reverse_codex_aliases(engine, aliases) or None)
    if calls:
        return calls
    if not tools:
        return []
    offered = {_tool_name_of(tool) for tool in tools} - {""}
    return parse_tool_calls(text, offered)


def _restore_tool_call_arguments(calls: list[ToolCall], engaged: Any) -> None:
    """Restore privacy placeholders in tool arguments and their raw echoes."""
    if engaged is None:
        return
    for call in calls:
        call.arguments = engaged.restore_value(call.arguments)
        function = call.raw.get("function")
        if isinstance(function, dict):
            function["arguments"] = call.arguments


def _restored_answer_text(text: str, engaged: Any) -> str:
    """Restore the buffered answer through the privacy door when engaged."""
    return engaged.restore_text(text) if engaged is not None else text
