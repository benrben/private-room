"""The skill-owner id list must mean the same thing in both languages.

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

AGENT_RS = Path(__file__).resolve().parents[2] / "src-tauri" / "src" / "commands" / "agent.rs"


def _rust_skill_agent_ids() -> list[str]:
    """Parse `SKILL_AGENT_IDS` out of the Rust source."""
    src = AGENT_RS.read_text(encoding="utf-8")
    m = re.search(
        r"pub\(crate\) const SKILL_AGENT_IDS: &\[&str\] = &\[(.*?)\];", src, re.S
    )
    assert m, "SKILL_AGENT_IDS not found in agent.rs — was it renamed?"
    return re.findall(r'"([^"]+)"', m.group(1))


@pytest.fixture(scope="module")
def rust_ids() -> list[str]:
    if not AGENT_RS.exists():  # pragma: no cover - sidecar built standalone
        pytest.skip("Rust source not present in this checkout")
    return _rust_skill_agent_ids()


def test_rust_lists_exactly_the_python_worker_ids(rust_ids: list[str]) -> None:
    workers = [spec.id for spec in REGISTRY if not spec.main]
    assert set(rust_ids) == set(workers), (
        "SKILL_AGENT_IDS drifted from the registry: "
        f"rust-only={sorted(set(rust_ids) - set(workers))} "
        f"python-only={sorted(set(workers) - set(rust_ids))}"
    )


def test_the_main_agent_is_not_offered_as_a_skill_owner(rust_ids: list[str]) -> None:
    """`chat.answer` delegates and runs no room tools — it can own no procedure,
    and `list_skills` is not even in its catalog."""
    main_ids = [spec.id for spec in REGISTRY if spec.main]
    for main_id in main_ids:
        assert main_id not in rust_ids, f"{main_id} is the hub, not a skill owner"


def test_the_ids_are_unique_and_non_empty(rust_ids: list[str]) -> None:
    assert rust_ids, "the enum must not be empty — that would reject every value"
    assert len(rust_ids) == len(set(rust_ids)), f"duplicate ids: {rust_ids}"
    assert all(i.strip() == i and i for i in rust_ids)


def test_the_tool_description_documents_every_id_it_offers(rust_ids: list[str]) -> None:
    """The enum and its prose must not drift apart either — the description
    explains what each id MEANS, and an undocumented value is one a model
    cannot choose sensibly."""
    src = AGENT_RS.read_text(encoding="utf-8")
    # The whole save_skill spec: from its name to the start of the NEXT tool
    # spec. The ids are explained in the `agent` parameter's description, which
    # sits well after the tool-level one.
    m = re.search(
        r'"name": "save_skill".*?(?=\{"type": "function")', src, re.S
    )
    assert m, "save_skill spec not found"
    spec_text = m.group(0)
    for agent_id in rust_ids:
        assert agent_id in spec_text, (
            f"{agent_id} is in the enum but never explained in save_skill's description"
        )
