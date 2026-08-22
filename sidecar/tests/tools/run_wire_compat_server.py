"""A real, UNMODIFIED ``arcelle_sidecar.server.create_app`` under uvicorn,
wired to scripted test doubles, for the ``/run`` NDJSON streaming client's
wire-compat suite.

This is the mirror image of ``sidecar/tests/test_mcp_bridge_wire_compat.py``:
that file is a PYTHON test that spawns a TS process
(``electron/main/mcpBridgeRunner.ts``) and drives it with the real
``arcelle_sidecar.mcp_client.McpClient``. Here it is a TS test
(``electron-migration/electron-app/electron/main/sidecarRun.wire.test.ts``)
that spawns THIS Python process and drives it with the real (newly ported)
``runViaSidecar``/``streamRun`` NDJSON client. Neither side is mocked; only
the MODEL is a double, via ``create_app``'s own ``chat_factory``/
``mcp_factory`` seams -- the exact mechanism ``sidecar/tests/test_server.py``
already uses. ``FakeChatModel``/``FakeMCP``/``Round``/``call`` are imported
from ``sidecar/tests/conftest.py`` UNCHANGED, not reimplemented here.

Not a pytest file: a standalone script the vitest suite spawns via
``node:child_process.spawn``, taking its bearer token (if any) from
``ARCELLE_SIDECAR_TOKEN`` -- the same variable name the real sidecar reads
(``server.TOKEN_ENV``, ``sidecar.ts``'s ``TOKEN_ENV``), so a token set here is
checked by the very same ``TokenAuthMiddleware`` a real run would hit, and
``create_app()``'s own default (``os.environ.get(TOKEN_ENV, "")``) needs no
extra plumbing from this script to pick it up.

ONE PROCESS, EVERY SCENARIO
===========================
The scenario is chosen PER REQUEST, off ``RunRequest.model`` (see
:data:`SCENARIOS`), rather than from a per-process env var. That is not a
cosmetic choice: it is what lets the whole suite -- and, more importantly, two
different clients being compared against each other -- run against ONE shared,
long-lived server instance. Comparing two NDJSON clients "on identical
scripted server responses" is only actually identical if it is the same
server process, holding the same ``RunRegistry``, answering both; a per-
process env var forces a fresh uvicorn per scenario and quietly turns the
comparison into two different servers that merely resemble each other.

Model strings are deliberately plain, local-looking names (no ``:cloud``
suffix, no ``openrouter::`` prefix), so ``privacy.is_nonlocal_model`` reads
them as loopback and the run takes the ordinary local path -- the same one a
real room's Ollama model takes.

Announces its bound port on stdout as ``WIRE_COMPAT_PORT=<port>`` --
deliberately NOT the production ``SIDECAR_PORT=`` handshake ``sidecar.ts``'s
``parsePortLine`` reads. This process never goes through ``ensureUp()`` /
``spawnAndWait()``'s lifecycle (that half of ``sidecar.rs`` was already
ported, as ``sidecar_lifecycle.rs`` -> ``sidecar.ts``, and stays out of scope
here); it is a bespoke, already-live ``/run`` server the test's
``streamRun(base, ...)`` talks to directly, and a distinct handshake string
keeps that distinction visible instead of implying this script is a stand-in
for the real spawn path.

Binds the same way the real entrypoint does (``arcelle_sidecar/__main__.py``'s
``_bind`` + ``uvicorn.Server(...).run(sockets=[sock])``): bind port 0 up front
so the real port is known before printing it, and hand uvicorn the
already-bound, already-listening socket rather than a bind-then-release race.

WHAT IS NOT HERE, AND WHY
=========================
There is no "the stream just stops, with neither ``final`` nor ``error``"
scenario in this file, because the real server CANNOT be made to produce one
from the inside, by design. ``graph.stream_events``'s driver catches
``BaseException`` -- not merely ``Exception`` -- and queues
``{"t":"error", ...}`` before re-raising, and its ``finally`` still queues the
end sentinel; that is precisely the fix for the live-QA 2026-07-30
"Yahoo/ETF" defect, where a torn-down run closed cleanly with no ``final``
and the host saved a zero-byte answer. Faking it by poisoning an event so
``server.py``'s own ``stamped()``/``compact_json`` raises would exercise a
failure mode nothing real produces.

A severed connection is a TRANSPORT condition, so the TS suite reproduces it
at the transport layer: a tiny in-test TCP relay in front of THIS server that
forwards the real bytes and then cuts the socket mid-stream. The same relay
is what injects a line stamped for a different ``run_id`` (the "badly-behaved
proxy interleaving two runs" case). See ``sidecarRun.wire.test.ts``'s own
doc. The server stays real and unmodified either way.
"""

from __future__ import annotations

import asyncio
import os
import socket
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable

import uvicorn
from fastapi.responses import JSONResponse

