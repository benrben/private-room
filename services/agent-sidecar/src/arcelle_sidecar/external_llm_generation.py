"""Image staging and subprocess execution for external generation."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from typing import Any, Optional

from .external_llm_cli import (
    _checked_arg,
    build_agent_cmdline,
    cli_failure_reason,
    fenced_cmdline,
    parse_antigravity_json_stream,
    parse_claude_json_result,
    parse_codex_json_stream,
    strip_shell_banner,
)
from .external_llm_codex import _CODEX_MCP_TOKEN_ENV
from .external_llm_messages import (
    IMAGE_ENGINES,
    _Wedged,
    _stopped,
    collect_images,
    drain_with_idle,
    flatten_messages,
)
from .external_llm_stream_events import (
    _DeltaTap,
    _antigravity_generation_cmdline,
    _claude_generation_cmdline,
    _codex_generation_cmdline,
    claude_user_event,
)
from .messages import Message, attach_images


def _facade_module() -> Any:
    """Return the public module so its established monkeypatch seams remain live."""
    return sys.modules[f"{__package__}.external_llm"]


def build_cmdline(
    engine: str,
    submodel: str | None,
    effort: str | None,
    *,
    stream_json_input: bool = False,
    image_paths: list[str] | None = None,
) -> str:
    """The one-shot generation invocation (external.rs minus MCP bridging) —
    pipeline generation is a pure text call, the CLI is not an agent here.

    submodel/effort are always our own known slugs in practice (a Codex catalog
    slug + level, or a Claude alias + ``--effort`` value), but they are READ
    FROM THE ROOM FILE, so what makes the quoting safe here is the
    :data:`_SAFE_CLI_ARG` check, not that assumption.

    Both Claude and Codex now ask for their machine-readable STREAMED envelopes
    (``stream-json`` / ``--json``) here too, which buys this path three things at
    once: the between-events liveness heartbeat the module doc used to name as
    this path's one gap, live text deltas for :func:`generate_external_stream`,
    and the structured terminal object the image channel needs. The parsers
    degrade to raw stdout, so a CLI change costs the accounting, never the
    answer.
    """
    submodel = _checked_arg(submodel, "model name")
    effort = _checked_arg(effort, "effort level")
    if engine == "claude-cli":
        return _claude_generation_cmdline(submodel, effort, stream_json_input)
    if engine == "codex-cli":
        return _codex_generation_cmdline(submodel, effort, image_paths)
    if engine == "antigravity-cli":
        return _antigravity_generation_cmdline(submodel)
    raise ValueError(f"Unknown external engine: {engine}")


def _decoded_staged_image(b64: str) -> bytes | None:
    """Decode one strictly-valid staged image, or fail closed."""
    import base64

    try:
        return base64.b64decode(b64, validate=True)
    except (ValueError, TypeError):
        return None


def _close_staging_fd(fd: int) -> None:
    """Best-effort close for a descriptor not transferred to ``fdopen``."""
    if fd >= 0:
        try:
            os.close(fd)
        except OSError:
            pass


def _unlink_staging_path(path: str | None) -> None:
    """Best-effort cleanup for a partially-written private image."""
    if path is not None:
        try:
            os.unlink(path)
        except OSError:
            pass


def _write_staged_image(data: bytes) -> str | None:
    """Write one private image and clean it up if staging fails."""
    fd = -1
    path: str | None = None
    try:
        fd, path = tempfile.mkstemp(prefix="arcelle-img-", suffix=".png")
        with os.fdopen(fd, "wb") as fh:
            fd = -1  # fdopen owns it from here, including exceptional exits
            fh.write(data)
        return path
    except OSError:
        _facade_module()._close_staging_fd(fd)
        _facade_module()._unlink_staging_path(path)
        return None


def _stage_image_files(images: list[str]) -> list[str]:
    """Codex's image channel: each base64 PNG becomes a private temp file for
    ``-i`` to attach (the CLI reads and embeds them itself — no tool needed).
    The caller unlinks every path on EVERY exit: the files hold decrypted room
    pixels. Staging is atomic: one invalid decode/write removes every path and
    returns no attachments, so the caller can fail closed instead of sending a
    prompt that claims Codex saw pixels it never received."""
    paths: list[str] = []
    for b64 in images:
        data = _facade_module()._decoded_staged_image(b64)
        if data is None:
            _facade_module()._unlink_all(paths)
            return []
        path = _facade_module()._write_staged_image(data)
        if path is None:
            _facade_module()._unlink_all(paths)
            return []
        paths.append(path)
    return paths


def _unlink_all(paths: list[str]) -> None:
    for path in paths:
        try:
            os.unlink(path)
        except OSError:  # pragma: no cover - best-effort cleanup
            pass


def _generation_inputs(
    model: str,
    messages: list[Message],
    format: dict[str, Any] | None,
    images: list[str] | None,
) -> tuple[str, str | None, str | None, str, list[str]]:
    """Prepare the engine-specific text and pixels for one one-shot request."""
    engine, submodel, effort = _facade_module().split_external_model(model)
    if images:
        messages = attach_images(messages, images)
    deliverable = collect_images(messages) if engine in IMAGE_ENGINES else []
    prompt = flatten_messages(messages, format, deliver_images=bool(deliverable))
    return engine, submodel, effort, prompt, deliverable


def _staged_generation_images(engine: str, deliverable: list[str]) -> list[str]:
    """Stage Codex pixels and fail closed if any requested attachment is lost."""
    if engine != "codex-cli" or not deliverable:
        return []
    staged = _facade_module()._stage_image_files(deliverable)
    if len(staged) == len(deliverable):
        return staged
    _facade_module()._unlink_all(staged)
    from .llm import LlmError

    raise LlmError(
        "ENGINE_ERROR",
        "Codex image pixels could not be staged, so visual interpretation "
        "stopped before model dispatch.",
    )


def _generation_cmdline(
    engine: str,
    submodel: str | None,
    effort: str | None,
    deliverable: list[str],
    staged: list[str],
) -> str:
    """Build a checked CLI invocation without exposing model text to the shell."""
    try:
        return build_cmdline(
            engine,
            submodel,
            effort,
            stream_json_input=engine == "claude-cli" and bool(deliverable),
            image_paths=staged,
        )
    except ValueError as exc:  # doctored model string — never reaches a shell
        from .llm import LlmError

        raise LlmError("ENGINE_ERROR", str(exc)) from exc


def _generation_wire_prompt(engine: str, prompt: str, deliverable: list[str]) -> str:
    """Encode the prompt in the input protocol expected by this CLI."""
    if engine == "antigravity-cli":
        return json.dumps(
            {"event": "user", "message": {"role": "user", "content": prompt}}
        ) + "\n"
    if engine == "claude-cli" and deliverable:
        return claude_user_event(prompt, deliverable)
    return prompt


def _agent_has_claude_images(engine: str, images: list[str] | None) -> bool:
    """Whether this agent round must use Claude's image-bearing stdin protocol."""
    return engine == "claude-cli" and bool(images)


