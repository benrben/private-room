"""Phase-2 feature logic: the AI ACTIONS menu, memory suggestion, file-meta.

Ported verbatim from ``commands/moonshot/ai_actions.rs``. The sidecar is the app's
SOLE AI service (MIGRATION): the PROMPT table, the schemas, the temperature /
keep_alive, the model call and the output parsing all live here. Rust gathers the
data from the encrypted DB — the scope/@-ref material for an action, the last
user+assistant exchange for a memory suggestion, or a file's name + extracted text
for the meta suggestion — and posts it; Rust then stores/returns what these produce.

Three features land here, faithful to their Rust originals:

* :func:`run_ai_action` — ``ai_action`` (D5/D12). Look up one of the 14 actions,
  build its system+user prompt, ask for a single ``{markdown}`` envelope, and
  return the recovered markdown. Rust propagates an engine failure
  (``chat_structured(...)?``), so a model error raises :class:`.llm.LlmError` and
  the route surfaces it; a reply with no usable markdown becomes an
  ``EMPTY_RESULT`` error carrying the exact "nothing usable" message.

* :func:`memory_suggestion` — ``memory_suggestion`` (D6). Judge whether one durable
  fact is worth saving. The Rust path SWALLOWS any model failure
  (``chat_structured(...).unwrap_or_default()`` -> not worth), so this returns
  ``{"worth": false, "fact": ""}`` on an engine error rather than raising.

* :func:`suggest_file_meta` — ``suggest_file_meta`` (D7). Propose a title, one
  folder, and up to five tags over the first ~2000 bytes of a file's text. Rust
  also swallows model failure (``unwrap_or_default()`` -> the ``echo`` of the
  current name), so this degrades to the echo on an engine error. A too-short
  extraction (<80 chars) skips the model entirely, exactly like Rust.

Structured-output recovery (ollama.rs ``recover_json``): the gateway ``/generate``
returns the model's RAW text, but the Rust ``chat_structured`` these features used
recovered the JSON first — dropping a ``<think>`` preamble and slicing to the outer
brackets so a fence-wrapped or reasoning-prefixed reply still parses. We reproduce
that here so a ``:cloud`` model (which ignores ``format``) behaves as it did.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from . import llm
from .config import KEEP_ALIVE_WARM, num_ctx_chat_notools
from .messages import Message, compact_json, system_message, user_message

#: chat_structured (ollama.rs) primes the schema onto the last user turn because
#: Ollama's ``format`` constrains the GRAMMAR but the model never sees the schema —
#: without the field names a small model fills the forced JSON with empty strings.
#: These features called chat_structured, so we reproduce the exact primer here.
_SCHEMA_PRIMER: str = (
    "\n\nReply with ONLY JSON matching this schema, filling every field with real content:\n"
)

# --- request bodies ---------------------------------------------------------
#
# Rust gathers the DB text (the scope/@-ref material, the last exchange, or a
# file's name + extracted text) and posts it here; the PROMPT, schema, temperature,
# keep_alive and parsing all live in this module. The model is resolved on the Rust
# side (it knows the user's preference) and named per request, and the Ollama
# ``base_url`` rides along (ollama::resolved_base_url()) — same as the gateway.


class AiActionRequest(BaseModel):
    """Body of ``POST /ai_action`` — moonshot/ai_actions.rs ``ai_action`` (D5/D12)."""

    model_config = ConfigDict(extra="ignore")

    model: str
    #: One of the 14 action ids (see AI_ACTIONS). Unknown -> UNKNOWN_ACTION.
    action: str
    #: The gathered scope/@-ref material Rust pulled from the encrypted DB.
    text: str = ""
    #: Overrides the action's default prompt when the user edited it (else null).
    instructions: str | None = None
    #: research's follow-up question OR translate's target language (else null).
    question: str | None = None
    base_url: str = "http://127.0.0.1:11434"
    #: PRIV-1: room privacy policy payload (config.RunRequest docstring).
    privacy: dict[str, Any] | None = None


class MemorySuggestionRequest(BaseModel):
    """Body of ``POST /memory_suggestion`` — ``memory_suggestion`` (D6).

    ``user_text`` / ``assistant_text`` are the last user + assistant messages,
    already markup-stripped on the Rust side. Rust only calls this when BOTH exist
    (the message-absence "no exchange -> not worth" check stays Rust-side)."""

    model_config = ConfigDict(extra="ignore")

    model: str
    user_text: str = ""
    assistant_text: str = ""
    base_url: str = "http://127.0.0.1:11434"
    #: PRIV-1: room privacy policy payload (config.RunRequest docstring).
    privacy: dict[str, Any] | None = None


class FileMetaRequest(BaseModel):
    """Body of ``POST /suggest_file_meta`` — ``suggest_file_meta`` (D7)."""

    model_config = ConfigDict(extra="ignore")

    model: str
    #: The file's current name (drives the echo fallback title).
    current_name: str = ""
    #: The file's extracted text (Rust pulls it; <80 chars skips the model).
    text: str = ""
    base_url: str = "http://127.0.0.1:11434"
    #: PRIV-1: room privacy policy payload (config.RunRequest docstring).
    privacy: dict[str, Any] | None = None

# --- the 14 AI actions ------------------------------------------------------
#
# Verbatim from the AI_ACTIONS table in ai_actions.rs: 9 file-scope then 5
# room-scope, in menu order. The `system` prompt is baked in (the frontend never
# sees it); `default_prompt` is what runs when the user doesn't edit it. Only
# `research` needs a question; only `translate` needs a target language.


@dataclass(frozen=True, slots=True)
class AiActionSpec:
    id: str
    scope: str  # "file" | "room"
    needs_question: bool
    needs_language: bool
    default_prompt: str
    system: str


AI_ACTIONS: tuple[AiActionSpec, ...] = (
    # ---- file scope ----
    AiActionSpec(
        id="summarize",
        scope="file",
        needs_question=False,
        needs_language=False,
        default_prompt="Summarize this material: a one-line TL;DR, then the key points as a short list.",
        system=(
            "You summarize material into a single tight TL;DR line followed by a short list of "
            "its key points. Base everything only on the provided text and add nothing that "
            "isn't there."
        ),
    ),
    AiActionSpec(
        id="analyze",
        scope="file",
        needs_question=False,
        needs_language=False,
        default_prompt="Analyze this material: its structure, main themes, sentiment, risks, and open questions.",
        system=(
            "You analyze material and lay it out under clear markdown sections: Structure, "
            "Themes, Sentiment, Risks, and Open questions. Base everything only on the provided "
            "text."
        ),
    ),
    AiActionSpec(
        id="explain",
        scope="file",
        needs_question=False,
        needs_language=False,
        default_prompt="Explain this material in plain language, as if to a smart friend new to the topic.",
        system=(
            "You explain material in plain, jargon-free language — a clear walkthrough a "
            "newcomer can follow, defining any terms the text relies on. Base everything only "
            "on the provided text."
        ),
    ),
    AiActionSpec(
        id="extract",
        scope="file",
        needs_question=False,
        needs_language=False,
        default_prompt="Extract the entities, dates, figures, and action items from this material.",
        system=(
            "You extract the key entities, dates, figures, and action items from material and "
            "present them as a single markdown table with columns Type, Detail, and Context. "
            "Base every row only on the provided text — never invent entries."
        ),
    ),
    AiActionSpec(
        id="outline",
        scope="file",
        needs_question=False,
        needs_language=False,
        default_prompt="Turn this material into a clean, nested outline of its points.",
        system=(
            "You turn material into a clean, nested markdown outline (bullets and sub-bullets) "
            "that mirrors its structure. Base everything only on the provided text."
        ),
    ),
    AiActionSpec(
        id="rewrite",
        scope="file",
        needs_question=False,
        needs_language=False,
        default_prompt="Rewrite this material into a tighter, clearer version that keeps every point.",
        system=(
            "You rewrite material into a tighter, clearer version that keeps all of its meaning "
            "and points but drops the padding. Base everything only on the provided text and add "
            "no new claims."
        ),
    ),
    AiActionSpec(
        id="qa_pack",
        scope="file",
        needs_question=False,
        needs_language=False,
        default_prompt="Write a set of study question-and-answer pairs covering this material.",
        system=(
            "You write study question-and-answer pairs that test real understanding of the "
            "material. Format each as a bold question line followed by its answer. Base every "
            "pair only on the provided text."
        ),
    ),
    AiActionSpec(
        id="fact_check",
        scope="file",
        needs_question=False,
        needs_language=False,
        default_prompt="Fact-check this material and flag any claim it doesn't actually support.",
        system=(
            "You fact-check material against itself: list its main claims and flag any that are "
            "unsupported, internally contradicted, or overstated by the text. Judge only against "
            "the provided material — never outside knowledge. Present the result as a markdown "
            "table with columns Claim, Verdict, and Why."
        ),
    ),
    # ADD-27: translate. The target language rides in the `question` parameter.
    AiActionSpec(
        id="translate",
        scope="file",
        needs_question=False,
        needs_language=True,
        default_prompt="Translate this material into the target language, keeping its structure.",
        system=(
            "You are a careful translator. Translate the user's material into the requested "
            "target language. Preserve the document structure (headings, lists, tables) and "
            "the exact meaning and tone; keep any [m:ss] timestamps and speaker names "
            "exactly as they appear in the source. Output only the translation."
        ),
    ),
    # ---- room scope ----
    AiActionSpec(
        id="research",
        scope="room",
        needs_question=True,
        needs_language=False,
        default_prompt="Answer the question using this room, and cite the files you draw on.",
        system=(
            "You answer a specific question by synthesizing across the room's material, citing "
            "the file each point comes from (by its heading). If the material doesn't answer the "
            "question, say so plainly. Base everything only on the provided text."
        ),
    ),
    AiActionSpec(
        id="compare",
        scope="room",
        needs_question=False,
        needs_language=False,
        default_prompt="Compare these files side by side — what they agree on and where they differ.",
        system=(
            "You compare the provided files side by side: what they share, where they differ, "
            "and any outright contradictions. Use a markdown table where it helps. Base "
            "everything only on the provided text."
        ),
    ),
    AiActionSpec(
        id="timeline",
        scope="room",
        needs_question=False,
        needs_language=False,
        default_prompt="Build a chronological timeline from the dated events mentioned in this material.",
        system=(
            "You build a chronological timeline from the dated events mentioned in the material, "
            "earliest first, as a markdown table with columns Date, Event, and Source. Include "
            "only dates the text actually states. Base everything only on the provided text."
        ),
    ),
    AiActionSpec(
        id="themes",
        scope="room",
        needs_question=False,
        needs_language=False,
        default_prompt="Group this material into its main themes, with the points under each.",
        system=(
            "You group material into its main themes or topic clusters, listing the supporting "
            "points under each as a markdown outline. Base everything only on the provided text."
        ),
    ),
    AiActionSpec(
        id="gaps",
        scope="room",
        needs_question=False,
        needs_language=False,
        default_prompt="Given this room, point out what's missing or still unanswered.",
        system=(
            "You identify gaps: questions the material raises but doesn't answer, and the topics "
            "it would still need to be complete. Be specific and grounded — no generic advice. "
            "Base everything only on the provided text."
        ),
    ),
)

_ACTION_BY_ID: dict[str, AiActionSpec] = {a.id: a for a in AI_ACTIONS}


# --- error surface ----------------------------------------------------------


class ActionError(Exception):
    """A NON-engine failure (bad action id, missing language, empty result).

    Distinct from :class:`.llm.LlmError` (a 502 engine failure the Rust gateway
    turns back into OLLAMA_DOWN / MODEL_MISSING). These carry the exact Rust-facing
    message and a 4xx status so the Rust rewiring can surface the same string the
    native ``ai_action`` returned.
    """

    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status

    def response(self) -> JSONResponse:
        return JSONResponse(status_code=self.status, content={"error": self.message, "code": self.code})


# --- ported Rust helpers (verbatim semantics) -------------------------------


def _strip_think_spans(raw: str) -> str:
    """ollama.rs ``strip_think_spans``: drop ``<think>…</think>`` reasoning spans.

    An UNTERMINATED ``<think>`` truncates the rest (everything after it is unclosed
    reasoning, not answer)."""
    out = raw
    while True:
        start = out.find("<think>")
        if start == -1:
            return out
        rel = out.find("</think>", start)
        if rel == -1:
            return out[:start]
        out = out[:start] + out[rel + len("</think>") :]


def _recover_json(text: str) -> str:
    """ollama.rs ``recover_json``: strip ``<think>``, then slice from the first
    opening bracket to the last closing one so a fence-wrapped / reasoning-prefixed
    reply still parses. A no-op for a model that already returns bare JSON."""
    s = _strip_think_spans(text.strip()).strip()
    opens = [i for i in (s.find("{"), s.find("[")) if i != -1]
    open_idx = min(opens) if opens else -1
    close_idx = max(s.rfind("}"), s.rfind("]"))
    if open_idx != -1 and close_idx >= open_idx:
        return s[open_idx : close_idx + 1]
    return s


def _load_obj(raw: str) -> dict[str, Any]:
    """Parse the recovered JSON into an object dict; ``{}`` on any failure.

    Mirrors json.rs, where a bad reply is missing data, not an error: every field
    helper below then reads from this dict and the caller falls back."""
    try:
        val = json.loads(_recover_json(raw))
    except (ValueError, TypeError):
        return {}
    return val if isinstance(val, dict) else {}


def _str_field(obj: dict[str, Any], key: str) -> str:
    """json.rs ``json_str_field``: the trimmed string at ``key``, else ``""``."""
    v = obj.get(key)
    return v.strip() if isinstance(v, str) else ""


def _bool_field(obj: dict[str, Any], key: str) -> bool:
    """json.rs ``json_bool_field``: the bool at ``key``, else ``False``."""
    v = obj.get(key)
    return v if isinstance(v, bool) else False


def _str_array(obj: dict[str, Any], key: str) -> list[str]:
    """json.rs ``json_str_array``: trimmed strings at ``key``, blanks dropped."""
    v = obj.get(key)
    if not isinstance(v, list):
        return []
    return [x.strip() for x in v if isinstance(x, str) and x.strip()]


def _clamp_bytes(s: str, max_bytes: int) -> str:
    """agent.rs ``clamp_bytes``: truncate to at most ``max_bytes`` UTF-8 bytes
    without splitting a char (``decode(errors='ignore')`` drops the partial tail,
    exactly like the Rust ``floor_boundary``)."""
    data = s.encode("utf-8")
    if len(data) <= max_bytes:
        return s
    return data[:max_bytes].decode("utf-8", errors="ignore")


def _title_from_name(name: str) -> str:
    """docs_html.rs ``title_from_name``: drop the extension ("a.md" -> "a"); a
    leading-dot or extension-less name is returned whole."""
    i = name.rfind(".")
    return name[:i] if i > 0 else name


def _instruction(instructions: str | None, default: str) -> str:
    """studios.rs ``studio_instruction``: the user's edit if non-blank, else the
    action's default prompt (trimmed)."""
    if instructions is not None:
        trimmed = instructions.strip()
        if trimmed:
            return trimmed
    return default


