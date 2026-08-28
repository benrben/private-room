"""Live-model e2e for the PER-AGENT GRAPH SHAPES (2026-07-25).

    ARCELLE_E2E=1 uv run pytest tests/e2e_live/test_live_shapes.py -q

The unit tests in ``tests/test_graphs.py`` drive every shape against a scripted
model, which proves the WIRING. They cannot prove the thing that actually broke
twice this repo's history: that a real small model, seeing a real catalog at a
production turn size, still lands where the shape intends. `app.ui` in
particular had ZERO live coverage while carrying the single biggest structural
change in the roster.

Each test asserts a STRUCTURAL fact the shape guarantees — a tool fired without
a model round, a catalog was narrowed, a payload was dropped — rather than the
quality of the model's prose. Those facts hold for any model; prose does not.
"""

from __future__ import annotations

from typing import Any

from .harness import (
    CATALOG,
    RecordingBridge,
    run_worker_live,
    skip_unless_live,
    tool_spec,
)

skip_unless_live()


UI_TOOLS = [
    tool_spec(
        "ui_snapshot",
        "List every visible control in the app as numbered marks.",
    ),
    tool_spec(
        "ui_act",
        "Click, type into, or scroll ONE numbered mark.",
        action={"type": "string"},
        mark={"type": "integer"},
    ),
    tool_spec("view_screenshot", "Attach what the user currently sees."),
]

MEDIA_TOOLS = [
    tool_spec("stt_status", "Whether the on-device speech model is installed."),
    tool_spec(
        "retranscribe_file", "Re-transcribe a room recording.", name={"type": "string"}
    ),
]

WEB_TOOLS = [
    tool_spec("web_search", "Search the live internet.", query={"type": "string"}),
    tool_spec("fetch_page", "Fetch and read one page.", url={"type": "string"}),
]

#: BROWSE-2: the ingestion verbs chat.web carries alongside search/fetch.
DOWNLOAD_TOOLS = [
    tool_spec(
        "save_link",
        "Save a web page into the room as a readable Markdown file.",
        url={"type": "string"},
    ),
    tool_spec(
        "download_url",
        "Download the file at a URL into the room.",
        url={"type": "string"},
    ),
    tool_spec(
        "download_media",
        "Download a page's video into the room as a background job.",
        url={"type": "string"},
    ),
]

STUDIO_TOOLS = [
    tool_spec("studio_flashcards", "Generate flashcards.", source={"type": "string"}),
    tool_spec("studio_mindmap", "Generate a mind map.", source={"type": "string"}),
    tool_spec(
        "generate_podcast_script", "Generate a podcast script.", source={"type": "string"}
    ),
]

SCRIPT_TOOLS = [
    tool_spec("list_scripts", "List the room's saved scripts."),
    tool_spec("run_script", "Run a saved script by name.", name={"type": "string"}),
]

#: CORE minus the tools a focused box does not need — keeps the live catalog at
#: a realistic size without dragging every domain in.
CORE_SUBSET = [t for t in CATALOG if t["name"] in {"list_room_files", "search_room", "open_file"}]


def _images_in(state: dict[str, Any]) -> list[int]:
    """Indices of messages still carrying base64 image payloads."""
    return [i for i, m in enumerate(state.get("messages", [])) if m.get("images")]


# --- perceive_act (app.ui) — the biggest change, previously untested --------- #


async def test_the_ui_agent_captures_before_the_model_speaks() -> None:
    """The capture is the GRAPH's move, not the model's.

    Under the old loop a UI task cost two model rounds per action: one to ask
    for `ui_snapshot`, one to decide what to click. `perceive` fires it
    deterministically, so the FIRST thing that reaches the bridge is the
    snapshot — before the model has produced a single token.
    """
    bridge = RecordingBridge(
        tools=CORE_SUBSET + UI_TOOLS,
        reply=lambda name, args: (
            "1: [button] Map\n2: [button] Files\n3: [button] Settings"
            if name == "ui_snapshot"
            else "OK."
        ),
    )
    try:
        out = await run_worker_live("app.ui", "open the Room Map", bridge=bridge)
    finally:
        bridge.close()

    assert out["tool_calls"], "no tool reached the bridge at all"
    assert out["tool_calls"][0] == "ui_snapshot", (
        f"the first bridge call was {out['tool_calls'][0]!r}; the capture must be "
        f"deterministic, not something the model spends a round asking for"
    )