def _checked_agent_cmdline(
    engine: str,
    submodel: str | None,
    effort: str | None,
    system_path: str | None,
    mcp_path: str | None,
    allowed: list[str] | None,
    hub_tools: list[str] | None,
    codex_mcp: tuple[str, str] | None,
    claude_images: bool,
    image_paths: list[str] | None,
) -> str:
    """Build a checked agent command without letting model text reach a shell."""
    try:
        return build_agent_cmdline(
            engine,
            submodel,
            effort,
            system_path=system_path,
            mcp_path=mcp_path,
            allowed=allowed,
            hub_allowed=hub_tools,
            codex_mcp_url=_agent_codex_mcp_url(codex_mcp),
            stream_json_input=claude_images,
            image_paths=image_paths,
        )
    except ValueError as exc:  # doctored model string — never reaches a shell
        from .llm import LlmError

        raise LlmError("ENGINE_ERROR", str(exc)) from exc


def _agent_codex_mcp_url(codex_mcp: tuple[str, str] | None) -> str | None:
    """Read the endpoint while keeping its bearer token out of the command."""
    return codex_mcp[0] if codex_mcp is not None else None


def _agent_child_environment(codex_mcp: tuple[str, str] | None) -> dict[str, str]:
    """Give Codex its per-round MCP token without exposing it in argv."""
    child_env = os.environ.copy()
    if codex_mcp is not None:
        child_env[_CODEX_MCP_TOKEN_ENV] = codex_mcp[1]
    return child_env


