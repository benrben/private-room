"""Tests for :mod:`arcelle_sidecar.stt.dictation` — the port of
``src-tauri/src/commands/stt_cmds.rs``'s streaming-dictation section (see that
module's own docstring for the protocol and the decisions these exercise).

Three layers, deliberately:

1. **Pure functions** (``dict_partial_step``, ``dict_stop_timeout``,
   ``dict_pass_text``, ``dict_mode_guidance``, ``_NativeBuffer``, the prompt
   building in ``run_dict_pass``, ``shape_text``'s fallback table) — plain
   unit tests, including the Rust source's own ``#[cfg(test)]`` cases ported
   value for value. The shaping PROMPTS are not retyped and compared: they are
   re-derived from ``stt_cmds.rs`` itself on every run (see
   :func:`test_the_shaping_prompts_still_match_the_rust_source`), so drift on
   either side of the migration is a test failure rather than a prompt that
   quietly stopped matching the shipped app.

2. **The worker, driven directly** with a stand-in ``transcribe`` — fast and
   deterministic, and the only way to pin the rules that matter without
   several minutes of real inference per assertion: the
   drain-everything-before-finalizing ordering contract, the growing repaint
   budget actually being fed back in, repeat-partial suppression, a partial
   decode failing being cosmetic while a FINAL one is reported, and the
   ``DICT_MAX_SECS`` guard capping what reaches the decoder.

3. **The real thing** — a real FastAPI app carrying the real
   ``server.TokenAuthMiddleware``, real WebSocket connections
   (``starlette.testclient.TestClient``, the convention
   ``tests/test_rec_session_ws.py`` established), real macOS ``say`` speech
   and the real whisper model.

THE MODEL-PATH RULE FOR LAYER 3. ``/dict/session`` refuses a ``modelPath``
that is not a file, so the wiring tests need SOME file to connect at all —
they use an empty ``tmp_path`` one (``dummy_model``) rather than the 574 MB
weights, and must therefore never let a real decode start on it:
``pywhispercpp`` does not raise on a file that is not a model, it aborts the
process. That is safe here because ``engine.transcribe`` returns ``""`` for
under 0.1 s of audio BEFORE it opens the model at all, so those tests push
either nothing or well under 1600 samples. Anything that needs a real decode
is marked ``requires_say_and_model``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
import struct
import subprocess
import threading
import time
import uuid
from pathlib import Path

import numpy as np
import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from arcelle_sidecar.media import decode as media_decode
from arcelle_sidecar.server import TokenAuthMiddleware, create_app
from arcelle_sidecar.stt import dictation
from arcelle_sidecar.stt import engine as stt_engine
from arcelle_sidecar.stt.dictation import (
    DICT_MAX_SECS,
    DICT_PARTIAL_STEP_SECS,
    DICT_PROMPT_OPTIMIZER,
    DICT_REWRITE,
    DICT_STOP_BASE,
    DICT_TAIL,
    DICT_TRANSLATE,
    DictSessionManager,
    LiveDictSession,
    LocalModelHooks,
    _NativeBuffer,
    dict_mode_guidance,
    dict_partial_step,
    dict_pass_text,
    dict_stop_timeout,
    register_dict_routes,
    run_dict_pass,
    shape_text,
)

SAMPLE_RATE = 16000

# ============================================================================
# ---- fixtures: the real model, real speech, and a harmless stand-in --------
# ============================================================================

_DOWNLOADED_MODEL = (
    Path.home()
    / "Library/Application Support/com.benreich.privateroom/models"
    / "ggml-large-v3-turbo-q5_0.bin"
)
_BUNDLED_MODEL = Path(__file__).resolve().parents[3] / (
    "apps/desktop/resources/models/ggml-large-v3-turbo-q5_0.bin"
)
MODEL_PATH = str(_DOWNLOADED_MODEL if _DOWNLOADED_MODEL.exists() else _BUNDLED_MODEL)

_HAS_MODEL = Path(MODEL_PATH).exists()
_HAS_SAY = Path("/usr/bin/say").exists() and Path("/usr/bin/afconvert").exists()

requires_say_and_model = pytest.mark.skipif(
    not (_HAS_MODEL and _HAS_SAY),
    reason=f"requires the whisper model at {MODEL_PATH} and macOS say(1)/afconvert(1)",
)

#: The Rust source this module is a port of. A tree that has finished the
#: migration and deleted it skips the fidelity check rather than failing on an
#: absence — the same shape stt_cmds.rs's own
#: `the_bundled_model_passes_the_check_it_is_derived_from` uses for a fresh
#: clone that has no weights.
RUST_SOURCE = Path(__file__).resolve().parents[3] / "src-tauri/src/commands/stt_cmds.rs"


@pytest.fixture
def dummy_model(tmp_path: Path) -> str:
    """A real, existing file that is NOT a model — enough to get past
    ``/dict/session``'s connect-time check. See this module's header for why
    every test using it must keep real decodes away from it."""
    path = tmp_path / "not-really-a-model.bin"
    path.write_bytes(b"lmgg")
    return str(path)


@pytest.fixture(autouse=True)
def _clean_warm_cache():
    """Same discipline as ``test_engine.py``'s fixture of the same name: never
    leave a warm whisper context behind for the next test."""
    stt_engine.unload_ctx()
    yield
    stt_engine.unload_ctx()


@pytest.fixture(scope="module")
def fox_pcm(tmp_path_factory: pytest.TempPathFactory) -> np.ndarray:
    if not _HAS_SAY:
        pytest.skip("requires macOS say/afconvert")
    d = tmp_path_factory.mktemp("dictation_audio")
    path = d / f"fox-{uuid.uuid4()}.aiff"
    proc = subprocess.run(
        [
            "/usr/bin/say",
            "-v",
            "Samantha",
            "-o",
            str(path),
            "The quick brown fox jumps over the lazy dog.",
        ],
        capture_output=True,
    )
    if proc.returncode != 0 or not path.exists():
        pytest.skip(f"say failed to synthesize: {proc.stderr!r}")
    pcm = media_decode.decode_to_pcm(path, media_decode.MediaKind.AUDIO)
    assert pcm.shape[0] > SAMPLE_RATE, "decoded under a second of audio"
    return np.asarray(pcm, dtype=np.float32)


# ============================================================================
# ---- the shaping prompts, re-derived from the Rust source ------------------
# ============================================================================


def _rust_string_at(src: str, idx: int) -> str:
    """Read the Rust ``"…"`` literal starting at ``src[idx]``, resolving the
    escapes rustc resolves — crucially the ``\\``-newline continuation, which
    swallows the newline AND the next line's indentation. Retyping these by
    hand is how a prompt silently drifts from the one the shipped app uses."""
    assert src[idx] == '"', src[idx - 40 : idx + 40]
    escapes = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "0": "\0"}
    out: list[str] = []
    i = idx + 1
    while True:
        char = src[i]
        if char == '"':
            return "".join(out)
        if char == "\\":
            nxt = src[i + 1]
            if nxt == "\n":
                i += 2
                while src[i] in " \t":
                    i += 1
                continue
            out.append(escapes[nxt])
            i += 2
            continue
        out.append(char)
        i += 1


def _rust_prompts() -> tuple[dict[str, str], dict[str, str]]:
    """``({const name: text}, {mode: guidance text})`` straight out of
    ``stt_cmds.rs``."""
    src = RUST_SOURCE.read_text()
    consts = {}
    for name in ("DICT_TRANSLATE", "DICT_REWRITE", "DICT_TAIL", "DICT_PROMPT_OPTIMIZER"):
        match = re.search(rf"const {name}: &str = ", src)
        assert match is not None, f"{name} is gone from the Rust source"
        consts[name] = _rust_string_at(src, match.end())

    start = src.index("pub(crate) fn dict_mode_guidance")
    body = src[start : src.index("pub async fn shape_text", start)]
    modes = {}
    for match in re.finditer(r'"(raw|email|message|commit|notes|prompt)" => Some\(\(', body):
        at = match.end()
        while body[at] in " \n\t":
            at += 1
        modes[match.group(1)] = (
            _rust_string_at(body, at)
            if body[at] == '"'
            else consts["DICT_PROMPT_OPTIMIZER"]  # the `prompt` arm passes the const
        )
    return consts, modes


@pytest.mark.skipif(not RUST_SOURCE.exists(), reason="the Rust source this ports is gone")
def test_the_shaping_prompts_still_match_the_rust_source() -> None:
    """Every shaping instruction, byte for byte against ``stt_cmds.rs``.

    These strings are the whole behaviour of the shaping pass — the model reads
    them verbatim — and they were retyped across a language boundary, where a
    dropped word or a swallowed line-continuation space produces no error
    anywhere, just a slightly worse rewrite for ever. So they are compared
    against the source rather than against a second copy of the transcription.
    """
    consts, modes = _rust_prompts()
    assert DICT_TRANSLATE == consts["DICT_TRANSLATE"]
    assert DICT_REWRITE == consts["DICT_REWRITE"]
    assert DICT_TAIL == consts["DICT_TAIL"]
    assert DICT_PROMPT_OPTIMIZER == consts["DICT_PROMPT_OPTIMIZER"]

    assert set(modes) == {"raw", "email", "message", "commit", "notes", "prompt"}
    for mode, expected in modes.items():
        guidance = dict_mode_guidance(mode)
        assert guidance is not None, mode
        assert guidance[0] == expected, mode
        # Only `prompt` replaces the cleanup instruction; the rest extend it.
        assert guidance[1] is (mode == "prompt"), mode


def test_the_prompt_extractor_resolves_rust_line_continuations() -> None:
    """The check above is only worth its assertions if this parser really joins
    a ``\\``-continued literal the way rustc does; a parser that kept the
    newline and the indentation would compare two wrong things and pass."""
    # The literal below is, character for character, what a `\`-continued Rust
    # string looks like on disk: backslash, newline, indentation, then the rest.
    assert _rust_string_at('"a \\\n     b"', 0) == "a b"
    assert _rust_string_at('"one\\ntwo"', 0) == "one\ntwo"
    assert _rust_string_at('"say \\"hi\\""', 0) == 'say "hi"'
    # …and it stops at the closing quote, not at the end of the file.
    assert _rust_string_at('"first", "second"', 0) == "first"


# ============================================================================
# ---- dict_partial_step / dict_stop_timeout (Rust's own #[test]s) -----------
# ============================================================================


def test_the_dictation_preview_step_grows_with_what_a_decode_costs() -> None:
    """Port of stt_cmds.rs's
    ``the_dictation_preview_step_grows_with_what_a_decode_costs``.

    Each preview repaint re-decodes the dictation from the start, so its cost
    grows with how long someone has been speaking. A fixed step meant a
    minutes-long dictation spent every cycle redecoding, the Mac ran hot, and
    the preview fell further and further behind anyway.
    """
    rate = 48_000
    base = int(rate * DICT_PARTIAL_STEP_SECS)
    # A decode that outruns the microphone keeps the lively fixed step.
    assert dict_partial_step(rate, 0.0) == base
    assert dict_partial_step(rate, 0.1) == base
    # Once a decode costs more than the step, it buys itself that much fresh
    # audio — roughly half the machine, never more.
    assert dict_partial_step(rate, 3.0) == rate * 3
    assert dict_partial_step(rate, 30.0) > dict_partial_step(rate, 3.0)


def test_the_stop_wait_grows_with_the_audio_it_has_to_decode() -> None:
    """Port of stt_cmds.rs's ``the_stop_wait_grows_with_the_audio_it_has_to_decode``."""
    # Nothing captured still gets the base wait: Stop can be queued behind an
    # STT context another decode is holding.
    assert dict_stop_timeout(0.0) == DICT_STOP_BASE
    five_min = dict_stop_timeout(300.0)
    assert five_min > 120.0 * 4
    # …and every extra second of audio buys more, never less.
    assert dict_stop_timeout(301.0) > five_min


