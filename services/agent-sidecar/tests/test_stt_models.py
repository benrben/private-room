"""Tests for `arcelle_sidecar.stt.models` — the model download/verify/delete
port of the model-management section of `src-tauri/src/commands/stt_cmds.rs`
(lines 1-260) plus the `MODEL_FILE`/`MODEL_URL`/`MODEL_SIZE_MB` constants
from `src-tauri/src/stt.rs` (lines 22-28).

This is DOWNLOAD code, so nothing here ever touches the real 574 MB
HuggingFace URL. Every download test spins up a REAL
`http.server.ThreadingHTTPServer` on `127.0.0.1` (a background daemon
thread) serving small fixture bytes, and points `download_model` at it via
the `url=` override parameter — real streaming-HTTP-to-disk code, exercised
end to end, just against a fixture instead of the network.
"""

from __future__ import annotations

import asyncio
import http.server
import re
import threading
import time
from pathlib import Path

import pytest

from arcelle_sidecar.stt import models

GGML_MAGIC = (0x67676D6C).to_bytes(4, "little")


# --------------------------------------------------------- fixture HTTP server


def _handler_factory(
    payload: bytes,
    *,
    status: int,
    chunk_size: int,
    delay: float,
    declare_length: bool,
    declared_length_override: int | None,
):
    class _Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            pass  # keep test output quiet

        def do_GET(self) -> None:  # noqa: N802 - stdlib-mandated name
            try:
                self.send_response(status)
                if declare_length:
                    length = (
                        declared_length_override
                        if declared_length_override is not None
                        else len(payload)
                    )
                    self.send_header("Content-Length", str(length))
                else:
                    self.send_header("Connection", "close")
                self.send_header("Content-Type", "application/octet-stream")
                self.end_headers()
                for i in range(0, len(payload), chunk_size):
                    self.wfile.write(payload[i : i + chunk_size])
                    self.wfile.flush()
                    if delay:
                        time.sleep(delay)
            except (BrokenPipeError, ConnectionResetError):
                return  # client (e.g. a cancelled download) hung up early

    return _Handler


class _FixtureServer:
    """A real local HTTP server serving fixed bytes — the hermetic stand-in
    for HuggingFace's `resolve/main/...`, never touched over the network.
    """

    def __init__(
        self,
        payload: bytes,
        *,
        status: int = 200,
        chunk_size: int = 1 << 16,
        delay: float = 0.0,
        declare_length: bool = True,
        declared_length_override: int | None = None,
    ) -> None:
        handler_cls = _handler_factory(
            payload,
            status=status,
            chunk_size=chunk_size,
            delay=delay,
            declare_length=declare_length,
            declared_length_override=declared_length_override,
        )
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        port = self.httpd.server_address[1]
        return f"http://127.0.0.1:{port}/model.bin"

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)


@pytest.fixture
def make_server():
    servers: list[_FixtureServer] = []

    def _make(payload: bytes, **kwargs) -> str:
        server = _FixtureServer(payload, **kwargs)
        servers.append(server)
        return server.url

    yield _make
    for s in servers:
        s.stop()


@pytest.fixture(autouse=True)
def _reset_download_state():
    """The download-in-progress/cancel flags are a module-level singleton
    (mirroring Rust's two `AtomicBool`s) — reset around every test so one
    test's state can never leak into the next.
    """
    models._downloading = False
    models._cancel_requested = False
    yield
    models._downloading = False
    models._cancel_requested = False


# ------------------------------------------------------------- pure helpers


def test_constants_match_rust_source() -> None:
    assert models.MODEL_FILE == "ggml-large-v3-turbo-q5_0.bin"
    assert models.MODEL_URL == (
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"
    )
    assert models.MODEL_SIZE_MB == 574
    assert models.MIN_MODEL_BYTES == 100 * 1024 * 1024
    assert models.MAX_MODEL_BYTES == 4 * 1024 * 1024 * 1024
    assert models.NOT_A_MODEL == (
        "What arrived is not the dictation model — the download was refused rather than used."
    )


def test_looks_like_ggml_model_magic_bytes() -> None:
    assert GGML_MAGIC == b"lmgg"
    assert models.looks_like_ggml_model(GGML_MAGIC + b"\x00\x00\x00")
    assert models.looks_like_ggml_model(b"lmgg" + b"anything after")
    assert not models.looks_like_ggml_model(b"\x00\x00\x00\x00")
    assert not models.looks_like_ggml_model(b"XXXX")
    assert not models.looks_like_ggml_model(b"lmg")  # under 4 bytes


def test_model_path_joins_models_dir(tmp_path: Path) -> None:
    assert models.model_path(str(tmp_path)) == str(tmp_path / models.MODEL_FILE)


