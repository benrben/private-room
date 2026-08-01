"""Big tool results, parked whole where the model can still reach them.

:func:`budget.fit_oversized_results` cuts an oversized tool result down to fit
the model's window and marks the cut. That keeps the request legal and loses the
rest — permanently. ``seen`` memoises on ``name|arguments``, so the only route
back to the missing tail is an exact-duplicate call, and ``_ToolPass.run``
answers a duplicate with ``duplicate_call_note`` instead of running it. One
``fetch_page`` of a long document was therefore unreadable past its first few
kilobytes for the rest of the turn, with nothing to tell the model so.

So the whole text stays HERE — in this process, for the life of one run — and
the thread carries a head plus a reference to it. ``read_result`` reads the rest
on demand: continue from a position, or search it. Like ``request_tools``, that
tool is resolved inside the loop and never sent to the bridge.

Nothing is written to disk and nothing outlives the run: :class:`.graph.Deps` is
built per request (``server.py``) and owns the store, so it is freed with the
run. The text is already in this process — it leaves only the way every tool
result does, through the model seam, where ``privacy.guard_outbound`` stands.

Positions are CHARACTER offsets. The model only ever echoes back a number this
module handed it, and slicing a ``str`` cannot land inside a codepoint — which
removes the whole class of "the offset split a Hebrew letter" bugs. Sizes stay
in UTF-8 bytes, because that is what every budget in this app counts.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .budget import byte_len, truncate_bytes

#: A result longer than this is parked instead of pasted into the thread. Well
#: above ordinary tool output — a search hit list, a file excerpt, a status blob
#: — so the common case is untouched and only genuinely large reads (a web page,
#: a long transcript) ever spill.
SPILL_BYTES: int = 24_000

#: How much of a parked result one ``read_result`` hands back. Small enough that
#: a local model's window survives several reads, large enough to carry a whole
#: section of a page.
SLICE_BYTES: int = 8_000

#: Everything one run may hold. A turn that reads twenty large pages would
#: otherwise grow this process without bound; past the cap the OLDEST spill is
#: dropped, and reading a dropped ref says so rather than returning silence.
STORE_CAP_BYTES: int = 8_000_000

#: How many matches one ``find`` answers with.
FIND_HITS: int = 3

#: Characters of context around each ``find`` match.
FIND_WINDOW: int = 600


class BadArgument(ValueError):
    """A ``read_result`` argument the model has to fix; the message IS the reply."""


@dataclass(frozen=True, slots=True)
class Spill:
    """One parked tool result."""

    ref: str
    tool: str
    text: str

    @property
    def size(self) -> int:
        """UTF-8 bytes — the unit every budget in this app counts in."""
        return byte_len(self.text)

    def head(self, limit: int = SLICE_BYTES) -> str:
        """The opening ``limit`` bytes, cut on a codepoint boundary.

        One read's worth by default, NOT :data:`SPILL_BYTES`: parking a 30 KB
        page and then pasting 24 KB of it back into the thread would leave the
        local model exactly where it started. It also makes "keep reading" a
        uniform step — the head is the same size as every page after it.
        """
        return truncate_bytes(self.text, limit)


class ResultStore:
    """The tool results one run has parked, oldest first."""

    def __init__(self) -> None:
        self._spills: dict[str, Spill] = {}
        self._minted = 0

    def __len__(self) -> int:
        return len(self._spills)

    @property
    def size(self) -> int:
        return sum(spill.size for spill in self._spills.values())

    def put(self, tool: str, text: str) -> Spill:
        """Park ``text`` under a fresh ref, dropping the oldest spills once this
        run holds more than :data:`STORE_CAP_BYTES`.

        The newest spill is never dropped, however big it is: a single oversized
        result parking and instantly vanishing is the exact failure this module
        exists to remove.
        """
        self._minted += 1
        spill = Spill(ref=f"res_{self._minted}", tool=tool, text=text)
        self._spills[spill.ref] = spill
        while self.size > STORE_CAP_BYTES and len(self._spills) > 1:
            self._spills.pop(next(iter(self._spills)))
        return spill

    def get(self, ref: str) -> Spill | None:
        return self._spills.get(ref)


def read_spill(
    store: ResultStore, refs: Sequence[str], arguments: Mapping[str, Any]
) -> tuple[str, bool]:
    """Answer one ``read_result`` call: the text for the model, and whether it
    was a usable request.

    ``refs`` is what THIS loop parked. The store is shared by the whole
    delegation tree (it hangs off ``Deps``), so scoping the read to the caller's
    own refs is what stops one specialist from reading text another one fetched
    and never showed it.
    """
    try:
        spill, offset, find = _resolve(store, refs, arguments)
    except BadArgument as exc:
        return str(exc), False
    return (_search(spill, find, offset) if find else _window(spill, offset)), True


def _resolve(
    store: ResultStore, refs: Sequence[str], arguments: Mapping[str, Any]
) -> tuple[Spill, int, str]:
    """The spill, position and search term one ``read_result`` call names."""
    ref = str(arguments.get("ref") or "").strip()
    if ref not in set(refs):
        raise BadArgument(
            f"No shortened result named '{ref}'. "
            + (
                f"Available here: {', '.join(refs)}."
                if refs
                else "Nothing has been shortened in this conversation."
            )
        )
    spill = store.get(ref)
    if spill is None:
        raise BadArgument(
            f"{ref} is no longer held — this run has read too much since. "
            "Run the tool again for a fresh copy."
        )
    offset = _offset(arguments.get("offset"), len(spill.text))
    return spill, offset, str(arguments.get("find") or "").strip()


def _offset(raw: Any, size: int) -> int:
    """``offset`` as a position inside a text of ``size`` characters.

    Parsed leniently because a 4B sends ``"4096"`` as readily as ``4096``, then
    range-checked strictly: a position outside the text is a mistake worth
    telling the model about, not one to quietly clamp.
    """
    if raw is None or raw == "":
        return 0
    try:
        value = int(float(str(raw).strip()))
    except (ValueError, OverflowError):
        raise BadArgument(
            f"offset must be a number between 0 and {size}; got {raw!r}."
        ) from None
    if not 0 <= value <= size:
        raise BadArgument(f"offset must be between 0 and {size}; got {value}.")
    return value


def _window(spill: Spill, offset: int) -> str:
    """The next slice of ``spill`` from ``offset``."""
    chunk = truncate_bytes(spill.text[offset:], SLICE_BYTES)
    if not chunk:
        return (
            f"{spill.ref} ends at position {len(spill.text)}; "
            f"there is nothing after {offset}."
        )
    end = offset + len(chunk)
    left = len(spill.text) - end
    tail = (
        f"[{spill.ref}: continue with offset={end} — {left} characters left.]"
        if left
        else f"[{spill.ref}: that was the end.]"
    )
    return f"[{spill.ref}, from position {offset} of {len(spill.text)}]\n{chunk}\n{tail}"


def _search(spill: Spill, find: str, offset: int) -> str:
    """Up to :data:`FIND_HITS` windows around ``find``, each with its position."""
    hits = _hits(spill.text, find, offset)
    if not hits:
        return (
            f"'{find}' does not appear in {spill.ref} after position {offset} "
            f"(it holds {len(spill.text)} characters). Try another word, or read "
            f"it with offset={offset}."
        )
    windows = [
        f"[{spill.ref}, around position {at}]\n{_around(spill.text, at, len(find))}"
        for at in hits
    ]
    body = truncate_bytes("\n\n".join(windows), SLICE_BYTES)
    return f"{body}\n[{spill.ref}: {len(hits)} match(es) shown for '{find}'.]"


def _hits(text: str, find: str, offset: int) -> list[int]:
    """Where ``find`` appears at or after ``offset``, case-insensitively."""
    hay, needle = text.lower(), find.lower()
    found: list[int] = []
    at = offset
    while len(found) < FIND_HITS:
        at = hay.find(needle, at)
        if at < 0:
            break
        found.append(at)
        at += len(needle)
    return found


def _around(text: str, at: int, width: int) -> str:
    """``width`` characters at ``at``, with :data:`FIND_WINDOW` of context."""
    pad = FIND_WINDOW // 2
    return text[max(0, at - pad) : at + width + pad]


__all__ = [
    "BadArgument",
    "FIND_HITS",
    "FIND_WINDOW",
    "ResultStore",
    "SLICE_BYTES",
    "SPILL_BYTES",
    "STORE_CAP_BYTES",
    "Spill",
    "read_spill",
]
