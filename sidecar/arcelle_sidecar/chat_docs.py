"""Chat-command AI logic ported to Python (MIGRATION Phase 2).

Two chat_commands carry the most bespoke prompts in
``commands/chat_commands/{knowledge,generate}.rs``:

  * ``#extract`` (knowledge.rs ``cmd_extract``) — pull named fields out of a
    document into a row. The genuinely fuzzy step is the field extraction.
  * ``#add-file`` (knowledge.rs ``cmd_add_file``) — enumerate a list from the
    conversation, then WRITE a document body per item (or one for a single
    topic). The fuzzy steps are the enumeration and the DOC_SYS writing.

Their PROMPT + parse logic now lives here; Rust still gathers the DB text (file
bodies, conversation history, ``refs_context``) and keeps the file-writing /
event-emitting / cancellation orchestration — only the compute moves.

Faithfulness (SPEC "same output, same error surfaces"):
  * The two STRUCTURED calls (fields, list) reproduce ollama.rs
    ``chat_structured`` EXACTLY — the schema is appended to the last user message
    ("schema-in-prompt priming", without which a small model fills the forced
    JSON with empty strings), and the raw reply is run through ``recover_json``
    (Ollama cloud models fence-wrap JSON / emit a ``<think>`` preamble) before
    parsing. ``parse_string_list`` / ``value_str`` reproduce docs_html.rs /
    json.rs byte for byte.
  * The doc-body call reproduces ``ask_quiet`` — a PLAIN chat turn (no ``format``,
    no priming, no JSON recovery), temperature 0.4, returned verbatim.
  * ``num_ctx`` is omitted, so Ollama/the selected model owns its context
    window instead of an app-level chat tier constraining it.

The model I/O (and the OLLAMA_DOWN / MODEL_MISSING error classification the Rust
gateway branches on) is delegated to :func:`llm.generate`, so these endpoints
share the exact error contract of the Phase-1 gateway.
"""

from __future__ import annotations

import json
from typing import Any

from . import llm
from .config import KEEP_ALIVE_WARM
from .messages import Message, system_message, user_message
from .model_text import prime_schema, recover_json, strip_think_spans

# --- verbatim prompts (from the Rust) ---------------------------------------

#: knowledge.rs cmd_extract — the field-extraction system prompt.
EXTRACT_FIELDS_SYSTEM = (
    "You extract specific fields from a document. Fill each field with its value "
    'copied from the document, or "(not found)" if it is absent.'
)

#: knowledge.rs cmd_add_file — the for-each enumeration system prompt.
LIST_NAMES_SYSTEM = "You extract a list of short names from a conversation."

#: docs_html.rs DOC_SYS — the HTML document-body writer (ADD-22).
DOC_SYS = (
    "You write the body of a single clear, well-structured HTML document "
    "using simple tags only: <h2>, <h3>, <p>, <ul>/<li>, <ol>/<li>, <strong>, <em>, <a>, "
    "<blockquote>, <table>/<tr>/<td>. Open with ONE short <p> that sums up the document, then "
    "organize the rest under <h2> section headings. Do NOT repeat the document's title as a "
    "heading — it is added for you. Output ONLY the inner HTML — no <html>, <head>, <body>, <h1> "
    'or <style> tags, no code fences, no preamble, no "Here is".'
)

#: The value a field gets when the document does not contain it (cmd_extract).
NOT_FOUND = "(not found)"

# --- Rust helper reproductions ----------------------------------------------


#: docs_html.rs parse_string_list strips these from the START of a fallback line
#: (ASCII digits plus these list markers). A ``str.lstrip`` char set.
_LINE_MARKERS = "0123456789-*.) "


def parse_string_list(raw: str) -> list[str]:
    """docs_html.rs ``parse_string_list``: a JSON array of strings (tolerating
    leading/trailing prose), else newline/bullet splitting. Trimmed and deduped
    case-insensitively; byte length (< 80) matches the Rust.

    Uncapped: ``#add-file for each`` writes a file per item the user asked for,
    so a 20-item list must not quietly become the first 12 files.
    """
    cleaned = strip_think_spans(raw)
    items: list[str] = []
    start = cleaned.find("[")
    if start != -1:
        try:
            value, _ = json.JSONDecoder().raw_decode(cleaned[start:])
        except ValueError:
            value = None
        if isinstance(value, list):
            for v in value:
                if isinstance(v, str):
                    items.append(v)
    if not items:
        for line in cleaned.splitlines():
            t = line.strip().lstrip(_LINE_MARKERS).strip()
            if t and len(t.encode("utf-8")) < 80:
                items.append(t)
    seen: set[str] = set()
    out: list[str] = []
    for s in items:
        s = s.strip()
        if not s:
            continue
        low = s.lower()
        if low in seen:
            continue
        seen.add(low)
        out.append(s)
    return out


def value_str(parsed: Any, key: str) -> str:
    """json.rs ``value_str``: the trimmed string at ``key`` of an object, ``""``
    when absent or not a string (a non-object parse yields ``""`` for every key)."""
    if not isinstance(parsed, dict):
        return ""
    x = parsed.get(key)
    if not isinstance(x, str):
        return ""
    return x.strip()


# --- model calls (reproduce chat_structured / ask_quiet) --------------------


async def _structured(
    model: str,
    base_url: str,
    messages: list[Message],
    schema: dict[str, Any],
    *,
    temperature: float,
    keep_alive: str,
    privacy: dict[str, Any] | None = None,
    provider: Any | None = None,
) -> str:
    """One structured turn = chat_structured: prime the prompt with the schema,
    generate with ``format=schema`` at the no-tools Chat window, recover the JSON."""
    primed = prime_schema(messages, schema)
    raw = await llm.generate(
        model,
        primed,
        base_url,
        temperature=temperature,
        keep_alive=keep_alive,
        format=schema,
        privacy=privacy,
        provider=provider,
    )
    return recover_json(raw)


