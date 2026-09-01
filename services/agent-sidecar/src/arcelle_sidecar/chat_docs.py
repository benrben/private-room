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
from .chat_docs_cast import (
    CAST_SCHEMA,
    CAST_SHEET_SYSTEM,
    CAST_MAX as CAST_MAX,
    CAST_WINDOW_CHARS as CAST_WINDOW_CHARS,
    CAST_WINDOW_OVERLAP as CAST_WINDOW_OVERLAP,
    cast_windows,
    merge_cast,
)
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


def _json_string_items(cleaned: str) -> list[str]:
    start = cleaned.find("[")
    if start == -1:
        return []
    try:
        value, _ = json.JSONDecoder().raw_decode(cleaned[start:])
    except ValueError:
        return []
    return _string_entries(value)


def _string_entries(values: list[Any]) -> list[str]:
    entries: list[str] = []
    for value in values:
        if isinstance(value, str):
            entries.append(value)
    return entries


def _fallback_string_items(cleaned: str) -> list[str]:
    entries: list[str] = []
    for line in cleaned.splitlines():
        item = line.strip().lstrip(_LINE_MARKERS).strip()
        if item and len(item.encode("utf-8")) < 80:
            entries.append(item)
    return entries


def _unique_trimmed_items(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        trimmed = item.strip()
        if not trimmed:
            continue
        key = trimmed.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(trimmed)
    return out


def parse_string_list(raw: str) -> list[str]:
    """docs_html.rs ``parse_string_list``: a JSON array of strings (tolerating
    leading/trailing prose), else newline/bullet splitting. Trimmed and deduped
    case-insensitively; byte length (< 80) matches the Rust.

    Uncapped: ``#add-file for each`` writes a file per item the user asked for,
    so a 20-item list must not quietly become the first 12 files.
    """
    cleaned = strip_think_spans(raw)
    items = _json_string_items(cleaned)
    if not items:
        items = _fallback_string_items(cleaned)
    return _unique_trimmed_items(items)


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


def _is_fatal(code: str) -> bool:
    """A hard engine failure is about the ENGINE, never the document (the same
    test as file_pass.py / rec_read.py)."""
    return code == "OLLAMA_DOWN" or code.startswith("MODEL_MISSING")


def _cast_messages(window: str) -> list[Message]:
    return [
        system_message(CAST_SHEET_SYSTEM),
        user_message(f"Document:\n{window}"),
    ]


def _cast_people(reply: str) -> list[dict[str, str]] | None:
    parsed = json.loads(reply.strip())
    if not isinstance(parsed, dict):
        return None
    people = parsed.get("cast")
    if not isinstance(people, list):
        return None
    return [person for person in people if isinstance(person, dict)]


async def _read_cast_window(
    model: str,
    base_url: str,
    window: str,
    *,
    temperature: float,
    keep_alive: str,
    privacy: dict[str, Any] | None,
    provider: Any | None,
) -> list[dict[str, str]] | None:
    try:
        reply = await _structured(
            model,
            base_url,
            _cast_messages(window),
            CAST_SCHEMA,
            temperature=temperature,
            keep_alive=keep_alive,
            privacy=privacy,
            provider=provider,
        )
        return _cast_people(reply)
    except llm.LlmError as exc:
        if _is_fatal(exc.code):
            raise
    except (ValueError, TypeError):
        pass
    return None


async def extract_cast(
    model: str,
    base_url: str,
    document: str,
    *,
    temperature: float = 0.0,
    keep_alive: str = KEEP_ALIVE_WARM,
    privacy: dict[str, Any] | None = None,
    provider: Any | None = None,
) -> list[dict[str, str]]:
    """Read a character sheet into people.

    Every window is read; an unreadable answer for ONE window is skipped rather
    than failing the import, because the other windows still hold real
    characters and losing them to one bad reply would be the worse trade. A
    document where NO window could be read raises, so "the model could not read
    this" never arrives disguised as "this file has no characters in it".

    A FATAL engine failure (OLLAMA_DOWN / MODEL_MISSING) is not a window that
    could not be read — it raises unchanged on the first window, keeping the
    code the Rust gateway and the UI branch on.
    """
    windows = cast_windows(document)
    if not windows:
        return []
    found: list[dict[str, str]] = []
    failures = 0
    for window in windows:
        people = await _read_cast_window(
            model,
            base_url,
            window,
            temperature=temperature,
            keep_alive=keep_alive,
            privacy=privacy,
            provider=provider,
        )
        if people is None:
            failures += 1
            continue
        found.extend(people)
    if failures == len(windows):
        raise llm.LlmError(
            "ENGINE_ERROR",
            "the model could not read this file as a character sheet — its "
            "answer was not usable",
        )
    return merge_cast(found)


__all__ = [
    "EXTRACT_FIELDS_SYSTEM",
    "LIST_NAMES_SYSTEM",
    "CAST_SHEET_SYSTEM",
    "cast_windows",
    "merge_cast",
    "extract_cast",
    "DOC_SYS",
    "NOT_FOUND",
    "parse_string_list",
    "value_str",
    "extract_fields",
    "enumerate_names",
    "generate_doc",
]
