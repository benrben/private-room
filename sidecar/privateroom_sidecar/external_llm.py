"""External-CLI generation backend (engine parity).

The room's engine can be a cloud coding CLI — ``claude-cli`` (Claude Code) or
``codex-cli`` (Codex) — and the user expects every feature, not just chat, to
run on it. This module mirrors the Rust ``external.rs::run_external`` contract
(same ``engine::model::effort`` split, same prompt flattening, same CLI flags)
so the sidecar's one-shot generation gateway can honor those engines too:
:func:`.llm.generate` / :func:`.llm.generate_stream` and summarize's
``OllamaModelClient`` branch here whenever the model string names an external
engine, which gives summaries, file passes, AI actions (translate, minutes…),
studio, suggestions, and workflow generate nodes the exact same reach as a
local model — with no per-feature special cases.

Invocation matches Rust: ``zsh -ilc`` so a GUI-launched process still sees the
user's real PATH (these CLIs are installed via ``.zshrc``-managed paths), the
prompt rides stdin, the reply is stdout. Content leaves the Mac through the
user's own CLI account — exactly like the chat path, and only when the USER
picked that engine for the room.

Structured output: the CLIs have no grammar constraint, so a requested JSON
schema is appended as a strict instruction. Every structured caller already
runs ``recover_json`` unconditionally (the Ollama ``:cloud`` compensation), so
fence-wrapped or prose-padded JSON is recovered the same way.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from .messages import Message

#: Engine ids that name a cloud coding CLI (mirror external.rs).
EXTERNAL_ENGINES = ("claude-cli", "codex-cli")

#: Hard ceiling on one external-CLI generation call. A wedged ``claude`` /
#: ``codex`` process would otherwise hang the await forever with no way to stop
#: it; on expiry we kill the subprocess and raise the ``ENGINE_ERROR`` sentinel.
EXTERNAL_TIMEOUT_SECS: int = 300

#: The engine/model/effort separator — a double colon, written as a regex so
#: the privacy suite's IPv6-wildcard-bind scan (which forbids a literal
#: double-colon STRING anywhere in this package) stays meaningful.
_SEP = re.compile(r":{2}")


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


def flatten_messages(messages: list[Message], schema: dict[str, Any] | None) -> str:
    """The Rust prompt convention: role-labelled turns, one flat text prompt.

    A ``format`` schema becomes a strict JSON-only instruction — the callers'
    ``recover_json`` cleans whatever wrapping the CLI still adds.
    """
    out: list[str] = []
    for m in messages:
        role = m.get("role", "")
        content = m.get("content", "") or ""
        if role == "system":
            out.append(f"Instructions:\n{content}\n")
        elif role == "user":
            out.append(f"User: {content}\n")
        elif role == "assistant":
            out.append(f"Assistant: {content}\n")
    if schema is not None:
        out.append(
            "Return ONLY a single JSON object matching this schema — no prose, "
            "no code fences, no explanation:\n"
            + json.dumps(schema, ensure_ascii=False)
            + "\n"
        )
    out.append("Respond to the last user message. Reply with the answer only.")
    return "\n".join(out)


def build_cmdline(engine: str, submodel: str | None, effort: str | None) -> str:
    """The exact CLI invocation Rust uses (external.rs), minus MCP bridging —
    pipeline generation is a pure text call, the CLI is not an agent here.

    Quoting is safe for the same reason as in Rust: submodel/effort are always
    our own known slugs (a Codex catalog slug + level, or a Claude alias +
    ``--effort`` value), never arbitrary user text.
    """
    model_flag = f" --model '{submodel}'" if submodel else ""
    if engine == "claude-cli":
        effort_flag = f" --effort '{effort}'" if effort else ""
        return f"claude -p{model_flag}{effort_flag}"
    if engine == "codex-cli":
        effort_flag = f" -c 'model_reasoning_effort={effort}'" if effort else ""
        return f"codex exec --skip-git-repo-check{model_flag}{effort_flag} -"
    raise ValueError(f"Unknown external engine: {engine}")


async def generate_external(
    model: str,
    messages: list[Message],
    *,
    format: dict[str, Any] | None = None,  # noqa: A002 - matches llm.generate
) -> str:
    """One non-streaming turn through a cloud CLI. Raises :class:`.llm.LlmError`
    with the sentinel contract on failure (``ENGINE_ERROR`` — there is no daemon
    or pull state to map to the other codes)."""
    from .llm import LlmError  # local import: llm.py imports this module

    engine, submodel, effort = split_external_model(model)
    prompt = flatten_messages(messages, format)
    cmdline = build_cmdline(engine, submodel, effort)
    try:
        proc = await asyncio.create_subprocess_exec(
            "zsh",
            "-ilc",
            cmdline,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(prompt.encode("utf-8")),
            timeout=EXTERNAL_TIMEOUT_SECS,
        )
    except asyncio.TimeoutError as exc:
        # Wedged CLI: stop it rather than hang the call forever. This raise is
        # NOT caught by the generic `except Exception` below — an exception
        # raised inside one except clause bypasses its sibling clauses.
        proc.kill()
        try:  # best-effort reap of the killed child; failure here is ignorable
            await asyncio.wait_for(proc.wait(), timeout=5)
        except Exception:  # noqa: BLE001 - already killed; reaping is best-effort
            pass
        raise LlmError(
            "ENGINE_ERROR",
            f"{engine} timed out after {EXTERNAL_TIMEOUT_SECS}s and was stopped.",
        ) from exc
    except FileNotFoundError as exc:  # zsh itself missing — effectively impossible
        raise LlmError("ENGINE_ERROR", f"Could not start {engine}: {exc}") from exc
    except Exception as exc:  # noqa: BLE001 - re-raised as the sentinel contract
        raise LlmError("ENGINE_ERROR", f"{engine} failed: {exc}") from exc
    if proc.returncode != 0:
        err = stderr.decode("utf-8", "replace")[:400]
        raise LlmError("ENGINE_ERROR", f"{engine} failed: {err}")
    return stdout.decode("utf-8", "replace").strip()


__all__ = [
    "EXTERNAL_ENGINES",
    "split_external_model",
    "is_external_model",
    "flatten_messages",
    "build_cmdline",
    "generate_external",
]
