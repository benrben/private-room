"""Whisper model download/verify/delete — the Settings-page lifecycle for the
on-device dictation model.

Port of `src-tauri/src/commands/stt_cmds.rs` (lines 1-260: `stt_model_path`,
`bundled_stt_model`, `stt_effective_model`, `looks_like_ggml_model`,
`MIN_MODEL_BYTES`/`MAX_MODEL_BYTES`, `NOT_A_MODEL`, `STT_DOWNLOADING`/
`STT_DOWNLOAD_CANCEL`, `stt_cancel_download`, `SttStatus`, `stt_status`,
`stt_download_model`, `stt_delete_model`, `free_deleted_model`) and the three
constants from `src-tauri/src/stt.rs` (lines 22-28: `MODEL_FILE`/`MODEL_URL`/
`MODEL_SIZE_MB`).

Tauri hands every command an `AppHandle` it resolves an app-data-dir from;
there is no such concept in this sidecar (per the migration plan, Electron
passes the models directory at spawn instead), so every function here takes
an explicit `models_dir` parameter where Rust reached for `app.path()`.

DEVIATIONS from the Rust source (all deliberate, detailed again at each call
site below):
  - Rust returns `Result<(), String>` from every fallible command; Python has
    no equivalent idiom, so the exact Rust error strings are raised as
    `ModelDownloadError` (a plain `RuntimeError` subclass) instead of returned.
  - `stt_cmds.rs`'s two `AtomicBool`s (`STT_DOWNLOADING`/`STT_DOWNLOAD_CANCEL`)
    guarded against tauri's multi-threaded command dispatch — several
    `#[tauri::command]` handlers can genuinely run on different pool threads
    at once. This sidecar is single-process asyncio: only one coroutine ever
    runs at a time between `await` points, exactly like Node's own
    single-threaded event loop, so plain module-level `bool`s are equivalently
    safe here with no `threading.Lock` needed — the ordering guarantee Rust
    bought with atomics, Python gets for free from never yielding mid-check
    (there is no `await` anywhere between "is one running?" and "mark one
    running").
  - `stt_delete_model`'s Rust twin calls `free_deleted_model`, which spawns a
    background thread retrying `stt::unload_model` up to 300 times over ~10
    minutes if a transcription in flight is still holding the mmap open at
    the moment of deletion. This port makes exactly the ONE immediate
    best-effort `engine.unload_model()` call Rust itself makes before handing
    off to that watcher, and does NOT port the retry-until-free watcher — a
    deliberate scope-narrowing (recorded here, not a silent omission): if a
    decode is mid-flight at the exact moment `delete_model` runs, the file is
    still unlinked (freeing the *name*, matching Rust's own unlink-first
    behavior) but the disk space stays held until that decode's `Model`
    object is garbage-collected on its own — nothing here retries to hurry
    that along.
"""

from __future__ import annotations

import contextlib
import os
from collections.abc import Callable
from typing import TypedDict

import httpx

from arcelle_sidecar.stt import engine

# Whisper large-v3-turbo, 5-bit quantized -- verbatim from `stt.rs` lines 22-28.
MODEL_FILE: str = "ggml-large-v3-turbo-q5_0.bin"
MODEL_URL: str = (
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"
)
MODEL_SIZE_MB: int = 574

# Size bounds for the fetched model -- verbatim from `stt_cmds.rs`. The floor
# rejects an error page/truncated body; the ceiling stops a misbehaving
# mirror filling the disk while the UI still says "Downloading...".
MIN_MODEL_BYTES: int = 100 * 1024 * 1024
MAX_MODEL_BYTES: int = 4 * 1024 * 1024 * 1024

# What a rejected download says -- deliberately about the FILE, not the
# network: the bytes arrived fine, they just were not a model.
NOT_A_MODEL: str = (
    "What arrived is not the dictation model — the download was refused rather than used."
)


class ModelDownloadError(RuntimeError):
    """Raised with one of the exact Rust error strings above (or a wrapped
    network/IO message in the same style) — see the module docstring's
    deviation note on why this replaces Rust's `Result<(), String>`.
    """


def model_path(models_dir: str) -> str:
    """Where a *downloaded* model lives: `models_dir/MODEL_FILE`. Port of
    `stt_model_path`, minus the app-data-dir lookup (see module docstring).
    """
    return os.path.join(models_dir, MODEL_FILE)


