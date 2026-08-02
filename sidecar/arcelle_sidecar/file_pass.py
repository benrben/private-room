"""The whole-file PASS job steps (MIGRATION Phase 2, ADD-32).

Ported from ``commands/jobs/file_pass.rs`` — the ``execute_pass_step`` map / merge
/ compose arms plus the ``model_call`` retry loop. Rust still owns everything that
touches the encrypted DB: it plans the immutable window list, loads each step's
inputs (the previous window's thread, the sibling note sections, the merged
notes), stores the returned artifact, and does the no-model ``publish`` step. This
module owns only the COMPUTE — the exact prompts, the structured model call, and
the parse/clamp of the model's output into the artifact the Rust side persists.

Artifact contract (identical for both steps, the shape Rust's ``PassArtifact``
stores): ``{"result": str, "thread": str, "skipped": bool}``.

The step semantics are reproduced byte-for-byte from Rust:

* map — one window's output (merge-mode dense notes, or stitch-mode transformed
  text) plus a short running thread. In merge mode a failed window falls back to
  its raw text (still covered, ``skipped=false``); in stitch mode there is no
  honest stand-in for a transform, so the window is marked ``skipped=true`` and
  the *incoming* thread flows on so the next window still reads in context.
* section — write ONE ordered section of the final HTML deliverable from a small
  group of consecutive windows' notes; a double failure publishes that group's
  raw notes (``skipped=false`` — nothing already read is lost).

Privacy (SPEC §6): the model I/O goes through :func:`llm.generate` (loopback-only
Ollama, tracing stripped at import) exactly like every other sidecar LLM call.
"""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from . import llm
from .budget import truncate_bytes
from .config import KEEP_ALIVE_WARM, ProviderConfig
from .messages import Message, system_message, user_message
from .model_text import prime_schema, recover_json

# --- caps (file_pass.rs constants) -----------------------------------------
#: Per-window notes cap (merge mode). This is the FIRST and harshest fold — a
#: ~16 KB window down to this many bytes — and anything dropped HERE can never be
#: recovered downstream, so it is sized for retention over brevity.
PASS_NOTES_MAX: int = 4_000
#: The running thread handed from window to window.
PASS_THREAD_MAX: int = 1_200
#: One composed SECTION. Each section covers a small group of consecutive windows
#: (Rust plans the grouping — file_pass.rs ``PASS_SECTION_WINDOWS``), so it never
#: approaches whole-document size; the final document is the ordered
#: concatenation of the sections and may be far larger than this.
PASS_SECTION_MAX: int = 40_000

#: file_pass.rs ``model_call`` passes ``Some(0.2)`` — steady, low-variance reads.
PASS_TEMPERATURE: float = 0.2

#: Output-token ceilings (``num_predict``). Not a quality limit — both sit far
#: above real output (map notes ≈1.4k tokens, a section ≈0.4–2k) — but a
#: runaway guard. Without one a degenerate repetition loop generates until it
#: fills the whole window, which a multi-doc sweep hit on ~4 % of section
#: composes and which now costs MORE than it used to: the window is
#: payload-fitted and can reach 128k, so an uncapped 4B could grind for hours
#: on one window while holding `Lane::LocalLlm`'s single slot.
#:
#: The map ceiling is deliberately generous — well past `PASS_NOTES_MAX`, which
#: is the byte clamp that actually shapes the artifact — so it can only ever
#: stop a loop, never truncate a real read.
PASS_MAP_PREDICT: int = 4_096
PASS_DOC_PREDICT: int = 8_192


