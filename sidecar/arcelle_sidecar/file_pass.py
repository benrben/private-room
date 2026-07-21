"""The whole-file PASS job steps (MIGRATION Phase 2, ADD-32).

Ported from ``commands/jobs/file_pass.rs`` — the ``execute_pass_step`` map / merge
/ compose arms plus the ``model_call`` retry loop. Rust still owns everything that
touches the encrypted DB: it plans the immutable window list, loads each step's
inputs (the previous window's thread, the sibling note sections, the merged
notes), stores the returned artifact, and does the no-model ``publish`` step. This
module owns only the COMPUTE — the exact prompts, the structured model call, and
the parse/clamp of the model's output into the artifact the Rust side persists.

Artifact contract (identical for all three steps, the shape Rust's ``PassArtifact``
stores): ``{"result": str, "thread": str, "skipped": bool}``.

The step semantics are reproduced byte-for-byte from Rust:

* map — one window's output (merge-mode dense notes, or stitch-mode transformed
  text) plus a short running thread. A double model failure yields the *incoming*
  thread unchanged and ``skipped=true`` so the next window still reads in context.
* merge — fold sibling note sections into one; a double failure falls back to the
  verbatim concatenation (``skipped=false`` — nothing already read is lost).
* compose — write the final HTML deliverable from the merged notes; a double
  failure publishes the raw notes (``skipped=false``).

Privacy (SPEC §6): the model I/O goes through :func:`llm.generate` (loopback-only
Ollama, tracing stripped at import) exactly like every other sidecar LLM call.
"""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from . import llm
from .config import KEEP_ALIVE_WARM, ProviderConfig, _HIGH_RAM_BYTES, _total_ram_bytes
from .messages import Message, compact_json, system_message, user_message

# --- Job-tier num_ctx (ollama.rs:307-308 num_ctx_for(_, Job)) ---------------
#: The background-job window a whole-file PASS runs each map/merge/compose call
#: at (chat_structured with ``StructuredOpts::job()``). Job ignores has_tools —
#: it is the big window a deep read's gathered text needs so nothing truncates.
NUM_CTX_JOB_LOW: int = 65536
NUM_CTX_JOB_HIGH: int = 131072

_num_ctx_job_cache: int | None = None


def num_ctx_for_job() -> int:
    """131072 on a 32 GB+ Mac, 65536 below. Cached — RAM does not change."""
    global _num_ctx_job_cache
    if _num_ctx_job_cache is None:
        _num_ctx_job_cache = (
            NUM_CTX_JOB_HIGH if _total_ram_bytes() >= _HIGH_RAM_BYTES else NUM_CTX_JOB_LOW
        )
    return _num_ctx_job_cache

# --- caps (file_pass.rs constants) -----------------------------------------
#: Per-window notes cap (merge mode). This is the FIRST and harshest fold — a
#: ~16 KB window down to this many bytes — and anything dropped HERE can never be
#: recovered downstream, so it is sized for retention over brevity.
PASS_NOTES_MAX: int = 4_000
#: The running thread handed from window to window.
PASS_THREAD_MAX: int = 1_200
#: Merge fan-in — a merge folds up to this many sibling sections (mirrors
#: file_pass.rs ``PASS_MERGE_GROUP``); the merge ceiling is sized around it.
PASS_MERGE_GROUP: int = 6
#: Floor for a merged section — a merge never clamps below this, so tiny files
#: and any low-context tier stay at least as good as the old fixed cap.
PASS_MERGE_FLOOR: int = 8_000
#: The composed final document (single-compose legacy path).
PASS_COMPOSE_MAX: int = 120_000
#: One composed SECTION (the sectioned path — each section covers a small group of
#: windows, so it never approaches the whole-doc cap; the final document is the
#: ordered concatenation of the sections and may exceed PASS_COMPOSE_MAX).
PASS_SECTION_MAX: int = 40_000

#: file_pass.rs ``model_call`` passes ``Some(0.2)`` — steady, low-variance reads.
PASS_TEMPERATURE: float = 0.2

#: Output-token caps (num_predict). Without a cap, a degenerate repetition loop
#: generates until it fills the whole num_ctx window — ~72 min on a 4B (65,536
#: tokens ÷ ~15 tok/s), which a multi-doc sweep hit on ~4 % of section composes.
#: These caps stop a runaway in minutes while sitting well above real output
#: (map notes ≈ 1.4 K tokens; a section ≈ 0.4–2 K tokens), and the byte-clamps
#: still trim the result. Sized generously so legitimate output is never cut.
PASS_MAP_PREDICT: int = 2_048
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

#: chat_structured (ollama.rs) primes the schema onto the last user turn because
#: Ollama's ``format`` constrains the GRAMMAR but the model never sees the schema —
#: without the field names a small model fills the forced JSON with empty strings.
_SCHEMA_PRIMER: str = (
    "\n\nReply with ONLY JSON matching this schema, filling every field with real content:\n"
)