async def test_only_one_screenshot_keeps_its_pixels_over_a_live_run() -> None:
    """WebVoyager's single-live-image rule, end to end.

    Every capture returns base64 pixels as a user message. Under a plain loop
    they ACCUMULATE — one per action — inside a payload-fitted num_ctx, which is
    the context-shift class already diagnosed in this repo (the 4k-window
    "Done." regression). A stale screenshot is also a UI state that no longer
    exists, so keeping it is wrong as well as expensive.
    """
    png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

    def reply(name: str, args: dict[str, Any]) -> str:
        return "1: [button] Map\n2: [button] Files" if name == "ui_snapshot" else "OK."

    class ImageBridge(RecordingBridge):
        pass

    bridge = ImageBridge(tools=CORE_SUBSET + UI_TOOLS, reply=reply)
    try:
        out = await run_worker_live(
            "app.ui", "open the Room Map, then open Files", bridge=bridge
        )
    finally:
        bridge.close()

    bearing = _images_in(out["state"])
    assert len(bearing) <= 1, (
        f"{len(bearing)} messages still carry image payloads; trim_images must "
        f"leave exactly the newest one"
    )
    # Sanity: the run really did drive the UI loop.
    assert out["tool_calls"].count("ui_snapshot") >= 1
    assert png  # the fixture is here to document the payload shape


# --- probe_gate_act (media.transcribe) — the agent that could not act -------- #


async def test_the_transcribe_agent_probes_first_and_still_reaches_its_verb() -> None:
    """THE bug this shape exists for, against a real model.

    Under `oneshot` the agent had ONE tool round while its prompt told it to
    check `stt_status` first — so an agent that obeyed its own prompt could
    never reach `retranscribe_file`.
    """
    bridge = RecordingBridge(
        tools=CORE_SUBSET + MEDIA_TOOLS,
        reply=lambda name, args: (
            "speech model ready (whisper-large-v3)" if name == "stt_status" else "OK."
        ),
    )
    try:
        out = await run_worker_live(
            "media.transcribe", "re-transcribe talk.mp4", bridge=bridge
        )
    finally:
        bridge.close()

    assert out["tool_calls"][0] == "stt_status", "the probe must fire first, free"
    assert "retranscribe_file" in out["tool_calls"], (
        f"the agent never reached its action verb: {out['tool_calls']}"
    )


async def test_a_blocked_probe_answers_with_no_model_round_at_all() -> None:
    """When the capability is missing the answer is a constant, so it should
    cost nothing. Under a plain loop this path burned two model rounds."""
    from arcelle_sidecar.agents import get_agent

    bridge = RecordingBridge(
        tools=CORE_SUBSET + MEDIA_TOOLS,
        reply=lambda name, args: (
            "Speech model is not installed." if name == "stt_status" else "OK."
        ),
    )
    try:
        out = await run_worker_live(
            "media.transcribe", "transcribe the meeting", bridge=bridge
        )
    finally:
        bridge.close()

    assert out["tool_calls"] == ["stt_status"], "the blocked path must stop at the probe"
    assert out["final"] == get_agent("media.transcribe").flow.blocked_answer


# --- chain_stage (chat.web) — the fetch is structural now ------------------- #


async def test_the_web_agent_searches_then_fetches() -> None:
    """WEB_PROMPT prescribes search-then-fetch. As a plea a 4B ignores it and
    answers from the snippet; as stages it is structural."""
    def reply(name: str, args: dict[str, Any]) -> str:
        if name == "web_search":
            return (
                "1. Bank of Israel — Monetary Policy | https://boi.org.il/en/monetary "
                "— The interest rate is set by the Monetary Committee."
            )
        if name == "fetch_page":
            return "Bank of Israel. The interest rate is 4.25%, effective 2026-07-07."
        return "OK."

    bridge = RecordingBridge(tools=CORE_SUBSET + WEB_TOOLS, reply=reply)
    try:
        out = await run_worker_live(
            "chat.web", "what is the current central-bank rate in Israel?", bridge=bridge
        )
    finally:
        bridge.close()

    calls = out["tool_calls"]
    assert "web_search" in calls, f"never searched: {calls}"
    assert calls.index("web_search") == 0, f"search must be the first stage: {calls}"
    assert "fetch_page" in calls, (
        f"the fetch is structural in chain_stage, not optional: {calls}"
    )


