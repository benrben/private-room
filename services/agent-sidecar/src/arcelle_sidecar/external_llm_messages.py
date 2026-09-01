"""CLI process draining and message flattening."""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from typing import Any, Optional

from .messages import Message
def _facade_module() -> Any:
    from . import external_llm

    return external_llm


EXTERNAL_ENGINES = ("claude-cli", "codex-cli", "antigravity-cli")

#: How long an external CLI may produce NOTHING before it is presumed wedged.
#:
#: This is a LIVENESS deadline, not a duration ceiling, and the difference is
#: the whole point. It replaced a hard 300s wall-clock kill whose docstring
#: called the call "one generation" — true of Ollama, false of a harness. One
#: ``claude -p`` spawn is an ENTIRE agentic session: it reads files, drives its
#: own tool loop and spawns its own sub-agents. Measured against that, any
#: duration cap kills healthy work and reports it to the user as a failure,
#: which is exactly what it did.
#:
#: Silence is the honest signal instead. Both engines run in a streaming
#: envelope (``claude --output-format stream-json``, ``codex exec --json``), so
#: a working CLI emits an NDJSON event every few seconds — init, each assistant
#: turn, each tool use — and the clock resets on every byte of stdout OR
#: stderr. A run may now take an hour; only a corpse goes quiet for a quarter of
#: one. :func:`external_idle_secs` raises it without a rebuild.
#:
#: ONE path has no heartbeat: `build_cmdline` (the non-agent, one-shot gateway)
#: still runs plain ``claude -p``, which prints its answer only at the end. That
#: is left alone deliberately — it is a single generation, not a tool loop, so
#: the budget below is the whole bound rather than a between-events one, and
#: fifteen minutes of silence for one completion really is wedged. Give it the
#: streamed envelope too if that ever stops being true.
EXTERNAL_IDLE_SECS: int = 900

#: The environment override for :data:`EXTERNAL_IDLE_SECS` (seconds).
EXTERNAL_IDLE_ENV = "ARCELLE_EXTERNAL_IDLE_SECS"

#: The pre-liveness name for the override. Still honored so a user who set it
#: when it meant "total run time" keeps a working setting; it now means idle
#: time, which is strictly more permissive, so nothing they had breaks.
EXTERNAL_TIMEOUT_ENV = "ARCELLE_EXTERNAL_TIMEOUT_SECS"

#: How often the drain loop wakes to check Stop and the idle deadline. Small
#: enough that Stop feels instant, large enough to cost nothing over an hour.
_POLL_SECS = 0.25

#: The engine/model/effort separator — a double colon, written as a regex so
#: the privacy suite's IPv6-wildcard-bind scan (which forbids a literal
#: double-colon STRING anywhere in this package) stays meaningful.
_SEP = re.compile(r":{2}")

#: The app imposes NO context limit on a cloud CLI — it manages its own window
#: (and compacts on its own when it fills). The only place a number is needed
#: is the token bar's denominator, and the host already resolves that one
#: (live from the Codex catalog, `model_limits.rs`) and sends it as
#: ``RunRequest.max_context``; this is the neutral display fallback used when
#: it didn't, identical to the one the local seam falls back to.
DISPLAY_CONTEXT_FALLBACK = 128_000


def external_idle_secs() -> float:
    """How long one CLI call may stay SILENT before it is killed.

    Read per call, so the default can be overridden without a rebuild; a
    missing, unparseable or non-positive value keeps the default. The current
    name wins over the legacy one when both are set.
    """
    facade = _facade_module()
    for name in (facade.EXTERNAL_IDLE_ENV, facade.EXTERNAL_TIMEOUT_ENV):
        try:
            override = float(os.environ.get(name, ""))
        except ValueError:
            continue
        if override > 0:
            return override
    return facade.EXTERNAL_IDLE_SECS


class _Wedged(Exception):
    """The child produced nothing for the idle budget. Carries no message —
    each caller words the ``ENGINE_ERROR`` in its own terms."""


