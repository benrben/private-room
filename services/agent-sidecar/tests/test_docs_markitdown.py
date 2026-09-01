"""Tests for `arcelle_sidecar.docs.markitdown` (port of
`src-tauri/src/extraction.rs` lines 731-815: `MARKITDOWN_TIMEOUT`, the
`MarkItDown` enum, `markitdown_extract`, `run_markitdown`).

The Rust file has no dedicated `#[cfg(test)]` cases for this -- these tests
are new coverage, exercising real (tiny, controllable) subprocesses rather
than depending on the real MarkItDown tool being installed:

  - `_run_markitdown` is unit-tested directly against a script for each of
    its four outcomes (not_runnable / failed / timed_out / text).
  - `markitdown_extract`'s candidate-search behaviour (skip a failure, stop
    dead on a timeout, skip a successful-but-blank conversion) is tested
    end-to-end by pointing `PATH`/`HOME` at temp scripts standing in for
    the bare `"markitdown"` and `{HOME}/.local/bin/markitdown` candidates.
    `/opt/homebrew/bin/markitdown` and `/usr/local/bin/markitdown` are
    hardcoded absolute paths the port can't override; tests that need the
    full 4-candidate search to behave a specific way skip themselves if a
    real binary happens to be installed at either spot on the machine
    running them.
"""

from __future__ import annotations

import os
import stat
import time

import pytest

from arcelle_sidecar.docs import markitdown
from arcelle_sidecar.docs.markitdown import _run_markitdown, markitdown_extract

_REAL_CANDIDATE_PATHS = ("/opt/homebrew/bin/markitdown", "/usr/local/bin/markitdown")


def _skip_if_real_markitdown_installed() -> None:
    if any(os.path.exists(p) for p in _REAL_CANDIDATE_PATHS):
        pytest.skip("a real markitdown binary is installed on this machine")


def make_script(path, body: str) -> str:
    """Write an executable `/bin/sh` script at `path` and return its str path."""
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return str(path)


# --------------------------------------------------- _run_markitdown (unit)


def test_run_markitdown_missing_binary_is_not_runnable(tmp_path):
    missing = tmp_path / "does-not-exist"
    result = _run_markitdown(str(missing), str(tmp_path / "in.txt"), 5.0)
    assert result.status == "not_runnable"
    assert result.text is None


def test_run_markitdown_non_executable_file_is_not_runnable(tmp_path):
    script = tmp_path / "not_executable.sh"
    script.write_text("#!/bin/sh\necho hi\n")
    # Deliberately no +x bit.
    result = _run_markitdown(str(script), str(tmp_path / "in.txt"), 5.0)
    assert result.status == "not_runnable"
    assert result.text is None


def test_run_markitdown_nonzero_exit_is_failed(tmp_path):
    script = make_script(tmp_path / "fail.sh", "exit 7")
    result = _run_markitdown(script, str(tmp_path / "in.txt"), 5.0)
    assert result.status == "failed"
    assert result.text is None


def test_run_markitdown_hang_is_killed_and_times_out(tmp_path):
    script = make_script(tmp_path / "hang.sh", "sleep 5")
    started = time.monotonic()
    result = _run_markitdown(script, str(tmp_path / "in.txt"), 0.3)
    elapsed = time.monotonic() - started
    assert result.status == "timed_out"
    assert result.text is None
    # If the child weren't actually killed, child.wait() would block until
    # the real 5s sleep finished -- finishing quickly proves it was killed,
    # not merely abandoned.
    assert elapsed < 3.0


def test_run_markitdown_handles_an_already_exited_process_group(tmp_path, monkeypatch):
    script = make_script(tmp_path / "short_hang.sh", "sleep 0.1")

    def already_exited(*_args):
        raise ProcessLookupError

    monkeypatch.setattr(markitdown.os, "killpg", already_exited)
    result = _run_markitdown(script, str(tmp_path / "in.txt"), 0.0)
    assert result.status == "timed_out"
    assert result.text is None


def test_run_markitdown_grandchild_holding_pipe_does_not_block_return(tmp_path):
    """A converter script that forks a background grandchild (holding the
    stdout pipe fd open) before hanging itself must not delay
    `_run_markitdown`'s return past its own deadline.

    If only the immediate child were killed (a literal reading of the Rust
    source's plain `child.kill()`), the reader thread's `read()` would block
    on the pipe until the still-alive grandchild's inherited copy of the fd
    closes on its own -- which for a genuinely hung grandchild never
    happens. This is the scenario the module docstring's `killpg` deviation
    exists for; this test proves it actually holds rather than just being
    argued for in prose.
    """
    script = make_script(tmp_path / "fork_and_hang.sh", "sleep 30 &\nsleep 30\n")
    started = time.monotonic()
    result = _run_markitdown(script, str(tmp_path / "in.txt"), 0.3)
    elapsed = time.monotonic() - started
    assert result.status == "timed_out"
    assert result.text is None
    # If the grandchild's copy of the stdout pipe were still open, the
    # reader thread's read() would block for the grandchild's full 30s
    # sleep -- returning promptly proves the whole process GROUP was
    # killed, not just the one PID we spawned.
    assert elapsed < 3.0


def test_run_markitdown_success_returns_raw_text(tmp_path):
    script = make_script(
        tmp_path / "ok.sh",
        "printf 'Hello   world\\n\\n\\n\\nFoo   bar\\n'",
    )
    result = _run_markitdown(script, str(tmp_path / "in.txt"), 5.0)
    assert result.status == "text"
    # _run_markitdown itself does NOT normalize -- that's markitdown_extract's job.
    assert result.text == "Hello   world\n\n\n\nFoo   bar\n"


