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
  ``EMPTY_RESULT`` error whose advice matches the action's SCOPE (a room-scope
  action has no single file to blame).

* :func:`memory_suggestion` — ``memory_suggestion`` (D6). Judge whether one durable
  fact is worth saving. The Rust path SWALLOWS any model failure
  (``chat_structured(...).unwrap_or_default()`` -> not worth), so this returns
  ``{"worth": false, "fact": ""}`` on an engine error rather than raising.

* :func:`suggest_file_meta` — ``suggest_file_meta`` (D7). Propose a title, one
  folder, and up to five tags over the first ~2000 bytes of a file's text. Rust
  also swallows model failure (``unwrap_or_default()`` -> the ``echo`` of the
  current name), so this degrades to the echo on an engine error. A too-short
  extraction (<80 chars) skips the model entirely, exactly like Rust.

A fourth feature lands here too, but it is NOT a port — there is no Rust original,
this is a brand-new generic service built once against a fixed cross-layer
contract (Rust + frontend built their halves in parallel against the same spec):

* :func:`generate_ui_text` — ``POST /generate_ui_text``. A small, generic "write
  me a short piece of adaptive UI text from local facts" pipe, reused by several
  features (an area subtitle, a tab title, an activity summary, ...). It owns NO
  per-feature prompt wording — the caller composes the whole ``prompt`` — so this
  is validation, not a feature: empty/blank output, an overlong reply, and a
  fabricated number (one absent from the caller's own ``facts``, as either a
  digit or a spelled-out word) all degrade to ``text: null`` rather than ever
  raising or 500ing.

