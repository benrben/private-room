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

CHAT/AGENT parity: :class:`ExternalChatModel` implements the same one-method
``chat.ChatModel`` seam the local engine uses, so the agent hub (main agent +
domain agents, ``agents.py``/``manager.py``/``graph.py``) runs on a cloud CLI
through *exactly the same code* — same registry, same scoped tool boxes, same
``plan``/``agent`` roster events. The CLIs expose no structured tool-call API
in ``-p``/``exec`` mode (their own tool loop is MCP-side and invisible to us),
so the seam speaks a text tool protocol: the catalog is rendered into the
prompt and one JSON envelope comes back. Deltas are emitted only once the
reply is known NOT to be a tool call — a half-streamed envelope would spray
JSON into the transcript.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import tempfile
from typing import Any, Optional

from . import hub_mcp
from .hub_mcp import HUB_SERVER_NAME, HubToolServer
from .messages import Message, ToolCall

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

#: The app imposes NO context limit on a cloud CLI — it manages its own window
#: (and compacts on its own when it fills). The only place a number is needed
#: is the token bar's denominator, and the host already resolves that one
#: (live from the Codex catalog, `model_limits.rs`) and sends it as
#: ``RunRequest.max_context``; this is the neutral display fallback used when
#: it didn't, identical to the one the local seam falls back to.
DISPLAY_CONTEXT_FALLBACK = 128_000


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