class _Stopped(Exception):
    """The user pressed Stop, so this piece of work was never started."""


def _stopped(cancel: Optional[Any]) -> bool:
    """Has Stop been pressed for this round?"""
    return cancel is not None and bool(getattr(cancel, "cancelled", False))


async def _pump(
    reader: Any, sink: bytearray, beat: list[float], tap: Any = None
) -> None:
    """Drain one pipe into ``sink``, stamping ``beat`` on every chunk.

    Draining is not optional bookkeeping: a child whose stderr pipe fills
    blocks in ``write`` forever and would then look exactly like the wedge this
    module is trying to detect. ``read`` (not ``readline``) so a CLI that emits
    a partial line still counts as alive.

    ``tap`` (stdout only) sees every chunk AS IT ARRIVES — that is the whole
    live-streaming feature: :class:`_DeltaTap` turns the envelope events into
    text deltas while the buffer above keeps accumulating for the terminal
    parse, byte-identical to before.
    """
    while True:
        chunk = await reader.read(65536)
        if not chunk:
            return
        sink.extend(chunk)
        beat[0] = time.monotonic()
        if tap is not None:
            await tap.feed(chunk)


async def _feed(stdin: Any, payload: bytes) -> None:
    """Write the prompt and close stdin — the CLIs read to EOF before working."""
    try:
        stdin.write(payload)
        await stdin.drain()
    except (BrokenPipeError, ConnectionResetError):  # child died early; the
        pass  # returncode path reports the real reason
    finally:
        try:
            stdin.close()
        except Exception:  # noqa: BLE001 - already closed / already dead
            pass


def _drain_tasks(
    proc: Any,
    payload: bytes,
    out: bytearray,
    err: bytearray,
    beat: list[float],
    tap: Any,
) -> list[asyncio.Future[Any]]:
    return [
        asyncio.ensure_future(_feed(proc.stdin, payload)),
        asyncio.ensure_future(_pump(proc.stdout, out, beat, tap)),
        asyncio.ensure_future(_pump(proc.stderr, err, beat)),
        asyncio.ensure_future(proc.wait()),
    ]


async def _stop_drain(proc: Any, tasks: list[asyncio.Future[Any]]) -> None:
    for task in tasks:
        task.cancel()
    try:
        proc.kill()
    except (ProcessLookupError, OSError):  # already gone
        pass
    # Reap, so a killed child never lingers as a zombie holding its pipes.
    try:
        await asyncio.wait_for(proc.wait(), timeout=5)
    except Exception:  # noqa: BLE001 - best-effort reap
        pass


def _drain_result(
    done: set[asyncio.Future[Any]], out: bytearray, err: bytearray
) -> tuple[bytes, bytes]:
    # Surface a drain failure rather than returning the half of the output that
    # made it — a truncated envelope parses as a wrong answer, which is worse
    # than a reported error.
    for task in done:
        if task.exception() is not None:
            raise task.exception()  # type: ignore[misc]
    return bytes(out), bytes(err)


def _idle_expired(beat: list[float], idle: float) -> bool:
    return time.monotonic() - beat[0] >= idle


async def _drain_until_finished(
    proc: Any,
    tasks: list[asyncio.Future[Any]],
    out: bytearray,
    err: bytearray,
    beat: list[float],
    idle: float,
    cancel: Optional[Any],
) -> tuple[bytes, bytes]:
    while True:
        done, pending = await asyncio.wait(
            tasks, timeout=_facade_module()._POLL_SECS
        )
        if not pending:
            return _drain_result(done, out, err)
        if _facade_module()._stopped(cancel):
            await _stop_drain(proc, tasks)
            return b"", b""
        if _idle_expired(beat, idle):
            await _stop_drain(proc, tasks)
            raise _Wedged


