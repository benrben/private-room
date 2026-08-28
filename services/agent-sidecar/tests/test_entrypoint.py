"""The process entry point: how the sidecar is started, and how it goes away.

The Rust host spawns `arcelle_sidecar.__main__` with no flags at all, so
everything the entry point decides for itself — how loud the log is, what
happens to the cloud-CLI children when the app disappears — is only reachable
from here.
"""

from __future__ import annotations

import subprocess
import sys
import textwrap

import pytest

from arcelle_sidecar.__main__ import LOG_LEVEL_ENV, _parse_args


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
