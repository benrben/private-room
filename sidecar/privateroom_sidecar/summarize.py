"""The SUMMARIZE feature's logic (MIGRATION Phase 2).

Ported from ``commands/summarize.rs`` — the two-step map-reduce that builds a
room's "Room summary.html". Rust's job shrinks to gathering the DB text and
storing the returned result; ALL prompts + orchestration live here:

* ``/summarize_file`` (the MAP step, ADD-17/ADD-27) — describe ONE file in one
  factual sentence. For a file that doesn't fit one window the MODEL drives the
  reading: it gets a ``read_text(offset, limit, find)`` tool and up to
  ``MAX_READS`` extra windows over the file's OWN text before a final,
  schema-constrained call produces the sentence. The paging is pure compute over
  the text Rust posted, so the whole loop moves here with no DB round-trips.
* ``/combine_summary`` (the REDUCE step, ADD-17/ADD-22) — the "What this room is
  for" paragraph + three suggested questions, from the per-file one-liners Rust
  gathered. Two single-purpose calls (free-text prose for the purpose, a plain
  string array for the questions) — exactly the split summarize.rs uses because a
  4B model can't fill a nested JSON shape it never sees.

Rust keeps the deterministic HTML assembly + file write (escaping, glyphs, the
canonical "Room summary.html" name, version history) — that is presentation, not
LLM. This module returns only the model-produced pieces: the one-liner, the
purpose paragraph, and the questions.

Privacy (SPEC §6): the model is the loopback Ollama server; tracing is stripped at
package import. Nothing here logs the user's file text.

Error contract: reuses :class:`.llm.LlmError` (OLLAMA_DOWN / MODEL_MISSING /
ENGINE_ERROR) so the routes surface the same ``{error, code}`` bodies the rest of
the gateway does, letting Rust rebuild the sentinels summarize.rs branches on.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict, Field

from . import config
from .llm import LlmError, _classify
from .messages import Message, ToolCall, canonical_json, compact_json

# --- constants (verbatim from summarize.rs / extraction/window.rs) ----------

#: ADD-27: extra reads the model may request per file (summarize.rs MAX_READS).
MAX_READS: int = 4

#: extraction/window.rs — the default/min/max for ONE read window (bytes).
READ_WINDOW_DEFAULT: int = 4_000
READ_WINDOW_MIN: int = 200
READ_WINDOW_MAX: int = 32_000


# --- num_ctx sizing (ollama.rs num_ctx_for / job_context_chars) -------------
#
# Kept here rather than in the (parallel-contended) config module. Uses only the
# stable RAM primitives; mirrors ollama.rs:306 exactly.


def _num_ctx_for(has_tools: bool, tier: str) -> int:
    """ollama.rs ``num_ctx_for(has_tools, CtxTier)``. tier ∈ {"job","chat"}.

    The Job tier ignores ``has_tools`` (a background job always gets the big
    window); the no-tools Chat tier is the smaller 16384/8192. 32 GB+ RAM picks
    the high column, unknown RAM (0) falls to low — same as Rust.
    """
    high = config._total_ram_bytes() >= config._HIGH_RAM_BYTES
    if tier == "job":
        return 131_072 if high else 65_536
    if has_tools:
        return 24_576 if high else 12_288
    return 16_384 if high else 8_192


def _job_context_chars() -> int:
    """ollama.rs ``job_context_chars`` — the Job window in chars (≈3 chars/token,
    a safe floor across English and Hebrew)."""
    return _num_ctx_for(True, "job") * 3


# --- text windowing (ported from extraction/window.rs, BYTE-exact) ----------
#
# Rust slices the file's extracted text on BYTE offsets (snapped to char
# boundaries), and the char-budget arithmetic counts bytes. To keep a Hebrew or
# other multi-byte file summarized identically, we operate on the UTF-8 bytes and
# report the same byte offsets Rust would.


@dataclass(slots=True)
class TextWindow:
    """One window of a file's text. Offsets are BYTE positions into the filtered
    text, always on char boundaries so decoding can never fail."""

    text: str
    offset: int
    end: int
    total: int
    found: bool

    @property
    def nbytes(self) -> int:
        """UTF-8 byte length of ``text`` (== end - offset); the budget unit."""
        return self.end - self.offset


def _floor_char_boundary(data: bytes, i: int) -> int:
    # Rust is_char_boundary(len) is True, so position len (and 0) is a boundary —
    # only step back off an interior continuation byte (0b10xxxxxx).
    i = min(i, len(data))
    while 0 < i < len(data) and (data[i] & 0xC0) == 0x80:
        i -= 1
    return i


def _ceil_char_boundary(data: bytes, i: int) -> int:
    i = min(i, len(data))
    while i < len(data) and (data[i] & 0xC0) == 0x80:
        i += 1
    return i


def _looks_like_noise(line: str) -> bool:
    """window.rs ``looks_like_noise``: a long line that is mostly symbols, or holds
    an unbroken 80+ char run (base64/hex/minified), is junk for a summary."""
    if len(line.encode("utf-8")) < 40:  # Rust line.len() is BYTES
        return False
    total = max(len(line), 1)  # Rust chars().count()
    allowed = set(".,;:!?'\"()-/&%$€@")
    wordish = sum(1 for c in line if c.isalnum() or c.isspace() or c in allowed)
    if wordish / total < 0.7:
        return True
    return any(len(w.encode("utf-8")) > 80 for w in line.split())  # Rust w.len() bytes


def smart_filter(text: str) -> str:
    """window.rs ``smart_filter``: drop the low-signal lines a big extraction is
    full of (binary/base64 junk, repeated boilerplate, blank runs). Conservative:
    prose, code and tables pass through untouched."""
    out: list[str] = []
    prev_line = ""
    blank_run = 0
    # Rust iterates str::lines(): split on '\n' but WITHOUT the trailing empty
    # segment a final newline would produce (a trailing '\r' is stripped by the
    # per-line rstrip below, matching Rust's trim_end()).
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    for line in lines:
        trimmed = line.rstrip()
        if not trimmed.strip():
            blank_run += 1
            if blank_run == 1:
                out.append("")
            continue
        blank_run = 0
        if trimmed == prev_line:  # repeated page header/footer
            continue
        if _looks_like_noise(trimmed):
            continue
        out.append(trimmed)
        prev_line = trimmed
    # Rust pushes each kept line + '\n' and a single '\n' per blank run, so the
    # result always ends with a trailing newline after the last non-blank line.
    joined = "".join(s + "\n" if s != "" else "\n" for s in out)
    return joined


def read_window(data: bytes, offset: int, limit: int, find: str | None) -> TextWindow:
    """window.rs ``read_window``: cut one window out of the filtered text bytes.

    ``limit`` is clamped to [MIN, MAX]. ``find`` (trimmed, non-empty) jumps to the
    first ASCII-case-insensitive occurrence at-or-after ``offset``, starting ~200
    bytes early for context; a miss leaves the window at ``offset`` with
    ``found=False`` so the model learns it missed.
    """
    total = len(data)
    limit = max(READ_WINDOW_MIN, min(limit, READ_WINDOW_MAX))
    start = _floor_char_boundary(data, min(offset, total))
    found = False
    needle = (find or "").strip()
    if needle:
        # bytes.lower() lowercases only ASCII, leaving other bytes (and therefore
        # every byte offset) exact — same as Rust to_ascii_lowercase.
        hay = data[start:].lower()
        pos = hay.find(needle.encode("utf-8").lower())
        if pos != -1:
            start = _floor_char_boundary(data, max(0, start + pos - 200))
            found = True
    end = _ceil_char_boundary(data, min(start + limit, total))
    return TextWindow(
        text=data[start:end].decode("utf-8", "replace"),
        offset=start,
        end=end,
        total=total,
        found=found,
    )


# --- reply cleanup (ported from retrieval.rs / summarize.rs / ollama.rs) -----


def strip_markup_blocks(content: str) -> str:
    """retrieval.rs ``strip_markup_blocks``: remove fenced ```boxes / ```annotation
    UI-markup payloads (viewer data, not conversation text)."""
    out = content
    for tag in ("```boxes", "```annotation"):
        while (start := out.find(tag)) != -1:
            after = out[start + len(tag):]
            end = after.find("```")
            out = (out[:start] + after[end + 3:]) if end != -1 else out[:start]
            out = out.strip()
    return out


def clean_one_liner(raw: str) -> str:
    """summarize.rs ``clean_one_liner``: trim a reply down to one clean sentence —
    first non-empty line, list markers stripped, capped at 200 chars."""
    stripped = strip_markup_blocks(raw)
    line = ""
    for candidate in stripped.split("\n"):
        t = candidate.strip()
        if t:
            line = t
            break
    line = line.lstrip("-*#> ")
    return line[:200].strip()


def strip_think_spans(raw: str) -> str:
    """ollama.rs ``strip_think_spans``: drop ``<think>…</think>`` reasoning spans a
    model leaks into its visible answer; an UNTERMINATED ``<think>`` truncates
    everything after it (unclosed reasoning, not answer)."""
    out = raw
    while (start := out.find("<think>")) != -1:
        rel = out[start:].find("</think>")
        if rel != -1:
            end = start + rel + len("</think>")
            out = out[:start] + out[end:]
        else:
            out = out[:start]
            break
    return out


def recover_json(text: str) -> str:
    """ollama.rs ``recover_json``: strip ``<think>`` then slice from the first
    opening bracket to the last closing one, so a fenced / preambled JSON reply
    (Ollama ``:cloud`` models ignore ``format``) still parses."""
    s = strip_think_spans(text.strip()).strip()
    opens = [i for i, c in enumerate(s) if c in "{["]
    closes = [i for i, c in enumerate(s) if c in "}]"]
    if opens and closes:
        a, b = opens[0], closes[-1]
        if b >= a:
            return s[a: b + 1]
    return s


def json_str_field(raw: str, key: str) -> str | None:
    """json.rs ``json_str_field``: the trimmed string at ``key`` of a JSON object,
    or None when the reply isn't JSON / isn't an object / has no string there."""
    try:
        obj = json.loads(raw.strip())
    except (ValueError, TypeError):
        return None
    if isinstance(obj, dict) and isinstance(obj.get(key), str):
        return obj[key].strip()
    return None


def parse_string_list(raw: str) -> list[str]:
    """docs_html.rs ``parse_string_list``: a JSON string array from a model reply,
    tolerating leading/trailing prose; falls back to line/bullet splitting. Deduped
    (case-insensitive), trimmed, capped at 12."""
    cleaned = strip_think_spans(raw)
    items: list[str] = []
    start = cleaned.find("[")
    if start != -1:
        try:
            # Rust reads ONE JSON value starting at '['; json.JSONDecoder.raw_decode
            # does the same (stops at the end of the first array, ignores a tail).
            value, _ = json.JSONDecoder().raw_decode(cleaned[start:])
            if isinstance(value, list):
                items = [v for v in value if isinstance(v, str)]
        except ValueError:
            items = []
    if not items:
        for line in cleaned.split("\n"):
            t = line.strip().lstrip("0123456789-*.) ").strip()
            if t and len(t) < 80:
                items.append(t)
    out: list[str] = []
    seen: set[str] = set()
    for s in items:
        s = s.strip()
        low = s.lower()
        if s and low not in seen:
            seen.add(low)
            out.append(s)
        if len(out) >= 12:
            break
    return out


# --- the read_text tool + its argument parsing (summarize.rs) ---------------


def read_text_tool() -> list[dict[str, Any]]:
    """summarize.rs ``read_text_tool``: the one tool offered during the gather
    phase — a paged, filtered read over the file's OWN text."""
    return [
        {
            "type": "function",
            "function": {
                "name": "read_text",
                "description": (
                    "Read another part of this file's text. offset picks where to "
                    "start (0 = beginning), limit is how many characters to read "
                    "(200-6000), find jumps to the next place a word or phrase "
                    "appears at or after offset."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "offset": {"type": "integer", "description": "Character position to read from"},
                        "limit": {"type": "integer", "description": "How many characters to read"},
                        "find": {"type": "string", "description": "Optional word or phrase to jump to"},
                    },
                },
            },
        }
    ]