def flatten_agent_messages(
    messages: list[Message], *, include_system: bool = True
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
        role = m.get("role", "")
        content = m.get("content", "") or ""
        if role == "system":
            if include_system:
                out.append(f"Instructions:\n{content}\n")
        elif role == "user":
            out.append(f"User: {content}\n")
        elif role == "assistant":
            calls = m.get("tool_calls") or []
            rendered = [
                "{}({})".format(
                    (c.get("function") or {}).get("name", ""),
                    json.dumps(
                        (c.get("function") or {}).get("arguments") or {},
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                )
                for c in calls
                if isinstance(c, dict)
            ]
            if content:
                out.append(f"Assistant: {content}\n")
            if rendered:
                out.append("Assistant called: " + "; ".join(rendered) + "\n")
        elif role == "tool":
            name = m.get("tool_name") or "tool"
            out.append(f"Result of {name}:\n{content}\n")
    out.append("Respond to the last user message.")
    return "\n".join(out)


#: Hub-internal tool names: resolved inside the graph, never on the room
#: bridge. They reach a harness engine through the hub's OWN MCP endpoint
#: (:mod:`.hub_mcp`), and fall back to the text protocol for Codex.
_HUB_ONLY_TOOLS = ("request_tools",)


def _is_hub_only(name: str) -> bool:
    return bool(name) and (name.startswith("ask_") or name in _HUB_ONLY_TOOLS)


def _tool_name_of(tool: dict[str, Any]) -> str:
    return str((tool.get("function") or {}).get("name") or "")


def _hub_calls(captured: list[tuple[str, dict[str, Any]]]) -> list[ToolCall]:
    """Delegations captured by the hub endpoint, as ordinary tool calls.

    Same shape `parse_tool_calls` produces, so everything downstream — the
    privacy restore, duplicate suppression, `graph.execute_tools` — cannot
    tell a native call from a text-protocol one.
    """
    calls: list[ToolCall] = []
    for i, (name, args) in enumerate(captured):
        call_id = f"hub_{i}"
        calls.append(
            ToolCall(
                name=name,
                arguments=args,
                id=call_id,
                raw={
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": args},
                },
            )
        )
    return calls


def _bridge_tools(tools: list[dict[str, Any]]) -> list[str]:
    """The offered tools that the ROOM BRIDGE actually serves.

    Everything except the hub's own ``ask_*_agent`` delegation tools and
    ``request_tools``, which exist only inside ``graph.py``.
    """
    out: list[str] = []
    for tool in tools:
        name = _tool_name_of(tool)
        if not name or _is_hub_only(name):
            continue
        out.append(name)
    return out


def _mcp_server_entry(url: str, token: str) -> dict[str, Any]:
    return {"type": "http", "url": url, "headers": {"Authorization": f"Bearer {token}"}}


def mcp_config_json(
    url: str, token: str, hub: tuple[str, str] | None = None
) -> str:
    """The ``--mcp-config`` payload for one CLI round.

    With ``hub`` omitted this is byte-compatible with Rust's
    ``Bridge::mcp_config_json`` — do not reorder the keys.

    ``hub`` adds the sidecar's own :mod:`.hub_mcp` endpoint as a SECOND server,
    which is how the ``ask_*_agent`` delegation tools become real tools Claude
    can call instead of prose it narrates around (see that module's doc).
    ``url`` may be empty when a round offers hub tools only — the main agent
    holds no room tools at all — and the room server is then omitted.
    """
    servers: dict[str, Any] = {}
    if url:
        servers["room"] = _mcp_server_entry(url, token)
    if hub is not None:
        servers[HUB_SERVER_NAME] = _mcp_server_entry(hub[0], hub[1])
    return json.dumps({"mcpServers": servers})


#: On the hub path the CLI is a GENERATOR, not an agent: every action goes
#: through the room's own scoped tool boxes, which the hub decides. So its
#: native toolset is shut off — no MCP server is loaded (``--strict-mcp-config``
#: with no ``--mcp-config``) and the allowlist names a pattern nothing matches,
#: leaving Read/Write/Bash unusable. Without this, selecting Claude as the room
#: engine would hand it its own file and shell tools on the user's Mac,
#: outside the room and outside the privacy door.
CLAUDE_NO_TOOLS_FLAGS = " --strict-mcp-config --allowedTools 'mcp__none__*'"

#: The flags the Rust chat path pins for Codex (external.rs CODEX_ARCELLE_FLAGS):
#: no user config, no shell/exec tools, read-only sandbox, never prompt for
#: approval. The agent hub reaches the room through OUR bridge, so the CLI's own
#: machinery for touching the outside world stays off.
CODEX_ARCELLE_FLAGS = (
    " --ignore-user-config --ephemeral --skip-git-repo-check"
    " --sandbox read-only -c 'approval_policy=\"never\"' --disable shell_tool"
    " --disable unified_exec -c 'web_search=\"disabled\"'"
)


def build_agent_cmdline(
    engine: str,
    submodel: str | None,
    effort: str | None,
    *,
    system_path: str | None = None,
    mcp_path: str | None = None,
    allowed: list[str] | None = None,
    hub_allowed: list[str] | None = None,
) -> str:
    """The CLI invocation for one AGENT round, mirroring ``external.rs``.

    Same machine-readable envelope Rust asks for (``--output-format json`` /
    ``--json``) — it carries the CLI's OWN usage report and, for Claude, its
    real context window, so nothing here has to assume a number. Both parsers
    below degrade to plain stdout, so a CLI change costs the accounting, never
    the answer.

    ``system_path`` REPLACES Claude's own agent system prompt with ours. That
    is the difference between a worker that acts and one that doesn't: the
    stock prompt tells the model it is a coding CLI with its own tools, and a
    tool protocol offered from a user turn loses to it (live QA 2026-07-24 — a
    worker holding search_mcp_tools answered "the tool list contains no
    search_mcp_tools" after searching its OWN registry). Codex takes no
    equivalent flag; its instructions ride the prompt.
    """
    model_flag = f" --model '{submodel}'" if submodel else ""
    if engine == "claude-cli":
        effort_flag = f" --effort '{effort}'" if effort else ""
        system_flag = f" --system-prompt-file '{system_path}'" if system_path else ""
        # Room tools ride Claude's OWN tool loop over the room bridge, scoped by
        # an allowlist to exactly this agent's box. See the module doc. The hub's
        # ask_*_agent delegation rides the same mechanism from a second server
        # (`hub_mcp`) — a harness calls tools; it does not narrate them.
        if mcp_path and (allowed or hub_allowed):
            names = " ".join(
                [f"'mcp__room__{n}'" for n in allowed or []]
                + [f"'{hub_mcp.qualified(n)}'" for n in hub_allowed or []]
            )
            tool_flags = (
                f" --mcp-config '{mcp_path}' --strict-mcp-config --allowedTools {names}"
            )
        else:
            tool_flags = CLAUDE_NO_TOOLS_FLAGS
        return (
            f"claude -p --output-format json{tool_flags}{system_flag}"
            f"{model_flag}{effort_flag}"
        )
    if engine == "codex-cli":
        effort_flag = f" -c 'model_reasoning_effort={effort}'" if effort else ""
        return f"codex exec --json{CODEX_ARCELLE_FLAGS}{model_flag}{effort_flag} -"
    raise ValueError(f"Unknown external engine: {engine}")


def parse_claude_json_result(stdout: str) -> tuple[str, int | None, int | None]:
    """``(text, input_tokens, context_window)`` from ``claude -p --output-format
    json`` — the Python twin of ``external.rs::parse_claude_json_result``.

    All three input counts (fresh, cache-creation, cache-read) occupy context,
    so the bar counts all three. ``contextWindow`` is taken from whichever model
    did the most work this turn — a single turn can span two models.
    """
    try:
        v = json.loads(stdout)
    except ValueError:
        return stdout.strip(), None, None
    if not isinstance(v, dict):
        return stdout.strip(), None, None
    text = v.get("result")
    text = text if isinstance(text, str) else stdout.strip()

    usage = v.get("usage")
    input_tokens: int | None = None
    if isinstance(usage, dict):
        input_tokens = sum(
            int(usage.get(k) or 0)
            for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
        )

    window: int | None = None
    model_usage = v.get("modelUsage")
    if isinstance(model_usage, dict):
        best = -1
        for entry in model_usage.values():
            if not isinstance(entry, dict) or not isinstance(entry.get("contextWindow"), int):
                continue
            weight = sum(
                int(entry.get(k) or 0)
                for k in (
                    "inputTokens",
                    "outputTokens",
                    "cacheCreationInputTokens",
                    "cacheReadInputTokens",
                )
            )
            if weight > best:
                best, window = weight, entry["contextWindow"]
    return text, input_tokens, window


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
    if isinstance(stdout, bytes):
        stdout = stdout.decode("utf-8", "replace")
    if isinstance(stderr, bytes):
        stderr = stderr.decode("utf-8", "replace")
    if stderr.strip():
        return stderr.strip()[:400]
    try:
        v = json.loads(stdout)
    except ValueError:
        return stdout.strip()[:400] or "no output"
    if not isinstance(v, dict):
        return stdout.strip()[:400] or "no output"
    result = v.get("result")
    reason = v.get("terminal_reason")
    parts = [p for p in (result if isinstance(result, str) else None, reason) if p]
    return " ".join(str(p) for p in parts).strip()[:400] or "no output"


def parse_codex_json_stream(stdout: str) -> tuple[str, int | None, int | None]:
    """``(text, input_tokens, None)`` from ``codex exec --json`` — the Python
    twin of ``external.rs::parse_codex_json_stream``. The answer rides the last
    ``agent_message`` item; usage rides ``turn.completed``. Codex reports no
    context window at all. Raw stdout is used only if NO line parsed as JSON.
    """
    text = ""
    input_tokens: int | None = None
    parsed_any = False
    for line in stdout.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if not isinstance(ev, dict):
            continue
        parsed_any = True
        kind = ev.get("type")
        if kind == "item.completed":
            item = ev.get("item")
            if isinstance(item, dict) and item.get("type") == "agent_message":
                if isinstance(item.get("text"), str):
                    text = item["text"]
        elif kind == "turn.completed":
            usage = ev.get("usage")
            if isinstance(usage, dict) and isinstance(usage.get("input_tokens"), int):
                input_tokens = usage["input_tokens"]
    if not parsed_any:
        text = stdout.strip()
    return text, input_tokens, None


def build_cmdline(engine: str, submodel: str | None, effort: str | None) -> str:
    """The exact CLI invocation Rust uses (external.rs), minus MCP bridging —
    pipeline generation is a pure text call, the CLI is not an agent here.

    Quoting is safe for the same reason as in Rust: submodel/effort are always
    our own known slugs (a Codex catalog slug + level, or a Claude alias +
    ``--effort`` value), never arbitrary user text. The Claude alias is scraped
    from the installed CLI rather than hardcoded; ``external.rs``'s parser caps
    a slug at 2-16 lowercase ASCII letters, so no quote or metacharacter can
    reach this interpolation.
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
        raise LlmError(
            "ENGINE_ERROR", f"{engine} failed: {cli_failure_reason(stdout, stderr)}"
        )
    return stdout.decode("utf-8", "replace").strip()


#: How the seam asks for a tool call. One JSON object, nothing else — the
#: alternative branch (plain prose) is what an ordinary answer looks like, so
#: the two are trivially separable without a grammar.
_TOOL_PROTOCOL = """
You are answering INSIDE another application, which executes tools on your
behalf. Anything your own environment may list as a tool — file readers,
shells, task or registry tools — is NOT connected to this task and must never
be consulted or mentioned; searching your own tool registry proves nothing
about this one. The list below is the complete set of tools that exist here,
and emitting the JSON envelope is the ONLY way to run one.

{catalog}

Every reply must be exactly one of:

(A) A tool call — a single JSON object and NOTHING else, no prose around it:
{{"tool_calls": [{{"name": "<tool name>", "arguments": {{<arguments object>}}}}]}}

(B) The answer for the user — plain prose. No JSON, no tool-call envelope.

Choose (A) when a tool would get you facts or make the change the user asked
for; the result comes back and you may then call another tool or answer.
Choose (B) when you can already answer. Do not describe a tool call in prose —
that does nothing. Do not apologise for using tools.
""".strip()


#: When every offered tool rides a REAL MCP endpoint (`hub_mcp` and/or the room
#: bridge) the text protocol is empty — there is no envelope to teach. What must
#: NOT be dropped with it is the disowning paragraph: without it the harness
#: answers about its own world. Live QA 2026-07-25, "what skills do I have in
#: this room?" → Claude Code listed ITS OWN installed skills (claude-api,
#: dataviz, artifact-design, loop, schedule…) instead of asking the room's
#: Skills agent. "Skills", "tools" and "tasks" are all words its own runtime
#: owns, so the room has to claim them explicitly.
_NATIVE_TOOLS_NOTE = """
You are answering INSIDE another application. Your own environment's tools,
skills, agents and files are NOT connected to this task and must never be
consulted, listed or mentioned — consulting your own registry proves nothing
about this one. Every capability that exists here is an MCP tool you have been
given; when the user asks what THIS room holds — its files, skills, workflows,
scripts, memories, connectors — the answer comes from those tools alone, never
from your own environment and never from memory. If a tool is offered, it
works: call it rather than reporting it unavailable.
""".strip()


#: The last line before generation. The full protocol has the authority (it is
#: the system prompt); this has the POSITION. Both are needed: without the
#: system prompt the CLI's own framing wins and the model consults its own tool
#: registry; without this reminder it drifts into answering from memory.
_TOOL_REMINDER = (
    "Reply now with EITHER a single JSON tool-call envelope "
    '({"tool_calls": [{"name": "…", "arguments": {…}}]}) using only the tools '
    "listed in your instructions, OR the plain-prose answer. Nothing else. "
    "Do not claim a tool is unavailable — if it is in that list, it works."
)


def render_catalog(tools: list[dict[str, Any]]) -> str:
    """The served tool boxes as compact prompt text (name, purpose, schema)."""
    lines: list[str] = []
    for tool in tools:
        fn = tool.get("function") or {}
        name = str(fn.get("name") or "")
        if not name:
            continue
        desc = " ".join(str(fn.get("description") or "").split())
        params = fn.get("parameters") or {}
        lines.append(
            f"- {name}: {desc}\n  arguments: "
            + json.dumps(params, ensure_ascii=False, separators=(",", ":"))
        )
    return "\n".join(lines)


def _recover_object(text: str) -> Any:
    """The one JSON value in ``text``, or None if it isn't JSON.

    Same slice-from-first-bracket recovery every structured caller already runs
    (``file_pass.recover_json``), kept local so the chat seam doesn't import a
    job module. Plain prose returns None — that is the (B) branch.
    """
    s = text.strip()
    if not s:
        return None
    start = next((i for i, c in enumerate(s) if c in "{["), None)
    end = next((i for i in range(len(s) - 1, -1, -1) if s[i] in "}]"), None)
    if start is None or end is None or end < start:
        return None
    try:
        return json.loads(s[start : end + 1])
    except ValueError:
        return None


def parse_tool_calls(text: str, offered: set[str] | None = None) -> list[ToolCall]:
    """Tool calls from one CLI reply, or [] when it is an ordinary answer.

    Accepts the envelope we ask for plus the two shapes models drift into (a
    single ``tool_call``, or a bare ``{name, arguments}``) — cheaper than a
    reprompt round, which on a CLI engine costs a whole process spawn.

    The bare ``{name, …}`` shape needs guarding, because it is not only a
    tool-call shape: it is what an ordinary JSON ANSWER looks like. Asked to
    extract fields, or to show a config, a model replies with exactly one object
    carrying a ``name`` key — and reading that as a call threw the answer away
    (branch A returns no text) and dispatched a tool that does not exist. So the
    bare shape is only believed when it ALSO carries an ``arguments`` object and
    names a tool that was actually offered this round. The two explicit
    envelopes are unambiguous and stay unconditional.
    """
    parsed = _recover_object(text)
    raw_calls: list[Any]
    if isinstance(parsed, dict) and isinstance(parsed.get("tool_calls"), list):
        raw_calls = parsed["tool_calls"]
    elif isinstance(parsed, dict) and isinstance(parsed.get("tool_call"), dict):
        raw_calls = [parsed["tool_call"]]
    elif (
        isinstance(parsed, dict)
        and isinstance(parsed.get("name"), str)
        and isinstance(parsed.get("arguments"), (dict, str))
        and (offered is None or parsed["name"] in offered)
    ):
        raw_calls = [parsed]
    else:
        return []
    calls: list[ToolCall] = []
    for i, raw in enumerate(raw_calls):
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "")
        if not name:
            continue
        args = raw.get("arguments")
        if isinstance(args, str):  # some replies stringify the arguments object
            try:
                args = json.loads(args)
            except ValueError:
                args = {}
        if not isinstance(args, dict):
            args = {}
        call_id = str(raw.get("id") or f"call_{i}")
        calls.append(
            ToolCall(
                name=name,
                arguments=args,
                id=call_id,
                raw={
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": args},
                },
            )
        )
    return calls


class ExternalChatModel:
    """A cloud CLI behind the local engine's ``ChatModel`` seam.

    One :meth:`stream` call = one ``claude -p`` / ``codex exec`` process. The
    CLI is stateless per call, so each round re-sends the composed transcript —
    the same thing the Ollama path does over the wire, just flattened to text.

    Deliberately NOT token-streamed: the reply has to be complete before we
    know whether it is a tool call (branch A) or the answer (branch B), and the
    CLI chat path never streamed live text anyway (agent.rs emitted a step chip
    instead). The whole answer is handed to ``on_delta`` in one piece.

    Images do not ride along — these CLIs take a text prompt on stdin. Vision
    turns stay on the local engine, which is where the perception tools live.
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
        self.composite_model = model
        self.model = model
        self.temperature = temperature
        self.engine, self.submodel, self.effort = split_external_model(model)
        #: Display-only: the token bar's denominator, as resolved by the host.
        #: Never a cap — nothing here truncates or refuses on its account.
        self.max_context = max_context or DISPLAY_CONTEXT_FALLBACK
        #: The room bridge, handed to Claude as a REAL MCP server for the
        #: rounds that offer room tools (see :meth:`stream`).
        self.mcp_url = mcp_url
        self.mcp_token = mcp_token
        #: PRIV-1: the /run handler attaches the room's policy here. A CLI is a
        #: non-local model, so the door engages exactly as it does for `:cloud`.
        self.privacy: Any = None

    @property
    def _takes_system_prompt(self) -> bool:
        """Claude replaces its system prompt from a file; Codex has no such
        flag, so its instructions ride the stdin prompt as before."""
        return self.engine == "claude-cli"

    def _prompt(self, messages: list[Message], tools: list[dict[str, Any]]) -> str:
        """The conversation for one round, as one flat prompt on stdin.

        The CATALOG lives in the system prompt (:meth:`_system`) — it needs the
        authority to outrank the CLI's own agent framing. But authority is not
        the same as position: with the protocol only up there, the main agent
        stopped emitting envelopes altogether and answered from memory (live
        QA 2026-07-24, both failure directions observed in one sitting). So the
        last thing before generation is a one-line reminder of the two branches.
        """
        base = flatten_agent_messages(
            messages, include_system=not self._takes_system_prompt
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
        room = "\n\n".join(
            (m.get("content") or "").strip()
            for m in messages
            if m.get("role") == "system" and (m.get("content") or "").strip()
        )
        parts = [room] if room else []
        if tools:
            parts.append(_TOOL_PROTOCOL.format(catalog=render_catalog(tools)))
        elif native:
            parts.append(_NATIVE_TOOLS_NOTE)
        return "\n\n".join(parts)

    async def _run(
        self,
        prompt: str,
        cancel: Optional[Any],
        system: str = "",
        bridge_tools: list[str] | None = None,
        hub: HubToolServer | None = None,
        hub_tools: list[str] | None = None,
    ) -> str:
        """One CLI process, killed on Stop or on the hard timeout.

        ``system`` rides a temp FILE rather than argv: it carries the room's
        instructions and the tool catalog (kilobytes, arbitrary user text), so
        quoting it into a `zsh -ilc` command line would be both fragile and an
        injection surface. ``bridge_tools`` names this agent's box, handed to
        Claude as a real MCP allowlist; ``hub`` is the per-round delegation
        endpoint (:mod:`.hub_mcp`) when this round offers ask_*_agent tools.
        Both files live for the call only.
        """
        paths: list[str] = []
        system_path: str | None = None
        mcp_path: str | None = None
        if system:
            fd, system_path = tempfile.mkstemp(prefix="arcelle-sys-", suffix=".txt")
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(system)
            paths.append(system_path)
        if (bridge_tools and self.mcp_url) or hub is not None:
            fd, mcp_path = tempfile.mkstemp(prefix="arcelle-mcp-", suffix=".json")
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(
                    mcp_config_json(
                        self.mcp_url if bridge_tools else "",
                        self.mcp_token,
                        hub=(hub.url, hub.token) if hub is not None else None,
                    )
                )
            paths.append(mcp_path)
        try:
            return await self._spawn(
                prompt,
                cancel,
                system_path,
                mcp_path,
                bridge_tools or [],
                hub_tools=hub_tools or [],
            )
        finally:
            for path in paths:
                try:
                    os.unlink(path)
                except OSError:  # pragma: no cover - best-effort cleanup
                    pass

    async def _spawn(
        self,
        prompt: str,
        cancel: Optional[Any],
        system_path: str | None,
        mcp_path: str | None = None,
        allowed: list[str] | None = None,
        hub_tools: list[str] | None = None,
    ) -> str:
        from .llm import LlmError  # local import: llm.py imports this module

        cmdline = build_agent_cmdline(
            self.engine,
            self.submodel,
            self.effort,
            system_path=system_path,
            mcp_path=mcp_path,
            allowed=allowed,
            hub_allowed=hub_tools,
        )
        try:
            proc = await asyncio.create_subprocess_exec(
                "zsh",
                "-ilc",
                cmdline,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except Exception as exc:  # noqa: BLE001 - re-raised as the sentinel contract
            raise LlmError("ENGINE_ERROR", f"Could not start {self.engine}: {exc}") from exc

        task = asyncio.ensure_future(proc.communicate(prompt.encode("utf-8")))
        waited = 0.0
        # Stop must not wait out a 300s cloud call: poll the flag while the CLI
        # runs and kill the process the moment the user presses it.
        while True:
            done, _ = await asyncio.wait({task}, timeout=0.25)
            if done:
                break
            waited += 0.25
            if cancel is not None and getattr(cancel, "cancelled", False):
                proc.kill()
                task.cancel()
                return ""
            if waited >= EXTERNAL_TIMEOUT_SECS:
                proc.kill()
                task.cancel()
                raise LlmError(
                    "ENGINE_ERROR",
                    f"{self.engine} timed out after {EXTERNAL_TIMEOUT_SECS}s and was stopped.",
                )
        stdout, stderr = task.result()
        if proc.returncode != 0:
            raise LlmError(
                "ENGINE_ERROR",
                f"{self.engine} failed: {cli_failure_reason(stdout, stderr)}",
            )
        return stdout.decode("utf-8", "replace").strip()

    async def stream(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]],
        on_delta: Any,
        cancel: Optional[Any] = None,
    ) -> tuple[str, list[ToolCall], Any]:
        from .privacy import guard_outbound

        # PRIV-1: same door as every other non-local model — the composed
        # history goes out redacted, the reply comes back restored.
        send, _, engaged = guard_outbound(self.composite_model, messages, self.privacy)
        # WHICH TOOLS ARE REAL. Claude Code is an agent harness: describe a tool
        # to it and it CALLS it through its own machinery — live QA 2026-07-24
        # showed a worker doing exactly that and reporting back "No such tool
        # available: search_mcp_tools" (its runtime's words, not ours). So room
        # tools are given to it as REAL MCP tools on the room bridge, scoped by
        # an allowlist to this agent's box, and it drives them natively. Only
        # the hub's own ask_*_agent delegation — which exists nowhere but
        # graph.py — stays on the text protocol, where it works.
        native = _bridge_tools(tools) if self._takes_system_prompt and self.mcp_url else []
        # …AND SO IS DELEGATION. Live QA 2026-07-25 proved the exemption above
        # was wrong: handed ask_jobs_agent in prose, Claude Code answered "the
        # automation tool isn't responding" without ever emitting an envelope
        # or running a worker. A harness calls tools; it does not narrate them.
        # So the hub's own tools get a real endpoint too (see `hub_mcp`) — it
        # CAPTURES the call and we return it as an ordinary ToolCall, leaving
        # graph.py to run the specialist exactly as it does for a local model.
        # Defined by NAME, not as the complement of `native`: a round whose
        # room tools are on the text protocol (no bridge url) must not have
        # them swept into the hub endpoint, which serves delegation only.
        hub_tools = (
            [t for t in tools if _is_hub_only(_tool_name_of(t))]
            if self._takes_system_prompt
            else []
        )
        hub_names = [_tool_name_of(t) for t in hub_tools]
        # Whatever neither channel can serve natively stays on the text
        # protocol — Codex (no --mcp-config on this path) drives entirely here.
        protocol_tools = [
            t
            for t in tools
            if _tool_name_of(t) not in set(native) | set(hub_names)
        ]
        system = self._system(
            send, protocol_tools, native=bool(native or hub_names)
        )
        prompt = self._prompt(send, protocol_tools)
        hub: HubToolServer | None = None
        try:
            if hub_names:
                hub = HubToolServer(hub_tools, secrets.token_urlsafe(24))
            if self._takes_system_prompt:
                stdout = await self._run(
                    prompt, cancel, system, native, hub=hub, hub_tools=hub_names
                )
            else:
                # Codex: no system-prompt flag, so instructions lead the prompt.
                stdout = await self._run(
                    f"{system}\n\n{prompt}" if system else prompt, cancel
                )
            captured = list(hub.calls) if hub is not None else []
        finally:
            if hub is not None:
                hub.close()
        if cancel is not None and getattr(cancel, "cancelled", False):
            return "", [], self._usage()

        if self.engine == "claude-cli":
            text, input_tokens, window = parse_claude_json_result(stdout)
        else:
            text, input_tokens, window = parse_codex_json_stream(stdout)
        # The engine's own report wins over the host's hint for the rest of
        # this run: Claude states its real window per turn (a 1M-context model
        # is not a 200k one), and no assumption here can beat that.
        if window:
            self.max_context = window

        # A NATIVE delegation wins over anything the harness wrote around it:
        # the call already happened, so trailing prose ("I've asked the Jobs
        # agent…") is narration about machinery, exactly what branch (A) drops.
        # The text protocol stays as the fallback for Codex and for a Claude
        # round that answered in an envelope anyway.
        offered = {_tool_name_of(t) for t in tools} - {""}
        calls = _hub_calls(captured) or (
            parse_tool_calls(text, offered) if tools else []
        )
        if calls:
            # Branch (A): an envelope is machinery, never transcript text. Its
            # arguments carry real values back through the door.
            if engaged is not None:
                for call in calls:
                    call.arguments = engaged.restore_value(call.arguments)
                    fn = call.raw.get("function")
                    if isinstance(fn, dict):
                        fn["arguments"] = call.arguments
            return "", calls, self._usage(input_tokens)

        # Branch (B): the answer. Restored, then delivered in one piece.
        if engaged is not None:
            restorer = engaged.restorer()
            text = restorer.feed(text) + restorer.flush()
        if text:
            await on_delta(text)
        return text, [], self._usage(input_tokens)

    def _usage(self, input_tokens: int | None = None) -> Any:
        """The round's accounting: the CLI's own prompt-token count when its
        envelope carried one (``is_real``), else the caller's char estimate.
        ``max_context`` is the engine's stated window, or the host's hint.
        """
        from .chat import RoundUsage

        return RoundUsage(
            input_tokens=input_tokens,
            output_tokens=None,
            max_context=self.max_context,
            is_real=input_tokens is not None,
        )


__all__ = [
    "EXTERNAL_ENGINES",
    "CODEX_ARCELLE_FLAGS",
    "DISPLAY_CONTEXT_FALLBACK",
    "ExternalChatModel",
    "build_agent_cmdline",
    "parse_claude_json_result",
    "parse_codex_json_stream",
    "parse_tool_calls",
    "render_catalog",
    "split_external_model",
    "is_external_model",
    "flatten_messages",
    "flatten_agent_messages",
    "build_cmdline",
    "generate_external",
]
