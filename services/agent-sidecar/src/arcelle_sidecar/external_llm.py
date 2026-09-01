"""External CLI generation and agent-chat backend."""
from __future__ import annotations

import asyncio as asyncio
import os as os
import tempfile as tempfile
from typing import Any, Optional

from .hub_mcp import HubToolServer
from .messages import Message, ToolCall
from .prompts import IMAGE_HANDOFF as IMAGE_HANDOFF

#: Engine ids that name a cloud coding CLI (mirror external.rs).
from .external_llm_messages import EXTERNAL_ENGINES as EXTERNAL_ENGINES, EXTERNAL_IDLE_SECS as EXTERNAL_IDLE_SECS, EXTERNAL_IDLE_ENV as EXTERNAL_IDLE_ENV, EXTERNAL_TIMEOUT_ENV as EXTERNAL_TIMEOUT_ENV, _POLL_SECS as _POLL_SECS, _SEP as _SEP, DISPLAY_CONTEXT_FALLBACK as DISPLAY_CONTEXT_FALLBACK, external_idle_secs as external_idle_secs, _Wedged as _Wedged, _Stopped as _Stopped, _stopped as _stopped, _pump as _pump, _feed as _feed, _drain_tasks as _drain_tasks, _stop_drain as _stop_drain, _drain_result as _drain_result, _idle_expired as _idle_expired, _drain_until_finished as _drain_until_finished, drain_with_idle as drain_with_idle, split_external_model as split_external_model, is_external_model as is_external_model, MAX_IMAGES_PER_MESSAGE as MAX_IMAGES_PER_MESSAGE, _B64_RE as _B64_RE, IMAGE_ENGINES as IMAGE_ENGINES, _is_deliverable_image as _is_deliverable_image, message_images as message_images, collect_images as collect_images, _blocked_image_turn as _blocked_image_turn, _attached_image_turn as _attached_image_turn, _undelivered_image_turn as _undelivered_image_turn, _delivered_turn_images as _delivered_turn_images, _user_turn as _user_turn, _append_one_shot_system_turn as _append_one_shot_system_turn, _append_one_shot_user_turn as _append_one_shot_user_turn, _append_one_shot_assistant_turn as _append_one_shot_assistant_turn, _ONE_SHOT_TURN_RENDERERS as _ONE_SHOT_TURN_RENDERERS, flatten_messages as flatten_messages, flatten_agent_messages as flatten_agent_messages, _append_agent_system_turn as _append_agent_system_turn, _append_agent_user_turn as _append_agent_user_turn, _render_agent_tool_calls as _render_agent_tool_calls, _agent_tool_calls as _agent_tool_calls, _agent_tool_call_name as _agent_tool_call_name, _agent_tool_call_arguments as _agent_tool_call_arguments, _append_agent_assistant_turn as _append_agent_assistant_turn, _append_agent_tool_turn as _append_agent_tool_turn, _AGENT_TURN_RENDERERS as _AGENT_TURN_RENDERERS
from .external_llm_codex import _tool_result_block as _tool_result_block, _HUB_ONLY_TOOLS as _HUB_ONLY_TOOLS, _CODEX_NATIVE_TOOL_ALIASES as _CODEX_NATIVE_TOOL_ALIASES, _CODEX_NATIVE_TOOL_DESCRIPTIONS as _CODEX_NATIVE_TOOL_DESCRIPTIONS, _MAIN_AGENT_PROMPT_START as _MAIN_AGENT_PROMPT_START, _MAIN_AGENT_PROMPT_END as _MAIN_AGENT_PROMPT_END, _CODEX_COORDINATOR_PROMPT as _CODEX_COORDINATOR_PROMPT, _is_hub_only as _is_hub_only, _tool_name_of as _tool_name_of, _hub_calls as _hub_calls, _codex_tool as _codex_tool, _codex_system as _codex_system, _codex_messages as _codex_messages, _codex_message as _codex_message, _render_codex_system_message as _render_codex_system_message, _render_codex_tool_calls as _render_codex_tool_calls, _codex_tool_call_alias as _codex_tool_call_alias, _render_codex_tool_name as _render_codex_tool_name, _bridge_tools as _bridge_tools, _mcp_server_entry as _mcp_server_entry, mcp_config_json as mcp_config_json, CLAUDE_NO_TOOLS_FLAGS as CLAUDE_NO_TOOLS_FLAGS, CODEX_ARCELLE_FLAGS as CODEX_ARCELLE_FLAGS, _CODEX_MCP_TOKEN_ENV as _CODEX_MCP_TOKEN_ENV, _codex_mcp_flags as _codex_mcp_flags, _validated_codex_mcp_url as _validated_codex_mcp_url, _is_loopback_http as _is_loopback_http, _is_arcelle_mcp_path as _is_arcelle_mcp_path, _codex_mcp_config_flag as _codex_mcp_config_flag, _SAFE_CLI_ARG as _SAFE_CLI_ARG
from .external_llm_cli import _checked_arg as _checked_arg, _image_flags as _image_flags, _agent_model_flag as _agent_model_flag, _claude_input_flag as _claude_input_flag, _claude_system_flag as _claude_system_flag, _claude_allowed_tool_names as _claude_allowed_tool_names, _claude_tool_flags as _claude_tool_flags, _claude_agent_cmdline as _claude_agent_cmdline, _codex_agent_cmdline as _codex_agent_cmdline, _antigravity_agent_cmdline as _antigravity_agent_cmdline, _agent_cmdline_for_engine as _agent_cmdline_for_engine, build_agent_cmdline as build_agent_cmdline, _OUTPUT_FENCE as _OUTPUT_FENCE, fenced_cmdline as fenced_cmdline, strip_shell_banner as strip_shell_banner, _json_object as _json_object, _last_claude_result_event as _last_claude_result_event, claude_result_object as claude_result_object, parse_claude_json_result as parse_claude_json_result, _claude_result_text as _claude_result_text, _claude_input_tokens as _claude_input_tokens, _claude_token_count as _claude_token_count, _claude_context_window as _claude_context_window, _largest_model_context_window as _largest_model_context_window, _model_context_candidate as _model_context_candidate, _model_work as _model_work, cli_failure_reason as cli_failure_reason, _cli_output_text as _cli_output_text, _trimmed_failure_reason as _trimmed_failure_reason, _stdout_failure_reason as _stdout_failure_reason, _claude_failure_reason as _claude_failure_reason, _failure_part as _failure_part, parse_codex_json_stream as parse_codex_json_stream, _parse_codex_events as _parse_codex_events, _apply_codex_event as _apply_codex_event, _codex_input_tokens as _codex_input_tokens, _codex_stream_text as _codex_stream_text, parse_antigravity_json_stream as parse_antigravity_json_stream, _parse_antigravity_events as _parse_antigravity_events, _apply_antigravity_event as _apply_antigravity_event, _append_antigravity_delta as _append_antigravity_delta, _replace_antigravity_result as _replace_antigravity_result, _antigravity_result_response as _antigravity_result_response, _antigravity_input_tokens as _antigravity_input_tokens, _antigravity_stream_text as _antigravity_stream_text
from .external_llm_stream_events import claude_user_event as claude_user_event, _DeltaTap as _DeltaTap, _stream_event_from_line as _stream_event_from_line, _claude_stream_event as _claude_stream_event, _claude_text_delta as _claude_text_delta, _codex_agent_message_text as _codex_agent_message_text, _antigravity_agent_delta as _antigravity_agent_delta, _claude_generation_cmdline as _claude_generation_cmdline, _codex_generation_cmdline as _codex_generation_cmdline, _antigravity_generation_cmdline as _antigravity_generation_cmdline
from .external_llm_generation import build_cmdline as build_cmdline, _decoded_staged_image as _decoded_staged_image, _close_staging_fd as _close_staging_fd, _unlink_staging_path as _unlink_staging_path, _write_staged_image as _write_staged_image, _stage_image_files as _stage_image_files, _unlink_all as _unlink_all, _generation_inputs as _generation_inputs, _staged_generation_images as _staged_generation_images, _generation_cmdline as _generation_cmdline, _generation_wire_prompt as _generation_wire_prompt, _agent_has_claude_images as _agent_has_claude_images, _checked_agent_cmdline as _checked_agent_cmdline, _agent_codex_mcp_url as _agent_codex_mcp_url, _agent_child_environment as _agent_child_environment, _start_agent_cli as _start_agent_cli, _drain_agent_cli as _drain_agent_cli, _agent_cli_result as _agent_cli_result, _run_generation_cli as _run_generation_cli, _parsed_generation_text as _parsed_generation_text, _generation_result as _generation_result
from .external_llm_protocol import _NATIVE_TOOLS_NOTE as _NATIVE_TOOLS_NOTE, _TOOL_PROTOCOL as _TOOL_PROTOCOL, _TOOL_REMINDER as _TOOL_REMINDER, _bare_tool_call_name as _bare_tool_call_name, _bare_tool_calls as _bare_tool_calls, _explicit_tool_calls as _explicit_tool_calls, _raw_tool_calls as _raw_tool_calls, _recover_object as _recover_object, _render_catalog_line as _render_catalog_line, _tool_arguments as _tool_arguments, _tool_call_from_raw as _tool_call_from_raw, generate_external as generate_external, generate_external_stream as generate_external_stream, parse_tool_calls as parse_tool_calls, render_catalog as render_catalog
from .external_llm_round import _write_call_file as _write_call_file, _system_prompt_path as _system_prompt_path, _uses_bridge_mcp as _uses_bridge_mcp, _requires_mcp_config as _requires_mcp_config, _bridge_mcp_url as _bridge_mcp_url, _hub_mcp_address as _hub_mcp_address, _mcp_config_path as _mcp_config_path, _codex_image_paths as _codex_image_paths, _codex_images_are_ready as _codex_images_are_ready, _codex_hub_address as _codex_hub_address, _remove_call_paths as _remove_call_paths, _latest_user_message as _latest_user_message, _is_image_handoff as _is_image_handoff, _validate_frame_request as _validate_frame_request, _guarded_compacted_messages as _guarded_compacted_messages, _stream_images as _stream_images, _delivered_frame_images as _delivered_frame_images, _validate_delivered_frame as _validate_delivered_frame, _stream_tap as _stream_tap, _codex_tool_aliases as _codex_tool_aliases, _rendered_stream_messages as _rendered_stream_messages, _native_bridge_tools as _native_bridge_tools, _hub_source_tools as _hub_source_tools, _hub_tools as _hub_tools, _hub_tool_names as _hub_tool_names, _protocol_tools as _protocol_tools, _open_hub as _open_hub, _captured_hub_calls as _captured_hub_calls, _close_hub as _close_hub, _should_retry_empty_antigravity as _should_retry_empty_antigravity, _require_antigravity_output as _require_antigravity_output, _parse_stream_response as _parse_stream_response, _reverse_codex_aliases as _reverse_codex_aliases, _stream_calls as _stream_calls, _restore_tool_call_arguments as _restore_tool_call_arguments, _restored_answer_text as _restored_answer_text
def _room_system_text(messages: list[Message]) -> str:
    """Join the non-empty system instructions supplied by the room."""
    return "\n\n".join(
        (message.get("content") or "").strip()
        for message in messages
        if message.get("role") == "system" and (message.get("content") or "").strip()
    )


