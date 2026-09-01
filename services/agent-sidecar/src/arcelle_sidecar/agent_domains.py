"""Domain vocabulary and Main-agent prompt assembly."""

from __future__ import annotations

from collections.abc import Iterable

from .prompts import MAIN_PROMPT_NO_SPECIALISTS, MAIN_PROMPT_TEMPLATE, WEB_OFF_NOTE

DOMAIN_BLURBS: dict[str, str] = {
    "file": "this room's own content",
    "web": "the internet and browsing sites",
    "app": "this app's interface",
    "jobs": "workflows and whole-file passes",
    "skills": "agent skills",
    "connector": "connected services",
}

#: Definition order, not alphabetical — ``file`` is the default worker's domain
#: and the most common pick, so it leads every generated list a model reads.
#: A literal (not derived from ``DOMAIN_KEYS``) because the registry below is
#: built before ``AGENT_TOOL_DOMAINS`` exists; the assert beside ``DOMAIN_KEYS``
#: pins the two together.
DOMAIN_KEY_ORDER: tuple[str, ...] = (
    "file",
    "web",
    "app",
    "jobs",
    "skills",
    "connector",
)


def domain_listing(keys: Iterable[str]) -> str:
    """``"file = this room's content…; web = the internet"`` for `keys`.

    Ordered by :data:`DOMAIN_KEY_ORDER` regardless of the caller's order, so
    the string is deterministic and always leads with the default domain.
    """
    wanted = set(keys)
    return "; ".join(
        f"{k} = {DOMAIN_BLURBS[k]}" for k in DOMAIN_KEY_ORDER if k in wanted
    )


def domain_areas(keys: Iterable[str]) -> str:
    """The same domains as plain AREAS, for user-facing prose in the prompt.

    ``"the internet, this app's interface and connected services"`` — no keys,
    no tool names: the Main agent describes areas to the user, never plumbing.
    """
    wanted = set(keys)
    parts = [DOMAIN_BLURBS[k] for k in DOMAIN_KEY_ORDER if k in wanted]
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " and " + parts[-1]


def _reachable_prompt_domains(keys: Iterable[str]) -> list[str]:
    """Materialise a possibly lazy domain iterable once, in stable order."""
    reachable = set(keys)
    return [key for key in DOMAIN_KEY_ORDER if key in reachable]


def _no_specialists_prompt(web_off: bool) -> str:
    if web_off:
        return MAIN_PROMPT_NO_SPECIALISTS + WEB_OFF_NOTE
    return MAIN_PROMPT_NO_SPECIALISTS


def _other_prompt_areas(wanted: list[str]) -> str:
    areas = domain_areas(key for key in wanted if key != "file")
    return areas or "nothing else — you have no other specialists"


def _active_specialists_prompt(wanted: list[str], web_off: bool) -> str:
    paragraph = MAIN_PROMPT_TEMPLATE.format(
        # The sentence already named ask_file_agent, so this half lists the
        # others. With file the only reachable domain it degrades to a plain
        # "there are no other specialists" rather than a dangling "for .".
        other_areas=_other_prompt_areas(wanted),
        all_areas=domain_areas(wanted) or "this room's content",
    )
    return paragraph + WEB_OFF_NOTE if web_off else paragraph


def main_prompt(keys: Iterable[str], *, web_off: bool = False) -> str:
    """The Main agent's system paragraph for exactly the REACHABLE domains.

    ``keys`` are the short domain keys whose ``ask_*_agent`` tool is actually
    in the catalog this turn. Both capability sentences are filled from them,
    so the prompt can never advertise a specialist the model has no tool for.

    THE BUG THIS SHAPE EXISTS FOR (owner report 2026-07-30). This was:

        wanted = [k for k in DOMAIN_KEY_ORDER if k in set(keys)]

    `set(keys)` sits in the comprehension's CONDITION, so it is re-evaluated
    once per item of ``DOMAIN_KEY_ORDER``. Against a list that is merely
    wasteful; against the GENERATOR ``graph.prepare`` actually passes, the first
    evaluation drains it and every later one builds `set()` from an exhausted
    iterator — so only ``DOMAIN_KEY_ORDER[0]`` (`file`) could ever survive.

    The Main agent's prompt therefore claimed ONE domain no matter how many its
    catalog held, on every single turn. A local model mostly ignored the prose
    and called the tools it could see; **Claude Code trusted the prompt** — the
    documented harness-engine order of authority — and answered "I have no
    web-browsing specialist" with zero delegations, for a room that had one.
    Every unit test passed a list, which re-iterates, so the suite never saw it.

    Materialised ONCE, and the tests below pass a generator on purpose.

    ``web_off`` appends :data:`WEB_OFF_NOTE`. The catalog alone says only that
    the web domain is absent; without a reason the model invents one, and it
    picks permanence ("this room has no browsing tool") over the truth (a switch
    is off). See the note for the live refusal that prompted it.

    NO reachable domain at all gets :data:`MAIN_PROMPT_NO_SPECIALISTS` instead.
    The normal template's first sentence orders the model to call
    ``ask_file_agent``, and that half cannot be filtered — it is the sentence's
    subject — so on the tier where ``agent_tool_specs`` returns an EMPTY catalog
    the model was told to call the one tool it certainly does not have.
    """
    wanted = _reachable_prompt_domains(keys)
    if not wanted:
        return _no_specialists_prompt(web_off)
    return _active_specialists_prompt(wanted, web_off)
