"""Tests for :mod:`arcelle_sidecar.rec.session_ws` -- the HTTP + WebSocket
wiring between the finished :class:`~arcelle_sidecar.rec.engine.Engine` and
Electron/the renderer (see that module's own docstring for the protocol these
exercise).

Real, not mocked: a real FastAPI app carrying the real
``arcelle_sidecar.server.TokenAuthMiddleware``, real WebSocket connections
(``starlette.testclient.TestClient``), a real ``Engine``, real AES-256-GCM
encryption read back off a real file on disk, and -- for the end-to-end case --
real macOS ``say`` speech through the real whisper model, the same convention
``tests/test_engine.py`` uses. ``Engine``'s own decisions are not re-tested
here; only this module's wiring is.

Each app is built fresh by :func:`_app` (the real middleware + this module's
routes) so nothing leaks between tests -- the session slot lives on
``app.state``, not in a module global, which is itself one of the things
:func:`test_two_apps_have_independent_session_slots` pins down. The one test
that goes through ``server.create_app()`` proves the single ``server.py``
addition is really wired up.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import struct
import subprocess
import threading
import time
import uuid
from pathlib import Path

import numpy as np
import pytest
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from arcelle_sidecar.media import decode as media_decode
from arcelle_sidecar.rec import session_ws
from arcelle_sidecar.rec.engine import (
    DecodeOut,
    Engine,
    EngineConfig,
    JobKind,
    MsgAudio,
    MsgDecodeDone,
    PersistFailed,
    RoomClosed,
    Save,
)
from arcelle_sidecar.rec.lanes import Source
from arcelle_sidecar.rec.meta import SAMPLE_RATE, RecMeta, RecSegment
from arcelle_sidecar.rec.session_ws import (
    EditMetaRequest,
    RecSessionManager,
    SpoolWriter,
    WsEnginePorts,
    _build_apply,
    _HostLink,
    _pump_session_socket,
    register_rec_routes,
)
from arcelle_sidecar.server import TokenAuthMiddleware, create_app
from arcelle_sidecar.stt import engine as stt_engine
from arcelle_sidecar.stt.live import SegOut

# ============================================================================
# ---- model/audio fixtures (same resolution + skip discipline as
# ---- tests/test_engine.py) -------------------------------------------------
# ============================================================================

_DOWNLOADED_MODEL = (
    Path.home()
    / "Library/Application Support/com.benreich.privateroom/models"
    / "ggml-large-v3-turbo-q5_0.bin"
)
_BUNDLED_MODEL = Path(
    "/Users/benreich/private-room/src-tauri/resources/models/ggml-large-v3-turbo-q5_0.bin"
)
MODEL_PATH = str(_DOWNLOADED_MODEL if _DOWNLOADED_MODEL.exists() else _BUNDLED_MODEL)
#: A path that certainly holds no model. Every test that never decodes real
#: speech uses it, so nothing can accidentally load real weights -- and no test
#: using it may ever let a real decode start (pywhispercpp aborts the process on
#: a missing model rather than raising), which is why they turn live STT off or
#: feed silence only.
NO_MODEL = "/nonexistent-whisper-model.bin"

_HAS_MODEL = Path(MODEL_PATH).exists()
_HAS_SAY = Path("/usr/bin/say").exists() and Path("/usr/bin/afconvert").exists()

requires_say_and_model = pytest.mark.skipif(
    not (_HAS_MODEL and _HAS_SAY),
    reason=f"requires the whisper model at {MODEL_PATH} and macOS say(1)/afconvert(1)",
)


@pytest.fixture(autouse=True)
def _clean_warm_cache():
    """Same discipline as ``test_engine.py``'s fixture of the same name."""
    stt_engine.unload_ctx()
    yield
    stt_engine.unload_ctx()


@pytest.fixture(scope="module")
def fox_pcm(tmp_path_factory: pytest.TempPathFactory) -> np.ndarray:
    if not _HAS_SAY:
        pytest.skip("requires macOS say/afconvert")
    d = tmp_path_factory.mktemp("session_ws_audio")
    path = d / f"fox-{uuid.uuid4()}.aiff"
    proc = subprocess.run(
        ["/usr/bin/say", "-v", "Samantha", "-o", str(path), "The quick brown fox jumps over the lazy dog."],
        capture_output=True,
    )
    if proc.returncode != 0 or not path.exists():
        pytest.skip(f"say failed to synthesize: {proc.stderr!r}")
    pcm = media_decode.decode_to_pcm(path, media_decode.MediaKind.AUDIO)
    assert pcm.shape[0] > SAMPLE_RATE, "decoded under a second of audio"
    return np.asarray(pcm, dtype=np.float32)


# ============================================================================
# ---- small helpers (app wiring, wire encoding, polling) --------------------
# ============================================================================

TOKEN = "test-token-123"


def _app(token: str | None = TOKEN) -> tuple[FastAPI, RecSessionManager]:
    app = FastAPI()
    if token:
        app.add_middleware(TokenAuthMiddleware, token=token)
    return app, register_rec_routes(app)


def _start_body(
    file_id: str, spool_dir, *, model_path: str = NO_MODEL, system_audio: bool = False
) -> dict:
    return {
        "fileId": file_id,
        "modelPath": model_path,
        "systemAudio": system_audio,
        "spoolDir": str(spool_dir),
    }


def _post(client: TestClient, path: str, body: dict, *, token: str | None = TOKEN):
    headers = {"authorization": f"Bearer {token}"} if token else {}
    return client.post(path, json=body, headers=headers)


def _ws_url(path: str, file_id: str, token: str | None = TOKEN) -> str:
    query = f"fileId={file_id}"
    return f"{path}?token={token}&{query}" if token else f"{path}?{query}"


def _encode_audio_frame(lane: int, rate: int, samples: np.ndarray, seq: int = 0) -> bytes:
    arr = np.ascontiguousarray(samples, dtype="<f4")
    return struct.pack("<BBHII", lane, 0, seq, rate, arr.size) + arr.tobytes()


