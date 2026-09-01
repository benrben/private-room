"""Nothing served to the model may claim a capability this run does not have.

The 2026-07-28 wave. The ``ask_agents`` ``agent`` enum was already built from
the REACHABLE domains, but its prose description — and both capability
sentences in the Main agent's system paragraph — were hardcoded six-domain
literals. In a web-disabled room the enum correctly dropped ``web`` and
``ask_web_agent`` vanished from the catalog, while the description still read
"web = the internet": the only text left in context claiming the capability
existed, and precisely the text a model reads to choose a key.

The consequence was not a validation error. ``DOMAIN_KEYS`` is unfiltered, so
``agent: "web"`` resolved to ``chat.web``; ``resolve_worker`` found it
unreachable and fell back to ``DEFAULT_AGENT_ID`` — the File agent, which
answered a live weather question out of room content. That is the exact
confident-non-answer failure ``worker_reachable``'s docstring records from the
2026-07-24 QA, arriving through the DESCRIPTION rather than through the router.

These tests pin the whole class, not the instance: for every tier × web
combination, every string the model can see is checked against the domains
actually offered. Adding a seventh domain, or a new tier that serves less,
cannot reintroduce the drift without failing here.
"""

from __future__ import annotations

import pytest

from arcelle_sidecar.agents import (
    AGENT_TOOL_DOMAINS,
    ALL_REGISTRY_TOOLS,
    BATCH_TOOL_NAME,
    CORE_TOOLS,
    DOMAIN_BLURBS,
    DOMAIN_KEY_ORDER,
    DOMAIN_KEYS,
    agent_tool_specs,
    domain_areas,
    domain_listing,
    main_prompt,
    normalize_domain_key,
    reachable_domain_keys,
)
from arcelle_sidecar.prompts import MAIN_PROMPT_NO_SPECIALISTS, MAIN_PROMPT_TEMPLATE, WEB_OFF_NOTE

# --------------------------------------------------------------------------- #
# the tiers, as the Rust bridge actually serves them (room_mcp::ToolScope)
# --------------------------------------------------------------------------- #

#: CloudAdvisor: CORE only — no job, workflow, script, studio or transcription
#: tools. This is the tier whose missing boxes caused the original QA symptom.
_CORE_ONLY = set(CORE_TOOLS)

#: LocalEngine / ExternalAgent: effectively everything in the registry.
_EVERYTHING = set(ALL_REGISTRY_TOOLS)

#: A deliberately hostile middle tier: CORE plus only the connector proxy.
_CORE_PLUS_CONNECTOR = _CORE_ONLY | {"search_mcp_tools", "run_mcp_tool"}

TIERS = {
    "core_only": _CORE_ONLY,
    "core_plus_connector": _CORE_PLUS_CONNECTOR,
    "everything": _EVERYTHING,
}

MATRIX = [
    pytest.param(served, web, id=f"{tier}-web{int(web)}")
    for tier, served in TIERS.items()
    for web in (True, False)
]


def _batch_agent_param(specs: list[dict]) -> dict | None:
    for spec in specs:
        if spec["function"]["name"] == BATCH_TOOL_NAME:
            props = spec["function"]["parameters"]["properties"]
            return props["tasks"]["items"]["properties"]["agent"]
    return None


# --------------------------------------------------------------------------- #
# the invariant
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(("served", "web"), MATRIX)
def test_batch_enum_and_its_description_name_the_same_domains(
    served: set[str], web: bool
) -> None:
    """The enum is the contract; the description must not widen or narrow it.

    This is the regression itself: enum ``[file, app, jobs, skills, connector]``
    beside a description still selling "web = the internet".
    """
    specs = agent_tool_specs(web_enabled=web, served_names=served)
    param = _batch_agent_param(specs)
    if param is None:
        pytest.skip("no batch tool at this tier (fewer than one domain reachable)")
    described = {
        piece.split("=")[0].strip()
        for piece in param["description"].split(":", 1)[1].split(";")
    }
    assert described == set(param["enum"]), (
        f"enum {param['enum']} vs description {sorted(described)}"
    )


@pytest.mark.parametrize(("served", "web"), MATRIX)
def test_batch_enum_matches_the_offered_ask_tools(served: set[str], web: bool) -> None:
    """Every enum key has a real ``ask_*_agent`` tool in the same catalog."""
    specs = agent_tool_specs(web_enabled=web, served_names=served)
    param = _batch_agent_param(specs)
    if param is None:
        pytest.skip("no batch tool at this tier")
    offered = {s["function"]["name"] for s in specs}
    for key in param["enum"]:
        assert DOMAIN_KEYS[key] in offered, f"{key} enumerated but {DOMAIN_KEYS[key]} not offered"


