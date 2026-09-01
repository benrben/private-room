"""Tests for ``POST /rec/retranscribe`` -- the offline rebuild route
(:mod:`arcelle_sidecar.rec.session_ws` §7).

Same discipline as ``tests/test_rec_session_ws.py``: a real FastAPI app
carrying the real ``arcelle_sidecar.server.TokenAuthMiddleware``, real route
registration through :func:`register_rec_routes`, real staged files on disk
under a real ``arcelle-stt-*`` temp directory, and the real NDJSON bytes the
route actually writes.

What IS faked, and why: :func:`arcelle_sidecar.rec.engine.retranscribe` itself
is monkeypatched in most tests. It is a pure, separately-tested function
(``tests/test_rec_engine.py``) whose real cost is minutes of whisper decode
against a 574 MB model -- running it here would test the engine, not the
wiring, and would put a model download in the way of the wiring tests. The
route's own decisions are what these pin: the path allowlist, the two failure
channels, the terminal-line vocabulary, the honesty of ``neural``, and the
promise that a caller who hangs up actually stops the rebuild.

The last of those cannot be expressed through ``TestClient`` at all -- its
``receive()`` blocks until the response is complete and it buffers the whole
body, so "the caller went away mid-stream" has no representation there. That
one test therefore drives the ASGI app directly (:func:`_drive_asgi`), which is
the only way to hand the app a real ``http.disconnect`` while its body iterator
is still running.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from arcelle_sidecar.media.decode import MediaKind
from arcelle_sidecar.rec import session_ws
from arcelle_sidecar.rec.engine import RetranscribeStopped
from arcelle_sidecar.rec.meta import RecMeta, RecSegment, RecWord
from arcelle_sidecar.rec.session_ws import RetranscribeRequest, register_rec_routes
from arcelle_sidecar.server import TokenAuthMiddleware, create_app

#: The REAL bundled TitaNet weights, for the one test that pins ``neural:
#: true``. Resolve relative to the checkout so a differently located CI clone
#: does not silently skip it. CI may explicitly provision weights through the
#: environment; an invalid configured path fails collection instead of hiding
#: the intended coverage.
_TITANET_ENV = "ARCELLE_TEST_TITANET_MODEL"
_REPO_ROOT = Path(__file__).resolve().parents[3]


def _resolve_titanet_model() -> Path:
    if override := os.environ.get(_TITANET_ENV):
        path = Path(override).expanduser().resolve()
        if not path.is_file():
            raise FileNotFoundError(f"{_TITANET_ENV} does not name a file: {path}")
        return path

    locations = (
        _REPO_ROOT / "apps/desktop/resources/models/nemo_en_titanet_small.onnx",
        _REPO_ROOT / "apps/desktop/assets/models/nemo_en_titanet_small.onnx",
    )
    return next((path for path in locations if path.is_file()), locations[0])


TITANET_PATH = str(_resolve_titanet_model())
requires_titanet = pytest.mark.skipif(
    not Path(TITANET_PATH).exists(),
    reason=f"the bundled TitaNet model is unavailable; set {_TITANET_ENV}",
)

TOKEN = "test-token-123"


# ============================================================================
# ---- app / staging helpers -------------------------------------------------
# ============================================================================


def _app(token: str | None = TOKEN) -> FastAPI:
    """The same bare app ``test_rec_session_ws._app`` builds: real middleware,
    real routes, nothing shared between tests."""
    app = FastAPI()
    if token:
        app.add_middleware(TokenAuthMiddleware, token=token)
    register_rec_routes(app)
    return app


def _post(client: TestClient, body: dict, *, token: str | None = TOKEN):
    headers = {"authorization": f"Bearer {token}"} if token else {}
    return client.post("/rec/retranscribe", json=body, headers=headers)


def _lines(response) -> list[dict]:
    """The NDJSON stream, parsed. A 400 refusal parses too -- deliberately, see
    ``_retranscribe_refused``'s docstring."""
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


