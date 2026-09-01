"""User-authored clause splitting for deterministic specialist plans."""

import re

_SPLIT_RE = re.compile(
    r"("
    r"\n+"
    r"|;"
    r"|,?\s+and\s+then\s+"
    r"|,?\s+then\s+"
    r"|,?\s+after\s+that,?\s+"
    r"|,?\s+afterwards,?\s+"
    r"|,?\s+and\s+also\s+"
    r"|,?\s+also,?\s+"
    r"|\s+ואז\s+"
    r"|\s+אחר\s+כך\s+"
    r"|\s+לאחר\s+מכן\s+"
    r"|\s+וגם\s+"
    r")",
    re.IGNORECASE,
)
_SEQ_RE = re.compile(
    r"then|after\s+that|afterwards|ואז|אחר\s+כך|לאחר\s+מכן", re.IGNORECASE
)


def _clauses(question: str) -> list[tuple[str, bool]]:
    parts = _SPLIT_RE.split(question.strip())
    clauses = _split_clauses(parts)
    return clauses or [(question.strip(), False)]


def _split_clauses(parts: list[str]) -> list[tuple[str, bool]]:
    out: list[tuple[str, bool]] = []
    _append_clause(out, parts[0], needs_previous=False)
    for delimiter, text in zip(parts[1::2], parts[2::2]):
        _append_clause(
            out,
            text,
            needs_previous=bool(_SEQ_RE.search(delimiter)) and bool(out),
        )
    return out


def _append_clause(
    clauses: list[tuple[str, bool]], part: str, *, needs_previous: bool
) -> None:
    text = part.strip().strip(",.;:- \t")
    if text:
        clauses.append((text, needs_previous))
