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

import json
import logging
import math
import re
from dataclasses import dataclass
from typing import Any

from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from . import llm
from .budget import truncate_bytes
from .config import KEEP_ALIVE_SHORT, KEEP_ALIVE_WARM, ProviderConfig
from .messages import compact_json, system_message, user_message
from .model_text import prime_schema, recover_json, strip_think_spans

_log = logging.getLogger(__name__)

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
    provider: ProviderConfig | None = None


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
    provider: ProviderConfig | None = None


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
    provider: ProviderConfig | None = None


class UiTextRequest(BaseModel):
    """Body of ``POST /generate_ui_text`` — the generic adaptive-UI-text pipe.

    ``kind`` is a free-form label ("dek"/"tab_title"/"activity_summary"/...) used
    ONLY for logging — it plays no role in generation. ``prompt`` is the full
    instruction text, already composed by the frontend caller; this pipe adds no
    wording of its own. ``facts`` is the raw structured facts the frontend based
    ``prompt`` on — used ONLY by the post-generation numeral guard, never sent to
    the model as a separate payload. ``max_words`` sizes both the output-token
    budget and the word-count validation below."""

    model_config = ConfigDict(extra="ignore")

    model: str
    kind: str = ""
    prompt: str = ""
    facts: Any = None
    max_words: int = 20
    base_url: str = "http://127.0.0.1:11434"
    #: PRIV-1: room privacy policy payload (config.RunRequest docstring).
    privacy: dict[str, Any] | None = None
    provider: ProviderConfig | None = None

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


def _load_obj(raw: str) -> dict[str, Any]:
    """Parse the recovered JSON into an object dict; ``{}`` on any failure.

    Mirrors json.rs, where a bad reply is missing data, not an error: every field
    helper below then reads from this dict and the caller falls back."""
    try:
        val = json.loads(recover_json(raw))
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
    elif ask is None and spec.needs_question:
        # The backstop translate already had: research WITHOUT its question used
        # to run anyway, and the model — told to "answer the question" with no
        # question in the prompt — invents one and answers that.
        raise ActionError("NEEDS_QUESTION", "Ask a question first.")
    else:
        user = f"{instr}\n\n{base}"

    # A single-field markdown envelope: the model writes free-form Markdown into
    # one constrained string, so any action (tables, outlines, prose) fits.
    messages = prime_schema([system_message(spec.system), user_message(user)], _MARKDOWN_SCHEMA)
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
            num_predict=ACTION_PREDICT,
            keep_alive=KEEP_ALIVE_WARM,
            privacy=privacy,
            provider=provider,
        )
        obj = _load_obj(plain)
        markdown = (
            _str_field(obj, "markdown") if obj else strip_think_spans(plain).strip()
        )
    if not markdown:
        # A room-scope action reads the WHOLE room, so "try a different file"
        # sends the user hunting for a file to blame that does not exist.
        advice = (
            "try again, or add more material to this room"
            if spec.scope == "room"
            else "try a different file"
        )
        raise ActionError(
            "EMPTY_RESULT",
            f"The model didn't return anything usable — {advice}.",
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


# --- generic adaptive UI text ------------------------------------------------
#
# A thin, generic "write me a short piece of adaptive UI text from local facts"
# pipe, built once and reused by several features (an area subtitle, a tab
# title, an activity summary, ...). Unlike everything above, this owns NO
# PER-FEATURE prompt wording of its own — the frontend caller composes the full
# `prompt` — so what lives here is the model call plus validation, not a
# feature. The one exception is `_DIGIT_INSTRUCTION` below: it steers every
# caller's output toward a form the numeral guard can check, so it belongs to
# the guard, not to any one feature's wording. A model that fabricates a
# number, rambles past its word budget, or answers with nothing usable all
# degrade to `None`; the caller shows its static fallback.

_UI_TEXT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"text": {"type": "string"}},
    "required": ["text"],
}

#: Appended to every caller's prompt (never as feature wording — see the module
#: comment above). A real local model very often spells small numbers out in
#: ordinary prose ("Twelve recordings are stored.") rather than using digits,
#: which puts them past the digit-only guard below entirely. This nudges the
#: model toward digits, which the guard CAN check; `_NUMBER_WORD_RE` below is
#: the backstop for when a model ignores the nudge (a prompt instruction, not a
#: guarantee).
_DIGIT_INSTRUCTION = (
    "\n\nWrite every number as a digit (e.g. \"3\", not \"three\") — never spell numbers out."
)

#: A maximal digit run — mirrors what the numeral guard looks for on both sides
#: (the generated text and the JSON-serialized facts it must stay within).
_NUMBER_RE = re.compile(r"\d+")

