"""Live-model e2e: every dispatch-first scenario, at production turn shapes.

Each test states the LIVE failure it guards against. Assertions are on
outcomes a correct run cannot miss (which tools ran, plan shape, a grounded
non-"Done." final) — never on exact model prose, so a wording change can't
flake the suite.

    ARCELLE_E2E=1 uv run pytest tests/e2e_live -q
"""

from __future__ import annotations

from .harness import (
    BASE_SYSTEM,
    RecordingBridge,
    run_ask,
    run_ask_sampled,
    skip_unless_live,
)

skip_unless_live()

DONE = "Done."

ROOM_LISTING = (
    "Claude Code best practices ｜ Code w⧸ Claude.mp4 (video, 214.0 MB)\n"
    "Don't Build Agents, Build Skills Instead – Barry Zhang & Mahesh Murag, "
    "Anthropic.mp4 (video, 188.3 MB)"
)

#: ~19KB of transcript-style retrieval context — the production-size turn
#: that context-shifted into "Done." before the payload-fitted num_ctx fix.
_CHUNK_A = (
    "So one of the things we found with Claude Code is that the best practices "
    "really matter: keep CLAUDE.md short, use subagents for exploration, verify "
    "with tests. " * 60
)
_CHUNK_B = (
    "The thesis of this talk is simple: do not build agents, build skills. Skills "
    "are procedural memory: markdown instructions the model loads on demand, "
    "progressively. " * 60
)
PRODUCTION_SYSTEM = (
    BASE_SYSTEM
    + "\n\nFiles currently stored in this room:\n"
    + "- Claude Code best practices ｜ Code w⧸ Claude.mp4 (video/mp4) — A conference "
    "talk about using Claude Code well: short CLAUDE.md files, subagents, and "
    "test-driven verification loops.\n"
    + "- Don't Build Agents, Build Skills Instead – Barry Zhang & Mahesh Murag, "
    "Anthropic.mp4 (video/mp4) — A talk arguing that skills beat hand-built agent "
    "scaffolds, with examples of progressive disclosure.\n"
)
PRODUCTION_CONTEXT = (
    "Context from files stored in this room:\n\n"
    f"[file: Claude Code best practices ｜ Code w⧸ Claude.mp4]\n{_CHUNK_A}\n\n"
    "[file: Don't Build Agents, Build Skills Instead – Barry Zhang & Mahesh Murag, "
    f"Anthropic.mp4]\n{_CHUNK_B}\n\n---\n\n"
)


def room_reply(name: str, args: dict) -> str:
    if name == "list_room_files":
        return ROOM_LISTING
    if name == "search_room":
        return "No matching passages found."
    if name == "start_file_pass":
        return "Started a background pass (job j-e2e) covering the whole file."
    if name == "search_mcp_tools":
        return '[{"id": "slack.send_message", "description": "Send a Slack message"}]'
    if name == "run_mcp_tool":
        return "Message delivered."
    return "OK."


#: Room + system for the compound-plan tests: the ask names "the book", so
#: the room must actually CONTAIN one — against the mp4-only room the model
#: sensibly explores, finds no book, and never starts the pass (first e2e
#: run failed exactly there; the model was right and the fixture was wrong).
BOOK_SYSTEM = (
    BASE_SYSTEM
    + "\n\nFiles currently stored in this room:\n"
    + "- book.pdf (application/pdf) — a full-length book, 412 pages.\n"
    + "- notes.md (text/markdown) — reading notes.\n"
)


def book_reply(name: str, args: dict) -> str:
    if name == "list_room_files":
        return "book.pdf (document, 4.1 MB)\nnotes.md (markdown, 2.1 KB)"
    if name == "search_room":
        return "[file: book.pdf]\nChapter 1 — It was the best of times…"
    return room_reply(name, args)


# --------------------------------------------------------------------------- #
# 1. The "Done." regressions
# --------------------------------------------------------------------------- #


async def test_plain_question_small_turn_answers() -> None:
    # Live QA 2026-07-23 (first "Done." regression): a trailing SYSTEM-role
    # progress note silenced the qwen chat template.
    bridge = RecordingBridge(reply=room_reply)
    try:
        out = await run_ask("What are the key points across my files?", bridge=bridge)
    finally:
        bridge.close()
    assert out["final"].strip() and out["final"].strip() != DONE


async def test_production_size_turn_stays_grounded() -> None:
    # Live QA 2026-07-23 (second "Done." regression): a ~21KB composed turn
    # exceeded the daemon's default 4k window; llama-server context-shifted
    # the system prompt away and the model emitted garbage or nothing. The
    # payload-fitted num_ctx must keep the WHOLE turn visible: the answer
    # must be real and must ground itself in BOTH files.
    bridge = RecordingBridge(reply=room_reply)
    try:
        out = await run_ask(
            "Summarize what's in this room",
            bridge=bridge,
            system=PRODUCTION_SYSTEM,
            user_prefix=PRODUCTION_CONTEXT,
        )
    finally:
        bridge.close()
    final = out["final"]
    assert final.strip() and final.strip() != DONE
    assert "Claude Code" in final and ("Skills" in final or "skills" in final)
    # The usage bar must report the window the call actually ran in — a
    # payload this size can never legally run in a 4k window again.
    assert out["last_usage"] is not None
    assert out["last_usage"]["max_context"] >= 8_192


# --------------------------------------------------------------------------- #
# 2. Agent visibility (the ask-plan / ask-agent contract)
# --------------------------------------------------------------------------- #