def test_the_stop_wait_is_the_callers_and_is_never_applied_here() -> None:
    """The migration plan puts the scaled stop timeout in Electron main, and
    this sidecar answers whenever the whole-utterance decode finishes — the
    same "no deadline of its own" ``/rec/stop`` has. A ceiling quietly added
    here would throw away exactly the long transcripts the scaling exists to
    protect, so pin that no session code reads it."""
    import inspect

    session_code = (
        inspect.getsource(dictation._dict_worker)
        + inspect.getsource(dictation.register_dict_routes)
        + inspect.getsource(dictation.LiveDictSession)
    )
    assert "dict_stop_timeout" not in session_code
    assert "DICT_STOP_BASE" not in session_code
    # …and it is genuinely reachable by the caller that does need it.
    assert dictation.dict_stop_timeout is dict_stop_timeout


# ============================================================================
# ---- dict_mode_guidance / dict_pass_text -----------------------------------
# ============================================================================


@pytest.mark.parametrize("mode", ["off", "", "bogus", "RAW", "Email", "PROMPT"])
def test_dict_mode_guidance_off_or_unknown_means_no_rewrite_stage(mode: str) -> None:
    """Rust's ``_ => None``: an unrecognized mode gets NO rewrite stage, not a
    default one. Case matters — the lookup is exact."""
    assert dict_mode_guidance(mode) is None


