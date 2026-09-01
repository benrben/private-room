"""Pure character-sheet windowing and merge rules for :mod:`chat_docs`."""

from __future__ import annotations

from typing import Any

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

CAST_WINDOW_CHARS = 12_000
CAST_WINDOW_OVERLAP = 1_200
CAST_MAX = 40


def cast_windows(document: str) -> list[str]:
    """Cut a document into overlapping windows at paragraph boundaries."""
    text = document.strip()
    short_windows = _short_cast_windows(text)
    if short_windows is not None:
        return short_windows
    return _long_cast_windows(text)


def _short_cast_windows(text: str) -> list[str] | None:
    if len(text) > CAST_WINDOW_CHARS:
        return None
    return [text] if text else []


def _long_cast_windows(text: str) -> list[str]:
    windows: list[str] = []
    start = 0
    while start < len(text):
        end = _cast_window_end(text, start)
        windows.append(text[start:end].strip())
        if end >= len(text):
            break
        start = _next_cast_window_start(end, start)
    return [window for window in windows if window]


def _cast_window_end(text: str, start: int) -> int:
    end = min(start + CAST_WINDOW_CHARS, len(text))
    if end >= len(text):
        return end
    return _paragraph_cast_window_end(text, start, end)


def _paragraph_cast_window_end(text: str, start: int, end: int) -> int:
    floor = end - CAST_WINDOW_CHARS // 5
    boundary = text.rfind("\n\n", max(start, floor), end)
    return boundary if boundary > start else end


def _next_cast_window_start(end: int, start: int) -> int:
    return max(end - CAST_WINDOW_OVERLAP, start + 1)


def _cast_text(person: dict[str, str], field: str) -> str:
    return (person.get(field) or "").strip()


def _merged_cast_detail(existing: str, addition: str) -> str:
    if not addition:
        return existing
    if not existing:
        return addition
    if addition.casefold() in existing.casefold():
        return existing
    return f"{existing} {addition}".strip()


def _update_cast_details(
    entry: dict[str, str], description: str, story: str
) -> None:
    entry["description"] = _merged_cast_detail(entry["description"], description)
    entry["story"] = _merged_cast_detail(entry["story"], story)


def merge_cast(found: list[dict[str, str]]) -> list[dict[str, str]]:
    """Merge repeated people case-insensitively without erasing prior detail."""
    merged: list[dict[str, str]] = []
    seen: dict[str, int] = {}
    for person in found:
        name = _cast_text(person, "name")
        if not name:
            continue
        key = name.casefold()
        description = _cast_text(person, "description")
        story = _cast_text(person, "story")
        if key in seen:
            _update_cast_details(merged[seen[key]], description, story)
            continue
        if len(merged) >= CAST_MAX:
            continue
        seen[key] = len(merged)
        merged.append({"name": name, "description": description, "story": story})
    return merged
