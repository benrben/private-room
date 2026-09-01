"""OpenAI-compatible API providers.

The host resolves credentials from macOS Keychain and passes them only in the
loopback request for the current call. This module never persists or logs them.
OpenRouter is the first provider; the config shape deliberately keeps the model
runtime generic so additional compatible providers can reuse this seam.
"""

from __future__ import annotations

from typing import Any, AsyncIterator, Optional

import httpx

from .chat import Cancellable, DeltaSink, RoundUsage
from .messages import Message, ToolCall
from .privacy import PrivacyPolicy, guard_outbound
from .provider_core import (
    API_PROVIDER_IDS as API_PROVIDER_IDS,
    DEFAULT_PROVIDER_CONTEXT as DEFAULT_PROVIDER_CONTEXT,
    MODEL_SEPARATOR as MODEL_SEPARATOR,
    PROVIDER_TIMEOUT_ENV as PROVIDER_TIMEOUT_ENV,
    PROVIDER_TIMEOUT_SECS as PROVIDER_TIMEOUT_SECS,
    ProviderApiError as ProviderApiError,
    _model_slug,
    _stall_as_error as _stall_as_error,
    is_api_provider_model as is_api_provider_model,
    provider_timeout_secs as provider_timeout_secs,
)
from .provider_errors import (
    MAX_ERROR_DETAIL_CHARS as MAX_ERROR_DETAIL_CHARS,
    _describe_error as _describe_error,
    _error_message as _error_message,
    _message_skeleton as _message_skeleton,
    _upstream_reason as _upstream_reason,
)
from .provider_messages import (
    UNANSWERED_TOOL_NOTE as UNANSWERED_TOOL_NOTE,
    _pop_pending_call_id as _pop_pending_call_id,
    _messages_for_api as _messages_for_api,
)
from .provider_stream import (
    _completion_content,
    _completion_data,
    _consume_stream_response,
    _finished_stream_calls,
    _merge_stream_piece as _merge_stream_piece,
    _post_completion,
    _sse_events,
)

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

    def _require_image_input(
        self, messages: list[Message], images: list[str] | None
    ) -> None:
        """Refuse pixels when the provider catalog explicitly says blind.

        OpenAI-compatible transport *can* carry images as ``image_url`` data
        URLs, but that does not make every routed model multimodal. Previously
        the adapter sent the frame anyway and waited for an upstream 400 (or a
        text-only model ignoring it). ``None`` is the deliberate old-host
        compatibility state; only an explicit catalog ``False`` fails closed.
        """
        if getattr(self.provider, "supports_vision", None) is not False:
            return
        if not images and not any(message.get("images") for message in messages):
            return
        raise ProviderApiError(
            "The selected OpenRouter model does not support image input, so it "
            "cannot inspect the captured frame. Choose a model with Vision "
            "capability or switch to On this Mac."
        )

    def _payload(
        self,
        messages: list[Message],
        *,
        tools: list[dict[str, Any]] | None = None,
        stream: bool = False,
        format: dict[str, Any] | None = None,  # noqa: A002
        images: list[str] | None = None,
    ) -> dict[str, Any]:
        self._require_image_input(messages, images)
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
            if not self.provider.supports_tools:
                # Dropping the catalog and answering anyway was the quiet
                # failure: the model has no reach into the room — it cannot read
                # a file, search, or change anything — and it says so nowhere,
                # so a confident answer from memory reads as an answer about the
                # room. Refusing names the cause, and the tool-less paths
                # (summaries, AI actions) pass no tools and are unaffected.
                raise ProviderApiError(
                    "The selected OpenRouter model does not support tool calling, "
                    "so it cannot use this room's tools — reading your files, "
                    "searching, or making changes. Choose a model with Tools capability."
                )
            payload["tools"] = tools
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

        # A model whose catalog entry carries no window still gets a budget:
        # "unknown" used to mean "unbounded", which is how one oversized tool
        # result reached the provider and failed the whole turn.
        window = self.provider.context_window or DEFAULT_PROVIDER_CONTEXT
        reserved = json_chars(tools) if tools else 0
        out, _did = await compact_to_budget(
            messages,
            fit_budget_bytes(window, reserved, CLOUD_SPEND_FRACTION),
            self._digest,
            reserved,
            digest_chunk_bytes(window, cloud=True),
        )
        return out

    def _fit_one_shot(
        self,
        messages: list[Message],
        format: dict[str, Any] | None,  # noqa: A002
        images: list[str] | None,
    ) -> list[Message]:
        """Cut a one-shot request down to this provider's stated window.

        The local twin (:meth:`chat.ChatModel.generate`) has always cut here
        with ``fit_to_window``; the gateway sent every one of these calls —
        ``/handoff_summary``, ``/generate``, ``/file_pass_section``,
        ``/ai_action``, ``/knowledge_extract`` — completely unbounded, so a
        conversation a local room trims with a visible marker came back from an
        OpenRouter room as a bare provider 400 the UI could only repeat.

        No compaction on this path: it is a single billed call with no digest
        cache behind it, and :func:`budget.fit_oversized_results` cuts the
        oversized RESULT first and leaves a marker where it cut. The grammar
        and any top-level images ride the same window and cannot be cut, so
        they are reserved rather than trimmed.
        """
        from .budget import IMAGE_BYTES, fit_oversized_results, json_chars
        from .compaction import CLOUD_SPEND_FRACTION, fit_budget_bytes

        reserved = (json_chars(format) if format else 0) + IMAGE_BYTES * len(images or [])
        window = self.provider.context_window or DEFAULT_PROVIDER_CONTEXT
        send, _did = fit_oversized_results(
            messages,
            fit_budget_bytes(window, reserved, CLOUD_SPEND_FRACTION),
            reserved,
        )
        return send

    async def generate(
        self,
        messages: list[Message],
        *,
        format: dict[str, Any] | None = None,  # noqa: A002
        images: list[str] | None = None,
    ) -> str:
        send = self._fit_one_shot(messages, format, images)
        payload = self._payload(send, format=format, images=images)
        async with httpx.AsyncClient(timeout=provider_timeout_secs()) as client:
            response = await _post_completion(
                client, self.endpoint, self.headers, payload, format
            )
        return _completion_content(_completion_data(response))

    async def generate_stream(
        self,
        messages: list[Message],
        *,
        format: dict[str, Any] | None = None,  # noqa: A002
        images: list[str] | None = None,
    ) -> AsyncIterator[str]:
        send = self._fit_one_shot(messages, format, images)
        payload = self._payload(send, stream=True, format=format, images=images)
        async with httpx.AsyncClient(timeout=provider_timeout_secs()) as client:
            async with client.stream(
                "POST", self.endpoint, headers=self.headers, json=payload
            ) as response:
                if not response.is_success:
                    await response.aread()
                    raise ProviderApiError(_error_message(response))
                async for event in _sse_events(response):
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

        async with httpx.AsyncClient(timeout=provider_timeout_secs()) as client:
            async with client.stream(
                "POST", self.endpoint, headers=self.headers, json=payload
            ) as response:
                input_tokens = await _consume_stream_response(
                    response,
                    payload,
                    cancel,
                    self.composite_model,
                    parts,
                    calls_by_index,
                    restorer,
                    on_delta,
                )

        if restorer is not None:
            tail = restorer.flush()
            if tail:
                parts.append(tail)
                await on_delta(tail)

        calls = _finished_stream_calls(calls_by_index, engaged)
        max_context = self.provider.context_window or DEFAULT_PROVIDER_CONTEXT
        return (
            "".join(parts),
            calls,
            RoundUsage(
                input_tokens=input_tokens,
                max_context=max_context,
                is_real=input_tokens is not None,
            ),
        )


__all__ = [
    "API_PROVIDER_IDS",
    "OpenAICompatibleChatModel",
    "PROVIDER_TIMEOUT_SECS",
    "ProviderApiError",
    "is_api_provider_model",
    "provider_timeout_secs",
]