def test_dict_mode_guidance_raw_is_cleanup_only() -> None:
    assert dict_mode_guidance("raw") == ("", False)


def test_dict_mode_guidance_prompt_replaces_cleanup() -> None:
    assert dict_mode_guidance("prompt") == (DICT_PROMPT_OPTIMIZER, True)


def test_dictation_shaping_never_types_the_models_reasoning() -> None:
    """Port of stt_cmds.rs's ``dictation_shaping_never_types_the_models_reasoning``.

    Shaping runs on a thinking model like anything else, and its text is typed
    into the composer AS the user's own words — so an unstripped ``<think>``
    span puts the model's reasoning in their mouth.
    """
    assert (
        dict_pass_text("<think>They said 'their' but meant 'there'.</think>\nMeet me there at six.")
        == "Meet me there at six."
    )
    assert dict_pass_text("<think>unterminated") == ""
    assert dict_pass_text("  Meet me at six.  ") == "Meet me at six."


# ============================================================================
# ---- _NativeBuffer: the DICT_MAX_SECS leak guard ---------------------------
# ============================================================================


def test_native_buffer_accepts_everything_under_the_cap() -> None:
    buf = _NativeBuffer()
    rate = 100  # arbitrary: the wire header carries whatever the sender declares
    cap = rate * DICT_MAX_SECS
    buf.extend(np.zeros(cap - 1, dtype=np.float32), rate)
    assert len(buf) == cap - 1
    assert buf.array().shape[0] == cap - 1


def test_native_buffer_drops_audio_whole_once_it_is_at_the_cap() -> None:
    buf = _NativeBuffer()
    rate = 100
    cap = rate * DICT_MAX_SECS
    buf.extend(np.zeros(cap, dtype=np.float32), rate)
    buf.extend(np.full(500, 7.0, dtype=np.float32), rate)
    assert len(buf) == cap
    assert not np.any(buf.array() == 7.0), "audio past the cap reached the buffer"


def test_native_buffer_never_trims_a_message_that_straddles_the_cap() -> None:
    """Rust's gate is a boolean "already at the cap?" asked BEFORE the message
    (stt_cmds.rs:641), not a trim — so the buffer legitimately ends up one
    message over. Pinned because "fixing" it to trim would silently clip the
    last words of a long dictation."""
    buf = _NativeBuffer()
    rate = 10
    cap = rate * DICT_MAX_SECS
    buf.extend(np.zeros(cap - 5, dtype=np.float32), rate)
    buf.extend(np.ones(25, dtype=np.float32), rate)
    assert len(buf) == cap + 20


def test_native_buffer_stays_correct_across_repeated_reads() -> None:
    """Every partial repaint reads the whole buffer; the lazy collapse must not
    lose or duplicate anything when more audio arrives between reads."""
    buf = _NativeBuffer()
    buf.extend(np.array([1.0, 2.0], dtype=np.float32), 100)
    buf.extend(np.array([3.0], dtype=np.float32), 100)
    assert list(buf.array()) == [1.0, 2.0, 3.0]
    buf.extend(np.array([4.0], dtype=np.float32), 100)
    assert list(buf.array()) == [1.0, 2.0, 3.0, 4.0]
    assert len(buf) == 4


def test_native_buffer_reads_the_cap_live_not_at_import() -> None:
    """The guard reads the module-level name on every message, so shrinking it
    affects a RUNNING worker — which is what makes the worker-level guard test
    below possible at all."""
    buf = _NativeBuffer()
    original = dictation.DICT_MAX_SECS
    try:
        dictation.DICT_MAX_SECS = 1
        buf.extend(np.zeros(16000, dtype=np.float32), 16000)
        buf.extend(np.zeros(16000, dtype=np.float32), 16000)
        assert len(buf) == 16000
    finally:
        dictation.DICT_MAX_SECS = original


# ============================================================================
# ---- run_dict_pass: the exact prompt shapes --------------------------------
# ============================================================================


async def test_run_dict_pass_builds_a_plain_prompt_for_a_single_instruction() -> None:
    captured: dict = {}

    async def fake_generate(model, messages, *, temperature=None, keep_alive=None):
        captured.update(
            model=model, messages=messages, temperature=temperature, keep_alive=keep_alive
        )
        return "<think>internal monologue</think>Cleaned up text."

    result = await run_dict_pass("qwen3.5:4b", [DICT_REWRITE], "  um so anyway  ", fake_generate)

    assert result == "Cleaned up text."
    assert captured["model"] == "qwen3.5:4b"
    assert captured["temperature"] == 0.2
    assert captured["keep_alive"] == "5m"
    assert captured["messages"] == [
        {
            "role": "user",
            "content": f"{DICT_REWRITE}\n\n{DICT_TAIL}\n\nINPUT TEXT:\n  um so anyway  ",
        }
    ]


async def test_run_dict_pass_numbers_multiple_instructions_in_order() -> None:
    captured: dict = {}

    async def fake_generate(model, messages, *, temperature=None, keep_alive=None):
        captured["prompt"] = messages[0]["content"]
        return "Result"

    second = "Shape it as a concise, natural chat/Slack message."
    await run_dict_pass("m", [DICT_REWRITE, second], "hi there", fake_generate)

    assert captured["prompt"] == (
        "You are a text post-processor. Apply the following operations to the "
        f"INPUT TEXT, in order:\n1. {DICT_REWRITE}\n2. {second}\n\n{DICT_TAIL}"
        "\n\nINPUT TEXT:\nhi there"
    )


async def test_run_dict_pass_lets_a_generate_failure_reach_its_caller() -> None:
    """It is ``shape_text``, not this, that decides what a failed pass means —
    and it decides differently for translate than for cleanup."""

    async def failing_generate(model, messages, *, temperature=None, keep_alive=None):
        raise ConnectionError("ollama is down")

    with pytest.raises(ConnectionError):
        await run_dict_pass("m", [DICT_REWRITE], "hi", failing_generate)


# ============================================================================
# ---- shape_text: never lose the words --------------------------------------
# ============================================================================


def _hooks(generate, models=("qwen3.5:4b",), list_raises: BaseException | None = None):
    async def list_local_models():
        if list_raises is not None:
            raise list_raises
        return list(models)

    return LocalModelHooks(generate=generate, list_local_models=list_local_models)


def _echo_hooks(**kwargs) -> LocalModelHooks:
    """Echoes the input back tagged with which instruction ran, so a test can
    see exactly which passes fired, in what order, and on what text."""

    async def generate(model, messages, *, temperature=None, keep_alive=None):
        prompt = messages[0]["content"]
        input_text = prompt.rsplit("INPUT TEXT:\n", 1)[1]
        tag = "translated" if prompt.startswith(DICT_TRANSLATE) else "shaped"
        return f"[{tag}]{input_text}"

    return _hooks(generate, **kwargs)


