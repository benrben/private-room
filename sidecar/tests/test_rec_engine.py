"""Tests for :mod:`arcelle_sidecar.rec.engine` -- the Python port of the
recording ``Engine`` orchestrator (``src-tauri/src/recording.rs`` lines 628-675
and 1173-2778; see that module's own docstring for the full port map and the
threading-model simplifications it discloses).

Real, not mocked, wherever this migration's own convention already asks for it:
``stt.live.transcribe_segments`` runs against the real whisper.cpp model,
``diar.embed.embed``/``diar.windows.window_prints``/``diar.cluster``/
``diar.label`` run against the real TitaNet ONNX model, the lanes run the real
Silero VAD when its weights are cached, and every phrase's audio is real macOS
``say``-synthesized speech decoded through the sidecar's own
``media.decode.decode_to_pcm`` -- never a fixture WAV or a stubbed decode. The
only boundary this suite fakes is :class:`EnginePorts` itself (:class:`FakePorts`
below): the Electron-side seam (emit/persist/sys-tap/translate) this port's
whole job is to isolate ``Engine`` from.

Skips cleanly (never silently) when the whisper/TitaNet models or macOS
``say``/``afconvert`` are missing. On the machine this suite was written
against all four are present, so nothing here is expected to be skipped.

This file is the merge of two independently-written candidate suites
(``test_rec_engine_candidate_a.py``/``_b.py``, both deleted): the union of their
cases, deduplicated, plus a regression test for every defect the differential
cross-check found in one candidate or the other (they are grouped under
"REGRESSIONS" at the end, each naming the behavior it pins).
"""

from __future__ import annotations

import asyncio
import contextlib
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pytest

from arcelle_sidecar.diar import embed as diar_embed
from arcelle_sidecar.media import decode as media_decode
from arcelle_sidecar.media.wav import decode_wav
from arcelle_sidecar.rec import vad as vad_module
from arcelle_sidecar.rec.engine import (
    ENGINE_GONE,
    FLUSH_RETRY_BACKOFF,
    LIVE_TRANSLATE_QUEUE,
    SAVE_FAILED,
    DecodeJob,
    DecodeOut,
    Engine,
    EngineConfig,
    JobKind,
    MsgAudio,
    MsgDecodeDone,
    MsgEditMeta,
    MsgPause,
    MsgResume,
    MsgSetLiveStt,
    MsgStop,
    MsgSysTapResult,
    PersistFailed,
    RetranscribeStopped,
    RoomClosed,
    Save,
    _run_decode_job,
    checkpoint_mark,
    create_engine,
    merge_phrase,
    retranscribe,
    room_translation_model,
)
from arcelle_sidecar.rec.lanes import Active, LaneLang, Source
from arcelle_sidecar.rec.meta import (
    LANE_RESYNC_GAP,
    MAX_SESSION_SAMPLES,
    RETRANSCRIBE_STOPPED,
    SAMPLE_RATE,
    NoteKind,
    RecChapter,
    RecCut,
    RecHighlight,
    RecMeta,
    RecNote,
    RecSegment,
    RecWord,
    cs_of_samples,
)
from arcelle_sidecar.stt import engine as stt_engine
from arcelle_sidecar.stt.live import SegOut

# --------------------------------------------------------------- model paths

_DOWNLOADED_MODEL = (
    Path.home()
    / "Library/Application Support/com.benreich.privateroom/models"
    / "ggml-large-v3-turbo-q5_0.bin"
)
_BUNDLED_MODEL = Path(
    "/Users/benreich/private-room/electron-migration/electron-app/assets/models/ggml-large-v3-turbo-q5_0.bin"
)
MODEL_PATH = str(_DOWNLOADED_MODEL if _DOWNLOADED_MODEL.exists() else _BUNDLED_MODEL)
DIAR_MODEL_PATH = (
    "/Users/benreich/private-room/electron-migration/electron-app/assets/models/nemo_en_titanet_small.onnx"
)
VAD_ONNX_PATH = str(
    Path.home() / "Library" / "Caches" / "arcelle-sidecar" / "models" / "silero_vad.onnx"
)

#: A path that certainly holds no model: every test that never decodes uses it,
#: so a stubbed-looking config can never accidentally load real weights.
NO_MODEL = "/nonexistent-whisper-model.bin"

_HAS_MODEL = Path(MODEL_PATH).exists()
_HAS_DIAR_MODEL = Path(DIAR_MODEL_PATH).exists()
_HAS_VAD_MODEL = Path(VAD_ONNX_PATH).exists()
_HAS_SAY = Path("/usr/bin/say").exists() and Path("/usr/bin/afconvert").exists()

requires_say = pytest.mark.skipif(not _HAS_SAY, reason="requires macOS say(1)/afconvert(1)")
requires_diar = pytest.mark.skipif(
    not (_HAS_DIAR_MODEL and _HAS_SAY),
    reason=f"requires the TitaNet model at {DIAR_MODEL_PATH} + say/afconvert",
)
requires_all = pytest.mark.skipif(
    not (_HAS_MODEL and _HAS_DIAR_MODEL and _HAS_SAY),
    reason=(
        f"requires the whisper model at {MODEL_PATH}, the TitaNet model at "
        f"{DIAR_MODEL_PATH}, and macOS say(1)/afconvert(1)"
    ),
)


@pytest.fixture(autouse=True)
def _clean_warm_cache():
    """Same discipline as ``test_engine.py``/``test_stt_live.py``'s fixture of
    the same name: a warm Metal context left resident at process exit is what
    ``unload_ctx`` exists to avoid, and cache-sharing tests need a known
    starting state."""
    stt_engine.unload_ctx()
    yield
    stt_engine.unload_ctx()


@pytest.fixture(autouse=True)
def _real_vad_when_available():
    """Point every ``Lane`` this file constructs at the real cached Silero VAD
    weights when they are present -- the same pattern ``test_rec_lanes.py``
    uses. Falls back to the energy gate (still real production code, not a
    stub) when absent."""
    if _HAS_VAD_MODEL:
        vad_module.set_vad_model_path(VAD_ONNX_PATH)
    yield
    vad_module._vad_model_path_override = None


# ------------------------------------------------------------ real say audio


def _say(voice: str, text: str, tmp_path_factory: pytest.TempPathFactory) -> np.ndarray:
    d = tmp_path_factory.mktemp("engine_audio")
    path = d / f"{voice}-{uuid.uuid4()}.aiff"
    proc = subprocess.run(
        ["/usr/bin/say", "-v", voice, "-o", str(path), text], capture_output=True
    )
    if proc.returncode != 0 or not path.exists():
        pytest.skip(f"say failed to synthesize voice {voice!r}: {proc.stderr!r}")
    pcm = media_decode.decode_to_pcm(path, media_decode.MediaKind.AUDIO)
    assert pcm.shape[0] > SAMPLE_RATE, "decoded under a second of audio"
    return np.asarray(pcm, dtype=np.float32)


@pytest.fixture(scope="module")
def fox_pcm(tmp_path_factory: pytest.TempPathFactory) -> np.ndarray:
    """Real "the quick brown fox..." audio, Samantha's voice."""
    if not _HAS_SAY:
        pytest.skip("requires macOS say/afconvert")
    return _say("Samantha", "The quick brown fox jumps over the lazy dog.", tmp_path_factory)


@pytest.fixture(scope="module")
def fred_pcm(tmp_path_factory: pytest.TempPathFactory) -> np.ndarray:
    """A DIFFERENT real sentence in a DIFFERENT voice -- for the relabel/split
    tests that need two genuinely distinct speakers."""
    if not _HAS_SAY:
        pytest.skip("requires macOS say/afconvert")
    return _say(
        "Fred",
        "Let us meet again tomorrow at ten to finalize everything on the agenda.",
        tmp_path_factory,
    )


@pytest.fixture(scope="module")
def launch_pcm(tmp_path_factory: pytest.TempPathFactory) -> np.ndarray:
    """The Rust source's own echo example, as real audio."""
    if not _HAS_SAY:
        pytest.skip("requires macOS say/afconvert")
    return _say("Samantha", "Let's move the launch to Friday.", tmp_path_factory)


# ---------------------------------------------------------------- FakePorts


@dataclass
class RecordedPersist:
    save: Save
    wav: bytes | None
    checkpoint_pcm: np.ndarray | None
    meta_json: str
    text: str


class FakePorts:
    """A plain recorder implementing :class:`EnginePorts` -- no mocking
    framework, matching this migration's established convention
    (``tests/conftest.py``'s ``FakeChatModel``/``FakeMCP``). Stands in for the
    Electron-side DB/emit/ScreenCaptureKit/translation seam, never for the
    decode itself."""

    def __init__(
        self,
        *,
        fail_next: int = 0,
        fail_exc: Exception | None = None,
        translate_result: str | None = "translated",
    ) -> None:
        self.events: list[tuple[str, dict]] = []
        self.persists: list[RecordedPersist] = []
        self.fail_next = fail_next
        self.fail_exc: Exception = fail_exc if fail_exc is not None else PersistFailed("disk full")
        self.sys_tap_requests = 0
        self.sys_tap_stops = 0
        self.translate_calls: list[tuple[str, str, str]] = []
        self.translate_result = translate_result

    def emit(self, event: str, payload: dict) -> None:
        self.events.append((event, dict(payload)))

    async def persist(
        self,
        save: Save,
        *,
        wav: bytes | None,
        checkpoint_pcm: np.ndarray | None,
        meta_json: str,
        text: str,
    ) -> None:
        if self.fail_next > 0:
            self.fail_next -= 1
            raise self.fail_exc
        self.persists.append(RecordedPersist(save, wav, checkpoint_pcm, meta_json, text))

    async def request_sys_tap(self) -> None:
        self.sys_tap_requests += 1

    async def stop_sys_tap(self) -> None:
        self.sys_tap_stops += 1

    async def translate(self, text: str, lang: str, model: str) -> str | None:
        self.translate_calls.append((text, lang, model))
        return self.translate_result

    # -- readers ----------------------------------------------------------
    def payloads(self, event: str) -> list[dict]:
        return [p for name, p in self.events if name == event]

    def errors(self) -> list[str]:
        return [p["message"] for p in self.payloads("rec-error")]

    def saves(self, save: Save) -> list[RecordedPersist]:
        return [p for p in self.persists if p.save is save]


def make_engine(
    ports: FakePorts,
    *,
    system_audio: bool = False,
    model_path: str = NO_MODEL,
    diarize_model_path: str | None = None,
    meta: RecMeta | None = None,
    base_samples: np.ndarray | None = None,
    known_voices: list | None = None,
    live_translate: str | None = None,
    default_translation_model: str | None = None,
) -> Engine:
    """An engine with NO background workers -- for tests that drive
    ``handle()``/``tick()``/``flush()`` directly and feed
    :class:`MsgDecodeDone` by hand."""
    return Engine(
        EngineConfig(
            file_id="file-1",
            model_path=model_path,
            base_samples=base_samples if base_samples is not None else np.zeros(0, np.float32),
            meta=meta if meta is not None else RecMeta(),
            system_audio=system_audio,
            live_translate=live_translate,
            known_voices=known_voices or [],
            diarize_model_path=diarize_model_path,
            default_translation_model=default_translation_model,
        ),
        ports,
    )


async def make_live_engine(ports: FakePorts, **kw) -> Engine:
    """An engine with its real decode + live-translate workers running."""
    engine = make_engine(ports, **kw)
    return await create_engine(engine.cfg, ports)


async def push_audio(
    engine: Engine, source: Source, pcm: np.ndarray, *, chunk: int = SAMPLE_RATE // 4
) -> None:
    """Feed ``pcm`` through ``handle(MsgAudio(...))`` in real-capture-sized
    (quarter-second) batches -- Rust's own doc comments describe this as the
    normal per-lane cadence."""
    for i in range(0, len(pcm), chunk):
        await engine.handle(MsgAudio(source=source, rate=SAMPLE_RATE, samples=pcm[i : i + chunk]))


