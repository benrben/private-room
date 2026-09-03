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

#: Ollama's remote-relay tag (mirror ``capabilities.rs::engine_id_of``).
_CLOUD_SUFFIX = ("cloud",)

# A last-resort output canary net.  Exact room rules remain the authority, but
# an import-time scanner can miss a synthetic credential (ARC-002 did).  These
# deliberately narrow forms cover values explicitly labelled as a secret,
# token, API key or canary and the common SECRET_TOKEN_xxx spelling; ordinary
# prose containing the word "token" is not touched.
_OUTPUT_SECRET_RE = re.compile(
    r"(?ix)"
    r"(?:\b(?:secret|canary|token|api[ _-]?key)"
    r"(?:[ _-]+(?:secret|canary|token|value|key))?\s*[:=]\s*"
    r"(?:[\"']?)[A-Za-z0-9][A-Za-z0-9._~+/=-]{7,256}(?:[\"']?))"
    r"|(?:\b(?:[A-Za-z0-9]{1,32}[_-])?(?:secret|canary|token)"
    r"(?:[_-](?:secret|canary|token))*"
    r"[_-][A-Za-z0-9][A-Za-z0-9_-]{7,255}\b)"
)
_OUTPUT_SECRET_PLACEHOLDER = "[Protected secret]"
# The labelled branch above is bounded to 256 value characters.  Keep enough
# tail to cover it plus its label while streaming, so no prefix can be emitted
# before the regex has seen the whole candidate.
_OUTPUT_SECRET_MAX = 320

# Defense in depth for Cloud Privacy.  The host normally supplies an effective
# bridge catalog, but the model runtime must not regain a mutating verb merely
# because an older/alternate bridge listed it.  Read/inspect verbs are absent
# from this set; mixed read/write proxy verbs (run_mcp_tool) fail closed because
# their remote side effect cannot be inferred from a schema name.
CLOUD_PRIVACY_BLOCKED_TOOLS: frozenset[str] = frozenset(
    {
        "create_file", "edit_file", "edit_files", "write_file", "set_cells",
        "rename_file", "move_file", "add_memory", "update_memory", "delete_memory",
        "annotate_file", "mark_image", "organize_files", "trash_files",
        "set_in_library", "merge_files", "run_script", "save_link",
        "download_url", "download_media", "browse_do", "browse_save", "ui_act",
        "start_file_pass", "save_workflow", "update_workflow", "delete_workflow",
        # test_workflow is called "validation", but it really executes every
        # workflow node (including connector/script side effects) immediately.
        "run_workflow", "test_workflow", "save_skill", "write_skill_resource",
        "delete_skill_resource", "delete_skill", "run_skill_script", "save_mcp",
        # read_recording starts a job that WRITES chapters/highlights/notes back
        # onto the recording; stt_status remains available for safe inspection.
        # view_media_frame itself is read-only, but Cloud Privacy strips its
        # pixels at the model boundary. Advertising it would leave only a text
        # receipt and invite fabricated visual interpretation, so hand Video to
        # a local engine instead.
        "delete_mcp", "run_mcp_tool", "retranscribe_file", "read_recording",
        "view_media_frame", "view_screenshot", "view_file_image",
        "read_drawing", "browse_look",
        "studio_flashcards", "studio_mindmap", "generate_podcast_script", "draw",
        "update_skin_draft", "undo_skin_change", "save_skin",
    }
)


def cloud_privacy_tool_allowed(name: str) -> bool:
    """Whether a tool is inspect-only under the Cloud Privacy boundary."""
    return name not in CLOUD_PRIVACY_BLOCKED_TOOLS


def is_cloud_model(model: str) -> bool:
    """True for an Ollama model whose tag relays to ollama.com.

    Ollama writes the marker BOTH ways — ``minimax-m3:cloud`` and, for its
    sized entries, inside the tag as ``gpt-oss:120b-cloud``. An exact ``:cloud``
    test sees only the first and calls the second local, and the cost of that
    error is the user's content leaving the Mac under a promise that it would
    not. ``engine_id_of`` on the Rust side accepts both; so does this.
    """
    if ":" not in model:
        return False
    tag = model.rsplit(":", 1)[-1]
    return tag in _CLOUD_SUFFIX or tag.endswith("-cloud")


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


