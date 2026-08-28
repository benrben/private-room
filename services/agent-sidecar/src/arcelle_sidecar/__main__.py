"""Entry point: bind loopback, print the port, serve.

The Rust host spawns this, reads the port off stdout, and health-checks it. Port
0 means the OS picks an ephemeral one — same as the room MCP bridge, so two
rooms (or a stale process) can never fight over a fixed port.

Bind host is :data:`arcelle_sidecar.LOOPBACK_HOST` and is not configurable.
An 0.0.0.0 bind would put the user's room contents on their LAN (SPEC §6).
"""

from __future__ import annotations

import argparse
import atexit
import logging
import os
import signal
import socket
import subprocess
import sys
import threading
import time

import uvicorn

from . import LOOPBACK_HOST, __version__
from .server import create_app

#: The log levels uvicorn accepts, quietest first.
LOG_LEVELS = ("critical", "error", "warning", "info", "debug")

#: Raise the log level without a rebuild. The host spawns us with no
#: ``--log-level``, so while chasing a problem in an INSTALLED app this env var
#: is the only way to get more than warnings out of the stderr log
#: (``sidecar_lifecycle::stderr_log_path``); the app passes its own environment
#: through to us. An unrecognised value is ignored rather than fatal — a typo
#: here must never stop the AI service from starting.
LOG_LEVEL_ENV = "ARCELLE_SIDECAR_LOG_LEVEL"


def _kill_descendants() -> None:
    """SIGKILL everything we spawned, deepest first.

    Our children are ``zsh -ilc claude …`` / ``codex exec …``
    (:mod:`.external_llm`): real cloud turns billing the user's quota. Nothing
    on our exit paths reaps them — :func:`os._exit` below skips every
    Python-level cleanup, and a plain SIGTERM from the host unwinds uvicorn but
    not a subprocess the event loop was awaiting — so without this they outlive
    us as orphans and run an answer nobody will read to completion.

    Best effort throughout: this is teardown, and a failure here must not
    replace a clean exit with a traceback.
    """
    frontier = [os.getpid()]
    descendants: list[int] = []
    while frontier:
        try:
            listed = subprocess.run(
                ["/usr/bin/pgrep", "-P", str(frontier.pop())],
                capture_output=True,
                text=True,
                timeout=2.0,
            ).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        children = [int(pid) for pid in listed.split() if pid.isdigit()]
        descendants.extend(children)
        frontier.extend(children)
    for pid in reversed(descendants):  # leaves before the shells that own them
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def _watch_parent() -> None:
    """Exit when the parent app dies (PRIV-1 incident hardening).

    The Rust host is our only legitimate parent. If it goes away — force-quit,
    crash, reinstall — launchd re-parents us to PID 1 and we would otherwise
    live on as an orphan, possibly mid-generation, monopolizing the local
    Ollama model with nobody listening (observed: several orphans pinned the
    GPU and every model "felt stuck"). Poll cheaply and self-terminate.
    """
    while True:
        if os.getppid() == 1:
            _kill_descendants()
            os._exit(0)
        time.sleep(2.0)


def _default_log_level() -> str:
    want = os.environ.get(LOG_LEVEL_ENV, "").strip().lower()
    return want if want in LOG_LEVELS else "warning"


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="arcelle-sidecar")
    p.add_argument(
        "--port",
        type=int,
        default=0,
        help="TCP port on 127.0.0.1; 0 (default) asks the OS for an ephemeral one",
    )
    p.add_argument(
        "--log-level",
        default=_default_log_level(),
        choices=list(LOG_LEVELS),
        help=(
            f"uvicorn log level (default: warning, or ${LOG_LEVEL_ENV} when set — "
            "the sidecar never logs message content)"
        ),
    )
    p.add_argument("--version", action="version", version=__version__)
    return p.parse_args(argv)


def _bind(port: int) -> socket.socket:
    """Bind up front so we can print the real port before uvicorn starts."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((LOOPBACK_HOST, port))
    sock.listen(128)
    return sock


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(level=args.log_level.upper())

    sock = _bind(args.port)
    bound_port = sock.getsockname()[1]
    # The host parses this line to find us. Keep the format stable.
    print(f"SIDECAR_PORT={bound_port}", flush=True)

    threading.Thread(target=_watch_parent, daemon=True, name="parent-watch").start()
    # The ordinary quit path: the host SIGTERMs us, uvicorn unwinds, and this
    # runs before the interpreter goes. `_watch_parent` calls it itself because
    # `os._exit` skips atexit entirely.
    atexit.register(_kill_descendants)

    config = uvicorn.Config(
        create_app(),
        log_level=args.log_level,
        access_log=False,  # an access log of /run is a log of the user's asks
    )
    server = uvicorn.Server(config)
    server.run(sockets=[sock])
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