def looks_like_ggml_model(head: bytes) -> bool:
    """Is this the head of a ggml model file? Port of `looks_like_ggml_model`.

    ggml writes its magic as the u32 `0x67676d6c` in little-endian, i.e. the
    file begins with the bytes `l m g g` —
    `(0x67676d6c).to_bytes(4, "little") == b"lmgg"`, confirmed by hand rather
    than assumed. Deliberately NOT a signature check (see the Rust doc
    comment this is ported from): `MODEL_URL` points at a mutable
    `resolve/main/...` HuggingFace ref with no digest that could honestly be
    pinned here, so this only catches the failure mode that actually
    happens — a captive portal or error page arriving with a 200 and getting
    renamed into place as a model.
    """
    return head[:4] == (0x67676D6C).to_bytes(4, "little")


def effective_model_path(models_dir: str, bundled_path: str | None) -> str | None:
    """The model to actually transcribe with: a user-downloaded copy wins
    (they may have swapped one in), otherwise the bundled copy, otherwise
    `None`. Port of `stt_effective_model`.
    """
    downloaded = model_path(models_dir)
    if os.path.exists(downloaded):
        return downloaded
    if bundled_path is not None and os.path.exists(bundled_path):
        return bundled_path
    return None


# --------------------------------------------------------- download state
#
# Mirrors Rust's two `AtomicBool`s (`STT_DOWNLOADING`/`STT_DOWNLOAD_CANCEL`).
# See the module docstring's deviation note for why plain module `bool`s are
# the right (not merely convenient) equivalent in a single-threaded asyncio
# process, unlike the tauri command dispatcher these guarded against.
_downloading = False
_cancel_requested = False


def is_downloading() -> bool:
    return _downloading


def cancel_download() -> bool:
    """Stop a model download in progress. Port of `stt_cancel_download`.

    Returns whether there WAS one to stop — `False` is not a failure, it
    means nothing was downloading, and callers must not report a stop they
    did not perform.
    """
    global _cancel_requested
    if not _downloading:
        return False
    _cancel_requested = True
    return True


class SttStatus(TypedDict):
    installed: bool
    downloading: bool
    size_mb: int


def stt_status(models_dir: str, bundled_path: str | None) -> SttStatus:
    """Port of `stt_status`. Bundled OR downloaded both count as installed,
    so a release build (which ships the model) never prompts for a download.
    """
    return {
        "installed": effective_model_path(models_dir, bundled_path) is not None,
        "downloading": is_downloading(),
        "size_mb": MODEL_SIZE_MB,
    }


