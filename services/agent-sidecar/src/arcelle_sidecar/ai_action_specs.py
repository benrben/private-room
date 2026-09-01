"""Request models and declarative action catalog for AI actions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict

from .config import ProviderConfig

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