@pytest.fixture
def staged(tmp_path: Path):
    """A real host-staged file: an ``arcelle-stt-*`` directory created directly
    under the OS temp root (which is what the allowlist checks -- ``tmp_path``
    is several levels deeper and would be REFUSED, which is itself one of the
    cases below).

    Also yields a stand-in whisper model file. It is never opened: every test
    here that gets past validation has ``retranscribe`` monkeypatched, and the
    route only ever checks that the path is a file.
    """
    directory = Path(tempfile.mkdtemp(prefix="arcelle-stt-"))
    media = directory / "meeting.m4a"
    media.write_bytes(b"not really audio -- decode_to_pcm is faked")
    model = tmp_path / "ggml-whisper.bin"
    model.write_bytes(b"not really a model -- retranscribe is faked")
    try:
        yield media, model
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def _body(media: Path, model: Path, **extra: Any) -> dict:
    body = {"filePath": str(media), "modelPath": str(model)}
    body.update(extra)
    return body


def _meta_with_one_line() -> RecMeta:
    """A minimal but REAL rebuilt meta, so the ``done`` line is asserted against
    the actual ``RecMeta.to_dict()`` shape rather than a hand-written dict."""
    return RecMeta(
        duration_cs=250,
        segments=[
            RecSegment(
                id="seg-1",
                source="sys",
                speaker="Speaker 1",
                t0=0,
                t1=250,
                text="hello there",
                words=[RecWord(w="hello", t0=0, t1=100), RecWord(w="there", t0=100, t1=250)],
                lang="en",
            )
        ],
        max_speakers=0,
    )


def _fake_decode(_path, _kind) -> np.ndarray:
    """5 s of silence -- the route only measures its length."""
    return np.zeros(16000 * 5, dtype=np.float32)


@pytest.fixture(autouse=True)
def _no_real_decode(monkeypatch: pytest.MonkeyPatch):
    """Nothing in this file may shell out to afconvert: the staged bytes are not
    audio, so a real decode would be a slow way to fail."""
    monkeypatch.setattr(session_ws, "decode_to_pcm", _fake_decode)


# ============================================================================
# ---- 1. refusals decided BEFORE the stream (400, never a 200 + error line) --
# ============================================================================


