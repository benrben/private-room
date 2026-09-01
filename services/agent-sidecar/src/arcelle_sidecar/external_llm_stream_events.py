"""Streaming event decoding and one-shot CLI command fragments."""

from __future__ import annotations

import codecs
import json
from typing import Any

from .external_llm_cli import _OUTPUT_FENCE, _image_flags


def claude_user_event(prompt: str, images: list[str]) -> str:
    """One stream-json input line: the flattened prompt plus its base64 image
    blocks — Claude's ONLY pixel channel while its own file tools are fenced
    off. Live-verified 2026-08-27 (a staged red PNG answered "Red")."""
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for b64 in images:
        content.append(
            {
                "type": "image",
                "source": {"type": "base64", "media_type": "image/png", "data": b64},
            }
        )
    return (
        json.dumps({"type": "user", "message": {"role": "user", "content": content}})
        + "\n"
    )


class _DeltaTap:
    """Live text deltas out of one CLI's stdout WHILE it streams.

    Fed raw stdout chunks by :func:`_pump`; splits them into the engine's NDJSON
    events and forwards ANSWER text to ``sink`` as it is written — the module
    used to hold the whole reply back ("a half-streamed envelope would spray
    JSON into the transcript"), and the two guards below are what make live
    forwarding safe instead:

    - a message whose first non-space character is ``{``/``[`` is WITHHELD in
      full — that is exactly the shape of a text-protocol tool envelope (and of
      a legitimate JSON answer, which the terminal parse still delivers whole
      via :meth:`finish`);
    - the moment ``"tool_call`` appears in a prose message, forwarding stops
      for the round — a framed envelope after a narration preamble must not
      reach the transcript as text.

    Interim assistant messages (a harness narrating between its tool calls)
    ARE forwarded: the local engine already streams every round's text, the
    live bubble is replaced by the persisted answer when the turn lands, and a
    working harness showing its progress beats minutes of silence.

    ``restorer`` is the privacy stream-restorer for this round, when the door
    is engaged — deltas leave the model redacted and must reach the user real.
    Nothing here parses tool calls or usage; the buffered terminal parse stays
    the single source of truth for what the round MEANT.
    """

    def __init__(self, engine: str, sink: Any, restorer: Any = None) -> None:
        self.engine = engine
        self.sink = sink
        self.restorer = restorer
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._pending = ""  # a partial NDJSON line straddling two chunks
        self._fenced = False  # past the login shell's banner?
        self._msg_raw = ""  # the current message's full raw text
        self._msg_sent = ""  # the part of it already forwarded (raw)
        self._withheld = False  # current message held back (JSON-shaped)
        self._blocked = False  # saw a tool-call marker: stop for the round
        self._event_handler = {
            "claude-cli": self._handle_claude_event,
            "codex-cli": self._handle_codex_event,
            "antigravity-cli": self._handle_antigravity_event,
        }.get(engine)

    async def feed(self, chunk: bytes) -> None:
        self._pending += self._decoder.decode(chunk)
        while "\n" in self._pending:
            line, self._pending = self._pending.split("\n", 1)
            await self._line(line)

    async def _line(self, line: str) -> None:
        if not self._past_output_fence(line):
            return
        event = _stream_event_from_line(line)
        if event is None:
            return
        if self._event_handler is None:
            return
        await self._event_handler(event)

    def _past_output_fence(self, line: str) -> bool:
        """Ignore login-shell output through the fence line itself."""
        if self._fenced:
            return True
        # A banner without a trailing newline glues itself onto this marker.
        if _OUTPUT_FENCE in line:
            self._fenced = True
        return False

    async def _handle_claude_event(self, event: dict[str, Any]) -> None:
        stream_event = _claude_stream_event(event)
        if stream_event is None:
            return
        if stream_event.get("type") == "message_start":
            await self._new_message()
            return
        text = _claude_text_delta(stream_event)
        if text is not None:
            await self._delta(text)

    async def _handle_codex_event(self, event: dict[str, Any]) -> None:
        # Codex has no token deltas: each completed agent message is progress.
        text = _codex_agent_message_text(event)
        if text is None:
            return
        await self._new_message()
        await self._delta(text)

    async def _handle_antigravity_event(self, event: dict[str, Any]) -> None:
        text = _antigravity_agent_delta(event)
        if text is not None:
            await self._delta(text)

    async def _delta(self, s: str) -> None:
        if not s:
            return
        self._msg_raw += s
        if self._should_withhold_delta():
            return
        if self._has_tool_call_marker():
            self._blocked = True
            return
        await self._emit_unsent_message()

    def _should_withhold_delta(self) -> bool:
        """Whether this fragment is machinery or lacks a meaningful first character."""
        if self._stream_is_blocked():
            return True
        if not self._msg_raw.lstrip():
            return True  # the first-character test must wait for non-whitespace
        if self._message_starts_with_json():
            self._withheld = True
            return True
        return False

    def _stream_is_blocked(self) -> bool:
        """Whether this message has already become non-transcript machinery."""
        return self._blocked or self._withheld

    def _message_starts_with_json(self) -> bool:
        """Recognize a text-protocol envelope before forwarding any of it."""
        if self._msg_sent:
            return False
        stripped = self._msg_raw.lstrip()
        if not stripped:
            return False
        return stripped[0] in "{["

    def _has_tool_call_marker(self) -> bool:
        """Recognize a framed tool envelope after a prose preamble."""
        return '"tool_call' in self._msg_raw

    async def _emit_unsent_message(self) -> None:
        """Forward the newly appended portion of the current prose message."""
        out = self._msg_raw[len(self._msg_sent) :]
        self._msg_sent = self._msg_raw
        await self._emit(out)

    async def _emit(self, text: str) -> None:
        if self.restorer is not None:
            text = self.restorer.feed(text)
        if text:
            await self.sink(text)

    async def _new_message(self) -> None:
        await self.flush()
        self._msg_raw = ""
        self._msg_sent = ""
        self._withheld = False

    async def flush(self) -> None:
        """Release the restorer's held-back tail (a possible partial
        placeholder) — on a message boundary and at the end of the round."""
        if self.restorer is not None:
            tail = self.restorer.flush()
            if tail:
                await self.sink(tail)

    def tail_for(self, final_raw: str) -> str:
        """What of the round's FINAL text was never forwarded live.

        The terminal parse is the source of truth; live deltas are only its
        preview. When the final text extends what was streamed, the remainder
        is owed; when it was withheld (or the engine emitted no usable deltas),
        all of it is; when the stream already delivered it — nothing, or the
        transcript would show the answer twice.
        """
        if not final_raw:
            return ""
        return self._unstreamed_tail(final_raw)

    def _unstreamed_tail(self, final_raw: str) -> str:
        """Reconcile terminal text with the last raw portion sent live."""
        sent = self._msg_sent
        if not sent:
            return final_raw
        if final_raw.startswith(sent):
            return final_raw[len(sent) :]
        if sent.startswith(final_raw):
            return ""
        return final_raw

    async def finish(self, final_raw: str) -> None:
        """Deliver the unstreamed remainder of the final text, then flush."""
        tail = self.tail_for(final_raw)
        if tail:
            await self._emit(tail)
        await self.flush()


