"""The dataset builder's invariants.

`devtools/dataset/build.py` is dev-only and lives outside the package, but the
two things pinned here are silent when broken and expensive when wrong: a
missing fixture reply degrades training data instead of failing, and a record
that targets a graph-fired turn teaches the student to duplicate work the graph
does for free.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from arcelle_sidecar.agents import ALL_REGISTRY_TOOLS, REGISTRY, toolbox_for

BUILD = Path(__file__).resolve().parent.parent / "devtools" / "dataset" / "build.py"


def _build():
    spec = importlib.util.spec_from_file_location("dataset_build", BUILD)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def build():
    return _build()


def test_every_tool_an_agent_can_hold_has_a_fixture_reply(build) -> None:
    """The gap that made 8 of 12 sampled trajectories end in an apology.

    An unfixtured tool used to answer "OK.", the teacher correctly reported it
    had learned nothing, and those refusals became training targets.
    """
    box: set[str] = set()
    for spec in REGISTRY:
        if not spec.main:
            box |= set(toolbox_for(spec.id, set(ALL_REGISTRY_TOOLS)))
    assert box - set(build.REPLIES) == set()


def test_fixture_replies_render_with_and_without_arguments(build) -> None:
    plausible = {
        "name": "invoice.py",
        "new_name": "q3-final.xlsx",
        "folder": "Legal",
        "page": 3,
        "content": "hello world",
        "text": "termination",
        "note": "check this",
        "sheet": "Summary",
        "updates": [1, 2],
        "image_name": "diagram.png",
        "find": "nucleus",
        "skill": "invoice",
        "path": "scripts/build.py",
        "name_or_id": "weekly-digest",
        "tool": "slack__send",
        "refs": "biology-notes.md",
        "mode": "translate",
    }
    for name in build.REPLIES:
        # A model that omits an optional argument must not crash the recorder.
        for args in (plausible, {}):
            out = build.fixture_reply(name, args)
            assert isinstance(out, str) and out.strip(), name


def test_a_real_tool_with_no_fixture_is_loud_rather_than_ok(build) -> None:
    """A catalog tool this table forgot is a bug in this file, and silence about
    it is how 38 of 51 tools came to be unfixtured unnoticed."""
    real = next(iter(build.load_catalog()))
    saved = build.REPLIES.pop(real, None)
    try:
        with pytest.raises(KeyError):
            build.fixture_reply(real, {})
    finally:
        if saved is not None:
            build.REPLIES[real] = saved


def test_an_invented_tool_gets_the_room_s_error_not_a_crash(build) -> None:
    """A name the catalog does not have is the MODEL inventing a tool, which is
    a thing rooms answer with an MCP error. qwen invents `read_file`; raising
    there discarded the whole trajectory instead of recording the recovery."""
    out = build.fixture_reply("read_file", {"name": "lease.pdf"})
    assert "no such tool" in out.lower()
    assert "read_file" in out


def test_argument_sensitive_fixtures_echo_the_argument(build) -> None:
    """`run_script(invoice.py)` reporting tidy.py's result made the teacher
    write "I asked to run invoice.py but the result came back for tidy.py"."""
    assert "invoice" in build.fixture_reply("run_script", {"name": "invoice.py"})
    assert "tidy" in build.fixture_reply("run_script", {"name": "tidy.py"})
    assert "contract.pdf" in build.fixture_reply("open_file", {"name": "contract.pdf"})


def test_the_catalog_snapshot_covers_every_box(build) -> None:
    """Guards the hand-off from the Rust snapshot test to this builder."""
    catalog = build.load_catalog()
    for spec in REGISTRY:
        if spec.main:
            continue
        for tool in toolbox_for(spec.id, set(ALL_REGISTRY_TOOLS)):
            assert tool in catalog, f"{spec.id}: {tool} missing from tool_catalog.json"
            assert catalog[tool].get("description"), tool


def test_graph_fired_turns_are_never_training_targets(build) -> None:
    """`synth_turns` marks assistant turns the GRAPH produced, not the model."""
    state = {
        "messages": [
            {"role": "system", "content": "s"},
            {"role": "user", "content": "q"},
            # index 2: fired by the graph's probe node, free at inference.
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"function": {"name": "stt_status", "arguments": "{}"}}],
            },
            {"role": "tool", "content": "ready"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"function": {"name": "retranscribe_file", "arguments": "{}"}}
                ],
            },
            {"role": "tool", "content": "started"},
        ],
        "synth_turns": [2],
        "final_text": "Started re-transcribing talk.mp4 on this computer.",
    }
    targets = [
        r["messages"][-1] for r in build.split_records(state, [], "media.transcribe", "all")
    ]
    fired = [
        t
        for t in targets
        if any(
            c["function"]["name"] == "stt_status" for c in (t.get("tool_calls") or [])
        )
    ]
    assert fired == [], "a graph-fired call became a training target"
    assert any(t.get("tool_calls") for t in targets), "model tool choices must survive"


def test_answers_mode_emits_exactly_one_record_per_question(build) -> None:
    """Several records sharing one user turn leak across a splitter that
    dedupes on the question — which is the split the brief asks for."""
    state = {
        "messages": [
            {"role": "system", "content": "s"},
            {"role": "user", "content": "q"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"function": {"name": "open_file", "arguments": "{}"}}],
            },
            {"role": "tool", "content": "opened"},
        ],
        "synth_turns": [],
        "final_text": "I opened lease.pdf for you, it is the one with the notice period.",
    }
    assert len(build.split_records(state, [], "files.read", "answers")) == 1
    assert len(build.split_records(state, [], "files.read", "all")) > 1


def test_corpus_regeneration_keeps_what_is_already_there(build, tmp_path) -> None:
    """Regeneration must never swap a question the recorder already paid for.

    The generator makes more candidates than the cap keeps, so a re-shuffle used
    to swap 1,962 of `files.read`'s 2,500 for different ones — each swap is a
    question already recorded AND a question about to be billed again. Measured:
    a $264 top-up became $615.
    """
    first = build.build_corpus(2500, existing=tmp_path)
    for agent, qs in first.items():
        (tmp_path / f"{agent}.txt").write_text("\n".join(qs), encoding="utf-8")

    second = build.build_corpus(2500, existing=tmp_path)
    assert second == first, "regenerating an untouched corpus is not a no-op"

    # A corpus that already holds questions keeps them at the front, in order,
    # even when the cap leaves room for more.
    agent = "files.read"
    (tmp_path / f"{agent}.txt").write_text("a one-off question\n", encoding="utf-8")
    third = build.build_corpus(2500, existing=tmp_path)
    assert third[agent][0] == "a one-off question"
    assert len(third[agent]) == 2500


def test_caps_keep_the_narrow_agents_from_ballooning(build) -> None:
    """The `extend` agents were widened to clear the 2,000 floor; uncapped they
    would have generated 7,330 questions for a group that needed ~3,000."""
    corpus = build.build_corpus(2500, existing=Path("/nonexistent"))
    for agent, cap in build.CAPS.items():
        assert len(corpus[agent]) <= cap, agent
    per_group = {
        g: sum(len(corpus[a]) for a in members) for g, members in build.GROUPS.items()
    }
    # Every group must clear the brief's floor with room for the length gate.
    for group, n in per_group.items():
        assert n >= 2400, f"{group} has {n} questions — under the 2,000 floor after the gate"


def test_groups_partition_the_whole_roster(build) -> None:
    """Every agent — the main one included — lands in exactly one dataset."""
    grouped = [a for members in build.GROUPS.values() for a in members]
    assert sorted(grouped) == sorted(s.id for s in REGISTRY)
    assert len(grouped) == len(set(grouped)), "an agent is in two groups"


def test_the_main_agent_records_its_specialists_not_room_tools(build) -> None:
    """It holds NO room tool: `prepare` swaps its catalog for the ask_*_agent
    specialists, so recording `toolbox_for` would write a tool list the model
    never saw."""
    from arcelle_sidecar.agents import MAIN_AGENT_ID, get_agent

    assert get_agent(MAIN_AGENT_ID).main
    box = toolbox_for(MAIN_AGENT_ID, set(ALL_REGISTRY_TOOLS))
    assert "list_room_files" in box, "the box itself is room tools…"
    # …but what the graph offers is delegation only.
    from arcelle_sidecar.agents import agent_tool_specs

    offered = {
        s["function"]["name"]
        for s in agent_tool_specs(web_enabled=True, served_names=set(box))
    }
    assert offered and all(n.startswith("ask_") for n in offered), offered
    assert not (offered & set(box))