async def test_plain_question_delegates_to_the_file_agent() -> None:
    # Hub v3: the Main agent must DELEGATE room questions (never answer them
    # from memory). Success = the roster grew to File agent → Main agent and
    # the worker actually touched the room.
    def delegated(out: dict) -> bool:
        plan = out["plan_last"] or []
        return [p["agent"] for p in plan][:1] == ["files.read"] and bool(out["tool_calls"])

    out = await run_ask_sampled(
        "What are the key points across my files?", delegated, reply=room_reply
    )
    assert delegated(out), (out["plan_last"], out["tool_calls"], out["final"][:200])
    assert out["final"].strip() and out["final"].strip() != DONE


async def test_greetings_never_wake_a_worker() -> None:
    # "hi bro" (live QA): the Main agent answers itself — no bridge traffic.
    out = await run_ask_sampled(
        "hi bro",
        lambda o: not o["tool_calls"] and o["final"].strip() not in ("", DONE),
        reply=room_reply,
    )
    assert not out["tool_calls"], out["tool_calls"]
    assert out["final"].strip() and out["final"].strip() != DONE


# --------------------------------------------------------------------------- #
# 3. Compound plans — pending sequential execution with the referent baton
# --------------------------------------------------------------------------- #


def _both_domains_acted(out: dict) -> bool:
    """The model-choice part of the compound outcome: the jobs box actually
    started the pass AND the connector proxy pair actually sent."""
    calls = out["tool_calls"]
    return "start_file_pass" in calls and (
        "run_mcp_tool" in calls or "search_mcp_tools" in calls
    )


async def test_compound_ask_plans_and_executes_both_domains() -> None:
    out = await run_ask_sampled(
        "translate the entire book and then send it to Slack",
        _both_domains_acted,
        reply=book_reply,
        system=BOOK_SYSTEM,
    )
    # The grown roster must include the Jobs agent and end with the Main agent.
    roster = [p["agent"] for p in (out["plan_last"] or [])]
    assert roster and roster[-1] == "chat.answer", roster
    assert "jobs.run" in roster, roster
    assert sum(1 for k in out["kinds"] if k == "final") == 1  # ONE final per ask
    assert out["final"].strip() and out["final"].strip() != DONE
    # Model choice — held to the sampled standard:
    assert _both_domains_acted(out), (out["tool_calls"], out["final"][:200])
    # Sequential pending execution: the pass starts before anything is sent.
    sends = [i for i, n in enumerate(out["tool_calls"]) if n in ("search_mcp_tools", "run_mcp_tool")]
    if sends:
        assert out["tool_calls"].index("start_file_pass") < sends[0]


async def test_hebrew_compound_ask_routes_and_executes() -> None:
    # Hebrew vocabulary opened NO lane before 2026-07-23 — this guards the
    # whole Hebrew path live: manager split on " ואז ", jobs box, connectors.
    out = await run_ask_sampled(
        "סכם את כל הספר ואז שלח את זה בסלאק",
        lambda o: "start_file_pass" in o["tool_calls"],
        reply=book_reply,
        system=BOOK_SYSTEM,
    )
    roster = [p["agent"] for p in (out["plan_last"] or [])]
    assert "jobs.run" in roster, roster
    assert "start_file_pass" in out["tool_calls"], (out["tool_calls"], out["final"][:200])
    assert out["final"].strip() and out["final"].strip() != DONE


# --------------------------------------------------------------------------- #
# 4. Write-verb self-image (the original "he doesn't know he can save" bug)
# --------------------------------------------------------------------------- #


async def test_agent_saves_dictated_content_with_create_file() -> None:
    # The prompt/catalog contradiction (write tools taught but not offered)
    # made the model deny its own abilities. With CORE always offered, an
    # explicit save request must reach create_file/write_file.
    bridge = RecordingBridge(reply=room_reply)
    try:
        out = await run_ask(
            'Save a new note called "Standup" with the content: ship the fix today.',
            bridge=bridge,
        )
    finally:
        bridge.close()
    assert any(name in ("create_file", "write_file") for name in out["tool_calls"])
    assert out["final"].strip() != DONE


async def test_save_that_anaphora_with_history() -> None:
    # "save that as a new file called Summary" with the answer in history.
    # (The host also has a deterministic Rust bypass for the pure form; the
    # sidecar path must STILL do the right thing when reached — the bypass
    # only covers attachment-free pure-save phrasings.)
    bridge = RecordingBridge(reply=room_reply)
    history = [
        {"role": "user", "content": "Question: What are the key points across my files?"},
        {
            "role": "assistant",
            "content": "The key points: keep CLAUDE.md short; build skills, not scaffolds.",
        },
    ]
    try:
        out = await run_ask(
            "save that as a new file called Summary",
            bridge=bridge,
            history=history,
            user_prefix=(
                "(Note: the user's \"that\"/\"this\" refers to earlier content in "
                "this conversation — usually your own previous reply. Save THAT "
                "full text with create_file or write_file now; do not ask the "
                "user to re-provide content that is already above.)\n\n"
            ),
        )
    finally:
        bridge.close()
    assert any(name in ("create_file", "write_file") for name in out["tool_calls"]), (
        out["tool_calls"],
        out["final"][:200],
    )


# --------------------------------------------------------------------------- #
# 5. Tool-grounded room questions
# --------------------------------------------------------------------------- #


async def test_room_summary_uses_the_listing_it_fetched() -> None:
    # The model must call list_room_files (empty context) and ground its
    # answer in the result — both file names came ONLY from the tool.
    bridge = RecordingBridge(reply=room_reply)
    try:
        out = await run_ask("Summarize what's in this room", bridge=bridge)
    finally:
        bridge.close()
    assert "list_room_files" in out["tool_calls"] or "search_room" in out["tool_calls"]
    assert out["final"].strip() and out["final"].strip() != DONE
