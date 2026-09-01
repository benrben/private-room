"""Generic adaptive UI-text generation and validation."""

from __future__ import annotations

import json
import logging
import math
import re
from typing import Any

from . import llm
from .config import KEEP_ALIVE_SHORT
from .messages import compact_json, user_message
from .model_text import prime_schema, recover_json

_log = logging.getLogger(__name__)

_UI_TEXT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"text": {"type": "string"}},
    "required": ["text"],
}
_DIGIT_INSTRUCTION = (
    '\n\nWrite every number as a digit (e.g. "3", not "three") — never spell numbers out.'
)
_NUMBER_RE = re.compile(r"\d+")
_NUMBER_WORDS: frozenset[str] = frozenset(
    """one two three four five six seven eight nine ten
    eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen
    twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million
    first second third fourth fifth sixth seventh eighth ninth tenth
    eleventh twelfth""".split()
)
_NUMBER_WORD_RE = re.compile(r"\b(" + "|".join(sorted(_NUMBER_WORDS)) + r")\b", re.IGNORECASE)
_WORD_COUNT_SLACK = 1.3
_MIN_UI_TEXT_PREDICT = 24


def _load_obj(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(recover_json(raw))
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _str_field(obj: dict[str, Any], key: str) -> str:
    value = obj.get(key)
    return value.strip() if isinstance(value, str) else ""


def _word_count(text: str) -> int:
    return len(text.split())


async def generate_ui_text(
    kind: str,
    prompt: str,
    facts: Any,
    max_words: int,
    model: str,
    base_url: str,
    privacy: dict[str, Any] | None = None,
    provider: Any | None = None,
) -> str | None:
    """Generate one short UI string, returning ``None`` for an unsafe reply."""
    raw = await _generate_ui_reply(
        kind, prompt, max_words, model, base_url, privacy=privacy, provider=provider
    )
    if raw is None:
        return None
    return _validated_ui_text(kind, raw, facts, max_words)


async def _generate_ui_reply(
    kind: str,
    prompt: str,
    max_words: int,
    model: str,
    base_url: str,
    *,
    privacy: dict[str, Any] | None,
    provider: Any | None,
) -> str | None:
    messages = prime_schema([user_message(prompt + _DIGIT_INSTRUCTION)], _UI_TEXT_SCHEMA)
    try:
        return await llm.generate(
            model,
            messages,
            base_url,
            temperature=0.3,
            num_predict=max(max_words * 2, _MIN_UI_TEXT_PREDICT),
            keep_alive=KEEP_ALIVE_SHORT,
            format=_UI_TEXT_SCHEMA,
            privacy=privacy,
            provider=provider,
        )
    except llm.LlmError as exc:
        _log.debug("generate_ui_text[%s]: engine failure, degrading to null: %s", kind, exc)
        return None
    except Exception:
        _log.exception("generate_ui_text[%s]: unexpected failure, degrading to null", kind)
        return None


def _validated_ui_text(kind: str, raw: str, facts: Any, max_words: int) -> str | None:
    text = _str_field(_load_obj(raw), "text")
    if not text:
        _log.debug("generate_ui_text[%s]: empty or invalid reply, degrading to null", kind)
        return None
    if _ui_text_exceeds_word_limit(text, max_words):
        _log.debug(
            "generate_ui_text[%s]: %d words over the %d-word cap, degrading to null",
            kind,
            _word_count(text),
            math.ceil(max_words * _WORD_COUNT_SLACK),
        )
        return None
    facts_text = compact_json(facts)
    fabricated_digits = _fabricated_digits(text, facts_text)
    if fabricated_digits:
        _log.debug(
            "generate_ui_text[%s]: fabricated number(s) %s, degrading to null",
            kind,
            sorted(fabricated_digits),
        )
        return None
    fabricated_words = _fabricated_number_words(text, facts_text)
    if fabricated_words:
        _log.debug(
            "generate_ui_text[%s]: fabricated number word(s) %s, degrading to null",
            kind,
            sorted(fabricated_words),
        )
        return None
    return text


def _ui_text_exceeds_word_limit(text: str, max_words: int) -> bool:
    return _word_count(text) > math.ceil(max_words * _WORD_COUNT_SLACK)


def _fabricated_digits(text: str, facts_text: str) -> set[str]:
    return set(_NUMBER_RE.findall(text)) - set(_NUMBER_RE.findall(facts_text))


def _fabricated_number_words(text: str, facts_text: str) -> set[str]:
    text_words = {word.lower() for word in _NUMBER_WORD_RE.findall(text)}
    facts_words = {word.lower() for word in _NUMBER_WORD_RE.findall(facts_text)}
    return text_words - facts_words
