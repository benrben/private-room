"""Small serde_json-parity readers used by workflow nodes."""

import json
from typing import Any

from .model_text import recover_json


def _bool_or(parsed: Any, key: str, default: bool) -> bool:
    if isinstance(parsed, dict):
        value = parsed.get(key)
        if isinstance(value, bool):
            return value
    return default


def _str_or_empty(parsed: Any, key: str) -> str:
    if isinstance(parsed, dict):
        value = parsed.get(key)
        if isinstance(value, str):
            return value
    return ""


def _parse_or(raw: str, fallback: Any) -> Any:
    try:
        return json.loads(recover_json(raw))
    except (ValueError, TypeError):
        return fallback


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))