# --- exact prompts (file_pass.rs execute_pass_step) ------------------------
MAP_SYSTEM_STITCH: str = (
    "You transform one long file part by part, in order, following the instruction "
    "exactly. Output ONLY the transformed text for the given part — the parts are "
    "joined afterward, so no headers, no preamble, no commentary. Also keep a short "
    "thread of notes (names, terminology, tone decisions) so the next part stays "
    "consistent."
)
MAP_SYSTEM_MERGE: str = (
    "You are reading one long file part by part, in order, so that together your "
    "notes cover the ENTIRE file. For the given part, write dense factual notes — "
    "every important fact, number, name, date, decision, obligation or plot point — "
    "serving the stated goal. Also keep a short running thread that connects the "
    "parts (where the text is going, open questions, running totals)."
)
SECTION_SYSTEM: str = (
    "You write ONE ordered section of the final document for a whole-file reading job. "
    "The sections are concatenated in order afterward, so cover exactly the material in "
    "front of you — no overall preamble or conclusion."
)

#: model_call returns None (→ skipped / fallback) after a double failure. A unique
#: sentinel keeps that distinct from a model that legitimately returned JSON
#: ``null`` (which Rust treats as ``Some(Null)`` — parsed, empty, not skipped).
_SKIP = object()


# --- step helpers -----------------------------------------------------------
#
# Every cap below is a BYTE cap: Rust string lengths and caps are byte counts, so
# clamping in chars would let a Hebrew/CJK file overflow the window it fits under
# in Rust. :func:`budget.truncate_bytes` is the sidecar's one implementation of
# that cut (agent.rs ``clamp_bytes``/``floor_boundary``).


def _is_fatal(code: str) -> bool:
    """A hard engine failure parks the job for Resume (file_pass.rs ``is_fatal``)."""
    return code == "OLLAMA_DOWN" or code.startswith("MODEL_MISSING")


def _field(parsed: Any, key: str) -> str:
    """``v[key].as_str().unwrap_or_default()`` — "" unless it's a string field."""
    if isinstance(parsed, dict):
        v = parsed.get(key)
        if isinstance(v, str):
            return v
    return ""


async def _structured_call(
    model: str,
    messages: list[Message],
    schema: dict[str, Any],
    base_url: str,
    *,
    keep_alive: str,
    num_predict: int | None = PASS_DOC_PREDICT,
    privacy: dict[str, Any] | None = None,
    provider: Any | None = None,
) -> Any:
    """One structured model call with a single retry (file_pass.rs ``model_call``).

    Reproduces chat_structured (schema primed onto the last user turn, Job-tier
    ``num_ctx``, ``format`` grammar, ``recover_json`` on the reply) wrapped in
    model_call's 2-attempt loop:

    * a FATAL engine error (OLLAMA_DOWN / MODEL_MISSING) raises straight through so
      the route returns the ``{code,error}`` envelope and the Rust host parks the
      job for Resume;
    * a transient engine error OR an unparseable reply retries once, then returns
      :data:`_SKIP` (the caller's None branch);
    * otherwise the parsed JSON value (any JSON — the caller reads fields safely).
    """
    primed = prime_schema(messages, schema)
    for attempt in range(2):
        try:
            raw = await llm.generate(
                model,
                primed,
                base_url,
                temperature=PASS_TEMPERATURE,
                num_predict=num_predict,
                keep_alive=keep_alive,
                format=schema,
                privacy=privacy,
                provider=provider,
            )
        except llm.LlmError as exc:
            if _is_fatal(exc.code):
                raise
            if attempt == 0:
                continue
            return _SKIP
        try:
            return json.loads(recover_json(raw))
        except (json.JSONDecodeError, ValueError):
            if attempt == 0:
                continue
            return _SKIP
    return _SKIP


# --- the three steps --------------------------------------------------------


