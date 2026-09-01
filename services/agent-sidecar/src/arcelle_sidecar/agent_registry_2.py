"""Declarative agent registry, part 2."""

from __future__ import annotations

from .agent_registry_common import _SKILLS_AUTHOR, _SKILLS_USE
from .agent_types import Action, AgentSpec, Flow
from .prompts import (
    CONNECTORS_ADMIN_PROMPT,
    CONNECTORS_USE_PROMPT,
    DRAW_PROMPT,
    SKILLS_AUTHOR_PROMPT,
    SKILLS_USE_PROMPT,
    STUDIO_PROMPT,
    TRANSCRIBE_PROMPT,
    VIDEO_PROMPT,
)
from .routing import (
    DRAW_TOOL_NAMES,
    MCP_MANAGEMENT_TOOL_NAMES,
)

REGISTRY_2: tuple[AgentSpec, ...] = (
    AgentSpec(
        id="skills.use",
        flow=Flow(
            # The skill INDEX is always the first move. repair_cap=0 on purpose:
            # a skill that fails is the AUTHOR's problem, and looping a 4B on
            # someone else's script is how you get invented output.
            probe="list_skills",
            repair_cap=0,
        ),
        template="recall_act_check",
        label="Skills agent",
        tag="skills",
        area="finding and running agent skills",
        summary=(
            "Finds, reads and runs Agent Skills — written procedures that teach "
            "an agent how to carry out a kind of task."
        ),
        tools=_SKILLS_USE,
        prompt=SKILLS_USE_PROMPT,
        hints=("skill", "agent instruction", "מיומנות", "סקיל"),
        group="skills",
    ),
    AgentSpec(
        id="skills.author",
        flow=Flow(
            # Two existing skills as verbatim examples teach frontmatter shape,
            # directory layout and house style by demonstration — the highest
            # leverage cheap win in the roster. NOTE: the full "does the script
            # RUN" check needs a Rust dry-run verb that does not exist yet
            # (the sidecar may not exec anything), so `check` degrades to the
            # save-errored predicate until that lands.
            probe="list_skills",
            failure_markers=("error", "invalid", "failed"),
            repair_cap=2,
        ),
        template="recall_act_check",
        label="Skill-builder agent",
        tag="skillbuilder",
        area="writing and editing agent skills",
        summary=(
            "Writes and edits Agent Skills: drafts a new procedure, changes an "
            "existing one, or turns something you just did into a reusable "
            "skill."
        ),
        tools=_SKILLS_AUTHOR,
        prompt=SKILLS_AUTHOR_PROMPT,
        # ALL-OF hints (see `manager._matches`): the discriminator against the
        # read-only sibling is an AUTHORING VERB somewhere in a sentence that is
        # already about skills — not a contiguous phrase. The contiguous list
        # alone sent "create a small draft skill called self-test-demo" to
        # `skills.use`, which answered that it has no create verb (self-test
        # 2026-08-01, wave 2). Safe to be this broad because siblings are scored
        # only WITHIN their own domain: the ask already reached `ask_skills_agent`.
        hints=(
            "create+skill", "make+skill", "write+skill", "build+skill",
            "author+skill", "new+skill", "draft+skill", "add+skill",
            "edit+skill", "update+skill", "change+skill", "modify+skill",
            "improve+skill", "rename+skill", "delete+skill", "remove+skill",
            "turn this into a skill",
            "צור+מיומנות", "כתוב+מיומנות", "בנה+מיומנות", "חדשה+מיומנות",
            "ערוך+מיומנות", "עדכן+מיומנות", "מחק+מיומנות",
        ),
        group="skills",
    ),
    AgentSpec(
        id="connectors.admin",
        # inspect then edit a small fixed set of server configs.
        flow=Flow(),
        label="Connector setup agent",
        tag="connectorsetup",
        area="setting up connected services",
        summary=(
            "Inspects and configures this room's connections to third-party "
            "tools: list them, add or remove one, enable, disable or reconnect."
        ),
        tools=MCP_MANAGEMENT_TOOL_NAMES,
        prompt=CONNECTORS_ADMIN_PROMPT,
        # ADMINISTRATIVE INTENT ONLY — never the bare subject noun. Live QA
        # 2026-07-24: "get the price for NVDA from the Yahoo connector" scored
        # this agent 2 (on "connector") against 0 for the sibling that owns
        # search_mcp_tools/run_mcp_tool, so a plain lookup was handed to the
        # SETUP agent, which answered "the Yahoo tools weren't in its toolbox"
        # and did nothing. Any sentence that merely NAMES a connector while
        # asking to use one must fall through to `connectors.use` (the domain's
        # first member, so a 0–0 tie already lands there).
        hints=(
            "add connector", "add a connector", "add an mcp", "add mcp",
            "new connector", "install connector", "install a connector",
            "install mcp", "connect a new", "set up connector",
            "set up a connector", "set up the connector", "configure connector",
            "configure the connector", "connector settings", "connector config",
            "mcp config", "mcp server", "remove connector", "remove the connector",
            "delete connector", "disable connector", "enable connector",
            "reconnect", "list connectors", "list my connectors",
            "which connectors", "what connectors", "my connectors",
            # "mcp connector(s)" as a NAMED SUBJECT is administrative talk —
            # someone using a connector says "the Yahoo connector", not "my MCP
            # connectors". The bare "mcp" is still not a hint.
            "mcp connector", "show connectors", "see connectors", "view connectors",
            "הוסף מחבר", "התקן מחבר", "הגדר מחבר", "הגדרות מחבר", "מחק מחבר",
            "הסר מחבר", "אילו מחברים", "רשימת מחברים", "המחברים שלי",
        ),
        group="connectors",
    ),
    AgentSpec(
        id="connectors.use",
        # discover the tool, invoke it, CHECK, report.
        #
        # `react_verify`, not plain `react` (2026-07-27). This is the agent that
        # sends email and Slack messages, i.e. the least reversible thing in the
        # roster, and it was the one worker doing outbound effects with no
        # ground-truth gate at all — a `run_mcp_tool` that ERRORED still reached
        # the user as "sent". `run_mcp_tool` is in `graphs.WRITE_TOOLS`, so the
        # same predicate that catches a claimed file write now catches a claimed
        # send: evidence is recorded on success only.
        template="react_verify",
        flow=Flow(),
        label="Connector agent",
        tag="connector",
        area="the user's connected services",
        summary=(
            "Uses the third-party tools the user has connected: sends email and "
            "Slack messages, reads calendars, calls an external app's tools."
        ),
        tools=("search_mcp_tools", "run_mcp_tool"),
        prompt=CONNECTORS_USE_PROMPT,
        hints=(
            "send ", "post ", "email", "mail", "slack", "calendar", "notion",
            "github", "jira", "שלח ", "מייל", "יומן", "לוח שנה",
        ),
        # No group: the user connected those servers explicitly, so the proxy
        # pair is ALWAYS offered when served (pre-registry behavior preserved);
        # routing here just adds the sharper prompt/label.
    ),
    AgentSpec(
        id="media.transcribe",
        # probe status, retranscribe, report.
        flow=Flow(
            probe="stt_status",
            # Matched against Rust-authored result text; the gate fails OPEN so
            # drifting wording costs us today's behaviour, never a false
            # refusal. Parity-locked by test_transcribe_blockers_match_rust.
            blockers=("not installed", "no speech model", "unavailable"),
            blocked_answer=(
                "MISSING: the on-device speech model is not installed, so "
                "nothing can be transcribed until it is."
            ),
            # A re-transcription is asynchronous in the room bridge. Give the
            # receipt gate one chance to inspect the durable job before it
            # reports an honest pending status; it must never turn QUEUED into
            # a past-tense success sentence (ARC-027).
            repair_cap=1,
        ),
        # Was "oneshot" (ONE tool round) while TRANSCRIBE_PROMPT tells it
        # "stt_status ... check it before promising anything". An agent that
        # OBEYED its own prompt spent its single round on the probe and could
        # never reach retranscribe_file — the prompt and the template were in
        # direct contradiction. Now the probe is deterministic and free, so the
        # model round is available for the actual work.
        template="probe_gate_act",
        label="Transcription agent",
        tag="transcribe",
        area="transcribing this room's audio and video",
        summary=(
            "Transcribes this room's audio and video on-device, and "
            "re-transcribes a file whose transcript is missing or wrong."
        ),
        # NOT transcribe_audio (it takes base64 bytes from the recorder UI)
        # and NOT rec_retranscribe (it drives a live recording session) — an
        # agent can supply neither. Re-transcribing a room FILE is the
        # operation it can actually perform.
        tools=("stt_status", "retranscribe_file", "job_status", "read_recording"),
        prompt=TRANSCRIBE_PROMPT,
        # VERBS, plus the noun only when the sentence asks for a transcript to
        # be MADE (or made again). The bare noun "transcript" used to be a hint,
        # and it is what a user says when they want to READ one: "summarize the meeting
        # transcript" scored here 1-0 against the hintless File agent and was
        # briefed to re-run the speech model on a file it was asked to
        # summarize. ("re-transcribe" was also redundant — it contains
        # "transcribe".)
        hints=(
            "transcribe", "transcription", "תמלל", "תמלול",
            # ALL-OF (see `manager._matches`): noun + a remake verb/complaint.
            "transcript+redo", "transcript+again", "transcript+wrong",
            "transcript+missing", "transcript+no ", "transcript+fix",
            "transcript+bad", "transcript+poor", "transcript+empty",
            # …and the ask that wants one MADE without saying "transcribe"
            # ("make me a transcript of the standup"). The tell is the
            # INDEFINITE article: you ask for "a transcript" when it does not
            # exist yet and for "THE transcript" when you want to read the one
            # that does. These stay CONTIGUOUS phrases on purpose — the obvious
            # ALL-OF spelling (transcript+make / +create / +need) re-opens the
            # false positive the pairs above were narrowed to close, and worse:
            # "make flashcards from the transcript" would match it, and because
            # the last tie-break rung prefers the LONGEST matched hint, the
            # 15-character pair beats creator.studio's "flashcard" outright.
            "a transcript of", "me a transcript", "new transcript",
            # Reading a recording (chapters / highlights / notes). ALL-OF pairs
            # against a recording noun, not bare verbs: "make chapters" alone is
            # also what someone says about a document, and "action items" is a
            # phrase the File agent answers about notes.md every day. Anchoring
            # each on meeting/recording/standup/call keeps this agent to the
            # asks it can actually act on with `read_recording`.
            "chapters+meeting", "chapters+recording", "chapters+standup",
            "chapters+call", "highlights+meeting", "highlights+recording",
            "action items+meeting", "action items+recording",
            "action items+standup", "action items+call",
            "decided+meeting", "decided+recording", "decided+standup",
            "read+recording", "read+meeting",
        ),
    ),
    AgentSpec(
        id="media.video",
        # This agent used to carry a deliberately small round budget: every
        # round can pull a full FRAME IMAGE into context, so its budget was a
        # CONTEXT budget as much as a work budget. The per-agent budgets were
        # removed (2026-07-27, owner call), so nothing bounds frame accumulation
        # here any more — if long video sessions start context-shifting, this is
        # the agent to give an image-aware trim (the `trim_images` node
        # `perceive_act` uses) rather than to give a round cap back.
        flow=Flow(),
        # Not `perceive_act`: that shape opens with a constant probe and keeps
        # exactly ONE live image (right for a screen, whose past states are
        # worthless). A video agent has no constant opening move — the frame it
        # wants depends on the question — and comparing two moments is the
        # normal case, so the frames must stay.
        template="react",
        label="Video agent",
        tag="video",
        area="watching this room's videos",
        summary=(
            "Watches a video in this room and reports what is on screen at any "
            "moment you ask about."
        ),
        # One tool, deliberately. The value of this box is not its size — it is
        # that SOMEBODY owns watching, with CORE's search_room (which returns
        # the transcript's [m:ss] stamps) as the way in.
        tools=("view_media_frame",),
        prompt=VIDEO_PROMPT,
        # Substring matching with no word boundaries, so a bare "frame" claims
        # "framework" and "the clip" claims "the clipboard" (both caught by
        # test_watching_a_video_reaches_the_video_agent_not_the_transcriber).
        # Every short stem here is anchored; a sentence-final "the clip" is
        # deliberately left to the default worker rather than widened back.
        hints=(
            "video", "footage", "clip ", "scene", "watch",
            "frame at", ".mp4", ".mov", "on screen at",
            "וידאו", "סרטון", "קליפ", "סצנה", "פריים",
        ),
    ),
    AgentSpec(
        id="creator.studio",
        # Three mutually exclusive terminal generators, each with its own hint
        # vocabulary — the clearest sub-action routing in the registry. The
        # product already asks for this: STUDIO_PROMPT says "One well-made
        # artifact beats several thin ones", which is the product requesting a
        # router and getting a tool loop. On a tie route_action abstains and the
        # model picks among all three, exactly as before.
        flow=Flow(
            actions=(
                Action(
                    tool="studio_flashcards",
                    hints=("flashcard", "flash card", "quiz", "revise", "memoris",
                           "memoriz", "כרטיסי"),
                ),
                Action(
                    tool="studio_mindmap",
                    hints=("mind map", "mindmap", "diagram", "map out", "concept map",
                           "מפת חשיבה"),
                ),
                Action(
                    tool="generate_podcast_script",
                    hints=("podcast", "script", "episode", "dialogue", "narrat",
                           "פודקאסט"),
                ),
            ),
            keep=("list_room_files", "search_room", "open_file"),
        ),
        template="route_act",
        label="Studio agent",
        tag="studio",
        area="flashcards, mind maps and podcast scripts",
        summary=(
            "Turns this room's material into one made thing: a set of "
            "flashcards, a mind map, or a podcast script."
        ),
        # stage_preview_html is a UI staging call, not an agent verb.
        tools=("studio_flashcards", "studio_mindmap", "generate_podcast_script"),
        prompt=STUDIO_PROMPT,
        # "study" was a bare hint, and it is an ordinary English verb for
        # READING something carefully: "study the lease" scored here 1-0 against
        # the hintless File agent and was briefed to generate flashcards. Only
        # the phrases that name a study ARTIFACT survive.
        hints=(
            "flashcard", "flash card", "mind map", "mindmap", "podcast", "quiz",
            "study guide", "study aid", "study material", "help me study",
            "כרטיסי", "מפת חשיבה",
        ),
    ),
    AgentSpec(
        id="creator.draw",
        # A SIBLING in the file domain rather than a seventh domain of its own.
        # The hub's domain list is capped at six because a 4B picks reliably
        # among no more (see MAX_DOMAINS below), and a drawing is a document
        # this room holds — the same place `creator.studio` already sits.
        #
        # `react_verify`, not `react`: `draw` is a write, and the write-claim
        # gate should audit "I drew it" exactly as it audits "I saved it".
        template="react_verify",
        # probe_unless keeps the read off a turn that is starting a NEW
        # drawing: reading a page that does not exist yet costs a round trip
        # and returns an error the model then has to reason past.
        flow=Flow(
            probe="read_drawing",
            probe_unless=("new ", "start a", "from scratch", "blank", "empty"),
        ),
        label="Drawing agent",
        tag="sketch",
        area="drawings on the room's sketch pages",
        summary=(
            "Draws on this room's sketches — diagrams, flows and maps — then "
            "measures its own work and corrects it."
        ),
        tools=DRAW_TOOL_NAMES,
        # A drawing is not complete until the agent has inspected its raster.
        # A blind provider can emit coordinates but cannot honestly verify the
        # visual result, so discovery hides the whole specialist.
        requires=("draw", "read_drawing"),
        prompt=DRAW_PROMPT,
        # Anchored to the ARTIFACT, not to the verb. "draw" alone is an
        # ordinary English word for describing anything ("draw a conclusion",
        # "that draws on chapter 3"), and a bare hint would pull ordinary
        # reading work onto an agent that can only draw.
        hints=(
            "sketch", "draw a", "draw me", "draw the", "drawing", "diagram",
            "flow chart", "flowchart", "whiteboard", "wireframe", "canvas",
            "boxes and arrows", "מפה", "שרטוט",
        ),
    ),
)
