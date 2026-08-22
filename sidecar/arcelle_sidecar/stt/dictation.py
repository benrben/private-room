"""Streaming dictation — the Python port of ``src-tauri/src/commands/stt_cmds
.rs`` lines ~460-887: the capture half (``DictState``/``DictSession``/
``DictMsg``, ``dict_start``/``dict_push_audio``/``dict_stop``/``dict_cancel``/
``dict_worker``, ``DICT_PARTIAL_STEP_SECS``/``dict_partial_step``,
``DICT_MAX_SECS``, ``DICT_STOP_BASE``/``DICT_STOP_PER_AUDIO_SEC``/
``dict_stop_timeout``) and the shaping half (``DICT_TRANSLATE``/
``DICT_REWRITE``/``DICT_TAIL``/``DICT_PROMPT_OPTIMIZER``/
``dict_mode_guidance``/``dict_pass_text``/``shape_text``/``run_dict_pass``).
Migration plan: ``pm-request/electron-python-migration-plan-2026-08-22.md`` §2
("Transport: one WebSocket per audio session") and §11 item 5.

Deliberately NOT the recording engine (``rec/``): dictation must never create a
Recording file, touch diarization, or take the room lock. The composer, the
journal, the file mic and the memory mic all share ONE physical microphone, so
there is one session at a time and the final text is one whole-utterance decode
at Stop — identical quality to the old batch path.

=============================================================================
1. WS /dict/session — all four Rust commands, on one socket
=============================================================================

Rust split this across four ``#[tauri::command]``s plus a background OS
thread, because Tauri IPC has no notion of a client holding a socket open.
Once the transport IS a socket all four collapse into the socket's own
lifecycle — the same collapse ``rec/session_ws.py``'s ``/rec/session`` made for
the recording engine, one lane simpler (a single producer, one buffer, no
lanes/diarization/spool/persist):

- **dict_start** = opening the WebSocket. ``?modelPath=`` carries the whisper
  weights, ALREADY RESOLVED by Electron (bundled vs. downloaded — Rust's
  ``stt_effective_model``), exactly the division of labour
  ``StartSessionRequest.model_path`` uses in ``rec/session_ws.py``.

  A missing or nonexistent ``modelPath`` closes the handshake with **4404**
  before ``accept()``, answering Rust's ``Err("STT_MODEL_MISSING")``. THIS
  CHECK IS LOAD-BEARING, not a courtesy: ``pywhispercpp`` does not raise on a
  model file that is not there. Constructing ``Model()`` logs "failed to open
  '(null)'" and hands back a live object, and the first real decode against it
  **aborts the process** — measured on this tree, the interpreter dies inside
  the native library with no Python traceback and no chance to answer. A
  dictation started against a model the user has since deleted would therefore
  take down the whole sidecar: every recording, every chat, mid-flight. Rust
  never faced this because ``stt_effective_model`` returns ``Option`` and
  ``dict_start`` refuses on ``None``; this route is that refusal.

- **dict_push_audio** = a binary frame: ``u32 rate (LE), u32 n (LE)`` then
  exactly ``n`` little-endian f32 samples. Rust's own wire shape for that
  command (``rate: u32, data_b64: String``) minus the base64 (a WS frame is
  already binary), and ``rec/session_ws.py``'s 12-byte header minus the
  ``lane``/``pad``/``seq`` fields dictation has no use for — one producer, so
  there is nothing to tell apart. A malformed frame (short read, ``n`` not
  matching the bytes that follow) is logged and DROPPED, never fatal: the same
  discipline ``rec/session_ws.py``'s ``_decode_audio_frame`` documents.

- **dict_stop** = a ``{"type":"stop"}`` text frame. Answered on the SAME socket
  with ``{"type":"final","ok":true,"text":...}`` (or ``{"ok":false,"error":
  ...}``), then the socket is closed — there is nothing further to say once
  the one whole-utterance decode is in. An empty transcript is a SUCCESS, not
  a failure: Rust's ``dict_stop`` may return ``Ok("")`` and its caller shows
  "No speech detected".

- **dict_cancel** = a ``{"type":"cancel"}`` text frame, or simply
  disconnecting. Either abandons the session with no final decode — Rust's
  ``dict_cancel`` semantics, reached by cancelling the worker task instead of
  by dropping an mpsc sender. The explicit frame exists because "the client
  went away" and "the client changed its mind" are worth distinguishing at the
  call site even though this module treats them identically.

- **dict_worker** = :func:`_dict_worker`, one ``asyncio.Task`` per connection,
  reading one ``asyncio.Queue`` the route's receive loop fills. Every rule
  Rust's worker spells out survives:

  * :func:`dict_partial_step` — the growing-budget repaint cadence, ported
    verbatim (see its own docstring).
  * :data:`DICT_MAX_SECS` — the leak guard (:class:`_NativeBuffer`).
  * THE DRAIN-EVERYTHING-QUEUED-BEFORE-DECIDING RULE (stt_cmds.rs:644-661):
    one blocking ``await queue.get()``, then a ``get_nowait()`` drain until the
    queue is empty or a stop is found, and only THEN the decision to repaint.
    A stop found mid-drain finalizes immediately against everything drained
    ahead of it, never against a buffer still missing samples.
  * Decodes run on ``asyncio.to_thread`` — ``stt/engine.py`` already owns the
    warm-context cache and its lock, so the only job left here is not to block
    the event loop, exactly as ``rec/engine.py`` does.
  * **One writer per socket.** ONLY the worker task ever sends: the partial
    repaints, the one ``final``, and the close. The receive loop only reads and
    enqueues. Two writers racing on one socket is the ordering bug
    ``rec/session_ws.py``'s §2 ("DELIVERY IS ORDERED") exists to prevent, and
    it also removes any way for the route handler to end up waiting on the
    worker — see the merge note at the bottom of this docstring.

=============================================================================
2. Auth, and the single-session slot
=============================================================================

``/dict/session`` implements no auth of its own: it rides
``server.TokenAuthMiddleware``'s existing ``?token=`` websocket branch,
unmodified, exactly like ``/rec/session`` (see that module's §6 for why the
check lives in one place and nowhere else).

:class:`DictSessionManager` holds the one slot, on ``app.state.dict_manager``
— per APP, never a module global, for the reason ``RecSessionManager`` isn't
one: two ``create_app()`` instances must not share a dictation.

UNLIKE ``RecSessionManager``, which REFUSES a second ``/rec/start`` with 409, a
second ``/dict/session`` **REPLACES** the first. That is ``dict_start``'s own
documented behaviour ("Replacing a stale session drops its sender; that worker
sees the disconnect and exits on its own"): the four mics share one
microphone, so a second session starting IS the first one ending, not a rival
to turn away. The superseded session's worker is cancelled (no final decode
ever runs for it — ``dict_cancel``'s contract, not ``dict_stop``'s) and its
socket is closed with 4409, rather than left to discover the replacement on
its own.

=============================================================================
3. Shaping: shape_text / run_dict_pass — no route in this batch
=============================================================================

Rust's ``shape_text`` reaches ``ollama::list_models``/``ollama::generate`` plus
three routing functions with no Python port yet: ``model_setting`` (the room's
configured model, out of the encrypted DB Electron owns), ``best_local_default``
(installed-model triage) and ``runs_on_this_mac`` (the capability/transport
check that also excludes ``:cloud``-suffixed Ollama tags — dictated words stay
on this Mac, the ONE deliberate exception to engine parity and an explicit
Settings-screen promise). None of that layer exists here yet, so rather than
invent an Ollama client that would either skip the ``:cloud`` exclusion or
invent a routing policy nobody signed off on, :func:`shape_text` takes an
injected :class:`LocalModelHooks`. Model SELECTION is stubbed to "the first
name listed" and loudly TODO'd. :func:`shape_text` and :func:`run_dict_pass`
are pure, injectable async functions; no HTTP/WS route is added for them here.

**Never lose the words.** Rust returns ``Result<String, String>`` and lets the
caller fall back to the transcript it already holds; this batch's instructions
are that shaping must never raise past its caller, so the fallback lives here
instead and the outcome is a :class:`ShapeResult` — the best text available,
plus human-readable ``notes`` for anything that fell back, so a UI can still
say "Kept the exact transcript — …" without an exception to branch on. The
STAGE SEMANTICS are Rust's, exactly:

===================== ================================================
Rust                  here
===================== ================================================
``list_models`` fails  text unchanged + Rust's own message as a note
no models installed    text unchanged + Rust's own message as a note
translate FAILS        **stop**; return the exact pre-translate text
                       + a note (Rust propagates the error and its
                       caller keeps the exact transcript "AND says
                       so" — shaping the untranslated words instead
                       would hand back a cleaned-up sentence in the
                       language it was spoken in, presented as the
                       answer to a translate request: the one outcome
                       stt_cmds.rs:801-806 exists to prevent)
translate EMPTY        keep the prior text and carry on to the shape
                       pass, silently (Rust's ``if !t.is_empty()``)
shape pass FAILS       return the best text so far + a note
shape pass EMPTY       return the prior text (alfred's resilience rule)
===================== ================================================

=============================================================================
4. DICT_STOP_BASE / DICT_STOP_PER_AUDIO_SEC are the CALLER's
=============================================================================

Ported as constants plus the pure :func:`dict_stop_timeout`, NOT as a ceiling
this module imposes on itself. Per the migration plan §2 the scaled timeout is
"enforced by the caller — Electron main ports ``dict_stop_timeout``". This
sidecar answers ``stop`` whenever the whole-utterance decode actually finishes,
matching ``/rec/stop``'s own "no deadline of its own". A caller that gives up
early simply stops listening; the reply's failed send is swallowed.

=============================================================================
MERGE NOTE: this file merges two independent candidate implementations
=============================================================================

``stt/dictation_a.py`` and ``stt/dictation_b.py`` (both now deleted) were read
against ``stt_cmds.rs`` and against each other. Both got ``dict_partial_step``,
the leak guard, the drain-before-finalize rule and every prompt string right —
the prompts are byte-for-byte identical to the Rust literals in BOTH, and
``tests/test_dictation.py`` now re-derives them from ``stt_cmds.rs`` on every
run rather than trusting either transcription. What each got wrong, and which
piece of each survived:

- **A accepted any ``modelPath``** and only discovered a missing model at
  decode time — which, as §1 records, is a native abort that kills the whole
  sidecar. B's connect-time existence check is here (tightened to
  ``is_file()``: a directory passes ``exists()`` and aborts just the same).
- **B's ``stop`` answer was awaited by the ROUTE HANDLER**, on a future the
  worker resolved. Cancelling that worker — which is exactly what the single
  slot's REPLACE path does — leaves the future unresolved for ever and the
  handler pending for ever, holding the socket, the queue and the whole audio
  buffer. Reproduced directly against B: enqueue a ``stop``, cancel the
  worker, and the handler coroutine never completes and never sends anything.
  A's shape is here instead: the worker owns every send, so cancelling it
  leaves nothing waiting.
- **A swallowed a failed translate** and then shaped the untranslated text,
  returning it with no indication the translation never happened — the exact
  misrepresentation stt_cmds.rs:801-806 documents as already fixed once. B
  reported it in ``notes`` but still shaped on. Neither matched Rust, which
  stops. See §3's table.
- **B's ``ShapeResult`` + ``notes``** is here (A returned a bare string, so
  "no local AI installed" and "the model shaped it into exactly this" were
  indistinguishable), carrying Rust's own two verbatim message strings.
- **B's ``_NativeBuffer``** is here (A's inline closure re-concatenated its
  chunk list on every decode and could not be tested without a socket).
- **A's leak-guard end-to-end test** is here: with the cap shrunk under a
  RUNNING worker it spies on the decoder and asserts that the array reaching it
  — through the real resampler, not a stand-in — respects the shrunk cap. B's
  real-wire equivalent asserted only that the session "answered at all", which
  no cap violation would have broken.
- **B's ``assert session.ws is not None``** is gone — an ``assert`` vanishes
  under ``python -O``, the same finding ``rec/session_ws.py``'s own merge note
  records against its candidate B.
- **B's explicit ``{"type":"cancel"}`` frame** is here (A had disconnect-only).
- **A's ``DICT_STOP_PER_AUDIO_SEC`` as an ``int``** is here, matching Rust's
  ``u32``; B widened it to ``2.0``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import struct
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Protocol

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from arcelle_sidecar.media.wav import resample_to_16k
from arcelle_sidecar.messages import Message, compact_json, user_message
from arcelle_sidecar.model_text import strip_think_spans
from arcelle_sidecar.stt import engine as stt_engine

log = logging.getLogger("arcelle_sidecar.stt.dictation")


# =============================================================================
# ---- repaint cadence + the leak guard (stt_cmds.rs:499-521) ------------------
# =============================================================================

#: ~0.7 s of fresh audio between partial repaints: short enough to feel live,
#: long enough that each repaint (a whole-buffer redecode — the partial IS the
#: full text so far) outpaces the microphone on Metal. The FLOOR, not the step:
#: see :func:`dict_partial_step`.
DICT_PARTIAL_STEP_SECS: float = 0.7

#: Leak guard, not a UX limit: audio past this is dropped (10 min of speech in
#: one dictation is a stuck mic, not a user). Read as a bare module-level name
#: inside :meth:`_NativeBuffer.extend` on purpose — never captured into a local
#: at import time — so a test can ``monkeypatch.setattr`` it down and have a
#: RUNNING worker honour the new value.
DICT_MAX_SECS: int = 600


def dict_partial_step(rate: int, last_decode_secs: float) -> int:
    """How much fresh audio (in samples at ``rate``) must arrive before the
    next preview repaint.

    Each repaint re-decodes the dictation FROM THE START, so its cost grows
    with how long the person has been speaking. At a fixed 0.7 s step a
    minutes-long dictation spends every spare cycle redecoding, the Mac runs
    hot, and the preview falls further and further behind anyway. Requiring at
    least as much new audio as the last decode consumed holds the decoder to
    roughly half the machine: the preview updates less often as the dictation
    grows, but it stops losing ground. The final text is unaffected — that is
    one whole-utterance decode at Stop. (stt_cmds.rs ``dict_partial_step``.)
    """
    base = int(rate * DICT_PARTIAL_STEP_SECS)
    return max(base, int(rate * last_decode_secs))


class _NativeBuffer:
    """The worker's growing audio buffer, at the sender's native rate — Rust's
    ``Vec<f32> native`` plus its leak guard (``if native.len() < rate as usize
    * DICT_MAX_SECS { native.extend(samples) }``, stt_cmds.rs:641).

    The gate is a boolean "is the buffer ALREADY at the cap?" asked BEFORE the
    message, never a trim: a message that straddles the cap is accepted whole
    (so the buffer may end up one chunk over), and every message after that is
    dropped whole. Deliberately identical to the Rust source, overshoot
    included.

    Chunks are concatenated lazily and collapsed in place on :meth:`array`, so
    an incoming message never pays for a full-buffer copy — only a decode does,
    exactly as expensive as Rust's own ``&native`` slice read.
    """

    def __init__(self) -> None:
        self._chunks: list[np.ndarray] = []
        self._len = 0

    def __len__(self) -> int:
        return self._len

    def extend(self, samples: np.ndarray, rate: int) -> None:
        if self._len < rate * DICT_MAX_SECS:
            self._chunks.append(np.asarray(samples, dtype=np.float32))
            self._len += len(samples)

    def array(self) -> np.ndarray:
        if not self._chunks:
            return np.zeros(0, dtype=np.float32)
        if len(self._chunks) > 1:
            self._chunks = [np.concatenate(self._chunks)]
        return self._chunks[0]


# =============================================================================
# ---- Stop's wait — the CALLER's, not ours (stt_cmds.rs:566-581) --------------
# =============================================================================

#: The wait a caller should allow the final decode before concluding it is
#: wedged. Covers a short dictation merely queued behind a busy STT context.
DICT_STOP_BASE: float = 120.0
#: Seconds of grace per second of audio — a decode slower than this is wedged,
#: not working. Rust's ``u32``; an int here for the same reason.
DICT_STOP_PER_AUDIO_SEC: int = 2


def dict_stop_timeout(captured_secs: float) -> float:
    """The wait a CALLER (Electron main) should allow ``stop``'s answer, given
    how many seconds of audio it pushed.

    The final decode is ONE whole-utterance pass over everything spoken, so its
    cost grows with the dictation while a flat ceiling does not: at 120 s flat,
    stopping a several-minute dictation threw away a transcript that was still
    being produced. Exported pure for the caller to reuse verbatim; see the
    module docstring §4 for why this module does not apply it to itself.
    """
    return DICT_STOP_BASE + captured_secs * DICT_STOP_PER_AUDIO_SEC


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
    shape_steps: list[str] = []
    guidance = dict_mode_guidance(mode)
    if guidance is not None:
        instruction, replaces_cleanup = guidance
        if replaces_cleanup:
            shape_steps.append(instruction)
        elif instruction == "":
            shape_steps.append(DICT_REWRITE)
        else:
            shape_steps.append(DICT_REWRITE)
            shape_steps.append(instruction)
    if not translate and not shape_steps:
        return ShapeResult(text=text)

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
    model = models[0]

    # Pass 1: translate, on its own.
    #
    # A FAILED translate STOPS here with the exact pre-translate text. Carrying
    # on to shape it would hand back a cleaned-up sentence in the language it
    # was spoken in as the answer to a translate request — the one outcome that
    # misrepresents what happened (stt_cmds.rs:801-806, where Rust propagates
    # the error precisely so its caller keeps the exact transcript AND says so).
    if translate:
        try:
            translated = await run_dict_pass(model, [DICT_TRANSLATE], text, hooks.generate)
        except Exception:  # noqa: BLE001 - never fatal; see this function's docstring
            log.warning("dictation.shape_text: the translate pass failed", exc_info=True)
            return ShapeResult(text=text, notes=[_TRANSLATE_FAILED])
        translated = translated.strip()
        if translated:
            text = translated
        # An EMPTY translate keeps the prior text and carries on, silently —
        # Rust's own `if !t.is_empty()`, which does not treat it as an error.

    # Pass 2: cleanup + optional mode shaping (or the prompt optimizer).
    if not shape_steps:
        return ShapeResult(text=text)
    try:
        shaped = await run_dict_pass(model, shape_steps, text, hooks.generate)
    except Exception:  # noqa: BLE001 - never fatal; see this function's docstring
        log.warning("dictation.shape_text: the shaping pass failed", exc_info=True)
        return ShapeResult(text=text, notes=[_SHAPE_FAILED])
    shaped = shaped.strip()
    # Resilience (alfred): never lose the words — empty output -> prior text.
    return ShapeResult(text=shaped if shaped else text)


# =============================================================================
# ---- the /dict/session frame protocol ----------------------------------------
# =============================================================================

#: rate, n — 8 bytes, little-endian. See the module docstring §1.
_AUDIO_HEADER_STRUCT = struct.Struct("<II")


@dataclass
class _MsgAudio:
    rate: int
    samples: np.ndarray


class _MsgStop:
    """Sentinel. Unlike Rust's ``DictMsg::Stop { done: Sender<…> }`` it carries
    no reply channel: the worker answers over the websocket itself, so nothing
    outside the worker is ever left waiting on it."""


def _decode_audio_frame(data: bytes) -> tuple[int, np.ndarray] | None:
    """Parse one binary ``/dict/session`` frame. ``None`` for anything
    malformed; never raises."""
    if len(data) < _AUDIO_HEADER_STRUCT.size:
        return None
    rate, n = _AUDIO_HEADER_STRUCT.unpack_from(data, 0)
    if len(data) != _AUDIO_HEADER_STRUCT.size + n * 4:
        return None
    samples = np.frombuffer(data, dtype="<f4", count=n, offset=_AUDIO_HEADER_STRUCT.size)
    return int(rate), samples.astype(np.float32, copy=True)


def _handle_audio_frame(queue: "asyncio.Queue", data: bytes) -> None:
    try:
        decoded = _decode_audio_frame(data)
    except Exception:  # noqa: BLE001 - a bad frame must never kill the socket
        log.warning("dict/session: could not parse a binary audio frame", exc_info=True)
        return
    if decoded is None:
        log.warning("dict/session: dropped a malformed binary audio frame (%d bytes)", len(data))
        return
    rate, samples = decoded
    queue.put_nowait(_MsgAudio(rate=rate, samples=samples))


def _handle_control_text(queue: "asyncio.Queue", text: str) -> bool:
    """Apply one control text frame. Returns True when the connection should
    end NOW without a final decode (``cancel``).

    ``stop`` deliberately returns False: the worker owns the answer and the
    close, and ending the receive loop here would run the route's teardown —
    cancelling the worker — before it could finalize.
    """
    try:
        parsed = json.loads(text)
    except Exception:  # noqa: BLE001 - a bad control frame must never kill the socket
        log.warning("dict/session: dropped a malformed control text frame")
        return False
    if not isinstance(parsed, dict):
        return False
    msg_type = parsed.get("type")
    if msg_type == "stop":
        queue.put_nowait(_MsgStop())
        return False
    if msg_type == "cancel":
        return True
    log.debug("dict/session: ignoring unknown control message type %r", msg_type)
    return False


async def _send_json(websocket: WebSocket, payload: dict) -> None:
    """Best-effort: a send that fails (the caller already gave up and went
    away) is never this module's own error."""
    with contextlib.suppress(Exception):
        await websocket.send_text(compact_json(payload))


