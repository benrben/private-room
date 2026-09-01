"""Provider identity, timeout, and error primitives."""

from __future__ import annotations

import logging
import os
from typing import Any, AsyncIterator

import httpx

from .chat import StreamStalled

MODEL_SEPARATOR = ":" * 2

#: The engine ids this module serves — the API half of "content leaves the Mac"
#: (the CLI half is :data:`external_llm.EXTERNAL_ENGINES`, and
#: :func:`privacy.is_nonlocal_model` is the union). Ask
#: :func:`is_api_provider_model` rather than re-typing the id anywhere else.
API_PROVIDER_IDS: frozenset[str] = frozenset({"openrouter"})

# WHY THERE IS NO LONGER AN "ARCELLE TOOLS" ALLOWLIST HERE
#
# There used to be a hardcoded frozenset of 44 tool names, and a 400 from the
# provider narrowed the catalog to it — the idea being that one connected
# THIRD-PARTY schema had made the provider reject the request, so retrying with
# only Arcelle's own tools was better than dropping every tool.
#
# The premise was false and the list was stale, and together they broke whole
# agents:
#
#   * No third-party schema ever reaches this payload. Connected MCP servers are
#     served through the two proxy tools `search_mcp_tools` / `run_mcp_tool` —
#     `room_mcp.rs::served_tools` says so explicitly ("Individual third-party
#     schemas are returned on demand by the search tool instead of flooding every
#     model request"). Every entry in `tools` is authored by us.
#   * The list had not been updated in a long time. 19 of the room's 62 tools
#     were missing from it, including ALL SEVEN `browse_*` tools and the three
#     download tools — the Browser agent's entire catalog — plus update/delete
#     memory, the script tools, retranscribe, and the studio generators.
#
# So the retry could only do harm. For the Browser agent (and for the Main
# agent, whose tools are all `ask_*_agent`) NOTHING matched the list, `builtins`
# came back empty, the guard below skipped the retry, and the 400 surfaced as a
# bare provider error — the Browser agent failing on OpenRouter "always", with
# no explanation. For a file or memory agent it was worse than an error: the
# retry silently amputated the tools it did not recognise and the model carried
# on with a smaller catalog it was never told about.
#
# A tool-related 400 now raises with the provider's own reason attached (see
# `_describe_error`), which is information the user can act on — choosing a
# different model — rather than a mystery with a mutilated catalog behind it.

#: Ceiling on one provider call, in seconds. A cloud model that is genuinely
#: thinking for a long time must not be cut off and reported as a failure, so
#: this is generous — and overridable for the rare answer that needs longer.
PROVIDER_TIMEOUT_SECS: float = 600.0

#: The environment override for :data:`PROVIDER_TIMEOUT_SECS` (seconds).
PROVIDER_TIMEOUT_ENV = "ARCELLE_PROVIDER_TIMEOUT_SECS"


#: What to assume a provider's context window is when its catalog says nothing.
#:
#: "Unknown window means no budget and no change" was the rule on the FITTING
#: path, and it is the one hole every other guard here was built to close: with
#: no budget, `compact_to_budget` returns immediately and `fit_oversized_results`
#: never runs, so a single heavy tool result — a `browse_read` of an ad-laden
#: search page, a `fetch_page` of a big site — reached the provider intact and
#: came back as a bare provider error, which the UI could only repeat.
#:
#: The token bar has always assumed this same number for the same unknown (see
#: `max_context` below), so the two now agree. A default can still be wrong for
#: a model with a genuinely smaller window, but being wrong is strictly better
#: than the previous behaviour of imposing no limit whatsoever.
DEFAULT_PROVIDER_CONTEXT = 128_000

_log = logging.getLogger(__name__)


class ProviderApiError(httpx.HTTPError):
    pass


def provider_timeout_secs() -> float:
    """The give-up time for one provider call.

    Read per call so the module default can be overridden without a rebuild;
    a missing, unparseable or non-positive value keeps the default.
    """
    raw = os.environ.get(PROVIDER_TIMEOUT_ENV, "")
    try:
        override = float(raw)
    except ValueError:
        return PROVIDER_TIMEOUT_SECS
    return override if override > 0 else PROVIDER_TIMEOUT_SECS


async def _stall_as_error(
    events: AsyncIterator[dict[str, Any]], model: str
) -> AsyncIterator[dict[str, Any]]:
    """Re-raise :class:`chat.StreamStalled` as this module's error type.

    Wrapping the generator, rather than the deeply nested ``async for`` that
    drains it, keeps the conversion one line from where the stream is built.
    """
    try:
        async for event in events:
            yield event
    except StreamStalled as exc:
        raise ProviderApiError(
            f"{model} sent nothing for {provider_timeout_secs():g}s and was stopped."
        ) from exc


def is_api_provider_model(model: str) -> bool:
    return model.split(MODEL_SEPARATOR, 1)[0] in API_PROVIDER_IDS


def _model_slug(model: str, configured: str) -> str:
    parts = model.split(MODEL_SEPARATOR, 2)
    return parts[1] if len(parts) > 1 and parts[1] else configured