def test_effective_model_path_prefers_downloaded_over_bundled(tmp_path: Path) -> None:
    bundled = tmp_path / "bundled.bin"
    bundled.write_bytes(b"bundled")
    models_dir = tmp_path / "models"

    # Neither downloaded nor bundled -> None.
    assert models.effective_model_path(str(models_dir), None) is None

    # Nothing downloaded yet -> bundled copy.
    assert models.effective_model_path(str(models_dir), str(bundled)) == str(bundled)

    # A downloaded copy wins once it exists.
    models_dir.mkdir()
    downloaded = models_dir / models.MODEL_FILE
    downloaded.write_bytes(b"downloaded")
    assert models.effective_model_path(str(models_dir), str(bundled)) == str(downloaded)

    # Neither exists -> None.
    assert models.effective_model_path(str(tmp_path / "nothing"), None) is None


def test_stt_status_reports_not_installed_and_size(tmp_path: Path) -> None:
    status = models.stt_status(str(tmp_path / "models"), None)
    assert status == {"installed": False, "downloading": False, "size_mb": 574}


def test_stt_status_installed_via_bundled(tmp_path: Path) -> None:
    bundled = tmp_path / "bundled.bin"
    bundled.write_bytes(b"x")
    status = models.stt_status(str(tmp_path / "models"), str(bundled))
    assert status == {"installed": True, "downloading": False, "size_mb": 574}


def test_cancel_download_returns_false_when_nothing_in_flight() -> None:
    assert models.is_downloading() is False
    assert models.cancel_download() is False


def test_cancel_download_when_in_progress_returns_true_and_sets_flag() -> None:
    models._downloading = True
    assert models.cancel_download() is True
    assert models._cancel_requested is True


# ----------------------------------------------------------------- downloads


