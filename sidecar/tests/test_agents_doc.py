"""`devtools/draw_agents_doc.py` must RUN — AGENTS.md is generated, never written.

Dev-only and outside the package, like `devtools/dataset/build.py`, and pinned
here for the same reason: the failure is silent until someone follows the
documented usage. That usage redirects stdout into the file
(``uv run python devtools/draw_agents_doc.py > AGENTS.md``), so a crash halfway
through does not just fail — it TRUNCATES the only roster doc the project has.
It crashed exactly that way when ``AgentSpec.description`` was removed and this
script, its last reader, kept asking for the attribute.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from arcelle_sidecar.agents import REGISTRY, get_agent

DOC = Path(__file__).resolve().parent.parent / "devtools" / "draw_agents_doc.py"


@pytest.fixture(scope="module")
def doc():
    spec = importlib.util.spec_from_file_location("draw_agents_doc", DOC)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_the_generator_writes_the_whole_roster(doc, capsys) -> None:
    doc.main()
    out = capsys.readouterr().out
    # Every agent reached — a crash at the first one still printed a header.
    for spec in REGISTRY:
        assert f"### `{spec.id}` — {spec.label}" in out, spec.id
    assert out.count("\n> ") == len(REGISTRY), "one blurb per agent"
    assert "## Roster" in out and "```mermaid" in out


def test_each_agent_blurb_comes_from_something_the_app_reads(doc) -> None:
    """The blurb is the first sentence of the agent's OWN prompt (what the
    model is briefed with every turn), so it cannot drift the way a doc-only
    field did."""
    for spec in REGISTRY:
        line = doc.blurb(spec)
        assert line.endswith((".", "!", "?", "…")), spec.id
        assert line.split(". ")[0] in " ".join(spec.prompt.split()), spec.id
    # Terse openers ("You are the WEB AGENT.") take the next sentence too.
    assert doc.blurb(get_agent("chat.web")).count(". ") >= 1