async def run_map(
    *,
    model: str,
    base_url: str,
    mode: str,
    file_name: str,
    instruction: str,
    part: int,
    total: int,
    start: int,
    end: int,
    text_len: int,
    thread: str,
    window_text: str,
    keep_alive: str = KEEP_ALIVE_WARM,
    privacy: dict[str, Any] | None = None,
    provider: Any | None = None,
) -> dict[str, Any]:
    """One map window: dense notes (merge) or transformed text (stitch) + a thread.

    ``thread`` is the previous window's carried thread ("" for the first part),
    loaded from the prior artifact by Rust. On a double model failure the *incoming*
    thread flows through unchanged; merge mode keeps the window's raw text as the
    reading, stitch mode marks it skipped (see the fallback branch below).
    """
    stitch = mode == "stitch"
    system = MAP_SYSTEM_STITCH if stitch else MAP_SYSTEM_MERGE
    thread_block = thread if thread else "(this is the first part)"
    user = (
        f"File: {file_name}\nGoal: {instruction}\n"
        f"This is part {part + 1} of {total} — characters {start}-{end} of {text_len}.\n\n"
        f"Thread from the earlier parts:\n{thread_block}\n\n"
        f"Text of THIS part:\n{window_text}"
    )
    if stitch:
        result_key = "result"
        # window_text.len() is BYTES in Rust — size the cap on the byte length.
        result_cap = max(len(window_text.encode("utf-8")) * 3, PASS_NOTES_MAX)
    else:
        result_key = "notes"
        result_cap = PASS_NOTES_MAX
    schema = {
        "type": "object",
        "properties": {result_key: {"type": "string"}, "thread": {"type": "string"}},
        "required": [result_key, "thread"],
    }
    messages = [system_message(system), user_message(user)]
    parsed = await _structured_call(
        model,
        messages,
        schema,
        base_url,
        keep_alive=keep_alive,
        num_predict=PASS_MAP_PREDICT,
        privacy=privacy,
        provider=provider,
    )
    result = "" if parsed is _SKIP else _field(parsed, result_key).strip()
    if not result:
        # The structured reply was a double-failure (_SKIP) or a valid-but-EMPTY
        # reply. A small model often can't wrap CODE / CSV / tabular content — full
        # of braces and quotes — in the forced JSON, so it returns nothing usable
        # even for a window that clearly HAS text.
        if stitch:
            # STITCH TRANSFORMS the text (translate, rewrite), so the source is
            # not a stand-in for its own transform: pasting it back would publish
            # a chunk of the ORIGINAL language into the translation, unmarked,
            # while the footer still claimed complete coverage. Mark the window
            # skipped — Rust then writes "[part N could not be processed]" where
            # it belongs and counts it in the coverage line.
            return {"result": "", "thread": thread, "skipped": True}
        # MERGE only READS the window into notes, so the raw text IS a faithful
        # (if unsummarized) reading of it. Rather than drop the window — which
        # reads to the user as "1 of N parts could not be processed" for a file
        # we can plainly see — keep it so the content is still COVERED: the
        # section step composes from it, or failing that publishes it raw. Only a
        # genuinely empty window is marked skipped.
        fallback = truncate_bytes(window_text.strip(), result_cap)
        if fallback:
            return {"result": fallback, "thread": thread, "skipped": False}
        return {"result": "", "thread": thread, "skipped": True}
    return {
        "result": truncate_bytes(result, result_cap),
        "thread": truncate_bytes(_field(parsed, "thread").strip(), PASS_THREAD_MAX),
        "skipped": False,
    }