async def push_audio_interleaved(
    engine: Engine,
    source_a: Source,
    pcm_a: np.ndarray,
    source_b: Source,
    pcm_b: np.ndarray,
    *,
    chunk: int = SAMPLE_RATE // 4,
) -> None:
    """Feed two lanes the same stretch of audio in LOCKSTEP (alternating
    quarter-second batches) -- a sound reaching both the system output and the
    microphone at nearly the same wall-clock moment, the real ``echo_of``
    scenario. ``Lane.resync`` re-anchors a lane idle past ``LANE_RESYNC_GAP``
    (0.5 s) to the CURRENT timeline head rather than where it left off, so
    feeding one lane's whole clip and then the other's would put the two
    phrases on disjoint stretches of the timeline instead of overlapping --
    which is why this helper exists rather than two sequential
    :func:`push_audio` calls."""
    n = max(len(pcm_a), len(pcm_b))
    for i in range(0, n, chunk):
        if i < len(pcm_a):
            await engine.handle(
                MsgAudio(source=source_a, rate=SAMPLE_RATE, samples=pcm_a[i : i + chunk])
            )
        if i < len(pcm_b):
            await engine.handle(
                MsgAudio(source=source_b, rate=SAMPLE_RATE, samples=pcm_b[i : i + chunk])
            )