async def test_download_model_success_renames_and_reports_progress(
    tmp_path: Path, make_server, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Real MIN_MODEL_BYTES is 100 MB; monkeypatched down so the fixture can
    # be a few KB and the test stays fast, as instructed.
    monkeypatch.setattr(models, "MIN_MODEL_BYTES", 1000)
    payload = GGML_MAGIC + (b"\xab" * 9996)  # 10000 bytes, correct magic
    url = make_server(payload, chunk_size=100)
    models_dir = tmp_path / "models"

    events: list[tuple[int, int, int]] = []
    await models.download_model(
        str(models_dir),
        None,
        on_progress=lambda got, total, pct: events.append((got, total, pct)),
        url=url,
    )

    dest = Path(models.model_path(str(models_dir)))
    assert dest.exists()
    assert dest.read_bytes() == payload
    assert not Path(str(dest) + ".part").exists()
    assert not models.is_downloading()

    assert events, "expected at least one progress callback"
    percents = [e[2] for e in events]
    assert percents == sorted(percents), "percentages must never decrease"
    assert len(percents) == len(set(percents)), "callback must fire only on a percent CHANGE"
    assert percents[-1] == 100
    assert events[-1][0] == len(payload)  # got == total bytes at the end
    assert events[-1][1] == len(payload)  # total == declared Content-Length


async def test_download_model_wrong_magic_rejected_no_part_left(
    tmp_path: Path, make_server, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(models, "MIN_MODEL_BYTES", 1000)
    payload = b"NOPE" + (b"\x00" * 4996)  # 5000 bytes, wrong magic
    url = make_server(payload, chunk_size=200)
    models_dir = tmp_path / "models"

    with pytest.raises(models.ModelDownloadError, match=re.escape(models.NOT_A_MODEL)):
        await models.download_model(str(models_dir), None, url=url)

    dest = Path(models.model_path(str(models_dir)))
    assert not dest.exists()
    assert not Path(str(dest) + ".part").exists()
    assert not models.is_downloading()


async def test_download_model_refuses_declared_oversize_before_any_byte(
    tmp_path: Path, make_server
) -> None:
    # A tiny actual body behind a Content-Length header that LIES about being
    # over MAX_MODEL_BYTES — refused from the headers alone, before the body
    # (which never actually reaches MAX_MODEL_BYTES) is read at all.
    payload = GGML_MAGIC + b"\x00" * 1000
    url = make_server(
        payload, chunk_size=100, declared_length_override=models.MAX_MODEL_BYTES + 1
    )
    models_dir = tmp_path / "models"

    with pytest.raises(models.ModelDownloadError, match=re.escape(models.NOT_A_MODEL)):
        await models.download_model(str(models_dir), None, url=url)

    dest = Path(models.model_path(str(models_dir)))
    assert not dest.exists()
    assert not Path(str(dest) + ".part").exists()


async def test_download_model_refuses_actual_oversize_without_declared_length(
    tmp_path: Path, make_server, monkeypatch: pytest.MonkeyPatch
) -> None:
    # No Content-Length header at all (so the pre-body check can't catch it)
    # and MAX_MODEL_BYTES monkeypatched down so the fixture can actually
    # exceed it without sending gigabytes — exercises the running-total
    # bound ("a server that declares nothing (or lies) is still bounded").
    monkeypatch.setattr(models, "MAX_MODEL_BYTES", 500)
    payload = GGML_MAGIC + b"\x00" * 2000
    url = make_server(payload, chunk_size=100, declare_length=False)
    models_dir = tmp_path / "models"

    with pytest.raises(models.ModelDownloadError, match=re.escape(models.NOT_A_MODEL)):
        await models.download_model(str(models_dir), None, url=url)

    dest = Path(models.model_path(str(models_dir)))
    assert not dest.exists()
    assert not Path(str(dest) + ".part").exists()


async def test_download_model_bad_status_wraps_message(
    tmp_path: Path, make_server, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A non-2xx response is reported as a "download failed: …" error,
    mirroring Rust's `.map_err(|e| format!("download failed: {e}"))` on
    `.error_for_status()`.
    """
    monkeypatch.setattr(models, "MIN_MODEL_BYTES", 1000)
    url = make_server(b"not found", status=404)
    models_dir = tmp_path / "models"

    with pytest.raises(models.ModelDownloadError, match="download failed"):
        await models.download_model(str(models_dir), None, url=url)

    dest = Path(models.model_path(str(models_dir)))
    assert not dest.exists()
    assert not Path(str(dest) + ".part").exists()
    assert not models.is_downloading()


async def test_download_model_cancel_mid_download_stops_and_cleans_up(
    tmp_path: Path, make_server, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(models, "MIN_MODEL_BYTES", 1000)
    payload = GGML_MAGIC + b"\x00" * 4996  # 5000 bytes
    url = make_server(payload, chunk_size=50, delay=0.05)  # ~100 chunks, slow
    models_dir = tmp_path / "models"

    task = asyncio.create_task(models.download_model(str(models_dir), None, url=url))
    await asyncio.sleep(0.15)  # let a handful of chunks arrive
    assert models.is_downloading()
    assert models.cancel_download() is True

    with pytest.raises(models.ModelDownloadError, match="Download stopped."):
        await task

    dest = Path(models.model_path(str(models_dir)))
    assert not dest.exists()
    assert not Path(str(dest) + ".part").exists()
    assert not models.is_downloading()


async def test_download_model_noop_when_already_installed(tmp_path: Path) -> None:
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    dest = models_dir / models.MODEL_FILE
    dest.write_bytes(b"already here")
    part = Path(str(dest) + ".part")
    part.write_bytes(b"stale partial from a previous quit")

    # Nothing is listening on this port; if the no-op path ever touched the
    # network this would raise a connection error instead of returning.
    await models.download_model(str(models_dir), None, url="http://127.0.0.1:1/never-touched")

    assert dest.read_bytes() == b"already here"
    assert not part.exists(), "a stale .part must be swept up even on the no-op path"
    assert not models.is_downloading()


async def test_download_model_noop_when_bundled_exists(tmp_path: Path) -> None:
    """Same no-op, via the bundled-path branch rather than a downloaded copy
    — `stt_effective_model` prefers a download, but `download_model` itself
    must not fetch one when a bundled copy already satisfies "installed".
    """
    bundled = tmp_path / "bundled.bin"
    bundled.write_bytes(b"bundled model")
    models_dir = tmp_path / "models"

    await models.download_model(
        str(models_dir), str(bundled), url="http://127.0.0.1:1/never-touched"
    )

    assert not Path(models.model_path(str(models_dir))).exists()
    assert not models.is_downloading()


async def test_download_model_concurrent_call_raises_already_downloading(
    tmp_path: Path, make_server, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(models, "MIN_MODEL_BYTES", 1000)
    payload = GGML_MAGIC + b"\x00" * 4996
    url = make_server(payload, chunk_size=50, delay=0.05)
    models_dir = tmp_path / "models"

    first = asyncio.create_task(models.download_model(str(models_dir), None, url=url))
    await asyncio.sleep(0)  # let `first` claim `_downloading` before we race it
    assert models.is_downloading()

    with pytest.raises(models.ModelDownloadError, match="already downloading"):
        await models.download_model(str(models_dir), None, url=url)

    # The in-flight download itself is untouched by the refused second call
    # and runs to a normal, successful completion.
    await first
    assert not models.is_downloading()
    dest = Path(models.model_path(str(models_dir)))
    assert dest.exists()


# ------------------------------------------------------------------ delete_model


def test_delete_model_removes_file_and_stray_part(tmp_path: Path) -> None:
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    dest = models_dir / models.MODEL_FILE
    dest.write_bytes(b"weights")
    part = Path(str(dest) + ".part")
    part.write_bytes(b"stale")

    models.delete_model(str(models_dir))

    assert not dest.exists()
    assert not part.exists()


def test_delete_model_safe_when_nothing_exists(tmp_path: Path) -> None:
    models_dir = tmp_path / "models"  # doesn't even exist
    models.delete_model(str(models_dir))  # must not raise
    assert not Path(models.model_path(str(models_dir))).exists()