async def drain_with_idle(
    proc: Any,
    payload: bytes,
    idle: float,
    cancel: Optional[Any] = None,
    tap: Any = None,
) -> tuple[bytes, bytes]:
    """``communicate()`` with a LIVENESS deadline instead of a duration one.

    Feeds stdin, drains both pipes concurrently, and returns
    ``(stdout, stderr)`` — byte-for-byte what ``proc.communicate(payload)``
    would have returned, so every downstream parser is untouched.

    Raises :class:`_Wedged` when nothing arrived on either pipe for ``idle``
    seconds, and returns ``(b"", b"")`` after killing the child when ``cancel``
    is tripped. Both leave the process dead, never orphaned.
    """
    out, err = bytearray(), bytearray()
    beat = [time.monotonic()]
    tasks = _drain_tasks(proc, payload, out, err, beat, tap)

    try:
        return await _drain_until_finished(proc, tasks, out, err, beat, idle, cancel)
    except asyncio.CancelledError:
        await _stop_drain(proc, tasks)
        raise


def split_external_model(model: str) -> tuple[str, str | None, str | None]:
    """``codex-cli / gpt-5.6-sol / high`` triple from the composite model id.

    A plain Ollama model name (single ``:`` tags, no double-colon separator)
    passes through as ``(model, None, None)`` — the engine-id guard is what
    matters, exactly like the Rust ``split_external_model``.
    """
    parts = _SEP.split(model, maxsplit=2)
    if parts[0] not in EXTERNAL_ENGINES:
        return model, None, None
    sub = parts[1] if len(parts) > 1 and parts[1] else None
    effort = parts[2] if len(parts) > 2 and parts[2] else None
    return parts[0], sub, effort


def is_external_model(model: str) -> bool:
    """True when the model string names a cloud CLI engine."""
    return split_external_model(model)[0] in EXTERNAL_ENGINES


#: How many attachments per turn are delivered to a CLI engine — the same cap
#: the Electron advisor path stages (`externalAdvisor.ts MAX_IMAGES_PER_MESSAGE`).
MAX_IMAGES_PER_MESSAGE = 3

#: Strict base64: standard alphabet, canonical padding, no whitespace. Anything
#: else is skipped rather than delivered — a lenient decode would announce a
#: corrupt attachment as an image the model should look at.
_B64_RE = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")

#: Which engines have a real image channel. Claude takes base64 blocks over
#: ``--input-format stream-json`` (live-verified 2026-08-27: a staged red PNG
#: came back "Red"); Codex takes staged files via ``-i`` under the same sandbox
#: flags the chat path pins (same live proof). Antigravity's print mode has no
#: documented image input, so it stays on the honest not-sent note.
IMAGE_ENGINES = ("claude-cli", "codex-cli")


def _is_deliverable_image(value: object) -> bool:
    """Whether one attachment is canonical base64 for a real image channel."""
    return (
        isinstance(value, str)
        and bool(value)
        and len(value) % 4 == 0
        and _B64_RE.match(value) is not None
    )


def message_images(m: Message) -> list[str]:
    """The images of one turn that can actually be DELIVERED: strictly valid
    base64 only, capped at :data:`MAX_IMAGES_PER_MESSAGE`."""
    out: list[str] = []
    for b64 in m.get("images") or []:
        if _is_deliverable_image(b64):
            out.append(b64)
        if len(out) == MAX_IMAGES_PER_MESSAGE:
            break
    return out


def collect_images(messages: list[Message]) -> list[str]:
    """Every deliverable image in the transcript, in transcript order — the
    order the flattened prompt's per-turn attachment notes describe."""
    return [
        b64
        for m in messages
        if m.get("role") == "user"
        for b64 in message_images(m)
    ]


def _blocked_image_turn(content: str, blocked: int) -> str:
    """Render the privacy door's honest attachment-withheld notice."""
    return (
        f"User: {content}\n"
        f"[{blocked} image(s) accompanied that message, but the room's privacy "
        f"settings withheld them — they were NOT sent. You have not seen them. "
        f"Do not describe them; say the privacy settings block images if asked.]\n"
    )


