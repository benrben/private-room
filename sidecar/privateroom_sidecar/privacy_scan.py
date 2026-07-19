"""The privacy scanner — the AI that decides what is private (PRIV-2).

The counterpart of :mod:`.privacy`: that module is the mechanical door, this one
is the judgment that happens BEFORE the door. A LOCAL model reads text (a
document at import time, or the user's freshly typed chat message for the live
guard) and names the sensitive strings in it — the default sensitive categories
plus the user's own concept rules ("anything about my health"). Rust turns the
findings into stored marks and stable placeholders; the live guard turns them
into request-scoped rules.

Two invariants:

* The scanner itself NEVER runs on a non-local model — scanning private text
  with a cloud model would be the leak it exists to prevent. Enforced here, not
  left to callers.
* Findings are verified verbatim against the text before they count — a string
  the model "found" but that does not occur is a hallucination and is dropped.
  The scanner can only under-mark, never invent marks the UI can't show.
"""

from __future__ import annotations

from typing import Any

from . import llm
from .chat_docs import recover_json
from .messages import system_message, user_message
from .privacy import is_nonlocal_model

import json

#: Mark categories. ``concept`` is anything matched by a user concept rule.
CATEGORIES = (
    "person",
    "address",
    "phone",
    "email",
    "id",
    "org",
    "concept",
)

#: Chunk size for long documents. Small enough for a 4B model to actually read
#: (matches the file-pass experience: big windows get skimmed, not read), large
#: enough that a book scans in a few dozen calls. Overlap catches entities that
#: straddle a boundary.
CHUNK_CHARS = 6_000
CHUNK_OVERLAP = 400

#: Per-call output cap: a mark list is short; a runaway model must not fill the
#: context window (same rationale as the background jobs' num_predict cap).
NUM_PREDICT = 1_500

#: Hard cap on distinct findings per scan call, so a degenerate model reply
#: can't flood the entity map.
MAX_FINDINGS = 300

SCAN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "entities": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "category": {"type": "string", "enum": list(CATEGORIES)},
                },
                "required": ["text", "category"],
            },
        }
    },
    "required": ["entities"],
}


def _scan_prompt(concepts: list[str]) -> str:
    lines = [
        "You are a privacy scanner. Find every string in the user's text that",
        "identifies a private individual or their personal details:",
        "- person: full or partial names of private people (not public figures,",
        "  not fictional characters clearly presented as fiction)",
        "- address: home or street addresses, apartment numbers",
        "- phone: phone numbers",
        "- email: personal email addresses",
        "- id: government IDs, passport numbers, account or card numbers",
        "- org: a person's specific employer or small organization when it can",
        "  identify them",
    ]
    if concepts:
        lines.append(
            "- concept: any string revealing one of these user-defined private"
            " topics: " + "; ".join(concepts)
        )
    lines += [
        "Copy each found string EXACTLY as it appears in the text — same",
        "characters, same case, no paraphrase. Return every distinct occurrence",
        "spelling once. If nothing is private, return an empty list.",
        # Schema-in-prompt priming, like every structured caller here: small
        # local models (and :cloud ones) often ignore the `format` grammar, so
        # the shape must ALSO be spelled out — and the parser below still
        # tolerates the bare-array replies they produce anyway.
        'Answer ONLY with JSON of this exact shape: {"entities": [{"text":',
        '"<exact string>", "category": "<person|address|phone|email|id|org|concept>"}]}',
    ]
    return "\n".join(lines)


def _chunks(text: str) -> list[str]:
    if len(text) <= CHUNK_CHARS:
        return [text] if text.strip() else []
    out: list[str] = []
    step = CHUNK_CHARS - CHUNK_OVERLAP
    for start in range(0, len(text), step):
        piece = text[start : start + CHUNK_CHARS]
        if piece.strip():
            out.append(piece)
        if start + CHUNK_CHARS >= len(text):
            break
    return out


def _guess_category(text: str) -> str:
    """Best-effort category for a bare-string finding (no dict around it)."""
    if "@" in text and "." in text:
        return "email"
    digits = sum(c.isdigit() for c in text)
    if digits >= 6 and digits >= len(text) // 2:
        return "phone"
    return "concept"


def _parse_findings(raw: str, chunk: str) -> list[dict[str, str]]:
    """Findings from whatever JSON shape the model actually produced.

    Small local models routinely ignore the ``format`` grammar (the same quirk
    the ``:cloud`` compensation exists for), so besides the schema'd
    ``{"entities": [{text, category}]}`` this accepts a bare list of dicts and
    a bare list of strings. Every finding is still verbatim-verified against
    the chunk — the tolerance is about SHAPE, never about content.
    """
    try:
        data = json.loads(recover_json(raw))
    except (ValueError, TypeError):
        return []
    if isinstance(data, dict):
        items = data.get("entities")
    elif isinstance(data, list):
        items = data
    else:
        items = None
    if not isinstance(items, list):
        return []
    low = chunk.casefold()
    out: list[dict[str, str]] = []
    for item in items:
        if isinstance(item, dict):
            text = str(item.get("text", "")).strip()
            category = str(item.get("category", "")).strip() or "concept"
            if category not in CATEGORIES:
                category = "concept"
        elif isinstance(item, str):
            text = item.strip()
            category = _guess_category(text)
        else:
            continue
        # Verbatim check (case-insensitive): drop hallucinated strings. Length
        # floor keeps single characters / stray digits from becoming rules that
        # would shred ordinary text.
        if len(text) < 2 or text.casefold() not in low:
            continue
        out.append({"text": text, "category": category})
    return out


async def scan_text(
    text: str,
    *,
    model: str,
    base_url: str,
    concepts: list[str] | None = None,
    known: list[str] | None = None,
) -> list[dict[str, str]]:
    """All sensitive strings a local model can find in ``text``.

    ``known`` (already-mapped reals) are excluded from the result so callers
    get only NEW entities. Raises ``ValueError`` for a non-local model.
    """
    if is_nonlocal_model(model):
        raise ValueError("privacy scan must run on a local model")
    concepts = [c.strip() for c in (concepts or []) if c.strip()]
    known_keys = {k.casefold() for k in (known or [])}
    prompt = _scan_prompt(concepts)

    found: dict[str, dict[str, str]] = {}
    for chunk in _chunks(text):
        raw = await llm.generate(
            model,
            [system_message(prompt), user_message(chunk)],
            base_url,
            temperature=0.0,
            num_predict=NUM_PREDICT,
            format=SCAN_SCHEMA,
        )
        for finding in _parse_findings(raw, chunk):
            key = finding["text"].casefold()
            if key in known_keys or key in found:
                continue
            found[key] = finding
            if len(found) >= MAX_FINDINGS:
                return list(found.values())
    return list(found.values())


def mint_ephemeral_rules(
    findings: list[dict[str, str]], taken: set[str]
) -> list[tuple[str, str]]:
    """Request-scoped ``(real, placeholder)`` pairs for the live guard.

    Rust owns the room's durable entity map and its stable "[Person A]" names;
    the live guard's findings exist only for one request, so they get a
    distinct ``[Hidden N]`` series that can never collide with the stored map
    (``taken`` is the set of placeholders already in the policy).
    """
    rules: list[tuple[str, str]] = []
    n = 1
    for finding in findings:
        while f"[Hidden {n}]" in taken:
            n += 1
        placeholder = f"[Hidden {n}]"
        taken.add(placeholder)
        rules.append((finding["text"], placeholder))
        n += 1
    return rules


__all__ = [
    "CATEGORIES",
    "SCAN_SCHEMA",
    "scan_text",
    "mint_ephemeral_rules",
]