def _never_called_hooks(**kwargs) -> LocalModelHooks:
    async def generate(model, messages, *, temperature=None, keep_alive=None):
        raise AssertionError("generate must not be called")

    return _hooks(generate, **kwargs)


async def test_shape_text_off_and_no_translate_makes_no_model_call_at_all() -> None:
    result = await shape_text("  raw words  ", False, "off", _never_called_hooks())
    assert result.text == "  raw words  "  # not even trimmed
    assert result.notes == []


async def test_shape_text_keeps_the_transcript_when_the_local_ai_is_down() -> None:
    result = await shape_text(
        "hello there", False, "notes", _never_called_hooks(list_raises=ConnectionError("no ollama"))
    )
    assert result.text == "hello there"
    assert result.notes == ["The local AI (Ollama) isn't running — raw transcript kept."]


async def test_shape_text_keeps_the_transcript_when_no_model_is_installed() -> None:
    result = await shape_text("hello there", False, "notes", _never_called_hooks(models=()))
    assert result.text == "hello there"
    assert result.notes == ["No local AI model is installed — raw transcript kept."]


async def test_shape_text_runs_translate_and_shape_as_two_ordered_passes() -> None:
    """ADD-22: one instruction at a time. The cleanup pass must run on the
    TRANSLATED text, not on the original."""
    result = await shape_text("bonjour", True, "message", _echo_hooks())
    assert result.text == "[shaped][translated]bonjour"
    assert result.notes == []


async def test_shape_text_raw_mode_is_cleanup_only() -> None:
    result = await shape_text("um so", False, "raw", _echo_hooks())
    assert result.text == "[shaped]um so"


async def test_shape_text_prompt_mode_replaces_cleanup_rather_than_extending_it() -> None:
    prompts: list[str] = []

    async def generate(model, messages, *, temperature=None, keep_alive=None):
        prompts.append(messages[0]["content"])
        return "optimized prompt"

    result = await shape_text("do the thing", False, "prompt", _hooks(generate))
    assert result.text == "optimized prompt"
    assert len(prompts) == 1
    assert DICT_PROMPT_OPTIMIZER in prompts[0]
    assert DICT_REWRITE not in prompts[0]


async def test_a_failed_translate_returns_the_exact_transcript_and_says_so() -> None:
    """stt_cmds.rs:801-806, the one outcome that misrepresents what happened.

    Carrying on to the cleanup pass would hand back a tidied-up sentence still
    in the language it was dictated in, as the answer to a translate request —
    "the words came back in the language they were spoken in, presented as a
    translation". The failure stops the pipeline; what comes back is the exact
    transcript, and the note is what lets the caller say so.
    """
    prompts: list[str] = []

    async def generate(model, messages, *, temperature=None, keep_alive=None):
        prompts.append(messages[0]["content"])
        raise ConnectionError("model unloaded mid-translate")

    result = await shape_text("texto original", True, "notes", _hooks(generate))

    assert result.text == "texto original"
    assert result.notes == ["Translating failed — kept the exact transcript."]
    assert len(prompts) == 1, "the shape pass ran on words that were never translated"


async def test_an_empty_translate_keeps_the_prior_text_and_still_shapes() -> None:
    """Rust's ``if !t.is_empty()``: an empty answer is not an error, it just
    leaves the text alone and the cleanup pass still runs."""
    calls: list[str] = []

    async def generate(model, messages, *, temperature=None, keep_alive=None):
        prompt = messages[0]["content"]
        calls.append(prompt)
        if prompt.startswith(DICT_TRANSLATE):
            return "   "  # blank once stripped
        return "[shaped]" + prompt.rsplit("INPUT TEXT:\n", 1)[1]

    result = await shape_text("texto original", True, "raw", _hooks(generate))
    assert result.text == "[shaped]texto original"
    assert result.notes == []
    assert len(calls) == 2


async def test_a_failed_shape_pass_keeps_the_best_text_so_far_and_says_so() -> None:
    async def generate(model, messages, *, temperature=None, keep_alive=None):
        prompt = messages[0]["content"]
        if prompt.startswith(DICT_TRANSLATE):
            return "In English now."
        raise ConnectionError("boom")

    result = await shape_text("en français", True, "notes", _hooks(generate))
    # The translation survived; only the cleanup was lost.
    assert result.text == "In English now."
    assert result.notes == ["Cleaning up failed — kept the transcript as dictated."]


async def test_an_empty_shape_reply_falls_back_to_the_prior_text() -> None:
    """alfred's resilience rule: never lose the words to a model that answered
    with nothing."""

    async def generate(model, messages, *, temperature=None, keep_alive=None):
        return "   "

    result = await shape_text("keep me please", False, "notes", _hooks(generate))
    assert result.text == "keep me please"
    assert result.notes == []


async def test_shape_text_never_raises_whatever_the_model_does() -> None:
    async def generate(model, messages, *, temperature=None, keep_alive=None):
        raise RuntimeError("boom")

    result = await shape_text("do not lose me", True, "prompt", _hooks(generate))
    assert result.text == "do not lose me"
    assert result.notes  # it fell back, and it said which stage


async def test_shape_text_uses_the_first_listed_local_model() -> None:
    """The documented stand-in for Rust's ``model_setting``/``runs_on_this_mac``/
    ``best_local_default``. Pinned so the engine-routing batch that replaces it
    has to notice this test, not just the TODO."""
    used: list[str] = []

    async def generate(model, messages, *, temperature=None, keep_alive=None):
        used.append(model)
        return "out"

    await shape_text("hola", True, "raw", _hooks(generate, models=("first", "second")))
    assert used == ["first", "first"]


# ============================================================================
# ---- the worker, driven directly (no socket, no real model) ----------------
# ============================================================================