class TestRefusals:
    def test_a_path_outside_the_staging_root_is_refused(self, staged, tmp_path: Path) -> None:
        """The allowlist is the only thing stopping this route -- which returns
        a whole transcript -- from being a general local file reader."""
        _media, model = staged
        elsewhere = tmp_path / "private.m4a"
        elsewhere.write_bytes(b"x")
        with TestClient(_app()) as client:
            response = _post(client, _body(elsewhere, model))
        assert response.status_code == 400
        assert response.json()["code"] == "REC_BAD_REQUEST"
        assert "staged audio path was refused" in response.json()["error"]

    def test_a_traversal_out_of_the_staging_directory_is_refused(self, staged) -> None:
        """``resolve()`` runs before the check, so ``arcelle-stt-x/../../etc/passwd``
        is judged by where it LANDS, not by how it is spelled."""
        media, model = staged
        escaped = media.parent / ".." / ".." / "etc" / "passwd"
        with TestClient(_app()) as client:
            response = _post(client, _body(escaped, model))
        assert response.status_code == 400
        assert response.json()["code"] == "REC_BAD_REQUEST"

    def test_a_sibling_temp_directory_of_another_shape_is_refused(self, staged) -> None:
        """Only ``arcelle-stt-*`` -- the docs staging root (``arcelle-docs-*``)
        and every other temp directory are somebody else's decrypted bytes."""
        _media, model = staged
        other = Path(tempfile.mkdtemp(prefix="arcelle-docs-"))
        try:
            intruder = other / "meeting.m4a"
            intruder.write_bytes(b"x")
            with TestClient(_app()) as client:
                response = _post(client, _body(intruder, model))
        finally:
            shutil.rmtree(other, ignore_errors=True)
        assert response.status_code == 400
        assert response.json()["code"] == "REC_BAD_REQUEST"

    def test_a_missing_staged_file_is_refused(self, staged) -> None:
        media, model = staged
        media.unlink()
        with TestClient(_app()) as client:
            response = _post(client, _body(media, model))
        assert response.status_code == 400
        assert "missing" in response.json()["error"]

    def test_a_missing_speech_model_is_refused(self, staged) -> None:
        media, model = staged
        model.unlink()
        with TestClient(_app()) as client:
            response = _post(client, _body(media, model))
        assert response.status_code == 400
        assert "missing" in response.json()["error"]

    def test_an_unresolvable_speech_model_path_is_refused(self, staged) -> None:
        """An invalid path is a request refusal, not an uncaught filesystem error."""
        media, model = staged
        body = _body(media, model)
        body["modelPath"] = "\x00not-a-path"
        with TestClient(_app()) as client:
            response = _post(client, body)
        assert response.status_code == 400
        assert "speech model path was refused" in response.json()["error"]

    def test_a_negative_max_speakers_is_refused_not_clamped(self, staged) -> None:
        """0 discovers and a positive value pins; a negative one is a caller bug
        and gets a refusal rather than a silently corrected cap."""
        media, model = staged
        with TestClient(_app()) as client:
            response = _post(client, _body(media, model, maxSpeakers=-1))
        assert response.status_code == 400
        assert "maxSpeakers" in response.json()["error"]

    def test_an_unknown_media_kind_is_refused_not_read_as_audio(self, staged) -> None:
        """Reading an unrecognised ``kind`` as "audio" would decode a video to
        nothing at all, and blame the file."""
        media, model = staged
        with TestClient(_app()) as client:
            response = _post(client, _body(media, model, kind="movie"))
        assert response.status_code == 400
        assert "kind" in response.json()["error"]

    def test_a_refusal_body_is_also_a_valid_ndjson_error_line(self, staged, tmp_path) -> None:
        """One parser reads both failure channels -- see ``_retranscribe_refused``."""
        _media, model = staged
        with TestClient(_app()) as client:
            response = _post(client, _body(tmp_path / "nope.m4a", model))
        assert _lines(response) == [
            {
                "kind": "error",
                "code": "REC_BAD_REQUEST",
                "error": "the staged audio path was refused",
            }
        ]

    def test_the_route_needs_the_host_token(self, staged) -> None:
        media, model = staged
        with TestClient(_app()) as client:
            response = _post(client, _body(media, model), token=None)
        assert response.status_code == 401
        assert response.json()["code"] == "NO_TOKEN"


# ============================================================================
# ---- 2. the happy path -----------------------------------------------------
# ============================================================================