async def drain_decodes(engine: Engine, *, timeout: float = 90.0) -> None:
    """Pump :attr:`Engine.inbox`, routing every message through the real
    ``handle()``, until the decode pipeline is fully drained -- the same
    condition ``Engine.run()`` checks before ``finish()``. The decode itself
    runs for real on the background worker; this only waits for its result and
    feeds it back through ``handle()``, exactly like ``run()`` does."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while engine.decode_busy or engine.final_queue or engine.partial_pending is not None:
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise TimeoutError("decode pipeline did not drain in time")
        await engine.handle(await asyncio.wait_for(engine.inbox.get(), timeout=remaining))


async def close_and_drain_one_lane(engine: Engine, source: Source) -> None:
    """Force-close and fully decode/integrate ONE lane's open phrase, without
    touching the other -- lets a test control which lane's segment lands in
    ``meta.segments`` FIRST, independent of ``close_open_phrases``'s own fixed
    (mic-then-sys) iteration order."""
    flushed = engine._lane(source).flush_active()
    assert flushed is not None, f"test setup: the {source} lane had nothing open to close"
    start, audio = flushed
    engine.queue_final(source, start, audio)
    engine.dispatch_next()
    await drain_decodes(engine)


async def wait_until(predicate, *, timeout: float, message: str) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            pytest.fail(message)
        await asyncio.sleep(0.02)


def final_out(
    *,
    source: Source,
    start: int,
    n_samples: int,
    text: str,
    mean_p: float = 0.9,
    lang: str | None = "en",
    detected: tuple[str, float] | None = ("en", 0.9),
    err: str | None = None,
) -> DecodeOut:
    """A hand-built final :class:`DecodeOut`, matching the shape Rust's own
    reference tests use where the DECISION logic is what is under test rather
    than the decode."""
    t0 = cs_of_samples(start)
    t1 = cs_of_samples(start + n_samples)
    words = [(w, t0, t1) for w in text.split()]
    return DecodeOut(
        kind=JobKind.FINAL,
        source=source,
        start=start,
        n_samples=n_samples,
        segs=[SegOut(t0=t0, t1=t1, text=text, words=words, lang=lang, mean_p=mean_p)],
        detected=detected,
        emb=None,
        wins=[],
        err=err,
    )


# =============================================================================
# ---- Save / checkpoint_mark / FLUSH_RETRY_BACKOFF -- pure, hand-computed ---
# =============================================================================


def test_save_enum_and_backoff_constants() -> None:
    assert {s.value for s in Save} == {"checkpoint", "full", "transcript"}
    assert len({Save.CHECKPOINT, Save.FULL, Save.TRANSCRIPT}) == 3
    assert FLUSH_RETRY_BACKOFF == 5.0
    assert SAVE_FAILED == "The recording could not be saved into the room."
    assert LIVE_TRANSLATE_QUEUE == 8


def test_checkpoint_mark_hand_computed_cases() -> None:
    """The Rust unit test's own values
    (``a_checkpoint_stops_at_the_trailing_lane_but_never_stalls_on_a_silent_one``),
    plus the boundary cases either candidate had alone."""
    assert LANE_RESYNC_GAP == SAMPLE_RATE // 2 == 8000
    head = SAMPLE_RATE * 61
    # Both lanes in step: everything recorded is durable.
    assert checkpoint_mark(head, head, 0) == head
    # The meeting lane is 0.4 s behind -- under the resync bar, so it is still
    # going to write into that stretch. The checkpoint stops short.
    behind = head - SAMPLE_RATE * 2 // 5
    assert checkpoint_mark(behind, head, 0) == behind
    # A lane that stopped delivering mid-session: its position is frozen far
    # past the bar. The head, less the bar, is what gets written.
    assert checkpoint_mark(0, head, 0) == head - LANE_RESYNC_GAP
    # Nothing new since the last checkpoint: the mark can never go backwards
    # over audio already written.
    assert checkpoint_mark(head, head, head) == head
    assert checkpoint_mark(0, head, head) == head
    # Never past the head.
    assert checkpoint_mark(2 * head, head, 0) == head
    # The first beats of a session, before the bar is even a whole timeline
    # long -- and never negative.
    assert checkpoint_mark(0, 10, 0) == 0
    assert checkpoint_mark(0, 0, 0) == 0


def test_checkpoint_mark_lane_resync_gap_boundary() -> None:
    """The exact ``LANE_RESYNC_GAP`` boundary the Rust doc comment describes: at
    or below the bar a frozen lane's floor is exactly 0; one sample past it the
    floor advances sample for sample."""
    assert checkpoint_mark(0, LANE_RESYNC_GAP - 1, 0) == 0
    assert checkpoint_mark(0, LANE_RESYNC_GAP, 0) == 0
    assert checkpoint_mark(0, LANE_RESYNC_GAP + 1, 0) == 1
    boundary = 1_000_000 - LANE_RESYNC_GAP
    assert checkpoint_mark(boundary, 1_000_000, 0) == boundary
    # One sample WITHIN the gap (frozen more recently): the lane's own, higher
    # position wins over the head-relative floor.
    assert checkpoint_mark(boundary + 1, 1_000_000, 0) == boundary + 1


# =============================================================================
# ---- merge_phrase ----------------------------------------------------------
# =============================================================================


def test_merge_phrase_joins_nonempty_text_and_weights_mean_p_by_word_count() -> None:
    segs = [
        SegOut(t0=0, t1=100, text=" hello ", words=[("hello", 0, 100)], lang="en", mean_p=0.9),
        # Empty text: excluded from the joined text and the mean_p average, but
        # its words/lang are still merged unconditionally.
        SegOut(t0=100, t1=100, text="   ", words=[], lang="fr", mean_p=0.1),
        SegOut(t0=100, t1=250, text="world", words=[("world", 100, 250)], lang=None, mean_p=0.5),
    ]
    text, words, lang, mean_p = merge_phrase(segs)
    assert text == "hello world"
    assert [w.w for w in words] == ["hello", "world"]
    assert lang == "en"  # the first segment's lang, taken regardless of its text
    assert mean_p == pytest.approx((0.9 * 1 + 0.5 * 1) / 2)


def test_merge_phrase_lang_taken_from_the_first_segment_that_has_one() -> None:
    segs = [
        SegOut(t0=0, t1=50, text="", words=[], lang=None, mean_p=0.0),
        SegOut(t0=50, t1=50, text="   ", words=[], lang="he", mean_p=0.2),
        SegOut(t0=50, t1=100, text="shalom", words=[("shalom", 50, 100)], lang="he", mean_p=0.8),
    ]
    text, _words, lang, _mean_p = merge_phrase(segs)
    assert (text, lang) == ("shalom", "he")


def test_merge_phrase_empty_input_gives_defaults() -> None:
    assert merge_phrase([]) == ("", [], None, 0.0)


# =============================================================================
# ---- full pipeline: ingest -> VAD close -> dispatch -> integrate -> emit ---
# =============================================================================


@requires_all
async def test_full_pipeline_ingest_to_saved_recording(fox_pcm: np.ndarray) -> None:
    """The whole session, driven through the real :meth:`Engine.run` loop: real
    audio in, real whisper + TitaNet, a real WAV out."""
    audio = np.concatenate(
        [
            np.zeros(SAMPLE_RATE // 2, np.float32),
            fox_pcm,
            np.zeros(SAMPLE_RATE * 2, np.float32),
        ]
    )
    ports = FakePorts()
    engine = await make_live_engine(ports, model_path=MODEL_PATH, diarize_model_path=DIAR_MODEL_PATH)
    try:
        task = asyncio.create_task(engine.run())
        for i in range(0, len(audio), SAMPLE_RATE // 4):
            engine.send(MsgAudio(Source.SYS, SAMPLE_RATE, audio[i : i + SAMPLE_RATE // 4]))
        engine.send(MsgStop())
        outcome = await asyncio.wait_for(task, timeout=180)

        assert outcome is not None and outcome.ok and outcome.meta is not None
        meta = outcome.meta
        combined = " ".join(s.text for s in meta.segments).lower()
        assert "quick brown fox" in combined, combined
        assert all(s.source == "sys" for s in meta.segments)
        assert any(s.words for s in meta.segments), "no word timings"
        assert all(s.voice is not None for s in meta.segments), "voiceprint not attached"
        assert meta.duration_cs == cs_of_samples(len(audio))

        seg_events = ports.payloads("rec-segment")
        assert seg_events, "no rec-segment events emitted"
        assert seg_events[0]["fileId"] == "file-1"
        assert "voice" not in seg_events[0]["segment"], "the voiceprint left the process"

        full = ports.saves(Save.FULL)
        assert full and full[-1].wav is not None
        assert len(decode_wav(full[-1].wav)) == len(audio)
        assert "quick brown fox" in full[-1].text.lower()
        # The RecShared-equivalent plain attributes, readable without an event.
        assert engine.status == "saved"
        assert engine.duration_cs == cs_of_samples(len(audio))
    finally:
        await engine.aclose()


@requires_all
async def test_a_mic_phrase_becomes_You_and_keeps_its_print_only_internally(
    fox_pcm: np.ndarray,
) -> None:
    ports = FakePorts()
    engine = await make_live_engine(ports, model_path=MODEL_PATH, diarize_model_path=DIAR_MODEL_PATH)
    try:
        await push_audio(engine, Source.MIC, fox_pcm)
        engine.close_open_phrases()
        await drain_decodes(engine)

        assert len(engine.meta.segments) == 1
        seg = engine.meta.segments[0]
        assert seg.source == "mic"
        assert seg.speaker == "You"
        assert "fox" in seg.text.lower() or "dog" in seg.text.lower(), seg.text
        assert seg.voice is not None, (
            "the AUTHORITATIVE copy keeps its voiceprint even though the emitted event does not"
        )
        assert "voice" not in ports.payloads("rec-segment")[0]["segment"]
        assert engine.status == "recording"
    finally:
        await engine.aclose()


@requires_all
async def test_a_live_partial_is_decoded_and_painted_while_the_phrase_is_open(
    fox_pcm: np.ndarray,
) -> None:
    """``tick()`` schedules a partial once the open phrase has grown past
    ``PARTIAL_EVERY``; it decodes in ``Auto`` mode (pre-lock, no detector) and
    paints the ghost line."""
    ports = FakePorts()
    engine = await make_live_engine(ports, model_path=MODEL_PATH, diarize_model_path=DIAR_MODEL_PATH)
    try:
        await push_audio(engine, Source.MIC, fox_pcm)
        assert engine.mic.state is not None, "test setup: the phrase must still be open"
        engine.tick()
        assert engine.partial_pending is not None or engine.decode_busy, "no partial was scheduled"
        await drain_decodes(engine)

        partials = [p for p in ports.payloads("rec-partial") if p["source"] == "mic" and p["text"]]
        assert partials, "no live partial was ever painted"
        assert not engine.meta.segments, "a partial must never become a transcript row"
    finally:
        await engine.aclose()


# =============================================================================
# ---- cross-lane echo drop (echo_of) -- BOTH directions --------------------
# =============================================================================


@requires_all
async def test_echo_of_never_adds_the_mic_twin_when_the_sys_original_landed_first(
    launch_pcm: np.ndarray,
) -> None:
    """Both lanes hear the SAME clip in lockstep (a genuine, real-time overlap
    on the shared mixed timeline). Sys is closed and integrated FIRST, so by the
    time the mic's decode lands the sys row already exists and the mic twin must
    never be appended at all."""
    ports = FakePorts()
    engine = await make_live_engine(ports, model_path=MODEL_PATH, diarize_model_path=DIAR_MODEL_PATH)
    try:
        await push_audio_interleaved(engine, Source.SYS, launch_pcm, Source.MIC, launch_pcm)
        assert engine.sys.state is not None and engine.mic.state is not None, (
            "test setup: both phrases must still be open before either is force-closed"
        )

        await close_and_drain_one_lane(engine, Source.SYS)
        assert len(engine.meta.segments) == 1
        assert engine.meta.segments[0].source == "sys"

        await close_and_drain_one_lane(engine, Source.MIC)

        assert len(engine.meta.segments) == 1, engine.meta.segments
        assert engine.meta.segments[0].source == "sys"
        assert "launch" in engine.meta.segments[0].text.lower()
        mic_partials = [p for p in ports.payloads("rec-partial") if p["source"] == "mic"]
        assert mic_partials and mic_partials[-1]["text"] == "", "the mic ghost was not cleared"
        assert not ports.payloads("rec-segment-drop"), (
            "only an EXISTING row can be dropped; the mic echo here is simply never added"
        )
    finally:
        await engine.aclose()


@requires_all
async def test_echo_of_pulls_the_existing_mic_row_back_out_when_sys_lands_second(
    launch_pcm: np.ndarray,
) -> None:
    """The same lockstep overlap, but MIC is closed and integrated FIRST (so its
    row genuinely exists already) and SYS lands second. The system lane always
    wins -- it cannot hear the room, so whatever reaches it is what the computer
    actually played -- so the EARLIER mic row is the one pulled back out via
    ``rec-segment-drop``."""
    ports = FakePorts()
    engine = await make_live_engine(ports, model_path=MODEL_PATH, diarize_model_path=DIAR_MODEL_PATH)
    try:
        await push_audio_interleaved(engine, Source.SYS, launch_pcm, Source.MIC, launch_pcm)
        assert engine.sys.state is not None and engine.mic.state is not None

        await close_and_drain_one_lane(engine, Source.MIC)
        assert len(engine.meta.segments) == 1
        assert engine.meta.segments[0].source == "mic"
        mic_id = engine.meta.segments[0].id

        await close_and_drain_one_lane(engine, Source.SYS)

        assert len(engine.meta.segments) == 1, engine.meta.segments
        assert engine.meta.segments[0].source == "sys"
        drops = ports.payloads("rec-segment-drop")
        assert [d["id"] for d in drops] == [mic_id], "the earlier mic row must be dropped by id"
    finally:
        await engine.aclose()


async def test_a_dropped_echo_retracts_the_language_vote_it_cast_on_the_mic_lane() -> None:
    """The dropped row was meeting audio, not the room: a lock resting on that
    one final falls with it (``LaneLang.retract``)."""
    ports = FakePorts()
    engine = make_engine(ports)
    # A mic final that is long and confident enough to LOCK the mic lane.
    text = "we should move the whole launch to Friday afternoon instead"
    await engine.handle(MsgDecodeDone(final_out(
        source=Source.MIC, start=0, n_samples=SAMPLE_RATE * 4, text=text, detected=("en", 0.95)
    )))
    assert engine.lane_lang[Source.MIC.value].hint() == "en"
    assert engine.lane_lang[Source.MIC.value].lock_votes == 1, "the lock rests on that final alone"

    # The system lane then reports the same words at the same moment: an echo.
    await engine.handle(MsgDecodeDone(final_out(
        source=Source.SYS, start=0, n_samples=SAMPLE_RATE * 4, text=text, detected=("en", 0.95)
    )))
    assert [s.source for s in engine.meta.segments] == ["sys"]
    assert ports.payloads("rec-segment-drop"), "the mic row was not dropped"
    assert engine.lane_lang[Source.MIC.value].hint() is None, (
        "a lock resting only on the retracted final must fall with it"
    )


# =============================================================================
# ---- mic-degraded-echo-during-crosstalk guard (mean_p < 0.35) -------------
# =============================================================================


async def test_degraded_mic_echo_is_dropped_but_confident_speech_and_lone_speech_survive() -> None:
    """Rust's own reference case (``degraded_mic_echo_of_meeting_speech_is_dropped``):
    low confidence ALONE must never delete, and real mic speech during crosstalk
    decodes far more confidently and stays."""
    ports = FakePorts()
    engine = make_engine(ports)
    # A finished meeting phrase sits on the timeline at [0 s, 20 s].
    engine.meta.segments.append(
        RecSegment(
            id="sys-1",
            source="sys",
            speaker="Speaker 1",
            t0=0,
            t1=2000,
            text="important discussion about the roadmap",
            words=[],
            lang="en",
        )
    )

    def mic(mean_p: float, start: int) -> DecodeOut:
        # Text that shares no words with the sys row, so `echo_of`'s separate
        # text-match rule is isolated out and only this guard can fire.
        return final_out(
            source=Source.MIC, start=start, n_samples=SAMPLE_RATE * 2,
            text="Thank you.", mean_p=mean_p, detected=None,
        )

    # Garbage-confidence phrase inside the meeting speech: dropped.
    await engine.handle(MsgDecodeDone(mic(0.2, SAMPLE_RATE * 5)))
    assert len(engine.meta.segments) == 1, "the degraded echo was stored"
    assert ports.payloads("rec-partial")[-1]["text"] == "", "the mic ghost was not cleared"

    # A confident phrase at the same spot (real crosstalk): kept.
    await engine.handle(MsgDecodeDone(mic(0.8, SAMPLE_RATE * 5)))
    assert len(engine.meta.segments) == 2, "confident mic speech was dropped"

    # Low confidence but NO meeting speech anywhere near: kept.
    await engine.handle(MsgDecodeDone(mic(0.2, SAMPLE_RATE * 60)))
    assert len(engine.meta.segments) == 3, "low confidence alone must never delete"


@requires_all
async def test_the_crosstalk_guard_sees_the_sys_lanes_STILL_OPEN_phrase(
    fox_pcm: np.ndarray,
) -> None:
    """Real sys speech left genuinely mid-phrase (not yet closed) -- exactly the
    "a long monologue hasn't closed yet" case ``overlaps_sys_speech`` exists
    for, and the only path that reads ``Lane.state`` rather than the stored
    segments."""
    ports = FakePorts()
    engine = make_engine(ports)
    await push_audio(engine, Source.SYS, fox_pcm[: len(fox_pcm) // 2])
    assert engine.sys.state is not None, "test setup: the sys lane must still be mid-phrase"
    assert not engine.meta.segments, "no sys segment has landed, so only the open phrase can match"

    await engine.handle(MsgDecodeDone(final_out(
        source=Source.MIC, start=0, n_samples=SAMPLE_RATE, text="thank you thank you", mean_p=0.1
    )))
    assert not engine.meta.segments, "the degraded mic echo must not become a segment"

    await engine.handle(MsgDecodeDone(final_out(
        source=Source.MIC, start=0, n_samples=SAMPLE_RATE,
        text="a completely different real sentence", mean_p=0.95,
    )))
    assert [s.source for s in engine.meta.segments] == ["mic"]


# =============================================================================
# ---- empty finals, decode errors, stale partials, the live-STT gate -------
# =============================================================================


async def test_an_empty_final_clears_the_ghost_and_counts_as_a_dead_final() -> None:
    ports = FakePorts()
    engine = make_engine(ports)
    engine.lane_lang[Source.SYS.value].lock = "en"
    engine.lane_lang[Source.SYS.value].lock_votes = 5
    for i in range(3):
        await engine.handle(MsgDecodeDone(final_out(
            source=Source.SYS, start=SAMPLE_RATE * i, n_samples=SAMPLE_RATE, text="   "
        )))
    assert not engine.meta.segments
    assert ports.payloads("rec-partial")[-1] == {
        "fileId": "file-1", "source": "sys", "t0": 200, "text": ""
    }
    assert engine.lane_lang[Source.SYS.value].hint() is None, (
        "three consecutive dead finals must unlock a wrongly-locked lane"
    )


async def test_a_decode_failure_is_reported_exactly_once() -> None:
    ports = FakePorts()
    engine = make_engine(ports)
    for i in range(3):
        await engine.handle(MsgDecodeDone(final_out(
            source=Source.SYS, start=SAMPLE_RATE * i, n_samples=SAMPLE_RATE, text="",
            err=f"model broken {i}",
        )))
    errors = ports.errors()
    assert len(errors) == 1, f"a model that cannot decode fails on every phrase: {errors}"
    assert "could not transcribe part of this recording" in errors[0]
    assert "model broken 0" in errors[0]


async def test_a_partial_for_a_phrase_that_already_finalized_is_suppressed() -> None:
    ports = FakePorts()
    engine = make_engine(ports)
    engine.last_final_start[Source.SYS.value] = SAMPLE_RATE * 2
    stale = DecodeOut(
        kind=JobKind.PARTIAL, source=Source.SYS, start=SAMPLE_RATE, n_samples=SAMPLE_RATE,
        segs=[SegOut(t0=100, t1=200, text="stale ghost", words=[], lang="en", mean_p=0.9)],
        detected=None, emb=None, wins=[], err=None,
    )
    await engine.handle(MsgDecodeDone(stale))
    assert not ports.payloads("rec-partial"), "a stale partial must not repaint the ghost line"

    fresh = DecodeOut(**{**stale.__dict__, "start": SAMPLE_RATE * 3})
    await engine.handle(MsgDecodeDone(fresh))
    assert [p["text"] for p in ports.payloads("rec-partial")] == ["stale ghost"]


async def test_live_stt_off_abandons_open_phrases_clears_ghosts_and_ignores_late_partials() -> None:
    ports = FakePorts()
    engine = make_engine(ports)
    await push_audio(engine, Source.MIC, np.full(SAMPLE_RATE * 2, 0.3, np.float32))
    engine.partial_pending = DecodeJob(
        kind=JobKind.PARTIAL, source=Source.MIC, start=0, samples=np.zeros(16, np.float32)
    )

    await engine.handle(MsgSetLiveStt(on=False))
    assert engine.live_stt is False
    assert engine.partial_pending is None
    assert engine.mic.state is None and engine.sys.state is None
    assert [(p["source"], p["text"]) for p in ports.payloads("rec-partial")] == [
        ("mic", ""), ("sys", "")
    ]
    assert not engine.final_queue, "an abandoned phrase must not be queued for decode"

    # A partial already in the decoder must not repaint the line that switch
    # just cleared -- nothing else would ever clear it again.
    ports.events.clear()
    await engine.handle(MsgDecodeDone(DecodeOut(
        kind=JobKind.PARTIAL, source=Source.MIC, start=SAMPLE_RATE, n_samples=SAMPLE_RATE,
        segs=[SegOut(t0=100, t1=200, text="ghost", words=[], lang="en", mean_p=0.9)],
        detected=None, emb=None, wins=[], err=None,
    )))
    assert not ports.payloads("rec-partial")

    # A closed phrase while OFF is dropped, not decoded.
    await engine.handle(MsgSetLiveStt(on=True))
    assert engine.live_stt is True


def test_dispatch_stamps_the_lane_lock_at_dispatch_not_at_enqueue() -> None:
    """A queued final must feel the lock the PREVIOUS final just established --
    and finals outrank partials."""
    ports = FakePorts()
    engine = make_engine(ports)
    engine.queue_final(Source.SYS, 0, np.zeros(SAMPLE_RATE, np.float32))
    engine.partial_pending = DecodeJob(
        kind=JobKind.PARTIAL, source=Source.SYS, start=0, samples=np.zeros(16, np.float32)
    )
    engine.lane_lang[Source.SYS.value].lock = "he"

    engine.dispatch_next()
    assert engine.decode_busy is True
    job = engine._job_queue.get_nowait()
    assert job.kind is JobKind.FINAL, "finals outrank partials"
    assert job.lang == "he", "the lock must be stamped at dispatch"
    assert engine.partial_pending is not None, "the partial stays pending behind the final"


def test_queueing_a_final_retires_that_lanes_pending_partial() -> None:
    """The phrase the partial belonged to is over, so decoding that snapshot
    would re-emit a ghost line AFTER the real transcript row for the same
    words."""
    ports = FakePorts()
    engine = make_engine(ports)
    engine.partial_pending = DecodeJob(
        kind=JobKind.PARTIAL, source=Source.MIC, start=0, samples=np.zeros(16, np.float32)
    )
    engine.queue_final(Source.SYS, 0, np.zeros(16, np.float32))
    assert engine.partial_pending is not None, "the OTHER lane's partial is untouched"
    engine.queue_final(Source.MIC, 0, np.zeros(16, np.float32))
    assert engine.partial_pending is None


# =============================================================================
# ---- pause / resume, incl. the pause_pending late-final follow-up ---------
# =============================================================================


@requires_all
async def test_pause_saves_full_then_the_late_final_lands_as_a_transcript_save(
    fox_pcm: np.ndarray,
) -> None:
    """Driven through ``handle()``/``tick()`` directly, so every step is
    individually observable."""
    ports = FakePorts()
    engine = await make_live_engine(
        ports, system_audio=True, model_path=MODEL_PATH, diarize_model_path=DIAR_MODEL_PATH
    )
    try:
        await engine.handle(MsgSysTapResult(ok=True))
        assert engine.sys_tap_up is True
        # Feed only part of the clip so a phrase is still open when Pause lands
        # -- close_open_phrases() force-closes it into the decoder, and Pause's
        # own save must not wait for that decode.
        await push_audio(engine, Source.MIC, fox_pcm[: len(fox_pcm) * 3 // 4])
        assert engine.mic.state is not None, "test setup: the phrase must still be open"

        await engine.handle(MsgPause())
        assert engine.paused is True
        assert engine.status == "paused"
        assert engine.sys_tap_up is False and ports.sys_tap_stops == 1
        assert ports.saves(Save.FULL), "Pause must persist a Save.FULL immediately"
        assert engine.pause_pending is True, "the force-closed final was still queued/decoding"

        await drain_decodes(engine)
        # The same check `Engine.run()`'s loop performs on every iteration --
        # exercised directly here since this test never spins up run().
        assert engine.pause_pending and engine.paused and not engine.decode_busy
        engine.pause_pending = False
        assert await engine.flush(Save.TRANSCRIPT) is True

        transcript = ports.saves(Save.TRANSCRIPT)
        assert transcript, "the late-landing final must trigger the Transcript follow-up"
        assert transcript[-1].wav is None, "the pause follow-up must not touch the audio"
        assert transcript[-1].checkpoint_pcm is None
        assert "fox" in transcript[-1].text.lower() or "dog" in transcript[-1].text.lower()
        # The audio was made durable by Pause's own write and cannot have grown.
        assert engine.flushed_samples == len(engine.mixed)

        await engine.handle(MsgResume())
        assert engine.paused is False and engine.pause_pending is False
        assert engine.status == "recording"
        assert engine.mic.resync is True and engine.sys.resync is True
        assert ports.sys_tap_requests == 1, "Resume must re-request the tap"
    finally:
        await engine.aclose()


@requires_all
async def test_the_run_loop_itself_fires_the_pause_follow_up_save(fox_pcm: np.ndarray) -> None:
    """The same behavior, but reached through :meth:`Engine.run`'s own
    post-tick check rather than simulated by the test."""
    # NO trailing silence: the phrase is still OPEN when Pause force-closes it.
    audio = np.concatenate([np.zeros(SAMPLE_RATE // 3, np.float32), fox_pcm])
    ports = FakePorts()
    engine = await make_live_engine(ports, model_path=MODEL_PATH, diarize_model_path=DIAR_MODEL_PATH)
    task = asyncio.create_task(engine.run())
    try:
        engine.send(MsgAudio(Source.SYS, SAMPLE_RATE, audio))
        engine.send(MsgPause())
        await wait_until(
            lambda: bool(ports.saves(Save.TRANSCRIPT)),
            timeout=180,
            message="the pause follow-up save never landed",
        )
        assert ports.saves(Save.FULL)[0].wav is not None, "pause's own Save.FULL never landed"
        last = ports.saves(Save.TRANSCRIPT)[-1]
        assert last.wav is None and last.checkpoint_pcm is None
        assert "quick brown fox" in last.text.lower()
        assert engine.paused is True and engine.pause_pending is False
        assert engine.status == "paused"
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        await engine.aclose()


async def test_a_tap_that_comes_up_after_pause_or_stop_is_torn_down_immediately() -> None:
    """Never keep two taps: the meeting would be recorded and transcribed
    twice, and the abandoned one would capture for the rest of the session."""
    for arrange in ("paused", "stopping", "already-up"):
        ports = FakePorts()
        engine = make_engine(ports, system_audio=True)
        await engine.start_sys_tap()
        assert engine.sys_tap_starting is True and ports.sys_tap_requests == 1
        # A second request inside the start window must not fire.
        await engine.start_sys_tap()
        assert ports.sys_tap_requests == 1

        if arrange == "paused":
            engine.paused = True
        elif arrange == "stopping":
            engine.stopping = True
        else:
            engine.sys_tap_up = True

        await engine.handle(MsgSysTapResult(ok=True))
        assert engine.sys_tap_starting is False
        assert ports.sys_tap_stops == 1, f"[{arrange}] the late tap was not torn down"
        if arrange != "already-up":
            assert engine.sys_tap_up is False


async def test_a_failed_tap_is_reported_on_the_sys_source_and_the_health_is_durable() -> None:
    ports = FakePorts()
    engine = make_engine(ports, system_audio=True)
    await engine.start_sys_tap()
    await engine.handle(MsgSysTapResult(ok=False, error="Screen Recording denied"))
    assert engine.sources[1] == ("error", "Screen Recording denied")
    assert ports.payloads("rec-source")[-1]["status"] == "error"
    assert engine.sys_lane().value == "off"


# =============================================================================
# ---- the 3-hour MAX_SESSION_SAMPLES ceiling -------------------------------
# =============================================================================


async def test_max_session_samples_ceiling_forces_a_clean_self_stop() -> None:
    ports = FakePorts()
    engine = make_engine(ports)
    engine.mic.ingested = MAX_SESSION_SAMPLES - 500
    await engine.handle(MsgAudio(Source.MIC, SAMPLE_RATE, np.zeros(1000, np.float32)))

    assert engine.stopping is True
    assert engine.status == "saving"
    assert engine.stop_reply is None, "a self-stop has nobody to answer"
    assert any("3-hour session limit" in m for m in ports.errors())
    assert len(engine.mixed) == 0, "the over-ceiling batch must not be mixed in"

    await engine.finish()
    assert engine.status == "saved"
    assert engine.outcome is not None and engine.outcome.ok and engine.outcome.meta is not None


async def test_a_stop_that_races_a_self_stop_is_still_answered() -> None:
    """Rust's ``begin_stop`` is idempotent: a second call only adopts a reply
    channel, so a user Stop arriving after the engine stopped itself is
    answered instead of finding a finished engine."""
    ports = FakePorts()
    engine = make_engine(ports)
    await engine.begin_stop(None)
    assert engine.stopping is True and engine.stop_reply is None
    saves_before = len(ports.persists)

    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    await engine.handle(MsgStop(done=fut))
    assert engine.stop_reply is fut
    assert len(ports.persists) == saves_before, "the second Stop must not re-run the drain's save"

    await engine.finish()
    meta = await asyncio.wait_for(fut, timeout=5)
    assert meta.duration_cs == 0


# =============================================================================
# ---- persist() failures: PersistFailed backoff, RoomClosed clean stop -----
# =============================================================================


async def test_persist_failed_on_a_checkpoint_reports_once_per_outage_not_once_per_batch() -> None:
    ports = FakePorts(fail_next=1, fail_exc=PersistFailed("disk full"))
    engine = make_engine(ports)
    await engine.handle(MsgAudio(Source.MIC, SAMPLE_RATE, np.full(SAMPLE_RATE, 0.05, np.float32)))

    assert await engine.flush(Save.CHECKPOINT) is False
    assert engine.flushed_samples == 0, "the failed range was marked durable"
    assert engine.flush_failed_at is not None
    assert len(ports.errors()) == 1
    assert "retrying" in ports.errors()[0] and "disk full" in ports.errors()[0]

    # Immediately again, still inside the backoff window: the retry itself runs
    # (ingest triggers one for every batch once the tail is dirty), but it must
    # not re-announce itself.
    ports.fail_next = 1
    assert await engine.flush(Save.CHECKPOINT) is False
    assert len(ports.errors()) == 1

    # The backoff window elapses: the same failure reports again.
    engine.flush_failed_at = time.monotonic() - FLUSH_RETRY_BACKOFF - 0.01
    ports.fail_next = 1
    assert await engine.flush(Save.CHECKPOINT) is False
    assert len(ports.errors()) == 2

    # A save someone ASKED for (the engine is stopping) always answers, backoff
    # or not -- pause/stop must never smile through a failure.
    engine.stopping = True
    ports.fail_next = 1
    assert await engine.flush(Save.CHECKPOINT) is False
    assert len(ports.errors()) == 3
    assert SAVE_FAILED in ports.errors()[-1]
    ports.fail_next = 1
    assert await engine.flush(Save.CHECKPOINT) is False
    assert len(ports.errors()) == 4, "an explicit save must report on EVERY attempt"

    # Recovery: once persist stops failing, the whole dirty tail lands.
    engine.stopping = False
    ports.fail_next = 0
    assert await engine.flush(Save.CHECKPOINT) is True
    assert engine.flush_failed_at is None
    assert engine.flushed_samples > 0
    assert ports.saves(Save.CHECKPOINT)[-1].checkpoint_pcm is not None


async def test_room_closed_stops_the_engine_quietly_and_fails_the_final_write() -> None:
    ports = FakePorts(fail_next=99, fail_exc=RoomClosed())
    engine = make_engine(ports)
    assert engine.stopping is False

    assert await engine.flush(Save.CHECKPOINT) is False
    assert engine.stopping is True
    assert engine.stop_reply is None
    assert any("room closed" in m.lower() for m in ports.errors())
    assert engine.flush_failed_at is None, "a closed room is not a retryable write failure"

    # Idempotent: a second failure while already stopping does not crash.
    assert await engine.flush(Save.CHECKPOINT) is False
    assert engine.stopping is True

    # The final write cannot land either, so the session ends "failed", not a
    # green badge next to a red error.
    await engine.finish()
    assert engine.status == "failed"
    assert engine.outcome is not None and engine.outcome.ok is False
    assert engine.outcome.error == SAVE_FAILED and engine.outcome.meta is None


async def test_a_failed_final_write_fails_the_stop_rather_than_smiling_through_it() -> None:
    ports = FakePorts(fail_next=99, fail_exc=PersistFailed("disk full"))
    engine = make_engine(ports)
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    await engine.begin_stop(fut)
    await engine.finish()
    assert engine.status == "failed"
    with pytest.raises(RuntimeError, match=SAVE_FAILED):
        await asyncio.wait_for(fut, timeout=5)


# =============================================================================
# ---- flush(): what each Save kind actually hands the port -----------------
# =============================================================================


async def test_each_save_kind_hands_the_port_exactly_what_it_should() -> None:
    ports = FakePorts()
    engine = make_engine(ports)
    await push_audio(engine, Source.MIC, np.full(SAMPLE_RATE * 2, 0.02, np.float32))
    # Only the mic lane ever delivered, so the sys lane sits at its base
    # position; `write_floor` answers the head for a lane still waiting to
    # (re)start, which is what keeps checkpoints from stalling forever.
    assert engine.sys.write_floor(len(engine.mixed)) == len(engine.mixed)

    assert await engine.flush(Save.CHECKPOINT) is True
    cp = ports.saves(Save.CHECKPOINT)[-1]
    assert cp.wav is None
    assert cp.checkpoint_pcm is not None
    assert len(cp.checkpoint_pcm) == engine.flushed_samples > 0
    assert cp.text.startswith("(live recording)")

    assert await engine.flush(Save.FULL) is True
    full = ports.saves(Save.FULL)[-1]
    assert full.checkpoint_pcm is None
    assert full.wav is not None
    assert len(decode_wav(full.wav)) == len(engine.mixed)
    assert engine.flushed_samples == len(engine.mixed)
    assert ports.payloads("room-files-changed"), "a full write changes the file list"

    assert await engine.flush(Save.TRANSCRIPT) is True
    tr = ports.saves(Save.TRANSCRIPT)[-1]
    assert tr.wav is None and tr.checkpoint_pcm is None


async def test_a_checkpoint_stops_at_the_trailing_lane_but_never_stalls_on_a_frozen_one() -> None:
    """The watermark math, end to end through :meth:`Engine.flush` rather than
    only through :func:`checkpoint_mark`."""
    ports = FakePorts()
    engine = make_engine(ports)
    quarter = np.full(SAMPLE_RATE // 4, 0.02, np.float32)
    # Both lanes deliver, the sys lane one batch behind: the checkpoint stops at
    # the trailing lane, because it still owes the samples in between.
    for _ in range(8):
        await engine.handle(MsgAudio(Source.MIC, SAMPLE_RATE, quarter))
        await engine.handle(MsgAudio(Source.SYS, SAMPLE_RATE, quarter))
    await engine.handle(MsgAudio(Source.MIC, SAMPLE_RATE, quarter))
    head = len(engine.mixed)
    assert engine.sys.ingested < head
    await engine.flush(Save.CHECKPOINT)
    assert engine.flushed_samples == engine.sys.ingested < head

    # The sys lane now dies mid-session: its position freezes. Past
    # LANE_RESYNC_GAP the head (less the bar) wins, or one dead lane would cost
    # the whole recording rather than a fifth of a second.
    frozen_at = engine.sys.ingested
    for _ in range(8):
        await engine.handle(MsgAudio(Source.MIC, SAMPLE_RATE, quarter))
    head = len(engine.mixed)
    assert head - frozen_at > LANE_RESYNC_GAP
    await engine.flush(Save.CHECKPOINT)
    assert engine.flushed_samples == head - LANE_RESYNC_GAP


# =============================================================================
# ---- EditMeta -------------------------------------------------------------
# =============================================================================


async def test_edit_meta_applies_persists_now_and_answers_with_the_stored_meta() -> None:
    """Nothing may edit a LIVE recording's meta except through here -- a write
    straight to the room's row is erased by the next flush, in silence."""
    ports = FakePorts()
    engine = make_engine(ports)
    fut: asyncio.Future = asyncio.get_running_loop().create_future()

    def rename(meta: RecMeta) -> None:
        meta.speaker_names["Speaker 1"] = "Dana"
        return None

    await engine.handle(MsgEditMeta(apply=rename, done=fut))
    stored = await asyncio.wait_for(fut, timeout=5)
    assert stored.speaker_names == {"Speaker 1": "Dana"}
    assert engine.meta.speaker_names == {"Speaker 1": "Dana"}
    # Persisted NOW, not at the next scheduled flush: a rename the user can see
    # but a crash would lose is not saved.
    assert ports.saves(Save.CHECKPOINT), "the edit was not persisted immediately"
    assert '"Dana"' in ports.saves(Save.CHECKPOINT)[-1].meta_json

    # A refusal is reported and changes nothing.
    fail: asyncio.Future = asyncio.get_running_loop().create_future()
    saves = len(ports.persists)
    await engine.handle(MsgEditMeta(apply=lambda m: "that speaker does not exist", done=fail))
    with pytest.raises(RuntimeError, match="that speaker does not exist"):
        await asyncio.wait_for(fail, timeout=5)
    assert len(ports.persists) == saves, "a refused edit must not persist"


