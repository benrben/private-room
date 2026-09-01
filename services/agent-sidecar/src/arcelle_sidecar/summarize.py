"""Map/reduce summary orchestration and its public facade."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .budget import json_chars, msg_len, window_budget_bytes
from .chat_docs import parse_string_list
from .llm import LlmError, _classify
from .messages import Message, ToolCall, canonical_json
from .model_limits import max_num_ctx, native_context_length, pick_num_ctx
from .summarize_chat import ModelClient as ModelClient, _chat_structured
from .summarize_combine import combine_summary as combine_summary
from .summarize_requests import (
    CombineSummaryRequest as CombineSummaryRequest,
    SummarizeFileRequest as SummarizeFileRequest,
)
from .summarize_text import (
    MAX_READS as MAX_READS,
    ONE_LINER_MAX as ONE_LINER_MAX,
    READ_WINDOW_DEFAULT as READ_WINDOW_DEFAULT,
    READ_WINDOW_MAX as READ_WINDOW_MAX,
    READ_WINDOW_MIN as READ_WINDOW_MIN,
    TextWindow as TextWindow,
    _ceil_char_boundary as _ceil_char_boundary,
    _first_nonempty_line as _first_nonempty_line,
    _floor_char_boundary as _floor_char_boundary,
    _num as _num,
    clean_one_liner as clean_one_liner,
    json_str_field as json_str_field,
    read_args as read_args,
    read_text_tool as read_text_tool,
    read_window as read_window,
    smart_filter as smart_filter,
    strip_markup_blocks as strip_markup_blocks,
)

def _restore_chat_text(content: str, engaged: Any | None) -> str:
    """Restore protected values when the outbound privacy door was engaged."""
    if engaged is None:
        return content
    return engaged.restore_text(content)


def _restore_tool_calls(calls: list[ToolCall], engaged: Any | None) -> list[ToolCall]:
    """Restore protected values in tool arguments for the local tool runner."""
    if engaged is None:
        return calls
    for call in calls:
        call.arguments = engaged.restore_value(call.arguments)
    return calls


def _restored_chat_result(
    content: str, calls: list[ToolCall], engaged: Any | None
) -> tuple[str, list[ToolCall]]:
    return _restore_chat_text(content, engaged), _restore_tool_calls(calls, engaged)


async def _external_chat(
    generate_external: Any,
    model: str,
    messages: list[Message],
    format: dict[str, Any] | None,  # noqa: A002 - Ollama arg name
    engaged: Any | None,
) -> tuple[str, list[ToolCall]]:
    """Use a CLI engine, whose summarize seam has no native tool protocol."""
    content = await generate_external(model, messages, format=format)
    return _restored_chat_result(content, [], engaged)


async def _ignore_provider_delta(_value: str) -> None:
    """Summarize needs the completed provider turn rather than live deltas."""
    return None


async def _provider_result(
    api: Any,
    messages: list[Message],
    tools: list[dict[str, Any]] | None,
    format: dict[str, Any] | None,  # noqa: A002 - Ollama arg name
) -> tuple[str, list[ToolCall]]:
    if tools:
        content, calls, _usage = await api.stream(messages, tools, _ignore_provider_delta)
        return content, calls
    return await api.generate(messages, format=format), []


async def _provider_chat(
    model: str,
    provider: Any,
    temperature: float | None,
    messages: list[Message],
    tools: list[dict[str, Any]] | None,
    format: dict[str, Any] | None,  # noqa: A002 - Ollama arg name
    engaged: Any | None,
) -> tuple[str, list[ToolCall]]:
    """Run the OpenAI-compatible path under the summarize error contract."""
    from .provider_api import OpenAICompatibleChatModel

    api = OpenAICompatibleChatModel(model, provider, temperature)
    try:
        content, calls = await _provider_result(api, messages, tools, format)
    except Exception as exc:  # noqa: BLE001 - the public seam classifies all provider failures
        raise _classify(exc) from exc
    return _restored_chat_result(content, calls, engaged)


def _request_json_chars(value: dict[str, Any] | list[dict[str, Any]] | None) -> int:
    return json_chars(value) if value else 0


async def _ollama_options(
    model: str,
    base_url: str,
    messages: list[Message],
    tools: list[dict[str, Any]] | None,
    format: dict[str, Any] | None,  # noqa: A002 - Ollama arg name
    temperature: float | None,
    num_ctx: int | None,
) -> dict[str, Any]:
    """Build the direct Ollama payload options, always pinning its context."""
    window = num_ctx
    if window is None:
        native = await native_context_length(model, base_url)
        request_bytes = sum(msg_len(message) for message in messages)
        request_bytes += _request_json_chars(tools) + _request_json_chars(format)
        window = pick_num_ctx(request_bytes, native)
    options: dict[str, Any] = {"num_ctx": window}
    if temperature is not None:
        options["temperature"] = temperature
    return options


def _ollama_think(model: str, think_on: bool) -> bool | None:
    """Only qwen3 non-instruct variants understand Ollama's think parameter."""
    return think_on if "qwen3" in model and "instruct" not in model else None


