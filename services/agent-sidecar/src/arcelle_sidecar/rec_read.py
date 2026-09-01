"""The recording READING pass — one window of a meeting, read by the model.

The compute half of ``commands/jobs/rec_read.rs``, split the same way
:mod:`file_pass` is: Rust owns the encrypted DB, plans the immutable window
list, loads the previous window's thread, stores the artifact and does the
no-model publish. This module owns only the prompt, the schema, the retry and
the parse.

Artifact contract (the shape Rust's ``ReadArtifact`` stores)::

    {"chapters": [{"turn": int, "title": str}],
     "highlights": [{"turn": int, "until": int}],
     "notes": [{"turn": int, "kind": str, "text": str, "who": str|null}],
     "thread": str,
     "skipped": bool}

**The model never states a time.** Its input is turns numbered ``#0``, ``#1``,
… and every finding answers with the NUMBER of the turn it came from. Rust
converts that to the exact moment, and drops any number that is not a turn in
the recording. So a hallucinated timestamp cannot reach the transcript — the
worst case is a real moment with the wrong finding on it, never a mark at a
moment that never happened.

A window the model cannot read is returned ``skipped=True`` with the incoming
thread flowing on, so the next window still reads in context and Rust can
report honestly that part of the meeting was not covered. There is no useful
"raw text" fallback here the way there is in merge-mode file_pass: findings are
structure, and inventing structure is the one thing this must not do.

Privacy (SPEC §6): model I/O goes through :func:`llm.generate` like every other
sidecar call, and Rust's gateway attaches the room policy for any non-local
model before the request arrives.
"""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, ConfigDict

from . import llm
from .budget import truncate_bytes
from .config import KEEP_ALIVE_WARM, ProviderConfig
from .messages import Message, system_message, user_message
from .model_text import prime_schema, recover_json

#: Cool: this is extraction, not writing. A creative reading of a meeting is a
#: wrong reading of a meeting.
READ_TEMPERATURE = 0.1

#: Room for a window's worth of findings and the thread, and no more — a model
#: that keeps going past this is listing sentences, not reading.
READ_PREDICT = 1400

#: Byte caps. Rust counts bytes, so clamping in characters would let a Hebrew
#: window overflow the budget it fits under on the other side.
TURNS_CAP = 48_000
THREAD_CAP = 700

_SKIP = object()

_SYSTEM = (
    "You read one part of a meeting transcript and report what happened in it. "
    "You never invent: every finding must be something actually said in the lines "
    "in front of you.\n\n"
    "Each line is numbered, like '#12 [3:04] Dana: ...'. Every finding you report "
    "must carry the NUMBER of the line it came from. Never write a time yourself.\n\n"
    "Report:\n"
    "- chapters: where a clearly new subject begins. Most parts have none or one. "
    "A chapter is a change of subject, not a change of speaker.\n"
    "- highlights: the few lines that carry the most weight — a commitment, a "
    "number, a decisive sentence someone would want to hear again.\n"
    "- notes, each one of:\n"
    "  decision — something settled\n"
    "  action — something a person agreed to do (put their name in 'who', spelled "
    "exactly as it appears in the lines; use null if no name is given)\n"
    "  question — something raised and left unresolved\n"
    "  point — what a stretch of this part was about\n\n"
    "Report nothing rather than something weak. Small talk, greetings and "
    "scheduling chatter are not findings. If this part holds nothing worth "
    "reporting, return empty lists."
)

_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "chapters": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "turn": {"type": "integer"},
                    "title": {"type": "string"},
                },
                "required": ["turn", "title"],
            },
        },
        "highlights": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "turn": {"type": "integer"},
                    "until": {"type": "integer"},
                },
                "required": ["turn", "until"],
            },
        },
        "notes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "turn": {"type": "integer"},
                    "kind": {
                        "type": "string",
                        "enum": ["decision", "action", "question", "point"],
                    },
                    "text": {"type": "string"},
                    "who": {"type": ["string", "null"]},
                },
                "required": ["turn", "kind", "text"],
            },
        },
        "thread": {"type": "string"},
    },
    "required": ["chapters", "highlights", "notes", "thread"],
}


class RecReadMapRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    model: str
    base_url: str = "http://127.0.0.1:11434"
    file_name: str = ""
    #: 0-based window index; ``total`` is the window count ("part i of n").
    part: int = 0
    total: int = 1
    #: the previous window's carried thread ("" for the first part).
    thread: str = ""
    #: this window's numbered turns, built by Rust.
    turns: str = ""
    keep_alive: str = KEEP_ALIVE_WARM
    #: PRIV-1: room privacy policy payload, attached by the Rust gateway.
    privacy: dict[str, Any] | None = None
    provider: ProviderConfig | None = None