def _attached_image_turn(content: str, total: int, delivered: list[str]) -> str:
    """Render a turn whose valid pixels ride this very request."""
    note = (
        f"[{len(delivered)} image(s) from this turn are attached to this "
        f"request, in transcript order."
    )
    dropped = total - len(delivered)
    if dropped:
        note += f" {dropped} more could not be attached and were NOT sent — you have not seen those."
    return f"User: {content}\n{note}]\n"


def _undelivered_image_turn(content: str, total: int) -> str:
    """Render the explicit no-image-channel note for a user turn."""
    return (
        f"User: {content}\n"
        f"[{total} image(s) accompanied that message, but THIS engine cannot receive "
        f"images — they were NOT sent. You have not seen them. Do not describe them; "
        f"say you cannot see the page, or read it as text instead.]\n"
    )


def _delivered_turn_images(m: Message, deliver_images: bool) -> list[str]:
    """Return validated attachments only when this engine has a pixel lane."""
    return message_images(m) if deliver_images else []


def _user_turn(m: Message, content: str, *, deliver_images: bool = False) -> str:
    """One user turn, flattened — and HONEST about its pixels either way.

    The perception tools append ``IMAGE_HANDOFF`` ("the capture you requested is
    attached") to the turn and hang the PNG off ``images``, so whatever this
    renders must keep that sentence true. Three states:

    - the privacy door stripped the images (``images_blocked``, stamped by
      ``privacy.redact_messages``): say so — the model must not describe a
      picture the door withheld;
    - ``deliver_images`` and the engine has a channel: the images ride the same
      request (Claude: base64 blocks on stdin; Codex: staged ``-i`` files), so
      the note says they are attached;
    - no channel (Antigravity, or nothing deliverable survived validation):
      the original not-sent note. Rendering only ``content`` here shipped a
      prompt that ASSERTS an attachment the model never received, and a harness
      believes the prompt — live QA 2026-07-30: "the screenshot for the browser
      is not working" was this, silently, on every flattened engine.
    """
    blocked = int(m.get("images_blocked") or 0)
    if blocked:
        return _blocked_image_turn(content, blocked)
    n = len(m.get("images") or [])
    if not n:
        return f"User: {content}\n"
    delivered = _delivered_turn_images(m, deliver_images)
    if delivered:
        return _attached_image_turn(content, n, delivered)
    return _undelivered_image_turn(content, n)


def _append_one_shot_system_turn(
    out: list[str],
    _message: Message,
    content: str,
    _deliver_images: bool,
) -> None:
    """Append a one-shot system instruction turn."""
    out.append(f"Instructions:\n{content}\n")


def _append_one_shot_user_turn(
    out: list[str],
    message: Message,
    content: str,
    deliver_images: bool,
) -> None:
    """Append a one-shot user turn with its honest image-delivery note."""
    out.append(_user_turn(message, content, deliver_images=deliver_images))


def _append_one_shot_assistant_turn(
    out: list[str],
    _message: Message,
    content: str,
    _deliver_images: bool,
) -> None:
    """Append a one-shot assistant transcript turn."""
    out.append(f"Assistant: {content}\n")


_ONE_SHOT_TURN_RENDERERS = {
    "system": _append_one_shot_system_turn,
    "user": _append_one_shot_user_turn,
    "assistant": _append_one_shot_assistant_turn,
}


def flatten_messages(
    messages: list[Message],
    schema: dict[str, Any] | None,
    *,
    deliver_images: bool = False,
) -> str:
    """The Rust prompt convention: role-labelled turns, one flat text prompt.

    A ``format`` schema becomes a strict JSON-only instruction — the callers'
    ``recover_json`` cleans whatever wrapping the CLI still adds.
    ``deliver_images`` says the same request carries the turns' images on a real
    channel, so each turn's note reads "attached" instead of "not sent".
    """
    out: list[str] = []
    for m in messages:
        content = m.get("content", "") or ""
        renderer = _ONE_SHOT_TURN_RENDERERS.get(m.get("role", ""))
        if renderer is not None:
            renderer(out, m, content, deliver_images)
    if schema is not None:
        out.append(
            "Return ONLY a single JSON object matching this schema — no prose, "
            "no code fences, no explanation:\n"
            + json.dumps(schema, ensure_ascii=False)
            + "\n"
        )
    out.append("Respond to the last user message. Reply with the answer only.")
    return "\n".join(out)