async def _dict_worker(
    websocket: WebSocket, model_path: str, queue: "asyncio.Queue[_MsgAudio | _MsgStop]"
) -> None:
    """Port of ``dict_worker`` (stt_cmds.rs:619-686). One task per connection,
    owning all of its state locally exactly as Rust's worker owns its stack,
    and the ONLY thing that ever writes to this socket."""
    buffer = _NativeBuffer()
    rate = 16000
    decoded_len = 0
    last_text = ""
    last_decode_secs = 0.0

    async def finalize() -> None:
        """The one whole-utterance decode at Stop. An EMPTY transcript is a
        success (Rust's ``Ok("")`` — the caller shows "No speech detected");
        only a decode that actually failed is reported as ``ok: false``.

        The RESAMPLE is inside the guard, not before it. Rust's is infallible
        (``Vec<f32>`` in, ``Vec<f32>`` out); this one allocates several arrays
        proportional to the whole buffer — ten minutes of 48 kHz audio is
        hundreds of megabytes of numpy temporaries — so it can raise where
        Rust's cannot. Raising here rather than answering kills the worker with
        NOTHING sent, and the caller — the only side holding a deadline at all
        (see the module docstring §4) — sits out that whole scaled wait before
        it can even say the dictation was lost. Every way this decode can fail
        is a ``final``.
        """
        try:
            pcm = resample_to_16k(buffer.array(), rate)
            text = await asyncio.to_thread(stt_engine.transcribe, model_path, pcm, False)
        except Exception as exc:  # noqa: BLE001 - reported over the wire, never raised
            log.warning("dict/session: the final decode failed", exc_info=True)
            payload = {"type": "final", "ok": False, "error": str(exc)}
        else:
            payload = {"type": "final", "ok": True, "text": text}
        await _send_json(websocket, payload)
        with contextlib.suppress(Exception):
            await websocket.close()

    while True:
        msg = await queue.get()
        if isinstance(msg, _MsgStop):
            await finalize()
            return
        rate = msg.rate
        buffer.extend(msg.samples, rate)

        # Drain everything ALREADY queued before deciding to decode — a partial
        # that took longer than the mic's push cadence must not make the loop
        # fall ever further behind it (stt_cmds.rs:644-646). A stop found in
        # here finalizes against everything drained ahead of it, which is what
        # secures the ordering contract: the client awaits its last push before
        # sending stop, one socket delivers in order, so every sample sent
        # before the stop is already in this queue when the stop is read.
        stop_now = False
        while True:
            try:
                nxt = queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if isinstance(nxt, _MsgStop):
                stop_now = True
                break
            rate = nxt.rate
            buffer.extend(nxt.samples, rate)
        if stop_now:
            await finalize()
            return

        step = dict_partial_step(rate, last_decode_secs)
        if len(buffer) - decoded_len >= step:
            decoded_len = len(buffer)
            began = time.monotonic()
            decoded: str | None
            # The resample is INSIDE the guard for the reason `finalize` spells
            # out — it can raise where Rust's cannot, and a repaint that raised
            # would kill the worker, so the `stop` behind it would never be read
            # and the whole dictation would be lost to a cosmetic failure. It is
            # therefore also inside the measured cost: preparing the decoder's
            # input is part of what a repaint over the whole buffer costs, and
            # the budget exists to charge a repaint for what it really took.
            try:
                pcm = resample_to_16k(buffer.array(), rate)
                decoded = await asyncio.to_thread(
                    stt_engine.transcribe, model_path, pcm, False
                )
            except Exception:  # noqa: BLE001 - partial failures are cosmetic; the
                # final decode at Stop is the one that must not lose words.
                log.warning("dict/session: a partial decode failed", exc_info=True)
                decoded = None
            # Timed whether or not it succeeded: a decode that blew up after
            # 30 s still cost 30 s, and the next step must reflect that.
            last_decode_secs = time.monotonic() - began
            if decoded is not None and decoded != last_text:
                last_text = decoded
                await _send_json(websocket, {"type": "partial", "text": decoded})