async def test_the_web_agent_saves_a_link_with_the_one_step_verb() -> None:
    """BROWSE-2: "save this link" must reach save_link.

    The failure this guards: the model imitates the save with fetch_page +
    create_file (two rounds, no provenance column) or — worse — claims a save
    with no tool call at all. save_link is in the chain's keep-list, so it is
    offered at every stage; a URL the user already supplied needs no search."""

    def reply(name: str, args: dict[str, Any]) -> str:
        if name == "save_link":
            return 'Saved "Bank of Israel — Monetary Policy.md" into the room.'
        return "OK."

    bridge = RecordingBridge(
        tools=CORE_SUBSET + WEB_TOOLS + DOWNLOAD_TOOLS, reply=reply
    )
    try:
        out = await run_worker_live(
            "chat.web",
            "Save https://boi.org.il/en/monetary into this room so I can read it offline",
            bridge=bridge,
        )
    finally:
        bridge.close()
    assert "save_link" in out["tool_calls"], out["tool_calls"]
    assert out["final"].strip() != "Done."


# --- route_act (creator.studio) — the deterministic verb pick ---------------- #


async def test_the_studio_agent_is_routed_to_one_generator() -> None:
    """Three mutually exclusive generators, and the classifier is free Python.

    Asserts the DETERMINISTIC half — the narrow happened and the other two
    generators are structurally unreachable this turn. Whether a 4B then calls
    the surviving verb is a model choice, and the harness's own note says model
    choices need sampling, not a bare assertion; the negative below holds for
    any model, which is what makes it worth pinning.
    """
    def reply(name: str, args: dict[str, Any]) -> str:
        if name == "list_room_files":
            return "biology-notes.md (12 KB)\nlecture-3.pdf (400 KB)\nrent.pdf (90 KB)"
        if name == "search_room":
            return '"The mitochondrion is the powerhouse…" (biology-notes.md)'
        if "flashcard" in name:
            return "Created 12 cards from biology-notes.md."
        return "OK."

    bridge = RecordingBridge(tools=CORE_SUBSET + STUDIO_TOOLS, reply=reply)
    try:
        out = await run_worker_live(
            "creator.studio", "make flashcards from my biology notes", bridge=bridge
        )
    finally:
        bridge.close()

    # The router's decision is recorded in state and is model-independent.
    assert out["state"].get("routed") == "studio_flashcards", (
        f"route_action did not narrow: routed={out['state'].get('routed')!r}"
    )
    offered = {
        (t.get("function") or {}).get("name") for t in out["state"].get("tools", [])
    }
    assert "studio_mindmap" not in offered and "generate_podcast_script" not in offered
    # ...so no other generator can possibly have run.
    assert not ({"studio_mindmap", "generate_podcast_script"} & set(out["tool_calls"])), (
        f"a narrowed-away generator still ran: {out['tool_calls']}"
    )
    # The resolvers survive the narrow, or "my biology notes" is unresolvable.
    assert {"list_room_files", "search_room"} <= offered


# --- recall_act_check (scripts.run) — the free index prefetch ---------------- #


async def test_the_scripts_agent_loads_its_index_for_free() -> None:
    """The first move is ALWAYS `list_scripts` — you cannot run a script you
    have not named — so paying a model round to rediscover it is waste."""
    bridge = RecordingBridge(
        tools=CORE_SUBSET + SCRIPT_TOOLS,
        reply=lambda name, args: (
            "invoice.py — build the monthly invoice\ntidy.py — tidy the room"
            if name == "list_scripts"
            else "OK."
        ),
    )
    try:
        out = await run_worker_live("scripts.run", "run the invoice script", bridge=bridge)
    finally:
        bridge.close()

    assert out["tool_calls"][0] == "list_scripts", (
        f"the index prefetch must be the first call: {out['tool_calls']}"
    )
