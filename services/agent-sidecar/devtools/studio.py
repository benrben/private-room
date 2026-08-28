"""DEV-ONLY graph registry for ``langgraph dev``. NEVER shipped.

Lives OUTSIDE the ``arcelle_sidecar`` package on purpose: the PyInstaller build
sweeps the package with ``collect_submodules('arcelle_sidecar')``, so anything
placed inside it would land in the signed bundle. Nothing here is imported by
``launch.py`` or ``arcelle_sidecar.__main__``, so it cannot reach a release.

Why this module exists
----------------------
Studio cannot hand a graph a live :class:`~arcelle_sidecar.graph.Deps` — a
ChatModel, an emit sink and an McpClient are not JSON-serialisable, and Studio
only sends JSON state. So every graph here is pre-bound to a Deps via
``.with_config()``. That still yields a real ``CompiledStateGraph`` (a Pregel
``with_config`` returns a Pregel, not a RunnableBinding), which is what
``langgraph dev`` requires.

The model
---------
Owner decision 2026-07-25: Studio runs on **Claude Sonnet** through the CLI
engine the app already supports (``external_llm.ExternalChatModel``), not on a
stub and not on Ollama. So what you see in Studio is the real loop driving a
real model — the same seam ``chat.answer`` uses when a room is set to a cloud
CLI. Override with ``ARCELLE_STUDIO_MODEL`` (e.g. ``codex-cli::gpt-5.6-sol``,
or a plain Ollama tag like ``qwen3.5:4b`` to stay on-device).

Two things this does NOT do, deliberately:

* **No MCP bridge.** ``mcp=None``, so no tool reaches a real room — Studio is
  for looking at topology and routing, not for mutating your files. A graph
  that tries to call a room tool gets "no room bridge is available", which is
  the same string the app produces when the bridge is down.
* **No weakening of the tracing strip.** Importing ``arcelle_sidecar`` still
  strips every LANGSMITH_*/LANGCHAIN_* variable at import time (``__init__.py``),
  exactly as in the app. ``langgraph dev`` serves on loopback and needs no key.

Note that a cloud CLI engine sends prompt text to Anthropic, as it does in the
app whenever a room is configured for one. Point ``ARCELLE_STUDIO_MODEL`` at an
Ollama tag if you want a fully on-device Studio session.
"""

from __future__ import annotations

import os
from typing import Any

from arcelle_sidecar.chat import OllamaChatModel
from arcelle_sidecar.external_llm import ExternalChatModel, is_external_model
from arcelle_sidecar import graph as _graph_mod
from arcelle_sidecar.graph import CancelToken, Deps
from arcelle_sidecar import graphs as _graphs
from arcelle_sidecar import wf_nodes as _wf

#: The engine every Studio run uses. `claude-cli::sonnet` is the CLI engine id
#: the app itself accepts (`engine::model::effort`), so this is not a Studio-only
#: code path — it is the same `ChatModel` seam the product ships.
STUDIO_MODEL = os.environ.get("ARCELLE_STUDIO_MODEL", "claude-cli::sonnet")
STUDIO_OLLAMA_URL = os.environ.get("ARCELLE_OLLAMA_URL", "http://127.0.0.1:11434")


async def _noop_emit(_event: dict[str, Any]) -> None:
    """Studio renders state, not our NDJSON event stream. Drop the events."""
    return None


def _chat() -> Any:
    if is_external_model(STUDIO_MODEL):
        # No mcp_url/mcp_token: Studio gets no room bridge (see module doc), so
        # Claude runs with its tools disabled rather than pointed at your files.
        return ExternalChatModel(model=STUDIO_MODEL, temperature=0.7)
    return OllamaChatModel(
        model=STUDIO_MODEL, base_url=STUDIO_OLLAMA_URL, temperature=0.7
    )


def _deps() -> Deps:
    return Deps(chat=_chat(), emit=_noop_emit, cancel=CancelToken(), mcp=None)


