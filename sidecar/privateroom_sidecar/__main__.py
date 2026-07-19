"""Entry point: bind loopback, print the port, serve.

The Rust host spawns this, reads the port off stdout, and health-checks it. Port
0 means the OS picks an ephemeral one — same as the room MCP bridge, so two
rooms (or a stale process) can never fight over a fixed port.

Bind host is :data:`privateroom_sidecar.LOOPBACK_HOST` and is not configurable.
An 0.0.0.0 bind would put the user's room contents on their LAN (SPEC §6).
"""

from __future__ import annotations

import argparse
import logging
import os
import socket
import sys
import threading
import time

import uvicorn

from . import LOOPBACK_HOST, __version__
from .server import create_app


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
            os._exit(0)
        time.sleep(2.0)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="privateroom-sidecar")
    p.add_argument(
        "--port",
        type=int,
        default=0,
        help="TCP port on 127.0.0.1; 0 (default) asks the OS for an ephemeral one",
    )
    p.add_argument(
        "--log-level",
        default="warning",
        choices=["critical", "error", "warning", "info", "debug"],
        help="uvicorn log level (default: warning — the sidecar never logs message content)",
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
