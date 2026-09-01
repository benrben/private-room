"""External CLI command construction and result parsing."""

from __future__ import annotations

import json
from typing import Any

from . import hub_mcp
from .external_llm_codex import CLAUDE_NO_TOOLS_FLAGS, CODEX_ARCELLE_FLAGS, _SAFE_CLI_ARG, _codex_mcp_flags


def _facade_module() -> Any:
    from . import external_llm

    return external_llm


def _checked_arg(value: str | None, what: str) -> str | None:
    if value is None or _SAFE_CLI_ARG.match(value):
        return value
    raise ValueError(f"Unsafe {what} in the room's model setting: {value!r}")


def _image_flags(image_paths: list[str] | None) -> str:
    """Codex's ``-i`` attachments. The paths are our own ``mkstemp`` names, but
    they cross the same ``zsh -ilc`` boundary the model slug does, so anything
    a quote could not contain fails loudly instead of being interpolated."""
    flags = ""
    for p in image_paths or []:
        if "'" in p or "\n" in p:
            raise ValueError(f"Unsafe staged image path: {p!r}")
        flags += f" -i '{p}'"
    return flags


def _agent_model_flag(submodel: str | None) -> str:
    """The optional model selector shared by every agent CLI."""
    return f" --model '{submodel}'" if submodel else ""


def _claude_input_flag(stream_json_input: bool) -> str:
    """Select Claude's image-capable stdin protocol when it is needed."""
    return " --input-format stream-json" if stream_json_input else ""


def _claude_system_flag(system_path: str | None) -> str:
    """Replace Claude's stock system prompt only when the caller supplied one."""
    return f" --system-prompt-file '{system_path}'" if system_path else ""


def _claude_allowed_tool_names(
    allowed: list[str] | None, hub_allowed: list[str] | None
) -> str:
    """Render the room and hub tools in Claude's MCP allowlist spelling."""
    room_tools = [f"'mcp__room__{name}'" for name in allowed or []]
    hub_tools = [f"'{hub_mcp.qualified(name)}'" for name in hub_allowed or []]
    return " ".join([*room_tools, *hub_tools])


def _claude_tool_flags(
    mcp_path: str | None,
    allowed: list[str] | None,
    hub_allowed: list[str] | None,
) -> str:
    """Mount the scoped room bridge, or explicitly leave Claude tool-less."""
    if not mcp_path:
        return CLAUDE_NO_TOOLS_FLAGS
    if not allowed and not hub_allowed:
        return CLAUDE_NO_TOOLS_FLAGS
    names = _claude_allowed_tool_names(allowed, hub_allowed)
    return f" --mcp-config '{mcp_path}' --strict-mcp-config --allowedTools {names}"


def _claude_agent_cmdline(
    submodel: str | None,
    effort: str | None,
    system_path: str | None,
    mcp_path: str | None,
    allowed: list[str] | None,
    hub_allowed: list[str] | None,
    stream_json_input: bool,
) -> str:
    """The streaming Claude agent invocation and its room-tool boundary."""
    effort_flag = f" --effort '{effort}'" if effort else ""
    return (
        "claude -p --output-format stream-json --verbose "
        f"--include-partial-messages{_claude_input_flag(stream_json_input)}"
        f"{_claude_tool_flags(mcp_path, allowed, hub_allowed)}"
        f"{_claude_system_flag(system_path)}{_agent_model_flag(submodel)}{effort_flag}"
    )


def _codex_agent_cmdline(
    submodel: str | None,
    effort: str | None,
    codex_mcp_url: str | None,
    image_paths: list[str] | None,
) -> str:
    """The sandboxed Codex agent invocation and its optional loopback bridge."""
    effort_flag = f" -c 'model_reasoning_effort={effort}'" if effort else ""
    return (
        f"codex exec --json{CODEX_ARCELLE_FLAGS}{_codex_mcp_flags(codex_mcp_url)}"
        f"{_agent_model_flag(submodel)}{effort_flag}{_image_flags(image_paths)} -"
    )


