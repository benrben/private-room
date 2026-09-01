"""Immutable routing data types shared by agent registries and graphs."""

from __future__ import annotations

from dataclasses import dataclass

@dataclass(frozen=True, slots=True)
class Action:
    """One mutually-exclusive terminal verb a routing shape may pick.

    The classifier is the ``hints`` tuple and it runs in plain Python, which is
    the documented "rule-based logic" arm of LangGraph's Router pattern — not a
    model call. A deterministic pick is 100% reproducible where a 4B's is not.
    """

    tool: str
    hints: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Flow:
    """Per-agent DATA for a SHARED graph shape.

    The reason templates can be shared without becoming generic mush: two
    agents run the same wiring and behave differently because their ``Flow``
    differs. Behaviour stays testable data rather than a branch inside a node.
    """

    #: Routing shapes only: the exclusive terminal verbs, scored by `hints`.
    actions: tuple[Action, ...] = ()
    #: A tool fired deterministically as the FIRST act of the turn, for agents
    #: whose opening move is a constant. Zero model cost.
    probe: str = ""
    #: A tool that must have RUN before ``probe`` is worth firing. Empty = the
    #: probe has no precondition, which is the common case.
    #:
    #: THE BUG THIS EXISTS FOR (2026-07-30): `app.ui` can perceive at any time
    #: because the app's own interface always exists, and `chat.browse` copied
    #: that pattern — but a web PAGE does not exist until `browse_open` has run.
    #: So every browse task opened with a `browse_snapshot` that could only fail
    #: ("The browser isn't open. Use browse_open first."), which the host
    #: journals as an `error` the USER reads back. A guaranteed failed first
    #: step on every task of a whole feature, and a small model's opening
    #: context poisoned with an error it did not cause.
    probe_after: str = ""
    #: Substrings in the LAST tool result meaning the precondition tool ran but
    #: did not establish the precondition, so ``probe`` still must not fire.
    #:
    #: THE BUG THIS EXISTS FOR (2026-08-02): BROWSE-3c let `browse_open` take
    #: plain words and answer with SEARCH RESULTS instead of navigating. That
    #: satisfies `probe_after` — the tool was attempted — while leaving no page
    #: at all, which put the guaranteed-failing `browse_snapshot` back exactly
    #: where `probe_after` had removed it: between the agent receiving its
    #: results and choosing one.
    #:
    #: Fails OPEN like ``blockers``: if the host's wording drifts, the probe
    #: fires as it did before this field existed, rather than never firing.
    probe_unless: tuple[str, ...] = ()
    #: Substrings in the probe's result that mean "this cannot be done". The
    #: predicate fails OPEN when none match, so drifting Rust wording degrades
    #: to today's behaviour rather than to a refusal.
    blockers: tuple[str, ...] = ()
    #: The answer given when a blocker matched — composed in code, no model.
    blocked_answer: str = ""
    #: Substrings in a tool result that mean the action FAILED — a traceback,
    #: a validation list. Fed back raw: the code-assistant tutorial's A/B found
    #: raw-error feedback BEAT a reflection call, so this costs no model round.
    failure_markers: tuple[str, ...] = ()
    #: How many repair passes this agent may spend. 0 = report the failure
    #: honestly instead (looping a 4B on someone else's script invents output).
    repair_cap: int = 0
    #: An ORDERED chain of one-tool stages, for agents whose prompt already
    #: prescribes the order (so the order is not the model's to choose).
    stages: tuple[str, ...] = ()
    #: Tools that stay offered ALONGSIDE a narrowed verb — the resolvers a
    #: model needs to turn "the contract" into a real filename. Without these
    #: a narrowed round cannot recover from a loosely-named argument.
    keep: tuple[str, ...] = ()
    #: A successful action is not enough for some agents: these tools require a
    #: later structured receipt before success wording is allowed (workflow
    #: authoring -> test_workflow -> ``VALIDATED: yes``).
    receipt_after: tuple[str, ...] = ()
    receipt_tool: str = ""
    receipt_marker: str = ""
    receipt_missing: str = ""