class _FakeWS:
    """Only what the worker uses of a WebSocket, recording what it was told."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.closed = False

    async def send_text(self, line: str) -> None:
        self.sent.append(json.loads(line))

    async def close(self, code: int = 1000) -> None:
        self.closed = True


def _audio(n: int, rate: int = SAMPLE_RATE, value: float = 0.0) -> dictation._MsgAudio:
    return dictation._MsgAudio(rate=rate, samples=np.full(n, value, dtype=np.float32))


async def _wait_for(predicate, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.005)
    raise AssertionError(f"condition never became true within {timeout}s")


async def test_stop_finalizes_against_everything_already_queued() -> None:
    """THE ORDERING CONTRACT (stt_cmds.rs:585, 644-661). The client awaits its
    last audio push before sending stop and one socket delivers in order, so
    every sample sent before the stop is already queued when the worker reads
    it. The drain loop is what turns that into a guarantee: a stop found
    mid-drain finalizes against ALL of it, never against a half-filled buffer
    that clips the last word.
    """
    decoded: list[int] = []

    def fake_transcribe(model_path, pcm, timestamps):
        decoded.append(len(pcm))
        return "the whole thing"

    queue: asyncio.Queue = asyncio.Queue()
    for _ in range(3):
        queue.put_nowait(_audio(4000))
    queue.put_nowait(dictation._MsgStop())

    ws = _FakeWS()
    with _patched_transcribe(fake_transcribe):
        await asyncio.wait_for(dictation._dict_worker(ws, "/no/model", queue), timeout=5)

    # ONE decode — the final one — over all 12000 samples.
    assert decoded == [12000]
    assert ws.sent == [{"type": "final", "ok": True, "text": "the whole thing"}]
    assert ws.closed


async def test_an_empty_dictation_is_a_successful_empty_transcript() -> None:
    """Rust's ``dict_stop`` may return ``Ok("")`` and its caller shows "No
    speech detected" — an empty transcript must not be reported as a failure."""
    queue: asyncio.Queue = asyncio.Queue()
    queue.put_nowait(dictation._MsgStop())
    ws = _FakeWS()
    with _patched_transcribe(lambda *a: ""):
        await asyncio.wait_for(dictation._dict_worker(ws, "/no/model", queue), timeout=5)
    assert ws.sent == [{"type": "final", "ok": True, "text": ""}]


async def test_a_failed_final_decode_is_reported_to_the_caller() -> None:
    """The opposite of a partial: Stop's decode is the one whose failure the
    caller has to hear about, so it does not sit waiting for a final that will
    never come."""
    queue: asyncio.Queue = asyncio.Queue()
    queue.put_nowait(_audio(4000))
    queue.put_nowait(dictation._MsgStop())
    ws = _FakeWS()

    def boom(model_path, pcm, timestamps):
        raise RuntimeError("the decoder fell over")

    with _patched_transcribe(boom):
        await asyncio.wait_for(dictation._dict_worker(ws, "/no/model", queue), timeout=5)

    assert ws.sent == [{"type": "final", "ok": False, "error": "the decoder fell over"}]
    assert ws.closed


async def test_a_failed_partial_decode_is_cosmetic_and_the_final_still_lands() -> None:
    """Rust: "Partial failures are cosmetic — the final decode at Stop is the
    one that must not lose words"."""
    calls: list[int] = []

    def flaky(model_path, pcm, timestamps):
        calls.append(len(pcm))
        if len(calls) == 1:
            raise RuntimeError("a partial blew up")
        return "recovered"

    queue: asyncio.Queue = asyncio.Queue()
    ws = _FakeWS()
    with _patched_transcribe(flaky):
        worker = asyncio.create_task(dictation._dict_worker(ws, "/no/model", queue))
        queue.put_nowait(_audio(12000))  # past the 11200-sample first step
        await _wait_for(lambda: len(calls) == 1)
        queue.put_nowait(dictation._MsgStop())
        await asyncio.wait_for(worker, timeout=5)

    assert not any(m["type"] == "partial" for m in ws.sent), "a failed partial was announced"
    assert ws.sent == [{"type": "final", "ok": True, "text": "recovered"}]


async def test_a_final_decode_that_cannot_even_be_resampled_still_answers() -> None:
    """Stop's failure has to reach the caller however the decode failed —
    including before the decoder is reached at all.

    Rust's ``resample_to_16k`` is infallible (``Vec<f32>`` in, ``Vec<f32>``
    out); this one allocates numpy temporaries proportional to the whole
    buffer, so on a ten-minute dictation it can raise where Rust's cannot. A
    worker that dies there sends NOTHING, and the caller — which has no
    deadline of this module's own to fall back on — waits out the whole scaled
    ``dict_stop_timeout`` before it can even say the dictation was lost.
    """
    queue: asyncio.Queue = asyncio.Queue()
    queue.put_nowait(_audio(4000))
    queue.put_nowait(dictation._MsgStop())
    ws = _FakeWS()

    def boom(samples, rate):
        raise MemoryError("no room to resample a ten-minute buffer")

    with _patched(dictation, "resample_to_16k", boom):
        await asyncio.wait_for(dictation._dict_worker(ws, "/no/model", queue), timeout=5)

    assert ws.sent == [
        {"type": "final", "ok": False, "error": "no room to resample a ten-minute buffer"}
    ]
    assert ws.closed


async def test_a_partial_that_cannot_be_resampled_is_cosmetic_too() -> None:
    """The same hazard on the preview path, where it costs more: a repaint that
    raised would kill the worker outright, so the ``stop`` queued behind it
    would never be read and the whole dictation would be lost to a failure the
    module calls cosmetic."""
    resamples: list[int] = []

    def flaky(samples, rate):
        resamples.append(len(samples))
        if len(resamples) == 1:
            raise ValueError("the repaint's resample blew up")
        return np.asarray(samples, dtype=np.float32)

    queue: asyncio.Queue = asyncio.Queue()
    ws = _FakeWS()
    with _patched_transcribe(lambda *a: "recovered"), _patched(
        dictation, "resample_to_16k", flaky
    ):
        worker = asyncio.create_task(dictation._dict_worker(ws, "/no/model", queue))
        queue.put_nowait(_audio(12000))  # past the 11200-sample first step
        await _wait_for(lambda: len(resamples) == 1)
        queue.put_nowait(dictation._MsgStop())
        await asyncio.wait_for(worker, timeout=5)

    assert not any(m["type"] == "partial" for m in ws.sent), "a failed repaint was announced"
    assert ws.sent == [{"type": "final", "ok": True, "text": "recovered"}]


async def test_the_repaint_budget_counts_a_decode_that_failed_too() -> None:
    """A decode that blew up after 30 s still cost 30 s.

    Leaving ``last_decode_secs`` at its old value on a failure resets the
    growing budget to the 0.7 s floor, so the worker immediately re-decodes the
    whole buffer again — thrashing hardest exactly when the machine is already
    in trouble, which is what the growing budget exists to stop.
    """
    seen: list[tuple[int, float]] = []
    real_step = dictation.dict_partial_step

    def spy(rate, last_decode_secs):
        seen.append((rate, last_decode_secs))
        return real_step(rate, 0.0)  # keep the floor so the test stays quick

    def slow_then_boom(model_path, pcm, timestamps):
        time.sleep(0.2)
        raise RuntimeError("the decoder fell over after doing the work")

    queue: asyncio.Queue = asyncio.Queue()
    ws = _FakeWS()
    with _patched_transcribe(slow_then_boom), _patched(dictation, "dict_partial_step", spy):
        worker = asyncio.create_task(dictation._dict_worker(ws, "/no/model", queue))
        queue.put_nowait(_audio(12000))
        await _wait_for(lambda: len(seen) >= 1)
        queue.put_nowait(_audio(12000))
        await _wait_for(lambda: len(seen) >= 2)
        queue.put_nowait(dictation._MsgStop())
        await asyncio.wait_for(worker, timeout=10)

    assert seen[0][1] == 0.0, "the first repaint decision had a cost from nowhere"
    assert seen[1][1] >= 0.15, f"a decode that failed was charged nothing: {seen[1][1]}"