def _antigravity_agent_cmdline(submodel: str | None) -> str:
    """The headless Antigravity agent invocation."""
    return (
        "agy --sandbox --mode plan --input-format stream-json "
        "--output-format stream-json --print-timeout 5m"
        f"{_agent_model_flag(submodel)}"
    )


def _agent_cmdline_for_engine(
    engine: str,
    submodel: str | None,
    effort: str | None,
    system_path: str | None,
    mcp_path: str | None,
    allowed: list[str] | None,
    hub_allowed: list[str] | None,
    codex_mcp_url: str | None,
    stream_json_input: bool,
    image_paths: list[str] | None,
) -> str:
    """Dispatch a checked agent model setting to its engine-specific builder."""
    if engine == "claude-cli":
        return _claude_agent_cmdline(
            submodel,
            effort,
            system_path,
            mcp_path,
            allowed,
            hub_allowed,
            stream_json_input,
        )
    if engine == "codex-cli":
        return _codex_agent_cmdline(submodel, effort, codex_mcp_url, image_paths)
    if engine == "antigravity-cli":
        return _antigravity_agent_cmdline(submodel)
    raise ValueError(f"Unknown external engine: {engine}")


def build_agent_cmdline(
    engine: str,
    submodel: str | None,
    effort: str | None,
    *,
    system_path: str | None = None,
    mcp_path: str | None = None,
    allowed: list[str] | None = None,
    hub_allowed: list[str] | None = None,
    codex_mcp_url: str | None = None,
    stream_json_input: bool = False,
    image_paths: list[str] | None = None,
) -> str:
    """The CLI invocation for one AGENT round, mirroring ``external.rs``.

    Same machine-readable envelope Rust asks for, in its STREAMED form for
    Claude (``--output-format stream-json`` / ``--json``) — it carries the CLI's
    OWN usage report and, for Claude, its real context window, so nothing here
    has to assume a number. Rust's ``external.rs`` still asks for the unstreamed
    ``json``; that is not drift, it needs no heartbeat because its own spawn has
    no timeout to satisfy (it blocks on ``wait_with_output``). Both parsers
    below degrade to plain stdout, so a CLI change costs the accounting, never
    the answer.

    ``submodel``/``effort`` are checked against :data:`_SAFE_CLI_ARG` before
    they are quoted into the command line — see there for why.

    ``system_path`` REPLACES Claude's own agent system prompt with ours. That
    is the difference between a worker that acts and one that doesn't: the
    stock prompt tells the model it is a coding CLI with its own tools, and a
    tool protocol offered from a user turn loses to it (live QA 2026-07-24 — a
    worker holding search_mcp_tools answered "the tool list contains no
    search_mcp_tools" after searching its OWN registry). Codex takes no
    equivalent flag; its instructions ride the prompt.
    """
    submodel = _checked_arg(submodel, "model name")
    effort = _checked_arg(effort, "effort level")
    return _agent_cmdline_for_engine(
        engine,
        submodel,
        effort,
        system_path,
        mcp_path,
        allowed,
        hub_allowed,
        codex_mcp_url,
        stream_json_input,
        image_paths,
    )


#: The marker the shell echoes on BOTH streams immediately before the CLI runs.
#: ``zsh -ilc`` runs the user's INTERACTIVE startup files — that is how a
#: GUI-launched process finds these CLIs on PATH at all — and whatever they
#: print goes to our pipes: a greeting, a version-manager banner, an "nvm is not
#: compatible with…" warning. On stdout it arrives glued to the reply and is
#: shown as the answer (and stops ``claude -p``'s JSON envelope from parsing);
#: on stderr :func:`cli_failure_reason` reads it INSTEAD of the real reason a
#: call failed. Everything before the marker belongs to the shell, not to the
#: engine, and is dropped. Fixed rather than random so the command line stays
#: predictable — a startup file cannot print this, and the CLI's own output
#: comes after it either way.
_OUTPUT_FENCE = "__ARCELLE_CLI_OUTPUT__"