def test_run_markitdown_success_lossy_decodes_invalid_utf8(tmp_path):
    script = make_script(tmp_path / "bad_utf8.sh", "printf '\\377\\376'")
    result = _run_markitdown(script, str(tmp_path / "in.txt"), 5.0)
    assert result.status == "text"
    assert result.text is not None
    # Doesn't raise, and produces the standard lossy-decode replacement char.
    assert "�" in result.text


def test_run_markitdown_blank_output_is_still_status_text(tmp_path):
    """A successful-but-blank conversion is `_run_markitdown`'s business to
    report faithfully as `"text"` -- it's `markitdown_extract` that decides
    blank isn't good enough and moves on.
    """
    script = make_script(tmp_path / "blank.sh", "printf '   \\n\\t\\n'")
    result = _run_markitdown(script, str(tmp_path / "in.txt"), 5.0)
    assert result.status == "text"
    assert result.text is not None
    assert result.text.strip() == ""


# -------------------------------------------------- markitdown_extract (integration)


def test_extract_all_candidates_not_runnable_returns_none(tmp_path, monkeypatch):
    _skip_if_real_markitdown_installed()
    empty_bin = tmp_path / "empty_bin"
    empty_bin.mkdir()
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setenv("PATH", str(empty_bin))
    monkeypatch.setenv("HOME", str(fake_home))

    result = markitdown_extract(str(tmp_path / "doc.pptx"), timeout=1.0)
    assert result is None


def test_extract_skips_failing_candidate_for_a_later_one(tmp_path, monkeypatch):
    _skip_if_real_markitdown_installed()
    # Candidate 1 (bare "markitdown" via PATH) fails outright.
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    make_script(bin_dir / "markitdown", "exit 1")
    monkeypatch.setenv("PATH", str(bin_dir))

    # Candidate 4 ({HOME}/.local/bin/markitdown) succeeds.
    fake_home = tmp_path / "home"
    local_bin = fake_home / ".local" / "bin"
    local_bin.mkdir(parents=True)
    make_script(local_bin / "markitdown", "printf 'Real   content\\n'")
    monkeypatch.setenv("HOME", str(fake_home))

    result = markitdown_extract(str(tmp_path / "doc.pptx"), timeout=5.0)
    assert result == "Real content\n"


def test_extract_timeout_stops_the_whole_search(tmp_path, monkeypatch):
    _skip_if_real_markitdown_installed()
    # Candidate 1 (bare "markitdown" via PATH) hangs past the deadline. The
    # script's own `sleep`/`touch` are external binaries, so PATH is
    # PREPENDED with (not replaced by) the real PATH -- our directory still
    # wins bare "markitdown" resolution since it's checked first, but the
    # script itself can still find `sleep`/`touch` on the system PATH.
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    make_script(bin_dir / "markitdown", "sleep 5")
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")

    # Candidate 4 would succeed AND leave evidence it ran, if it were ever tried.
    sentinel = tmp_path / "candidate_4_ran"
    fake_home = tmp_path / "home"
    local_bin = fake_home / ".local" / "bin"
    local_bin.mkdir(parents=True)
    make_script(
        local_bin / "markitdown",
        f"touch {sentinel}\nprintf 'should not be reached\\n'",
    )
    monkeypatch.setenv("HOME", str(fake_home))

    started = time.monotonic()
    result = markitdown_extract(str(tmp_path / "doc.pptx"), timeout=0.3)
    elapsed = time.monotonic() - started

    assert result is None
    assert elapsed < 3.0
    assert not sentinel.exists(), "later candidate must never be tried after a timeout"


def test_extract_normalizes_whitespace_of_successful_text(tmp_path, monkeypatch):
    _skip_if_real_markitdown_installed()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    make_script(
        bin_dir / "markitdown",
        "printf '  Title    line  \\n\\n\\n\\nBody   text  \\n'",
    )
    monkeypatch.setenv("PATH", str(bin_dir))
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setenv("HOME", str(fake_home))

    result = markitdown_extract(str(tmp_path / "doc.pptx"), timeout=5.0)
    assert result == "Title line\n\nBody text\n"


def test_extract_skips_blank_success_for_a_later_candidate(tmp_path, monkeypatch):
    _skip_if_real_markitdown_installed()
    # Candidate 1 succeeds but produces only whitespace -- not good enough.
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    make_script(bin_dir / "markitdown", "printf '   \\n\\t\\n'")
    monkeypatch.setenv("PATH", str(bin_dir))

    # Candidate 4 produces real text.
    fake_home = tmp_path / "home"
    local_bin = fake_home / ".local" / "bin"
    local_bin.mkdir(parents=True)
    make_script(local_bin / "markitdown", "printf 'Actual content here\\n'")
    monkeypatch.setenv("HOME", str(fake_home))

    result = markitdown_extract(str(tmp_path / "doc.pptx"), timeout=5.0)
    assert result == "Actual content here\n"


def test_extract_returns_none_when_every_candidate_exhausted_with_nothing_usable(
    tmp_path, monkeypatch
):
    _skip_if_real_markitdown_installed()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    make_script(bin_dir / "markitdown", "printf ''")  # blank
    monkeypatch.setenv("PATH", str(bin_dir))
    fake_home = tmp_path / "home"
    fake_home.mkdir()  # no .local/bin/markitdown at all -> not_runnable
    monkeypatch.setenv("HOME", str(fake_home))

    result = markitdown_extract(str(tmp_path / "doc.pptx"), timeout=1.0)
    assert result is None