def _prime_schema(messages: list[Message], schema: dict[str, Any]) -> list[Message]:
    """Append the schema primer to the last user turn (chat_structured, ollama.rs).

    Non-mutating: returns a fresh list so a caller's messages are untouched."""
    out: list[Message] = [dict(m) for m in messages]  # type: ignore[misc]
    for m in reversed(out):
        if m.get("role") == "user":
            m["content"] = m.get("content", "") + _SCHEMA_PRIMER + compact_json(schema)
            break
    return out


# --- D5/D12: run one AI action ----------------------------------------------

_MARKDOWN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"markdown": {"type": "string"}},
    "required": ["markdown"],
}


async def run_ai_action(
    action: str,
    text: str,
    model: str,
    base_url: str,
    instructions: str | None = None,
    question: str | None = None,
    privacy: dict[str, Any] | None = None,
) -> str:
    """Run one AI action over the gathered ``text`` and return its markdown.

    ``instructions`` overrides the action's default prompt; ``question`` carries the
    research follow-up OR the translate target language. Raises :class:`ActionError`
    for an unknown action, a missing target language, or an empty result; raises
    :class:`.llm.LlmError` on an engine failure (both surfaced by the route)."""
    spec = _ACTION_BY_ID.get(action)
    if spec is None:
        raise ActionError("UNKNOWN_ACTION", f'"{action}" isn\'t a known AI action.')

    instr = _instruction(instructions, spec.default_prompt)
    # Always ground the model in the gathered text; `research` also folds in the
    # user's question, `translate` the target language.
    base = f"Base everything only on this material:\n\n{text}"
    ask = question.strip() if question is not None else ""
    ask = ask if ask else None

    if ask is not None and spec.needs_question:
        user = f"{instr}\n\nQuestion: {ask}\n\n{base}"
    elif ask is not None and spec.needs_language:
        user = f"{instr}\n\nTarget language: {ask}\n\n{base}"
    elif ask is None and spec.needs_language:
        raise ActionError("NEEDS_LANGUAGE", "Pick a target language first.")
    else:
        user = f"{instr}\n\n{base}"

    # A single-field markdown envelope: the model writes free-form Markdown into
    # one constrained string, so any action (tables, outlines, prose) fits.
    messages = _prime_schema([system_message(spec.system), user_message(user)], _MARKDOWN_SCHEMA)
    raw = await llm.generate(
        model,
        messages,
        base_url,
        temperature=0.3,
        num_ctx=num_ctx_chat_notools(),
        keep_alive=KEEP_ALIVE_WARM,
        format=_MARKDOWN_SCHEMA,
        privacy=privacy,
    )
    markdown = _str_field(_load_obj(raw), "markdown")
    if not markdown:
        # Small local models sometimes choke on grammar-constrained LONG output
        # (translate over a whole file being the classic case): the constrained
        # call returns an empty/mangled envelope. Retry ONCE without the schema
        # — plain prose from the same prompt IS the markdown we wanted. If the
        # retry STILL answers with a JSON envelope, read its markdown field
        # (possibly empty → the honest EMPTY_RESULT below) rather than passing
        # the raw envelope through as literal text.
        plain = await llm.generate(
            model,
            [system_message(spec.system), user_message(user)],
            base_url,
            temperature=0.3,
            num_ctx=num_ctx_chat_notools(),
            keep_alive=KEEP_ALIVE_WARM,
            privacy=privacy,
        )
        obj = _load_obj(plain)
        markdown = (
            _str_field(obj, "markdown") if obj else _strip_think_spans(plain).strip()
        )
    if not markdown:
        raise ActionError(
            "EMPTY_RESULT",
            "The model didn't return anything usable — try a different file.",
            status=422,
        )
    return markdown