def fenced_cmdline(cmdline: str) -> str:
    """``cmdline`` preceded by the fence marker on stdout and stderr."""
    return (
        f"printf '%s\\n' {_OUTPUT_FENCE} >&2; "
        f"printf '%s\\n' {_OUTPUT_FENCE}; {cmdline}"
    )


def strip_shell_banner(stream: bytes | str) -> str:
    """One captured stream with the login shell's own chatter removed.

    Returned unchanged when the marker is absent — the fence never ran, so
    there is nothing we can honestly attribute to the shell.
    """
    if isinstance(stream, bytes):
        stream = stream.decode("utf-8", "replace")
    _shell, marker, rest = stream.partition(_OUTPUT_FENCE)
    return rest.lstrip("\r\n") if marker else stream


def _json_object(text: str) -> dict[str, Any] | None:
    """Parse one JSON object, treating invalid and non-object input alike."""
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _last_claude_result_event(stdout: str) -> dict[str, Any] | None:
    """Find the terminal result object among a stream of NDJSON events."""
    found: dict[str, Any] | None = None
    for line in stdout.splitlines():
        event = _json_object(line.strip())
        if event is not None and event.get("type") == "result":
            found = event  # last one wins — it is the terminal envelope
    return found


def claude_result_object(stdout: str) -> dict[str, Any] | None:
    """The terminal ``{"type": "result", …}`` envelope, from EITHER output shape.

    ``--output-format json`` prints that object and nothing else;
    ``--output-format stream-json`` prints one JSON event per line and the SAME
    object last. Reading whole-buffer first and falling back to the last
    ``type: result`` line means one parser serves both — which is what made the
    streaming switch (taken for the liveness heartbeat, see
    :data:`EXTERNAL_IDLE_SECS`) free on the answer path rather than a rewrite of
    it. Returns None when neither shape yields an object.
    """
    whole = _json_object(stdout)
    return whole if whole is not None else _last_claude_result_event(stdout)


def parse_claude_json_result(stdout: str) -> tuple[str, int | None, int | None]:
    """``(text, input_tokens, context_window)`` from ``claude -p`` — the Python
    twin of ``external.rs::parse_claude_json_result``.

    All three input counts (fresh, cache-creation, cache-read) occupy context,
    so the bar counts all three. ``contextWindow`` is taken from whichever model
    did the most work this turn — a single turn can span two models.
    """
    result = claude_result_object(stdout)
    if result is None:
        return stdout.strip(), None, None
    return (
        _claude_result_text(result, stdout),
        _claude_input_tokens(result),
        _claude_context_window(result),
    )


def _claude_result_text(result: dict[str, Any], stdout: str) -> str:
    """Use Claude's terminal text, retaining raw output as the schema-drift fallback."""
    text = result.get("result")
    return text if isinstance(text, str) else stdout.strip()


def _claude_input_tokens(result: dict[str, Any]) -> int | None:
    """Count every Claude input bucket because all of them occupy context."""
    usage = result.get("usage")
    if not isinstance(usage, dict):
        return None
    return sum(
        _claude_token_count(usage.get(key))
        for key in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
    )


def _claude_token_count(value: Any) -> int:
    """Normalize Claude's absent input-count field exactly as its CLI contract does."""
    return int(value or 0)


def _claude_context_window(result: dict[str, Any]) -> int | None:
    """Read the context limit belonging to the model that did the most work."""
    model_usage = result.get("modelUsage")
    return _largest_model_context_window(model_usage) if isinstance(model_usage, dict) else None


def _largest_model_context_window(model_usage: dict[str, Any]) -> int | None:
    """Choose the reported window from the highest-work valid model record."""
    greatest_work = -1
    selected_window: int | None = None
    for entry in model_usage.values():
        candidate = _model_context_candidate(entry)
        if candidate is None:
            continue
        work, window = candidate
        if work > greatest_work:
            greatest_work, selected_window = work, window
    return selected_window