async def run_section(
    *,
    model: str,
    base_url: str,
    instruction: str,
    file_name: str,
    section: int,
    total: int,
    sections: list[str],
    missing: int = 0,
    keep_alive: str = KEEP_ALIVE_WARM,
    privacy: dict[str, Any] | None = None,
    provider: Any | None = None,
) -> dict[str, Any]:
    """Compose ONE ordered section of the deliverable from a small group of
    consecutive windows' notes (the sectioned path).

    ``sections`` are the group's non-skipped map notes, in order (Rust-gathered);
    ``missing`` counts the windows in the group that were unreadable. Publishing
    concatenates every section's HTML in order, so no one model call must hold the
    whole file's notes: a call that only ever sees a handful of windows stays well
    inside a small model's reach, which is what keeps big files complete instead of
    collapsing in a single global fold. Empty ``sections`` → a skipped artifact
    with no model call. A double
    failure OR an empty reply falls back to the group's raw notes so the reading
    is never lost.
    """
    if not sections:
        return {"result": "", "thread": "", "skipped": True}
    notes = "\n\n".join(sections)
    absent = f"({missing} note-block(s) in this section were unreadable and are absent.)\n\n" if missing else ""
    user = (
        f"Goal: {instruction}\n\n"
        f"These are dense, in-order notes covering section {section + 1} of {total} of "
        f"the file {file_name}:\n{notes}\n\n"
        f"{absent}"
        "Write THIS section of the final document as clean HTML body markup. Begin "
        "every chapter or major topic that starts within these notes with an <h2> "
        'heading that names it (e.g. "<h2>Chapter 3: Functions</h2>") — always a '
        "heading, never a bare paragraph; use <h3> for sub-parts, <p> for prose, and "
        "<ul>/<table> where useful — no <html> or <head>. Cover every chapter or topic "
        "that appears in these notes, in the order they appear, following the goal; do "
        "not reorder, do not merge distinct chapters together, skip none, and use ONLY "
        "what the notes contain — never invent facts."
    )
    schema = {
        "type": "object",
        "properties": {"html": {"type": "string"}},
        "required": ["html"],
    }
    messages = [system_message(SECTION_SYSTEM), user_message(user)]
    parsed = await _structured_call(
        model, messages, schema, base_url, keep_alive=keep_alive,
        privacy=privacy, provider=provider
    )
    html = "" if parsed is _SKIP else _field(parsed, "html").strip()
    if not html:
        # Composing this section failed or came back empty: keep the reading by
        # publishing the group's raw notes (clamped) rather than dropping it.
        return {"result": truncate_bytes(notes, PASS_SECTION_MAX), "thread": "", "skipped": False}
    return {"result": truncate_bytes(html, PASS_SECTION_MAX), "thread": "", "skipped": False}


# --- request bodies (the whole-file PASS step endpoints) --------------------
#
# Rust owns the DB and the immutable plan: it slices each window out of the
# smart-filtered text and loads each step's inputs (the prior window's thread,
# the sibling note sections, the merged notes) from the jobs artifacts, then
# posts them here. These bodies carry ONLY the gathered text + plan facts; the
# ``base_url`` is ollama::resolved_base_url() like the gateway bodies.


class FilePassMapRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    model: str
    base_url: str = "http://127.0.0.1:11434"
    #: "merge" (dense notes → folded → composed) or "stitch" (transform in place).
    mode: str = "merge"
    file_name: str = ""
    instruction: str = ""
    #: 0-based window index; ``total`` is the window count (for the "part i of n").
    part: int = 0
    total: int = 1
    #: byte span of this window into the filtered text (shown in the prompt).
    start: int = 0
    end: int = 0
    text_len: int = 0
    #: the previous window's carried thread ("" for the first part), loaded by Rust.
    thread: str = ""
    window_text: str = ""
    keep_alive: str = KEEP_ALIVE_WARM
    #: PRIV-1: room privacy policy payload (config.RunRequest docstring).
    privacy: dict[str, Any] | None = None
    provider: ProviderConfig | None = None


class FilePassSectionRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    model: str
    base_url: str = "http://127.0.0.1:11434"
    instruction: str = ""
    file_name: str = ""
    #: 0-based section index and the total section count (for "section i of n").
    section: int = 0
    total: int = 1
    #: this section's group of consecutive windows' notes, in order (Rust-gathered).
    sections: list[str] = Field(default_factory=list)
    #: count of the group's windows that were unreadable/absent.
    missing: int = 0
    keep_alive: str = KEEP_ALIVE_WARM
    #: PRIV-1: room privacy policy payload (config.RunRequest docstring).
    privacy: dict[str, Any] | None = None
    provider: ProviderConfig | None = None


__all__ = [
    "PASS_NOTES_MAX",
    "PASS_THREAD_MAX",
    "PASS_SECTION_MAX",
    "PASS_TEMPERATURE",
    "PASS_MAP_PREDICT",
    "PASS_DOC_PREDICT",
    "MAP_SYSTEM_STITCH",
    "MAP_SYSTEM_MERGE",
    "SECTION_SYSTEM",
    "run_map",
    "run_section",
    "FilePassMapRequest",
    "FilePassSectionRequest",
]