def _num(v: Any) -> int | None:
    """summarize.rs ``read_args::num``: a usize tolerating int/float/str, clamped
    at 0 (a negative float floors to 0, like ``f.max(0.0) as usize``)."""
    if isinstance(v, bool):  # bool is an int subclass — never a coordinate
        return None
    if isinstance(v, int):
        return max(0, v)
    if isinstance(v, float):
        return int(max(0.0, v))
    if isinstance(v, str):
        try:
            return int(v.strip())
        except ValueError:
            return None
    return None


def read_args(args: dict[str, Any]) -> tuple[int, int, str | None]:
    """summarize.rs ``read_args``: (offset, limit, find) out of a read_text call,
    tolerating numbers as strings/floats and a blank ``find``."""
    offset = _num(args.get("offset"))
    offset = offset if offset is not None else 0
    limit = _num(args.get("limit"))
    limit = limit if limit is not None else READ_WINDOW_DEFAULT
    find_raw = args.get("find")
    find = find_raw.strip() if isinstance(find_raw, str) and find_raw.strip() else None
    return offset, limit, find


# --- the model seam ---------------------------------------------------------
#
# One thin async class over the loopback Ollama server. Kept behind a Protocol so
# the orchestration is testable with a scripted fake — no network, no weights.


class ModelClient(Protocol):
    async def chat_tools(
        self,
        model: str,
        messages: list[Message],
        tools: list[dict[str, Any]],
        *,
        temperature: float | None,
        num_ctx: int,
        keep_alive: str,
    ) -> tuple[str, list[ToolCall]]:
        ...

    async def generate(
        self,
        model: str,
        messages: list[Message],
        *,
        temperature: float | None,
        num_ctx: int,
        keep_alive: str,
        format: dict[str, Any] | None = None,  # noqa: A002 - Ollama arg name
    ) -> str:
        ...