# --- D6: memory suggestion --------------------------------------------------

_MEMORY_SYSTEM = (
    "You decide whether a single durable fact about the user or their world is worth "
    "saving to this room's long-term memory. Only lasting, reusable facts count — not "
    "one-off task details or general knowledge. If worth remembering, phrase it as one "
    "short standalone sentence."
)

_MEMORY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "worth_remembering": {"type": "boolean"},
        "fact": {"type": "string"},
    },
    "required": ["worth_remembering", "fact"],
}


async def memory_suggestion(
    model: str,
    user_text: str,
    assistant_text: str,
    base_url: str,
    privacy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Judge whether one durable fact from the exchange is worth remembering (D6).

    ``user_text`` / ``assistant_text`` are the last user + assistant messages, already
    markup-stripped on the Rust side (the message-ABSENCE short-circuit — no exchange
    -> not worth — stays in Rust, as it's DB work). Each is clamped to 2000 bytes for
    the prompt. Swallows any engine failure to ``{"worth": false, "fact": ""}``,
    matching Rust's ``chat_structured(...).unwrap_or_default()``."""
    messages = _prime_schema(
        [
            system_message(_MEMORY_SYSTEM),
            user_message(
                "User asked:\n{}\n\nAssistant answered:\n{}".format(
                    _clamp_bytes(user_text, 2000), _clamp_bytes(assistant_text, 2000)
                )
            ),
        ],
        _MEMORY_SCHEMA,
    )
    try:
        raw = await llm.generate(
            model,
            messages,
            base_url,
            temperature=0.2,
            num_ctx=num_ctx_chat_notools(),
            keep_alive=KEEP_ALIVE_WARM,
            format=_MEMORY_SCHEMA,
            privacy=privacy,
        )
    except llm.LlmError:
        # Model down: not worth (Rust unwrap_or_default -> empty raw -> false).
        return {"worth": False, "fact": ""}
    obj = _load_obj(raw)
    fact = _str_field(obj, "fact")
    worth = _bool_field(obj, "worth_remembering")
    # A fact is only worth surfacing if the model both flagged it AND wrote one.
    return {"worth": worth and bool(fact), "fact": fact}


# --- D7: suggest file metadata ----------------------------------------------

_FILE_META_SYSTEM = (
    "You propose tidy metadata for a document: a short human title, one broad folder name "
    "to file it under, and up to five short lowercase tags. Base everything on the text; "
    "keep it concise."
)

_FILE_META_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "folder": {"type": "string"},
        "tags": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["title", "folder", "tags"],
}


async def suggest_file_meta(
    model: str,
    current_name: str,
    text: str,
    base_url: str,
    privacy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Propose a title, one folder, and up to five tags for a file (D7).

    ``current_name`` + the file's extracted ``text`` are gathered on the Rust side.
    A too-short extraction (<80 chars — a damaged PDF, an error page saved as one)
    skips the model and echoes the current name, exactly like Rust. Swallows any
    engine failure to that same echo (Rust ``unwrap_or_default()``)."""

    def echo() -> dict[str, Any]:
        return {"title": _title_from_name(current_name), "folder": "", "tags": []}

    # A rename/file-under proposal is only as good as the text behind it: a failed
    # or trivial extraction yields a few stray words, so stay quiet instead.
    if len(text.strip()) < 80:
        return echo()

    snippet = _clamp_bytes(text, 2000)
    messages = _prime_schema(
        [
            system_message(_FILE_META_SYSTEM),
            user_message(f"Current file name: {current_name}\n\nBeginning of the text:\n{snippet}"),
        ],
        _FILE_META_SCHEMA,
    )
    try:
        raw = await llm.generate(
            model,
            messages,
            base_url,
            temperature=0.3,
            num_ctx=num_ctx_chat_notools(),
            keep_alive=KEEP_ALIVE_WARM,
            format=_FILE_META_SCHEMA,
            privacy=privacy,
        )
    except llm.LlmError:
        return echo()
    obj = _load_obj(raw)
    title = _str_field(obj, "title")
    folder = _str_field(obj, "folder")
    # Lowercase the tags and keep at most five (ai_actions.rs).
    tags = [t.lower() for t in _str_array(obj, "tags")][:5]
    # An empty title falls back to the current name — i.e. exactly echo()'s title.
    return {
        "title": title if title else _title_from_name(current_name),
        "folder": folder,
        "tags": tags,
    }


__all__ = [
    "AI_ACTIONS",
    "AiActionSpec",
    "ActionError",
    "AiActionRequest",
    "MemorySuggestionRequest",
    "FileMetaRequest",
    "run_ai_action",
    "memory_suggestion",
    "suggest_file_meta",
]