Structured-output recovery (ollama.rs ``recover_json``): the gateway ``/generate``
returns the model's RAW text, but the Rust ``chat_structured`` these features used
recovered the JSON first — dropping a ``<think>`` preamble and slicing to the outer
brackets so a fence-wrapped or reasoning-prefixed reply still parses. We reproduce
that here so a ``:cloud`` model (which ignores ``format``) behaves as it did.
"""

from __future__ import annotations

from typing import Any

from fastapi.responses import JSONResponse

from . import llm
from .ai_action_specs import (
    AI_ACTIONS as AI_ACTIONS,
    _ACTION_BY_ID,
    AiActionRequest as AiActionRequest,
    AiActionSpec as AiActionSpec,
    FileMetaRequest as FileMetaRequest,
    MemorySuggestionRequest as MemorySuggestionRequest,
    UiTextRequest as UiTextRequest,
)
from .ai_actions_ui import (
    _load_obj,
    _str_field,
    generate_ui_text as generate_ui_text,
)
from .budget import truncate_bytes
from .config import KEEP_ALIVE_WARM
from .messages import system_message, user_message
from .model_text import prime_schema, strip_think_spans

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


# --- D5/D12: run one AI action ----------------------------------------------

_MARKDOWN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"markdown": {"type": "string"}},
    "required": ["markdown"],
}

#: Output-token ceiling (``num_predict``) for an action, the same runaway guard
#: the PASS job carries (file_pass.PASS_DOC_PREDICT). Not a quality limit: Rust
#: clamps the gathered material to ~12 KB before posting (studios.rs
#: ``gather_scope_text``/``gather_files_text``), so even a full translation lands
#: far below this. Without it a degenerate repetition loop on a small local model
#: generates until it fills the whole payload-fitted window — which can be 128k —
#: and the menu simply appears to hang.
ACTION_PREDICT: int = 8_192

_COMPARE_GROUNDING = (
    " Before synthesizing, build a separate fact list for each file heading in "
    "the provided material. Every comparison sentence must name the supporting "
    "file heading(s); never transfer a fact from one file to another. If no "
    "source span supports a claimed relationship, omit it."
)

_TRANSLATION_QUALITY = (
    " Use natural, idiomatic terminology for the target locale rather than "
    "literal calques. Silently review terminology and grammar once before "
    "returning the translation."
)


_ACTION_SYSTEM_SUFFIXES = {
    "compare": _COMPARE_GROUNDING,
    "translate": _TRANSLATION_QUALITY,
}


def _action_spec(action: str) -> AiActionSpec:
    spec = _ACTION_BY_ID.get(action)
    if spec is None:
        raise ActionError("UNKNOWN_ACTION", f'"{action}" isn\'t a known AI action.')
    return spec


def _action_system(action: str, spec: AiActionSpec) -> str:
    suffix = _ACTION_SYSTEM_SUFFIXES.get(action)
    return f"{spec.system}{suffix}" if suffix else spec.system


def _optional_question(question: str | None) -> str | None:
    if question is None:
        return None
    return question.strip() or None


def _action_user_with_question(
    spec: AiActionSpec, instruction: str, base: str, question: str
) -> str:
    if spec.needs_question:
        return f"{instruction}\n\nQuestion: {question}\n\n{base}"
    if spec.needs_language:
        return f"{instruction}\n\nTarget language: {question}\n\n{base}"
    return f"{instruction}\n\n{base}"


def _action_user_without_question(spec: AiActionSpec, instruction: str, base: str) -> str:
    if spec.needs_language:
        raise ActionError("NEEDS_LANGUAGE", "Pick a target language first.")
    if spec.needs_question:
        raise ActionError("NEEDS_QUESTION", "Ask a question first.")
    return f"{instruction}\n\n{base}"


def _action_user(
    spec: AiActionSpec, instruction: str, text: str, question: str | None
) -> str:
    base = f"Base everything only on this material:\n\n{text}"
    optional_question = _optional_question(question)
    if optional_question is None:
        return _action_user_without_question(spec, instruction, base)
    return _action_user_with_question(spec, instruction, base, optional_question)


async def _structured_action_markdown(
    model: str,
    system: str,
    user: str,
    base_url: str,
    privacy: dict[str, Any] | None,
    provider: Any | None,
) -> str:
    messages = prime_schema([system_message(system), user_message(user)], _MARKDOWN_SCHEMA)
    raw = await llm.generate(
        model,
        messages,
        base_url,
        temperature=0.3,
        num_predict=ACTION_PREDICT,
        keep_alive=KEEP_ALIVE_WARM,
        format=_MARKDOWN_SCHEMA,
        privacy=privacy,
        provider=provider,
    )
    return _str_field(_load_obj(raw), "markdown")


async def _plain_action_markdown(
    model: str,
    system: str,
    user: str,
    base_url: str,
    privacy: dict[str, Any] | None,
    provider: Any | None,
) -> str:
    raw = await llm.generate(
        model,
        [system_message(system), user_message(user)],
        base_url,
        temperature=0.3,
        num_predict=ACTION_PREDICT,
        keep_alive=KEEP_ALIVE_WARM,
        privacy=privacy,
        provider=provider,
    )
    obj = _load_obj(raw)
    if obj:
        return _str_field(obj, "markdown")
    return strip_think_spans(raw).strip()


def _empty_action_result(spec: AiActionSpec) -> ActionError:
    advice = (
        "try again, or add more material to this room"
        if spec.scope == "room"
        else "try a different file"
    )
    return ActionError(
        "EMPTY_RESULT",
        f"The model didn't return anything usable — {advice}.",
        status=422,
    )


async def run_ai_action(
    action: str,
    text: str,
    model: str,
    base_url: str,
    instructions: str | None = None,
    question: str | None = None,
    privacy: dict[str, Any] | None = None,
    provider: Any | None = None,
) -> str:
    """Run one AI action over the gathered ``text`` and return its markdown.

    ``instructions`` overrides the action's default prompt; ``question`` carries the
    research follow-up OR the translate target language. Raises :class:`ActionError`
    for an unknown action, a missing question or target language, or an empty
    result; raises :class:`.llm.LlmError` on an engine failure (both surfaced by
    the route)."""
    spec = _action_spec(action)

    instruction = _instruction(instructions, spec.default_prompt)
    system = _action_system(action, spec)
    user = _action_user(spec, instruction, text, question)
    markdown = await _structured_action_markdown(
        model, system, user, base_url, privacy, provider
    )
    if not markdown:
        # Small local models sometimes choke on grammar-constrained LONG output
        # (translate over a whole file being the classic case): the constrained
        # call returns an empty/mangled envelope. Retry ONCE without the schema
        # — plain prose from the same prompt IS the markdown we wanted. If the
        # retry STILL answers with a JSON envelope, read its markdown field
        # (possibly empty → the honest EMPTY_RESULT below) rather than passing
        # the raw envelope through as literal text.
        markdown = await _plain_action_markdown(
            model, system, user, base_url, privacy, provider
        )
    if not markdown:
        raise _empty_action_result(spec)
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
    provider: Any | None = None,
) -> dict[str, Any]:
    """Judge whether one durable fact from the exchange is worth remembering (D6).

    ``user_text`` / ``assistant_text`` are the last user + assistant messages, already
    markup-stripped on the Rust side (the message-ABSENCE short-circuit — no exchange
    -> not worth — stays in Rust, as it's DB work). Each is clamped to 2000 bytes for
    the prompt. Swallows any engine failure to ``{"worth": false, "fact": ""}``,
    matching Rust's ``chat_structured(...).unwrap_or_default()``."""
    messages = prime_schema(
        [
            system_message(_MEMORY_SYSTEM),
            user_message(
                "User asked:\n{}\n\nAssistant answered:\n{}".format(
                    truncate_bytes(user_text, 2000), truncate_bytes(assistant_text, 2000)
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
            keep_alive=KEEP_ALIVE_WARM,
            format=_MEMORY_SCHEMA,
            privacy=privacy,
            provider=provider,
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
    provider: Any | None = None,
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

    snippet = truncate_bytes(text, 2000)
    messages = prime_schema(
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
            keep_alive=KEEP_ALIVE_WARM,
            format=_FILE_META_SCHEMA,
            privacy=privacy,
            provider=provider,
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
    "ACTION_PREDICT",
    "AI_ACTIONS",
    "AiActionSpec",
    "ActionError",
    "AiActionRequest",
    "MemorySuggestionRequest",
    "FileMetaRequest",
    "UiTextRequest",
    "run_ai_action",
    "memory_suggestion",
    "suggest_file_meta",
    "generate_ui_text",
]