# =============================================================================
# ---- relabel_speakers / split_speakers via REAL diarize clustering --------
# =============================================================================


@requires_diar
async def test_relabel_speakers_separates_two_real_voices_via_real_clustering(
    fox_pcm: np.ndarray, fred_pcm: np.ndarray
) -> None:
    ports = FakePorts()
    engine = make_engine(ports, diarize_model_path=DIAR_MODEL_PATH)
    # Alternating turns, all provisionally mislabeled "Speaker 1" -- exactly
    # what a fast live pass, biased toward NOT opening new voices, leaves
    # behind. Real TitaNet embeddings, real audio.
    t = 0
    for i, clip in enumerate([fox_pcm, fred_pcm, fox_pcm, fred_pcm]):
        emb = diar_embed.embed(DIAR_MODEL_PATH, clip)
        assert emb.vec.shape[0] == diar_embed.EMB_DIM, "TitaNet model missing/broken"
        dur = cs_of_samples(len(clip))
        engine.meta.segments.append(
            RecSegment(
                id=str(uuid.uuid4()), source="sys", speaker="Speaker 1", t0=t, t1=t + dur,
                text=f"turn {i}", words=[], lang="en", voice=emb,
            )
        )
        t += dur + 500  # a real gap between turns

    engine.relabel_speakers()

    labels = [s.speaker for s in engine.meta.segments]
    assert len(set(labels)) == 2, f"two real, distinct voices should separate: {labels}"
    assert {labels[0], labels[2]} != {labels[1], labels[3]}, labels
    assert len({labels[0], labels[2]}) == 1 and len({labels[1], labels[3]}) == 1, labels
    relabels = ports.payloads("rec-relabel")
    assert relabels, "no rec-relabel event for a real label change"
    assert sorted(relabels[-1]) == ["fileId", "labels", "recognized", "speakerNames"]
    # The countdown is rescheduled from how long the pass actually took.
    assert 2 <= engine.relabel_countdown <= 64


