"""OpenAI-compatible API providers.

The host resolves credentials from macOS Keychain and passes them only in the
loopback request for the current call. This module never persists or logs them.
OpenRouter is the first provider; the config shape deliberately keeps the model
runtime generic so additional compatible providers can reuse this seam.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, AsyncIterator, Optional

import httpx

from .chat import Cancellable, DeltaSink, RoundUsage, StreamStalled, iter_with_stop
from .messages import Message, ToolCall, attach_images
from .privacy import PrivacyPolicy, guard_outbound

MODEL_SEPARATOR = ":" * 2

#: The engine ids this module serves — the API half of "content leaves the Mac"
#: (the CLI half is :data:`external_llm.EXTERNAL_ENGINES`, and
#: :func:`privacy.is_nonlocal_model` is the union). Ask
#: :func:`is_api_provider_model` rather than re-typing the id anywhere else.
API_PROVIDER_IDS: frozenset[str] = frozenset({"openrouter"})

# WHY THERE IS NO LONGER AN "ARCELLE TOOLS" ALLOWLIST HERE
#
# There used to be a hardcoded frozenset of 44 tool names, and a 400 from the
# provider narrowed the catalog to it — the idea being that one connected
# THIRD-PARTY schema had made the provider reject the request, so retrying with
# only Arcelle's own tools was better than dropping every tool.
#
# The premise was false and the list was stale, and together they broke whole
# agents:
#
#   * No third-party schema ever reaches this payload. Connected MCP servers are
#     served through the two proxy tools `search_mcp_tools` / `run_mcp_tool` —
#     `room_mcp.rs::served_tools` says so explicitly ("Individual third-party
#     schemas are returned on demand by the search tool instead of flooding every
#     model request"). Every entry in `tools` is authored by us.
#   * The list had not been updated in a long time. 19 of the room's 62 tools
#     were missing from it, including ALL SEVEN `browse_*` tools and the three
#     download tools — the Browser agent's entire catalog — plus update/delete
#     memory, the script tools, retranscribe, and the studio generators.
#
# So the retry could only do harm. For the Browser agent (and for the Main
# agent, whose tools are all `ask_*_agent`) NOTHING matched the list, `builtins`
# came back empty, the guard below skipped the retry, and the 400 surfaced as a
# bare provider error — the Browser agent failing on OpenRouter "always", with
# no explanation. For a file or memory agent it was worse than an error: the
# retry silently amputated the tools it did not recognise and the model carried
# on with a smaller catalog it was never told about.
#
# A tool-related 400 now raises with the provider's own reason attached (see
# `_describe_error`), which is information the user can act on — choosing a
# different model — rather than a mystery with a mutilated catalog behind it.

#: Ceiling on one provider call, in seconds. A cloud model that is genuinely
#: thinking for a long time must not be cut off and reported as a failure, so
#: this is generous — and overridable for the rare answer that needs longer.
PROVIDER_TIMEOUT_SECS: float = 600.0

#: The environment override for :data:`PROVIDER_TIMEOUT_SECS` (seconds).
PROVIDER_TIMEOUT_ENV = "ARCELLE_PROVIDER_TIMEOUT_SECS"


#: What to assume a provider's context window is when its catalog says nothing.
#:
#: "Unknown window means no budget and no change" was the rule on the FITTING
#: path, and it is the one hole every other guard here was built to close: with
#: no budget, `compact_to_budget` returns immediately and `fit_oversized_results`
#: never runs, so a single heavy tool result — a `browse_read` of an ad-laden
#: search page, a `fetch_page` of a big site — reached the provider intact and
#: came back as a bare provider error, which the UI could only repeat.
#:
#: The token bar has always assumed this same number for the same unknown (see
#: `max_context` below), so the two now agree. A default can still be wrong for
#: a model with a genuinely smaller window, but being wrong is strictly better
#: than the previous behaviour of imposing no limit whatsoever.
DEFAULT_PROVIDER_CONTEXT = 128_000

_log = logging.getLogger(__name__)


class ProviderApiError(httpx.HTTPError):
    pass


def provider_timeout_secs() -> float:
    """The give-up time for one provider call.

    Read per call so the module default can be overridden without a rebuild;
    a missing, unparseable or non-positive value keeps the default.
    """
    raw = os.environ.get(PROVIDER_TIMEOUT_ENV, "")
    try:
        override = float(raw)
    except ValueError:
        return PROVIDER_TIMEOUT_SECS
    return override if override > 0 else PROVIDER_TIMEOUT_SECS


async def _stall_as_error(
    events: AsyncIterator[dict[str, Any]], model: str
) -> AsyncIterator[dict[str, Any]]:
    """Re-raise :class:`chat.StreamStalled` as this module's error type.

    Wrapping the generator, rather than the deeply nested ``async for`` that
    drains it, keeps the conversion one line from where the stream is built.
    """
    try:
        async for event in events:
            yield event
    except StreamStalled as exc:
        raise ProviderApiError(
            f"{model} sent nothing for {provider_timeout_secs():g}s and was stopped."
        ) from exc


def is_api_provider_model(model: str) -> bool:
    return model.split(MODEL_SEPARATOR, 1)[0] in API_PROVIDER_IDS


def _model_slug(model: str, configured: str) -> str:
    parts = model.split(MODEL_SEPARATOR, 2)
    return parts[1] if len(parts) > 1 and parts[1] else configured


def _pop_pending_call_id(pending: list[tuple[str, str]], name: str) -> str:
    """The id of the outstanding tool call this result answers, or "".

    An OpenAI-compatible provider matches a ``role: "tool"`` message to the
    assistant turn that requested it by ``tool_call_id`` and NOTHING else, so a
    caller that only records the tool's NAME (summarize.py's read_text loop) used
    to send ``tool_call_id: "read_text"`` and have the whole request rejected —
    the file's one-line summary failed, but only on long files, where the model
    asks to read more. The ids are right here in the transcript, so pair them up:
    first outstanding call of that name, else the oldest outstanding call.
    """
    for i, (_id, call_name) in enumerate(pending):
        if call_name == name:
            return pending.pop(i)[0]
    return pending.pop(0)[0] if pending else ""


#: Stands in for a tool result that never arrived. Phrased as something the
#: model can act on — it explains the gap instead of leaving it to guess why a
#: tool it called has said nothing.
UNANSWERED_TOOL_NOTE = "(no result — the assistant stopped before this tool ran)"


def _answer_every_tool_call(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Give every declared tool call the reply the protocol requires.

    An OpenAI-compatible provider rejects the WHOLE request when an assistant
    turn declares `tool_calls` and any one of them is not followed by a matching
    `role: "tool"` message. Azure words it "No tool output found for function
    call <id>", and it arrives as a plain 400 — so the turn dies for a reason
    with no visible relation to what the user asked, after the real work is
    already done. Observed live on 2026-08-02: the Browser agent opened the page
    and read its controls, then the next round 400'd.

    The graph leaves one behind legitimately. `_Round.run` walks a round's calls
    one at a time and BREAKS out of the loop when Stop is pressed or a delegated
    child is cancelled; the call it broke on is answered, but every call after it
    in the same assistant turn is declared and never answered. Rather than teach
    each of those exits to backfill, this — the one place that sees the finished
    conversation on its way out — makes the invariant true for all of them.
    """
    out: list[dict[str, Any]] = []
    index = 0
    while index < len(messages):
        item = messages[index]
        out.append(item)
        index += 1
        calls = item.get("tool_calls") if item.get("role") == "assistant" else None
        if not calls:
            continue
        # Declared ids in order, deduped: a provider that mints colliding ids is
        # already broken, and emitting two fillers for one id would not help.
        declared: list[tuple[str, str]] = []
        for call in calls:
            call_id = str(call.get("id") or "")
            name = str((call.get("function") or {}).get("name") or "")
            if call_id and call_id not in {seen for seen, _ in declared}:
                declared.append((call_id, name))
        answered: set[str] = set()
        while index < len(messages) and messages[index].get("role") == "tool":
            answered.add(str(messages[index].get("tool_call_id") or ""))
            out.append(messages[index])
            index += 1
        for call_id, name in declared:
            if call_id in answered:
                continue
            filler: dict[str, Any] = {
                "role": "tool",
                "tool_call_id": call_id,
                "content": UNANSWERED_TOOL_NOTE,
            }
            if name:
                filler["name"] = name
            out.append(filler)
    return out