class OllamaModelClient:
    """The real seam: a local Ollama server over loopback, nothing else.

    Reproduces the summarize.rs wire calls: same ``options.num_ctx``/temperature,
    same ``keep_alive``, and the same qwen3 ``think`` rule (ollama.rs:603 — the
    flag is sent ONLY to qwen3 non-instruct models; the gather loop turns it ON,
    every other call leaves it OFF). Exceptions are re-raised as the sentinel
    :class:`.llm.LlmError` contract.
    """

    def __init__(self, base_url: str, privacy: dict[str, Any] | None = None) -> None:
        from .privacy import policy_from_payload

        self.base_url = base_url
        # PRIV-1: the room's policy rides the request body; the door engages in
        # _chat only when the model is non-local.
        self.privacy = policy_from_payload(privacy)

    async def _chat(
        self,
        model: str,
        messages: list[Message],
        *,
        tools: list[dict[str, Any]] | None,
        format: dict[str, Any] | None,  # noqa: A002
        temperature: float | None,
        num_ctx: int,
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
            text = await generate_external(model, messages, format=format)
            return (engaged.restore_text(text) if engaged else text), []

        options: dict[str, Any] = {"num_ctx": num_ctx}
        if temperature is not None:
            options["temperature"] = temperature
        # ollama.rs:603 — only qwen3 non-instruct models accept (and need) the flag.
        think = think_on if ("qwen3" in model and "instruct" not in model) else None
        try:
            resp = await AsyncClient(host=self.base_url).chat(
                model=model,
                messages=[dict(m) for m in messages],
                tools=tools,
                format=format,
                options=options,
                keep_alive=keep_alive,
                think=think,
                stream=False,
            )
        except Exception as exc:  # noqa: BLE001 - re-raised as the sentinel contract
            raise _classify(exc) from exc
        content = resp.message.content or ""
        if engaged is not None:
            content = engaged.restore_text(content)
        calls: list[ToolCall] = []
        for i, tc in enumerate(resp.message.tool_calls or []):
            name = getattr(tc.function, "name", "") or ""
            if not name:
                continue
            args = dict(tc.function.arguments or {})
            if engaged is not None:
                args = engaged.restore_value(args)
            cid = f"call_{i}"
            calls.append(
                ToolCall(
                    name=name,
                    arguments=args,
                    id=cid,
                    raw={"id": cid, "type": "function", "function": {"name": name, "arguments": args}},
                )
            )
        return content, calls

    async def chat_tools(
        self,
        model: str,
        messages: list[Message],
        tools: list[dict[str, Any]],
        *,
        temperature: float | None,
        num_ctx: int,
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
        num_ctx: int,
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


async def _chat_structured(
    client: ModelClient,
    model: str,
    messages: list[Message],
    temperature: float | None,
    keep_alive: str,
    schema: dict[str, Any],
    tier: str,
) -> str:
    """ollama.rs ``chat_structured``: a one-shot call CONSTRAINED to ``schema`` via
    Ollama ``format`` (grammar token masking), plus the schema appended to the last
    user turn (a small model fills a forced JSON shape with empty strings unless it
    SEES the field names), and ``recover_json`` on the reply.
    """
    primed = [dict(m) for m in messages]
    for m in reversed(primed):
        if m.get("role") == "user":
            m["content"] = (m.get("content", "") or "") + (
                "\n\nReply with ONLY JSON matching this schema, filling every field "
                f"with real content:\n{compact_json(schema)}"
            )
            break
    num_ctx = _num_ctx_for(False, tier)
    raw = await client.generate(
        model,
        primed,
        temperature=temperature,
        num_ctx=num_ctx,
        keep_alive=keep_alive,
        format=schema,
    )
    return recover_json(raw)


# --- the map step: summarize_one_file (summarize.rs) ------------------------


async def summarize_one_file(
    client: ModelClient,
    model: str,
    name: str,
    mime: str,
    text: str,
    keep_alive: str,
) -> str:
    """summarize.rs ``summarize_one_file``: describe a single file in ONE sentence.

    ``text`` is the file's FULL extracted text; it is noise-filtered, and when it
    doesn't fit one window the model drives the reading (``read_text``) up to
    ``MAX_READS`` extra windows before a final schema-constrained call.
    """
    filtered = smart_filter(text)
    data = filtered.encode("utf-8")
    head = read_window(data, 0, READ_WINDOW_DEFAULT, None)
    whole = head.end >= len(data)
    # Deterministic baseline samples for a long file, and a cumulative read budget
    # derived from the engine's REAL context (spend it on file text, not a fixed
    # snippet). All arithmetic is in BYTES to match Rust exactly.
    mid = read_window(data, len(data) // 2, 2_000, None)
    tail = read_window(data, max(0, len(data) - 2_000), 2_000, None)
    remaining = max(0, _job_context_chars() - (head.nbytes + mid.nbytes + tail.nbytes + 8_000))

    if whole:
        system = (
            "You describe a single file in ONE short, factual sentence based only "
            "on what is given."
        )
        user = (
            f"File name: {name}\nType: {mime}\n\nIts text:\n{head.text}\n\n"
            "In one sentence, what is this file about?"
        )
    else:
        system = (
            "You describe a single file in ONE short, factual sentence based only "
            "on what you read from it. You see samples of a longer file. If the "
            "samples hint that the important content is elsewhere (a table of "
            "contents, a reference to a later section, a phrase worth locating), "
            "you MUST call read_text to look there (find jumps to a phrase, offset "
            "picks a position) before answering. If the samples already show what "
            "the file is, answer directly."
        )
        # Beginning, middle and end up front, so even a model that never touches
        # read_text summarizes the file's whole shape, not just page one.
        user = (
            f"File name: {name}\nType: {mime}\nText length: {head.total} characters\n\n"
            f"Characters 0-{head.end} (beginning):\n{head.text}\n\n"
            f"Characters {mid.offset}-{mid.end} (middle):\n{mid.text}\n\n"
            f"Characters {tail.offset}-{tail.end} (end):\n{tail.text}\n\n"
            "In one sentence, what is this file about?"
        )

    messages: list[Message] = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]

    if not whole:
        tools = read_text_tool()
        seen: set[str] = set()
        reads = 0
        num_ctx = _num_ctx_for(True, "job")
        while reads < MAX_READS and remaining >= READ_WINDOW_MIN:
            # ADD-27: thinking ON — without it, qwen3-family models answer straight
            # from the samples and never touch the tool.
            try:
                _content, calls = await client.chat_tools(
                    model, list(messages), tools, temperature=0.2, num_ctx=num_ctx, keep_alive=keep_alive
                )
            except LlmError as exc:
                # Ollama down / model missing: every remaining call would fail too.
                if exc.code in ("OLLAMA_DOWN", "MODEL_MISSING"):
                    raise
                # A model with no tool support must not lose its summary: degrade to
                # answering from the samples alone (pre-ADD-27 behavior).
                break
            if not calls:
                break
            messages.append(
                {"role": "assistant", "content": "", "tool_calls": [c.to_raw() for c in calls]}
            )
            for call in calls:
                if call.name != "read_text":
                    result = "Unknown tool: only read_text is available."
                elif canonical_json(call.arguments) in seen:
                    result = (
                        "You already read exactly this window; ask for a different "
                        "offset or find, or answer now."
                    )
                else:
                    seen.add(canonical_json(call.arguments))
                    reads += 1
                    offset, limit, find = read_args(call.arguments)
                    limit = min(limit, remaining)  # spend at most what's left
                    w = read_window(data, offset, limit, find)
                    # A find that lands inside the already-shown head sample wastes
                    # the read — jump to the next occurrence past the shown region.
                    if w.found and w.offset < head.end:
                        again = read_window(data, head.end, limit, find)
                        if again.found:
                            w = again
                    remaining = max(0, remaining - w.nbytes)
                    note = (
                        f' ("{find}" was not found after that offset)'
                        if find and not w.found
                        else ""
                    )
                    result = f"Characters {w.offset}-{w.end} of {w.total}{note}:\n{w.text}"
                messages.append({"role": "tool", "content": result, "tool_name": call.name})
                if reads >= MAX_READS or remaining < READ_WINDOW_MIN:
                    break
        messages.append(
            {
                "role": "user",
                "content": "Based on everything you read, in one sentence, what is this file about?",
            }
        )

    # ADD-22: a single guaranteed string field, so a chatty model can't wrap the
    # sentence in preamble/markup. Job tier: the gathered windows can far exceed
    # the small chat num_ctx.
    schema = {
        "type": "object",
        "properties": {"summary": {"type": "string"}},
        "required": ["summary"],
    }
    raw = await _chat_structured(client, model, messages, 0.2, keep_alive, schema, "job")
    # A reply that isn't the JSON envelope still usually contains the sentence, so
    # fall back to the raw text rather than losing the summary.
    summary = json_str_field(raw, "summary")
    if summary is None:
        summary = raw
    return clean_one_liner(summary)


# --- the reduce step: combine_summary (summarize.rs) ------------------------


async def combine_summary(
    client: ModelClient,
    model: str,
    room_name: str,
    memories: list[str],
    file_lines: str,
) -> tuple[str, list[str]]:
    """summarize.rs ``combine_summary``: the "What this room is for" paragraph +
    three suggested questions, from the per-file one-liners Rust gathered.

    TWO single-purpose calls (ADD-22 fix): free-text prose for the purpose (what a
    4B model does most reliably) and a plain string array for the questions. The
    purpose call's errors propagate (Rust ``?``); the questions call swallows
    errors and yields ``[]`` (Rust ``unwrap_or_default``).
    """
    context = f"Room name: {room_name}\n\nFiles and what each is:\n{file_lines}\n"
    if memories:
        context += "\nMemory notes the user saved for this room:\n"
        for m in memories:
            context += f"- {m}\n"

    # Purpose: free-text prose. chat_stream_tools with no tools == a plain no-tools
    # Chat-tier generate; strip any leaked <think> span.
    purpose_messages: list[Message] = [
        {
            "role": "system",
            "content": (
                "You describe what a personal document room is for. In 2-4 "
                "sentences, say what the room is about and the main topics it "
                "covers, based only on the file list. Be specific and concrete. No "
                "preamble, no bullet lists, no file names."
            ),
        },
        {"role": "user", "content": context},
    ]
    purpose_raw = await client.generate(
        model,
        purpose_messages,
        temperature=0.4,
        num_ctx=_num_ctx_for(False, "chat"),
        keep_alive=config.KEEP_ALIVE_WARM,
    )
    purpose = strip_think_spans(purpose_raw).strip()

    # Questions: a plain string array, schema-constrained at the Chat tier. Errors
    # are swallowed to an empty list (Rust unwrap_or_default).
    questions_messages: list[Message] = [
        {
            "role": "system",
            "content": (
                "You suggest example questions a user could ask about their own "
                "documents. Give exactly three short, specific questions that these "
                "files would actually answer."
            ),
        },
        {"role": "user", "content": context},
    ]
    schema = {"type": "array", "items": {"type": "string"}, "minItems": 3, "maxItems": 3}
    try:
        questions_raw = await _chat_structured(
            client, model, questions_messages, 0.4, config.KEEP_ALIVE_WARM, schema, "chat"
        )
    except LlmError:
        questions_raw = ""
    questions = parse_string_list(questions_raw)[:3]

    return purpose, questions


# --- HTTP request bodies ----------------------------------------------------
#
# Defined here (not the parallel-contended config module) to keep the whole
# feature self-contained. Each carries the Ollama ``base_url`` the sidecar should
# use (ollama::resolved_base_url() on the Rust side).


class SummarizeFileRequest(BaseModel):
    """Body of ``POST /summarize_file`` — the map step for ONE file."""

    model_config = ConfigDict(extra="ignore")

    model: str
    name: str
    text: str
    mime: str = ""
    base_url: str = "http://127.0.0.1:11434"
    keep_alive: str = "30m"
    #: PRIV-1: room privacy policy payload (config.RunRequest docstring).
    privacy: dict[str, Any] | None = None


class CombineSummaryRequest(BaseModel):
    """Body of ``POST /combine_summary`` — the reduce step from the one-liners."""

    model_config = ConfigDict(extra="ignore")

    model: str
    room_name: str
    file_lines: str
    memories: list[str] = Field(default_factory=list)
    base_url: str = "http://127.0.0.1:11434"
    keep_alive: str = "30m"
    #: PRIV-1: room privacy policy payload (config.RunRequest docstring).
    privacy: dict[str, Any] | None = None


__all__ = [
    "MAX_READS",
    "READ_WINDOW_DEFAULT",
    "READ_WINDOW_MIN",
    "READ_WINDOW_MAX",
    "TextWindow",
    "smart_filter",
    "read_window",
    "strip_markup_blocks",
    "clean_one_liner",
    "strip_think_spans",
    "recover_json",
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