async def test_a_partial_is_sent_when_the_text_changes_and_suppressed_when_it_does_not() -> None:
    """``dict_worker``'s ``if text != last_text``: a repaint that decodes to
    exactly what is already on screen is not a repaint."""
    texts = ["the quick brown", "the quick brown", "the quick brown fox"]
    calls: list[int] = []

    def fake(model_path, pcm, timestamps):
        calls.append(len(pcm))
        return texts[min(len(calls) - 1, len(texts) - 1)]

    queue: asyncio.Queue = asyncio.Queue()
    ws = _FakeWS()
    with _patched_transcribe(fake):
        worker = asyncio.create_task(dictation._dict_worker(ws, "/no/model", queue))
        for expected in (1, 2, 3):
            queue.put_nowait(_audio(12000))
            await _wait_for(lambda n=expected: len(calls) == n)
        queue.put_nowait(dictation._MsgStop())
        await asyncio.wait_for(worker, timeout=5)

    partials = [m["text"] for m in ws.sent if m["type"] == "partial"]
    assert partials == ["the quick brown", "the quick brown fox"]


async def test_the_next_repaint_budget_is_what_the_last_decode_actually_cost() -> None:
    """``dict_partial_step`` is only worth having if the worker feeds the
    measured cost back into it. Pinned by watching the arguments rather than
    the timing, so it says what it means without being flaky: the first
    decision is made with no cost yet, the one after a decode that really took
    time is made with that time, and the rate is the latest one the sender
    declared."""
    seen: list[tuple[int, float]] = []
    real_step = dictation.dict_partial_step

    def spy(rate, last_decode_secs):
        seen.append((rate, last_decode_secs))
        return real_step(rate, 0.0)  # keep the floor so the test stays quick

    def slow(model_path, pcm, timestamps):
        time.sleep(0.2)
        return f"n={len(pcm)}"

    queue: asyncio.Queue = asyncio.Queue()
    ws = _FakeWS()
    with _patched_transcribe(slow), _patched(dictation, "dict_partial_step", spy):
        worker = asyncio.create_task(dictation._dict_worker(ws, "/no/model", queue))
        # 40000 samples clears the 33600-sample floor at 48 kHz, so each push
        # really does trigger a decode and there is a cost to feed back.
        queue.put_nowait(_audio(40000, rate=48000))
        await _wait_for(lambda: len(seen) >= 1)
        await _wait_for(lambda: any(m["type"] == "partial" for m in ws.sent))
        queue.put_nowait(_audio(40000, rate=48000))
        await _wait_for(lambda: len(seen) >= 2)
        queue.put_nowait(dictation._MsgStop())
        await asyncio.wait_for(worker, timeout=10)

    assert seen[0] == (48000, 0.0), "the first repaint decision had a cost from nowhere"
    assert seen[1][0] == 48000
    assert seen[1][1] >= 0.15, f"the measured decode cost was not fed back: {seen[1][1]}"


async def test_the_leak_guard_caps_what_reaches_the_decoder() -> None:
    """``DICT_MAX_SECS`` enforced by the RUNNING worker, not merely correct in
    isolation: with the cap shrunk to one second, the array handed to the real
    resampler — and from there to the decoder — never exceeds it, however much
    audio is pushed. Allowing exactly one message of overshoot, which is the
    Rust behaviour ``_NativeBuffer`` reproduces on purpose."""
    handed: list[int] = []

    def fake(model_path, pcm, timestamps):
        handed.append(len(pcm))
        return "capped"

    chunk = 4000
    queue: asyncio.Queue = asyncio.Queue()
    for _ in range(10):  # 40000 samples = 2.5 s at 16 kHz
        queue.put_nowait(_audio(chunk))
    queue.put_nowait(dictation._MsgStop())

    ws = _FakeWS()
    with _patched_transcribe(fake), _patched(dictation, "DICT_MAX_SECS", 1):
        await asyncio.wait_for(dictation._dict_worker(ws, "/no/model", queue), timeout=5)

    assert handed, "nothing was ever decoded"
    assert handed[-1] <= SAMPLE_RATE + chunk
    assert handed[-1] >= SAMPLE_RATE, "the guard clipped below the cap"


async def test_cancelling_the_worker_leaves_nothing_waiting_for_stops_answer() -> None:
    """The single slot REPLACES rather than refuses, so a session can be torn
    down with a ``stop`` queued and its whole-utterance decode in flight.
    ``stop``'s answer is produced by the worker itself and written to the
    socket, so cancelling that worker ends the session outright and there is
    nothing outside it left holding a reply future.

    This is a regression test for the alternative shape — a route handler that
    awaits a future the worker resolves — where the same teardown leaves that
    handler pending for ever, holding the socket, the queue and the whole audio
    buffer, with the client never told anything either.
    """
    entered = threading.Event()
    release = threading.Event()

    def wedged(model_path, pcm, timestamps):
        entered.set()
        release.wait(10)
        return "never arrives"

    queue: asyncio.Queue = asyncio.Queue()
    queue.put_nowait(_audio(4000))
    queue.put_nowait(dictation._MsgStop())
    ws = _FakeWS()
    before = asyncio.all_tasks()
    try:
        with _patched_transcribe(wedged):
            worker = asyncio.create_task(dictation._dict_worker(ws, "/no/model", queue))
            await _wait_for(entered.is_set)
            session = LiveDictSession(websocket=ws, queue=queue, worker=worker)
            # Awaiting must return promptly even though a decode is parked in a
            # thread — a teardown that blocks on the decode it is abandoning
            # would hang the REPLACEMENT session's own connect.
            await asyncio.wait_for(session.stop_worker(), timeout=2)
    finally:
        release.set()

    assert worker.done()
    left_behind = asyncio.all_tasks() - before - {asyncio.current_task()}
    assert left_behind == set(), f"tasks left waiting after teardown: {left_behind}"
    assert ws.sent == [], "an abandoned session answered anyway"


@contextlib.contextmanager
def _patched(target, name: str, value):
    original = getattr(target, name)
    setattr(target, name, value)
    try:
        yield
    finally:
        setattr(target, name, original)


