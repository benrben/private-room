"""The skill-owner id list must mean the same thing in both processes.

`save_skill(agent=…)` scopes a procedure to ONE sub-agent. Rust owns the enum
the model picks from and the validation that rejects anything else
(`agent.rs::SKILL_AGENT_IDS`); Python owns the registry those ids name
(`agents.py::REGISTRY`). Nothing in either language forces them to agree.

If Rust lists an id Python does not have, `save_skill` happily stores a skill
scoped to a worker that will never exist: it is offered to no specialist and
surfaces to no user — invisible forever, with no error at any point. If Python
gains a worker Rust does not list, that specialist can never own a skill, and
the model is refused a value that is actually valid.

Both directions are silent, so both are pinned here.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from arcelle_sidecar.agents import REGISTRY

TOOL_SPECS_TS = (
    Path(__file__).resolve().parents[2]
    / "electron-migration" / "electron-app" / "electron" / "main" / "toolSpecs.ts"
)


def _host_skill_agent_ids() -> list[str]:
    """Parse `SKILL_AGENT_IDS` out of the Electron host source."""
    src = TOOL_SPECS_TS.read_text(encoding="utf-8")
    m = re.search(
        r"export const SKILL_AGENT_IDS:[^=]+?= \[(.*?)\];", src, re.S
    )
    assert m, "SKILL_AGENT_IDS not found in toolSpecs.ts — was it renamed?"
    return re.findall(r'"([^"]+)"', m.group(1))


@pytest.fixture(scope="module")
def host_ids() -> list[str]:
    return _host_skill_agent_ids()


def test_host_lists_exactly_the_python_worker_ids(host_ids: list[str]) -> None:
    workers = [spec.id for spec in REGISTRY if not spec.main]
    assert set(host_ids) == set(workers), (
        "SKILL_AGENT_IDS drifted from the registry: "
        f"host-only={sorted(set(host_ids) - set(workers))} "
        f"python-only={sorted(set(workers) - set(host_ids))}"
    )


def test_the_main_agent_is_not_offered_as_a_skill_owner(host_ids: list[str]) -> None:
    """`chat.answer` delegates and runs no room tools — it can own no procedure,
    and `list_skills` is not even in its catalog."""
    main_ids = [spec.id for spec in REGISTRY if spec.main]
    for main_id in main_ids:
        assert main_id not in host_ids, f"{main_id} is the hub, not a skill owner"


def test_the_ids_are_unique_and_non_empty(host_ids: list[str]) -> None:
    assert host_ids, "the enum must not be empty — that would reject every value"
    assert len(host_ids) == len(set(host_ids)), f"duplicate ids: {host_ids}"
    assert all(i.strip() == i and i for i in host_ids)


def test_the_tool_description_documents_every_id_it_offers(host_ids: list[str]) -> None:
    """The enum and its prose must not drift apart either — the description
    explains what each id MEANS, and an undocumented value is one a model
    cannot choose sensibly."""
    src = TOOL_SPECS_TS.read_text(encoding="utf-8")
    m = re.search(r'name: "save_skill".*?(?=\n\s*\{\n\s*type: "function")', src, re.S)
    assert m, "save_skill spec not found"
    spec_text = m.group(0)
    for agent_id in host_ids:
        assert agent_id in spec_text, (
            f"{agent_id} is in the enum but never explained in save_skill's description"
        )
