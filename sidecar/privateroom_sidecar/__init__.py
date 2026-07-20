"""Private Room — local LangGraph agent sidecar.

The sidecar is the *agent brain* only. All tools, all DB access, all decryption
and all streaming to the UI stay in the Rust host (see SPEC.md §1).

PRIVACY (SPEC §6): this product's whole promise is that nothing leaves the Mac.
LangChain/LangSmith tracing would POST room content — the user's private files —
to a cloud endpoint the moment an env var happened to be set (a stray shell
profile, an inherited environment, a dependency's default). So we do not merely
*not enable* tracing: we forcibly strip every tracing variable out of
``os.environ`` at import time, before any LangChain module can read one, and we
pin the opt-outs off. This is the earliest code in the process that LangChain can
possibly see.
"""

from __future__ import annotations

import os

#: Env vars that can turn on LangSmith/LangChain tracing (i.e. outbound network
#: with room content in the payload). Deleted, not just ignored.
_TRACING_ENV_VARS: tuple[str, ...] = (
    "LANGCHAIN_TRACING",
    "LANGCHAIN_TRACING_V2",
    # Legacy v1 tracing enabler. langchain-core still honours it: if it is set
    # while V2 is off, CallbackManager.configure() raises RuntimeError, so EVERY
    # /run crashes for any user who has it in their shell profile. It also could
    # turn on tracing (outbound room content) — strip it either way.
    "LANGCHAIN_HANDLER",
    "LANGCHAIN_API_KEY",
    "LANGCHAIN_ENDPOINT",
    "LANGCHAIN_PROJECT",
    "LANGCHAIN_HUB_API_KEY",
    "LANGCHAIN_HUB_API_URL",
    "LANGCHAIN_CALLBACKS_BACKGROUND",
    "LANGSMITH_TRACING",
    "LANGSMITH_TRACING_V2",
    "LANGSMITH_API_KEY",
    "LANGSMITH_ENDPOINT",
    "LANGSMITH_PROJECT",
    "LANGSMITH_RUNS_ENDPOINTS",
    "LANGSMITH_OTEL_ENABLED",
    # OpenTelemetry span-export config: the actual off-box channel if tracing is
    # ever turned on. Defense in depth (SPEC §6: no telemetry). Only the export
    # ENDPOINT/HEADERS are stripped — never a *_DISABLED flag, which would
    # re-enable what it was set to suppress.
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
)

#: Forced to these values (belt and braces: even if something re-reads a default).
_TRACING_ENV_FORCED: dict[str, str] = {
    "LANGCHAIN_TRACING_V2": "false",
    "LANGSMITH_TRACING": "false",
}


def disable_tracing() -> None:
    """Strip every LangSmith/LangChain tracing var from the environment.

    Called at import time. Exposed so tests (and any embedder) can assert it.
    """
    for key in list(os.environ):
        upper = key.upper()
        if upper in _TRACING_ENV_VARS or upper.startswith("LANGSMITH_"):
            del os.environ[key]
    os.environ.update(_TRACING_ENV_FORCED)


disable_tracing()

__version__ = "0.5.1"

#: The ONLY address the sidecar ever binds. Never 0.0.0.0 (SPEC §6).
LOOPBACK_HOST = "127.0.0.1"

__all__ = ["__version__", "LOOPBACK_HOST", "disable_tracing"]