@requires_diar
async def test_split_speakers_cuts_a_real_two_voice_phrase_from_the_mixed_timeline(
    fox_pcm: np.ndarray, fred_pcm: np.ndarray
) -> None:
    """One segment whose audio is really two different speakers glued back to
    back, with NO ``win_cache`` entry -- exercises the fallback that re-embeds
    sub-windows from ``self.mixed`` on the spot (resumed history, or pieces from
    an earlier pause)."""
    ports = FakePorts()
    engine = make_engine(ports, diarize_model_path=DIAR_MODEL_PATH)
    combined = np.concatenate([fox_pcm, fred_pcm]).astype(np.float32)
    engine.mixed = combined
    assert engine.mixed.dtype == np.float32 and len(engine.mixed) == len(combined)
    t1 = cs_of_samples(len(combined))
    n_words = 12
    engine.meta.segments = [
        RecSegment(
            id="whole", source="sys", speaker="Speaker 1", t0=0, t1=t1,
            text="a run-on phrase spanning two real voices",
            words=[
                RecWord(w=f"w{i}", t0=int(t1 * i / n_words), t1=int(t1 * (i + 1) / n_words))
                for i in range(n_words)
            ],
            lang="en",
        )
    ]

    engine.split_speakers()

    assert len(engine.meta.segments) >= 2, "the two-voice phrase must be cut"
    assert len({s.speaker for s in engine.meta.segments}) >= 2, (
        f"the pieces must carry different speakers: {[s.speaker for s in engine.meta.segments]}"
    )


@requires_diar
async def test_split_speakers_prefers_the_decode_time_window_cache(
    fox_pcm: np.ndarray, fred_pcm: np.ndarray
) -> None:
    """The prints the decode worker already computed are used as-is -- the
    mixed timeline is only the fallback."""
    ports = FakePorts()
    engine = make_engine(ports, diarize_model_path=DIAR_MODEL_PATH)
    voice_a = diar_embed.embed(DIAR_MODEL_PATH, fox_pcm)
    voice_b = diar_embed.embed(DIAR_MODEL_PATH, fred_pcm)
    assert voice_a.is_strong() and voice_b.is_strong(), "fixtures too short to define a voice"
    engine.meta.segments = [
        RecSegment(id="a", source="sys", speaker="Speaker 1", t0=0, t1=300, text="one",
                   words=[RecWord(w="one", t0=0, t1=300)], voice=voice_a),
        RecSegment(id="b", source="sys", speaker="Speaker 1", t0=400, t1=700, text="two",
                   words=[RecWord(w="two", t0=400, t1=700)], voice=voice_b),
    ]
    # No mixed timeline at all behind these rows: only the cache can answer.
    engine.win_cache["a"] = [(0, 300, voice_a)]
    engine.win_cache["b"] = [(400, 700, voice_b)]

    engine.split_speakers()

    assert len({s.speaker for s in engine.meta.segments}) == 2, (
        "two clearly different real voices collapsed into one label"
    )


# =============================================================================
# ---- retranscribe(): end to end, stop() abort, cuts survive re-marking ----
# =============================================================================