#: model_call returns None (→ skipped / fallback) after a double failure. A unique
#: sentinel keeps that distinct from a model that legitimately returned JSON
#: ``null`` (which Rust treats as ``Some(Null)`` — parsed, empty, not skipped).
_SKIP = object()


# --- byte-safe helpers (agent.rs clamp_bytes / ollama.rs recover_json) ------


def clamp_bytes(s: str, max_bytes: int) -> str:
    """Truncate to at most ``max_bytes`` UTF-8 bytes without splitting a char.

    Mirrors agent.rs ``clamp_bytes``/``floor_boundary``: Rust string lengths and
    caps are BYTE counts, so the artifact must be clamped in bytes, not chars, or
    a merge group could overflow the window a Hebrew/CJK file fits under in Rust.
    """
    raw = s.encode("utf-8")
    if len(raw) <= max_bytes:
        return s
    # errors="ignore" drops a partial trailing multibyte char — the same result
    # as floor_boundary walking back to the last char boundary <= max.
    return raw[:max_bytes].decode("utf-8", errors="ignore")


def strip_think_spans(raw: str) -> str:
    """Drop ``<think>…</think>`` reasoning spans (ollama.rs ``strip_think_spans``).

    An UNTERMINATED ``<think>`` truncates the rest — everything after it is unclosed
    reasoning, not answer.
    """
    out = raw
    while True:
        start = out.find("<think>")
        if start < 0:
            break
        rel = out.find("</think>", start)
        if rel < 0:
            out = out[:start]
            break
        out = out[:start] + out[rel + len("</think>") :]
    return out


def recover_json(text: str) -> str:
    """Recover the JSON payload from a structured response (ollama.rs ``recover_json``).

    A no-op for models that honour ``format``; for the ones that wrap the JSON in a
    ```` ```json ```` fence or a ``<think>`` preamble (notably Ollama *cloud* models
    that ignore ``format``) it drops the think span then slices from the first
    opening bracket to the last closing one.
    """
    s = strip_think_spans(text.strip()).strip()
    a = next((i for i, c in enumerate(s) if c in "{["), None)
    b = next((i for i in range(len(s) - 1, -1, -1) if s[i] in "}]"), None)
    if a is not None and b is not None and b >= a:
        return s[a : b + 1]
    return s


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


def _prime_schema(messages: list[Message], schema: dict[str, Any]) -> list[Message]:
    """Append the schema primer to the last user turn (chat_structured, ollama.rs).

    Non-mutating: returns a fresh list so a caller's messages are untouched.
    """
    out: list[Message] = [dict(m) for m in messages]  # type: ignore[misc]
    for m in reversed(out):
        if m.get("role") == "user":
            m["content"] = m.get("content", "") + _SCHEMA_PRIMER + compact_json(schema)
            break
    return out


async def _structured_call(
    model: str,
    messages: list[Message],
    schema: dict[str, Any],
    base_url: str,
    *,
    keep_alive: str,
    num_predict: int = PASS_DOC_PREDICT,
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
    primed = _prime_schema(messages, schema)
    num_ctx = num_ctx_for_job()
    for attempt in range(2):
        try:
            raw = await llm.generate(
                model,
                primed,
                base_url,
                temperature=PASS_TEMPERATURE,
                num_ctx=num_ctx,
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
    thread flows through unchanged and the window is marked skipped.
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
        # of braces and quotes — in the forced {notes, thread} JSON, so it returns
        # nothing usable even for a window that clearly HAS text. Rather than drop
        # the window (which reads to the user as "0 of N parts could not be
        # processed" for a file we can plainly see), fall back to the raw window
        # text so this content is still COVERED: the section step then composes a
        # summary from it (or, failing that, publishes it raw). Coverage stays
        # honest — only a genuinely empty window is marked skipped.
        fallback = clamp_bytes(window_text.strip(), result_cap)
        if fallback:
            return {"result": fallback, "thread": thread, "skipped": False}
        return {"result": "", "thread": thread, "skipped": True}
    return {
        "result": clamp_bytes(result, result_cap),
        "thread": clamp_bytes(_field(parsed, "thread").strip(), PASS_THREAD_MAX),
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
        return {"result": clamp_bytes(notes, PASS_SECTION_MAX), "thread": "", "skipped": False}
    return {"result": clamp_bytes(html, PASS_SECTION_MAX), "thread": "", "skipped": False}


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
    "PASS_MERGE_GROUP",
    "PASS_MERGE_FLOOR",
    "PASS_COMPOSE_MAX",
    "PASS_SECTION_MAX",
    "PASS_TEMPERATURE",
    "PASS_MAP_PREDICT",
    "PASS_DOC_PREDICT",
    "MAP_SYSTEM_STITCH",
    "MAP_SYSTEM_MERGE",
    "SECTION_SYSTEM",
    "clamp_bytes",
    "strip_think_spans",
    "recover_json",
    "run_map",
    "run_section",
    "num_ctx_for_job",
    "FilePassMapRequest",
    "FilePassSectionRequest",
]