@pytest.mark.parametrize(("served", "web"), MATRIX)
def test_main_prompt_never_names_an_unreachable_domain(
    served: set[str], web: bool
) -> None:
    """The Main agent's own paragraph is the other place drift hid.

    A blurb for an unreachable domain appearing in the prompt is the bug: the
    model reads its system message as the truth about itself.
    """
    keys = reachable_domain_keys(web_enabled=web, served_names=served)
    prompt = main_prompt(keys)
    for key, blurb in DOMAIN_BLURBS.items():
        if key not in keys:
            assert blurb not in prompt, (
                f"{key!r} is unreachable but its blurb {blurb!r} is in the prompt"
            )


@pytest.mark.parametrize(("served", "web"), MATRIX)
def test_main_prompt_names_every_reachable_domain(served: set[str], web: bool) -> None:
    """The dual: a reachable specialist the prompt forgets is under-use, not
    fabrication — but it is still a lie about the agent's own shape."""
    keys = reachable_domain_keys(web_enabled=web, served_names=served)
    prompt = main_prompt(keys)
    for key in keys:
        assert DOMAIN_BLURBS[key] in prompt, f"{key!r} reachable but missing from the prompt"


@pytest.mark.parametrize(("served", "web"), MATRIX)
def test_every_served_string_is_consistent_with_the_catalog(
    served: set[str], web: bool
) -> None:
    """The sweeping version: concatenate EVERYTHING the model can see this turn
    — every tool description, every parameter description, and the Main agent's
    paragraph — and assert no unreachable domain's blurb appears anywhere."""
    keys = reachable_domain_keys(web_enabled=web, served_names=served)
    specs = agent_tool_specs(web_enabled=web, served_names=served)

    blob: list[str] = [main_prompt(keys)]

    def walk(node: object) -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                if k == "description" and isinstance(v, str):
                    blob.append(v)
                else:
                    walk(v)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(specs)
    haystack = "\n".join(blob)
    for key, blurb in DOMAIN_BLURBS.items():
        if key not in keys:
            assert blurb not in haystack, (
                f"{key!r} unreachable but {blurb!r} is served to the model"
            )


# --------------------------------------------------------------------------- #
# web off is the concrete case that shipped broken
# --------------------------------------------------------------------------- #


def test_web_disabled_room_never_mentions_the_internet() -> None:
    """The exact live bug, nailed down as a named test."""
    keys = reachable_domain_keys(web_enabled=False, served_names=_EVERYTHING)
    assert "web" not in keys

    specs = agent_tool_specs(web_enabled=False, served_names=_EVERYTHING)
    param = _batch_agent_param(specs)
    assert param is not None
    assert "web" not in param["enum"]
    assert "the internet" not in param["description"]
    assert "the internet" not in main_prompt(keys)
    assert not any(s["function"]["name"] == "ask_web_agent" for s in specs)


# --------------------------------------------------------------------------- #
# the generators themselves
# --------------------------------------------------------------------------- #


def test_blurbs_cover_exactly_the_domains() -> None:
    """The import-time assert, restated so a failure names itself in CI."""
    assert set(DOMAIN_BLURBS) == set(DOMAIN_KEYS) == set(DOMAIN_KEY_ORDER)
    assert len(DOMAIN_KEY_ORDER) == len(AGENT_TOOL_DOMAINS)


def test_listings_are_order_stable_and_ignore_caller_order() -> None:
    """Two callers passing the same domains in different orders must produce
    byte-identical prose — otherwise prompt caching thrashes for no reason."""
    a = domain_listing(["web", "file"])
    b = domain_listing(["file", "web"])
    assert a == b
    # DOMAIN_KEY_ORDER, so `file` leads.
    assert a.startswith("file = ")
    assert domain_areas(["web", "file"]) == domain_areas(["file", "web"])


def test_listings_degrade_cleanly_at_the_edges() -> None:
    assert domain_listing([]) == ""
    assert domain_areas([]) == ""
    assert domain_areas(["web"]) == DOMAIN_BLURBS["web"]
    # Two domains join with "and", not a dangling comma.
    assert domain_areas(["file", "web"]) == (
        f"{DOMAIN_BLURBS['file']} and {DOMAIN_BLURBS['web']}"
    )


def test_main_prompt_survives_a_file_only_room() -> None:
    """The degenerate tier: no sentence may dangle ("...tools for .")."""
    prompt = main_prompt(["file"])
    assert " for ." not in prompt
    assert " covering ." not in prompt
    assert "no other specialists" in prompt
    # The structural clauses the hub depends on are still there.
    assert "DID / FOUND / MISSING" in prompt


@pytest.mark.parametrize(
    ("web_off", "expected"),
    [
        pytest.param(False, MAIN_PROMPT_NO_SPECIALISTS, id="normal"),
        pytest.param(True, MAIN_PROMPT_NO_SPECIALISTS + WEB_OFF_NOTE, id="web-off"),
    ],
)
def test_main_prompt_without_specialists_preserves_its_exact_fallback(
    web_off: bool, expected: str
) -> None:
    assert main_prompt([], web_off=web_off) == expected