@requires_all
def test_retranscribe_rebuilds_a_corrupted_transcript_and_preserves_the_users_edits(
    fox_pcm: np.ndarray, fred_pcm: np.ndarray
) -> None:
    gap = np.zeros(SAMPLE_RATE * 3 // 2, np.float32)
    samples = np.concatenate([np.zeros(SAMPLE_RATE // 2, np.float32), fox_pcm, gap, fred_pcm, gap])
    prior = RecMeta(
        duration_cs=cs_of_samples(len(samples)),
        segments=[
            RecSegment(id="junk", source="mic", speaker="You", t0=0, t1=50, text="��",
                       words=[RecWord(w="�", t0=0, t1=50)], lang="en")
        ],
        cuts=[RecCut(t0=10, t1=20)],
        max_speakers=0,
        speaker_names={"Speaker 1": "Dana", "Speaker 2": "Guessed"},
        recognized={"Guessed"},
    )

    ticks: list[tuple[int, int]] = []
    meta = retranscribe(
        MODEL_PATH, samples, prior, [], DIAR_MODEL_PATH, lambda d, t: ticks.append((d, t)),
        lambda: False,
    )

    shown = "\n".join(f"{s.source}/{s.speaker}: {s.text}" for s in meta.segments)
    lowered = shown.lower()
    assert "quick brown fox" in lowered, shown
    assert "tomorrow" in lowered or "agenda" in lowered, shown
    assert "�" not in shown, f"the old corrupted text survived:\n{shown}"

    speakers = {s.speaker for s in meta.segments}
    assert len(speakers) >= 2, f"two voices became {speakers}:\n{shown}"
    assert all(sp.startswith("Speaker ") for sp in speakers), (
        f"the mixed file has no lane identity -- nobody may become 'You': {speakers}"
    )
    assert all(s.source == "sys" for s in meta.segments)
    assert any(s.words for s in meta.segments), "no word timings"
    assert all(s.voice is not None for s in meta.segments), "voiceprints not kept"

    assert meta.duration_cs == cs_of_samples(len(samples))
    assert meta.cuts == prior.cuts, "the user's studio deletions must survive"
    assert meta.max_speakers == prior.max_speakers
    assert "Dana" in meta.speaker_names.values(), "the TYPED speaker name was thrown away"
    assert "Guessed" not in meta.speaker_names.values(), (
        "a GUESS must not outlive the labels it was made about"
    )
    assert meta.read_of is None, "the room's reading is stale the moment the words are rebuilt"
    # The caller's own meta is never touched.
    assert prior.speaker_names == {"Speaker 1": "Dana", "Speaker 2": "Guessed"}

    assert ticks[-1] == (meta.duration_cs, meta.duration_cs)
    assert all(a[0] <= b[0] and a[1] == b[1] for a, b in zip(ticks, ticks[1:])), (
        f"progress must be monotone over a fixed total: {ticks}"
    )
    # Only the LAST tick reports done: the speaker pass runs after the final
    # phrase and takes tens of seconds on a long meeting.
    assert all(d < t for d, t in ticks[:-1]), f"the decode pass claimed the whole bar: {ticks}"


@requires_all
def test_retranscribe_marks_every_word_inside_a_carried_over_cut_as_deleted(
    fox_pcm: np.ndarray,
) -> None:
    samples = np.concatenate(
        [np.zeros(SAMPLE_RATE // 2, np.float32), fox_pcm, np.zeros(SAMPLE_RATE, np.float32)]
    )
    total_cs = cs_of_samples(len(samples))
    # A cut spanning the ENTIRE recording -- deterministic regardless of the
    # exact word timings a real decode produces.
    prior = RecMeta(duration_cs=total_cs, cuts=[RecCut(t0=0, t1=total_cs)])
    meta = retranscribe(MODEL_PATH, samples, prior, [], DIAR_MODEL_PATH, lambda d, t: None,
                        lambda: False)
    all_words = [w for s in meta.segments for w in s.words]
    assert all_words, "no words decoded"
    assert all(w.del_ for w in all_words), "a whole-recording cut must delete every word"
    assert meta.cuts == prior.cuts


@requires_all
def test_retranscribe_leaves_words_outside_a_cut_untouched(fox_pcm: np.ndarray) -> None:
    # A first pass (no cuts) discovers real word timestamps to build a cut from.
    first = retranscribe(MODEL_PATH, fox_pcm, RecMeta(), [], DIAR_MODEL_PATH, lambda d, t: None,
                         lambda: False)
    assert first.segments and first.segments[0].words, "need a real word to build a cut around"
    w = first.segments[0].words[0]

    prior = RecMeta(duration_cs=0, cuts=[RecCut(t0=w.t0, t1=w.t1 + 1)])
    second = retranscribe(MODEL_PATH, fox_pcm, prior, [], DIAR_MODEL_PATH, lambda d, t: None,
                          lambda: False)
    inside = [x for x in second.segments[0].words if x.t0 < w.t1 + 1 and x.t1 > w.t0]
    assert inside, "no word landed inside the carried-over cut"
    assert all(x.del_ for x in inside)
    assert not any(x.del_ for x in second.segments[0].words if x.t1 <= w.t0)


def test_retranscribe_stop_aborts_before_any_decode() -> None:
    """Mirrors Rust's ``a_stopped_rebuild_gives_up_before_it_decodes_anything``
    -- no real model is needed to prove ``stop()`` is honored before the
    decoder, because a stopped rebuild never reaches one."""
    samples = np.full(SAMPLE_RATE * 3, 0.2, np.float32)
    prior = RecMeta(duration_cs=cs_of_samples(len(samples)), cuts=[RecCut(t0=10, t1=20)],
                    speaker_names={"Speaker 1": "Dana"})
    ticks = 0

    def progress(_done: int, _total: int) -> None:
        nonlocal ticks
        ticks += 1

    with pytest.raises(RetranscribeStopped) as exc_info:
        retranscribe(NO_MODEL, samples, prior, [], None, progress, lambda: True)

    assert str(exc_info.value) == RETRANSCRIBE_STOPPED
    assert "unchanged" in str(exc_info.value)
    assert ticks == 0, "a stopped rebuild decoded a phrase anyway"


@requires_all
def test_retranscribe_stop_aborts_mid_pass(fox_pcm: np.ndarray) -> None:
    samples = np.concatenate([fox_pcm, np.zeros(SAMPLE_RATE, np.float32), fox_pcm])
    calls = {"n": 0}

    def stop() -> bool:
        calls["n"] += 1
        return calls["n"] > 3  # let a few polls pass, then abort mid-pass

    with pytest.raises(RetranscribeStopped):
        retranscribe(MODEL_PATH, samples, RecMeta(), [], DIAR_MODEL_PATH, lambda d, t: None, stop)
    assert calls["n"] > 3


# =============================================================================
# ---- live translation ------------------------------------------------------
# =============================================================================


def test_room_translation_model_is_the_configured_default() -> None:
    assert room_translation_model("qwen3.5:4b") == "qwen3.5:4b"
    assert room_translation_model(None) is None


async def test_the_live_translate_worker_emits_rec_live_translation() -> None:
    ports = FakePorts(translate_result="שלום")
    engine = await make_live_engine(
        ports, live_translate="he", default_translation_model="qwen3.5:4b"
    )
    try:
        seg = RecSegment(id="s1", source="mic", speaker="You", t0=0, t1=100, text="hello",
                         words=[], lang="en")
        engine.translate_tx.push(seg, "he")
        await wait_until(
            lambda: bool(ports.payloads("rec-live-translation")),
            timeout=5,
            message="the live-translate worker never emitted",
        )
        assert ports.payloads("rec-live-translation")[0] == {
            "fileId": "file-1", "segId": "s1", "text": "שלום"
        }
        assert ports.translate_calls == [("hello", "he", "qwen3.5:4b")]
    finally:
        await engine.aclose()


async def test_the_translate_ring_drops_the_OLDEST_waiting_line_not_the_newest() -> None:
    """A bounded channel alone dropped the wrong end: ``try_send`` on a full
    channel throws away the sentence just spoken and keeps delivering the stale
    ones behind it, so a fast stretch of a meeting is exactly the part that
    never gets translated."""
    ports = FakePorts()
    engine = make_engine(ports)
    for i in range(LIVE_TRANSLATE_QUEUE + 3):
        engine.translate_tx.push(
            RecSegment(id=f"s{i}", source="sys", speaker="Speaker 1", t0=i, t1=i + 1,
                       text=f"line {i}", words=[]),
            "he",
        )
    waiting = [seg.id for seg, _lang in engine.translate_tx.waiting]
    assert len(waiting) == LIVE_TRANSLATE_QUEUE
    assert waiting[-1] == f"s{LIVE_TRANSLATE_QUEUE + 2}", "the newest line must always get in"
    assert waiting[0] == "s3", "the oldest waiting lines are the ones given up"


async def test_a_translation_failure_is_never_fatal() -> None:
    ports = FakePorts(translate_result=None)
    engine = await make_live_engine(
        ports, live_translate="he", default_translation_model="qwen3.5:4b"
    )
    try:
        for i in range(2):
            engine.translate_tx.push(
                RecSegment(id=f"s{i}", source="sys", speaker="Speaker 1", t0=0, t1=1,
                           text=f"line {i}", words=[]),
                "he",
            )
        await wait_until(
            lambda: len(ports.translate_calls) == 2,
            timeout=5,
            message="the worker stopped after the first failure",
        )
        assert not ports.payloads("rec-live-translation")
    finally:
        await engine.aclose()


# =============================================================================
# ============================== REGRESSIONS ==================================
# Each of these pins a defect the differential cross-check found in one of the
# two candidate ports (or, for the last two, in BOTH).
# =============================================================================


async def test_stop_sys_tap_is_a_no_op_when_no_tap_is_up() -> None:
    """Rust's whole body is ``if let Some(tap) = self.sys_tap.take() {
    tap.stop(); }``. One candidate signalled the renderer unconditionally, which
    sends a release for a capture that was never started -- on every pause and
    every stop of a microphone-only recording, and while a tap is still coming
    up (which the ``MsgSysTapResult`` arm is what tears down)."""
    # system_audio on, but the tap never came up.
    ports = FakePorts()
    engine = make_engine(ports, system_audio=True)
    await engine.handle(MsgPause())
    assert ports.sys_tap_stops == 0

    # system_audio off: no tap was ever even asked for.
    ports = FakePorts()
    engine = make_engine(ports, system_audio=False)
    await engine.begin_stop(None)
    assert ports.sys_tap_stops == 0

    # A tap still STARTING is not stopped either -- it is torn down on arrival.
    ports = FakePorts()
    engine = make_engine(ports, system_audio=True)
    await engine.start_sys_tap()
    await engine.begin_stop(None)
    assert ports.sys_tap_stops == 0
    await engine.handle(MsgSysTapResult(ok=True))
    assert ports.sys_tap_stops == 1

    # A tap that IS up is released exactly once.
    ports = FakePorts()
    engine = make_engine(ports, system_audio=True)
    engine.sys_tap_up = True
    await engine.handle(MsgPause())
    assert ports.sys_tap_stops == 1 and engine.sys_tap_up is False
    await engine.begin_stop(None)
    assert ports.sys_tap_stops == 1, "a released tap must not be released twice"


async def test_checkpoint_pcm_is_a_copy_not_a_live_view_onto_the_timeline() -> None:
    """``persist`` is awaited, and the range below ``mark`` is exactly the range
    a lane that fell behind the resync bar writes into next. One candidate
    handed over a numpy VIEW, whose bytes then changed under the port after the
    flush had already returned."""
    ports = FakePorts()
    engine = make_engine(ports)
    await push_audio(engine, Source.MIC, np.full(SAMPLE_RATE * 3, 0.1, np.float32))
    # A sys lane frozen far behind the bar: the mark lands above where it will
    # write next, so its next batch lands inside the checkpointed range.
    engine.sys.resync = False
    engine.sys.ingested = 0

    assert await engine.flush(Save.CHECKPOINT) is True
    cp = ports.saves(Save.CHECKPOINT)[-1].checkpoint_pcm
    assert cp is not None
    before = float(np.sum(cp))

    engine.mixed[:1000] += 5.0
    assert float(np.sum(cp)) == before, "the persisted checkpoint aliased the live timeline"


async def test_a_checkpoint_with_nothing_new_to_append_carries_no_pcm_at_all() -> None:
    """Rust guards the append with ``if mark > self.flushed_samples``; ``None``
    is this port's unambiguous "append nothing, still write the transcript and
    the meta" signal, so a port implementation can never insert an empty chunk
    row (``append_rec_chunk`` is not idempotent, and crash recovery
    concatenates every chunk it finds)."""
    ports = FakePorts()
    engine = make_engine(ports)
    assert len(engine.mixed) == 0

    assert await engine.flush(Save.CHECKPOINT) is True
    cp = ports.saves(Save.CHECKPOINT)[-1]
    assert cp.checkpoint_pcm is None
    assert cp.wav is None
    assert cp.text and cp.meta_json, "the transcript and the meta still have to be written"


async def test_finish_leaves_the_engine_stopped_so_it_cannot_record_again() -> None:
    """Rust's ``finish()`` ends with ``self.stopping.take()``, which consumes
    the reply SENDER -- modelled here by ``stop_reply``. One candidate read that
    as clearing "are we stopping" too, and a finished engine then happily
    ingested audio and painted level meters again."""
    ports = FakePorts()
    engine = make_engine(ports)
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    await engine.begin_stop(fut)
    await engine.finish()

    assert engine.status == "saved"
    assert engine.stopping is True, "a finished engine is not 'no longer stopping'"
    assert engine.stop_reply is None, "the reply future is consumed, exactly once"
    assert (await asyncio.wait_for(fut, timeout=5)) is not None

    before = len(engine.mixed)
    events = len(ports.events)
    await engine.handle(MsgAudio(Source.MIC, SAMPLE_RATE, np.full(4000, 0.1, np.float32)))
    engine.tick()
    assert len(engine.mixed) == before, "a finished engine ingested more audio"
    assert len(ports.events) == events, "a finished engine kept emitting"


async def test_the_mixed_timeline_is_float32_and_grows_geometrically() -> None:
    """Neither candidate's representation survives the 3-hour ceiling this
    module's own constant enforces: one grew by ``np.concatenate`` per 250 ms
    batch (quadratic -- 1.7 ms/batch at the start of a session, 16.9 ms/batch 30
    simulated minutes in), the other held the samples in a ``list[float]``
    (~5.5 GB at the ceiling against the Rust source's own "~230 MB/h of f32"
    budget)."""
    ports = FakePorts()
    engine = make_engine(ports)
    engine.flushed_samples = MAX_SESSION_SAMPLES  # never auto-flush during this
    batch = np.full(SAMPLE_RATE // 4, 0.01, np.float32)

    reallocations = 0
    last_buf = engine._mixed_buf
    for _ in range(4 * 300):  # five simulated minutes of capture
        await engine.handle(MsgAudio(Source.MIC, SAMPLE_RATE, batch))
        if engine._mixed_buf is not last_buf:
            reallocations += 1
            last_buf = engine._mixed_buf

    assert engine.mixed.dtype == np.float32, "f32, like Rust's Vec<f32>"
    assert len(engine.mixed) == 4 * 300 * len(batch)
    assert engine.mixed.base is engine._mixed_buf, "`mixed` is a view, not a fresh copy per read"
    # 1200 batches, but geometric growth from a 1-minute floor: a handful of
    # reallocations, not one per batch.
    assert reallocations <= 5, f"{reallocations} reallocations for 1200 batches"
    assert float(np.sum(engine.mixed)) == pytest.approx(4 * 300 * len(batch) * 0.01, rel=1e-3)

    # Growth must not disturb what was already mixed, and must expose silence.
    engine.mixed = np.array([1.0, 2.0, 3.0], dtype=np.float32)
    engine.mic.ingested, engine.mic.resync = 3, False
    await engine.handle(MsgAudio(Source.MIC, SAMPLE_RATE, np.array([4.0], np.float32)))
    assert list(engine.mixed) == [1.0, 2.0, 3.0, 4.0]


async def test_an_edit_meta_apply_that_raises_is_reported_not_fatal() -> None:
    """Rust's ``apply`` returns a ``Result`` and cannot unwind; a Python
    callable can, and letting it out of ``handle()`` would kill the run loop --
    and with it the whole recording."""
    ports = FakePorts()
    engine = make_engine(ports)
    fut: asyncio.Future = asyncio.get_running_loop().create_future()

    def boom(_meta: RecMeta) -> None:
        raise ValueError("kaboom")

    await engine.handle(MsgEditMeta(apply=boom, done=fut))  # must not raise
    with pytest.raises(RuntimeError, match="kaboom"):
        await asyncio.wait_for(fut, timeout=5)
    assert not ports.persists, "a failed edit must not persist"
    # The engine is still perfectly usable.
    await engine.handle(MsgAudio(Source.MIC, SAMPLE_RATE, np.full(4000, 0.1, np.float32)))
    assert len(engine.mixed) == 4000


async def test_a_caller_that_gave_up_on_its_reply_future_cannot_kill_the_engine() -> None:
    """Rust ignores the result of ``done.send(..)`` -- a receiver that hung up
    is not the engine's problem. A Python future that was already cancelled
    raises ``InvalidStateError`` on ``set_result``, which one candidate let
    escape ``handle()`` and ``finish()``."""
    ports = FakePorts()
    engine = make_engine(ports)
    cancelled: asyncio.Future = asyncio.get_running_loop().create_future()
    cancelled.cancel()
    await engine.handle(MsgEditMeta(apply=lambda m: None, done=cancelled))  # must not raise

    gone: asyncio.Future = asyncio.get_running_loop().create_future()
    gone.cancel()
    await engine.begin_stop(gone)
    await engine.finish()  # must not raise
    assert engine.status == "saved"


async def test_the_engines_meta_is_independent_of_the_callers_and_of_its_replies() -> None:
    """Rust's ``cfg.meta.clone()`` and ``self.meta.clone()`` are DEEP clones. A
    shallow per-field copy shares the ``RecWord``/``VoicePrint`` objects, which
    is what let one candidate mark words in the CALLER's meta as deleted."""
    ports = FakePorts()
    caller_meta = RecMeta(
        segments=[RecSegment(id="s", source="sys", speaker="Speaker 1", t0=0, t1=10, text="hi",
                             words=[RecWord(w="hi", t0=0, t1=10)])]
    )
    engine = make_engine(ports, meta=caller_meta)

    engine.meta.segments[0].words[0].del_ = True
    engine.meta.segments[0].text = "changed"
    assert caller_meta.segments[0].words[0].del_ is False, "the engine polluted the caller's meta"
    assert caller_meta.segments[0].text == "hi"

    await engine.begin_stop(None)
    await engine.finish()
    returned = engine.outcome.meta
    assert returned is not None
    returned.segments[0].words[0].w = "MUTATED"
    assert engine.meta.segments[0].words[0].w == "hi", "the returned copy aliases the engine's"


def test_an_engine_can_be_built_outside_a_running_event_loop() -> None:
    """``Engine.__init__`` does the synchronous setup ``Engine::new`` did and
    nothing else; only :func:`create_engine` needs a live loop (it spawns the
    two workers). One candidate called ``asyncio.create_task`` from the
    constructor, so an ``Engine`` could not be built anywhere else at all."""
    engine = make_engine(FakePorts())
    assert engine.status == "recording"
    assert engine._background_tasks == []
    assert engine.translate_tx.pop() is None


async def test_a_decode_job_whose_speaker_analysis_raises_cannot_wedge_the_engine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Rust's ``diarize::embed``/``window_prints`` are infallible, so its decode
    thread only catches ``transcribe_segments``. The Python ports of both CAN
    raise (a corrupt ONNX model), and in BOTH candidates that killed the single
    decode task with ``decode_busy`` stuck ``True`` -- the engine would never
    drain, so Stop hung and the whole recording was lost."""
    import arcelle_sidecar.rec.engine as engine_mod

    monkeypatch.setattr(engine_mod, "transcribe_segments", lambda *a, **k: engine_mod.PhraseOut())
    monkeypatch.setattr(
        engine_mod, "embed", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("titanet exploded"))
    )

    ports = FakePorts()
    engine = await make_live_engine(ports)
    try:
        engine.queue_final(Source.MIC, 0, np.full(SAMPLE_RATE, 0.1, np.float32))
        engine.dispatch_next()
        assert engine.decode_busy is True

        msg = await asyncio.wait_for(engine.inbox.get(), timeout=10)
        assert isinstance(msg, MsgDecodeDone)
        assert msg.out.err is not None and "titanet exploded" in msg.out.err
        assert msg.out.emb is None and msg.out.wins == []

        await engine.handle(msg)
        assert engine.decode_busy is False, "the engine stayed wedged"
        assert any("could not transcribe part of this recording" in m for m in ports.errors())
        assert engine._background_tasks[0].done() is False, "the decode worker died"
    finally:
        await engine.aclose()


def test_run_decode_job_reports_a_transcribe_failure_as_err_never_as_silence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """"A phrase the speech engine choked on is NOT silence" -- swallowing this
    made a damaged model produce a recording in which nobody ever spoke.
    ``transcribe_segments`` raising is exactly what a damaged model looks like
    from here (``live.py`` raises when ``whisper_full`` reports a failure)."""
    import arcelle_sidecar.rec.engine as engine_mod

    def broken(*_a, **_k):
        raise RuntimeError("transcription failed")

    monkeypatch.setattr(engine_mod, "transcribe_segments", broken)
    job = DecodeJob(
        kind=JobKind.FINAL, source=Source.SYS, start=SAMPLE_RATE,
        samples=np.full(SAMPLE_RATE, 0.1, np.float32), lang=None,
    )
    out = _run_decode_job(NO_MODEL, None, job)
    assert out.err == "transcription failed", "a broken decoder must be reported, not decoded away"
    assert out.segs == [] and out.detected is None
    assert out.kind is JobKind.FINAL and out.source is Source.SYS and out.start == SAMPLE_RATE
    assert out.n_samples == SAMPLE_RATE
    # The voiceprint still lands: a broken decoder is not a broken microphone,
    # and the phrase's audio is real (the DSP fallback answers with no model).
    assert out.emb is not None

    # A partial never pays for the speaker analysis.
    partial = DecodeJob(
        kind=JobKind.PARTIAL, source=Source.MIC, start=0,
        samples=np.full(SAMPLE_RATE, 0.1, np.float32), lang="he",
    )
    out = _run_decode_job(NO_MODEL, None, partial)
    assert out.emb is None and out.wins == []


# =============================================================================
# ================ ADVERSARIAL REVIEW 2026-08-22 ==============================
# Found by re-deriving this module against recording.rs 628-2778 (and the
# `rec_stop`/`edit_rec_meta` callers the reply channel actually serves) rather
# than against the merge report. Each names the Rust line it is measured
# against.
# =============================================================================


async def test_a_stop_racing_the_3_hour_ceiling_inside_run_is_still_answered() -> None:
    """DEFECT: a reply future left in the inbox when ``run()`` returned was
    never settled, so the caller waited on it FOR EVER.

    Rust does not need to do anything here: the engine thread ends, dropping
    the ``mpsc::Receiver`` and with it the ``Sender`` inside every message
    still queued, so ``rec_stop``'s ``done_rx.recv()`` -- which has
    *deliberately no deadline* ("the wait ends when the engine answers or when
    the engine is gone") -- returns ``Err`` at once and falls back to
    ``stop_verdict(&shared)``, i.e. to the verdict ``finish()`` stored. That
    fallback is the whole reason ``RecShared.outcome`` exists (recording.rs
    1265-1269, 2474-2479).

    And this is not a rare race: the run loop handles exactly ONE message
    before re-checking "stopped and drained", so a Stop queued behind the batch
    that trips the ceiling is ALWAYS the one left over."""
    ports = FakePorts()
    engine = make_engine(ports)
    engine.mic.ingested = MAX_SESSION_SAMPLES - 500
    task = asyncio.create_task(engine.run())
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    # Both queued before the loop reads either.
    engine.send(MsgAudio(Source.MIC, SAMPLE_RATE, np.zeros(1000, np.float32)))
    engine.send(MsgStop(done=fut))

    outcome = await asyncio.wait_for(task, timeout=15)
    assert outcome is not None and outcome.ok and outcome.meta is not None
    assert any("3-hour session limit" in m for m in ports.errors())

    meta = await asyncio.wait_for(fut, timeout=2)
    assert meta.duration_cs == outcome.meta.duration_cs
    assert engine.status == "saved"


async def test_a_stop_that_arrives_after_the_run_loop_returned_reads_the_verdict() -> None:
    """The same hole from the other side: ``rec_stop`` sends and then waits, so
    a Stop that loses the race to a self-stop entirely (the engine is already
    gone) must still be answered rather than parked in a queue nobody reads.
    Rust's ``tx.send`` fails, the reply ``Sender`` is dropped with the returned
    message, and ``stop_verdict`` answers."""
    ports = FakePorts()
    engine = make_engine(ports)
    task = asyncio.create_task(engine.run())
    engine.send(MsgStop())  # a self-answering stop, nobody waiting on it
    outcome = await asyncio.wait_for(task, timeout=15)
    assert outcome is not None and outcome.ok

    late: asyncio.Future = asyncio.get_running_loop().create_future()
    engine.send(MsgStop(done=late))
    meta = await asyncio.wait_for(late, timeout=2)
    assert meta.duration_cs == 0, "the stored verdict, not a fresh empty meta"

    # A FAILED save answers with the failure -- never a green badge, and never
    # silence.
    broken = FakePorts(fail_next=99, fail_exc=PersistFailed("disk full"))
    dead = make_engine(broken)
    dead_task = asyncio.create_task(dead.run())
    dead.send(MsgStop())
    assert (await asyncio.wait_for(dead_task, timeout=15)).ok is False
    after: asyncio.Future = asyncio.get_running_loop().create_future()
    dead.send(MsgStop(done=after))
    with pytest.raises(RuntimeError, match=SAVE_FAILED):
        await asyncio.wait_for(after, timeout=2)


async def test_an_edit_meta_left_in_the_inbox_is_told_the_engine_is_gone() -> None:
    """Same defect, other message: ``edit_rec_meta`` blocks on its reply too
    (bounded, but it still reports ``REC_EDIT_BUSY``/``REC_EDIT_LANDED`` off a
    real answer). An edit the engine never reached must say so, and must not
    have been applied."""
    ports = FakePorts()
    engine = make_engine(ports)
    engine.mic.ingested = MAX_SESSION_SAMPLES - 500
    applied: list[int] = []

    def rename(meta: RecMeta) -> None:
        applied.append(1)
        meta.speaker_names["Speaker 1"] = "Dana"
        return None

    task = asyncio.create_task(engine.run())
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    engine.send(MsgAudio(Source.MIC, SAMPLE_RATE, np.zeros(1000, np.float32)))
    engine.send(MsgEditMeta(apply=rename, done=fut))

    await asyncio.wait_for(task, timeout=15)
    with pytest.raises(RuntimeError, match="stopped before it could save"):
        await asyncio.wait_for(fut, timeout=2)
    assert applied == [], "an orphaned edit must never have been applied"
    assert engine.meta.speaker_names == {}
    assert ENGINE_GONE == "The recording engine stopped before it could save."


def test_retranscribe_deep_copies_the_annotations_it_carries_over() -> None:
    """DEFECT: the carried-over lists were shallow copies, so the rebuilt meta
    handed back the CALLER's own ``RecCut``/``RecChapter``/``RecHighlight``/
    ``RecNote`` objects. Rust carries them as ``prior.notes.clone()`` etc., and
    ``Vec<T>::clone()`` clones every element -- the same deep-copy rule
    ``Engine.__init__`` already follows for ``cfg.meta``. Sharing them means
    editing a note on the rebuilt transcript silently rewrites the meta the
    caller kept to fall back on."""
    prior = RecMeta(
        duration_cs=100,
        cuts=[RecCut(t0=1, t1=2)],
        chapters=[RecChapter(id="c", t0=0, title="Intro")],
        highlights=[RecHighlight(id="h", t0=0, t1=5)],
        notes=[RecNote(id="n", t0=0, kind=NoteKind.ACTION, text="ship it")],
    )
    # Empty audio: no phrase ever closes, so no model is touched.
    rebuilt = retranscribe(
        NO_MODEL, np.zeros(0, np.float32), prior, [], None, lambda d, t: None, lambda: False
    )

    assert rebuilt.cuts == prior.cuts and rebuilt.notes == prior.notes
    assert rebuilt.chapters == prior.chapters and rebuilt.highlights == prior.highlights
    for carried, original, what in (
        (rebuilt.cuts, prior.cuts, "cuts"),
        (rebuilt.chapters, prior.chapters, "chapters"),
        (rebuilt.highlights, prior.highlights, "highlights"),
        (rebuilt.notes, prior.notes, "notes"),
    ):
        assert carried[0] is not original[0], f"the rebuilt meta aliases the caller's {what}"

    # `RecCut` is frozen, so its aliasing was inert; `RecNote`/`RecHighlight`/
    # `RecChapter` are plain mutable dataclasses, and those were the live wire.
    rebuilt.notes[0].text = "MUTATED"
    rebuilt.chapters[0].title = "MUTATED"
    rebuilt.highlights[0].t1 = 999
    assert prior.notes[0].text == "ship it"
    assert prior.chapters[0].title == "Intro"
    assert prior.highlights[0].t1 == 5


async def test_pause_resets_the_dead_final_streak_on_both_lanes() -> None:
    """recording.rs 1838-1842: "Force-closing can truncate a phrase into an
    empty final; 'consecutive dead finals' must not span a pause." Without the
    reset the pause itself pushes a perfectly good lock over the unlock
    threshold, and the lane re-detects from scratch mid-meeting."""
    ports = FakePorts()
    engine = make_engine(ports)
    for lane in engine.lane_lang:
        lane.lock = "he"
        lane.lock_votes = 5
        lane.empty_streak = LaneLang.EMPTY_FINALS_TO_UNLOCK - 1  # one short of unlocking

    await engine.handle(MsgPause())
    assert [lane.empty_streak for lane in engine.lane_lang] == [0, 0]
    assert [lane.hint() for lane in engine.lane_lang] == ["he", "he"]

    # And the reset is REAL, not just the counter: one more dead final per lane
    # must leave both locks standing.
    for source in (Source.MIC, Source.SYS):
        await engine.handle(MsgDecodeDone(final_out(
            source=source, start=0, n_samples=SAMPLE_RATE, text="   "
        )))
    assert [lane.hint() for lane in engine.lane_lang] == ["he", "he"], (
        "the dead-final streak spanned the pause and unlocked the lane"
    )
    assert [lane.empty_streak for lane in engine.lane_lang] == [1, 1]


async def test_the_pause_follow_up_saves_the_transcript_once_after_the_LAST_late_final() -> None:
    """Pause lands with a decode genuinely IN FLIGHT and force-closes a phrase
    on each lane behind it. The ``Save.TRANSCRIPT`` follow-up must fire exactly
    ONCE, only when the whole tail has landed, and must carry every one of
    those late sentences -- otherwise quitting while paused loses the last
    thing that was said (recording.rs 1782-1792)."""
    ports = FakePorts()
    engine = make_engine(ports)
    engine.mic.state = Active(start=0, buf=[0.1] * SAMPLE_RATE)
    engine.sys.state = Active(start=0, buf=[0.1] * SAMPLE_RATE)
    engine.decode_busy = True  # something is already in the decoder
    task = asyncio.create_task(engine.run())
    try:
        engine.send(MsgPause())
        await wait_until(
            lambda: engine.pause_pending, timeout=5, message="pause never armed the follow-up"
        )
        assert len(engine.final_queue) == 2, "both force-closed phrases must be queued"
        assert engine.decode_busy is True, "the in-flight decode must still be in flight"
        assert ports.saves(Save.FULL), "Pause's own Save.FULL never landed"
        assert not ports.saves(Save.TRANSCRIPT), "the follow-up ran before the tail landed"

        words = ("alpha", "beta", "gamma")
        for i, word in enumerate(words):
            engine.send(MsgDecodeDone(final_out(
                source=Source.SYS, start=SAMPLE_RATE * 4 * i, n_samples=SAMPLE_RATE, text=word
            )))
            await wait_until(
                lambda n=i: len(engine.meta.segments) == n + 1,
                timeout=5,
                message=f"late final {word} was never integrated",
            )
            if i < len(words) - 1:
                assert not ports.saves(Save.TRANSCRIPT), (
                    f"the follow-up fired after {word}, with the tail still decoding"
                )

        await wait_until(
            lambda: bool(ports.saves(Save.TRANSCRIPT)),
            timeout=5,
            message="the pause follow-up never fired once the tail had landed",
        )
        assert len(ports.saves(Save.TRANSCRIPT)) == 1, "the follow-up fired more than once"
        last = ports.saves(Save.TRANSCRIPT)[-1]
        assert last.wav is None and last.checkpoint_pcm is None
        assert all(w in last.text for w in words), last.text
        assert engine.pause_pending is False and engine.paused is True
        assert engine.status == "paused"
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        await engine.aclose()


async def test_room_closed_mid_session_ends_the_run_loop_instead_of_spinning() -> None:
    """``Err(None)`` sets ``stopping`` but -- unlike ``begin_stop`` -- does not
    close the open phrases, clear the partial or say "saving". The loop still
    has to reach ``finish()`` on its own; a self-stop that only sets a flag
    would spin at 10 Hz for ever on a recording nobody can save. Only ever
    checked through ``flush()``/``finish()`` by hand before this."""
    ports = FakePorts(fail_next=99, fail_exc=RoomClosed())
    engine = make_engine(ports)
    # The energy gate rather than Silero: this is about the save path, and a
    # minute of audio through a real ONNX VAD is a minute of ONNX for nothing.
    engine.mic.vad = None
    task = asyncio.create_task(engine.run())
    # A minute of silence -- enough dirty tail for ingest's own checkpoint
    # trigger, quiet enough that no phrase opens and needs a decoder.
    engine.send(MsgAudio(Source.MIC, SAMPLE_RATE, np.zeros(SAMPLE_RATE * 61, np.float32)))

    outcome = await asyncio.wait_for(task, timeout=30)
    assert outcome is not None and outcome.ok is False
    assert outcome.error == SAVE_FAILED and outcome.meta is None
    assert engine.status == "failed" and engine.stopping is True
    closed = [m for m in ports.errors() if "room closed" in m.lower()]
    assert len(closed) == 2, f"once for the checkpoint, once for the final write: {ports.errors()}"
    assert not ports.persists, "nothing may be written into a locked room"
    assert engine.flush_failed_at is None, "a closed room is not a retryable write failure"


async def test_a_failed_pause_save_reports_every_time_even_inside_the_backoff() -> None:
    """``automatic`` is ``Save::Checkpoint && stopping.is_none()`` -- ONLY.
    The once-per-outage throttle exists because the ingest trigger fires four
    times a second once the tail is dirty; a save someone ASKED for (pause, and
    the transcript follow-up behind it) must answer whatever the checkpoints
    have been doing (recording.rs 2421-2432)."""
    ports = FakePorts(fail_next=1)
    engine = make_engine(ports)
    await engine.handle(MsgAudio(Source.MIC, SAMPLE_RATE, np.full(SAMPLE_RATE, 0.05, np.float32)))
    assert await engine.flush(Save.CHECKPOINT) is False
    assert len(ports.errors()) == 1

    # Straight back inside the 5 s backoff window, and not stopping:
    ports.fail_next = 1
    assert await engine.flush(Save.FULL) is False
    assert len(ports.errors()) == 2, "a pause's own Save.FULL was silently swallowed"
    ports.fail_next = 1
    assert await engine.flush(Save.TRANSCRIPT) is False
    assert len(ports.errors()) == 3, "the pause follow-up was silently swallowed"
    assert all("retrying" in m for m in ports.errors()), (
        "not stopping, so every one of these is the retryable message"
    )
    assert engine.flushed_samples == 0, "a failed save must never mark audio durable"


def test_overlaps_sys_speech_caps_the_SCAN_at_fifty_rows_not_fifty_sys_ones() -> None:
    """Rust is ``.rev().take(50).filter(sys).any(..)`` -- take BEFORE filter, so
    the cap is on rows LOOKED AT. A port that filtered first would keep finding
    a sys phrase pushed far past the newest fifty rows, and keep deleting real
    mic speech long after the crosstalk ended."""
    ports = FakePorts()
    engine = make_engine(ports)
    engine.meta.segments.append(RecSegment(
        id="sys-old", source="sys", speaker="Speaker 1", t0=0, t1=1000, text="meeting", words=[]
    ))
    assert engine.overlaps_sys_speech(0, 1000) is True
    for i in range(49):
        engine.meta.segments.append(RecSegment(
            id=f"mic-{i}", source="mic", speaker="You", t0=2000 + i, t1=2001 + i, text="x", words=[]
        ))
    assert engine.overlaps_sys_speech(0, 1000) is True, "the 50th-newest row is still scanned"
    engine.meta.segments.append(RecSegment(
        id="mic-49", source="mic", speaker="You", t0=9000, t1=9001, text="x", words=[]
    ))
    assert engine.overlaps_sys_speech(0, 1000) is False, "the cap is on rows scanned, not sys rows"


async def test_a_retracted_echo_vote_leaves_a_twice_confirmed_lock_standing() -> None:
    """``retract`` always drops the dissent, but only a lock resting on that ONE
    final falls with it. A lock an evidenced final has since confirmed
    (``lock_votes`` > 1) survives its echo being pulled back out -- the
    complement of the ``lock_votes == 1`` case already covered."""
    ports = FakePorts()
    engine = make_engine(ports)
    text = "we should move the whole launch to Friday afternoon instead"
    for i in range(2):
        await engine.handle(MsgDecodeDone(final_out(
            source=Source.MIC, start=SAMPLE_RATE * 20 * i, n_samples=SAMPLE_RATE * 4,
            text=f"{text} {i}", detected=("en", 0.95),
        )))
    mic_lang = engine.lane_lang[Source.MIC.value]
    assert mic_lang.hint() == "en" and mic_lang.lock_votes == 2
    mic_lang.dissent = ("he", 1)

    # The system lane reports the SECOND mic phrase's words, same moment.
    await engine.handle(MsgDecodeDone(final_out(
        source=Source.SYS, start=SAMPLE_RATE * 20, n_samples=SAMPLE_RATE * 4,
        text=f"{text} 1", detected=("en", 0.95),
    )))
    assert [s.source for s in engine.meta.segments] == ["mic", "sys"], (
        "the system lane must win, and only the mic twin may be pulled out"
    )
    assert ports.payloads("rec-segment-drop"), "the echoed mic row was not dropped"
    assert mic_lang.hint() == "en", "a confirmed lock must survive one retracted vote"
    assert mic_lang.dissent is None, "the retracted final's dissent must go"