async def _plain(
    model: str,
    base_url: str,
    messages: list[Message],
    *,
    temperature: float,
    keep_alive: str,
    privacy: dict[str, Any] | None = None,
    provider: Any | None = None,
) -> str:
    """One plain turn = ask_quiet: no ``format``, no priming, no JSON recovery."""
    return await llm.generate(
        model,
        messages,
        base_url,
        temperature=temperature,
        keep_alive=keep_alive,
        privacy=privacy,
        provider=provider,
    )


# --- feature functions ------------------------------------------------------


async def extract_fields(
    model: str,
    base_url: str,
    fields: list[str],
    document: str,
    *,
    temperature: float = 0.0,
    keep_alive: str = KEEP_ALIVE_WARM,
    privacy: dict[str, Any] | None = None,
    provider: Any | None = None,
) -> dict[str, str]:
    """knowledge.rs cmd_extract, one document. One string property per requested
    field (all required) so the reply is a JSON object keyed by the field names;
    each field maps to its value or ``"(not found)"``, in the requested order.

    A reply that is not a readable JSON OBJECT raises :class:`.llm.LlmError`
    rather than answering ``"(not found)"`` for everything — see below."""
    props: dict[str, Any] = {f: {"type": "string"} for f in fields}
    schema = {"type": "object", "properties": props, "required": list(fields)}
    field_lines = "\n".join(fields)
    messages = [
        system_message(EXTRACT_FIELDS_SYSTEM),
        user_message(f"Fields:\n{field_lines}\n\nDocument:\n{document}"),
    ]
    reply = await _structured(
        model,
        base_url,
        messages,
        schema,
        temperature=temperature,
        keep_alive=keep_alive,
        privacy=privacy,
        provider=provider,
    )
    try:
        parsed = json.loads(reply.strip())
    except (ValueError, TypeError):
        parsed = None
    if not isinstance(parsed, dict):
        # An UNREADABLE answer is not the same as a document that lacks the
        # fields. Defaulting every column to "(not found)" here looks exactly
        # like a searched-and-absent result, so the user concludes their file
        # doesn't hold what it does. Surface it instead: knowledge.rs cmd_extract
        # already has the honest branch for a window that errored — it calls
        # `note_unread()` ("this window went unread") and lets a LATER window of
        # the same file still answer the field.
        raise llm.LlmError(
            "UNREADABLE_REPLY",
            "The model's reply wasn't usable JSON, so this text went unread.",
        )
    values: dict[str, str] = {}
    for f in fields:
        val = value_str(parsed, f)
        values[f] = val if val else NOT_FOUND
    return values


async def enumerate_names(
    model: str,
    base_url: str,
    subject: str,
    conversation: str,
    *,
    temperature: float = 0.0,
    keep_alive: str = KEEP_ALIVE_WARM,
    privacy: dict[str, Any] | None = None,
    provider: Any | None = None,
) -> list[str]:
    """knowledge.rs cmd_add_file "for each" — enumerate the ``subject`` as short
    names from the conversation, guaranteed a JSON string array.

    Uncapped HERE on purpose — enumerating is the fuzzy step and cutting the
    list at this end would hide from the caller how long it really was. The cap
    that keeps a hundred-item list from filling the room lives with the loop
    that writes the files (``knowledge.rs`` ``MAX_FAN_OUT_FILES``), where the
    overflow can be counted and named in the answer."""
    schema = {"type": "array", "items": {"type": "string"}}
    messages = [
        system_message(LIST_NAMES_SYSTEM),
        user_message(
            f"From the conversation below, list EVERY one of the {subject} as short names. "
            f"If there are none, return an empty array.\n\nConversation:\n{conversation}"
        ),
    ]
    reply = await _structured(
        model,
        base_url,
        messages,
        schema,
        temperature=temperature,
        keep_alive=keep_alive,
        privacy=privacy,
        provider=provider,
    )
    return parse_string_list(reply)


async def generate_doc(
    model: str,
    base_url: str,
    *,
    mode: str = "single",
    topic: str = "",
    context: str = "",
    item: str = "",
    history: str = "",
    temperature: float = 0.4,
    keep_alive: str = KEEP_ALIVE_WARM,
    privacy: dict[str, Any] | None = None,
    provider: Any | None = None,
) -> str:
    """knowledge.rs cmd_add_file document body (DOC_SYS). ``mode``:

    * ``"single"`` — one document about ``topic``, optionally prefixed by
      ``context`` (Rust ``refs_context``, may be ``""``).
    * ``"each"`` — one note about ``item``, grounded in the conversation ``history``.

    Returns the raw model body verbatim; Rust checks emptiness and wraps it in the
    styled HTML page."""
    if mode == "each":
        user = (
            f'Write a concise, useful note about "{item}", grounded in this '
            f"conversation where relevant:\n\n{history}"
        )
    else:  # "single"
        user = f"{context}Write a well-structured document about: {topic}"
    messages = [system_message(DOC_SYS), user_message(user)]
    return await _plain(
        model,
        base_url,
        messages,
        temperature=temperature,
        keep_alive=keep_alive,
        privacy=privacy,
        provider=provider,
    )


__all__ = [
    "EXTRACT_FIELDS_SYSTEM",
    "LIST_NAMES_SYSTEM",
    "DOC_SYS",
    "NOT_FOUND",
    "parse_string_list",
    "value_str",
    "extract_fields",
    "enumerate_names",
    "generate_doc",
]