def _patched_transcribe(fn):
    return _patched(dictation.stt_engine, "transcribe", fn)


# ============================================================================
# ---- the WS route: auth, refusals, malformed frames, the single slot -------
# ============================================================================

TOKEN = "test-token-123"


def _dict_app(token: str | None = TOKEN) -> tuple[FastAPI, DictSessionManager]:
    app = FastAPI()
    if token:
        app.add_middleware(TokenAuthMiddleware, token=token)
    return app, register_dict_routes(app)


def _ws_url(model_path: str, token: str | None = TOKEN) -> str:
    query = f"modelPath={model_path}"
    return f"/dict/session?token={token}&{query}" if token else f"/dict/session?{query}"


def _encode_audio_frame(rate: int, samples: np.ndarray) -> bytes:
    arr = np.ascontiguousarray(samples, dtype="<f4")
    return struct.pack("<II", rate, arr.size) + arr.tobytes()


def _push_audio(ws, pcm: np.ndarray, *, rate: int = SAMPLE_RATE, chunk: int = 4000) -> None:
    for i in range(0, len(pcm), chunk):
        ws.send_bytes(_encode_audio_frame(rate, pcm[i : i + chunk]))


def _run_collector(ws, received: list) -> None:
    while True:
        try:
            received.append(ws.receive_json())
        except Exception:
            return