#: Cardinal (and common ordinal) English number words — the digit guard above
#: only ever sees runs of `\d` and is blind to a model spelling a number out in
#: prose despite `_DIGIT_INSTRUCTION` ("The room holds fifteen files." has no
#: digit in it at all). Deliberately blunt, matching the digit guard's own
#: "hard rule, not a suggestion" philosophy: reject the whole word rather than
#: trying to parse it into a value and range-check it. Scoped to what UI-text
#: -sized facts (counts, sizes, tab labels) realistically say — not an
#: exhaustive English numeral parser.
_NUMBER_WORDS: frozenset[str] = frozenset(
    """one two three four five six seven eight nine ten
    eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen
    twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million
    first second third fourth fifth sixth seventh eighth ninth tenth
    eleventh twelfth""".split()
)

#: Whole-word, case-insensitive match for any of `_NUMBER_WORDS`.
_NUMBER_WORD_RE = re.compile(r"\b(" + "|".join(sorted(_NUMBER_WORDS)) + r")\b", re.IGNORECASE)

#: A reply is allowed to run a little long, but not ramble: past this multiple
#: of the caller's `max_words`, showing nothing beats an overflowing UI slot.
_WORD_COUNT_SLACK = 1.3

#: Output-token floor for the tab-title-style consumer (`max_words` as low as
#: 4, so `max_words * 2` alone is 8) — too tight once the `{"text": "..."}`
#: JSON-schema wrapping is included: a real local model's reply gets cut off
#: mid-string a measurable fraction of the time (empirically ~10-65% depending
#: on how many sub-word tokens the natural answer needs — see
#: generate_ui_text's docstring), silently degrading to `None` even though the
#: model "knew" the answer. `max_predict` never LOWERS the token budget for a
#: caller with a bigger `max_words` — it only raises the floor for small ones.
_MIN_UI_TEXT_PREDICT = 24


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
    """Generate one short piece of adaptive UI text, or ``None`` (``POST /generate_ui_text``).

    ``prompt`` is the full instruction text the frontend already composed — this
    function adds no PER-FEATURE wording of its own (only ``_DIGIT_INSTRUCTION``,
    a guard-enabling nudge every caller gets), the low-temperature model call,
    and the validation below. ``kind`` is a free-form label, logged only.
    ``facts`` is the raw structured data the frontend based ``prompt`` on; it is
    used ONLY by the numeral guard (3) below, never sent to the model separately.

    ``None`` is a fully valid, expected result (never an error to the caller):

    * an :class:`.llm.LlmError` (or any other exception) from the model call,
    * (1) an empty/whitespace-only reply (including one truncated mid-JSON by
      too tight an output-token budget — see ``_MIN_UI_TEXT_PREDICT``),
    * (2) a reply longer than ``max_words * 1.3`` words — better nothing than a
      result that overflows its UI slot,
    * (3) THE NUMERAL GUARD, in two parts — a fabricated figure the model
      wasn't given is rejected whether it wrote it as a digit or spelled it
      out in a word, and BOTH sides check against the facts payload's own
      serialized text so a fact that already says "three" isn't a false
      positive:
        - a number (a maximal digit run) that doesn't appear anywhere in the
          JSON-serialized ``facts``;
        - a cardinal/ordinal number WORD (``_NUMBER_WORDS`` — "three",
          "twelfth", ...) that doesn't appear as that same word, literally, in
          the JSON-serialized ``facts``. The prompt also instructs the model to
          write digits, not words (``_DIGIT_INSTRUCTION``), so this is the
          backstop for when a model spells one out anyway — which local models
          do often enough in ordinary prose that the digit-only check alone is
          nearly inert against them.
      Hard rule, not a suggestion, on both counts: reject outright rather than
      trying to parse the value and range-check it.

    Each rejection is logged server-side with why, so a "why did this go blank"
    question is debuggable later even though the caller only ever sees ``None``.
    """
    messages = prime_schema([user_message(prompt + _DIGIT_INSTRUCTION)], _UI_TEXT_SCHEMA)
    try:
        raw = await llm.generate(
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

    text = _str_field(_load_obj(raw), "text")
    if not text:
        _log.debug("generate_ui_text[%s]: empty/blank (or truncated/unparsable) reply, degrading to null", kind)
        return None

    words = _word_count(text)
    limit = math.ceil(max_words * _WORD_COUNT_SLACK)
    if words > limit:
        _log.debug(
            "generate_ui_text[%s]: %d words over the %d-word cap (max_words=%d), degrading to null",
            kind, words, limit, max_words,
        )
        return None

    facts_text = compact_json(facts)

    fabricated_digits = set(_NUMBER_RE.findall(text)) - set(_NUMBER_RE.findall(facts_text))
    if fabricated_digits:
        _log.debug(
            "generate_ui_text[%s]: fabricated number(s) %s not present in facts, degrading to null",
            kind, sorted(fabricated_digits),
        )
        return None

    text_words = {w.lower() for w in _NUMBER_WORD_RE.findall(text)}
    facts_words = {w.lower() for w in _NUMBER_WORD_RE.findall(facts_text)}
    fabricated_words = text_words - facts_words
    if fabricated_words:
        _log.debug(
            "generate_ui_text[%s]: fabricated number word(s) %s not present in facts, degrading to null",
            kind, sorted(fabricated_words),
        )
        return None

    return text


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
