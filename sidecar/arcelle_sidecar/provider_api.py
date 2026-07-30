"""OpenAI-compatible API providers.

The host resolves credentials from macOS Keychain and passes them only in the
loopback request for the current call. This module never persists or logs them.
OpenRouter is the first provider; the config shape deliberately keeps the model
runtime generic so additional compatible providers can reuse this seam.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator, Optional

import httpx

from .chat import Cancellable, DeltaSink, RoundUsage
from .messages import Message, ToolCall, attach_images
from .privacy import PrivacyPolicy, guard_outbound

MODEL_SEPARATOR = ":" * 2

# Arcelle-owned tools are known-good OpenAI function schemas. If one connected
# third-party schema makes OpenRouter reject the catalog, retry with this set
# instead of deleting *all* tools (which previously made file writes impossible).
ARCELLE_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "list_room_files", "search_room", "open_file", "mark_image",
        "annotate_file", "create_file", "edit_file", "edit_files",
        "write_file", "set_cells", "rename_file", "move_file", "add_memory",
        "list_memories", "web_search", "fetch_page", "ui_snapshot", "ui_act",
        "view_screenshot", "view_media_frame", "start_file_pass", "job_status",
        "list_workflows", "save_workflow", "update_workflow", "delete_workflow",
        "run_workflow", "test_workflow", "list_skills", "read_skill",
        "read_skill_resource", "save_skill", "write_skill_resource",
        "delete_skill_resource", "delete_skill", "run_skill_script", "list_mcps",
        "read_mcp", "save_mcp", "delete_mcp", "search_mcp_tools",
        "run_mcp_tool", "local_generate", "consult_advisor",
    }
)
WRITE_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "create_file", "edit_file", "edit_files", "write_file", "set_cells",
        "rename_file", "move_file", "add_memory",
    }
)


class ProviderApiError(httpx.HTTPError):
    pass


def is_api_provider_model(model: str) -> bool:
    return model.split(MODEL_SEPARATOR, 1)[0] == "openrouter"


def _model_slug(model: str, configured: str) -> str:
    parts = model.split(MODEL_SEPARATOR, 2)
    return parts[1] if len(parts) > 1 and parts[1] else configured


def _messages_for_api(messages: list[Message], images: list[str] | None = None) -> list[dict[str, Any]]:
    source = attach_images(messages, images)
    out: list[dict[str, Any]] = []
    for message in source:
        role = str(message.get("role") or "user")
        item: dict[str, Any] = {"role": role}
        content = message.get("content", "") or ""
        inline_images = message.get("images") or []
        if role == "user" and inline_images:
            item["content"] = [{"type": "text", "text": content}] + [
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{image}"},
                }
                for image in inline_images
            ]
        else:
            item["content"] = content
        if role == "assistant" and message.get("tool_calls"):
            normalized_calls: list[dict[str, Any]] = []
            for call in message["tool_calls"]:
                normalized = dict(call)
                function = dict(normalized.get("function") or {})
                arguments = function.get("arguments", "{}")
                if not isinstance(arguments, str):
                    arguments = json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))
                function["arguments"] = arguments
                normalized["function"] = function
                normalized_calls.append(normalized)
            item["tool_calls"] = normalized_calls
        if role == "tool":
            item["tool_call_id"] = (
                message.get("tool_call_id") or message.get("tool_name") or "tool"
            )
            if message.get("tool_name"):
                item["name"] = message["tool_name"]
        out.append(item)
    return out


def _error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
        error = payload.get("error", {})
        if isinstance(error, dict) and error.get("message"):
            return str(error["message"])
        if isinstance(error, str):
            return error
    except (ValueError, TypeError):
        pass
    return f"provider returned HTTP {response.status_code}"


def _tool_name(spec: dict[str, Any]) -> str:
    return str((spec.get("function") or {}).get("name") or "")


def _arcelle_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [tool for tool in tools if _tool_name(tool) in ARCELLE_TOOL_NAMES]


def _merge_stream_piece(current: str, piece: Any) -> str:
    """Merge a streamed id/name fragment without duplicating repeated full values.

    OpenRouter normally sends a function name only once, but some routed
    OpenAI-compatible backends repeat it on later chunks. Blind concatenation
    turned ``write_file`` into ``write_filewrite_file`` and the bridge rejected it.
    """
    incoming = str(piece or "")
    if not incoming:
        return current
    if not current or incoming.startswith(current):
        return incoming
    if current.endswith(incoming):
        return current
    return current + incoming


class OpenAICompatibleChatModel:
    def __init__(
        self,
        model: str,
        provider: Any,
        temperature: float | None = None,
    ) -> None:
        self.composite_model = model
        self.provider = provider
        self.model = _model_slug(model, provider.model)
        self.temperature = temperature
        self.privacy: PrivacyPolicy | None = None

    @property
    def endpoint(self) -> str:
        return f"{self.provider.base_url.rstrip('/')}/chat/completions"

    @property
    def headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.provider.api_key}",
            "Content-Type": "application/json",
            "X-OpenRouter-Title": "Arcelle",
        }

    def _payload(
        self,
        messages: list[Message],
        *,
        tools: list[dict[str, Any]] | None = None,
        stream: bool = False,
        format: dict[str, Any] | None = None,  # noqa: A002
        images: list[str] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": _messages_for_api(messages, images),
            "stream": stream,
        }
        if stream:
            payload["stream_options"] = {"include_usage": True}
        if self.temperature is not None:
            payload["temperature"] = self.temperature
        if tools:
            if self.provider.supports_tools:
                payload["tools"] = tools
            elif any(_tool_name(tool) in WRITE_TOOL_NAMES for tool in tools):
                raise ProviderApiError(
                    "The selected OpenRouter model does not support tool calling, "
                    "so it cannot create or edit files. Choose a model with Tools capability."
                )
        if format is not None:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "arcelle_response",
                    "strict": True,
                    "schema": format,
                },
            }
        return payload

    async def _digest(self, text: str) -> str:
        """One compaction pass, as an ordinary (billed) completion."""
        from .compaction import DIGEST_PROMPT

        return await self.generate(
            [
                {"role": "system", "content": DIGEST_PROMPT},
                {"role": "user", "content": text},
            ]
        )

    async def _compact(
        self, messages: list[Message], tools: list[dict[str, Any]]
    ) -> list[Message]:
        """Compress the older half of a long conversation before it is billed.

        Budgeted off the provider's REAL catalog window, at the gentle cloud
        fraction — this is here to stop a runaway transcript being re-sent
        every round, not to ration a model that has room to spare. Unknown
        window means no budget and no change.
        """
        from .budget import json_chars
        from .compaction import (
            CLOUD_SPEND_FRACTION,
            compact_to_budget,
            digest_chunk_bytes,
            fit_budget_bytes,
        )

        window = self.provider.context_window
        reserved = json_chars(tools) if tools else 0
        out, _did = await compact_to_budget(
            messages,
            fit_budget_bytes(window, reserved, CLOUD_SPEND_FRACTION),
            self._digest,
            reserved,
            digest_chunk_bytes(window, cloud=True),
        )
        return out

    async def generate(
        self,
        messages: list[Message],
        *,
        format: dict[str, Any] | None = None,  # noqa: A002
        images: list[str] | None = None,
    ) -> str:
        payload = self._payload(messages, format=format, images=images)
        async with httpx.AsyncClient(timeout=600.0) as client:
            response = await client.post(self.endpoint, headers=self.headers, json=payload)
            # Not every OpenRouter model supports strict structured outputs. The
            # schema is already included in Arcelle's prompt, so retry once with
            # ordinary text generation when that optional parameter is rejected.
            if response.status_code == 400 and format is not None:
                payload.pop("response_format", None)
                response = await client.post(self.endpoint, headers=self.headers, json=payload)
        if not response.is_success:
            raise ProviderApiError(_error_message(response))
        data = response.json()
        choices = data.get("choices") or []
        if not choices:
            raise ProviderApiError("provider returned no completion")
        content = choices[0].get("message", {}).get("content", "")
        if isinstance(content, list):
            return "".join(
                str(block.get("text", ""))
                for block in content
                if isinstance(block, dict) and block.get("type") == "text"
            )
        return str(content or "")

    async def generate_stream(
        self,
        messages: list[Message],
        *,
        format: dict[str, Any] | None = None,  # noqa: A002
        images: list[str] | None = None,
    ) -> AsyncIterator[str]:
        payload = self._payload(messages, stream=True, format=format, images=images)
        async with httpx.AsyncClient(timeout=600.0) as client:
            async with client.stream(
                "POST", self.endpoint, headers=self.headers, json=payload
            ) as response:
                if not response.is_success:
                    await response.aread()
                    raise ProviderApiError(_error_message(response))
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == "[DONE]":
                        continue
                    event = json.loads(raw)
                    if event.get("error"):
                        error = event["error"]
                        raise ProviderApiError(
                            str(error.get("message") if isinstance(error, dict) else error)
                        )
                    for choice in event.get("choices") or []:
                        delta = choice.get("delta", {}).get("content")
                        if delta:
                            yield str(delta)

    async def stream(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]],
        on_delta: DeltaSink,
        cancel: Optional[Cancellable] = None,
    ) -> tuple[str, list[ToolCall], RoundUsage]:
        send, _, engaged = guard_outbound(self.composite_model, messages, self.privacy)
        send = await self._compact(send, tools)
        restorer = engaged.restorer() if engaged else None
        payload = self._payload(send, tools=tools, stream=True)
        parts: list[str] = []
        calls_by_index: dict[int, dict[str, Any]] = {}
        input_tokens: int | None = None
        output_tokens: int | None = None

        async with httpx.AsyncClient(timeout=600.0) as client:
            # Some upstream adapters reject one of the room's third-party MCP
            # JSON schemas even though the selected model supports tools. Keep
            # tool calling as the normal path, but on that pre-stream 400 retry
            # once without the rejected catalog so ordinary chat still works.
            # No delta or tool can have run before an HTTP error response.
            retried_with_arcelle_tools = False
            while True:
                async with client.stream(
                    "POST", self.endpoint, headers=self.headers, json=payload
                ) as response:
                    if (
                        response.status_code == 400
                        and payload.get("tools")
                        and not retried_with_arcelle_tools
                    ):
                        await response.aread()
                        original = payload["tools"]
                        builtins = _arcelle_tools(original)
                        if builtins and len(builtins) < len(original):
                            payload["tools"] = builtins
                            retried_with_arcelle_tools = True
                            continue
                    if not response.is_success:
                        await response.aread()
                        raise ProviderApiError(_error_message(response))
                    async for line in response.aiter_lines():
                        if cancel is not None and cancel.cancelled:
                            break
                        if not line.startswith("data:"):
                            continue
                        raw = line[5:].strip()
                        if not raw or raw == "[DONE]":
                            continue
                        event = json.loads(raw)
                        if event.get("error"):
                            error = event["error"]
                            raise ProviderApiError(
                                str(error.get("message") if isinstance(error, dict) else error)
                            )
                        usage = event.get("usage") or {}
                        input_tokens = usage.get("prompt_tokens", input_tokens)
                        output_tokens = usage.get("completion_tokens", output_tokens)
                        for choice in event.get("choices") or []:
                            delta = choice.get("delta") or {}
                            text = delta.get("content") or ""
                            if restorer is not None:
                                text = restorer.feed(str(text))
                            if text:
                                parts.append(str(text))
                                await on_delta(str(text))
                            for fragment in delta.get("tool_calls") or []:
                                raw_index = fragment.get("index")
                                index = raw_index if isinstance(raw_index, int) else 0
                                current = calls_by_index.setdefault(
                                    index, {"id": "", "name": "", "arguments": ""}
                                )
                                current["id"] = _merge_stream_piece(
                                    current["id"], fragment.get("id")
                                )
                                fn = fragment.get("function") or {}
                                current["name"] = _merge_stream_piece(
                                    current["name"], fn.get("name")
                                )
                                arguments = fn.get("arguments") or ""
                                if isinstance(arguments, str):
                                    current["arguments"] += arguments
                                else:
                                    current["arguments"] += json.dumps(
                                        arguments, ensure_ascii=False, separators=(",", ":")
                                    )
                    break

        if restorer is not None:
            tail = restorer.flush()
            if tail:
                parts.append(tail)
                await on_delta(tail)

        calls: list[ToolCall] = []
        for index in sorted(calls_by_index):
            raw_call = calls_by_index[index]
            if not raw_call["name"]:
                continue
            try:
                arguments = json.loads(raw_call["arguments"] or "{}")
            except ValueError:
                arguments = {}
            if engaged is not None:
                arguments = engaged.restore_value(arguments)
            call_id = raw_call["id"] or f"call_{index}"
            calls.append(
                ToolCall(
                    name=raw_call["name"],
                    arguments=arguments,
                    id=call_id,
                    raw={
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": raw_call["name"],
                            "arguments": raw_call["arguments"] or "{}",
                        },
                    },
                )
            )
        max_context = self.provider.context_window or 128_000
        return (
            "".join(parts),
            calls,
            RoundUsage(
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                max_context=max_context,
                is_real=input_tokens is not None,
            ),
        )


__all__ = [
    "OpenAICompatibleChatModel",
    "ProviderApiError",
    "is_api_provider_model",
]
