"""SPEC §6 — nothing leaves the Mac.

These are not style tests. A single LANGCHAIN_TRACING_V2=true in the user's shell
profile would POST the contents of their workspace to a cloud endpoint, and a
0.0.0.0 bind would serve their room to the LAN. Both are one line away at all
times, so both are pinned here.
"""

from __future__ import annotations

import os
import pathlib
import re
import socket

import arcelle_sidecar
from arcelle_sidecar import LOOPBACK_HOST, disable_tracing
from arcelle_sidecar.__main__ import _bind, _parse_args

PKG_DIR = pathlib.Path(arcelle_sidecar.__file__).parent


def test_tracing_env_vars_are_cleared_at_import() -> None:
    for key in os.environ:
        assert not key.upper().startswith("LANGSMITH_") or key.upper() in {
            "LANGSMITH_TRACING"
        }, key
    assert os.environ.get("LANGCHAIN_TRACING_V2") == "false"
    assert os.environ.get("LANGSMITH_TRACING") == "false"
    assert "LANGCHAIN_API_KEY" not in os.environ
    assert "LANGSMITH_API_KEY" not in os.environ
    assert "LANGCHAIN_ENDPOINT" not in os.environ


def test_disable_tracing_strips_a_poisoned_environment() -> None:
    poison = {
        "LANGCHAIN_TRACING_V2": "true",
        "LANGCHAIN_API_KEY": "ls__leak",
        "LANGCHAIN_ENDPOINT": "https://api.smith.langchain.com",
        "LANGCHAIN_PROJECT": "arcelle",
        "LANGSMITH_TRACING": "true",
        "LANGSMITH_API_KEY": "ls__leak",
        "LANGSMITH_ENDPOINT": "https://api.smith.langchain.com",
        "LANGSMITH_OTEL_ENABLED": "true",
    }
    original = {k: os.environ.get(k) for k in poison}
    try:
        os.environ.update(poison)
        disable_tracing()

        assert os.environ["LANGCHAIN_TRACING_V2"] == "false"
        assert os.environ["LANGSMITH_TRACING"] == "false"
        for key in (
            "LANGCHAIN_API_KEY",
            "LANGCHAIN_ENDPOINT",
            "LANGCHAIN_PROJECT",
            "LANGSMITH_API_KEY",
            "LANGSMITH_ENDPOINT",
            "LANGSMITH_OTEL_ENABLED",
        ):
            assert key not in os.environ, key
    finally:
        for k, v in original.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        disable_tracing()


def test_langchain_handler_is_stripped() -> None:
    # F2: the legacy v1 tracing enabler. Left in the environment it crashes every
    # /run (CallbackManager raises when it is set while V2 is off), and it is a
    # tracing var besides. It is NOT caught by the LANGSMITH_ prefix rule.
    original = os.environ.get("LANGCHAIN_HANDLER")
    try:
        os.environ["LANGCHAIN_HANDLER"] = "langchain"
        disable_tracing()
        assert "LANGCHAIN_HANDLER" not in os.environ
    finally:
        if original is None:
            os.environ.pop("LANGCHAIN_HANDLER", None)
        else:
            os.environ["LANGCHAIN_HANDLER"] = original
        disable_tracing()


def test_otel_exporter_endpoints_are_stripped_but_disable_flags_are_not() -> None:
    # F2 defense-in-depth: the OTLP export endpoint/headers are the off-box
    # channel; strip them. A *_DISABLED flag must survive — deleting it would
    # re-enable what it suppresses.
    poison = {
        "OTEL_EXPORTER_OTLP_ENDPOINT": "https://collector.example",
        "OTEL_EXPORTER_OTLP_HEADERS": "authorization=Bearer x",
    }
    original = {k: os.environ.get(k) for k in poison}
    prior_disabled = os.environ.get("OTEL_SDK_DISABLED")
    try:
        os.environ.update(poison)
        os.environ["OTEL_SDK_DISABLED"] = "true"
        disable_tracing()
        for key in poison:
            assert key not in os.environ, key
        assert os.environ.get("OTEL_SDK_DISABLED") == "true"  # not clobbered
    finally:
        for k, v in original.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        if prior_disabled is None:
            os.environ.pop("OTEL_SDK_DISABLED", None)
        else:
            os.environ["OTEL_SDK_DISABLED"] = prior_disabled
        disable_tracing()


def test_bind_host_is_loopback() -> None:
    assert LOOPBACK_HOST == "127.0.0.1"
    sock = _bind(0)
    try:
        host, port = sock.getsockname()
        assert host == "127.0.0.1"
        assert port > 0  # ephemeral, like the room MCP bridge
        assert sock.family == socket.AF_INET
    finally:
        sock.close()


def test_port_defaults_to_ephemeral_and_is_overridable() -> None:
    assert _parse_args([]).port == 0
    assert _parse_args(["--port", "8123"]).port == 8123


def test_the_bind_host_is_not_configurable() -> None:
    # There is no --host flag on purpose: an 0.0.0.0 bind would put the user's
    # room on their LAN.
    main_src = (PKG_DIR / "__main__.py").read_text()
    assert "--host" not in main_src
    assert "0.0.0.0" not in main_src.replace(
        "An 0.0.0.0 bind", ""
    )  # only the comment explaining why


def test_no_source_file_binds_a_public_interface() -> None:
    for path in PKG_DIR.rglob("*.py"):
        src = path.read_text()
        code = "\n".join(
            line for line in src.splitlines() if not line.strip().startswith("#")
        )
        assert '"0.0.0.0"' not in code, path
        assert "'0.0.0.0'" not in code, path
        assert '"::"' not in code, path


def test_the_only_outbound_hosts_are_ollama_and_the_loopback_bridge() -> None:
    """No telemetry, no analytics, no third-party endpoint anywhere in the source."""
    url_re = re.compile(r"https?://[^\s\"'\)]+")
    found: set[str] = set()
    for path in PKG_DIR.rglob("*.py"):
        for match in url_re.findall(path.read_text()):
            found.add(match.rstrip(".,"))
    # Every literal URL in the package must be loopback. The Ollama base URL and
    # the MCP bridge URL both arrive per-run from the Rust host.
    for url in found:
        assert url.startswith("http://127.0.0.1"), f"non-loopback URL in source: {url}"


def test_no_analytics_or_tracing_imports() -> None:
    banned = ("langsmith", "posthog", "segment", "sentry_sdk", "opentelemetry", "requests")
    for path in PKG_DIR.rglob("*.py"):
        code = "\n".join(
            line
            for line in path.read_text().splitlines()
            if line.strip().startswith(("import ", "from "))
        )
        for name in banned:
            assert f"import {name}" not in code, (path, name)
            assert f"from {name}" not in code, (path, name)


def test_access_log_is_off() -> None:
    # An access log of /run is a log of the user's questions.
    src = (PKG_DIR / "__main__.py").read_text()
    assert "access_log=False" in src


def test_no_info_logging_of_message_content() -> None:
    # The sidecar never logs message content at INFO or above (SPEC §6).
    for path in PKG_DIR.rglob("*.py"):
        src = path.read_text()
        for bad in ("log.info(", "logging.info(", "print(messages", "print(req"):
            assert bad not in src, (path, bad)