def test_main_prompt_preserves_the_template_order_and_web_off_suffix() -> None:
    expected = MAIN_PROMPT_TEMPLATE.format(
        other_areas=DOMAIN_BLURBS["web"],
        all_areas=f"{DOMAIN_BLURBS['file']} and {DOMAIN_BLURBS['web']}",
    ) + WEB_OFF_NOTE
    assert main_prompt(["web", "file"], web_off=True) == expected


# --------------------------------------------------------------------------- #
# normalize_domain_key — tolerance for small models, without lying
# --------------------------------------------------------------------------- #


def test_every_spelling_a_model_might_emit_resolves() -> None:
    """Short key, full tool name and member worker id all mean one domain.

    A 4B echoes a worker id out of a report, or the tool name instead of the
    enum key. Accepting all three costs nothing and converts a near-miss into a
    correct dispatch.
    """
    assert normalize_domain_key("web") == "web"
    assert normalize_domain_key("ask_web_agent") == "web"
    assert normalize_domain_key("chat.web") == "web"
    assert normalize_domain_key("  WEB  ") == "web"
    assert normalize_domain_key("files.read") == "file"
    assert normalize_domain_key("jobs.workflows") == "jobs"
    assert normalize_domain_key("creator.studio") == "file"


def test_unrecognised_keys_stay_none_so_the_caller_keeps_its_fallback() -> None:
    """``None`` must mean "not a domain", never "an unavailable domain".

    The batch dispatcher's tolerant fallback for a garbled key predates this
    wave and is deliberate; only a RECOGNISED-but-unavailable domain is refused.
    """
    assert normalize_domain_key("nonsense") is None
    assert normalize_domain_key("") is None


def test_every_registry_worker_id_is_an_alias() -> None:
    """A worker added to a domain must be reachable by its own id too."""
    for _name, members, _desc in AGENT_TOOL_DOMAINS:
        for member in members:
            assert normalize_domain_key(member) is not None, member


# --------------------------------------------------------------------------- #
# The call SHAPE, not just the values (owner report 2026-07-30)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(("served", "web"), MATRIX)
def test_main_prompt_takes_a_lazy_iterator_the_way_prepare_passes_one(
    served: set[str], web: bool
) -> None:
    """Every other test here hands `main_prompt` a LIST. Production hands it a
    GENERATOR, and that difference silently cost the prompt every domain but the
    first for days.

    `graph.prepare` calls:

        main_prompt(k for k, name in DOMAIN_KEYS.items() if name in offered)

    while `main_prompt` filtered with `set(keys)` INSIDE a comprehension
    condition — re-evaluated per candidate, so the first evaluation drained the
    generator and the rest saw an exhausted one. Result: the Main agent's prompt
    always claimed exactly `DOMAIN_KEY_ORDER[0]` ("file"), whatever its catalog
    held. Claude Code trusts the prompt over the catalog, so it answered "I have
    no web-browsing specialist" in rooms that had one, and delegated nothing.

    So this asserts the two spellings agree — the only thing a list-only test
    can never see.
    """
    keys = reachable_domain_keys(web_enabled=web, served_names=served)
    from_list = main_prompt(list(keys))
    from_generator = main_prompt(k for k in keys)
    assert from_generator == from_list
    for key in keys:
        assert DOMAIN_BLURBS[key] in from_generator, (
            f"{key!r} is reachable but a generator-fed prompt dropped it"
        )


@pytest.mark.parametrize(("served", "web"), MATRIX)
def test_the_prompt_and_the_catalog_describe_the_same_agent(
    served: set[str], web: bool
) -> None:
    """End-to-end agreement, built the way `prepare` builds it.

    The failure this pins is not "a wrong word in a prompt" — it is the CATALOG
    and the PROMPT disagreeing about which specialists exist. A harness engine
    resolves that disagreement in favour of the prose (live QA 2026-07-25), so
    any drift here reads to the user as "the agents don't work".
    """
    specs = agent_tool_specs(web_enabled=web, served_names=served)
    offered = {s["function"]["name"] for s in specs}
    # Verbatim the expression in `graph.prepare` — a generator, on purpose.
    prompt = main_prompt(k for k, name in DOMAIN_KEYS.items() if name in offered)
    for key, tool in DOMAIN_KEYS.items():
        blurb = DOMAIN_BLURBS[key]
        if tool in offered:
            assert blurb in prompt, (
                f"catalog offers {tool} but the prompt never mentions {blurb!r} — "
                "a harness engine will believe the prompt and refuse the work"
            )
        else:
            assert blurb not in prompt, (
                f"catalog has no {tool} but the prompt advertises {blurb!r}"
            )


def test_no_domain_blurb_contains_a_comma() -> None:
    """`domain_areas` joins blurbs with commas, so a comma INSIDE one garbles the
    sentence the Main agent reads its own capabilities from — "…studio, the
    internet, and browsing sites, this app's interface…" hides where each item
    begins. Claude Code then omitted the web item when listing what it could do
    (owner report 2026-07-30). Keep each blurb one comma-free noun phrase."""
    for key, blurb in DOMAIN_BLURBS.items():
        assert "," not in blurb, f"{key!r} blurb has an internal comma: {blurb!r}"
