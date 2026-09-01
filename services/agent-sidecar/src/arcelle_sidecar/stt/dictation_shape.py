"""Local-only dictation translation and intent shaping."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Awaitable, Protocol

from arcelle_sidecar.messages import Message, user_message
from arcelle_sidecar.model_text import strip_think_spans

log = logging.getLogger("arcelle_sidecar.stt.dictation")

# =============================================================================
# ---- shaping: prompts + pure helpers (ADD-18, stt_cmds.rs:688-747, 857-866) --
#
# Every string below is byte-for-byte the Rust literal (its `\`-continuations
# joined the way rustc does). `tests/test_dictation.py` re-derives them from
# stt_cmds.rs itself on every run, so a drift on either side is a test failure
# rather than a prompt that quietly stopped matching the shipped app.
# =============================================================================

DICT_TRANSLATE: str = (
    "Translate it into fluent, natural English. If it is already English, "
    "keep it unchanged. Preserve meaning and tone."
)

DICT_REWRITE: str = (
    "Clean up this raw voice transcription: remove filler words (um, uh, like), "
    "false starts, and repetitions; fix grammar, spelling, and punctuation; "
    "preserve the speaker's meaning, intent, and tone. Do not add new "
    "information and do not answer any question contained in the text."
)

DICT_TAIL: str = (
    "Output ONLY the resulting text, with no preamble, labels, explanations, "
    "or surrounding quotes."
)

#: alfred's Prompt Optimizer — a standalone rewrite instruction (it REPLACES
#: the cleanup instruction instead of extending it).
DICT_PROMPT_OPTIMIZER: str = (
    "You are a prompt optimizer. Given any user input, automatically rewrite "
    "it into a clear, effective prompt. Never ask follow-up questions — infer "
    "everything from the input alone and preserve the user's full original "
    "intent (every requirement, entity, constraint, and nuance must survive "
    "the rewrite; never add goals they didn't imply).\n\nINTERNAL STEPS (do "
    "not show these):\n1. Deconstruct: extract the core intent, key entities, "
    "context, output requirements, and constraints.\n2. Develop: silently "
    "classify the request type and apply the fitting approach (creative → "
    "multi-perspective; technical → constraint-based precision; educational → "
    "clear structure and examples; complex → step-by-step framing). Add a "
    "role/expertise framing and logical structure where it helps.\n3. "
    "Auto-detect level: SHORT for simple requests (a tight one-paragraph "
    "prompt), DETAILED for complex ones (role, context, task breakdown, "
    "output format).\n\nOUTPUT:\nReturn only the rewritten prompt — no "
    "preamble, no explanation of changes, no questions."
)

#: mode -> (guidance, replaces_cleanup). alfred's BUILTIN_MODES: guidance is
#: APPENDED to the cleanup instruction, except "prompt", which swaps it out.
_DICT_MODE_GUIDANCE: dict[str, tuple[str, bool]] = {
    "raw": ("", False),  # cleanup only
    "email": (
        "Shape it as the body of a clear, courteous email. Do not invent a "
        "subject line, greeting, or signature unless they were dictated.",
        False,
    ),
    "message": ("Shape it as a concise, natural chat/Slack message.", False),
    "commit": (
        "Shape it as a git commit message: a short imperative summary line "
        "(<=72 chars), then a blank line, then bullet points if warranted.",
        False,
    ),
    "notes": (
        "Shape it as clean, organized notes (short paragraphs or bullets).",
        False,
    ),
    "prompt": (DICT_PROMPT_OPTIMIZER, True),
}


def dict_mode_guidance(mode: str) -> tuple[str, bool] | None:
    """Intent guidance for ``mode`` as ``(guidance, replaces_cleanup)``, or
    ``None`` for "off" and anything unrecognized — Rust's ``_ => None``, which
    means no rewrite stage at all rather than a default one."""
    return _DICT_MODE_GUIDANCE.get(mode)


def dict_pass_text(raw: str) -> str:
    """What a shaping pass hands back as the user's dictated words.

    ``generate`` returns the model's RAW text and a thinking model prefixes it
    with ``<think>…</think>``. This text is typed into the composer AS the
    user's own sentence, so an unstripped monologue is dictation putting the
    model's private reasoning in their mouth — and, in ``prompt`` mode, in the
    next thing they send. (stt_cmds.rs ``dict_pass_text``.)
    """
    return strip_think_spans(raw).strip()


# =============================================================================
# ---- shaping: the injected local-model seam (see the module docstring §3) ----
# =============================================================================


class GenerateFn(Protocol):
    """``generate(model, messages, temperature=…, keep_alive=…) -> text``.

    TODO(engine-routing batch): production wires this to a thin adapter over
    ``arcelle_sidecar.llm.generate`` pinned to a base URL, once
    ``model_setting``/``runs_on_this_mac``/``best_local_default`` are ported.
    """

    def __call__(
        self,
        model: str,
        messages: list[Message],
        *,
        temperature: float | None = None,
        keep_alive: str | None = None,
    ) -> Awaitable[str]: ...


class ListLocalModelsFn(Protocol):
    """``list_local_models() -> ["qwen3.5:4b", …]`` — installed LOCAL models
    only. NEVER a ``:cloud`` tag: dictated words do not leave this Mac, and
    whoever implements this for production owns keeping that true."""

    def __call__(self) -> Awaitable[list[str]]: ...


@dataclass
class LocalModelHooks:
    """What :func:`shape_text` needs from the not-yet-ported Ollama routing
    layer — see the module docstring §3 for why this is an injection point
    rather than a real client."""

    generate: GenerateFn
    list_local_models: ListLocalModelsFn


@dataclass
class ShapeResult:
    """:func:`shape_text`'s answer: the best text produced, plus human-readable
    notes for every stage that fell back instead of failing outright. Empty
    ``notes`` means every requested pass ran and produced real output."""

    text: str
    notes: list[str] = field(default_factory=list)


#: Rust's own two refusal strings, verbatim (stt_cmds.rs:785, 787).
_NO_LOCAL_AI = "The local AI (Ollama) isn't running — raw transcript kept."
_NO_LOCAL_MODEL = "No local AI model is installed — raw transcript kept."
_TRANSLATE_FAILED = "Translating failed — kept the exact transcript."
_SHAPE_FAILED = "Cleaning up failed — kept the transcript as dictated."


async def run_dict_pass(
    model: str, steps: list[str], text: str, generate: GenerateFn
) -> str:
    """One dictation-shaping model call. A single instruction gets a plain
    prompt; multiple instructions keep the numbered "operations in order" shape
    (ADD-22). Temperature and keep-alive match Rust's call exactly (``Some(0.2)``,
    ``"5m"``). MAY RAISE — :func:`shape_text` decides what a failed pass means.
    """
    if len(steps) == 1:
        prompt = f"{steps[0]}\n\n{DICT_TAIL}\n\nINPUT TEXT:\n{text}"
    else:
        numbered = "\n".join(f"{i + 1}. {s}" for i, s in enumerate(steps))
        prompt = (
            "You are a text post-processor. Apply the following operations to "
            f"the INPUT TEXT, in order:\n{numbered}\n\n{DICT_TAIL}\n\nINPUT TEXT:\n{text}"
        )
    raw = await generate(model, [user_message(prompt)], temperature=0.2, keep_alive="5m")
    return dict_pass_text(raw)


def _shape_steps(mode: str) -> list[str]:
    """Build the cleanup and intent instructions for one dictation mode."""
    guidance = dict_mode_guidance(mode)
    if guidance is None:
        return []
    instruction, replaces_cleanup = guidance
    if replaces_cleanup:
        return [instruction]
    if instruction == "":
        return [DICT_REWRITE]
    return [DICT_REWRITE, instruction]


def _shaping_is_disabled(translate: bool, shape_steps: list[str]) -> bool:
    return not translate and not shape_steps


async def _model_or_fallback(hooks: LocalModelHooks, text: str) -> str | ShapeResult:
    """Choose the current stand-in local model or retain the transcript."""
    try:
        models = await hooks.list_local_models()
    except Exception:  # noqa: BLE001 - never fatal; the words are what matter
        log.warning("dictation.shape_text: could not reach the local AI", exc_info=True)
        return ShapeResult(text=text, notes=[_NO_LOCAL_AI])
    if not models:
        return ShapeResult(text=text, notes=[_NO_LOCAL_MODEL])
    # TODO(engine-routing batch): Rust picked the SPECIFIC local model here via
    # `model_setting` (the room's configured one) / `runs_on_this_mac` (which
    # refuses a `:cloud` tag) / `best_local_default` (stt_cmds.rs:789-798).
    # None of that is ported yet, so this naively takes whichever model is
    # listed first — correct only by accident once more than one is installed.
    # Replace this ONE line, not the surrounding pass logic, when that lands.
    return models[0]


async def _translation_or_fallback(
    model: str, text: str, translate: bool, generate: GenerateFn
) -> ShapeResult:
    """Run the optional translate pass, preserving its exact failure contract."""
    if not translate:
        return ShapeResult(text=text)
    try:
        translated = await run_dict_pass(model, [DICT_TRANSLATE], text, generate)
    except Exception:  # noqa: BLE001 - never fatal; see shape_text's docstring
        log.warning("dictation.shape_text: the translate pass failed", exc_info=True)
        return ShapeResult(text=text, notes=[_TRANSLATE_FAILED])
    return ShapeResult(text=translated.strip() or text)


async def _shape_or_fallback(
    model: str, shape_steps: list[str], text: str, generate: GenerateFn
) -> ShapeResult:
    """Run cleanup and mode shaping, retaining the best text on fallback."""
    if not shape_steps:
        return ShapeResult(text=text)
    try:
        shaped = await run_dict_pass(model, shape_steps, text, generate)
    except Exception:  # noqa: BLE001 - never fatal; see shape_text's docstring
        log.warning("dictation.shape_text: the shaping pass failed", exc_info=True)
        return ShapeResult(text=text, notes=[_SHAPE_FAILED])
    return ShapeResult(text=shaped.strip() or text)


async def shape_text(
    text: str, translate: bool, mode: str, hooks: LocalModelHooks
) -> ShapeResult:
    """Post-process dictated text on a LOCAL model: an optional
    translate-to-English pass plus an optional intent rewrite, as TWO separate
    model calls (ADD-22: one instruction at a time is far more reliable for a
    small model than translate+cleanup+shape crammed into one prompt).

    ``mode="off"`` with ``translate=False`` returns the text unchanged, with no
    model call at all. Never raises; see the module docstring §3 for the
    stage-by-stage fallback table this implements.
    """
    # Build the shaping steps WITHOUT translate — translate is its own pass.
    shape_steps = _shape_steps(mode)
    if _shaping_is_disabled(translate, shape_steps):
        return ShapeResult(text=text)

    model = await _model_or_fallback(hooks, text)
    if isinstance(model, ShapeResult):
        return model

    # Pass 1: translate, on its own.
    #
    # A FAILED translate STOPS here with the exact pre-translate text. Carrying
    # on to shape it would hand back a cleaned-up sentence in the language it
    # was spoken in as the answer to a translate request — the one outcome that
    # misrepresents what happened (stt_cmds.rs:801-806, where Rust propagates
    # the error precisely so its caller keeps the exact transcript AND says so).
    translated = await _translation_or_fallback(model, text, translate, hooks.generate)
    if translated.notes:
        return translated
    # An EMPTY translate keeps the prior text and carries on, silently —
    # Rust's own `if !t.is_empty()`, which does not treat it as an error.

    # Pass 2: cleanup + optional mode shaping (or the prompt optimizer).
    # Resilience (alfred): never lose the words — empty output -> prior text.
    return await _shape_or_fallback(model, shape_steps, translated.text, hooks.generate)