def _synthetic_call_id(turn: int, index: int) -> str:
    """A stable id for a tool call that arrived without one.

    The graph fires DETERMINISTIC tool calls of its own — `probe` and `perceive`
    build a `ToolCall` directly instead of reading one off the model — and those
    carry no id, because Ollama never needed one: it pairs a result to its call
    positionally. An OpenAI-compatible provider pairs by `tool_call_id` and
    NOTHING else, so an anonymous call is unanswerable by construction and the
    whole request is rejected.

    Observed live 2026-08-02 on the Browser agent: round one paired fine, round
    two was the browse flow's own `browse_snapshot` probe and went out as
    `assistant[calls:-]` followed by `tool[for:browse_snapshot]` — the tool NAME
    standing in for an id. Azure answered "No tool output found for function
    call call_7_0", naming the index IT had assigned to the call we left
    anonymous, which is why the number moved with the conversation length and
    matched nothing anyone could search for.

    Derived from position rather than a counter or a random value so the same
    conversation always produces the same ids — a request that gets retried, or
    re-fitted after compaction, must not change shape underneath the provider.
    """
    return f"call_auto_{turn}_{index}"


def _messages_for_api(messages: list[Message], images: list[str] | None = None) -> list[dict[str, Any]]:
    source = attach_images(messages, images)
    out: list[dict[str, Any]] = []
    pending: list[tuple[str, str]] = []
    for turn, message in enumerate(source):
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
            for index, call in enumerate(message["tool_calls"]):
                normalized = dict(call)
                function = dict(normalized.get("function") or {})
                arguments = function.get("arguments", "{}")
                if not isinstance(arguments, str):
                    arguments = json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))
                function["arguments"] = arguments
                normalized["function"] = function
                # An anonymous call cannot be answered — see `_synthetic_call_id`.
                # Minted HERE rather than left to the tool message to guess, so
                # both halves of the pair agree: the id goes into `pending`, and
                # `_pop_pending_call_id` hands the same one to the result below.
                call_id = str(normalized.get("id") or "") or _synthetic_call_id(turn, index)
                normalized["id"] = call_id
                normalized_calls.append(normalized)
                pending.append((call_id, str(function.get("name") or "")))
            item["tool_calls"] = normalized_calls
        if role == "tool":
            name = str(message.get("tool_name") or "")
            given = str(message.get("tool_call_id") or "")
            if given:
                pending[:] = [call for call in pending if call[0] != given]
            item["tool_call_id"] = (
                given or _pop_pending_call_id(pending, name) or name or "tool"
            )
            if name:
                item["name"] = name
        out.append(item)
    return _answer_every_tool_call(out)