def _stream_event_from_line(line: str) -> dict[str, Any] | None:
    """Parse one complete NDJSON event while ignoring shell noise."""
    line = line.strip()
    if not line.startswith("{"):
        return None
    try:
        event = json.loads(line)
    except ValueError:  # a partial or non-JSON line among the events
        return None
    return event if isinstance(event, dict) else None


def _claude_stream_event(event: dict[str, Any]) -> dict[str, Any] | None:
    """Return Claude's nested stream event when this is its wrapper."""
    if event.get("type") != "stream_event":
        return None
    nested = event.get("event")
    return nested if isinstance(nested, dict) else None


def _claude_text_delta(event: dict[str, Any]) -> str | None:
    """Return public Claude text, never private thinking or signatures."""
    if event.get("type") != "content_block_delta":
        return None
    delta = event.get("delta")
    if not isinstance(delta, dict) or delta.get("type") != "text_delta":
        return None
    text = delta.get("text")
    return text if isinstance(text, str) else None


def _codex_agent_message_text(event: dict[str, Any]) -> str | None:
    """Return a completed Codex agent message, if this event carries one."""
    if event.get("type") != "item.completed":
        return None
    item = event.get("item")
    if not isinstance(item, dict):
        return None
    if item.get("type") != "agent_message":
        return None
    text = item.get("text")
    return text if isinstance(text, str) else None


def _antigravity_agent_delta(event: dict[str, Any]) -> str | None:
    """Return a public Antigravity agent-response delta, if present."""
    if event.get("event") != "step_update":
        return None
    update = event.get("step_update")
    if not isinstance(update, dict):
        return None
    if update.get("step_type") != "agent_response":
        return None
    text = update.get("text_delta")
    return text if isinstance(text, str) else None


def _claude_generation_cmdline(
    submodel: str | None, effort: str | None, stream_json_input: bool
) -> str:
    """Build Claude's one-shot streamed invocation."""
    model_flag = f" --model '{submodel}'" if submodel else ""
    effort_flag = f" --effort '{effort}'" if effort else ""
    input_flag = " --input-format stream-json" if stream_json_input else ""
    return (
        f"claude -p --output-format stream-json --verbose "
        f"--include-partial-messages{input_flag}{model_flag}{effort_flag}"
    )


def _codex_generation_cmdline(
    submodel: str | None, effort: str | None, image_paths: list[str] | None
) -> str:
    """Build Codex's one-shot JSON invocation."""
    model_flag = f" --model '{submodel}'" if submodel else ""
    effort_flag = f" -c 'model_reasoning_effort={effort}'" if effort else ""
    return f"codex exec --json --skip-git-repo-check{model_flag}{effort_flag}{_image_flags(image_paths)} -"


def _antigravity_generation_cmdline(submodel: str | None) -> str:
    """Build Antigravity's one-shot streamed invocation."""
    model_flag = f" --model '{submodel}'" if submodel else ""
    return (
        "agy --sandbox --mode plan --input-format stream-json "
        f"--output-format stream-json --print-timeout 5m{model_flag}"
    )