def _model_context_candidate(entry: Any) -> tuple[int, int] | None:
    """Return one usable model record's work and stated context window."""
    if not isinstance(entry, dict):
        return None
    window = entry.get("contextWindow")
    if not isinstance(window, int):
        return None
    return _model_work(entry), window


def _model_work(entry: dict[str, Any]) -> int:
    """Total all Claude usage buckets used to compare model records."""
    return sum(
        _claude_token_count(entry.get(key))
        for key in (
            "inputTokens",
            "outputTokens",
            "cacheCreationInputTokens",
            "cacheReadInputTokens",
        )
    )


def cli_failure_reason(stdout: bytes | str, stderr: bytes | str) -> str:
    """Why a cloud CLI exited non-zero, in words a user can act on.

    A failing ``claude -p`` writes NOTHING to stderr — the diagnosis rides
    stdout as ordinary result JSON with ``is_error`` set. Reading only stderr
    (what both call sites used to do) produced the empty message
    ``"claude-cli failed: "``, which tells a user nothing and cost a real
    debugging session: a teacher model exhausting its tool-call retries
    (``terminal_reason: malformed_tool_use_exhausted``) looked identical to a
    missing binary.

    ``terminal_reason`` is carried alongside ``result`` because it is the
    machine-readable half — "the model kept emitting broken tool calls" is a
    different fix from "you are out of quota", and only that field separates
    them reliably.
    """
    stdout_text = _cli_output_text(stdout)
    stderr_text = _cli_output_text(stderr)
    stderr_reason = _trimmed_failure_reason(stderr_text)
    if stderr_reason is not None:
        return stderr_reason
    # Same both-shapes read as the answer path: under `stream-json` the
    # diagnosis still rides the terminal `result` event, just not alone on the
    # buffer. Parsing only the whole buffer here would have turned every
    # streamed failure back into the empty message this function exists to fix.
    return _stdout_failure_reason(stdout_text)


def _cli_output_text(value: bytes | str) -> str:
    """Decode process output with the replacement policy used by the old path."""
    return value.decode("utf-8", "replace") if isinstance(value, bytes) else value


def _trimmed_failure_reason(value: str) -> str | None:
    """Return non-empty diagnostic text, preserving the shared length limit."""
    text = value.strip()[:400]
    return text or None


def _stdout_failure_reason(stdout: str) -> str:
    """Use Claude's terminal diagnostic when a structured result is available."""
    result = claude_result_object(stdout)
    if result is None:
        return _trimmed_failure_reason(stdout) or "no output"
    return _claude_failure_reason(result)


def _claude_failure_reason(result: dict[str, Any]) -> str:
    """Render the human text and machine terminal reason in their old order."""
    response = result.get("result")
    public_text = response if isinstance(response, str) else None
    parts = (_failure_part(public_text), _failure_part(result.get("terminal_reason")))
    return _trimmed_failure_reason(" ".join(filter(None, parts))) or "no output"


def _failure_part(value: Any) -> str:
    """Keep truthy failure fields, matching the former filtered join exactly."""
    return str(value) if value else ""


def parse_codex_json_stream(stdout: str) -> tuple[str, int | None, int | None]:
    """``(text, input_tokens, None)`` from ``codex exec --json`` — the Python
    twin of ``external.rs::parse_codex_json_stream``. The answer rides the last
    ``agent_message`` item; usage rides ``turn.completed``. Codex reports no
    context window at all. Raw stdout is used only if NO line parsed as JSON.
    """
    text, input_tokens, parsed_any = _parse_codex_events(stdout)
    return _codex_stream_text(text, parsed_any, stdout), input_tokens, None


def _parse_codex_events(stdout: str) -> tuple[str, int | None, bool]:
    """Collect Codex's final message and reported input usage from JSONL."""
    text = ""
    input_tokens: int | None = None
    parsed_any = False
    for line in stdout.split("\n"):
        event = _facade_module()._stream_event_from_line(line)
        if event is None:
            continue
        parsed_any = True
        text, input_tokens = _apply_codex_event(text, input_tokens, event)
    return text, input_tokens, parsed_any