def flatten_agent_messages(
    messages: list[Message],
    *,
    include_system: bool = True,
    deliver_images: bool = False,
) -> str:
    """The agent-loop transcript, flattened for a CLI that takes one text prompt.

    Unlike :func:`flatten_messages` (the one-shot generation path, which only
    ever sees system/user/assistant), a ROUND of the agent loop carries the
    machinery the loop is made of: the assistant turn that requested a tool and
    the ``role: "tool"`` result that came back. Dropping those would leave the
    model asking for the same tool forever, never seeing an answer — so they
    are rendered explicitly, in the order they happened.

    ``include_system`` is False when the engine takes a real system prompt
    (Claude's ``--system-prompt-file``), so the instructions are not repeated.
    """
    out: list[str] = []
    for m in messages:
        content = m.get("content", "") or ""
        renderer = _AGENT_TURN_RENDERERS.get(m.get("role", ""))
        if renderer is not None:
            renderer(out, m, content, include_system, deliver_images)
    out.append("Respond to the last user message.")
    return "\n".join(out)


def _append_agent_system_turn(
    out: list[str],
    _message: Message,
    content: str,
    include_system: bool,
    _deliver_images: bool,
) -> None:
    """Append system instructions when this engine has no separate system channel."""
    if include_system:
        out.append(f"Instructions:\n{content}\n")


def _append_agent_user_turn(
    out: list[str],
    message: Message,
    content: str,
    _include_system: bool,
    deliver_images: bool,
) -> None:
    """Append a user turn, including its image-delivery note."""
    out.append(_user_turn(message, content, deliver_images=deliver_images))


def _render_agent_tool_calls(message: Message) -> list[str]:
    """Render the function envelope the flat CLI transcript needs to replay."""
    return [
        "{}({})".format(
            _agent_tool_call_name(call),
            json.dumps(
                _agent_tool_call_arguments(call),
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        for call in _agent_tool_calls(message)
        if isinstance(call, dict)
    ]


def _agent_tool_calls(message: Message) -> list[object]:
    """Return the provider's optional call envelope in its original shape."""
    return message.get("tool_calls") or []


def _agent_tool_call_name(call: dict[object, object]) -> object:
    """Read one call's optional function name without normalizing provider data."""
    return (call.get("function") or {}).get("name", "")


def _agent_tool_call_arguments(call: dict[object, object]) -> object:
    """Read one call's optional function arguments without normalizing them."""
    return (call.get("function") or {}).get("arguments") or {}


def _append_agent_assistant_turn(
    out: list[str],
    message: Message,
    content: str,
    _include_system: bool,
    _deliver_images: bool,
) -> None:
    """Append assistant text and the tool requests that followed it."""
    rendered = _render_agent_tool_calls(message)
    if content:
        out.append(f"Assistant: {content}\n")
    if rendered:
        out.append("Assistant called: " + "; ".join(rendered) + "\n")


def _append_agent_tool_turn(
    out: list[str],
    message: Message,
    content: str,
    _include_system: bool,
    _deliver_images: bool,
) -> None:
    """Append a tool result as untrusted, line-prefixed reference material."""
    name = message.get("tool_name") or "tool"
    out.append(_facade_module()._tool_result_block(name, content))


_AGENT_TURN_RENDERERS = {
    "system": _append_agent_system_turn,
    "user": _append_agent_user_turn,
    "assistant": _append_agent_assistant_turn,
    "tool": _append_agent_tool_turn,
}