def _wait_until(predicate, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError(f"condition never became true within {timeout}s")


def _receive_json_within(ws, timeout: float = 20.0):
    """``ws.receive_json()`` with a deadline. ``TestClient``'s own receive has
    none, so a regression that leaves a socket silent would HANG the suite
    rather than fail it — and a test that hangs reports nothing at all."""
    box: list = []

    def grab() -> None:
        try:
            box.append(("ok", ws.receive_json()))
        except BaseException as exc:  # noqa: BLE001 - re-raised on the test's thread
            box.append(("raised", exc))

    thread = threading.Thread(target=grab, daemon=True)
    thread.start()
    thread.join(timeout)
    assert box, f"nothing came back on the socket within {timeout}s"
    kind, value = box[0]
    if kind == "raised":
        raise value
    return value


@contextlib.contextmanager
def _open_ws(client: TestClient, url: str):
    """``client.websocket_connect``, except leaving the block never raises for
    a socket the SERVER already closed on its own — which ``stop``, ``cancel``
    and a supersede all do before the client's context manager gets there."""
    conn = client.websocket_connect(url)
    websocket = conn.__enter__()
    try:
        yield websocket
    finally:
        with contextlib.suppress(Exception):
            conn.__exit__(None, None, None)


def test_the_route_needs_the_query_token(dummy_model: str) -> None:
    """Auth runs BEFORE the route looks at ``modelPath`` — proven by passing a
    perfectly good one and still getting 4401."""
    app, manager = _dict_app()
    with TestClient(app) as client:
        for url in (
            _ws_url(dummy_model, token=None),
            _ws_url(dummy_model, token="nope"),
        ):
            with pytest.raises(WebSocketDisconnect) as exc:
                with client.websocket_connect(url):
                    pass
            assert exc.value.code == 4401
    assert manager.current is None


def test_a_model_path_that_is_not_a_file_is_refused_before_anything_decodes(
    tmp_path: Path,
) -> None:
    """Rust's ``STT_MODEL_MISSING``. This is not politeness: a decode against a
    path with no model behind it aborts the whole process inside the native
    library, taking every other thing the sidecar is doing with it. A
    directory has to be refused too — it passes ``exists()`` and aborts just
    the same."""
    app, manager = _dict_app()
    a_directory = tmp_path / "models"
    a_directory.mkdir()
    with TestClient(app) as client:
        for url in (
            f"/dict/session?token={TOKEN}",  # no modelPath at all
            _ws_url(str(tmp_path / "deleted-by-the-user.bin")),
            _ws_url(str(a_directory)),
        ):
            with pytest.raises(WebSocketDisconnect) as exc:
                with client.websocket_connect(url):
                    pass
            assert exc.value.code == 4404, url
    assert manager.current is None


def test_a_malformed_frame_is_dropped_and_the_session_survives_it(dummy_model: str) -> None:
    app, manager = _dict_app()
    with TestClient(app) as client:
        with _open_ws(client, _ws_url(dummy_model)) as ws:
            ws.send_bytes(b"\x00\x01")  # shorter than the 8-byte header
            ws.send_bytes(struct.pack("<II", SAMPLE_RATE, 999_999))  # lying n
            ws.send_text("{not json")
            ws.send_text(json.dumps(["not", "an", "object"]))
            ws.send_json({"type": "who-knows"})
            # Still alive: stop is answered normally. Nothing real was buffered,
            # so this decodes to "" without ever opening the stand-in file.
            ws.send_json({"type": "stop"})
            assert _receive_json_within(ws) == {"type": "final", "ok": True, "text": ""}
        _wait_until(lambda: manager.current is None)


def test_stop_with_no_audio_answers_an_empty_transcript(dummy_model: str) -> None:
    app, manager = _dict_app()
    with TestClient(app) as client:
        with _open_ws(client, _ws_url(dummy_model)) as ws:
            ws.send_json({"type": "stop"})
            assert _receive_json_within(ws) == {"type": "final", "ok": True, "text": ""}
        _wait_until(lambda: manager.current is None)


def test_cancel_ends_the_session_with_no_final_decode(dummy_model: str) -> None:
    """``dict_cancel``'s contract: abandon, do not finalize. The socket ends
    with the session rather than dangling — a cancelled session must not be
    left looking like somewhere audio can still be pushed."""
    app, manager = _dict_app()
    received: list = []
    with TestClient(app) as client:
        with _open_ws(client, _ws_url(dummy_model)) as ws:
            collector = threading.Thread(target=_run_collector, args=(ws, received), daemon=True)
            collector.start()
            ws.send_json({"type": "cancel"})
            # The collector only ends when the socket does. Bounded on purpose:
            # a dangling socket must fail this test, not hang it.
            collector.join(timeout=5)
            assert not collector.is_alive(), "the socket was left open after cancel"
        _wait_until(lambda: manager.current is None)
    assert not any(e.get("type") == "final" for e in received), "cancel ran a final decode"


def test_just_disconnecting_is_a_cancel_too(dummy_model: str) -> None:
    app, manager = _dict_app()
    with TestClient(app) as client:
        with client.websocket_connect(_ws_url(dummy_model)):
            _wait_until(lambda: manager.current is not None)
        _wait_until(lambda: manager.current is None)


def test_a_second_session_replaces_the_first_and_closes_it(dummy_model: str) -> None:
    """``DictState``'s own behaviour: the four mics share one microphone, so a
    second session starting IS the first one ending — REPLACE, not the
    refuse-with-409 ``/rec/start`` answers with."""
    app, manager = _dict_app()
    with TestClient(app) as client:
        with _open_ws(client, _ws_url(dummy_model)) as first:
            _wait_until(lambda: manager.current is not None)
            first_session = manager.current
            with _open_ws(client, _ws_url(dummy_model)) as second:
                _wait_until(
                    lambda: manager.current is not None and manager.current is not first_session
                )
                with pytest.raises(WebSocketDisconnect) as exc:
                    first.receive_json()
                assert exc.value.code == 4409
                # …and the replacement is a working session, not a wedged slot.
                second.send_json({"type": "stop"})
                assert _receive_json_within(second) == {"type": "final", "ok": True, "text": ""}
        _wait_until(lambda: manager.current is None)


def test_a_superseded_session_does_not_clear_its_replacements_slot(dummy_model: str) -> None:
    """The first connection's own teardown runs AFTER the second has taken the
    slot. Clearing unconditionally there would free a slot that belongs to a
    live session, and the manager would then report no dictation while one is
    running.

    The first socket is therefore closed FIRST, while the second is still open
    — the interleaving that actually exercises this. Nesting the two the
    obvious way tears the second down first and the guard is never reached.
    """
    app, manager = _dict_app()
    with TestClient(app) as client:
        first_conn = client.websocket_connect(_ws_url(dummy_model))
        first = first_conn.__enter__()
        _wait_until(lambda: manager.current is not None)
        first_session = manager.current
        with _open_ws(client, _ws_url(dummy_model)) as second:
            _wait_until(lambda: manager.current is not first_session)
            second_session = manager.current
            with pytest.raises(WebSocketDisconnect):
                first.receive_json()
            # Let the superseded connection finish tearing itself down.
            with contextlib.suppress(Exception):
                first_conn.__exit__(None, None, None)
            time.sleep(0.3)
            assert manager.current is second_session, "a dead session freed the live slot"
            # …and the slot it kept is a working session, not a husk.
            second.send_json({"type": "stop"})
            assert _receive_json_within(second) == {"type": "final", "ok": True, "text": ""}


def test_two_apps_have_independent_dictation_slots(dummy_model: str) -> None:
    """Per app, never a module global — two ``create_app()`` instances in one
    process must not share a dictation (or a lock bound to whichever event loop
    touched it first)."""
    app1, manager1 = _dict_app()
    app2, manager2 = _dict_app()
    with TestClient(app1) as c1, TestClient(app2) as c2:
        with _open_ws(c1, _ws_url(dummy_model)):
            _wait_until(lambda: manager1.current is not None)
            assert manager2.current is None
            with _open_ws(c2, _ws_url(dummy_model)):
                _wait_until(lambda: manager2.current is not None)
                assert manager1.current is not None, "app2's session took app1's slot"


def test_the_real_app_mounts_the_route_and_leaves_header_auth_alone(dummy_model: str) -> None:
    """``server.create_app()`` really registers this, and the websocket branch
    is an ADDITION to ``TokenAuthMiddleware``, not a replacement — the same
    check ``test_rec_session_ws.py`` makes for ``/rec/session``."""
    app = create_app(token=TOKEN)
    assert isinstance(app.state.dict_manager, DictSessionManager)
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        anon = client.post("/cancel", json={"run_id": "x"})
        assert anon.status_code == 401 and anon.json()["code"] == "NO_TOKEN"
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(f"/dict/session?modelPath={dummy_model}"):
                pass
        assert exc.value.code == 4401
        # …and with the token it is the real handler answering, not a 404.
        with _open_ws(client, _ws_url(dummy_model)) as ws:
            ws.send_json({"type": "stop"})
            assert _receive_json_within(ws) == {"type": "final", "ok": True, "text": ""}


# ============================================================================
# ---- the whole thing: real speech, real whisper, the real wire -------------
# ============================================================================


@requires_say_and_model
def test_a_whole_dictation_over_the_real_wire(fox_pcm: np.ndarray) -> None:
    """Real speech in over the binary frame protocol, a real partial repaint
    from the real model while "speaking" is still open, and the real final
    whole-utterance transcript from ``stop`` — the counterpart of stt_cmds.rs's
    own ``e2e_dict_worker_partials_then_final``."""
    app, manager = _dict_app()
    with TestClient(app) as client:
        with _open_ws(client, _ws_url(MODEL_PATH)) as ws:
            received: list = []
            collector = threading.Thread(target=_run_collector, args=(ws, received), daemon=True)
            collector.start()
            _push_audio(ws, np.concatenate([np.zeros(4000, np.float32), fox_pcm]))
            # A repaint must arrive while "speaking" is still open. Its WORDS
            # are deliberately not asserted: a partial is a whole-buffer decode
            # of however much audio had landed by then, so it is legitimately
            # an unfinished sentence — a real run of this produced "The quick
            # brush". What must be true is that something arrived to paint.
            # The finished sentence is the FINAL decode's job, below.
            _wait_until(
                lambda: any(
                    e.get("type") == "partial" and e.get("text", "").strip() for e in received
                ),
                timeout=90,
            )
            ws.send_json({"type": "stop"})
            _wait_until(lambda: any(e.get("type") == "final" for e in received), timeout=120)
            collector.join(timeout=5)
        final = next(e for e in received if e["type"] == "final")
        assert final["ok"] is True
        assert "quick brown fox" in final["text"].lower()
        _wait_until(lambda: manager.current is None)


@requires_say_and_model
def test_the_last_words_pushed_before_stop_are_never_clipped(fox_pcm: np.ndarray) -> None:
    """The ordering contract end to end: the whole utterance is pushed in one
    burst immediately followed by ``stop``, so on a real socket both are
    already queued server-side before the worker runs at all — the case the
    drain loop exists for. The final transcript must still carry the last
    words."""
    app, _manager = _dict_app()
    with TestClient(app) as client:
        with _open_ws(client, _ws_url(MODEL_PATH)) as ws:
            received: list = []
            collector = threading.Thread(target=_run_collector, args=(ws, received), daemon=True)
            collector.start()
            _push_audio(ws, np.concatenate([np.zeros(4000, np.float32), fox_pcm]))
            ws.send_json({"type": "stop"})
            _wait_until(lambda: any(e.get("type") == "final" for e in received), timeout=120)
            collector.join(timeout=5)
        final = next(e for e in received if e["type"] == "final")
        assert final["ok"] is True
        text = final["text"].lower()
        assert "quick brown fox" in text
        assert "lazy dog" in text, f"the tail of the utterance was clipped: {final['text']!r}"
