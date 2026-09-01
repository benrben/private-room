"""Universal fallback CLI bridge to Microsoft's MarkItDown tool.

Port of `src-tauri/src/extraction.rs` lines 731-815 (`MARKITDOWN_TIMEOUT`,
the `MarkItDown` enum, `markitdown_extract`, `run_markitdown`).

MarkItDown converts almost any format (ppt, doc, xls, epub, ...) to
Markdown, but it is optional and third-party -- only used if the user has
it installed (`pipx install markitdown`). GUI apps don't inherit a shell
PATH, so common install locations are probed explicitly in addition to the
bare command name.

The Rust source spawns the child with stdout piped and polls `try_wait()`
in a sleep loop rather than a single blocking `Command::output()` (which
waits forever) -- specifically so stdout is drained on a separate thread
while polling. A converter that fills the OS pipe buffer would otherwise
block on its own write while the parent was separately blocked waiting for
exit: a deadlock. This port mirrors that shape exactly: a reader thread
drains `Popen.stdout` into a buffer while the main thread polls `.poll()`
against a wall-clock deadline.

There used to be no limit at all on how long a MarkItDown conversion could
run -- a converter that hung took the whole import (and the window with
it) down to a force quit. `MARKITDOWN_TIMEOUT` is generous enough for a
large book, short enough to stay an import.
"""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Literal

from arcelle_sidecar.docs.xml_utils import normalize_whitespace

# Hard ceiling on one MarkItDown conversion. See module docstring.
MARKITDOWN_TIMEOUT: float = 180.0  # seconds

_RunStatus = Literal["not_runnable", "failed", "timed_out", "text"]


@dataclass(frozen=True)
class _RunResult:
    """What one attempt at a MarkItDown binary produced. `text` is only
    meaningful when `status == "text"` -- mirrors the Rust `MarkItDown` enum
    (`NotRunnable` | `Failed` | `TimedOut` | `Text(String)`).
    """

    status: _RunStatus
    text: str | None = None


def markitdown_extract(path: str, timeout: float = MARKITDOWN_TIMEOUT) -> str | None:
    """Try each known MarkItDown install location in turn, returning the
    first usable (non-blank, whitespace-normalized) conversion.

    A timeout STOPS the whole search immediately rather than moving on to
    the next candidate: every candidate is almost always the same real
    binary resolved differently, so retrying a hang three more times would
    just spend three more timeouts for nothing.
    """
    home = os.environ.get("HOME", "")
    candidates = [
        "markitdown",
        "/opt/homebrew/bin/markitdown",
        "/usr/local/bin/markitdown",
        f"{home}/.local/bin/markitdown",
    ]
    for bin_path in candidates:
        result = _run_markitdown(bin_path, path, timeout)
        if result.status in ("not_runnable", "failed"):
            continue
        if result.status == "timed_out":
            return None
        # status == "text"
        text = normalize_whitespace(result.text or "")
        if text.strip():
            return text
        # Successful but empty conversion: not good enough, try the next.
    return None


def _run_markitdown(bin_path: str, path: str, timeout: float) -> _RunResult:
    """Run one converter with a deadline. Stdin is closed, stderr discarded,
    stdout captured and drained on a background thread while the main
    thread polls for completion -- see the module docstring for why a
    single blocking read-to-completion-then-wait would risk a deadlock.

    `start_new_session=True` makes the child the leader of its own new
    process group (POSIX `setsid`), purely so a timeout can be enforced
    against the group rather than just the one PID: a shell-based
    converter script forks its real work as a CHILD of the process we
    spawned, and that grandchild inherits the stdout pipe fd. Killing only
    the immediate child (`Popen.kill()`, matching a literal reading of the
    Rust source's plain `child.kill()`) leaves that grandchild running and
    still holding the pipe open, so the reader thread's `read()` would not
    see EOF until the grandchild exits on its own -- for a genuinely
    hung/looping grandchild, that is forever, exactly the unbounded-hang
    failure mode `MARKITDOWN_TIMEOUT` exists to prevent (confirmed with a
    real `sh -c 'sleep 5'` fixture: plain `kill()` returned in under a
    millisecond while the pipe stayed open for the full 5 seconds).
    Killing the whole group is what makes "no orphan process survives the
    call" true rather than aspirational.
    """
    child = _start_markitdown(bin_path, path)
    if child is None:
        return _RunResult("not_runnable")

    chunks: list[bytes] = []
    reader = threading.Thread(
        target=_drain_markitdown_stdout,
        args=(child, chunks),
        daemon=True,
    )
    reader.start()

    deadline = time.monotonic() + timeout
    while True:
        status = child.poll()
        if status is not None:
            return _completed_markitdown(status, chunks, reader)
        if time.monotonic() >= deadline:
            return _timed_out_markitdown(child, reader)
        time.sleep(0.05)


def _start_markitdown(bin_path: str, path: str) -> subprocess.Popen[bytes] | None:
    try:
        return subprocess.Popen(
            [bin_path, path],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        return None


def _drain_markitdown_stdout(child: subprocess.Popen[bytes], chunks: list[bytes]) -> None:
    assert child.stdout is not None
    while True:
        chunk = child.stdout.read(65536)
        if not chunk:
            return
        chunks.append(chunk)


def _completed_markitdown(status: int, chunks: list[bytes], reader: threading.Thread) -> _RunResult:
    reader.join()
    if status != 0:
        return _RunResult("failed")
    output = b"".join(chunks)
    return _RunResult("text", output.decode("utf-8", errors="replace"))


def _timed_out_markitdown(child: subprocess.Popen[bytes], reader: threading.Thread) -> _RunResult:
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass  # already gone -- a benign race with normal exit.
    child.wait()
    # A shell can put a background grandchild into another process group. It
    # may retain stdout even after the direct child has died, so waiting for
    # EOF here would silently turn a bounded timeout back into its full hang.
    # Timeout outcomes intentionally discard output; a daemon reader may
    # finish later without holding either this call or interpreter shutdown.
    reader.join(timeout=0.1)
    return _RunResult("timed_out")
