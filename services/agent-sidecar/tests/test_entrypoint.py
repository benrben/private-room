"""The process entry point: how the sidecar is started, and how it goes away.

The Rust host spawns `arcelle_sidecar.__main__` with no flags at all, so
everything the entry point decides for itself — how loud the log is, what
happens to the cloud-CLI children when the app disappears — is only reachable
from here.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import textwrap

import pytest

import arcelle_sidecar.__main__ as entrypoint
from arcelle_sidecar.__main__ import LOG_LEVEL_ENV, _kill_descendants, _parse_args


def test_the_log_is_quiet_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(LOG_LEVEL_ENV, raising=False)
    assert _parse_args([]).log_level == "warning"


def test_the_log_level_can_be_raised_without_a_rebuild(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The only way in on an INSTALLED app: the host passes no --log-level and
    # hands us its own environment.
    monkeypatch.setenv(LOG_LEVEL_ENV, "debug")
    assert _parse_args([]).log_level == "debug"
    # Case and stray whitespace are the shape a user actually types.
    monkeypatch.setenv(LOG_LEVEL_ENV, " INFO ")
    assert _parse_args([]).log_level == "info"


def test_an_unusable_log_level_is_ignored_not_fatal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A typo in an env var must never stop the app's only AI service starting.
    monkeypatch.setenv(LOG_LEVEL_ENV, "chatty")
    assert _parse_args([]).log_level == "warning"


def test_an_explicit_flag_still_wins_over_the_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(LOG_LEVEL_ENV, "debug")
    assert _parse_args(["--log-level", "error"]).log_level == "error"


def test_descendant_cleanup_walks_the_full_tree_and_keeps_best_effort_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tree = {10: "11 12\n", 11: "13\n", 12: "", 13: ""}
    looked_up: list[int] = []
    killed: list[int] = []

    def fake_run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        parent = int(command[-1])
        looked_up.append(parent)
        if parent == 12:
            raise OSError("gone")
        return subprocess.CompletedProcess(command, 0, stdout=tree[parent])

    def fake_kill(pid: int, sig: signal.Signals) -> None:
        killed.append(pid)
        if pid == 12:
            raise ProcessLookupError("gone")

    monkeypatch.setattr(os, "getpid", lambda: 10)
    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(os, "kill", fake_kill)

    _kill_descendants()

    assert looked_up == [10, 12, 11, 13]
    assert killed == [13, 12, 11]


def test_parent_watcher_keeps_polling_while_its_parent_is_alive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class StopWatching(Exception):
        pass

    sleeps: list[float] = []

    def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        raise StopWatching

    monkeypatch.setattr(entrypoint.os, "getppid", lambda: 417)
    monkeypatch.setattr(entrypoint.time, "sleep", fake_sleep)
    monkeypatch.setattr(
        entrypoint, "_kill_descendants", lambda: pytest.fail("unexpected cleanup")
    )
    monkeypatch.setattr(
        entrypoint.os, "_exit", lambda _code: pytest.fail("unexpected exit")
    )

    with pytest.raises(StopWatching):
        entrypoint._watch_parent()

    assert sleeps == [2.0]


def test_parent_watcher_reaps_and_exits_when_parent_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class ParentExit(Exception):
        pass

    cleanup_calls = 0
    exit_codes: list[int] = []

    def fake_cleanup() -> None:
        nonlocal cleanup_calls
        cleanup_calls += 1

    def fake_exit(code: int) -> None:
        exit_codes.append(code)
        raise ParentExit

    monkeypatch.setattr(entrypoint.os, "getppid", lambda: 1)
    monkeypatch.setattr(entrypoint, "_kill_descendants", fake_cleanup)
    monkeypatch.setattr(entrypoint.os, "_exit", fake_exit)
    monkeypatch.setattr(
        entrypoint.time, "sleep", lambda _seconds: pytest.fail("must not sleep")
    )

    with pytest.raises(ParentExit):
        entrypoint._watch_parent()

    assert cleanup_calls == 1
    assert exit_codes == [0]


def test_parent_watcher_propagates_a_parent_probe_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def failed_parent_probe() -> int:
        raise OSError("fabricated parent lookup failure")

    monkeypatch.setattr(entrypoint.os, "getppid", failed_parent_probe)
    monkeypatch.setattr(
        entrypoint.time, "sleep", lambda _seconds: pytest.fail("must not sleep")
    )
    monkeypatch.setattr(
        entrypoint, "_kill_descendants", lambda: pytest.fail("unexpected cleanup")
    )
    monkeypatch.setattr(
        entrypoint.os, "_exit", lambda _code: pytest.fail("unexpected exit")
    )

    with pytest.raises(OSError, match="fabricated parent lookup failure"):
        entrypoint._watch_parent()


def test_a_dying_sidecar_takes_its_cloud_cli_children_with_it() -> None:
    """`_kill_descendants` reaps what `external_llm` spawned.

    Run in a child interpreter of its own: the function kills every descendant
    of the process that calls it, and the pytest session has descendants of its
    own that no test may touch.
    """
    script = textwrap.dedent(
        """
        import subprocess, sys
        from arcelle_sidecar.__main__ import _kill_descendants

        # Stands in for `zsh -ilc claude …`: a shell holding a long turn.
        cli = subprocess.Popen(["/bin/sh", "-c", "sleep 30"])
        _kill_descendants()
        try:
            cli.wait(timeout=5)
        except subprocess.TimeoutExpired:
            print("SURVIVED")
            sys.exit(1)
        print("REAPED")
        """
    )
    done = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=60
    )
    assert done.returncode == 0, done.stdout + done.stderr
    assert "REAPED" in done.stdout