@dataclass(frozen=True, slots=True)
class AgentSpec:
    """One sub-agent, fully described as data.

    Every field below is READ by the running loop. Two were not, and both went
    on 2026-08-01: ``read_only`` — decoration shaped like a safety switch, since
    a spec could be marked read-only and still be handed ``browse_do`` with no
    code path noticing — and ``description``, a one-liner carried on every row
    for a constrained classifier that was never built. An agent's role is
    already stated where something actually reads it: the first sentence of its
    ``prompt`` (the model reads that every turn) and the per-domain blurb in
    :data:`AGENT_TOOL_DOMAINS` (the Main agent's catalog).

    ``tag``/``area``/``summary`` are the ``*`` menu's three columns, and they
    are NOT that removed field coming back: they are read on every roster call
    (:func:`specialist_roster`) and shown to a PERSON. The distinction that
    matters is who the audience is. A MODEL picks among ≤6 domains, because
    that is what a 4B does reliably; a person picks from a dropdown, where
    "Web" and "Browser" are two different jobs and collapsing them hides one of
    the room's agents behind the other. So the model-facing catalog stays
    per-domain and this trio is per-AGENT.
    """

    #: Stable id, ``domain.name`` (e.g. ``"jobs.run"``).
    id: str
    #: Human label for step chips (``graph.py`` reads it for the agent strip and
    #: for the worker's report header).
    label: str
    #: Tools this agent ADDS on top of CORE. ≤ MAX_BOX_TOOLS; tests pin it.
    tools: tuple[str, ...]
    #: The tools WITHOUT WHICH this box cannot do its job. ``worker_reachable``
    #: requires ALL of them on top of its usual "some tool of this box was
    #: served" test. Empty — the normal case — means every tool in the box is
    #: equally load-bearing and any one of them is enough to be useful.
    #:
    #: THE BUG THIS EXISTS FOR (2026-08-01): ``app.ui``'s box is the four
    #: UI_TOOL_NAMES, one of which is ``view_media_frame`` — a room video's
    #: pixels, which ``room_mcp::ToolScope`` classes as CONTENT and therefore
    #: serves to a cloud-CLI room, while the three SCREEN tools stay local-only.
    #: An any-one-of-them test passed on that single unrelated tool, so a Claude
    #: or Codex room was offered an App agent that cannot see or click anything
    #: and was briefed by UI_PROMPT on ui_snapshot/ui_act regardless. Watching a
    #: video is already ``media.video``'s job under ``ask_file_agent``, so
    #: nothing is lost by dropping the domain on those tiers.
    requires: tuple[str, ...] = ()
    #: This worker's real job is CORE; its :attr:`tools` box is an ADDITION it
    #: is useful without. ``worker_reachable`` then tests CORE rather than the
    #: box, exactly as it does for a worker with no box at all.
    #:
    #: THE BUG THIS EXISTS FOR (2026-08-07): the File agent had ``tools=()`` and
    #: rode the CORE branch of ``worker_reachable``. Giving it the ORGANIZE box
    #: moved it onto the box branch — so on any tier that does not serve the
    #: organize tools (a consulted advisor, ``include_organize_tools``) the File
    #: agent, the room's DEFAULT worker, silently became UNREACHABLE. Reading,
    #: searching and editing files is its job whether or not it can also tidy
    #: them; "cannot file things" is not "has nothing to do".
    #:
    #: Only true where it is really true. For ``chat.web`` or ``jobs.run`` the
    #: box IS the job, and a tier that serves none of it must drop the domain
    #: rather than route to an empty one — the confident-non-answer this whole
    #: function exists to kill.
    core_capable: bool = False
    #: The name a user types after ``*`` to send a turn HERE ("browse"). ``a-z``
    #: only, because that is all `tagged_specialist` and the host's
    #: ``composer.ts`` can lex, and unique across the registry — both pinned by
    #: the import-time assert below. "" for the Main agent alone, which is the
    #: interlocutor rather than a specialist anyone can tag.
    #:
    #: A domain's FIRST member carries its DOMAIN key ("web" is `chat.web`), so
    #: the vocabulary a user already learned keeps meaning what it meant and
    #: `resolve_worker`'s default is what a bare domain tag reaches.
    tag: str = ""
    #: The menu's one-line hint: this agent's area, in plain words. Also the
    #: ``{area}`` of `prompts.DIRECT_SPECIALIST_NOTE`, so a directly-tagged
    #: specialist is told its own scope in the words the menu offered it under.
    area: str = ""
    #: The menu's full sentence: what this agent can actually be asked for. Per
    #: AGENT, not per domain — "searches and reads pages" and "opens and
    #: operates a page" are the honest answers for the two internet workers, and
    #: one shared domain sentence could only be one of them.
    summary: str = ""
    #: System-prompt paragraph appended while this agent is active ("" = the
    #: base prompt already covers it).
    prompt: str = ""
    #: Deterministic routing vocabulary (lowercase substrings, EN + Hebrew).
    hints: tuple[str, ...] = ()
    #: False while the host serves no tools for this box (documents the
    #: target tree without offering the unlockable).
    available: bool = True
    #: request_tools group this box belongs to ("" = not unlockable mid-turn).
    group: str = ""
    #: Which graph SHAPE this agent runs (owner decision 2026-07-25). Agents do
    #: not all do the same kind of work, so they do not all get the same
    #: topology: the Studio agent generates once and answers, the File agent
    #: needs a ground-truth check before it reports, the Main agent dispatches
    #: rather than acting. Templates are SHARED where the work really is the
    #: same and distinct where it is not — see :mod:`.graphs`. The SPEC §3.2
    #: invariants live in the shared NODE functions, not in the shape, so a new
    #: template cannot quietly drop the tool-less final round or the memo set.
    template: str = "react"
    #: Per-agent data for that shape (routed verbs, probe, stages, …).
    flow: Flow = Flow()
    #: True for THE MAIN AGENT (owner decision 2026-07-23, hub-and-spoke): the
    #: user's single interlocutor. It runs NO tools — every piece of work is
    #: delegated to a specialist worker, whose report comes BACK to the main
    #: agent, and the main agent alone composes the user-facing answer. Never
    #: routable as a plan step; run_agent appends its synthesis turn itself.
    main: bool = False