def _apply_codex_event(
    text: str, input_tokens: int | None, event: dict[str, Any]
) -> tuple[str, int | None]:
    """Apply public text or terminal usage without changing the other value."""
    message_text = _facade_module()._codex_agent_message_text(event)
    reported_tokens = _codex_input_tokens(event)
    return (
        message_text if message_text is not None else text,
        reported_tokens if reported_tokens is not None else input_tokens,
    )


def _codex_input_tokens(event: dict[str, Any]) -> int | None:
    """Read Codex's optional terminal prompt-token count."""
    if event.get("type") != "turn.completed":
        return None
    usage = event.get("usage")
    if not isinstance(usage, dict):
        return None
    tokens = usage.get("input_tokens")
    return tokens if isinstance(tokens, int) else None


def _codex_stream_text(text: str, parsed_any: bool, stdout: str) -> str:
    """Fall back to raw output only when the stream held no object events."""
    return text if parsed_any else stdout.strip()


def parse_antigravity_json_stream(stdout: str) -> tuple[str, int | None, int | None]:
    """``(text, input_tokens, None)`` from Antigravity's stream-json JSONL.

    Assistant message deltas form the answer and the terminal result carries
    aggregate token statistics. Raw stdout is preserved on schema drift.
    """
    text, input_tokens, parsed_any = _parse_antigravity_events(stdout)
    return _antigravity_stream_text(text, parsed_any, stdout), input_tokens, None


def _parse_antigravity_events(stdout: str) -> tuple[str, int | None, bool]:
    """Collect public text and usage from the valid JSON objects in a stream."""
    text = ""
    input_tokens: int | None = None
    parsed_any = False
    for line in stdout.splitlines():
        event = _facade_module()._stream_event_from_line(line)
        if event is None:
            continue
        parsed_any = True
        text, input_tokens = _apply_antigravity_event(text, input_tokens, event)
    return text, input_tokens, parsed_any


def _apply_antigravity_event(
    text: str, input_tokens: int | None, event: dict[str, Any]
) -> tuple[str, int | None]:
    """Apply one stream event without letting private events change the reply."""
    if event.get("event") == "step_update":
        return _append_antigravity_delta(text, input_tokens, event)
    if event.get("event") == "result":
        return _replace_antigravity_result(text, input_tokens, event)
    return text, input_tokens


def _append_antigravity_delta(
    text: str, input_tokens: int | None, event: dict[str, Any]
) -> tuple[str, int | None]:
    """Append a public response fragment when this update carries one."""
    delta = _facade_module()._antigravity_agent_delta(event)
    if delta is None:
        return text, input_tokens
    return text + delta, input_tokens


def _replace_antigravity_result(
    text: str, input_tokens: int | None, event: dict[str, Any]
) -> tuple[str, int | None]:
    """Let a terminal result replace deltas and refresh aggregate usage."""
    result = event.get("result")
    if not isinstance(result, dict):
        return text, input_tokens
    response = _antigravity_result_response(result)
    reported_tokens = _antigravity_input_tokens(result)
    return (
        response if response is not None else text,
        reported_tokens if reported_tokens is not None else input_tokens,
    )


def _antigravity_result_response(result: dict[str, Any]) -> str | None:
    """Read the terminal response only when the adapter supplied text."""
    response = result.get("response")
    return response if isinstance(response, str) else None


def _antigravity_input_tokens(result: dict[str, Any]) -> int | None:
    """Read the optional aggregate input-token count from a terminal result."""
    usage = result.get("usage")
    if not isinstance(usage, dict):
        return None
    tokens = usage.get("input_tokens")
    return tokens if isinstance(tokens, int) else None


def _antigravity_stream_text(text: str, parsed_any: bool, stdout: str) -> str:
    """Keep raw stdout only when no dictionary event could be parsed."""
    if parsed_any:
        return text
    return stdout.strip()