async def download_model(
    models_dir: str,
    bundled_path: str | None = None,
    on_progress: Callable[[int, int, int], None] | None = None,
    url: str = MODEL_URL,
) -> None:
    """Download the Whisper model (once, ~574 MB), streaming to a `.part`
    file and renaming it into place only on success — port of
    `stt_download_model`. `on_progress(got, total, percent)` fires once per
    percent CHANGE, matching Rust's "only emit when pct != last_pct"
    throttling (not once per chunk, which would be hundreds of events/sec).

    Raises `ModelDownloadError` with:
      - "The dictation model is already downloading." if a download is
        already in flight (a second concurrent call is refused, not queued).
      - "Download stopped." if `cancel_download()` was called mid-transfer.
      - `NOT_A_MODEL` if the server declares (or actually sends) more than
        `MAX_MODEL_BYTES`, or the finished file is under `MIN_MODEL_BYTES`,
        or its first 4 bytes are not the ggml magic.
      - a wrapped network/IO message otherwise ("download failed: ..." for a
        connection/status failure, "download interrupted: ..." for one
        mid-stream), in the same spirit as Rust's own `format!(...)` wraps.

    On ANY failure the `.part` file is removed before the exception
    propagates — a cancelled/refused download never leaves a half model
    behind for `effective_model_path` to find later.
    """
    global _downloading, _cancel_requested

    dest = model_path(models_dir)
    part = dest + ".part"

    if os.path.exists(dest) or (bundled_path is not None and os.path.exists(bundled_path)):
        # Nothing to download — but a `.part` left behind by a download the
        # user quit out of would otherwise sit there for good.
        with contextlib.suppress(OSError):
            os.remove(part)
        return

    if _downloading:
        # Mirrors `STT_DOWNLOADING.swap(true, ...)` returning `true`: this
        # call touches NOTHING else — no flag reset, no `.part` cleanup —
        # because the download actually in flight owns that cleanup.
        raise ModelDownloadError("The dictation model is already downloading.")
    _downloading = True
    # A Stop pressed against the PREVIOUS download must not kill this one.
    _cancel_requested = False

    try:
        os.makedirs(models_dir, exist_ok=True)
        async with httpx.AsyncClient() as client:
            try:
                async with client.stream("GET", url) as resp:
                    try:
                        resp.raise_for_status()
                    except httpx.HTTPStatusError as e:
                        raise ModelDownloadError(f"download failed: {e}") from e

                    raw_len = resp.headers.get("content-length")
                    try:
                        declared: int | None = int(raw_len) if raw_len is not None else None
                    except ValueError:
                        declared = None
                    # An implausible declared size is refused before a byte
                    # is written.
                    if declared is not None and declared > MAX_MODEL_BYTES:
                        raise ModelDownloadError(NOT_A_MODEL)
                    total = declared if declared is not None else MODEL_SIZE_MB * 1024 * 1024

                    got = 0
                    last_pct = 0
                    # The first four bytes decide whether this is a model at
                    # all; kept rather than re-read because the file is
                    # renamed straight into the place whisper.cpp mmaps from.
                    head = bytearray()
                    with open(part, "wb") as f:
                        try:
                            async for chunk in resp.aiter_bytes():
                                if _cancel_requested:
                                    # Raising (rather than returning) is what
                                    # takes the .part file away below, so a
                                    # stopped download leaves no half model
                                    # behind and `installed` keeps telling
                                    # the truth.
                                    raise ModelDownloadError("Download stopped.")
                                got += len(chunk)
                                # A server that declares nothing (or lies) is
                                # still bounded.
                                if got > MAX_MODEL_BYTES:
                                    raise ModelDownloadError(NOT_A_MODEL)
                                if len(head) < 4:
                                    head.extend(chunk[: 4 - len(head)])
                                f.write(chunk)
                                pct = got * 100 // max(total, 1)
                                if pct != last_pct:
                                    last_pct = pct
                                    if on_progress is not None:
                                        on_progress(got, total, pct)
                        except httpx.HTTPError as e:
                            raise ModelDownloadError(f"download interrupted: {e}") from e

                    # Only now is it renamed into the path `effective_model_path`
                    # prefers over the bundled copy. Nothing checked what
                    # arrived before this port, so an error page served with a
                    # 200 became "installed: true" and every transcription
                    # afterwards failed on a file the app had told the user
                    # it had. The exception path above (and the outer
                    # cleanup below) removes the `.part`.
                    if got < MIN_MODEL_BYTES or not looks_like_ggml_model(bytes(head)):
                        raise ModelDownloadError(NOT_A_MODEL)
                    os.replace(part, dest)
            except httpx.HTTPError as e:
                # Connection-establishment/status failures (DNS, refused,
                # 4xx/5xx) — anything raised from inside the streaming loop
                # above has ALREADY been converted to a `ModelDownloadError`
                # by the inner handler and is a different exception type, so
                # it passes through this `except httpx.HTTPError` untouched.
                raise ModelDownloadError(f"download failed: {e}") from e
    except BaseException:
        # Catches `ModelDownloadError`, any stray `OSError`, and (a
        # deliberate strengthening past the literal Rust source, which has
        # no concept of task cancellation) `asyncio.CancelledError` if the
        # caller cancels the awaiting task outright — in every case the
        # half-written file must not survive.
        with contextlib.suppress(OSError):
            os.remove(part)
        raise
    finally:
        # Unconditional, success or failure — matches Rust's cleanup after
        # the `result` match, which runs regardless of `Ok`/`Err`.
        _cancel_requested = False
        _downloading = False


def delete_model(models_dir: str) -> None:
    """Delete the downloaded model — and actually give the disk space back.
    Port of `stt_delete_model`. See the module docstring's deviation note:
    Rust's background retry-until-free watcher (`free_deleted_model`'s 300
    attempts over ~10 minutes) is NOT ported here; this makes the single
    immediate best-effort `engine.unload_model()` attempt only.
    """
    path = model_path(models_dir)
    engine.unload_model(path)
    if os.path.exists(path):
        os.remove(path)
    # A download interrupted by quitting leaves a `.part` behind that
    # nothing else ever sweeps up. "Free the space" must free that too.
    with contextlib.suppress(OSError):
        os.remove(path + ".part")