def _system_prompt_parts(
    messages: list[Message], tools: list[dict[str, Any]], native: bool
) -> list[str]:
    """Collect independent prompt sections in their stable wire order."""
    room = _room_system_text(messages)
    parts = [room] if room else []
    if tools:
        parts.append(_TOOL_PROTOCOL.format(catalog=render_catalog(tools)))
    if native:
        parts.append(_NATIVE_TOOLS_NOTE)
    return parts


class ExternalChatModel:
    """A cloud CLI behind the local engine's ``ChatModel`` seam.

    One :meth:`stream` call = one ``claude -p`` / ``codex exec`` process. The
    CLI is stateless per call, so each round re-sends the composed transcript —
    the same thing the Ollama path does over the wire, just flattened to text.

    LIVE-streamed since 2026-08-27: a :class:`_DeltaTap` on stdout forwards
    answer text to ``on_delta`` while the CLI writes (token deltas from Claude
    and Antigravity, per completed message from Codex). The old buffer-it-all
    rule existed because "a half-streamed envelope would spray JSON into the
    transcript" — the tap's withhold-JSON-shaped-messages guard is what retired
    it. The buffered terminal parse below stays the source of truth for what
    the round meant; :meth:`_DeltaTap.finish` reconciles the two so the answer
    is never delivered twice.

    Images ride along on the engines that have a channel (:data:`IMAGE_ENGINES`
    — Claude as stream-json content blocks, Codex as staged ``-i`` files);
    Antigravity keeps the honest not-sent note.
    """

    def __init__(
        self,
        model: str,
        temperature: float | None = None,
        *,
        max_context: int | None = None,
        mcp_url: str = "",
        mcp_token: str = "",
    ) -> None:
        # `temperature` is accepted so this seam matches the local engine's
        # ChatModel signature, and then deliberately dropped: neither CLI has a
        # temperature flag (`claude -p` has none, and Codex's `-c` knobs are
        # effort and verbosity), so there is nothing to pass it to. Storing it
        # only made the room's Creativity slider LOOK connected here.
        self.composite_model = model
        self.model = model
        self.engine, self.submodel, self.effort = split_external_model(model)
        #: Display-only: the token bar's denominator, as resolved by the host.
        #: Never a cap — nothing here truncates or refuses on its account.
        self.max_context = max_context or DISPLAY_CONTEXT_FALLBACK
        #: The window someone actually STATED — the host's resolved catalog
        #: value. None while `max_context` is only the display fallback.
        #: Compaction budgets against this and nothing else: guessing a window
        #: and then trimming a conversation to fit the guess is how facts get
        #: lost.
        #:
        #: NOT updated from an engine's per-turn report, because ONE instance
        #: serves every agent of a run: under `ask_agents` two children stream
        #: concurrently, and a turn can even span two models (see
        #: `parse_claude_json_result`). Storing that here published one child's
        #: denominator to the other's token bar and budgeted its next
        #: compaction against a window it never had. The reported window is a
        #: fact about ONE round, so it travels with that round instead.
        self._stated_context: int | None = max_context
        #: The room bridge, handed to Claude as a REAL MCP server for the
        #: rounds that offer room tools (see :meth:`stream`).
        self.mcp_url = mcp_url
        self.mcp_token = mcp_token
        #: PRIV-1: the /run handler attaches the room's policy here. A CLI is a
        #: non-local model, so the door engages exactly as it does for `:cloud`.
        self.privacy: Any = None

    async def _digest(self, text: str, cancel: Optional[Any] = None) -> str:
        """One compaction pass, through this CLI itself.

        A pass here is a whole process, not a request, so it is the expensive
        kind. That is exactly why ``digest_chunk_bytes`` sizes a cloud pass to
        the engine's own (large) window: a long conversation becomes one or two
        passes rather than the dozen a small local window would need.

        ``cancel`` travels with it so Stop takes the pass that is ALREADY
        running, not merely the ones after it.
        """
        from .compaction import DIGEST_PROMPT

        return await generate_external(
            self.composite_model,
            [
                {"role": "system", "content": DIGEST_PROMPT},
                {"role": "user", "content": text},
            ],
            cancel=cancel,
        )

    async def _compact(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]],
        window: int | None,
        cancel: Optional[Any] = None,
    ) -> list[Message]:
        """Compress the older half of a long conversation before it goes out.

        A CLI is stateless per call, so EVERY round re-sends the whole composed
        transcript — which on a metered engine is the same bytes billed again
        and again. Measured 2026-07-28: a compacted 12 KB transcript matched a
        raw 176 KB one on the large model (4/4 ties) at 19x fewer prompt
        tokens. Nothing is amputated; if the digest fails, or if no real window
        was ever stated, the full transcript goes out exactly as it does today.

        ``window`` is the round's own budget denominator, passed in rather than
        read off the instance — one instance serves every concurrent agent.

        STOP REACHES IN HERE. Each pass is a whole CLI process bounded only by
        ``EXTERNAL_IDLE_SECS``, so a stopped turn that kept digesting kept
        spawning and paying for sessions the user had already abandoned.
        """
        from .budget import json_chars
        from .compaction import (
            CLOUD_SPEND_FRACTION,
            compact_to_budget,
            digest_chunk_bytes,
            fit_budget_bytes,
        )

        if _stopped(cancel):
            return messages

        async def digest(text: str) -> str:
            # Raised, not returned empty: an empty digest would be filed as a
            # stretch that "could not be summarised", and this one was never
            # attempted. `compact_to_budget` treats the failure as uncached, so
            # nothing about the abandoned turn is remembered.
            if _stopped(cancel):
                raise _Stopped()
            return await self._digest(text, cancel)

        reserved = json_chars(tools) if tools else 0
        out, _did = await compact_to_budget(
            messages,
            fit_budget_bytes(window, reserved, CLOUD_SPEND_FRACTION),
            digest,
            reserved,
            digest_chunk_bytes(window, cloud=True),
        )
        # A run that was stopped part-way through compaction has a transcript
        # with holes in it. The round is about to return empty anyway; hand back
        # what came in rather than a half-digested history.
        return messages if _stopped(cancel) else out

    @property
    def _takes_system_prompt(self) -> bool:
        """Claude replaces its system prompt from a file; Codex has no such
        flag, so its instructions ride the stdin prompt as before."""
        return self.engine == "claude-cli"

    def _prompt(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]],
        *,
        deliver_images: bool = False,
    ) -> str:
        """The conversation for one round, as one flat prompt on stdin.

        The CATALOG lives in the system prompt (:meth:`_system`) — it needs the
        authority to outrank the CLI's own agent framing. But authority is not
        the same as position: with the protocol only up there, the main agent
        stopped emitting envelopes altogether and answered from memory (live
        QA 2026-07-24, both failure directions observed in one sitting). So the
        last thing before generation is a one-line reminder of the two branches.
        """
        base = flatten_agent_messages(
            messages,
            include_system=not self._takes_system_prompt,
            deliver_images=deliver_images,
        )
        if not tools:
            return base
        return base + "\n\n" + _TOOL_REMINDER

    def _system(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]],
        *,
        native: bool = False,
    ) -> str:
        """The SYSTEM prompt for one round: the room's own instructions plus,
        when tools are offered, the tool protocol.

        Claude Code ships an agent system prompt describing ITS tools; ours has
        to replace it (``--system-prompt``), not argue with it from a user turn.
        With no tools at all this is the hub's tool-less final round — "answer
        now" — so the protocol is omitted rather than offered empty.

        ``native``: this round's tools ride real MCP endpoints, so there is no
        envelope to teach — but the harness still has to be told that its own
        world is not this one (:data:`_NATIVE_TOOLS_NOTE`).
        """
        # NOT `elif`. The two are independent facts: `tools` here is only what is
        # left on the TEXT protocol, while `native` says real MCP endpoints are
        # mounted this round. A round can have both — any tool the room bridge
        # does not serve stays on the envelope while delegation rides the hub —
        # and the `elif` silently dropped the note in exactly that case.
        #
        # The note is what forbids "I can't browse the web" / "I have no way to
        # inspect MCP servers". Live QA 2026-07-30: cloud Main denied BOTH while
        # `include_browse_tools()` and the MCP-management gate were serving those
        # tools to it (room_mcp.rs — CloudEngine is in both). The capability was
        # present and the sentence that says so was not.
        return "\n\n".join(_system_prompt_parts(messages, tools, native))

    async def _run(
        self,
        prompt: str,
        cancel: Optional[Any],
        system: str = "",
        bridge_tools: list[str] | None = None,
        hub: HubToolServer | None = None,
        hub_tools: list[str] | None = None,
        images: list[str] | None = None,
        tap: "_DeltaTap | None" = None,
    ) -> str:
        """One CLI process, killed on Stop or after going silent.

        ``system`` rides a temp FILE rather than argv: it carries the room's
        instructions and the tool catalog (kilobytes, arbitrary user text), so
        quoting it into a `zsh -ilc` command line would be both fragile and an
        injection surface. ``bridge_tools`` names this agent's box, handed to
        Claude as a real MCP allowlist; ``hub`` is the per-round captured-tool
        endpoint (:mod:`.hub_mcp`). Claude uses it for delegation and Codex
        uses it for its entire exact scoped catalog.

        ``images`` are the round's deliverable pixels: Claude takes them as
        base64 blocks on stdin, Codex as staged temp files (decrypted room
        content, so they are removed with the other per-call files below on
        EVERY exit). ``tap`` is the live delta feed.

        All files live for the call only.
        """
        from .llm import LlmError  # local import: llm.py imports this module

        paths: list[str] = []
        try:
            system_path = _system_prompt_path(system, paths)
            mcp_path = _mcp_config_path(
                bridge_tools, self.mcp_url, self.mcp_token, hub, paths
            )
            image_paths = _codex_image_paths(self.engine, images)
            paths.extend(image_paths)
            if not _codex_images_are_ready(self.engine, images, image_paths):
                raise LlmError(
                    "ENGINE_ERROR",
                    "Codex image pixels could not be staged, so visual "
                    "interpretation stopped before model dispatch.",
                )
            return await self._spawn(
                prompt,
                cancel,
                system_path,
                mcp_path,
                bridge_tools or [],
                hub_tools=hub_tools or [],
                codex_mcp=_codex_hub_address(self.engine, hub),
                images=images or [],
                image_paths=image_paths,
                tap=tap,
            )
        finally:
            _remove_call_paths(paths)

    async def _spawn(
        self,
        prompt: str,
        cancel: Optional[Any],
        system_path: str | None,
        mcp_path: str | None = None,
        allowed: list[str] | None = None,
        hub_tools: list[str] | None = None,
        codex_mcp: tuple[str, str] | None = None,
        images: list[str] | None = None,
        image_paths: list[str] | None = None,
        tap: "_DeltaTap | None" = None,
    ) -> str:
        claude_images = _agent_has_claude_images(self.engine, images)
        cmdline = _checked_agent_cmdline(
            self.engine,
            self.submodel,
            self.effort,
            system_path,
            mcp_path,
            allowed,
            hub_tools,
            codex_mcp,
            claude_images,
            image_paths,
        )
        proc = await _start_agent_cli(
            self.engine, cmdline, _agent_child_environment(codex_mcp)
        )
        idle = external_idle_secs()
        stdout, stderr = await _drain_agent_cli(
            proc,
            self.engine,
            _generation_wire_prompt(self.engine, prompt, images or []),
            idle,
            cancel,
            tap,
        )
        return _agent_cli_result(self.engine, proc, stdout, stderr, cancel)

    async def _invoke_stream(
        self,
        prompt: str,
        system: str,
        cancel: Optional[Any],
        native: list[str],
        hub: HubToolServer | None,
        hub_names: list[str],
        images: list[str],
        tap: _DeltaTap,
    ) -> str:
        """Run one prepared CLI request through its engine-specific system channel."""
        if self._takes_system_prompt:
            return await self._run(
                prompt,
                cancel,
                system,
                native,
                hub=hub,
                hub_tools=hub_names,
                images=images,
                tap=tap,
            )
        combined = f"{system}\n\n{prompt}" if system else prompt
        return await self._run(
            combined,
            cancel,
            hub=hub,
            hub_tools=hub_names,
            images=images,
            tap=tap,
        )

    async def _retry_empty_antigravity(
        self,
        stdout: str,
        prompt: str,
        system: str,
        cancel: Optional[Any],
        native: list[str],
        hub: HubToolServer | None,
        hub_names: list[str],
        images: list[str],
        tap: _DeltaTap,
    ) -> str:
        """Retry exactly once when Antigravity exits successfully without text."""
        if not _should_retry_empty_antigravity(self.engine, stdout, cancel):
            return stdout
        retried = await self._invoke_stream(
            prompt, system, cancel, native, hub, hub_names, images, tap
        )
        _require_antigravity_output(retried)
        return retried

    async def _run_stream_request(
        self,
        prompt: str,
        system: str,
        cancel: Optional[Any],
        native: list[str],
        hub_tools: list[dict[str, Any]],
        hub_names: list[str],
        images: list[str],
        tap: _DeltaTap,
    ) -> tuple[str, list[tuple[str, dict[str, Any]]]]:
        """Run a round and close its native-tool capture endpoint on every path."""
        hub = _open_hub(hub_tools, hub_names)
        try:
            stdout = await self._invoke_stream(
                prompt, system, cancel, native, hub, hub_names, images, tap
            )
            stdout = await self._retry_empty_antigravity(
                stdout,
                prompt,
                system,
                cancel,
                native,
                hub,
                hub_names,
                images,
                tap,
            )
            return stdout, _captured_hub_calls(hub)
        finally:
            _close_hub(hub)

    async def _finish_stream(
        self,
        captured: list[tuple[str, dict[str, Any]]],
        aliases: dict[str, str],
        text: str,
        tools: list[dict[str, Any]],
        tap: _DeltaTap,
        engaged: Any,
        input_tokens: int | None,
        window: int | None,
    ) -> tuple[str, list[ToolCall], Any]:
        """Return tool machinery or a restored answer without double-delivery."""
        calls = _stream_calls(captured, aliases, self.engine, text, tools)
        if calls:
            _restore_tool_call_arguments(calls, engaged)
            await tap.flush()
            return "", calls, self._usage(input_tokens, window)
        await tap.finish(text)
        return _restored_answer_text(text, engaged), [], self._usage(input_tokens, window)

    async def stream(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]],
        on_delta: Any,
        cancel: Optional[Any] = None,
    ) -> tuple[str, list[ToolCall], Any]:
        # PRIV-1: same door as every other non-local model — the composed
        # history goes out redacted, the reply comes back restored. The door
        # pops images and stamps `images_blocked`, so a door-on room collects
        # nothing below and the flattened turns say the pixels were withheld.
        frame_handoff = _validate_frame_request(
            self.engine, _latest_user_message(messages)
        )
        send, engaged = await _guarded_compacted_messages(self, messages, tools, cancel)
        if _stopped(cancel):
            return "", [], self._usage()
        # AFTER compaction: a digested turn has no pixels left to deliver, so
        # what is collected is exactly what the delivered-mode notes describe.
        images = _stream_images(self.engine, send)
        _validate_delivered_frame(frame_handoff, _delivered_frame_images(send))
        # The live feed: answer text reaches the user while the CLI writes,
        # restored through the same door the buffered reply passes.
        tap = _stream_tap(self.engine, on_delta, engaged)
        codex_aliases = _codex_tool_aliases(self.engine, tools)
        rendered_messages = _rendered_stream_messages(
            self.engine, send, codex_aliases
        )
        # WHICH TOOLS ARE REAL. Claude Code is an agent harness: describe a tool
        # to it and it CALLS it through its own machinery — live QA 2026-07-24
        # showed a worker doing exactly that and reporting back "No such tool
        # available: search_mcp_tools" (its runtime's words, not ours). So room
        # tools are given to it as REAL MCP tools on the room bridge, scoped by
        # an allowlist to this agent's box, and it drives them natively.
        # …AND SO IS DELEGATION. Live QA 2026-07-25 proved the exemption above
        # was wrong: handed ask_jobs_agent in prose, Claude Code answered "the
        # automation tool isn't responding" without ever emitting an envelope
        # or running a worker. A harness calls tools; it does not narrate them.
        # So the hub's own tools get a real endpoint too (see `hub_mcp`) — it
        # CAPTURES the call and we return it as an ordinary ToolCall, leaving
        # graph.py to run the specialist exactly as it does for a local model.
        # Claude needs this endpoint only for delegation because its room MCP
        # bridge executes specialist tools directly. Codex receives EVERY
        # offered tool here: the endpoint exposes the exact per-agent box and
        # captures calls for graph.py to execute through Arcelle's normal
        # approval and commit gates. This avoids the unreliable prose-only
        # catalog that made Codex deny rename/organize capabilities.
        native = _native_bridge_tools(self._takes_system_prompt, self.mcp_url, tools)
        hub_source_tools = _hub_source_tools(self.engine, tools)
        hub_tools = _hub_tools(self.engine, hub_source_tools, codex_aliases)
        hub_names = _hub_tool_names(hub_tools)
        # Whatever neither channel can serve natively stays on the text
        # protocol. Antigravity uses this equivalent fallback because its
        # print mode exposes no per-invocation MCP-config flag.
        protocol_tools = _protocol_tools(tools, native, hub_source_tools)
        system = self._system(
            rendered_messages, protocol_tools, native=bool(native or hub_names)
        )
        prompt = self._prompt(
            rendered_messages, protocol_tools, deliver_images=bool(images)
        )
        stdout, captured = await self._run_stream_request(
            prompt,
            system,
            cancel,
            native,
            hub_tools,
            hub_names,
            images,
            tap,
        )
        if cancel is not None and getattr(cancel, "cancelled", False):
            return "", [], self._usage()
        text, input_tokens, window = _parse_stream_response(self.engine, stdout)
        # The engine's own report wins over the host's hint for THIS round:
        # Claude states its real window per turn (a 1M-context model is not a
        # 200k one), and no assumption here can beat that. It stays a local —
        # see `_stated_context` for the concurrent children it used to cross.
        # A NATIVE delegation wins over anything the harness wrote around it:
        # the call already happened, so trailing prose ("I've asked the Jobs
        # agent…") is narration about machinery, exactly what branch (A) drops.
        # The text protocol stays as the fallback for Codex and for a Claude
        # round that answered in an envelope anyway.
        return await self._finish_stream(
            captured,
            codex_aliases,
            text,
            tools,
            tap,
            engaged,
            input_tokens,
            window,
        )

    def _usage(self, input_tokens: int | None = None, window: int | None = None) -> Any:
        """The round's accounting: the CLI's own prompt-token count when its
        envelope carried one (``is_real``), else the caller's char estimate.
        ``max_context`` is the window THIS round's engine stated, or the host's
        hint — passed in, never stored, because one instance serves every agent
        of a run.
        """
        from .chat import RoundUsage

        return RoundUsage(
            input_tokens=input_tokens,
            max_context=window or self.max_context,
            is_real=input_tokens is not None,
        )


__all__ = [
    "EXTERNAL_ENGINES",
    "EXTERNAL_IDLE_SECS",
    "IMAGE_ENGINES",
    "MAX_IMAGES_PER_MESSAGE",
    "CODEX_ARCELLE_FLAGS",
    "DISPLAY_CONTEXT_FALLBACK",
    "ExternalChatModel",
    "external_idle_secs",
    "drain_with_idle",
    "fenced_cmdline",
    "strip_shell_banner",
    "build_agent_cmdline",
    "claude_result_object",
    "claude_user_event",
    "collect_images",
    "message_images",
    "parse_claude_json_result",
    "parse_codex_json_stream",
    "parse_antigravity_json_stream",
    "parse_tool_calls",
    "render_catalog",
    "split_external_model",
    "is_external_model",
    "flatten_messages",
    "flatten_agent_messages",
    "build_cmdline",
    "generate_external",
    "generate_external_stream",
]
