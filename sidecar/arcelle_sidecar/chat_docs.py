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

#: story.rs — reading a character sheet into a cast.
#:
#: Replaced a hand-written parser that matched headings and labels. It read a
#: tidy sheet correctly and mangled a real one, which is the usual fate of a
#: heuristic meeting a document a person actually wrote: nested lists, tables,
#: numbered items, an appearance split over three bullets under a sub-heading.
#:
#: The two rules that matter are the two a model gets wrong. **Do not invent
#: anyone** — an added character is believed, and ends up in shots. And
#: `description` is for a PICTURE MODEL: it goes verbatim into every prompt
#: that person appears in, so "brave and loyal" is worse than useless there
#: while "tall, grey wool coat, cropped hair" is the whole job.
CAST_SHEET_SYSTEM = (
    "You read a document and list the CHARACTERS it describes.\n"
    "Rules:\n"
    "1. Only people the document actually describes. Never invent a character, "
    "and never turn a place, a chapter heading, a section title, an episode "
    "name or a list label into one. If the document describes no characters, "
    "return an empty list.\n"
    "2. `name` is what they are called, nothing else — no title line, no "
    "numbering, no markdown, no colon.\n"
    "3. `description` is ONLY what they LOOK like — build, age, hair, clothing, "
    "distinguishing marks. It is fed straight to an image model, so personality, "
    "role and history do not belong in it. Gather the appearance from wherever "
    "it appears in their entry, including lists and tables. If the document "
    "never says what they look like, use an empty string rather than guessing.\n"
    "4. `story` is who they are: role, history, what they want, how they speak. "
    "Empty string if the document does not say.\n"
    "5. Copy the document's own wording. Do not embellish, translate or "
    "summarise into your own phrasing.\n"
    "6. Keep the document's language."
)

#: One person as the sheet reader returns them.
CAST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "cast": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "story": {"type": "string"},
                },
                "required": ["name", "description", "story"],
            },
        }
    },
    "required": ["cast"],
}

#: How much document goes into one call.
#:
#: Windowed rather than clamped, and the difference is the whole point: a clamp
#: reads the first N characters and silently reports the rest as "no characters
#: found", which is exactly the `#minutes` failure — a confident answer about
#: the part it happened to see. Every window is read and the results merged.
CAST_WINDOW_CHARS = 12_000
#: Carried between windows so a person split across a boundary is still whole
#: in one of them.
CAST_WINDOW_OVERLAP = 1_200
#: A ceiling on one import, mirroring the Rust. A document that yields more
#: than this is being misread, and importing sixty people nobody asked for is
#: worse than importing none.
CAST_MAX = 40

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


def cast_windows(document: str) -> list[str]:
    """Cut a document into overlapping windows, on paragraph breaks where it can.

    Splitting mid-sentence would hand a window half a character's appearance
    and nothing to attach it to, so a boundary is nudged back to the last blank
    line in the tail of the window when there is one.
    """
    text = document.strip()
    if len(text) <= CAST_WINDOW_CHARS:
        return [text] if text else []
    windows: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + CAST_WINDOW_CHARS, len(text))
        if end < len(text):
            # Look for a paragraph break in the last fifth of the window.
            floor = end - CAST_WINDOW_CHARS // 5
            brk = text.rfind("\n\n", max(start, floor), end)
            if brk > start:
                end = brk
        windows.append(text[start:end].strip())
        if end >= len(text):
            break
        start = max(end - CAST_WINDOW_OVERLAP, start + 1)
    return [w for w in windows if w]


def merge_cast(found: list[dict[str, str]]) -> list[dict[str, str]]:
    """Fold the windows' answers into one cast, first mention wins the name.

    The overlap means a person can come back twice; the same person described
    in two places should be ONE entry with both halves, not two heroes with the
    same name who each know half of themselves. Matched case-insensitively
    because a sheet writes "MIRA" in a heading and "Mira" in the prose.
    """
    merged: list[dict[str, str]] = []
    seen: dict[str, int] = {}
    for person in found:
        name = (person.get("name") or "").strip()
        if not name:
            continue
        key = name.casefold()
        description = (person.get("description") or "").strip()
        story = (person.get("story") or "").strip()
        if key in seen:
            at = merged[seen[key]]
            # Only ADD what is missing. Overwriting would let a later, thinner
            # window erase a full description from an earlier one.
            for field, value in (("description", description), ("story", story)):
                if not value:
                    continue
                if not at[field]:
                    at[field] = value
                elif value.casefold() not in at[field].casefold():
                    at[field] = f"{at[field]} {value}".strip()
            continue
        if len(merged) >= CAST_MAX:
            continue
        seen[key] = len(merged)
        merged.append({"name": name, "description": description, "story": story})
    return merged


def _is_fatal(code: str) -> bool:
    """A hard engine failure is about the ENGINE, never the document (the same
    test as file_pass.py / rec_read.py)."""
    return code == "OLLAMA_DOWN" or code.startswith("MODEL_MISSING")


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
        messages = [
            system_message(CAST_SHEET_SYSTEM),
            user_message(f"Document:\n{window}"),
        ]
        try:
            reply = await _structured(
                model,
                base_url,
                messages,
                CAST_SCHEMA,
                temperature=temperature,
                keep_alive=keep_alive,
                privacy=privacy,
                provider=provider,
            )
            parsed = json.loads(reply.strip())
        except llm.LlmError as exc:
            # A dead daemon or an unpulled model is not this document's fault,
            # and it will be every window's answer — counting it as a window
            # that "was not usable" ends in a message blaming the file, with
            # the sentinel the Rust gateway rebuilds OLLAMA_DOWN /
            # MODEL_MISSING:<model> from (and the UI's "start Ollama" offer)
            # thrown away.
            if _is_fatal(exc.code):
                raise
            failures += 1
            continue
        except (ValueError, TypeError):
            failures += 1
            continue
        people = parsed.get("cast") if isinstance(parsed, dict) else None
        if isinstance(people, list):
            found.extend(p for p in people if isinstance(p, dict))
        else:
            failures += 1
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
