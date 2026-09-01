"""Deterministic planner handoff notes for the Main agent."""

from __future__ import annotations

#: ARCELLE BUILT THE PLAN (owner decision #2, 2026-08-03). Appended to the Main
#: agent's paragraph whenever :func:`.planner.build_plan` named the steps.
#:
#: The paragraph above still tells the hub HOW to delegate — one call for one
#: part, ``ask_agents`` for several — and that half stays exactly as it was.
#: What moves is WHICH specialists and how many: the same request used to
#: produce twelve, then five, then none, because that decision is a plan, and a
#: plan is the multi-turn agency a small model measures worst at. So the plan
#: arrives already made and this paragraph's whole job is to stop the model
#: improving on it.
#:
#: It deliberately does NOT close the door on a follow-up. A specialist that
#: reports MISSING and names another area is new information that did not exist
#: when the plan was built, and refusing to act on it would turn a truthful
#: report into a dead end — which is the opposite of what the report contract is
#: for. Adding a specialist BEFORE any report exists is the thing being stopped.
PLAN_NOTE_TEMPLATE = (
    "\n\nTHIS TURN'S PLAN IS ALREADY MADE. Arcelle built it from what the user "
    "asked and from the specialists this room can actually reach right now, so "
    "choosing them is not your job on this turn. Run exactly these steps:\n"
    "{steps}\n"
    "{call}"
    "Do not add a specialist this plan does not name, do not drop one it does, "
    "and do not reorder them. If a specialist reports MISSING and names another "
    "area, you may ask that one afterwards — that is a follow-up to a finished "
    "step, not a new plan. Everything else is unchanged: you still write the "
    "final answer yourself in plain words, you still never narrate the "
    "machinery, and you still never say an agent did something it did not "
    "report doing."
)

#: How to actually emit a plan of SEVERAL steps. One call, because a small model
#: asked for N tool calls in one round gets the COUNT wrong far more often than
#: it gets one call's arguments wrong (BFCL V4) — the same reason
#: ``ask_agents`` exists at all.
PLAN_CALL_BATCH = (
    "Send it as ONE {batch} call carrying exactly these tasks in this order, "
    "and set depends_on only where a step above says it needs an earlier one. "
)

#: …and of exactly one. Naming the single tool removes the last choice.
PLAN_CALL_SINGLE = "Make exactly one call — {tool} — with that instruction. "

#: A part of the request whose specialist this room cannot reach this turn.
#:
#: Same doctrine as :data:`TAG_UNAVAILABLE_ANSWER`: name it, refuse it, and do not
#: quietly hand it to whoever is left. Substituting a specialist is how "redo the
#: transcript" was once answered by re-saving an unrelated earlier reply.
PLAN_UNAVAILABLE_NOTE = (
    "\n\nTHIS ROOM HAS NO SPECIALIST for part of what was asked: {parts}. Say "
    "that plainly, in your own words, as part of your answer. Do not hand that "
    "part to a different specialist and do not answer it from memory."
)

#: The planner ABSTAINED — nothing in the words named a specialist it could be
#: sure of, so the hub keeps the judgement.
#:
#: Said out loud rather than left silent. A turn with no plan note looks
#: identical to a turn whose plan note failed to render, and the difference
#: matters to anyone reading a transcript after the fact — this app writes no
#: log of its own, so the prompt is the record.
NO_PLAN_NOTE_TEMPLATE = (
    "\n\nARCELLE COULD NOT NAME THE SPECIALISTS for this request from the words "
    "used, so this one turn is yours to judge — it is the exception, not the "
    "rule. Keep it minimal: ask only the specialists the request genuinely "
    "needs, and if it is about this room's own content that is {tool} and "
    "nothing else. A greeting, thanks, or general knowledge you already have, "
    "you answer directly with no call at all."
)

