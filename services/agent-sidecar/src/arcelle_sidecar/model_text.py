"""Recovering usable text and JSON out of a model's prose reply.

The two halves of what ollama.rs ``chat_structured`` did around a structured
call, ported once and shared by every caller (they used to be copied per feature
module, which is why ``wf_nodes`` imported ``file_pass.recover_json`` and
``privacy_scan`` imported ``chat_docs.recover_json`` — the helper had no home).

* :func:`strip_think_spans` (ollama.rs ``strip_think_spans``) drops the
  ``<think>…</think>`` reasoning spans a model leaks into its visible answer.
  Thinking-capable models do it even with the flag off, and ``:cloud`` proxies
  pass them straight through.
* :func:`recover_json` (ollama.rs ``recover_json``) drops the think spans, then
  slices from the first opening bracket to the last closing one, so a reply the
  model wrapped in a ```` ```json ```` fence or a reasoning preamble still
  parses. Models that honour Ollama's ``format`` return bare JSON, so for them
  this is a **no-op**; it exists for the ones that ignore ``format`` (notably
  Ollama *cloud* models), whose framing a strict ``json.loads`` rejects and the
  caller then reports as "nothing usable".
* :func:`prime_schema` (the outbound half of ``chat_structured``) appends the
  schema to the last user turn, because without the field names in the prompt a
  small model fills the forced JSON with empty strings.

Two edge cases both docstrings record, kept deliberately:

* an UNTERMINATED ``<think>`` **truncates everything after it** — that text is
  unclosed reasoning, not answer;
* a reply holding no bracket at all comes back trimmed but otherwise unchanged
  (``recover_json`` never raises and never returns None — callers decide what an
  unparseable reply means).
"""

from __future__ import annotations

from typing import Any

from .messages import Message, compact_json

__all__ = [
    "SCHEMA_PRIMER",
    "prime_schema",
    "recover_json",
    "strip_think_spans",
]

#: chat_structured (ollama.rs:414) appends the schema to the last user turn so a
#: small model fills the forced JSON with real content instead of empty strings —
#: Ollama's ``format`` constrains the GRAMMAR but the model never SEES the schema.
#: These features called chat_structured, so we reproduce the exact primer here.
SCHEMA_PRIMER: str = (
    "\n\nReply with ONLY JSON matching this schema, filling every field with real content:\n"
)


def strip_think_spans(raw: str) -> str:
    """Drop ``<think>…</think>`` reasoning spans (ollama.rs ``strip_think_spans``).

    An UNTERMINATED ``<think>`` truncates the rest: everything after it is
    unclosed reasoning, not answer.
    """
    out = raw
    while True:
        start = out.find("<think>")
        if start < 0:
            return out
        rel = out.find("</think>", start)
        if rel < 0:
            return out[:start]
        out = out[:start] + out[rel + len("</think>") :]


def recover_json(text: str) -> str:
    """Recover the JSON payload from a structured response (ollama.rs ``recover_json``).

    A no-op for models that honour ``format``; for the ones that wrap the JSON in
    a ```` ```json ```` fence or a ``<think>`` preamble (notably Ollama *cloud*
    models, which ignore ``format``) it drops the think span then slices from the
    first opening bracket to the last closing one. A reply with no bracket pair
    comes back trimmed but unchanged, so the caller's ``json.loads`` fails the
    same way it would have on the raw reply.
    """
    s = strip_think_spans(text.strip()).strip()
    start, end = _json_bounds(s)
    if _has_json_payload_bounds(start, end):
        return s[start : end + 1]
    return s


def _json_bounds(text: str) -> tuple[int | None, int | None]:
    return _first_json_bracket(text), _last_json_bracket(text)


def _first_json_bracket(text: str) -> int | None:
    return next((index for index, char in enumerate(text) if char in "{" "["), None)


def _last_json_bracket(text: str) -> int | None:
    return next((index for index in range(len(text) - 1, -1, -1) if text[index] in "}" "]"), None)


def _has_json_payload_bounds(start: int | None, end: int | None) -> bool:
    return start is not None and end is not None and end >= start


def prime_schema(messages: list[Message], schema: dict[str, Any]) -> list[Message]:
    """Append the schema primer to the last user turn (chat_structured, ollama.rs).

    Non-mutating: returns a fresh list so a caller's messages are untouched.
    """
    out: list[Message] = [dict(m) for m in messages]  # type: ignore[misc]
    for m in reversed(out):
        if m.get("role") == "user":
            m["content"] = (m.get("content") or "") + SCHEMA_PRIMER + compact_json(schema)
            break
    return out