class TestHappyPath:
    def test_the_stream_is_progress_lines_then_one_done_line(
        self, staged, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        media, model = staged
        meta = _meta_with_one_line()

        def fake(model_path, samples, prior, known, diarize, progress, stop):
            progress(120, 500)
            progress(500, 500)
            return meta

        monkeypatch.setattr(session_ws, "retranscribe", fake)
        with TestClient(_app()) as client:
            response = _post(client, _body(media, model))

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/x-ndjson")
        lines = _lines(response)
        # The duration is announced before any phrase closes, from the decoded
        # sample count (5 s of fake audio -> 500 cs).
        assert lines[0] == {"kind": "progress", "doneCs": 0, "totalCs": 500}
        assert {"kind": "progress", "doneCs": 120, "totalCs": 500} in lines
        assert [line["kind"] for line in lines].count("done") == 1
        assert lines[-1]["kind"] == "done"
        assert lines[-1]["meta"] == meta.to_dict()
        assert lines[-1]["meta"]["segments"][0]["speaker"] == "Speaker 1"

    def test_every_request_field_reaches_retranscribe(
        self, staged, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The wire contract, pinned end to end: camelCase in, the engine's own
        argument shapes out. A field that quietly stopped being forwarded is
        exactly how diarization was dead on the live path."""
        media, model = staged
        seen: dict[str, Any] = {}

        def fake(model_path, samples, prior, known, diarize, progress, stop):
            seen.update(
                model_path=model_path,
                samples=len(samples),
                prior=prior,
                known=known,
                diarize=diarize,
            )
            return RecMeta()

        monkeypatch.setattr(session_ws, "retranscribe", fake)
        with TestClient(_app()) as client:
            response = _post(
                client,
                _body(
                    media,
                    model,
                    diarizeModelPath="/models/titanet.onnx",
                    maxSpeakers=3,
                    knownVoices=[{"name": "Dana", "vec": [0.5, 0.5], "rejects": [[0.1, 0.2]]}],
                    prior={"speakerNames": {"Speaker 1": "Dana"}, "recognized": ["Dana"]},
                ),
            )

        assert response.status_code == 200
        assert seen["model_path"] == str(Path(model).resolve())
        assert seen["samples"] == 16000 * 5
        assert seen["diarize"] == "/models/titanet.onnx"
        assert seen["prior"].max_speakers == 3
        assert seen["prior"].speaker_names == {"Speaker 1": "Dana"}
        assert seen["prior"].recognized == {"Dana"}
        assert [k.name for k in seen["known"]] == ["Dana"]
        assert np.allclose(seen["known"][0].vec, [0.5, 0.5])
        assert np.allclose(seen["known"][0].rejects[0], [0.1, 0.2])

    def test_the_prior_cuts_reach_retranscribe_so_deleted_words_stay_deleted(
        self, staged, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The one part of the prior meta a host CANNOT restore afterwards.

        ``retranscribe`` re-marks every freshly derived word inside a carried
        cut as deleted (``rec/engine.py``:
        ``test_retranscribe_marks_every_word_inside_a_carried_over_cut_as_deleted``),
        and it can only do that from the ``cuts`` it was handed. Dropping them
        on the wire and pasting the spans back onto the returned meta gives a
        waveform that skips the audio while the words the user deleted are
        still readable in the transcript, in ``files.extracted_text`` -- and so
        in search and in every AI prompt.
        """
        media, model = staged
        seen: dict[str, Any] = {}

        def fake(model_path, samples, prior, known, diarize, progress, stop):
            seen["prior"] = prior
            return RecMeta()

        monkeypatch.setattr(session_ws, "retranscribe", fake)
        with TestClient(_app()) as client:
            response = _post(
                client,
                _body(
                    media,
                    model,
                    prior={
                        "speakerNames": {},
                        "recognized": [],
                        "cuts": [{"t0": 120, "t1": 340}, {"t0": 900, "t1": 1000}],
                    },
                ),
            )

        assert response.status_code == 200
        assert [(c.t0, c.t1) for c in seen["prior"].cuts] == [(120, 340), (900, 1000)]

    def test_a_prior_without_cuts_is_an_uncut_recording_not_a_refusal(
        self, staged, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Most recordings have no studio deletions, and an older host that
        does not send the key at all must keep working."""
        media, model = staged
        seen: dict[str, Any] = {}

        def fake(model_path, samples, prior, known, diarize, progress, stop):
            seen["prior"] = prior
            return RecMeta()

        monkeypatch.setattr(session_ws, "retranscribe", fake)
        with TestClient(_app()) as client:
            response = _post(
                client,
                _body(media, model, prior={"speakerNames": {"Speaker 1": "Dana"}}),
            )

        assert response.status_code == 200
        assert seen["prior"].cuts == []
        assert seen["prior"].speaker_names == {"Speaker 1": "Dana"}

    def test_a_file_that_was_never_a_recording_has_an_empty_prior(
        self, staged, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An import carries no naming overlay at all. That is the normal case
        for this route, not an error."""
        media, model = staged
        seen: dict[str, Any] = {}

        def fake(model_path, samples, prior, known, diarize, progress, stop):
            seen["prior"] = prior
            seen["known"] = known
            seen["diarize"] = diarize
            return RecMeta()

        monkeypatch.setattr(session_ws, "retranscribe", fake)
        with TestClient(_app()) as client:
            assert _post(client, _body(media, model)).status_code == 200

        assert seen["prior"].speaker_names == {}
        assert seen["prior"].recognized == set()
        assert seen["prior"].max_speakers == 0
        assert seen["prior"].cuts == []
        assert seen["known"] == []
        # Absent, not the empty string: `retranscribe` distinguishes them.
        assert seen["diarize"] is None


# ============================================================================
# ---- 2b. which decode path the file gets -----------------------------------
# ============================================================================


class TestMediaKind:
    """A video's audio has to be lifted out of its container before the decoder
    can read it. The shared request shape carries no ``kind``, so an omitted one
    has to be worked out here -- otherwise every video import would come back
    "no readable audio track" on a file that plays perfectly."""

    @pytest.fixture
    def kinds_seen(self, monkeypatch: pytest.MonkeyPatch) -> list:
        seen: list = []

        def spy(path, kind):
            seen.append(kind)
            return _fake_decode(path, kind)

        monkeypatch.setattr(session_ws, "decode_to_pcm", spy)
        monkeypatch.setattr(session_ws, "retranscribe", lambda *a, **k: RecMeta())
        return seen

    @pytest.mark.parametrize("suffix", [".mp4", ".mkv", ".mov", ".webm", ".MP4"])
    def test_a_video_suffix_takes_the_video_path(self, staged, kinds_seen, suffix) -> None:
        media, model = staged
        video = media.with_name(f"meeting{suffix}")
        video.write_bytes(b"x")
        with TestClient(_app()) as client:
            assert _post(client, _body(video, model)).status_code == 200
        assert kinds_seen == [MediaKind.VIDEO]

    @pytest.mark.parametrize("suffix", [".m4a", ".flac", ".wav", ".mp3", ".aiff"])
    def test_an_audio_suffix_takes_the_audio_path(self, staged, kinds_seen, suffix) -> None:
        media, model = staged
        audio = media.with_name(f"meeting{suffix}")
        audio.write_bytes(b"x")
        with TestClient(_app()) as client:
            assert _post(client, _body(audio, model)).status_code == 200
        assert kinds_seen == [MediaKind.AUDIO]

    def test_an_explicit_kind_beats_the_suffix(self, staged, kinds_seen) -> None:
        """The host knows the room file's real type; a suffix only guesses."""
        media, model = staged
        mislabelled = media.with_name("meeting.m4a")
        mislabelled.write_bytes(b"x")
        with TestClient(_app()) as client:
            assert _post(client, _body(mislabelled, model, kind="video")).status_code == 200
        assert kinds_seen == [MediaKind.VIDEO]

    def test_a_file_with_no_suffix_at_all_takes_the_audio_path(
        self, staged, kinds_seen
    ) -> None:
        media, model = staged
        bare = media.with_name("recording")
        bare.write_bytes(b"x")
        with TestClient(_app()) as client:
            assert _post(client, _body(bare, model)).status_code == 200
        assert kinds_seen == [MediaKind.AUDIO]


# ============================================================================
# ---- 3. `neural` says which voiceprint generation the rebuild actually got --
# ============================================================================


class TestNeuralHonesty:
    @pytest.fixture(autouse=True)
    def _fake_rebuild(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(
            session_ws,
            "retranscribe",
            lambda *args, **kwargs: _meta_with_one_line(),
        )

    def test_no_diarize_model_reports_neural_false(self, staged) -> None:
        """The degraded path: a transcript with DSP-only voiceprints, which can
        never be enrolled or recognised later -- so it must not claim to be
        neural."""
        media, model = staged
        with TestClient(_app()) as client:
            lines = _lines(_post(client, _body(media, model)))
        assert lines[-1]["kind"] == "done"
        assert lines[-1]["neural"] is False

    def test_an_unloadable_diarize_model_reports_neural_false(self, staged) -> None:
        """A path that exists but is not a usable ONNX model degrades exactly
        like a missing one -- and is reported as such rather than refused."""
        media, model = staged
        with TestClient(_app()) as client:
            lines = _lines(
                _post(client, _body(media, model, diarizeModelPath=str(model)))
            )
        assert lines[-1]["kind"] == "done"
        assert lines[-1]["neural"] is False

    @requires_titanet
    def test_the_real_bundled_model_reports_neural_true(self, staged) -> None:
        media, model = staged
        with TestClient(_app()) as client:
            lines = _lines(_post(client, _body(media, model, diarizeModelPath=TITANET_PATH)))
        assert lines[-1]["kind"] == "done"
        assert lines[-1]["neural"] is True


# ============================================================================
# ---- 4. failures after the 200 is committed --------------------------------
# ============================================================================


class TestTerminalFailures:
    def test_a_decode_failure_is_a_terminal_error_line(
        self, staged, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        media, model = staged

        def boom(_path, _kind):
            raise RuntimeError("no readable audio track: not a media file")

        monkeypatch.setattr(session_ws, "decode_to_pcm", boom)
        monkeypatch.setattr(session_ws, "retranscribe", lambda *a, **k: RecMeta())
        with TestClient(_app()) as client:
            response = _post(client, _body(media, model))

        assert response.status_code == 200  # the stream had already started
        assert _lines(response) == [
            {
                "kind": "error",
                "code": "REC_DECODE_FAILED",
                "error": "no readable audio track: not a media file",
            }
        ]

    def test_a_decode_failure_never_reaches_the_engine(
        self, staged, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        media, model = staged
        called: list[int] = []

        def boom(_path, _kind):
            raise OSError("afconvert failed to start")

        monkeypatch.setattr(session_ws, "decode_to_pcm", boom)
        monkeypatch.setattr(
            session_ws, "retranscribe", lambda *a, **k: called.append(1) or RecMeta()
        )
        with TestClient(_app()) as client:
            _post(client, _body(media, model))
        assert called == []

    def test_a_broken_speech_model_is_an_error_not_an_empty_transcript(
        self, staged, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """``retranscribe``'s own rule, carried onto the wire: a decode failure
        must never be written back as "nobody spoke"."""
        media, model = staged

        def fake(model_path, samples, prior, known, diarize, progress, stop):
            progress(50, 500)
            raise RuntimeError("Transcribing at 0:05 failed: model load failed")

        monkeypatch.setattr(session_ws, "retranscribe", fake)
        with TestClient(_app()) as client:
            lines = _lines(_post(client, _body(media, model)))

        assert lines[-1]["kind"] == "error"
        assert lines[-1]["code"] == "REC_RETRANSCRIBE_FAILED"
        assert "Transcribing at 0:05 failed" in lines[-1]["error"]
        assert not any(line["kind"] == "done" for line in lines)

    def test_a_stopped_rebuild_ends_with_the_stopped_line_and_no_meta(
        self, staged, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The two ways ``retranscribe`` can fail are told apart by TYPE, and
        they get two different terminal lines -- a deliberate stop is not an
        error, and carries no meta because the caller must keep the transcript
        it already has."""
        media, model = staged

        def fake(model_path, samples, prior, known, diarize, progress, stop):
            progress(50, 500)
            raise RetranscribeStopped()

        monkeypatch.setattr(session_ws, "retranscribe", fake)
        with TestClient(_app()) as client:
            lines = _lines(_post(client, _body(media, model)))

        assert lines[-1] == {"kind": "stopped"}
        assert not any(line["kind"] in ("done", "error") for line in lines)


# ============================================================================
# ---- 5. hanging up stops the rebuild ---------------------------------------
# ============================================================================


async def _drive_asgi(
    app: FastAPI,
    payload: dict,
    *,
    token: str | None = TOKEN,
    disconnect_after: int | None = None,
    spec_version: str = "2.3",
) -> tuple[dict, list[dict]]:
    """POST to the app as an ASGI server would, optionally hanging up after
    ``disconnect_after`` NDJSON lines have been written.

    ``TestClient`` cannot express this: its ``receive()`` waits for the response
    to COMPLETE before it ever returns ``http.disconnect``, and it buffers the
    whole body, so a caller that goes away mid-stream has no representation
    there. Driving the app directly is the only way to hand it the disconnect
    message while its body iterator is still running -- which is exactly the
    signal starlette turns into a cancelled body iterator, and this route turns
    into a stopped worker thread.

    ``spec_version`` defaults to "2.3" because that is what the pinned uvicorn
    0.51 advertises. Starlette takes a materially different branch at 2.4 and
    above -- no ``listen_for_disconnect`` task, so the body iterator is never
    cancelled -- which is precisely why this route carries a second, independent
    hang-up signal; ``2.4`` here exercises that one alone.
    """
    body_bytes = json.dumps(payload).encode("utf-8")
    headers = [
        (b"host", b"testserver"),
        (b"content-type", b"application/json"),
        (b"content-length", str(len(body_bytes)).encode()),
    ]
    if token:
        headers.append((b"authorization", f"Bearer {token}".encode()))
    scope: dict[str, Any] = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": spec_version},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/rec/retranscribe",
        "raw_path": b"/rec/retranscribe",
        "root_path": "",
        "query_string": b"",
        "headers": headers,
        "client": ("127.0.0.1", 50000),
        "server": ("testserver", 80),
    }

    hung_up = asyncio.Event()
    request_sent = False

    async def receive() -> dict:
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": body_bytes, "more_body": False}
        await hung_up.wait()
        return {"type": "http.disconnect"}

    start: dict = {}
    lines: list[dict] = []
    pending = bytearray()

    async def send(message: dict) -> None:
        if message["type"] == "http.response.start":
            start.update(message)
        elif message["type"] == "http.response.body":
            pending.extend(message.get("body", b""))
            while b"\n" in pending:
                raw, _, rest = bytes(pending).partition(b"\n")
                pending[:] = rest
                lines.append(json.loads(raw))
                if disconnect_after is not None and len(lines) >= disconnect_after:
                    hung_up.set()

    await app(scope, receive, send)
    return start, lines


async def _wait_for(flag: threading.Event, timeout: float = 10.0) -> None:
    """Await a flag set from a WORKER THREAD without blocking the loop."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if flag.is_set():
            return
        await asyncio.sleep(0.02)
    raise AssertionError(f"the worker never saw the stop flag within {timeout}s")


class TestHangUpStopsTheRebuild:
    async def test_a_caller_that_hangs_up_stops_the_worker(
        self, staged, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """THE property: a rebuild is minutes of whisper decode, and nothing
        else in the system will ever stop it -- there is no cancel endpoint and
        the worker holds no session. If this regresses, a host that closes a
        room leaves a core pinned until the file finishes."""
        media, model = staged
        observed_stop = threading.Event()
        finished = threading.Event()

        def fake(model_path, samples, prior, known, diarize, progress, stop):
            progress(10, 500)
            try:
                deadline = time.monotonic() + 20.0
                while time.monotonic() < deadline:
                    if stop():
                        observed_stop.set()
                        raise RetranscribeStopped()
                    time.sleep(0.01)
                raise AssertionError("stop was never signalled")
            finally:
                finished.set()

        monkeypatch.setattr(session_ws, "retranscribe", fake)
        media_path, model_path = media, model
        app = _app()
        # Hang up as soon as the very first line (the duration announcement) has
        # been written, which is while the worker is still spinning.
        _start, lines = await _drive_asgi(
            app, _body(media_path, model_path), disconnect_after=1
        )
        assert lines[0]["kind"] == "progress"
        await _wait_for(observed_stop)
        await _wait_for(finished)

    async def test_the_disconnect_poll_stops_it_where_starlette_does_not_cancel(
        self, staged, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The SECOND hang-up signal, on its own. Above ASGI spec 2.4 starlette
        streams without a ``listen_for_disconnect`` task, so nothing cancels the
        body iterator and the generator's teardown never runs -- the route's own
        ``request.is_disconnected()`` poll is then the only thing between a
        vanished caller and minutes of decode. It is also the one path on which
        the ``stopped`` line has a reader."""
        media, model = staged
        observed_stop = threading.Event()

        def fake(model_path, samples, prior, known, diarize, progress, stop):
            progress(10, 500)
            deadline = time.monotonic() + 20.0
            while time.monotonic() < deadline:
                if stop():
                    observed_stop.set()
                    raise RetranscribeStopped()
                time.sleep(0.01)
            raise AssertionError("stop was never signalled")

        monkeypatch.setattr(session_ws, "retranscribe", fake)
        _start, lines = await _drive_asgi(
            _app(), _body(media, model), disconnect_after=1, spec_version="2.4"
        )
        assert observed_stop.is_set()
        assert lines[-1] == {"kind": "stopped"}

    async def test_a_caller_that_stays_gets_the_whole_stream(
        self, staged, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The same harness with nobody hanging up -- so the test above is
        pinning the disconnect, not merely the harness ending the request."""
        media, model = staged
        meta = _meta_with_one_line()
        stops_seen: list[bool] = []

        def fake(model_path, samples, prior, known, diarize, progress, stop):
            stops_seen.append(stop())
            progress(500, 500)
            return meta

        monkeypatch.setattr(session_ws, "retranscribe", fake)
        start, lines = await _drive_asgi(_app(), _body(media, model))
        assert start["status"] == 200
        assert stops_seen == [False]
        assert lines[-1]["kind"] == "done"
        assert lines[-1]["meta"] == meta.to_dict()


# ============================================================================
# ---- 6. the request model itself -------------------------------------------
# ============================================================================


def test_the_request_model_is_camel_case_on_the_wire() -> None:
    """The ``/rec/*`` lane is camelCase (only ``/stt/transcribe_file`` is
    snake_case). Parsed straight from a dict so a rename cannot pass by
    accident."""
    req = RetranscribeRequest.model_validate(
        {
            "filePath": "/tmp/arcelle-stt-x/a.m4a",
            "modelPath": "/models/whisper.bin",
            "diarizeModelPath": "/models/titanet.onnx",
            "maxSpeakers": 4,
            "knownVoices": [{"name": "Dana", "vec": [1.0], "rejects": []}],
            "prior": {
                "speakerNames": {"Speaker 1": "Dana"},
                "recognized": ["Dana"],
                "cuts": [{"t0": 10, "t1": 20}],
            },
        }
    )
    assert req.file_path == "/tmp/arcelle-stt-x/a.m4a"
    assert req.model_path == "/models/whisper.bin"
    assert req.diarize_model_path == "/models/titanet.onnx"
    assert req.max_speakers == 4
    assert req.known_voices[0].name == "Dana"
    assert req.prior is not None
    assert req.prior.speaker_names == {"Speaker 1": "Dana"}
    assert req.prior.recognized == ["Dana"]
    assert [(c.t0, c.t1) for c in req.prior.cuts] == [(10, 20)]
    assert req.kind is None


def test_the_route_is_mounted_on_the_real_sidecar_app() -> None:
    """``register_rec_routes`` is called once from ``server.create_app``; this
    pins that the new verb rides that same registration (and therefore the same
    bearer-header auth) rather than needing a second wiring point in
    ``server.py`` that somebody has to remember."""
    app = create_app(token="s3cret")
    assert "/rec/retranscribe" in {r.path for r in app.routes if hasattr(r, "path")}


def test_the_optional_request_fields_all_have_defaults() -> None:
    req = RetranscribeRequest.model_validate(
        {"filePath": f"/tmp/arcelle-stt-{uuid.uuid4()}/a.m4a", "modelPath": "/m.bin"}
    )
    assert req.diarize_model_path is None
    assert req.max_speakers == 0
    assert req.known_voices == []
    assert req.prior is None
    assert req.kind is None
