"""Toolbox constants shared by the declarative agent registry."""

from __future__ import annotations

from .routing import JOB_TOOL_NAMES, SKILL_TOOL_NAMES, WRITE_TOOL_NAMES

CORE_TOOLS: tuple[str, ...] = (
    "list_room_files",
    "search_room",
    "open_file",
    "annotate_file",
    "mark_image",
    "list_memories",
    # 2026-07-24: the agent could save a memory but never correct or drop one,
    # so a wrong note it wrote was permanent. Both match on the note's text.
    "update_memory",
    "delete_memory",
    # 2026-07-24: every agent may own SKILLS — procedures for its domain, held
    # outside the prompt and loaded only when one applies. These two verbs are
    # how it discovers and loads them, so they belong to CORE rather than to a
    # box: a box is capped at MAX_BOX_TOOLS and jobs.workflows is already full,
    # and skills are no longer one domain's business. `list_skills` answers are
    # scoped to the calling agent (graph.execute_tools injects its id).
    "list_skills",
    "read_skill",
    *WRITE_TOOL_NAMES,  # create/edit/edit_files/write/set_cells/rename/move/add_memory
)

#: JOB_TOOL_NAMES split into the two jobs boxes (whole-file pass vs workflows).
_JOBS_RUN: tuple[str, ...] = ("start_file_pass", "job_status")
_JOBS_WORKFLOWS: tuple[str, ...] = tuple(n for n in JOB_TOOL_NAMES if n not in _JOBS_RUN)
#: SKILL_TOOL_NAMES split into use vs author.
_SKILLS_USE: tuple[str, ...] = ("list_skills", "read_skill", "read_skill_resource", "run_skill_script")
_SKILLS_AUTHOR: tuple[str, ...] = tuple(n for n in SKILL_TOOL_NAMES if n not in _SKILLS_USE)

# --------------------------------------------------------------------------- #
# the tree
# --------------------------------------------------------------------------- #