#: A part of the request the planner could NOT name a specialist for, on a turn
#: where it named one for some other part.
#:
#: THE BUG THIS EXISTS FOR (review, 2026-08-03). An unclaimed clause used to be
#: handed to the DEFAULT domain and then stated as fact in the plan above, under
#: "run exactly these steps … do not drop one". So "search the web for rents;
#: thanks!" planned a File agent sub-loop for "thanks!", and in a web-off room
#: "search the web for rents; email dana" planned the WEB half as a File agent
#: step — a substituted specialist, which is the one thing every other paragraph
#: in this file refuses to do. Unclaimed is not the same as "belongs to the
#: default": the planner abstains per CLAUSE now, exactly as it abstains per
#: turn, and says which parts it abstained on.
#:
#: Deliberately does NOT say "no specialist" — that is
#: :data:`PLAN_UNAVAILABLE_NOTE`'s sentence, and it is a claim about the ROOM.
#: This one is a claim about the PLANNER, which is a much smaller thing.
PLAN_REMAINDER_NOTE = (
    "\n\nARCELLE DID NOT PLAN these parts of the request: {parts}. Whatever the "
    "steps above do and do not name, THESE are yours to judge, the way you "
    "would judge any turn: ask a specialist for one only where a specialist is "
    "genuinely needed, and answer a greeting, a thank-you or general knowledge "
    "you already have directly, with no call at all. Do not leave them "
    "unanswered."
)

#: …and the one extra sentence when the room's default specialist is reachable.
#: Split off rather than templated with an empty string, because a tier that
#: serves no file box would otherwise read "that is  and nothing else".
PLAN_REMAINDER_ROOM_HINT = (
    " If a part is about this room's own content, that is {tool} and nothing "
    "else — never answer those from memory."
)


def _plan_step_lines(steps: list[tuple[str, str, str, bool]]) -> str:
    return "\n".join(
        f"{index + 1}. {label} ({area}) — {instruction}"
        + (f" [needs step {index}]" if needs_previous else "")
        for index, (label, area, instruction, needs_previous) in enumerate(steps)
    )


def _plan_call(
    steps: list[tuple[str, str, str, bool]], tools: list[str], batch_tool: str
) -> str:
    if len(steps) == 1:
        return PLAN_CALL_SINGLE.format(tool=tools[0])
    return PLAN_CALL_BATCH.format(batch=batch_tool)


def _planned_note(
    steps: list[tuple[str, str, str, bool]], tools: list[str], batch_tool: str
) -> str:
    if not steps:
        return ""
    return PLAN_NOTE_TEMPLATE.format(
        steps=_plan_step_lines(steps), call=_plan_call(steps, tools, batch_tool)
    )


def _unavailable_note(unavailable: tuple[tuple[str, str], ...]) -> str:
    if not unavailable:
        return ""
    parts = "; ".join(f'{label} — "{text}"' for label, text in unavailable)
    return PLAN_UNAVAILABLE_NOTE.format(parts=parts)


def _unplanned_note(unplanned: tuple[str, ...], default_tool: str) -> str:
    if not unplanned:
        return ""
    note = PLAN_REMAINDER_NOTE.format(parts="; ".join(f'"{text}"' for text in unplanned))
    if default_tool:
        note += PLAN_REMAINDER_ROOM_HINT.format(tool=default_tool)
    return note


def plan_note(
    steps: list[tuple[str, str, str, bool]],
    *,
    tools: list[str],
    batch_tool: str,
    unavailable: tuple[tuple[str, str], ...] = (),
    unplanned: tuple[str, ...] = (),
    default_tool: str = "",
) -> str:
    """The handover paragraph for a plan Arcelle built.

    ``steps`` are ``(label, area, instruction, needs_previous)`` and ``tools``
    the parallel ``ask_*_agent`` names. Both come from
    :class:`.planner.PlanStep`, which is where the data lives; the WORDS live
    here with every other paragraph a model reads, so "what did we tell it" is
    one grep in one file.
    """
    return (
        _planned_note(steps, tools, batch_tool)
        + _unavailable_note(unavailable)
        + _unplanned_note(unplanned, default_tool)
    )


def no_plan_note(default_tool: str) -> str:
    """The paragraph for a turn the planner deliberately did not plan."""
    return NO_PLAN_NOTE_TEMPLATE.format(tool=default_tool)