#: How much of an upstream provider's own error text to keep. Long enough for a
#: real reason (a rate-limit notice, a rejected parameter, a content-policy
#: verdict), short enough that the failure box stays readable.
MAX_ERROR_DETAIL_CHARS = 600


def _upstream_reason(metadata: Any) -> str:
    """The upstream provider's OWN words, dug out of an OpenRouter envelope.

    When a routed backend fails, OpenRouter replaces its message with the fixed
    string "Provider returned error" and files the real cause under
    ``metadata`` — ``raw`` (usually the backend's whole JSON error, as a string)
    and ``provider_name``. Keeping only ``message`` therefore produced a failure
    box that said nothing at all: the one sentence shown to the user was the one
    sentence guaranteed to carry no information.

    ``raw`` is unwrapped one level when it parses as a provider error envelope,
    so the reader gets "Rate limit reached for gpt-4o" rather than a JSON blob.
    """
    if not isinstance(metadata, dict):
        return ""
    raw = metadata.get("raw")
    if isinstance(raw, (dict, list)):
        raw = json.dumps(raw)
    if isinstance(raw, str) and raw.strip():
        text = raw.strip()
        try:
            inner = json.loads(text)
        except ValueError:
            return text
        if isinstance(inner, dict):
            error = inner.get("error")
            if isinstance(error, dict) and error.get("message"):
                return str(error["message"])
            if isinstance(error, str) and error.strip():
                return error.strip()
            if inner.get("message"):
                return str(inner["message"])
        return text
    # Moderation refusals carry no `raw` — the categories are the whole reason.
    reasons = metadata.get("reasons")
    if isinstance(reasons, list) and reasons:
        return "flagged as " + ", ".join(str(reason) for reason in reasons)
    return ""


def _describe_error(error: Any, status: int | None = None) -> str:
    """One line naming what actually went wrong, for a human reading a failure.

    Assembled as ``message (HTTP code) — Provider said: reason`` so the useful
    part survives even when only some of it is present.
    """
    metadata: Any = None
    code: Any = None
    if isinstance(error, dict):
        head = str(error.get("message") or "").strip()
        metadata = error.get("metadata")
        code = error.get("code")
    else:
        head = str(error or "").strip()

    tag = code if code not in (None, "") else status
    if tag not in (None, "") and str(tag) not in head:
        head = f"{head} (HTTP {tag})" if head else f"provider returned HTTP {tag}"

    provider = ""
    if isinstance(metadata, dict):
        provider = str(metadata.get("provider_name") or "").strip()
    reason = _upstream_reason(metadata)
    if reason:
        said = f"{provider} said: {reason}" if provider else reason
        head = f"{head} — {said}" if head else said
    elif provider and provider.lower() not in head.lower():
        head = f"{head} — upstream provider: {provider}" if head else provider

    if len(head) > MAX_ERROR_DETAIL_CHARS:
        head = head[: MAX_ERROR_DETAIL_CHARS - 1].rstrip() + "…"
    return head or "the provider returned an error with no detail"