# =============================================================================
# ---- the single-session slot + route registration ----------------------------
# =============================================================================


@dataclass
class LiveDictSession:
    """One live dictation — Rust's ``DictSession``, minus the ``captured_ms``
    counter, which existed only so ``dict_stop`` could size its own wait (see
    the module docstring §4: that wait is now the caller's)."""

    websocket: WebSocket
    queue: "asyncio.Queue[_MsgAudio | _MsgStop]"
    worker: "asyncio.Task[None]"

    async def stop_worker(self) -> None:
        """Cancel the worker and wait for it to be gone. Awaiting is safe even
        mid-decode: cancelling a task parked on ``asyncio.to_thread`` returns
        at once (the orphaned thread finishes into nobody's hands), so this
        cannot block on a whole-utterance decode."""
        self.worker.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await self.worker

    async def supersede(self) -> None:
        """A second ``/dict/session`` replaced this one. NO final decode runs
        (``dict_cancel``'s contract, not ``dict_stop``'s): whoever was replaced
        hears nothing back, exactly like the old Tauri session whose sender was
        simply dropped — except the socket is closed rather than left to work
        it out."""
        await self.stop_worker()
        with contextlib.suppress(Exception):
            await self.websocket.close(code=4409)


class DictSessionManager:
    """The single-live-dictation slot — Rust's ``DictState``. Per APP
    (``app.state.dict_manager``), never a module global; see the module
    docstring §2 for that and for why a second session REPLACES rather than
    being refused."""

    def __init__(self) -> None:
        self.current: LiveDictSession | None = None

    async def replace(self, session: LiveDictSession) -> None:
        old, self.current = self.current, session
        if old is not None:
            await old.supersede()

    def clear(self, session: LiveDictSession) -> None:
        """Free the slot, but only if it still holds THIS session — a session
        that was already superseded must not clear its replacement's slot."""
        if self.current is session:
            self.current = None