def _bind(graph: Any) -> Any:
    """Attach Deps for a Studio run.

    Belt AND braces, because the two mechanisms fail on different versions:

    * ``with_config`` is honoured by langgraph-api 0.9.x, and keeps the deps
      scoped to the graph object rather than to the process.
    * langgraph-api **0.4.x re-resolves the graph from its spec and discards
      that binding**, so a Studio run died in ``prepare`` with "graph invoked
      without Deps in config.configurable". The module-level hook below is what
      no version can plumb away.

    Setting the hook is idempotent and is what actually makes 0.4.x work.
    """
    _graph_mod.STUDIO_DEPS = _deps()
    _wf.STUDIO_DEPS = _WF_DEPS
    return graph.with_config({"configurable": {"deps": _deps()}})


#: The workflow chain graphs take a NodeDeps — a smaller contract than Deps
#: (one `gen()` method). Defined before `_bind` runs so the hook is set once.
_WF_DEPS = _wf.NodeDeps(
    model=STUDIO_MODEL,
    base_url=STUDIO_OLLAMA_URL,
    keep_alive="30m",
    privacy=None,
    provider=None,
    cancel=CancelToken(),
    parallel=4,
)


# --- the agent roster (one entry per registered agent) ----------------------- #

AGENT = _bind(_graphs.MAIN_GRAPH)
CHAT_ANSWER = _bind(_graphs.GRAPH_CHAT_ANSWER)
FILES_READ = _bind(_graphs.GRAPH_FILES_READ)
CHAT_WEB = _bind(_graphs.GRAPH_CHAT_WEB)
CHAT_BROWSE = _bind(_graphs.GRAPH_CHAT_BROWSE)
APP_UI = _bind(_graphs.GRAPH_APP_UI)
JOBS_RUN = _bind(_graphs.GRAPH_JOBS_RUN)
JOBS_WORKFLOWS = _bind(_graphs.GRAPH_JOBS_WORKFLOWS)
SCRIPTS_RUN = _bind(_graphs.GRAPH_SCRIPTS_RUN)
SKILLS_USE = _bind(_graphs.GRAPH_SKILLS_USE)
SKILLS_AUTHOR = _bind(_graphs.GRAPH_SKILLS_AUTHOR)
CONNECTORS_USE = _bind(_graphs.GRAPH_CONNECTORS_USE)
CONNECTORS_ADMIN = _bind(_graphs.GRAPH_CONNECTORS_ADMIN)
MEDIA_TRANSCRIBE = _bind(_graphs.GRAPH_MEDIA_TRANSCRIBE)
MEDIA_VIDEO = _bind(_graphs.GRAPH_MEDIA_VIDEO)
CREATOR_STUDIO = _bind(_graphs.GRAPH_CREATOR_STUDIO)
CREATOR_DRAW = _bind(_graphs.GRAPH_CREATOR_DRAW)

# --- the shapes, for looking at a template without picking an agent ---------- #

TEMPLATE_REACT = _bind(_graphs.TEMPLATE_REACT)
TEMPLATE_SUPERVISOR = _bind(_graphs.TEMPLATE_SUPERVISOR)
TEMPLATE_REACT_VERIFY = _bind(_graphs.TEMPLATE_REACT_VERIFY)
TEMPLATE_ROUTE_ACT = _bind(_graphs.TEMPLATE_ROUTE_ACT)
TEMPLATE_PROBE_GATE_ACT = _bind(_graphs.TEMPLATE_PROBE_GATE_ACT)
TEMPLATE_PERCEIVE_ACT = _bind(_graphs.TEMPLATE_PERCEIVE_ACT)
TEMPLATE_CHAIN_STAGE = _bind(_graphs.TEMPLATE_CHAIN_STAGE)
TEMPLATE_RECALL_ACT_CHECK = _bind(_graphs.TEMPLATE_RECALL_ACT_CHECK)

# --- the workflow chain graphs ---------------------------------------------- #
#
# These take a `NodeDeps`, not a `Deps` — a different, smaller contract (one
# `gen()` method). Bound the same way so Studio can drive them too.


WORKFLOW_REFINE = _wf.REFINE_GRAPH.with_config({"configurable": {"deps": _WF_DEPS}})
WORKFLOW_PLAN_AND_MAP = _wf.MAP_GRAPH.with_config({"configurable": {"deps": _WF_DEPS}})