# sidecar/tests/tools/run_wire_compat_server.py -> `sidecar/` is two levels
# up. Both the package (`arcelle_sidecar`) and the test-doubles module
# (`tests/conftest.py`) need to be importable, and neither is installed as a
# library -- path-insert defensively rather than assume the caller's cwd (the
# TS test spawns this with `cwd` set to `sidecar/`, but a human running it
# directly from elsewhere should not need to know that).
_SIDECAR_ROOT = Path(__file__).resolve().parents[2]
for _p in (str(_SIDECAR_ROOT), str(_SIDECAR_ROOT / "tests")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from conftest import FakeChatModel, FakeMCP, Round, call  # noqa: E402

from arcelle_sidecar.chat import RoundUsage  # noqa: E402
from arcelle_sidecar.messages import Message, ToolCall  # noqa: E402
from arcelle_sidecar.server import create_app  # noqa: E402

#: What this script announces its port as. See the module doc for why this is
#: deliberately not the production `SIDECAR_PORT=` string.
PORT_HANDSHAKE_PREFIX = "WIRE_COMPAT_PORT="

#: How long the "slow" scenario's fake model waits for cancellation before
#: giving up and answering anyway. Generous: real test runs cancel within a
#: couple of seconds, so this only bounds a test that forgot to.
_SLOW_MAX_WAIT_SECS = 20.0
_SLOW_POLL_SECS = 0.05


def _answer_chat(_req: Any) -> FakeChatModel:
    """The exact round script ``test_server.py``'s own
    ``test_run_streams_ndjson_in_order`` uses, reused verbatim (not
    reimplemented) so the real event sequence this scenario proves is the one
    the Python-side suite already pins down: a delegation to a specialist, a
    tool call inside it, the specialist's report, and the Main agent's final
    answer."""
    return FakeChatModel(
        [
            Round(content="", calls=[call("ask_file_agent", instruction="find the rent")]),
            Round(content="looking", calls=[call("search_room", query="rent")]),
            Round(content="Found it; rent is 1200."),
            Round(content="The rent is 1200."),
        ]
    )


class _PartialThenRaisesChat:
    """Streams a partial answer, then blows up mid-round -- ``final`` never
    arrives.

    Matches ``test_server.py``'s own ``Exploding`` in spirit: the sidecar's
    graph turns ANY exception out of the model into a terminal
    ``{"t":"error"}`` line (``graph.stream_events``'s driver), the same
    mechanism ``test_a_failure_becomes_an_error_event_not_a_500`` exercises --
    plus a delta first, so the "keeps the partial the user watched arrive"
    half of the contract has something real to keep.
    """

    async def stream(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]],
        on_delta: Callable[[str], Awaitable[None]],
        cancel: Any = None,
    ) -> tuple[str, list[ToolCall], RoundUsage]:
        await on_delta("half an ")
        await on_delta("answer")
        raise RuntimeError("the run was torn down")


class _SlowCancellableChat:
    """One delta, then a long pause that actually WATCHES the real
    ``CancelToken`` ``/cancel`` mutates.

    ``state["cancel_seen"]`` is the one piece of server-side, OUT-OF-BAND
    evidence a wire-compat test can check to confirm ``/cancel`` really
    reached and stopped a live run, rather than merely that the client's own
    call returned without throwing. Exposed on the debug-only
    ``/__test_state`` route bolted onto the already-built ``app`` below.
    """

    def __init__(self, state: dict[str, bool]) -> None:
        self._state = state

    async def stream(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]],
        on_delta: Callable[[str], Awaitable[None]],
        cancel: Any = None,
    ) -> tuple[str, list[ToolCall], RoundUsage]:
        await on_delta("thinking it through slowly")
        try:
            waited = 0.0
            while waited < _SLOW_MAX_WAIT_SECS:
                if cancel is not None and getattr(cancel, "cancelled", False):
                    self._state["cancel_seen"] = True
                    break
                await asyncio.sleep(_SLOW_POLL_SECS)
                waited += _SLOW_POLL_SECS
        except asyncio.CancelledError:
            # A client that delivers `/cancel` and then also drops the `/run`
            # connection (exactly what the ported `streamRun` does -- its
            # `reader.cancel()` runs in a `finally` right after
            # `deliverCancel` returns) can race ahead of this loop's own
            # cooperative check above: Starlette notices the disconnect and
            # cancels this coroutine directly, via a plain
            # `asyncio.CancelledError`, which can arrive mid-`sleep` before
            # the next iteration re-reads `cancel.cancelled`. Recording the
            # same fact either way keeps `cancel_seen` an honest signal of
            # "cancellation reached this model call", regardless of which of
            # the two real paths delivered it.
            self._state["cancel_seen"] = True
            raise
        return (
            "thinking it through slowly",
            [],
            RoundUsage(input_tokens=None, max_context=8192, is_real=False),
        )


#: ``RunRequest.model`` -> which fake model that run gets. The TS suite spells
#: these same strings; keep them in step.
SCENARIOS = ("wire-answer", "wire-error", "wire-slow")


def _build_app() -> Any:
    # Shared across every "wire-slow" run this process serves. That is the
    # point: one long-lived server, so a test can cancel a run and then ask
    # this same process, out of band, whether the cancellation actually
    # reached the model call.
    slow_state: dict[str, bool] = {"cancel_seen": False}

    def chat_factory(req: Any) -> Any:
        model = getattr(req, "model", "")
        if model == "wire-error":
            return _PartialThenRaisesChat()
        if model == "wire-slow":
            return _SlowCancellableChat(slow_state)
        if model == "wire-answer":
            return _answer_chat(req)
        raise SystemExit(
            f"unknown wire-compat scenario model {model!r} (want one of {list(SCENARIOS)})"
        )

    app = create_app(chat_factory=chat_factory, mcp_factory=lambda _req: FakeMCP())

    # Debug-only introspection, bolted onto the ALREADY-BUILT app object --
    # `server.py` itself is never touched. This is how a test proves the real
    # `/cancel` endpoint reached the real `CancelToken` the fake model is
    # polling, independent of whatever the client-side call locally believes
    # happened.
    @app.get("/__test_state")
    async def _test_state() -> JSONResponse:
        return JSONResponse(slow_state)

    return app


def _bind() -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    return sock


def main() -> int:
    app = _build_app()

    sock = _bind()
    port = sock.getsockname()[1]
    # The test parses this line to find us. Keep the format stable.
    print(f"{PORT_HANDSHAKE_PREFIX}{port}", flush=True)

    config = uvicorn.Config(app, log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    server.run(sockets=[sock])
    return 0


if __name__ == "__main__":
    sys.exit(main())
