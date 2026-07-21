"""The privacy gatekeeper — the mechanical door (PRIV-1).

Room content may only reach a NON-LOCAL model (an Ollama ``:cloud`` model or a
cloud CLI engine) after passing through this module. The design principle: the
moment of sending is enforced by a simple rule, never by live AI judgment.
An AI (the import-time scanner, :mod:`.privacy_scan`) decides ahead of time
*what* is private; this module mechanically replaces those exact strings with
stable placeholders on the way out and restores them in the answer on the way
back — so the cloud model can still reason about "[Person A]" coherently while
the real name never leaves the Mac.

Enforcement lives at the model seam (:class:`.chat.OllamaChatModel` and
:mod:`.external_llm`), the last point every outbound token passes regardless of
which feature composed it. Rust resolves the per-room policy (switch state +
entity map) and sends it on each request; a LOCAL model call is always a no-op
here even when a policy rides the request.

Everything in this module is pure string mechanics — no model calls, no I/O —
so the guarantee is unit-testable and cannot "have a bad day".
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .external_llm import is_external_model
from .messages import Message

#: Ollama's remote-relay tag (mirror external.rs ``is_cloud_model``).
_CLOUD_SUFFIX = ("cloud",)


def is_cloud_model(model: str) -> bool:
    """True for an Ollama model whose tag relays to ollama.com (``name:cloud``)."""
    return model.rsplit(":", 1)[-1] in _CLOUD_SUFFIX and ":" in model


def is_nonlocal_model(model: str) -> bool:
    """True when this model string means content leaves the Mac.

    Two ways out exist: the Ollama daemon relaying a ``:cloud`` model, and the
    cloud coding CLIs (claude-cli / codex-cli). Everything else is loopback.
    """
    return (
        is_cloud_model(model)
        or is_external_model(model)
        or model.split(":" * 2, 1)[0] == "openrouter"
    )


@dataclass(slots=True)
class PrivacyReport:
    """What the door actually did on one request — feeds the UI indicator."""

    #: Distinct protected entities that occurred (and were hidden) in outbound text.
    entities_hidden: int = 0
    #: Total individual replacements across all outbound text.
    replacements: int = 0
    #: Images stripped from outbound messages (pixels can't be redacted).
    images_blocked: int = 0

    def as_payload(self) -> dict[str, int]:
        return {
            "entities_hidden": self.entities_hidden,
            "replacements": self.replacements,
            "images_blocked": self.images_blocked,
        }


@dataclass
class PrivacyPolicy:
    """The resolved per-request policy Rust sends (already switch-resolved).

    ``rules`` is the room's entity map: ``(real, placeholder)`` pairs from the
    user's exact block list plus every entity the import-time scanner found in
    the room's documents. Matching is case-insensitive and longest-first so
    "Ben Reich-Cohen" wins over "Ben Reich"; replacement is single-pass via one
    alternation regex, so a minted placeholder can never itself be re-matched.
    """

    active: bool = False
    rules: list[tuple[str, str]] = field(default_factory=list)
    #: User-defined concept rules ("my health") — consumed by the live guard
    #: (:mod:`.privacy_scan`), carried here so routes have one policy object.
    concepts: list[str] = field(default_factory=list)
    report: PrivacyReport = field(default_factory=PrivacyReport)

    _redact_re: re.Pattern[str] | None = None
    _restore_re: re.Pattern[str] | None = None
    _by_real: dict[str, str] = field(default_factory=dict)
    _by_placeholder: dict[str, str] = field(default_factory=dict)
    _counted_entities: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        self._compile()

    def _compile(self) -> None:
        pairs = [(r.strip(), p.strip()) for r, p in self.rules if r.strip() and p.strip()]
        self.rules = sorted(pairs, key=lambda rp: len(rp[0]), reverse=True)
        self._by_real = {r.casefold(): p for r, p in self.rules}
        self._by_placeholder = {p.casefold(): r for r, p in self.rules}
        if self.rules:
            self._redact_re = re.compile(
                "|".join(re.escape(r) for r, _ in self.rules), re.IGNORECASE
            )
            restore = sorted((p for _, p in self.rules), key=len, reverse=True)
            self._restore_re = re.compile(
                "|".join(re.escape(p) for p in restore), re.IGNORECASE
            )
        else:
            self._redact_re = None
            self._restore_re = None

    def add_rules(self, extra: list[tuple[str, str]]) -> None:
        """Append request-scoped rules (the live guard's findings) and recompile."""
        if not extra:
            return
        known = {r.casefold() for r, _ in self.rules}
        self.rules = self.rules + [
            (r, p) for r, p in extra if r.strip() and r.casefold() not in known
        ]
        self._compile()

    # -- outbound ---------------------------------------------------------

    def redact_text(self, text: str) -> str:
        """Replace every protected entity with its placeholder (counted)."""
        if not text or self._redact_re is None:
            return text
        seen: set[str] = set()

        def _sub(m: re.Match[str]) -> str:
            key = m.group(0).casefold()
            placeholder = self._by_real.get(key)
            if placeholder is None:
                # Case-insensitive hit on a differently-cased rule: find it.
                for real, ph in self.rules:
                    if real.casefold() == key:
                        placeholder = ph
                        break
            if placeholder is None:  # pragma: no cover - alternation only matches rules
                return m.group(0)
            self.report.replacements += 1
            seen.add(key)
            return placeholder

        out = self._redact_re.sub(_sub, text)
        self._counted_entities |= seen
        self.report.entities_hidden = len(self._counted_entities)
        return out

    def redact_value(self, value: Any) -> Any:
        """Redact strings anywhere in a JSON-shaped value (tool-call arguments —
        an earlier round's restored args must not carry real values back out)."""
        if isinstance(value, str):
            return self.redact_text(value)
        if isinstance(value, list):
            return [self.redact_value(v) for v in value]
        if isinstance(value, dict):
            return {k: self.redact_value(v) for k, v in value.items()}
        return value

    def redact_messages(self, messages: list[Message]) -> list[Message]:
        """The outbound half of the door: copy of ``messages`` with every text
        field redacted, tool-call arguments included, and every image stripped.
        Non-mutating."""
        out: list[Message] = []
        for m in messages:
            mm: dict[str, Any] = dict(m)
            content = mm.get("content")
            if content:
                mm["content"] = self.redact_text(content)
            if mm.get("tool_calls"):
                mm["tool_calls"] = self.redact_value(mm["tool_calls"])
            if mm.get("images"):
                self.report.images_blocked += len(mm["images"])
                mm.pop("images", None)
            out.append(mm)  # type: ignore[arg-type]
        return out

    def block_images(self, images: list[str] | None) -> None:
        """Count top-level images the seam refused to attach (vision param)."""
        if images:
            self.report.images_blocked += len(images)

    # -- inbound ----------------------------------------------------------

    def restore_text(self, text: str) -> str:
        """Put the real values back into an answer (placeholder → real)."""
        if not text or self._restore_re is None:
            return text

        def _sub(m: re.Match[str]) -> str:
            real = self._by_placeholder.get(m.group(0).casefold())
            return real if real is not None else m.group(0)

        return self._restore_re.sub(_sub, text)

    def restore_value(self, value: Any) -> Any:
        """Restore placeholders anywhere in a JSON-shaped value (tool-call args:
        a cloud model asks to search for "[Person A]", the local tool must see
        the real name to find anything)."""
        if isinstance(value, str):
            return self.restore_text(value)
        if isinstance(value, list):
            return [self.restore_value(v) for v in value]
        if isinstance(value, dict):
            return {k: self.restore_value(v) for k, v in value.items()}
        return value

    def restorer(self) -> "StreamRestorer":
        return StreamRestorer(self)


class StreamRestorer:
    """Stream-safe placeholder restore.

    A placeholder like ``[Person A]`` can arrive split across token deltas
    (``"…met [Per"`` / ``"son A] today"``). Feed each delta in; text is released
    only once it can no longer be the beginning of any placeholder — the tail
    from the last unclosed ``[`` is held back (bounded by the longest
    placeholder, so a stray lone ``[`` can't buffer forever). ``flush()``
    releases whatever remains at end of stream.
    """

    def __init__(self, policy: PrivacyPolicy) -> None:
        self._policy = policy
        self._buf = ""
        self._max_len = max((len(p) for _, p in policy.rules), default=0)

    def feed(self, delta: str) -> str:
        if self._max_len == 0:
            return delta
        self._buf += delta
        cut = len(self._buf)
        start = self._buf.rfind("[")
        if start != -1 and "]" not in self._buf[start:]:
            if len(self._buf) - start <= self._max_len:
                cut = start
        ready, self._buf = self._buf[:cut], self._buf[cut:]
        return self._policy.restore_text(ready)

    def flush(self) -> str:
        ready, self._buf = self._buf, ""
        return self._policy.restore_text(ready)


def policy_from_payload(payload: dict[str, Any] | None) -> PrivacyPolicy | None:
    """The wire shape Rust sends: ``{active, rules: [{real, placeholder}], concepts}``.

    ``None``/missing means "no policy" (privacy off for this room, or a caller
    that predates the feature) — the seam then behaves exactly as before.
    """
    if not payload:
        return None
    rules = [
        (str(r.get("real", "")), str(r.get("placeholder", "")))
        for r in payload.get("rules", [])
        if isinstance(r, dict)
    ]
    return PrivacyPolicy(
        active=bool(payload.get("active", False)),
        rules=rules,
        concepts=[str(c) for c in payload.get("concepts", []) if str(c).strip()],
    )


def guard_outbound(
    model: str,
    messages: list[Message],
    policy: PrivacyPolicy | None,
    images: list[str] | None = None,
) -> tuple[list[Message], list[str] | None, PrivacyPolicy | None]:
    """The one call every outbound path makes.

    Returns ``(messages, images, engaged_policy)`` — untouched originals and
    ``None`` when the door stays open (local model, or policy off/absent), the
    redacted copy and ``images=None`` when it engages.
    """
    if policy is None or not policy.active or not is_nonlocal_model(model):
        return messages, images, None
    redacted = policy.redact_messages(messages)
    policy.block_images(images)
    return redacted, None, policy


__all__ = [
    "PrivacyPolicy",
    "PrivacyReport",
    "StreamRestorer",
    "is_cloud_model",
    "is_nonlocal_model",
    "policy_from_payload",
    "guard_outbound",
]