def _ollama_tool_call(index: int, raw_call: Any, engaged: Any | None) -> ToolCall | None:
    name = getattr(raw_call.function, "name", "") or ""
    if not name:
        return None
    arguments = dict(raw_call.function.arguments or {})
    if engaged is not None:
        arguments = engaged.restore_value(arguments)
    call_id = f"call_{index}"
    return ToolCall(
        name=name,
        arguments=arguments,
        id=call_id,
        raw={"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}},
    )


def _ollama_tool_calls(raw_calls: list[Any] | None, engaged: Any | None) -> list[ToolCall]:
    calls: list[ToolCall] = []
    for index, raw_call in enumerate(raw_calls or []):
        call = _ollama_tool_call(index, raw_call, engaged)
        if call is not None:
            calls.append(call)
    return calls


async def _ollama_chat(
    client_factory: Any,
    base_url: str,
    model: str,
    messages: list[Message],
    tools: list[dict[str, Any]] | None,
    format: dict[str, Any] | None,  # noqa: A002 - Ollama arg name
    temperature: float | None,
    num_ctx: int | None,
    keep_alive: str,
    think_on: bool,
    engaged: Any | None,
) -> tuple[str, list[ToolCall]]:
    """Call loopback Ollama and translate its response into the model seam."""
    options = await _ollama_options(model, base_url, messages, tools, format, temperature, num_ctx)
    try:
        response = await client_factory(host=base_url).chat(
            model=model,
            messages=[dict(message) for message in messages],
            tools=tools,
            format=format,
            options=options,
            keep_alive=keep_alive,
            think=_ollama_think(model, think_on),
            stream=False,
        )
    except Exception as exc:  # noqa: BLE001 - re-raised as the sentinel contract
        raise _classify(exc) from exc
    content = response.message.content or ""
    return _restored_chat_result(content, _ollama_tool_calls(response.message.tool_calls, engaged), engaged)


class OllamaModelClient:
    """The real seam: a local Ollama server over loopback, nothing else.

    Reproduces the summarize.rs wire calls: same ``options.num_ctx``/temperature,
    same ``keep_alive``, and the same qwen3 ``think`` rule (ollama.rs:603 — the
    flag is sent ONLY to qwen3 non-instruct models; the gather loop turns it ON,
    every other call leaves it OFF). Exceptions are re-raised as the sentinel
    :class:`.llm.LlmError` contract.
    """

    def __init__(
        self,
        base_url: str,
        privacy: dict[str, Any] | None = None,
        provider: Any | None = None,
    ) -> None:
        from .privacy import policy_from_payload

        self.base_url = base_url
        # PRIV-1: the room's policy rides the request body; the door engages in
        # _chat only when the model is non-local.
        self.privacy = policy_from_payload(privacy)
        self.provider = provider

    async def _chat(
        self,
        model: str,
        messages: list[Message],
        *,
        tools: list[dict[str, Any]] | None,
        format: dict[str, Any] | None,  # noqa: A002
        temperature: float | None,
        num_ctx: int | None,
        keep_alive: str,
        think_on: bool,
    ) -> tuple[str, list[ToolCall]]:
        from ollama import AsyncClient

        # Engine parity: an external CLI answers as plain text with no Ollama
        # tool-calls — the gather loop already degrades to sample-based
        # summaries when a model returns no calls, so (text, []) slots in.
        from .external_llm import generate_external, is_external_model
        from .privacy import guard_outbound

        # PRIV-1: one guard ahead of the engine split covers both ways out.
        messages, _, engaged = guard_outbound(model, messages, self.privacy)

        if is_external_model(model):
            return await _external_chat(generate_external, model, messages, format, engaged)
        if self.provider is not None:
            return await _provider_chat(
                model,
                self.provider,
                temperature,
                messages,
                tools,
                format,
                engaged,
            )
        return await _ollama_chat(
            AsyncClient,
            self.base_url,
            model,
            messages,
            tools,
            format,
            temperature,
            num_ctx,
            keep_alive,
            think_on,
            engaged,
        )

    async def chat_tools(
        self,
        model: str,
        messages: list[Message],
        tools: list[dict[str, Any]],
        *,
        temperature: float | None,
        num_ctx: int | None,
        keep_alive: str,
    ) -> tuple[str, list[ToolCall]]:
        # summarize.rs uses chat_stream_tools_thinking here: thinking ON.
        return await self._chat(
            model,
            messages,
            tools=tools,
            format=None,
            temperature=temperature,
            num_ctx=num_ctx,
            keep_alive=keep_alive,
            think_on=True,
        )

    async def generate(
        self,
        model: str,
        messages: list[Message],
        *,
        temperature: float | None,
        num_ctx: int | None,
        keep_alive: str,
        format: dict[str, Any] | None = None,  # noqa: A002
    ) -> str:
        # chat_structured / chat_stream_tools(no tools): thinking OFF.
        content, _ = await self._chat(
            model,
            messages,
            tools=None,
            format=format,
            temperature=temperature,
            num_ctx=num_ctx,
            keep_alive=keep_alive,
            think_on=False,
        )
        return content


# --- chat_structured (ollama.rs) --------------------------------------------


# --- the map step: summarize_one_file (summarize.rs) ------------------------


async def _gather_window(client: ModelClient, model: str) -> int:
    """The largest window ``model`` will actually be given for one file's gather.

    :func:`.model_limits.max_num_ctx` is the RAM ceiling — the biggest window
    this MAC may ask for. It is NOT what the chosen model gets: every call the
    gather loop makes goes through :func:`.model_limits.pick_num_ctx`, which
    clamps that ceiling to the model's own native length. Budgeting the reads
    off the ceiling alone therefore handed a small-window model roughly double
    what fits, and an oversized prompt is dropped from the FRONT — the system
    prompt and the instruction — so the summary came back rambling or empty
    with no error.

    A provider room states its window in its own catalog entry
    (:attr:`config.Provider.context_window`), and every call it makes is cut to
    that window by :meth:`provider_api.OpenAICompatibleChatModel._fit_one_shot`
    — silently. Budgeting an 8k cloud model's reads off this Mac's RAM instead
    spent hundreds of KB the provider then threw away, so the one-liner was
    written from a truncated read nothing had reported as truncated. The
    ceiling still caps it: the gathered text is held in THIS process first.

    A cloud CLI states no window, and neither does a provider whose catalog
    entry carries none, so both keep the ceiling (unchanged behaviour).
    """
    from .external_llm import is_external_model

    ceiling = max_num_ctx()
    provider_window = getattr(getattr(client, "provider", None), "context_window", None)
    if provider_window:
        return min(ceiling, provider_window)
    base_url = getattr(client, "base_url", "")
    if not base_url or getattr(client, "provider", None) is not None:
        return ceiling
    if is_external_model(model):
        return ceiling
    native = await native_context_length(model, base_url)
    return min(ceiling, native) if native else ceiling


@dataclass(slots=True)
class _FileSummaryContext:
    data: bytes
    head: TextWindow
    samples: list[tuple[str, TextWindow]]
    remaining: int

    @property
    def whole(self) -> bool:
        return self.head.end >= len(self.data)


@dataclass(slots=True)
class _ReadState:
    remaining: int
    reads: int = 0
    seen: set[str] = field(default_factory=set)

    @property
    def can_read(self) -> bool:
        return self.reads < MAX_READS and self.remaining >= READ_WINDOW_MIN


def _baseline_samples(data: bytes, head: TextWindow) -> list[tuple[str, TextWindow]]:
    """Return the distinct middle and end samples that follow the head sample."""
    samples: list[tuple[str, TextWindow]] = []
    for label, start in (("middle", len(data) // 2), ("end", len(data) - 2_000)):
        window = read_window(data, max(start, head.end), 2_000, None)
        if window.nbytes and all(window.offset != prior.offset for _, prior in samples):
            samples.append((label, window))
    return samples


async def _summary_context(client: ModelClient, model: str, filtered: str) -> _FileSummaryContext:
    """Build the samples and bounded read budget for one filtered file."""
    data = filtered.encode("utf-8")
    head = read_window(data, 0, READ_WINDOW_DEFAULT, None)
    samples = _baseline_samples(data, head)
    budget = window_budget_bytes(await _gather_window(client, model))
    remaining = max(0, budget - (head.nbytes + sum(window.nbytes for _, window in samples) + 8_000))
    return _FileSummaryContext(data=data, head=head, samples=samples, remaining=remaining)


def _summary_prompts(name: str, mime: str, context: _FileSummaryContext) -> tuple[str, str]:
    """Build the unchanged whole-file or sampled-long-file prompt pair."""
    if context.whole:
        return _whole_file_prompts(name, mime, context.head)
    return _long_file_prompts(name, mime, context)


def _whole_file_prompts(name: str, mime: str, head: TextWindow) -> tuple[str, str]:
    system = "You describe a single file in ONE short, factual sentence based only on what is given."
    user = f"File name: {name}\nType: {mime}\n\nIts text:\n{head.text}\n\nIn one sentence, what is this file about?"
    return system, user


def _long_file_prompts(name: str, mime: str, context: _FileSummaryContext) -> tuple[str, str]:
    system = (
        "You describe a single file in ONE short, factual sentence based only "
        "on what you read from it. You see samples of a longer file. If the "
        "samples hint that the important content is elsewhere (a table of "
        "contents, a reference to a later section, a phrase worth locating), "
        "you MUST call read_text to look there (find jumps to a phrase, offset "
        "picks a position) before answering. If the samples already show what "
        "the file is, answer directly."
    )
    blocks = "".join(
        f"Characters {window.offset}-{window.end} ({label}):\n{window.text}\n\n"
        for label, window in context.samples
    )
    user = (
        f"File name: {name}\nType: {mime}\nText length: {context.head.total} characters\n\n"
        f"Characters 0-{context.head.end} (beginning):\n{context.head.text}\n\n"
        f"{blocks}In one sentence, what is this file about?"
    )
    return system, user


async def _request_read_calls(
    client: ModelClient,
    model: str,
    messages: list[Message],
    tools: list[dict[str, Any]],
    keep_alive: str,
) -> list[ToolCall] | None:
    """Request tool calls, returning ``None`` when tool support degrades."""
    try:
        _content, calls = await client.chat_tools(
            model, list(messages), tools, temperature=0.2, num_ctx=None, keep_alive=keep_alive
        )
        return calls
    except LlmError as exc:
        if exc.code in ("OLLAMA_DOWN", "MODEL_MISSING"):
            raise
        return None


def _append_tool_call_turn(messages: list[Message], calls: list[ToolCall]) -> None:
    messages.append({"role": "assistant", "content": "", "tool_calls": [call.to_raw() for call in calls]})


def _read_budget_reply() -> str:
    return "The read budget for this file is used up — answer from what you have already read."


def _duplicate_read_reply() -> str:
    return "You already read exactly this window; ask for a different offset or find, or answer now."


def _follow_find_past_head(
    data: bytes,
    head: TextWindow,
    limit: int,
    find: str | None,
    window: TextWindow,
) -> TextWindow:
    """Prefer a matching window after the already-shown head when available."""
    if not window.found or window.offset >= head.end:
        return window
    again = read_window(data, head.end, limit, find)
    return again if again.found else window


def _window_reply(window: TextWindow, find: str | None) -> str:
    note = f' ("{find}" was not found after that offset)' if find and not window.found else ""
    return f"Characters {window.offset}-{window.end} of {window.total}{note}:\n{window.text}"


def _read_window_reply(context: _FileSummaryContext, state: _ReadState, call: ToolCall) -> str:
    offset, limit, find = read_args(call.arguments)
    window = read_window(context.data, offset, min(limit, state.remaining), find)
    window = _follow_find_past_head(context.data, context.head, min(limit, state.remaining), find, window)
    state.remaining = max(0, state.remaining - window.nbytes)
    return _window_reply(window, find)


def _tool_reply(context: _FileSummaryContext, state: _ReadState, call: ToolCall) -> str:
    if not state.can_read:
        return _read_budget_reply()
    if call.name != "read_text":
        return "Unknown tool: only read_text is available."
    key = canonical_json(call.arguments)
    if key in state.seen:
        return _duplicate_read_reply()
    state.seen.add(key)
    state.reads += 1
    return _read_window_reply(context, state, call)


def _append_tool_replies(
    messages: list[Message],
    calls: list[ToolCall],
    context: _FileSummaryContext,
    state: _ReadState,
) -> None:
    for call in calls:
        messages.append({"role": "tool", "content": _tool_reply(context, state, call), "tool_name": call.name})


async def _gather_file_reads(
    client: ModelClient,
    model: str,
    keep_alive: str,
    context: _FileSummaryContext,
    messages: list[Message],
) -> None:
    """Let the model request bounded additional windows, preserving failures."""
    state = _ReadState(remaining=context.remaining)
    tools = read_text_tool()
    while state.can_read:
        calls = await _request_read_calls(client, model, messages, tools, keep_alive)
        if not calls:
            break
        _append_tool_call_turn(messages, calls)
        _append_tool_replies(messages, calls, context, state)
    messages.append(
        {"role": "user", "content": "Based on everything you read, in one sentence, what is this file about?"}
    )


async def _final_summary(
    client: ModelClient,
    model: str,
    messages: list[Message],
    keep_alive: str,
) -> str:
    schema = {"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"]}
    raw = await _chat_structured(client, model, messages, 0.2, keep_alive, schema)
    return clean_one_liner(_summary_text(raw))


def _summary_text(raw: str) -> str:
    summary = json_str_field(raw, "summary")
    return raw if summary is None else summary


async def summarize_one_file(
    client: ModelClient,
    model: str,
    name: str,
    mime: str,
    text: str,
    keep_alive: str,
) -> str:
    """Describe one file in a sentence, using model-directed reads when needed."""
    filtered = smart_filter(text)
    if not filtered.strip():
        return ""
    context = await _summary_context(client, model, filtered)
    system, user = _summary_prompts(name, mime, context)
    messages: list[Message] = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    if not context.whole:
        await _gather_file_reads(client, model, keep_alive, context, messages)
    return await _final_summary(client, model, messages, keep_alive)


__all__ = [
    "MAX_READS",
    "ONE_LINER_MAX",
    "READ_WINDOW_DEFAULT",
    "READ_WINDOW_MIN",
    "READ_WINDOW_MAX",
    "TextWindow",
    "smart_filter",
    "read_window",
    "strip_markup_blocks",
    "clean_one_liner",
    "json_str_field",
    "parse_string_list",
    "read_text_tool",
    "read_args",
    "ModelClient",
    "OllamaModelClient",
    "summarize_one_file",
    "combine_summary",
    "SummarizeFileRequest",
    "CombineSummaryRequest",
]