def _is_fatal(code: str) -> bool:
    """A hard engine failure parks the job for Resume (rec_read.rs ``is_fatal``)."""
    return code == "OLLAMA_DOWN" or code.startswith("MODEL_MISSING")


def _items(parsed: Any, key: str) -> list[dict[str, Any]]:
    """``parsed[key]`` as a list of objects — [] for anything else.

    Deliberately forgiving: a model that returns one good list and one piece of
    nonsense should cost us the nonsense, not the window. Rust validates every
    turn number and drops what it cannot place, so nothing unchecked gets through.
    """
    if isinstance(parsed, dict):
        v = parsed.get(key)
        if isinstance(v, list):
            return [i for i in v if isinstance(i, dict)]
    return []


def _empty_window(req: RecReadMapRequest) -> dict[str, Any]:
    return {
        "chapters": [],
        "highlights": [],
        "notes": [],
        "thread": req.thread,
        "skipped": False,
    }


def _previous_thread(req: RecReadMapRequest) -> str:
    if not req.thread.strip():
        return ""
    thread = truncate_bytes(req.thread, THREAD_CAP)
    return f"What has happened in this meeting so far:\n{thread}\n\n"


def _window_messages(req: RecReadMapRequest, turns: str) -> list[Message]:
    where = f"Part {req.part + 1} of {req.total}"
    file_name = f' "{req.file_name}"' if req.file_name else ""
    return [
        system_message(_SYSTEM),
        user_message(
            f"{where} of the meeting"
            + file_name
            + ".\n\n"
            + _previous_thread(req)
            + "Lines:\n"
            + turns
            + "\n\nReport what happened in these lines. Also write 'thread': two or "
            "three sentences on where the meeting stands now, for whoever reads the "
            "next part."
        ),
    ]



async def _read_once(req: RecReadMapRequest, messages: list[Message]) -> Any:
    try:
        raw = await llm.generate(
            req.model,
            messages,
            req.base_url,
            temperature=READ_TEMPERATURE,
            num_predict=READ_PREDICT,
            keep_alive=req.keep_alive,
            format=_SCHEMA,
            privacy=req.privacy,
            provider=req.provider,
        )
    except llm.LlmError as exc:
        # A fatal engine error parks the whole job for Resume; anything else
        # is a one-off this read survives.
        if _is_fatal(exc.code):
            raise
        return _SKIP
    try:
        return json.loads(recover_json(raw))
    except (json.JSONDecodeError, ValueError):
        return _SKIP


async def _read_reply(req: RecReadMapRequest, messages: list[Message]) -> Any:
    for attempt in range(2):
        parsed = await _read_once(req, messages)
        if parsed is not _SKIP:
            return parsed
        if attempt == 0:
            continue
    return _SKIP


def _skipped_window(req: RecReadMapRequest) -> dict[str, Any]:
    # The incoming thread flows on, so the next window still reads in context
    # even though this one was lost.
    return {
        "chapters": [],
        "highlights": [],
        "notes": [],
        "thread": req.thread,
        "skipped": True,
    }


def _window_thread(parsed: Any, req: RecReadMapRequest) -> str:
    thread = parsed.get("thread") if isinstance(parsed, dict) else None
    value = thread if isinstance(thread, str) else req.thread
    return truncate_bytes(value, THREAD_CAP)


def _window_result(parsed: Any, req: RecReadMapRequest) -> dict[str, Any]:
    return {
        "chapters": _items(parsed, "chapters"),
        "highlights": _items(parsed, "highlights"),
        "notes": _items(parsed, "notes"),
        "thread": _window_thread(parsed, req),
        "skipped": False,
    }


async def read_window(req: RecReadMapRequest) -> dict[str, Any]:
    """Read one window of a meeting. Never raises for a bad model reply — a lost
    window comes back ``skipped=True`` so the count Rust reports stays honest."""
    turns = truncate_bytes(req.turns, TURNS_CAP)
    if not turns.strip():
        return _empty_window(req)

    messages = _window_messages(req, turns)
    parsed = await _read_reply(req, prime_schema(messages, _SCHEMA))
    if parsed is _SKIP:
        return _skipped_window(req)
    return _window_result(parsed, req)