def _error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except (ValueError, TypeError):
        payload = None
    if isinstance(payload, dict) and payload.get("error") is not None:
        return _describe_error(payload["error"], response.status_code)
    return f"provider returned HTTP {response.status_code}"


def _tool_name(spec: dict[str, Any]) -> str:
    return str((spec.get("function") or {}).get("name") or "")


def _message_skeleton(messages: list[dict[str, Any]]) -> str:
    """The SHAPE of a request — roles and tool-call ids, never any content.

    A 400 about tool-call pairing ("No tool output found for function call
    <id>") is unanswerable without seeing how the conversation was laid out, and
    the layout is exactly what no log had: the failure named an id that appears
    nowhere a person can look. Content is deliberately excluded (SPEC §6) — the
    pairing is structural, so the skeleton is the whole evidence.
    """
    parts: list[str] = []
    for message in messages:
        role = str(message.get("role") or "?")
        if role == "assistant" and message.get("tool_calls"):
            ids = ",".join(str(call.get("id") or "-") for call in message["tool_calls"])
            parts.append(f"assistant[calls:{ids}]")
        elif role == "tool":
            parts.append(f"tool[for:{message.get('tool_call_id') or '-'}]")
        else:
            parts.append(role)
    return " ".join(parts)


def _rejected_catalog_error(response: httpx.Response, tools: list[dict[str, Any]]) -> str:
    """The message for a 400 that arrived with a tool catalog attached.

    Names the model and how many tools it was offered, because the actionable
    fix is almost always "this model's backend does not accept this catalog —
    use another model", and nothing else in the UI says that.
    """
    detail = _error_message(response)
    names = ", ".join(sorted(filter(None, (_tool_name(t) for t in tools)))[:8])
    return (
        f"{detail} — this happened on a request carrying {len(tools)} tool "
        f"definitions ({names}…). If it repeats for every message, the model's "
        f"provider is rejecting this room's tool catalog; choose a different "
        f"model with Tools capability."
    )


async def _sse_events(response: httpx.Response) -> AsyncIterator[dict[str, Any]]:
    """The parsed ``data:`` payloads of one streaming response, in order.

    A line that is not valid JSON is SKIPPED, not fatal. Both readers used to
    parse it bare, so one garbled or truncated frame — a dropped byte, a proxy's
    own keep-alive noise — raised out of the middle of the stream and turned the
    half-written answer already on screen into an error. Everything the model
    sent before and after that frame is still good.

    An explicit ``error`` payload is different: that one IS the provider saying
    the turn failed, so it is raised.
    """
    async for line in response.aiter_lines():
        if not line.startswith("data:"):
            continue
        raw = line[5:].strip()
        if not raw or raw == "[DONE]":
            continue
        try:
            event = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        if event.get("error"):
            raise ProviderApiError(_describe_error(event["error"]))
        yield event


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
        input_tokens: int | None = None

        async with httpx.AsyncClient(timeout=provider_timeout_secs()) as client:
            # A 400 carrying a tool catalog is reported, never worked around by
            # quietly shrinking the catalog — see the note at the top of this
            # module for the agents that broke when it was. An agent whose tools
            # were removed does not say so; it answers as though it had never
            # had them.
            async with client.stream(
                "POST", self.endpoint, headers=self.headers, json=payload
            ) as response:
                if not response.is_success:
                    await response.aread()
                    if response.status_code == 400 and payload.get("tools"):
                        _log.warning(
                            "provider rejected a tool request: %s | shape: %s",
                            _error_message(response),
                            _message_skeleton(payload.get("messages") or []),
                        )
                        raise ProviderApiError(
                            _rejected_catalog_error(response, payload["tools"])
                        )
                    raise ProviderApiError(_error_message(response))
                # Poll Stop WHILE the next SSE event is outstanding. The
                # in-body check this replaces only ran once an event had
                # arrived, so a provider holding the connection open with no
                # data — the shape live QA saw on OpenRouter — never sampled
                # the flag at all. `iter_with_stop` also bounds the silence,
                # which httpx's timeout does not: that one covers a single
                # socket read, not a stream that keeps the connection warm.
                events = _stall_as_error(
                    iter_with_stop(
                        _sse_events(response), cancel, provider_timeout_secs()
                    ),
                    self.composite_model,
                )
                async for event in events:
                    usage = event.get("usage") or {}
                    input_tokens = usage.get("prompt_tokens", input_tokens)
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