def register_dict_routes(app: FastAPI) -> DictSessionManager:
    """Mount the dictation WebSocket surface onto the sidecar's existing
    FastAPI app. Called once from ``server.create_app``.

    Auth is NOT re-implemented here: ``/dict/session`` rides
    ``TokenAuthMiddleware``'s ``?token=`` websocket branch, exactly like
    ``/rec/session`` (see the module docstring §2).

    Returns the :class:`DictSessionManager` — also stashed on
    ``app.state.dict_manager`` — so a caller (chiefly a test) can see the live
    session without a second, parallel way to reach it.
    """
    manager = DictSessionManager()
    app.state.dict_manager = manager

    @app.websocket("/dict/session")
    async def dict_session_ws(websocket: WebSocket) -> None:
        model_path = websocket.query_params.get("modelPath") or ""
        # Rust's `STT_MODEL_MISSING`. A rejected WS handshake has no JSON body
        # to carry that in, so the close code is the whole signal — and this
        # refusal is what keeps a decode against a model that is not there from
        # aborting the process (see the module docstring §1).
        if not model_path or not Path(model_path).is_file():
            await websocket.close(code=4404, reason="STT_MODEL_MISSING")
            return
        await websocket.accept()
        queue: "asyncio.Queue[_MsgAudio | _MsgStop]" = asyncio.Queue()
        worker = asyncio.create_task(_dict_worker(websocket, model_path, queue))
        session = LiveDictSession(websocket=websocket, queue=queue, worker=worker)
        await manager.replace(session)
        try:
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                data = message.get("bytes")
                if data is not None:
                    _handle_audio_frame(queue, data)
                    continue
                text = message.get("text")
                if text is not None and _handle_control_text(queue, text):
                    break  # `cancel`: abandon with no final decode
        except WebSocketDisconnect:
            pass
        finally:
            manager.clear(session)
            await session.stop_worker()
            # The session is over however we got here, so leave no socket
            # dangling for a client to keep pushing audio into. Both other
            # exits already closed it — the worker after `stop`, the client
            # itself on a disconnect — and closing twice is a no-op.
            with contextlib.suppress(Exception):
                await websocket.close()

    return manager


__all__ = [
    "DICT_MAX_SECS",
    "DICT_PARTIAL_STEP_SECS",
    "DICT_PROMPT_OPTIMIZER",
    "DICT_REWRITE",
    "DICT_STOP_BASE",
    "DICT_STOP_PER_AUDIO_SEC",
    "DICT_TAIL",
    "DICT_TRANSLATE",
    "DictSessionManager",
    "LiveDictSession",
    "LocalModelHooks",
    "ShapeResult",
    "dict_mode_guidance",
    "dict_partial_step",
    "dict_pass_text",
    "dict_stop_timeout",
    "register_dict_routes",
    "run_dict_pass",
    "shape_text",
]