async def _start_agent_cli(engine: str, cmdline: str, child_env: dict[str, str]) -> Any:
    """Start the fenced command and retain the established startup sentinel."""
    from .llm import LlmError

    try:
        return await asyncio.create_subprocess_exec(
            "zsh",
            "-ilc",
            fenced_cmdline(cmdline),
            cwd=tempfile.gettempdir() if engine == "antigravity-cli" else None,
            env=child_env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except Exception as exc:  # noqa: BLE001 - re-raised as the sentinel contract
        raise LlmError("ENGINE_ERROR", f"Could not start {engine}: {exc}") from exc


async def _drain_agent_cli(
    proc: Any,
    engine: str,
    wire_prompt: str,
    idle: float,
    cancel: Optional[Any],
    tap: "_DeltaTap | None",
) -> tuple[bytes, bytes]:
    """Drain one agent session, translating only its silent-process failure."""
    from .llm import LlmError

    try:
        return await drain_with_idle(proc, wire_prompt.encode("utf-8"), idle, cancel, tap)
    except _Wedged as exc:
        raise LlmError(
            "ENGINE_ERROR", f"{engine} produced no output for {idle:g}s and was stopped."
        ) from exc


def _agent_cli_result(
    engine: str,
    proc: Any,
    stdout: bytes,
    stderr: bytes,
    cancel: Optional[Any],
) -> str:
    """Honor Stop and turn a finished agent process into its raw stream text."""
    if _stopped(cancel):
        return ""
    out = strip_shell_banner(stdout)
    if proc.returncode != 0:
        from .llm import LlmError

        raise LlmError(
            "ENGINE_ERROR",
            f"{engine} failed: {cli_failure_reason(out, strip_shell_banner(stderr))}",
        )
    return out.strip()


async def _run_generation_cli(
    engine: str,
    cmdline: str,
    prompt: str,
    deliverable: list[str],
    idle: float,
    cancel: Optional[Any],
    tap: "_DeltaTap | None",
) -> tuple[Any, bytes, bytes]:
    """Spawn and drain one CLI session, translating transport failures once."""
    from .llm import LlmError

    try:
        proc = await asyncio.create_subprocess_exec(
            "zsh",
            "-ilc",
            fenced_cmdline(cmdline),
            cwd=tempfile.gettempdir() if engine == "antigravity-cli" else None,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        wire_prompt = _generation_wire_prompt(engine, prompt, deliverable)
        stdout, stderr = await drain_with_idle(
            proc, wire_prompt.encode("utf-8"), idle, cancel, tap
        )
        return proc, stdout, stderr
    except _Wedged as exc:
        # Silent for the whole idle budget: stopped rather than hung forever.
        raise LlmError(
            "ENGINE_ERROR",
            f"{engine} produced no output for {idle:g}s and was stopped.",
        ) from exc
    except FileNotFoundError as exc:  # zsh itself missing — effectively impossible
        raise LlmError("ENGINE_ERROR", f"Could not start {engine}: {exc}") from exc
    except Exception as exc:  # noqa: BLE001 - re-raised as the sentinel contract
        raise LlmError("ENGINE_ERROR", f"{engine} failed: {exc}") from exc


def _parsed_generation_text(engine: str, stdout: str) -> str:
    """Read the terminal text from the streaming envelope this engine emits."""
    if engine == "antigravity-cli":
        return parse_antigravity_json_stream(stdout)[0].strip()
    if engine == "claude-cli":
        return parse_claude_json_result(stdout)[0].strip()
    return parse_codex_json_stream(stdout)[0].strip()


def _generation_result(
    engine: str,
    proc: Any,
    stdout: bytes,
    stderr: bytes,
    cancel: Optional[Any],
) -> str:
    """Honor Stop and turn a completed process into its public response text."""
    if _stopped(cancel):
        return ""
    out = strip_shell_banner(stdout)
    if proc.returncode != 0:
        from .llm import LlmError

        raise LlmError(
            "ENGINE_ERROR",
            f"{engine} failed: {cli_failure_reason(out, strip_shell_banner(stderr))}",
        )
    return _parsed_generation_text(engine, out)
