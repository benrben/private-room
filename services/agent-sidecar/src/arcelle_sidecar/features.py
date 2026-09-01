"""Phase-2 feature logic: front-page starter questions + feedback drafting.

The sidecar is the app's SOLE AI service (MIGRATION): the PROMPT, the schema, the
temperature/keep_alive, the model call and the output parsing all live here. Rust
gathers the data from the encrypted DB (room name + file names, or the raw
feedback words) and posts it; it stores/returns what these functions produce.

Two features land here, ported verbatim from Rust:

* :func:`front_page_labels` — front_page.rs ``front_page_suggestions`` (D4): up to
  three short starter questions grounded in the room name + file list. The Rust
  path swallows any model failure (``chat_structured(...).unwrap_or_default()``)
  and reuses its cached list, so this returns an empty list rather than raising —
  the route mirrors that (see server.py).

* :func:`feedback_draft` — feedback.rs ``feedback_draft`` (ADD-28): shape the
  user's raw feedback into a GitHub issue ``{title, body}``. Unlike the front
  page, the Rust path propagates an engine failure (``chat_structured(...)?``), so
  a model error raises :class:`.llm.LlmError` here and the route surfaces it; a
  model that returns UNPARSEABLE output falls back to the plain first-line title +
  "## What happened" body, so the user's words survive any misfire.

There is deliberately NO room-graph AI labeling: graph.rs ``build_room_graph`` is
model-free (embedding/keyword overlap only), so ``/label`` serves the front page.
"""

from __future__ import annotations

import json
from typing import Any

from . import llm
from .config import KEEP_ALIVE_SHORT, KEEP_ALIVE_WARM
from .messages import system_message, user_message
from .model_text import recover_json

# --- front page: starter questions (front_page.rs) --------------------------

_SUGGESTIONS_SYSTEM = (
    "You suggest example questions a user could ask about their own documents. Give up to "
    "three short, specific questions these files would actually answer."
)

_SUGGESTIONS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"questions": {"type": "array", "items": {"type": "string"}}},
    "required": ["questions"],
}


def _parse_questions(raw: str) -> list[str]:
    """Extract up to three non-blank questions from the model's raw JSON.

    front_page.rs: collect every string in ``questions``, drop the blank ones
    (empty after trim), keep the first three. The kept strings are returned
    verbatim (the Rust filter does not trim the survivors).

    Run through :func:`.model_text.recover_json` first, like every other
    structured caller (chat_docs, ai_actions, external_llm). This was a bare
    ``json.loads`` on the raw reply, which is fine for a model that honours
    ``format`` and wrong for the ones that do not — an Ollama ``:cloud`` model
    fence-wraps its JSON or prefixes a ``<think>`` span, the strict parse
    rejected it, and the front page silently showed no starter questions at
    all."""
    return _question_strings(_json_object(raw))[:3]


def _json_object(raw: str) -> dict[str, Any] | None:
    try:
        data = json.loads(recover_json(raw))
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def _question_strings(data: dict[str, Any] | None) -> list[str]:
    if data is None:
        return []
    questions = data.get("questions")
    if not isinstance(questions, list):
        return []
    return [question for question in questions if isinstance(question, str) and question.strip()]


async def front_page_labels(
    model: str,
    room_name: str,
    files: list[str],
    base_url: str,
    privacy: dict[str, Any] | None = None,
    provider: Any | None = None,
) -> list[str]:
    """Up to three starter questions for the room's front page (D4).

    Raises :class:`.llm.LlmError` on an engine failure; the route swallows it to
    an empty list so the Rust caller falls back to its cached suggestions — the
    exact ``unwrap_or_default()`` behaviour of front_page.rs."""
    listing = "\n".join(files)
    messages = [
        system_message(_SUGGESTIONS_SYSTEM),
        user_message(f"Room name: {room_name}\n\nFiles:\n{listing}"),
    ]
    raw = await llm.generate(
        model,
        messages,
        base_url,
        temperature=0.4,
        keep_alive=KEEP_ALIVE_WARM,
        format=_SUGGESTIONS_SCHEMA,
        privacy=privacy,
        provider=provider,
    )
    return _parse_questions(raw)


# --- feedback: GitHub issue draft (feedback.rs) -----------------------------

_FEEDBACK_SYSTEM = (
    "You turn a user's raw feedback about the Arcelle desktop app into a clear "
    "GitHub issue. Title: one short, specific English summary line (under 70 "
    "characters, no trailing period). Body: GitHub Markdown with '## What happened' "
    "and, only when the feedback implies them, '## Expected' and '## Steps to "
    "reproduce'. Preserve the user's meaning exactly — never invent details. If the "
    "feedback is not in English, keep the original text quoted in the body and add "
    "an English summary above it."
)

_FEEDBACK_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"title": {"type": "string"}, "body": {"type": "string"}},
    "required": ["title", "body"],
}


def _parse_or_fallback(raw: str, text: str) -> tuple[str, str]:
    """Parse ``{title, body}`` or fall back so the user's words always survive.

    feedback.rs: require both a non-blank title and a non-blank body (trimmed);
    otherwise title = the first line of the raw feedback (max 70 chars, or
    "Feedback" if there is none) and body = "## What happened\\n\\n{text}".

    :func:`.model_text.recover_json` first, for the same reason
    :func:`_parse_questions` needs it: a fence-wrapped reply from a cloud model
    fell straight through to the fallback, so the feedback form quietly used
    the user's first line as the issue title and never told anyone."""
    parsed = _feedback_fields(_json_object(raw))
    return parsed if parsed is not None else _feedback_fallback(text)


def _feedback_fields(data: dict[str, Any] | None) -> tuple[str, str] | None:
    if data is None:
        return None
    title = data.get("title")
    body = data.get("body")
    if not isinstance(title, str) or not isinstance(body, str):
        return None
    title, body = title.strip(), body.strip()
    return (title, body) if title and body else None


def _feedback_fallback(text: str) -> tuple[str, str]:
    """Keep the user's words when the structured model reply is unusable."""
    first_line = text.split("\n", 1)[0].rstrip("\r")
    return (first_line or "Feedback")[:70], f"## What happened\n\n{text}"


async def feedback_draft(
    model: str,
    text: str,
    base_url: str,
    privacy: dict[str, Any] | None = None,
    provider: Any | None = None,
) -> dict[str, str]:
    """Shape raw feedback into a GitHub-ready ``{title, body}`` (ADD-28).

    Raises :class:`.llm.LlmError` on an engine failure (the route surfaces it,
    mirroring feedback.rs' ``?``). A parseable-but-empty or unparseable model
    reply degrades to the plain fallback. The final title is capped at 120 chars,
    matching the Rust ``.chars().take(120)`` (both count Unicode scalar values)."""
    messages = [system_message(_FEEDBACK_SYSTEM), user_message(text)]
    raw = await llm.generate(
        model,
        messages,
        base_url,
        temperature=0.3,
        keep_alive=KEEP_ALIVE_SHORT,
        format=_FEEDBACK_SCHEMA,
        privacy=privacy,
        provider=provider,
    )
    title, body = _parse_or_fallback(raw, text)
    return {"title": title[:120], "body": body}


__all__ = ["front_page_labels", "feedback_draft"]