def _push_audio(ws, lane: int, pcm: np.ndarray, *, chunk: int = SAMPLE_RATE // 4) -> None:
    for i in range(0, len(pcm), chunk):
        ws.send_bytes(_encode_audio_frame(lane, SAMPLE_RATE, pcm[i : i + chunk]))


def _wait_until(predicate, timeout: float = 10.0, interval: float = 0.02) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(interval)
    raise AssertionError(f"condition never became true within {timeout}s")


def _run_acker(ws, received: list, ack_fn) -> None:
    """Background thread: a well-behaved Electron main answering every save."""
    while True:
        try:
            msg = ws.receive_json()
        except Exception:
            return
        received.append(msg)
        try:
            ws.send_json(ack_fn(msg))
        except Exception:
            return


@contextlib.contextmanager
def _acking_host(client: TestClient, file_id: str, *, token: str | None = TOKEN, ack_fn=None):
    ack_fn = ack_fn or (lambda msg: {"reqId": msg["reqId"], "ok": True})
    with client.websocket_connect(_ws_url("/rec/host", file_id, token)) as host_ws:
        received: list[dict] = []
        thread = threading.Thread(target=_run_acker, args=(host_ws, received, ack_fn), daemon=True)
        thread.start()
        try:
            yield received
        finally:
            with contextlib.suppress(Exception):
                host_ws.close()
            thread.join(timeout=5)


def _run_collector(ws, received: list) -> None:
    while True:
        try:
            received.append(ws.receive_json())
        except Exception:
            return


def _drain(queue: "asyncio.Queue[str]") -> list[dict]:
    events = []
    while not queue.empty():
        events.append(json.loads(queue.get_nowait()))
    return events


class _FakeHostSocket:
    """A stand-in for the real `/rec/host` socket: every `send_text` is answered
    IN-LINE by `ack_fn`, so a test pins the EXACT ack a save gets with no
    network timing involved. Real control flow otherwise -- `_HostLink.call`
    still awaits its own future the ordinary way."""

    def __init__(self, host: _HostLink, ack_fn) -> None:
        self._host = host
        self._ack_fn = ack_fn
        self.sent: list[dict] = []

    async def send_text(self, text: str) -> None:
        message = json.loads(text)
        self.sent.append(message)
        ack = self._ack_fn(message)
        if ack is not None:
            self._host.resolve(ack)


def _ok(msg: dict) -> dict:
    return {"reqId": msg["reqId"], "ok": True}


def _ports_with_engine(tmp_path: Path, ack_fn=_ok, *, file_id: str = "f"):
    """A real ``WsEnginePorts`` + a real ``Engine`` + a scripted host socket."""
    spool = SpoolWriter(Path(tmp_path) / f"{file_id}.spool", AESGCM.generate_key(bit_length=256))
    ports = WsEnginePorts(file_id=file_id, spool=spool, base_url="http://127.0.0.1:11434")
    engine = Engine(EngineConfig(file_id=file_id, model_path=NO_MODEL), ports)
    ports.bind_engine(engine)
    fake = _FakeHostSocket(ports.host, ack_fn)
    ports.host.ws = fake
    return ports, engine, fake


# ============================================================================
# ---- SpoolWriter: real AES-256-GCM, real file, real permission bits --------
# ============================================================================


def test_spool_frames_are_independently_nonced_and_decryptable(tmp_path: Path) -> None:
    path = tmp_path / "s.spool"
    key = AESGCM.generate_key(bit_length=256)
    writer = SpoolWriter(path, key)
    a = b"first chunk of raw pcm bytes"
    b = b"a second, differently sized chunk of raw pcm bytes appended later"
    r1 = writer.append(a)
    r2 = writer.append(b)
    writer.close()

    raw = path.read_bytes()
    assert a not in raw, "plaintext recoverable from the spool file without the key"
    assert b not in raw, "plaintext recoverable from the spool file without the key"

    def _frame(rng: tuple[int, int]) -> tuple[bytes, bytes]:
        start, end = rng
        region = raw[start:end]
        length = struct.unpack_from("<I", region, 0)[0]
        assert length == len(region) - 4
        return region[4:16], region[16:]

    nonce1, ct1 = _frame(r1)
    nonce2, ct2 = _frame(r2)
    assert nonce1 != nonce2, "a nonce was reused across frames"
    assert len(nonce1) == 12 and len(nonce2) == 12
    assert AESGCM(key).decrypt(nonce1, ct1, None) == a
    assert AESGCM(key).decrypt(nonce2, ct2, None) == b
    # The tag really is authenticating: the wrong key cannot open the frame.
    with pytest.raises(InvalidTag):
        AESGCM(AESGCM.generate_key(bit_length=256)).decrypt(nonce1, ct1, None)


def test_spool_file_is_owner_only_and_recreated_after_unlink(tmp_path: Path) -> None:
    path = tmp_path / "s2.spool"
    writer = SpoolWriter(path, AESGCM.generate_key(bit_length=256))
    writer.append(b"anything")
    assert os.stat(path).st_mode & 0o777 == 0o600
    writer.unlink()
    assert not path.exists()
    # The next append recreates it from byte 0, 0600 again (pause -> resume).
    start, end = writer.append(b"after the unlink")
    assert start == 0 and end == os.stat(path).st_size
    assert os.stat(path).st_mode & 0o777 == 0o600
    writer.close()


def test_spool_refuses_to_overwrite_a_previous_sessions_file(tmp_path: Path) -> None:
    """A spool left by a crashed session is Electron's to recover from -- never
    ours to silently overwrite."""
    path = tmp_path / "s3.spool"
    path.write_bytes(b"a crashed session left this behind")
    with pytest.raises(FileExistsError):
        SpoolWriter(path, AESGCM.generate_key(bit_length=256))
    assert path.read_bytes() == b"a crashed session left this behind"


def test_a_corrupted_or_truncated_frame_refuses_to_decrypt(tmp_path: Path) -> None:
    """The spool is AUTHENTICATED, not merely scrambled. A frame damaged by a
    half-written flush, a bad sector or anything else must fail loudly at
    Electron's decrypt -- a mode that quietly hands back garbage floats would
    paint noise into the middle of a recovered recording, which nobody would
    read as corruption."""
    path = tmp_path / "s5.spool"
    key = AESGCM.generate_key(bit_length=256)
    writer = SpoolWriter(path, key)
    plaintext = np.linspace(-1, 1, 256, dtype=np.float32).astype("<f4").tobytes()
    start, end = writer.append(plaintext)
    writer.close()

    raw = path.read_bytes()
    nonce, ciphertext = raw[start + 4 : start + 16], raw[start + 16 : end]
    assert AESGCM(key).decrypt(nonce, ciphertext, None) == plaintext

    # One flipped bit anywhere in the ciphertext.
    for at in (0, len(ciphertext) // 2, len(ciphertext) - 1):
        damaged = bytearray(ciphertext)
        damaged[at] ^= 0x01
        with pytest.raises(InvalidTag):
            AESGCM(key).decrypt(nonce, bytes(damaged), None)
    # A frame cut short (a crash mid-append) -- including one cut to nothing.
    for cut in (1, 17, len(ciphertext) // 2):
        with pytest.raises(InvalidTag):
            AESGCM(key).decrypt(nonce, ciphertext[:-cut], None)
    # And a frame read back under the wrong frame's nonce.
    with pytest.raises(InvalidTag):
        AESGCM(key).decrypt(os.urandom(12), ciphertext, None)


def test_several_checkpoints_leave_no_plaintext_pcm_anywhere_in_the_file(
    tmp_path: Path,
) -> None:
    """Read as bytes, not through any decrypt helper: nothing recognisable from
    any of the chunks survives in the file."""
    path = tmp_path / "s6.spool"
    writer = SpoolWriter(path, AESGCM.generate_key(bit_length=256))
    chunks = [
        (np.sin(np.linspace(0, 40 + i, 4000, dtype=np.float32)) * 0.3).astype("<f4").tobytes()
        for i in range(5)
    ]
    ranges = [writer.append(c) for c in chunks]
    writer.close()

    raw = path.read_bytes()
    for chunk in chunks:
        assert chunk not in raw
        # Not a whole chunk, not a window of one, not even one sample's four
        # bytes at a predictable spot.
        for at in range(0, len(chunk) - 64, 997):
            assert chunk[at : at + 64] not in raw
        assert chunk[:4] * 8 not in raw
    # Ranges are contiguous, non-overlapping, and cover the file exactly.
    assert ranges[0][0] == 0
    assert [r[0] for r in ranges[1:]] == [r[1] for r in ranges[:-1]]
    assert ranges[-1][1] == os.stat(path).st_size


def test_spool_truncate_drops_the_last_frame(tmp_path: Path) -> None:
    writer = SpoolWriter(tmp_path / "s4.spool", AESGCM.generate_key(bit_length=256))
    keep_start, keep_end = writer.append(b"an ACKed frame")
    drop_start, _drop_end = writer.append(b"a frame nobody ACKed")
    writer.truncate_to(drop_start)
    writer.close()
    assert os.stat(tmp_path / "s4.spool").st_size == keep_end == drop_start
    assert keep_start == 0


# ============================================================================
# ---- _build_apply: the explicit edit-meta ops (mirrors recording_cmds.rs) --
# ============================================================================


def _meta_with_speaker(label: str = "Speaker 1") -> RecMeta:
    meta = RecMeta()
    meta.segments.append(
        RecSegment(id="s1", source="mic", speaker=label, t0=0, t1=100, text="hello", words=[])
    )
    return meta


def _engine_for_ops(duration_cs: int = 0) -> Engine:
    class _NullPorts:
        def emit(self, event, payload):
            pass

        async def persist(self, save, *, wav, checkpoint_pcm, meta_json, text):
            return None

        async def request_sys_tap(self):
            return None

        async def stop_sys_tap(self):
            return None

        async def translate(self, text, lang, model):
            return None

    engine = Engine(EngineConfig(file_id="f", model_path=NO_MODEL), _NullPorts())
    engine.duration_cs = duration_cs
    return engine


def test_rename_speaker_applies_and_clears_the_recognized_guess() -> None:
    engine = _engine_for_ops()
    meta = _meta_with_speaker()
    meta.speaker_names["Speaker 1"] = "Dana"
    meta.recognized.add("Dana")
    apply_fn = _build_apply(
        EditMetaRequest(fileId="f", op="rename_speaker", label="Speaker 1", name="Ben"), engine
    )
    assert apply_fn(meta) is None
    assert meta.speaker_names["Speaker 1"] == "Ben"
    # The name is the user's own now, so it must stop being re-decided.
    assert "Dana" not in meta.recognized and "Ben" not in meta.recognized


def test_rename_speaker_refusals_match_the_rust_command() -> None:
    engine = _engine_for_ops()
    apply_fn = _build_apply(
        EditMetaRequest(fileId="f", op="rename_speaker", label="  ", name="Ben"), engine
    )
    assert apply_fn(RecMeta()) == "No speaker selected."

    apply_fn = _build_apply(
        EditMetaRequest(fileId="f", op="rename_speaker", label="Speaker 1", name="Ben"), engine
    )
    assert apply_fn(RecMeta()) == "That recording has no transcript yet."
    assert apply_fn(_meta_with_speaker("Speaker 2")) == 'Nobody in this recording is labelled "Speaker 1".'


def test_rename_speaker_back_to_the_label_is_a_removal() -> None:
    engine = _engine_for_ops()
    meta = _meta_with_speaker()
    meta.speaker_names["Speaker 1"] = "Dana"
    apply_fn = _build_apply(
        EditMetaRequest(fileId="f", op="rename_speaker", label="Speaker 1", name="Speaker 1"), engine
    )
    assert apply_fn(meta) is None
    assert "Speaker 1" not in meta.speaker_names


def test_note_and_chapter_ops_round_trip() -> None:
    engine = _engine_for_ops()
    meta = RecMeta()
    assert _build_apply(
        EditMetaRequest(fileId="f", op="add_note", t0=10, kind="action", text=" ship it ", who="Ben"),
        engine,
    )(meta) is None
    note = meta.notes[0]
    assert note.text == "ship it" and note.who == "Ben" and note.by.value == "you"
    assert note.kind.value == "action"

    assert _build_apply(
        EditMetaRequest(fileId="f", op="set_note", noteId=note.id, text="shipped"), engine
    )(meta) is None
    assert meta.notes[0].text == "shipped"
    assert _build_apply(
        EditMetaRequest(fileId="f", op="set_note", noteId="nope", text="x"), engine
    )(meta) == "That note is no longer in this recording."

    assert _build_apply(
        EditMetaRequest(fileId="f", op="add_chapter", t0=5, title="Intro"), engine
    )(meta) is None
    chapter = meta.chapters[0]
    assert _build_apply(
        EditMetaRequest(fileId="f", op="set_chapter", chapterId=chapter.id, title="Opening"), engine
    )(meta) is None
    assert meta.chapters[0].title == "Opening"

    assert _build_apply(
        EditMetaRequest(fileId="f", op="delete_item", itemKind="note", itemId=note.id), engine
    )(meta) is None
    assert meta.notes == []
    assert _build_apply(
        EditMetaRequest(fileId="f", op="delete_item", itemKind="note", itemId=note.id), engine
    )(meta) == "That item is no longer in this recording."
    assert _build_apply(
        EditMetaRequest(fileId="f", op="delete_item", itemKind="nonsense", itemId="x"), engine
    )(meta) == 'Unknown item kind "nonsense".'


def test_add_highlight_with_t1_before_t0_marks_the_instant() -> None:
    engine = _engine_for_ops()
    meta = RecMeta()
    assert _build_apply(
        EditMetaRequest(fileId="f", op="add_highlight", t0=90, t1=10), engine
    )(meta) is None
    assert (meta.highlights[0].t0, meta.highlights[0].t1) == (90, 90)


def test_a_mark_past_the_end_is_refused_but_the_live_head_counts() -> None:
    """The horizon is the LIVE head, not the last-flushed meta -- marking the
    moment someone just spoke is the whole reason the button exists."""
    meta = RecMeta()
    meta.duration_cs = 100  # what the last flush stamped
    engine = _engine_for_ops(duration_cs=500)  # what has actually been recorded
    assert _build_apply(EditMetaRequest(fileId="f", op="add_chapter", t0=400, title="Now"), engine)(
        meta
    ) is None
    assert _build_apply(EditMetaRequest(fileId="f", op="add_chapter", t0=900, title="Later"), engine)(
        meta
    ) == "That moment is outside this recording."
    assert _build_apply(EditMetaRequest(fileId="f", op="add_chapter", t0=-1, title="Before"), engine)(
        meta
    ) == "That moment is outside this recording."


@pytest.mark.parametrize(
    "body",
    [
        {"op": "nonsense"},
        {"op": "rename_speaker", "label": "Speaker 1"},
        {"op": "add_note", "t0": 1, "kind": "point"},
        {"op": "set_note", "text": "x"},
        {"op": "add_chapter", "t0": 1},
        {"op": "set_chapter", "title": "x"},
        {"op": "add_highlight", "t0": 1},
        {"op": "delete_item", "itemKind": "note"},
    ],
)
def test_unknown_or_incomplete_ops_are_rejected(body: dict) -> None:
    with pytest.raises(ValueError):
        _build_apply(EditMetaRequest(fileId="f", **body), _engine_for_ops())


# ============================================================================
# ---- _HostLink / persist(): the PersistFailed vs RoomClosed contract -------
# ============================================================================


async def test_persist_checkpoint_reports_the_engines_own_sample_range(tmp_path: Path) -> None:
    ports, engine, fake = _ports_with_engine(tmp_path)
    await engine.handle(MsgAudio(Source.MIC, SAMPLE_RATE, np.full(SAMPLE_RATE, 0.05, np.float32)))

    assert await engine.flush(Save.CHECKPOINT) is True
    sent = fake.sent[-1]
    assert sent["kind"] == "checkpoint"
    assert sent["fromSample"] == 0 and sent["toSample"] == SAMPLE_RATE
    assert sent["spoolRange"] is not None
    assert engine.flushed_samples == SAMPLE_RATE
    ports.spool.unlink()


async def test_checkpoint_from_sample_continues_across_a_full_save(tmp_path: Path) -> None:
    """THE REGRESSION: a port that keeps its OWN sample cursor (advanced only on
    checkpoint acks) drifts past every ``Save.FULL``, because a full save moves
    ``flushed_samples`` to the head without reporting a sample count at all.
    Every checkpoint after the first pause then names a range that starts before
    the audio it actually holds -- measured at 16000 samples (1.0 s) on a real
    pause/resume recording."""
    ports, engine, fake = _ports_with_engine(tmp_path)

    await engine.handle(MsgAudio(Source.MIC, SAMPLE_RATE, np.full(SAMPLE_RATE, 0.05, np.float32)))
    assert await engine.flush(Save.CHECKPOINT) is True
    assert fake.sent[-1]["toSample"] == SAMPLE_RATE

    # A whole second more arrives, and THEN the pause writes the full WAV.
    await engine.handle(MsgAudio(Source.MIC, SAMPLE_RATE, np.full(SAMPLE_RATE, 0.05, np.float32)))
    assert await engine.flush(Save.FULL) is True
    full = fake.sent[-1]
    assert full["kind"] == "full"
    assert (full["fromSample"], full["toSample"]) == (0, 2 * SAMPLE_RATE)
    assert engine.flushed_samples == 2 * SAMPLE_RATE

    # The next checkpoint must start where the WAV ended, not where the last
    # CHECKPOINT ended.
    await engine.handle(MsgAudio(Source.MIC, SAMPLE_RATE, np.full(SAMPLE_RATE, 0.05, np.float32)))
    assert await engine.flush(Save.CHECKPOINT) is True
    resumed = fake.sent[-1]
    assert resumed["fromSample"] == 2 * SAMPLE_RATE, "the checkpoint's sample cursor drifted"
    assert resumed["toSample"] == 3 * SAMPLE_RATE
    ports.spool.unlink()


async def test_persist_transcript_touches_no_spool(tmp_path: Path) -> None:
    ports, engine, fake = _ports_with_engine(tmp_path)
    size_before = os.stat(ports.spool.path).st_size
    await ports.persist(Save.TRANSCRIPT, wav=None, checkpoint_pcm=None, meta_json="{}", text="hi")
    assert fake.sent[-1]["spoolRange"] is None
    assert fake.sent[-1]["fromSample"] is None and fake.sent[-1]["toSample"] is None
    assert os.stat(ports.spool.path).st_size == size_before
    ports.spool.unlink()


async def test_a_failed_ack_raises_persist_failed_and_rolls_the_spool_back(tmp_path: Path) -> None:
    ports, engine, _fake = _ports_with_engine(
        tmp_path,
        lambda msg: {"reqId": msg["reqId"], "ok": False, "reason": "failed", "message": "disk full"},
    )
    with pytest.raises(PersistFailed, match="disk full"):
        await ports.persist(
            Save.CHECKPOINT, wav=None, checkpoint_pcm=np.zeros(64, np.float32),
            meta_json="{}", text="",
        )
    # Nothing will ever reference an un-ACKed frame; leaving it there would make
    # a retried outage write the whole growing tail again every few seconds.
    assert os.stat(ports.spool.path).st_size == 0
    ports.spool.unlink()


async def test_a_closed_ack_raises_room_closed(tmp_path: Path) -> None:
    ports, engine, _fake = _ports_with_engine(
        tmp_path, lambda msg: {"reqId": msg["reqId"], "ok": False, "reason": "closed"}
    )
    with pytest.raises(RoomClosed):
        await ports.persist(
            Save.CHECKPOINT, wav=None, checkpoint_pcm=np.zeros(64, np.float32),
            meta_json="{}", text="",
        )
    ports.spool.unlink()


async def test_a_host_that_is_not_connected_is_persist_failed_not_room_closed(
    tmp_path: Path,
) -> None:
    """A save with nobody on the other end must be RETRYABLE. RoomClosed makes
    ``Engine.flush`` stop the session quietly and abandon everything still in
    memory -- only Electron can say the room closed."""
    ports, engine, _fake = _ports_with_engine(tmp_path)
    ports.host.ws = None
    with pytest.raises(PersistFailed):
        await ports.persist(
            Save.CHECKPOINT, wav=None, checkpoint_pcm=np.zeros(64, np.float32),
            meta_json="{}", text="",
        )
    ports.spool.unlink()


async def test_a_host_socket_that_drops_mid_save_fails_that_save_at_once(tmp_path: Path) -> None:
    """Electron reconnecting, reloading or dying is NOT the room closing: the
    save fails (and is retried on the engine's own backoff), and it fails
    immediately rather than blocking the run loop for the whole ack timeout."""

    class _SilentSocket:
        async def send_text(self, text: str) -> None:
            return None

    ports, engine, _fake = _ports_with_engine(tmp_path)
    ports.host.ws = _SilentSocket()
    task = asyncio.create_task(
        ports.persist(
            Save.CHECKPOINT, wav=None, checkpoint_pcm=np.zeros(64, np.float32),
            meta_json="{}", text="",
        )
    )
    await asyncio.sleep(0.05)
    started = time.monotonic()
    ports.host.detach()  # exactly what the /rec/host route's `finally` does
    with pytest.raises(PersistFailed):
        await asyncio.wait_for(task, timeout=3)
    assert time.monotonic() - started < 2, "the save waited out the ack timeout instead of failing"
    ports.spool.unlink()


async def test_a_spool_write_failure_becomes_persist_failed(tmp_path: Path) -> None:
    """An OSError out of the spool must not escape ``persist()``: ``Engine.flush``
    catches PersistFailed/RoomClosed and nothing else, so anything else unwinds
    out of the run loop and leaves every reply future pending for ever."""
    if os.geteuid() == 0:  # pragma: no cover - the CI user is not root
        pytest.skip("cannot make a directory unwritable as root")
    spool_dir = tmp_path / "readonly"
    spool_dir.mkdir()
    ports, engine, _fake = _ports_with_engine(spool_dir)
    ports.spool.unlink()  # the next append has to recreate the file
    os.chmod(spool_dir, 0o500)
    try:
        with pytest.raises(PersistFailed, match="spool file could not be written"):
            await ports.persist(
                Save.CHECKPOINT, wav=None, checkpoint_pcm=np.zeros(64, np.float32),
                meta_json="{}", text="",
            )
    finally:
        os.chmod(spool_dir, 0o700)


async def test_a_full_save_with_no_wav_is_reported_not_raised(tmp_path: Path) -> None:
    ports, engine, _fake = _ports_with_engine(tmp_path)
    with pytest.raises(PersistFailed, match="no WAV bytes"):
        await ports.persist(Save.FULL, wav=None, checkpoint_pcm=None, meta_json="{}", text="")
    ports.spool.unlink()


async def test_an_ack_without_a_req_id_still_resolves_the_one_request(tmp_path: Path) -> None:
    """A courtesy to a simpler host: with exactly one request outstanding there
    is no ambiguity about what an un-correlated ack is answering. Bounded well
    under :data:`PERSIST_TIMEOUT`, so a fallback that stopped working shows up
    as a failure here rather than as a 15 s stall."""
    ports, engine, _fake = _ports_with_engine(tmp_path, lambda msg: {"ok": True})
    await asyncio.wait_for(
        ports.persist(Save.TRANSCRIPT, wav=None, checkpoint_pcm=None, meta_json="{}", text=""),
        timeout=2,
    )
    ports.spool.unlink()


async def test_a_stale_ok_ack_never_answers_the_save_that_is_actually_waiting(
    tmp_path: Path,
) -> None:
    """THE REGRESSION: a host whose ack arrives after its own save timed out --
    a slow encrypted write, a machine that swapped -- carries an id nobody is
    waiting on any more. Handing it to whatever IS outstanding tells ``Engine``
    a chunk was written that Electron never wrote: ``flushed_samples`` advances
    past it and nothing ever writes it again. That audio is gone from the room
    while the recording carries on looking healthy."""
    link = _HostLink()

    class _Mute:
        async def send_text(self, text: str) -> None:
            return None

    link.ws = _Mute()
    with pytest.raises(PersistFailed):
        await link.call({"reqId": "save-1"}, timeout=0.05)  # this one gives up

    task = asyncio.create_task(link.call({"reqId": "save-2"}, timeout=1.0))
    await asyncio.sleep(0.02)
    link.resolve({"reqId": "save-1", "ok": True})  # the late answer to save-1
    with pytest.raises(PersistFailed):
        await asyncio.wait_for(task, timeout=3)


async def test_a_stale_closed_ack_cannot_end_a_live_recording(tmp_path: Path) -> None:
    """The same stale ack, at its worst: ``RoomClosed`` makes ``Engine.flush``
    stop the session QUIETLY and abandon everything still in memory. Only an ack
    for the save that is actually outstanding may say that."""
    link = _HostLink()

    class _Mute:
        async def send_text(self, text: str) -> None:
            return None

    link.ws = _Mute()
    with pytest.raises(PersistFailed):
        await link.call({"reqId": "save-1"}, timeout=0.05)

    task = asyncio.create_task(link.call({"reqId": "save-2"}, timeout=1.0))
    await asyncio.sleep(0.02)
    link.resolve({"reqId": "save-1", "ok": False, "reason": "closed"})
    with pytest.raises(PersistFailed):  # never RoomClosed
        await asyncio.wait_for(task, timeout=3)


async def test_a_duplicate_ack_does_not_spill_onto_the_next_save(tmp_path: Path) -> None:
    """A host that acks twice for one save (a retry on its own side) must not
    have its second copy answer the NEXT one."""
    acks: list[dict] = []

    def ack_twice(msg: dict) -> dict:
        acks.append(msg)
        return {"reqId": msg["reqId"], "ok": True}

    ports, _engine, fake = _ports_with_engine(tmp_path, ack_twice)
    await ports.persist(Save.TRANSCRIPT, wav=None, checkpoint_pcm=None, meta_json="{}", text="")
    first_id = fake.sent[-1]["reqId"]

    # The duplicate lands while the SECOND save is in flight and failing.
    def ack_failed(msg: dict) -> dict:
        ports.host.resolve({"reqId": first_id, "ok": True})  # the duplicate
        return {"reqId": msg["reqId"], "ok": False, "reason": "failed", "message": "disk full"}

    ports.host.ws = _FakeHostSocket(ports.host, ack_failed)
    with pytest.raises(PersistFailed, match="disk full"):
        await ports.persist(
            Save.TRANSCRIPT, wav=None, checkpoint_pcm=None, meta_json="{}", text=""
        )
    ports.spool.unlink()


async def test_persist_makes_exactly_one_save_attempt(tmp_path: Path) -> None:
    """``persist()``'s whole contract is "try once, report honestly": the retry
    belongs to ``Engine.flush_failed_at``/``FLUSH_RETRY_BACKOFF``. A retry loop
    in here would double every save during an outage and report an outage that
    had already been reported."""
    ports, _engine, fake = _ports_with_engine(
        tmp_path,
        lambda msg: {"reqId": msg["reqId"], "ok": False, "reason": "failed", "message": "nope"},
    )
    with pytest.raises(PersistFailed):
        await ports.persist(
            Save.CHECKPOINT, wav=None, checkpoint_pcm=np.zeros(32, np.float32),
            meta_json="{}", text="",
        )
    assert len(fake.sent) == 1, "persist() retried a failed save by itself"
    # And the caller -- and only the caller -- can ask again.
    with pytest.raises(PersistFailed):
        await ports.persist(
            Save.CHECKPOINT, wav=None, checkpoint_pcm=np.zeros(32, np.float32),
            meta_json="{}", text="",
        )
    assert len(fake.sent) == 2
    ports.spool.unlink()


async def test_a_host_that_never_answers_at_all_is_persist_failed(
    tmp_path: Path, monkeypatch
) -> None:
    """No reply, ever: the save must fail (retryable) at the deadline -- never
    hang the engine's run loop for good, never come back as ``RoomClosed``, and
    never leave its frame on the end of the spool or its future in the pending
    table."""
    monkeypatch.setattr(session_ws, "PERSIST_TIMEOUT", 0.15)

    class _Mute:
        async def send_text(self, text: str) -> None:
            return None

    ports, _engine, _fake = _ports_with_engine(tmp_path)
    ports.host.ws = _Mute()
    started = time.monotonic()
    with pytest.raises(PersistFailed, match="did not answer in time"):
        await asyncio.wait_for(
            ports.persist(
                Save.CHECKPOINT, wav=None, checkpoint_pcm=np.zeros(64, np.float32),
                meta_json="{}", text="",
            ),
            timeout=5,
        )
    assert time.monotonic() - started < 3
    assert os.stat(ports.spool.path).st_size == 0, "the un-ACKed frame stayed on the spool"
    assert ports.host._pending == {}, "the timed-out request leaked into the pending table"
    ports.spool.unlink()


async def test_persist_failure_surfaces_engines_own_documented_backoff(tmp_path: Path) -> None:
    """``Engine``'s once-per-outage reporting, through this module's wiring: the
    failure must arrive as ONE `error` wire event, not one per retry."""
    from arcelle_sidecar.rec.engine import FLUSH_RETRY_BACKOFF

    failing = True

    def ack_fn(msg: dict) -> dict:
        if failing:
            return {"reqId": msg["reqId"], "ok": False, "reason": "failed", "message": "disk full"}
        return {"reqId": msg["reqId"], "ok": True}

    ports, engine, _fake = _ports_with_engine(tmp_path, ack_fn)
    queue = ports.attach_session_socket(object())
    await engine.handle(MsgAudio(Source.MIC, SAMPLE_RATE, np.full(SAMPLE_RATE, 0.05, np.float32)))

    assert await engine.flush(Save.CHECKPOINT) is False
    assert engine.flushed_samples == 0
    errors = [e["message"] for e in _drain(queue) if e["type"] == "error"]
    assert len(errors) == 1 and "retrying" in errors[0] and "disk full" in errors[0]

    assert await engine.flush(Save.CHECKPOINT) is False
    assert not [e for e in _drain(queue) if e["type"] == "error"]

    engine.flush_failed_at = time.monotonic() - FLUSH_RETRY_BACKOFF - 0.01
    assert await engine.flush(Save.CHECKPOINT) is False
    assert len([e for e in _drain(queue) if e["type"] == "error"]) == 1

    failing = False
    assert await engine.flush(Save.CHECKPOINT) is True
    assert engine.flush_failed_at is None and engine.flushed_samples > 0
    ports.spool.unlink()


async def test_room_closed_ends_the_engine_session_quietly(tmp_path: Path) -> None:
    ports, engine, _fake = _ports_with_engine(
        tmp_path, lambda msg: {"reqId": msg["reqId"], "ok": False, "reason": "closed"}
    )
    assert engine.stopping is False
    assert await engine.flush(Save.CHECKPOINT) is False
    assert engine.stopping is True
    ports.spool.unlink()


# ============================================================================
# ---- emit(): the wire vocabulary, derived lang-locked, ordered delivery ----
# ============================================================================


async def test_state_events_split_into_state_and_stopped(tmp_path: Path) -> None:
    ports, engine, _fake = _ports_with_engine(tmp_path)
    queue = ports.attach_session_socket(object())
    for status in ("recording", "paused", "saving", "saved", "failed"):
        engine.status = status
        engine.emit_state()
    types = [e["type"] for e in _drain(queue)]
    assert types == ["state", "state", "state", "stopped", "stopped"]
    ports.spool.unlink()


async def test_room_files_changed_is_never_forwarded(tmp_path: Path) -> None:
    ports, engine, _fake = _ports_with_engine(tmp_path)
    queue = ports.attach_session_socket(object())
    ports.emit("room-files-changed", {})
    assert _drain(queue) == []
    ports.spool.unlink()


async def test_an_unknown_event_is_forwarded_rather_than_dropped(tmp_path: Path) -> None:
    ports, engine, _fake = _ports_with_engine(tmp_path)
    queue = ports.attach_session_socket(object())
    ports.emit("rec-something-new", {"fileId": "f"})
    assert _drain(queue) == [{"type": "rec-something-new", "fileId": "f"}]
    ports.spool.unlink()


async def test_lang_locked_is_derived_and_a_final_maps_to_the_final_wire_type(
    tmp_path: Path,
) -> None:
    ports, engine, _fake = _ports_with_engine(tmp_path)
    queue = ports.attach_session_socket(object())
    seg = SegOut(
        t0=0,
        t1=400,
        text="hello there my friend",
        words=[("hello", 0, 100), ("there", 100, 200), ("my", 200, 300), ("friend", 300, 400)],
        lang="en",
        mean_p=0.9,
    )
    await engine.handle(
        MsgDecodeDone(
            DecodeOut(
                kind=JobKind.FINAL, source=Source.MIC, start=0, n_samples=SAMPLE_RATE * 4,
                segs=[seg], detected=("en", 0.95), emb=None, wins=[], err=None,
            )
        )
    )
    events = _drain(queue)
    locked = [e for e in events if e["type"] == "lang-locked"]
    assert locked, "no lang-locked event derived on the first lock"
    assert locked[0] == {"type": "lang-locked", "fileId": "f", "source": "mic", "lang": "en"}
    finals = [e for e in events if e["type"] == "final"]
    assert finals and finals[0]["segment"]["text"] == "hello there my friend"
    # The 192-float voiceprint is never put on the wire.
    assert "voice" not in finals[0]["segment"]
    ports.spool.unlink()


async def test_events_reach_a_slow_socket_in_order(tmp_path: Path) -> None:
    """THE REGRESSION: one fire-and-forget task per event per socket lets a
    frame that blocks on backpressure be overtaken by the next one, and the
    renderer sees a `final` before the `partial` it replaces (measured:
    partial/final/stopped arrived as final/stopped/partial)."""
    arrived: list[str] = []

    class _SlowFirstSocket:
        def __init__(self) -> None:
            self.n = 0

        async def send_text(self, text: str) -> None:
            self.n += 1
            if self.n == 1:
                await asyncio.sleep(0.05)
            arrived.append(json.loads(text)["type"])

    ports, engine, _fake = _ports_with_engine(tmp_path)
    sock = _SlowFirstSocket()
    queue = ports.attach_session_socket(sock)
    pump = asyncio.create_task(_pump_session_socket(sock, queue))
    ports.emit("rec-partial", {"fileId": "f", "text": "still speak"})
    ports.emit("rec-segment", {"fileId": "f", "segment": {}})
    ports.emit("rec-state", {"fileId": "f", "status": "saved"})
    await asyncio.sleep(0.3)
    pump.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await pump
    assert arrived == ["partial", "final", "stopped"]
    ports.spool.unlink()


# ============================================================================
# ---- translate(): the think-span-stripping contract ------------------------
# ============================================================================


async def test_translate_strips_think_spans_and_trims(tmp_path: Path, monkeypatch) -> None:
    """``EnginePorts.translate``'s own words: THE PORT OWNS THE CLEAN-UP. The
    room's default model is a reasoning one, so raw output paints
    ``<think>...</think>`` into the live translation."""
    seen: dict = {}

    async def fake_generate(model, messages, base_url, **kwargs):
        seen.update(model=model, messages=messages, base_url=base_url, kwargs=kwargs)
        return "<think>The user wants Spanish. Hmm.</think>\n  Hola, mundo.  "

    monkeypatch.setattr(session_ws.llm, "generate", fake_generate)
    ports, _engine, _fake = _ports_with_engine(tmp_path)
    assert await ports.translate("Hello, world.", "Spanish", "qwen3.5:4b") == "Hola, mundo."
    assert seen["model"] == "qwen3.5:4b"
    assert seen["base_url"] == "http://127.0.0.1:11434"
    assert "Spanish" in seen["messages"][0]["content"]
    assert "Hello, world." in seen["messages"][0]["content"]
    assert seen["kwargs"]["temperature"] == 0.2 and seen["kwargs"]["keep_alive"] == "5m"
    ports.spool.unlink()


async def test_translate_returns_none_for_an_empty_or_failed_answer(
    tmp_path: Path, monkeypatch
) -> None:
    ports, _engine, _fake = _ports_with_engine(tmp_path)

    async def only_thinking(model, messages, base_url, **kwargs):
        return "<think>I cannot decide</think>   "

    monkeypatch.setattr(session_ws.llm, "generate", only_thinking)
    assert await ports.translate("Hello", "Spanish", "m") is None

    async def boom(model, messages, base_url, **kwargs):
        raise RuntimeError("ollama is not running")

    monkeypatch.setattr(session_ws.llm, "generate", boom)
    assert await ports.translate("Hello", "Spanish", "m") is None

    # An UNTERMINATED think span truncates the rest (`strip_think_spans`'s own
    # rule): what follows is unclosed reasoning, not an answer, and showing it
    # would paint the model's deliberation into the live translation.
    async def never_closed(model, messages, base_url, **kwargs):
        return "<think>Let me consider the register. Hola? Buenos días?"

    monkeypatch.setattr(session_ws.llm, "generate", never_closed)
    assert await ports.translate("Hello", "Spanish", "m") is None

    # A failure is never fatal: the live-translate worker calls straight into
    # this and dies for the whole session on anything that raises.
    async def refuses(model, messages, base_url, **kwargs):
        raise asyncio.TimeoutError()

    monkeypatch.setattr(session_ws.llm, "generate", refuses)
    assert await ports.translate("Hello", "Spanish", "m") is None
    ports.spool.unlink()


# ============================================================================
# ---- the routes, over real HTTP + real WebSockets ---------------------------
# ============================================================================


def test_one_live_session_at_a_time_and_the_slot_reopens(tmp_path: Path) -> None:
    app, manager = _app()
    with TestClient(app) as client:
        r1 = _post(client, "/rec/start", _start_body("f1", tmp_path))
        assert r1.status_code == 200, r1.text
        body = r1.json()
        assert body["ok"] is True and body["fileId"] == "f1"
        assert len(base64.b64decode(body["spoolKey"])) == 32
        assert body["spoolPath"] == str(tmp_path / "f1.spool")

        r2 = _post(client, "/rec/start", _start_body("f2", tmp_path))
        assert r2.status_code == 409 and r2.json()["code"] == "REC_ALREADY_LIVE"
        # The refused start must not have taken the live session's spool with it.
        assert Path(body["spoolPath"]).exists()

        with _acking_host(client, "f1"):
            assert _post(client, "/rec/pause", {"fileId": "f1"}).json() == {"ok": True}
            assert _post(client, "/rec/resume", {"fileId": "f1"}).json() == {"ok": True}
            assert _post(client, "/rec/set_live_stt", {"fileId": "f1", "on": False}).json() == {"ok": True}
            assert _post(
                client, "/rec/set_live_translate", {"fileId": "f1", "lang": "es"}
            ).json() == {"ok": True}
            # Fire-and-forget: the response only promises the message was
            # enqueued, so poll rather than assert immediately.
            _wait_until(lambda: manager.current.engine.live_stt is False)
            _wait_until(lambda: manager.current.engine.live_translate == "es")

            wrong = _post(client, "/rec/pause", {"fileId": "not-the-live-one"})
            assert wrong.status_code == 404 and wrong.json()["code"] == "REC_NOT_LIVE"

            stop = _post(client, "/rec/stop", {"fileId": "f1"})
        assert stop.status_code == 200 and stop.json()["ok"] is True
        assert manager.current is None

        r3 = _post(client, "/rec/start", _start_body("f3", tmp_path))
        assert r3.status_code == 200
        with _acking_host(client, "f3"):
            _post(client, "/rec/stop", {"fileId": "f3"})


def test_a_self_stopped_session_frees_the_slot(tmp_path: Path) -> None:
    """THE REGRESSION: an engine that stops ITSELF (the room closing under it,
    the 3-hour ceiling) has nobody to call ``/rec/stop`` for it. A slot only
    cleared by that route stays occupied for ever, and every later
    ``/rec/start`` answers 409."""
    app, manager = _app()
    with TestClient(app) as client:
        assert _post(client, "/rec/start", _start_body("closing", tmp_path)).status_code == 200
        closed = lambda msg: {"reqId": msg["reqId"], "ok": False, "reason": "closed"}  # noqa: E731
        with _acking_host(client, "closing", ack_fn=closed):
            # Any edit forces a flush, which is where the room's closure lands.
            _post(client, "/rec/edit_meta",
                  {"fileId": "closing", "op": "add_chapter", "t0": 0, "title": "x"})
            _wait_until(lambda: manager.current is None, timeout=15)
        assert _post(client, "/rec/start", _start_body("after", tmp_path)).status_code == 200
        with _acking_host(client, "after"):
            _post(client, "/rec/stop", {"fileId": "after"})


def test_each_session_gets_its_own_spool_key(tmp_path: Path) -> None:
    """One key per SESSION, never a per-app or per-install one: two recordings
    that share a key share a compromise, and the whole point of §5 is that the
    key exists only for as long as the session does."""
    app, _manager = _app(token=None)
    keys = []
    with TestClient(app) as client:
        for file_id in ("k1", "k2", "k3"):
            start = client.post("/rec/start", json=_start_body(file_id, tmp_path))
            assert start.status_code == 200
            key = base64.b64decode(start.json()["spoolKey"])
            assert len(key) == 32
            keys.append(key)
            with _acking_host(client, file_id, token=None):
                client.post("/rec/stop", json={"fileId": file_id})
    assert len(set(keys)) == len(keys), "two sessions were handed the same spool key"
    # And a key that is genuinely random, not a counter or a hash of the fileId.
    assert all(len(set(k)) > 8 for k in keys)


def test_a_start_that_cannot_build_its_engine_leaves_no_spool_behind(tmp_path: Path) -> None:
    """THE REGRESSION: the spool file is created BEFORE the engine is. A start
    that then fails used to leave the file on disk, and ``O_EXCL`` means a
    leftover refuses EVERY later ``/rec/start`` for that file with
    ``REC_SPOOL_EXISTS`` -- for ever, on a recording that never started and has
    nothing to recover. One malformed body permanently blocked recording that
    file.

    ``maxSpeakers`` as a string is a real wire shape: ``RecMeta.from_dict``
    reads it leniently and ``SpeakerBook`` only fails on it deep inside
    ``Engine.__init__``, past every check this route makes."""
    app, manager = _app(token=None)
    bad_meta = {"durationCs": 0, "segments": [], "cuts": [], "maxSpeakers": "3"}
    with TestClient(app, raise_server_exceptions=False) as client:
        failed = client.post("/rec/start", json=_start_body("brick", tmp_path) | {"meta": bad_meta})
        assert failed.status_code == 500
        assert failed.json()["code"] == "REC_START_FAILED"
        assert not (tmp_path / "brick.spool").exists(), "a failed start left its spool behind"
        assert manager.current is None
        # The next, well-formed start for the SAME file must simply work.
        again = client.post("/rec/start", json=_start_body("brick", tmp_path))
        assert again.status_code == 200, again.text
        with _acking_host(client, "brick", token=None):
            client.post("/rec/stop", json={"fileId": "brick"})


def test_an_engine_that_dies_abnormally_frees_the_slot_and_its_spool(
    tmp_path: Path, monkeypatch
) -> None:
    """Not the room closing and not a ``/rec/stop`` -- a run loop that fell over.
    The slot must reopen anyway (a single slot nobody can clear blocks every
    later recording), the spool must not be left behind, and ``/rec/stop`` for
    the dead session must answer rather than wait for a reply that will never
    come."""
    from arcelle_sidecar.rec.engine import Engine

    async def falls_over(self) -> None:
        raise RuntimeError("the run loop fell over")

    monkeypatch.setattr(Engine, "run", falls_over)
    app, manager = _app(token=None)
    with TestClient(app) as client:
        assert client.post("/rec/start", json=_start_body("dead", tmp_path)).status_code == 200
        _wait_until(lambda: manager.current is None, timeout=5)
        assert not (tmp_path / "dead.spool").exists()
        stop = client.post("/rec/stop", json={"fileId": "dead"})
        assert stop.status_code == 404 and stop.json()["code"] == "REC_NOT_LIVE"
        monkeypatch.undo()
        assert client.post("/rec/start", json=_start_body("alive", tmp_path)).status_code == 200
        with _acking_host(client, "alive", token=None):
            assert client.post("/rec/stop", json={"fileId": "alive"}).status_code == 200


def test_two_apps_have_independent_session_slots(tmp_path: Path) -> None:
    """THE REGRESSION: a module-global slot makes two ``create_app()`` instances
    share one recording -- app 2 refuses to start because app 1 is busy."""
    app1, manager1 = _app(token=None)
    app2, manager2 = _app(token=None)
    with TestClient(app1) as c1, TestClient(app2) as c2:
        assert c1.post("/rec/start", json=_start_body("on-one", tmp_path / "a")).status_code == 200
        assert c2.post("/rec/start", json=_start_body("on-two", tmp_path / "b")).status_code == 200
        assert manager1.current is not manager2.current
        for client, file_id in ((c1, "on-one"), (c2, "on-two")):
            # No host attached: the final save fails fast and 502s, which still
            # finalizes the session.
            assert client.post("/rec/stop", json={"fileId": file_id}).status_code == 502
        assert manager1.current is None and manager2.current is None


def test_http_header_auth_still_gates_the_rec_routes(tmp_path: Path) -> None:
    app, _manager = _app(token=TOKEN)
    with TestClient(app) as client:
        anon = client.post("/rec/start", json=_start_body("f-anon", tmp_path))
        assert anon.status_code == 401 and anon.json()["code"] == "NO_TOKEN"

        wrong = client.post(
            "/rec/start", json=_start_body("f-wrong", tmp_path),
            headers={"authorization": "Bearer nope"},
        )
        assert wrong.status_code == 401

        right = _post(client, "/rec/start", _start_body("f-right", tmp_path))
        assert right.status_code == 200
        with _acking_host(client, "f-right"):
            _post(client, "/rec/stop", {"fileId": "f-right"})


def test_ws_routes_need_the_query_token(tmp_path: Path) -> None:
    app, _manager = _app(token=TOKEN)
    with TestClient(app) as client:
        assert _post(client, "/rec/start", _start_body("f-auth", tmp_path)).status_code == 200
        for path in ("/rec/session", "/rec/host"):
            with pytest.raises(WebSocketDisconnect) as missing:
                with client.websocket_connect(f"{path}?fileId=f-auth"):
                    pass
            assert missing.value.code == 4401

            with pytest.raises(WebSocketDisconnect) as wrong:
                with client.websocket_connect(f"{path}?token=nope&fileId=f-auth"):
                    pass
            assert wrong.value.code == 4401

            with client.websocket_connect(_ws_url(path, "f-auth")):
                pass
        with _acking_host(client, "f-auth"):
            _post(client, "/rec/stop", {"fileId": "f-auth"})


def test_the_ws_token_check_runs_before_any_audio_or_save_traffic(tmp_path: Path) -> None:
    """A close code is not the point -- what matters is that the route never
    ran. An unauthenticated socket must not be attached to the session's
    broadcast set, must not become its host link (from where it could ACK saves
    the room never wrote), and must not put one sample into the engine."""
    app, manager = _app(token=TOKEN)
    with TestClient(app) as client:
        assert _post(client, "/rec/start", _start_body("f-guard", tmp_path)).status_code == 200
        session = manager.current
        for url in (
            "/rec/session?fileId=f-guard",  # no token at all
            "/rec/session?token=&fileId=f-guard",  # a blank one
            "/rec/session?token=nope&fileId=f-guard",
            f"/rec/session?token={TOKEN}x&fileId=f-guard",  # a near miss
            "/rec/host?fileId=f-guard",
            "/rec/host?token=nope&fileId=f-guard",
        ):
            with pytest.raises(WebSocketDisconnect) as exc:
                with client.websocket_connect(url) as ws:
                    ws.send_bytes(
                        _encode_audio_frame(0, SAMPLE_RATE, np.full(SAMPLE_RATE, 0.5, np.float32))
                    )
                    ws.send_json({"reqId": "x", "ok": True})
            assert exc.value.code == 4401, url
        assert session.ports._queues == {}, "an unauthenticated socket was attached"
        assert session.ports.host.ws is None, "an unauthenticated socket became the host link"
        assert session.engine.inbox.qsize() == 0 and session.engine.duration_cs == 0
        with _acking_host(client, "f-guard"):
            assert _post(client, "/rec/stop", {"fileId": "f-guard"}).status_code == 200


def test_mounting_the_rec_routes_left_the_header_auth_alone(tmp_path: Path) -> None:
    """The websocket branch is an ADDITION to ``TokenAuthMiddleware``, not a
    replacement: every HTTP route still wants the bearer header, ``/health`` is
    still the one open path, and a `?token=` on an HTTP request buys nothing."""
    app = create_app(token="s3cret")
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        anon = client.post("/cancel", json={"run_id": "x"})
        assert anon.status_code == 401 and anon.json()["code"] == "NO_TOKEN"
        assert client.post(
            "/cancel", json={"run_id": "x"}, headers={"authorization": "Bearer nope"}
        ).status_code == 401
        # The query parameter is a WEBSOCKET affordance only -- it must not open
        # an HTTP route, or the token starts riding referrers and shell history.
        assert client.post("/cancel?token=s3cret", json={"run_id": "x"}).status_code == 401
        right = client.post(
            "/cancel", json={"run_id": "x"}, headers={"authorization": "Bearer s3cret"}
        )
        assert right.status_code == 200
        assert right.json() == {"ok": True, "known": False, "stopped": []}


def test_ws_routes_close_4404_for_an_unknown_session(tmp_path: Path) -> None:
    app, _manager = _app(token=None)
    with TestClient(app) as client:
        for path in ("/rec/session", "/rec/host"):
            with pytest.raises(WebSocketDisconnect) as exc:
                with client.websocket_connect(f"{path}?fileId=nobody"):
                    pass
            assert exc.value.code == 4404


def test_a_second_host_connection_is_refused(tmp_path: Path) -> None:
    app, _manager = _app(token=None)
    with TestClient(app) as client:
        assert client.post("/rec/start", json=_start_body("f-host", tmp_path)).status_code == 200
        with client.websocket_connect(_ws_url("/rec/host", "f-host", None)):
            with pytest.raises(WebSocketDisconnect) as exc:
                with client.websocket_connect(_ws_url("/rec/host", "f-host", None)):
                    pass
            assert exc.value.code == 4409
        client.post("/rec/stop", json={"fileId": "f-host"})


def test_a_stale_spool_file_refuses_the_start(tmp_path: Path) -> None:
    """Rather than being discovered at the first checkpoint, where an
    unhandled ``FileExistsError`` used to kill the whole run loop."""
    app, _manager = _app(token=None)
    (tmp_path / "f-stale.spool").write_bytes(b"a crashed session left this")
    with TestClient(app) as client:
        r = client.post("/rec/start", json=_start_body("f-stale", tmp_path))
        assert r.status_code == 409 and r.json()["code"] == "REC_SPOOL_EXISTS"
        assert (tmp_path / "f-stale.spool").read_bytes() == b"a crashed session left this"


def test_a_file_id_cannot_escape_the_spool_directory(tmp_path: Path) -> None:
    app, _manager = _app(token=None)
    with TestClient(app) as client:
        r = client.post("/rec/start", json=_start_body("../escaped", tmp_path))
        assert r.status_code == 400 and r.json()["code"] == "REC_BAD_REQUEST"
        assert not (tmp_path.parent / "escaped.spool").exists()


def test_a_malformed_binary_frame_is_dropped_not_fatal(tmp_path: Path) -> None:
    app, manager = _app()
    with TestClient(app) as client:
        assert _post(client, "/rec/start", _start_body("f-bad", tmp_path)).status_code == 200
        with _acking_host(client, "f-bad"):
            with client.websocket_connect(_ws_url("/rec/session", "f-bad")) as ws:
                ws.send_bytes(b"\x00\x01\x02")  # too short for the header
                ws.send_bytes(struct.pack("<BBHII", 0, 0, 0, SAMPLE_RATE, 999_999))  # lying n
                ws.send_bytes(struct.pack("<BBHII", 7, 0, 0, SAMPLE_RATE, 0))  # unknown lane
                ws.send_text("{not json")
                ws.send_text(json.dumps({"type": "who-knows"}))
                # Still alive: a real frame lands and reaches the engine.
                ws.send_bytes(
                    _encode_audio_frame(0, SAMPLE_RATE, np.zeros(SAMPLE_RATE // 4, np.float32))
                )
                _wait_until(lambda: manager.current.engine.duration_cs > 0)
            stop = _post(client, "/rec/stop", {"fileId": "f-bad"})
        assert stop.status_code == 200


def test_edit_meta_over_http_applies_refuses_and_validates(tmp_path: Path) -> None:
    app, _manager = _app()
    with TestClient(app) as client:
        assert _post(client, "/rec/start", _start_body("f-edit", tmp_path)).status_code == 200
        with _acking_host(client, "f-edit"):
            ok = _post(client, "/rec/edit_meta", {
                "fileId": "f-edit", "op": "add_note", "t0": 5, "kind": "decision", "text": "ship it",
            })
            assert ok.status_code == 200, ok.text
            notes = ok.json()["meta"]["notes"]
            assert notes and notes[0]["text"] == "ship it" and notes[0]["by"] == "you"

            bad_op = _post(client, "/rec/edit_meta", {"fileId": "f-edit", "op": "nonsense"})
            assert bad_op.status_code == 400 and bad_op.json()["code"] == "REC_BAD_EDIT_OP"

            # The op's own refusal (nobody is labelled that) is a 400 too, but
            # it comes back through `apply`'s Result-shaped return value.
            refused = _post(client, "/rec/edit_meta", {
                "fileId": "f-edit", "op": "rename_speaker", "label": "Speaker 9", "name": "Ben",
            })
            assert refused.status_code == 400
            assert refused.json()["code"] == "REC_EDIT_META_FAILED"
            assert "no transcript yet" in refused.json()["error"]

            _post(client, "/rec/stop", {"fileId": "f-edit"})


def test_a_checkpoint_writes_a_genuinely_encrypted_spool_frame(tmp_path: Path) -> None:
    app, manager = _app()
    with TestClient(app) as client:
        start = _post(client, "/rec/start", _start_body("f-spool", tmp_path))
        assert start.status_code == 200
        spool_key = base64.b64decode(start.json()["spoolKey"])
        spool_path = Path(start.json()["spoolPath"])
        # NO_MODEL must never reach a real decode (pywhispercpp aborts the
        # process on a missing model rather than raising), so live STT goes off
        # before any audio is pushed.
        assert _post(client, "/rec/set_live_stt", {"fileId": "f-spool", "on": False}).status_code == 200
        _wait_until(lambda: manager.current.engine.live_stt is False)

        tone = (np.sin(np.linspace(0, 400, SAMPLE_RATE * 2, dtype=np.float32)) * 0.2).astype(np.float32)
        with _acking_host(client, "f-spool") as saves:
            with client.websocket_connect(_ws_url("/rec/session", "f-spool")) as ws:
                _push_audio(ws, 0, tone)
                _wait_until(lambda: manager.current.engine.duration_cs >= 199)
                # An edit always flushes once `apply` succeeds -- a deterministic
                # checkpoint trigger, instead of waiting out the 60 s cadence.
                edit = _post(client, "/rec/edit_meta", {
                    "fileId": "f-spool", "op": "add_chapter", "t0": 0, "title": "Intro",
                })
                assert edit.status_code == 200, edit.text

            checkpoints = [s for s in saves if s["kind"] == "checkpoint" and s["spoolRange"]]
            assert checkpoints, "no checkpoint with real audio reached /rec/host"
            save = checkpoints[-1]

            assert os.stat(spool_path).st_mode & 0o777 == 0o600
            raw = spool_path.read_bytes()
            plaintext = tone.astype("<f4").tobytes()
            assert plaintext not in raw, "raw PCM is recoverable from the spool file"
            # Not one byte of the sample data survives in the clear.
            assert plaintext[:64] not in raw

            start_b, end_b = save["spoolRange"]
            region = raw[start_b:end_b]
            assert struct.unpack_from("<I", region, 0)[0] == len(region) - 4
            nonce, ciphertext = region[4:16], region[16:]
            recovered = AESGCM(spool_key).decrypt(nonce, ciphertext, None)
            assert recovered == plaintext[: len(recovered)]
            assert len(recovered) == (save["toSample"] - save["fromSample"]) * 4
            with pytest.raises(InvalidTag):
                AESGCM(AESGCM.generate_key(bit_length=256)).decrypt(nonce, ciphertext, None)

            stop = _post(client, "/rec/stop", {"fileId": "f-spool"})
            assert stop.status_code == 200, stop.text
        # The stop's own Save.FULL supersedes every checkpoint.
        assert not spool_path.exists()


def test_the_startup_tap_request_still_reaches_a_socket_that_connects_after_it(
    tmp_path: Path,
) -> None:
    """THE REGRESSION: ``run()`` asks for the meeting tap the moment the session's
    run task is scheduled -- which is ALWAYS before the renderer, which cannot
    connect until ``/rec/start``'s response has reached it. Broadcast to a set of
    sockets that is provably empty, the request was simply lost, and
    ``Engine.start_sys_tap`` is a one-shot (``sys_tap_starting`` refuses a second
    one, so not even a pause/resume recovers it): a "record meeting audio"
    session sat in `starting` for its whole life and captured nothing but the
    microphone, silently."""
    app, manager = _app()
    with TestClient(app) as client:
        start = _post(client, "/rec/start", _start_body("f-late", tmp_path, system_audio=True))
        assert start.status_code == 200
        # The engine has certainly asked by now -- and nobody was listening.
        _wait_until(lambda: manager.current.engine.sys_tap_starting is True)
        with _acking_host(client, "f-late"):
            with client.websocket_connect(_ws_url("/rec/session", "f-late")) as ws:
                received: list = []
                collector = threading.Thread(target=_run_collector, args=(ws, received), daemon=True)
                collector.start()
                _wait_until(
                    lambda: any(
                        e.get("type") == "sys-tap-request" and e.get("action") == "start"
                        for e in received
                    ),
                    timeout=5,
                )
                # And it is a real request, not a stray line: answering it brings
                # the meeting lane up.
                ws.send_json({"type": "sys-tap-result", "ok": True, "error": None})
                _wait_until(lambda: manager.current.engine.sys_tap_up)

                # A SECOND socket joining a session whose tap is already up must
                # NOT be asked to start another one -- two taps record and
                # transcribe the meeting twice.
                with client.websocket_connect(_ws_url("/rec/session", "f-late")) as ws2:
                    second: list = []
                    c2 = threading.Thread(target=_run_collector, args=(ws2, second), daemon=True)
                    c2.start()
                    _post(client, "/rec/edit_meta", {
                        "fileId": "f-late", "op": "add_chapter", "t0": 0, "title": "x",
                    })
                    time.sleep(0.3)
                    assert not [e for e in second if e.get("type") == "sys-tap-request"]
                c2.join(timeout=5)
            collector.join(timeout=5)
            _post(client, "/rec/stop", {"fileId": "f-late"})


def test_a_real_session_writes_several_independently_encrypted_checkpoints(
    tmp_path: Path,
) -> None:
    """Not the writer in isolation -- a live session, three real checkpoints,
    then the file read as BYTES. Every frame must carry its own nonce, cover its
    own byte range, and decrypt back to exactly the samples its ``fromSample``/
    ``toSample`` claim; no window of any chunk may be findable in the clear."""
    app, manager = _app()
    with TestClient(app) as client:
        start = _post(client, "/rec/start", _start_body("f-many", tmp_path))
        assert start.status_code == 200
        key = base64.b64decode(start.json()["spoolKey"])
        spool_path = Path(start.json()["spoolPath"])
        assert _post(client, "/rec/set_live_stt", {"fileId": "f-many", "on": False}).status_code == 200
        _wait_until(lambda: manager.current.engine.live_stt is False)

        pushed: list[np.ndarray] = []
        with _acking_host(client, "f-many") as saves:
            with client.websocket_connect(_ws_url("/rec/session", "f-many")) as ws:
                for i in range(3):
                    tone = (
                        np.sin(np.linspace(0, 300 + 137 * i, SAMPLE_RATE, dtype=np.float32))
                        * (0.2 + 0.1 * i)
                    ).astype(np.float32)
                    pushed.append(tone)
                    _push_audio(ws, 0, tone)
                    _wait_until(
                        lambda n=i: manager.current.engine.duration_cs >= (n + 1) * 100 - 1
                    )
                    edit = _post(client, "/rec/edit_meta", {
                        "fileId": "f-many", "op": "add_chapter", "t0": 0, "title": f"c{i}",
                    })
                    assert edit.status_code == 200, edit.text

            timeline = np.concatenate(pushed).astype("<f4").tobytes()
            raw = spool_path.read_bytes()
            checkpoints = [s for s in saves if s["kind"] == "checkpoint" and s["spoolRange"]]
            assert len(checkpoints) >= 2, f"expected several checkpoints, got {len(checkpoints)}"

            # Nothing of the audio is in the clear, anywhere in the file.
            for tone in pushed:
                plain = tone.astype("<f4").tobytes()
                assert plain not in raw
                for at in range(0, len(plain) - 64, 1021):
                    assert plain[at : at + 64] not in raw

            seen_nonces: set[bytes] = set()
            last_end = 0
            for save in checkpoints:
                start_b, end_b = save["spoolRange"]
                assert start_b >= last_end, "two checkpoint frames overlapped in the spool"
                last_end = end_b
                region = raw[start_b:end_b]
                assert struct.unpack_from("<I", region, 0)[0] == len(region) - 4
                nonce, ciphertext = region[4:16], region[16:]
                assert nonce not in seen_nonces, "a GCM nonce was reused inside one session"
                seen_nonces.add(nonce)
                recovered = AESGCM(key).decrypt(nonce, ciphertext, None)
                a, b = save["fromSample"], save["toSample"]
                assert len(recovered) == (b - a) * 4
                assert recovered == timeline[a * 4 : b * 4], "a chunk did not hold the audio it named"
            assert last_end == os.stat(spool_path).st_size

            stop = _post(client, "/rec/stop", {"fileId": "f-many"})
            assert stop.status_code == 200, stop.text
        assert not spool_path.exists()


def test_the_sys_tap_request_and_result_round_trip(tmp_path: Path) -> None:
    app, manager = _app()
    with TestClient(app) as client:
        start = _post(client, "/rec/start", _start_body("f-tap", tmp_path, system_audio=True))
        assert start.status_code == 200
        with _acking_host(client, "f-tap"):
            with client.websocket_connect(_ws_url("/rec/session", "f-tap")) as ws:
                received: list = []
                collector = threading.Thread(target=_run_collector, args=(ws, received), daemon=True)
                collector.start()
                # `run()`'s own startup request may have been broadcast before
                # this socket attached (nothing is buffered for a socket that is
                # not there yet, by design) -- answer it either way.
                ws.send_json({"type": "sys-tap-result", "ok": True, "error": None})
                _wait_until(lambda: manager.current.engine.sys_tap_up)

                _post(client, "/rec/pause", {"fileId": "f-tap"})
                _wait_until(lambda: any(
                    e.get("type") == "sys-tap-request" and e.get("action") == "stop" for e in received
                ))
                assert manager.current.engine.sys_tap_up is False

                _post(client, "/rec/resume", {"fileId": "f-tap"})
                _wait_until(lambda: any(
                    e.get("type") == "sys-tap-request" and e.get("action") == "start" for e in received
                ))
                _wait_until(lambda: manager.current.engine.sys_tap_starting is True)
                ws.send_json({"type": "sys-tap-result", "ok": False, "error": "no permission"})
                _wait_until(lambda: any(
                    e.get("type") == "source-health" and e.get("status") == "error" for e in received
                ))
                assert manager.current.engine.sys_tap_up is False
            collector.join(timeout=5)
            _post(client, "/rec/stop", {"fileId": "f-tap"})


def test_the_shared_app_really_mounts_these_routes(tmp_path: Path) -> None:
    """``server.create_app()``'s one addition, end to end: the routes exist on
    the real app, the manager is reachable, and `/health` still answers without
    a token."""
    app = create_app(token=TOKEN)
    paths = {getattr(r, "path", None) for r in app.routes}
    assert {"/rec/start", "/rec/stop", "/rec/session", "/rec/host"} <= paths
    assert isinstance(app.state.rec_manager, RecSessionManager)
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        assert client.post("/rec/pause", json={"fileId": "x"}).status_code == 401
        authed = _post(client, "/rec/pause", {"fileId": "x"})
        assert authed.status_code == 404 and authed.json()["code"] == "REC_NOT_LIVE"


# ============================================================================
# ---- the whole thing: real audio, real model, real sockets ------------------
# ============================================================================


@requires_say_and_model
def test_a_whole_recording_over_the_real_wire(tmp_path: Path, fox_pcm: np.ndarray) -> None:
    """Real speech in over the binary frame protocol, real whisper decoding,
    real wire events out, a real encrypted spool, and a real final ``RecMeta``
    from ``/rec/stop``."""
    app, manager = _app()
    with TestClient(app) as client:
        start = _post(client, "/rec/start", _start_body("f-e2e", tmp_path, model_path=MODEL_PATH))
        assert start.status_code == 200, start.text
        spool_path = Path(start.json()["spoolPath"])
        spool_key = base64.b64decode(start.json()["spoolKey"])

        with _acking_host(client, "f-e2e") as saves:
            with client.websocket_connect(_ws_url("/rec/session", "f-e2e")) as ws:
                received: list = []
                collector = threading.Thread(target=_run_collector, args=(ws, received), daemon=True)
                collector.start()
                _push_audio(ws, 0, np.concatenate([
                    np.zeros(SAMPLE_RATE // 2, np.float32), fox_pcm,
                    np.zeros(SAMPLE_RATE, np.float32),
                ]))
                _wait_until(lambda: any(
                    e.get("type") == "final"
                    and "quick brown fox" in e.get("segment", {}).get("text", "").lower()
                    for e in received
                ), timeout=120)
                assert any(e.get("type") == "lang-locked" and e.get("lang") == "en" for e in received)
                assert any(e.get("type") == "level" for e in received)
                # Nothing reached the renderer under a name it was never taught:
                # an engine event with no mapping is forwarded under its own
                # `rec-*` name, which would show up here. (No `partial` is
                # asserted: pushed at machine speed the phrase closes before its
                # partial decode returns, and `Engine` then suppresses it on
                # purpose -- `out.start <= last_final_start`.)
                known = {
                    "level", "partial", "final", "segment-drop", "relabel", "save-status",
                    "source-health", "error", "live-translation", "state", "stopped",
                    "lang-locked", "sys-tap-request",
                }
                assert {e.get("type") for e in received} <= known
            collector.join(timeout=5)
            stop = _post(client, "/rec/stop", {"fileId": "f-e2e"})

            full = [s for s in saves if s["kind"] == "full"]
            assert full, "no full save reached /rec/host"
            assert full[-1]["fromSample"] == 0 and full[-1]["toSample"] > SAMPLE_RATE

        assert stop.status_code == 200, stop.text
        meta = stop.json()["meta"]
        combined = " ".join(s["text"] for s in meta["segments"]).lower()
        assert "quick brown fox" in combined
        assert all(s["source"] == "mic" and s["speaker"] == "You" for s in meta["segments"])
        assert manager.current is None
        assert not spool_path.exists()
        assert len(spool_key) == 32