def _normalized_privacy_rules(rules: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Trim usable rules and put longer real values before their prefixes."""
    pairs = [
        (real.strip(), placeholder.strip())
        for real, placeholder in rules
        if real.strip() and placeholder.strip()
    ]
    return sorted(pairs, key=lambda pair: len(pair[0]), reverse=True)


def _real_to_placeholder(rules: list[tuple[str, str]]) -> dict[str, str]:
    """Index compiled rules by their case-insensitive real value."""
    return {real.casefold(): placeholder for real, placeholder in rules}


def _placeholder_to_real(rules: list[tuple[str, str]]) -> dict[str, str]:
    """Index compiled rules by their case-insensitive placeholder."""
    return {placeholder.casefold(): real for real, placeholder in rules}


def _privacy_patterns(
    rules: list[tuple[str, str]],
) -> tuple[re.Pattern[str] | None, re.Pattern[str] | None]:
    """Compile the outbound and inbound literal alternations for a rule set."""
    if not rules:
        return None, None
    redact = _privacy_literal_pattern([real for real, _ in rules])
    restore = _privacy_literal_pattern(
        sorted([placeholder for _, placeholder in rules], key=len, reverse=True)
    )
    return redact, restore


def _privacy_literal_pattern(values: list[str]) -> re.Pattern[str]:
    """Compile a case-insensitive, literal-only alternation."""
    return re.compile("|".join(re.escape(value) for value in values), re.IGNORECASE)


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
    #: Rust's verdict that this request's transport leaves the Mac even though
    #: the model NAME says local — the Closet (``set_ollama_url``) pointing an
    #: ordinary ``qwen3.5:4b`` at another computer. Only the host can know this,
    #: so it is told to us rather than guessed from the name here.
    relayed: bool = False
    report: PrivacyReport = field(default_factory=PrivacyReport)

    _redact_re: re.Pattern[str] | None = None
    _restore_re: re.Pattern[str] | None = None
    _by_real: dict[str, str] = field(default_factory=dict)
    _by_placeholder: dict[str, str] = field(default_factory=dict)
    _counted_entities: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        self._compile()

    def _compile(self) -> None:
        self.rules = _normalized_privacy_rules(self.rules)
        self._by_real = _real_to_placeholder(self.rules)
        self._by_placeholder = _placeholder_to_real(self.rules)
        self._redact_re, self._restore_re = _privacy_patterns(self.rules)

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

    def sanitize_output_text(self, text: str) -> str:
        """Redact protected values in user-visible model output.

        This is intentionally separate from :meth:`redact_text`: it runs for
        LOCAL models too, after generation, and does not alter the outbound
        privacy counters.  Cloud placeholders are never restored past this
        final gate, and narrowly-labelled secret/canary forms are caught even
        when the scanner failed to mint an exact rule.
        """
        if not text:
            return text
        out = text
        if self._redact_re is not None:
            def _sub(m: re.Match[str]) -> str:
                return self._by_real.get(m.group(0).casefold(), "[Protected detail]")

            out = self._redact_re.sub(_sub, out)
        return _OUTPUT_SECRET_RE.sub(_OUTPUT_SECRET_PLACEHOLDER, out)

    def sanitize_output_value(self, value: Any) -> Any:
        """Apply the final-output gate recursively to JSON-shaped event data."""
        if isinstance(value, str):
            return self.sanitize_output_text(value)
        if isinstance(value, list):
            return [self.sanitize_output_value(v) for v in value]
        if isinstance(value, dict):
            return {k: self.sanitize_output_value(v) for k, v in value.items()}
        return value

    def output_redactor(self) -> "OutputRedactor":
        """A split-token-safe redactor for streamed user-visible deltas."""
        return OutputRedactor(self)

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
                # The count alone vanishes into the aggregate report, but the
                # PROMPT still contains text asserting an attachment (the
                # perception tools' IMAGE_HANDOFF) — so the flattened engines
                # need a per-message trace to answer it honestly. See
                # `external_llm._user_turn`.
                mm["images_blocked"] = len(mm["images"])
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


class OutputRedactor:
    """Stream-safe form of :meth:`PrivacyPolicy.sanitize_output_text`.

    Model chunks can split both exact protected values and labelled canary
    tokens.  The bounded tail is held until neither kind can cross the release
    boundary.  A final event is independently sanitized in full, so this is a
    leak-prevention gate rather than a model-compliance prompt.
    """

    def __init__(self, policy: PrivacyPolicy) -> None:
        self._policy = policy
        self._buf = ""
        self._keep = max(
            _OUTPUT_SECRET_MAX,
            max((len(real) for real, _ in policy.rules), default=0),
        )

    def _matches(self) -> list[tuple[int, int, str]]:
        found: list[tuple[int, int, str]] = []
        if self._policy._redact_re is not None:
            for match in self._policy._redact_re.finditer(self._buf):
                replacement = self._policy._by_real.get(
                    match.group(0).casefold(), "[Protected detail]"
                )
                found.append((match.start(), match.end(), replacement))
        found.extend(
            (m.start(), m.end(), _OUTPUT_SECRET_PLACEHOLDER)
            for m in _OUTPUT_SECRET_RE.finditer(self._buf)
        )
        # Exact rules win on the same start, and overlaps collapse to the first
        # longest match so a labelled value cannot be partially released.
        return sorted(found, key=lambda item: (item[0], -item[1]))

    def feed(self, delta: str) -> str:
        if not delta:
            return ""
        self._buf += delta
        return self._release_safe_prefix()

    def _release_safe_prefix(self) -> str:
        safe_end = max(0, len(self._buf) - self._keep)
        if safe_end == 0:
            return ""
        pieces, cursor = self._release_redacted_matches(safe_end)
        release_to = max(safe_end, cursor)
        if cursor < safe_end:
            pieces.append(self._buf[cursor:safe_end])
        self._buf = self._buf[release_to:]
        return "".join(pieces)

    def _release_redacted_matches(self, safe_end: int) -> tuple[list[str], int]:
        pieces: list[str] = []
        cursor = 0
        for start, end, replacement in self._matches():
            if start < cursor:
                continue
            if start >= safe_end:
                break
            pieces.append(self._buf[cursor:start])
            pieces.append(replacement)
            cursor = end
        return pieces, cursor

    def flush(self) -> str:
        ready, self._buf = self._buf, ""
        return self._policy.sanitize_output_text(ready)


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
        relayed=bool(payload.get("relayed", False)),
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
    if policy is None or not policy.active:
        return messages, images, None
    # Two ways out, and the name only knows one of them: a relayed tag, and a
    # transport the host pointed off this Mac. Asking the name alone let the
    # Closet carry whole documents away with the door reading "on".
    if not (is_nonlocal_model(model) or policy.relayed):
        return messages, images, None
    redacted = policy.redact_messages(messages)
    policy.block_images(images)
    return redacted, None, policy


__all__ = [
    "PrivacyPolicy",
    "PrivacyReport",
    "OutputRedactor",
    "StreamRestorer",
    "is_cloud_model",
    "is_nonlocal_model",
    "policy_from_payload",
    "guard_outbound",
    "CLOUD_PRIVACY_BLOCKED_TOOLS",
    "cloud_privacy_tool_allowed",
]
