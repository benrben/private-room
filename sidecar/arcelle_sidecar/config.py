"""Request/settings models for the sidecar HTTP API (SPEC §5)."""

from __future__ import annotations

import os
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .messages import Message

#: commands.rs:104 — a runaway backstop, not a budget. The loop self-terminates
#: via duplicate detection + forced synthesis + Stop, so this sits far above any
#: real run.
MAX_TOOL_ROUNDS: int = 1_000

#: The plain no-tool chat path needs only a couple of rounds (agent.rs:1337).
PLAIN_MAX_ROUNDS: int = 4

#: models.rs:72 — the chat model stays warm across the conversation.
KEEP_ALIVE_WARM: str = "30m"

#: models.rs:74 — the short warmth for one-shot shaping calls (feedback drafting).
#: The model need not linger after a single, rare structured turn.
KEEP_ALIVE_SHORT: str = "2m"

#: ollama.rs:224-231 ``num_ctx_for(has_tools=true, Chat)`` — the working-memory
#: window handed to Ollama. RAM-adaptive: a 16 GB Mac must not OOM, but a 32 GB+
#: Mac should get the fuller window rather than half of it. The sidecar always
#: runs the tool tier (the catalog is `Some` even on the tool-less final round,
#: CHG-32), so it never drops to the smaller no-tools window mid-answer.
NUM_CTX_LOW: int = 12288
NUM_CTX_HIGH: int = 24576

#: ollama.rs:224-231 ``num_ctx_for(has_tools=false, Chat)`` — the SMALLER no-tools
#: Chat window. The chat_commands one-shot calls (``ask_structured`` / ``ask_quiet``
#: in chat_commands.rs) allocate this tier, not the tools-tier window above.
NUM_CTX_NOTOOLS_LOW: int = 8192
NUM_CTX_NOTOOLS_HIGH: int = 16384

#: ollama.rs:220 — the RAM threshold above which the fuller window is safe.
_HIGH_RAM_BYTES: int = 32 * 1024 * 1024 * 1024

_num_ctx_cache: int | None = None
_num_ctx_notools_cache: int | None = None


def _total_ram_bytes() -> int:
    """Total physical RAM in bytes, or 0 if it can't be determined.

    ``os.sysconf`` works on macOS and Linux (verified on macOS: SC_PHYS_PAGES *
    SC_PAGE_SIZE). No subprocess, no third-party dependency.
    """
    try:
        return os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    except (ValueError, OSError, AttributeError):  # pragma: no cover - exotic OS
        return 0


def num_ctx_for_chat() -> int:
    """The chat model's ``num_ctx``, sized to RAM like ollama.rs ``num_ctx_for``.

    24576 on a 32 GB+ Mac, 12288 below (the Rust's Chat+tools tier). Computed once
    and cached — RAM does not change under us, and the Rust caches it in a
    ``OnceLock`` too. Unknown RAM (0) falls to the safe low window.
    """
    global _num_ctx_cache
    if _num_ctx_cache is None:
        _num_ctx_cache = NUM_CTX_HIGH if _total_ram_bytes() >= _HIGH_RAM_BYTES else NUM_CTX_LOW
    return _num_ctx_cache


def num_ctx_chat_notools() -> int:
    """The no-tools Chat ``num_ctx`` (ollama.rs ``num_ctx_for(false, Chat)``).

    16384 on a 32 GB+ Mac, 8192 below — the window the chat_commands one-shot
    ``ask_structured`` / ``ask_quiet`` calls (``StructuredOpts`` default tier =
    Chat, no tools) actually allocated. Cached like its tools-tier sibling.
    """
    global _num_ctx_notools_cache
    if _num_ctx_notools_cache is None:
        _num_ctx_notools_cache = (
            NUM_CTX_NOTOOLS_HIGH if _total_ram_bytes() >= _HIGH_RAM_BYTES else NUM_CTX_NOTOOLS_LOW
        )
    return _num_ctx_notools_cache


class McpConfig(BaseModel):
    """The per-run room bridge: loopback URL + a fresh bearer token."""

    model_config = ConfigDict(extra="ignore")

    url: str
    token: str


class Routing(BaseModel):
    """Routing decisions the Rust host already computed.

    The sidecar implements the same routers locally (see :mod:`.routing`) and the
    two must agree; the host's answer wins so the engines can never drift.
    """

    model_config = ConfigDict(extra="ignore")

    write: bool | None = None
    ui: bool | None = None
    jobs: bool | None = None
    skills: bool | None = None
    connectors: bool | None = None


class RunRequest(BaseModel):
    """Body of ``POST /run``."""

    model_config = ConfigDict(extra="ignore")

    model: str
    question: str
    messages: list[Message] = Field(default_factory=list)
    temperature: float | None = None
    ollama_base_url: str = "http://127.0.0.1:11434"
    mcp: McpConfig | None = None
    routing: Routing | None = None
    web_enabled: bool = False
    max_rounds: int | None = None
    run_id: str = ""
    #: PRIV-1: the room's resolved privacy policy (:func:`.privacy.policy_from_payload`
    #: shape). Engages only when ``model`` is non-local; None/absent = door open.
    privacy: dict[str, Any] | None = None

    #: How many connected (third-party) MCP tools the host routed this turn, and
    #: which cloud advisors are available. Both only feed the max_rounds choice
    #: (agent.rs:1337): a turn with any real capability gets the long backstop,
    #: a plain chat turn gets 4 rounds.
    mcp_routes: int = 0
    advisors: list[str] = Field(default_factory=list)

    def resolved_routing(self) -> tuple[bool, bool, bool, bool, bool]:
        """(write, ui, jobs, skills, connectors) — host decision else router."""
        from .routing import (
            wants_job_tools,
            wants_mcp_management_tools,
            wants_skill_tools,
            wants_ui_tools,
            wants_write_tools,
        )

        r = self.routing
        write = r.write if r and r.write is not None else wants_write_tools(self.question)
        ui = r.ui if r and r.ui is not None else wants_ui_tools(self.question)
        jobs = r.jobs if r and r.jobs is not None else wants_job_tools(self.question)
        skills = r.skills if r and r.skills is not None else wants_skill_tools(self.question)
        connectors = (
            r.connectors
            if r and r.connectors is not None
            else wants_mcp_management_tools(self.question)
        )
        return write, ui, jobs, skills, connectors

    def resolved_max_rounds(
        self, ui: bool, jobs: bool, skills: bool = False, connectors: bool = False
    ) -> int:
        """agent.rs:1337 — 4 rounds for a plain turn, the backstop otherwise."""
        plain = (
            self.mcp_routes == 0
            and not self.web_enabled
            and not self.advisors
            and not ui
            and not jobs
            and not skills
            and not connectors
        )
        if plain:
            return PLAIN_MAX_ROUNDS
        return self.max_rounds if self.max_rounds and self.max_rounds > 0 else MAX_TOOL_ROUNDS


class CancelRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    run_id: str


# --- LLM gateway request bodies (MIGRATION Phase 1) -------------------------
#
# The non-agent AI calls Rust now routes through the sidecar. Each carries the
# Ollama ``base_url`` the sidecar should use (ollama::resolved_base_url() — the
# runtime "closet supercomputer" override lives on the Rust side, so the sidecar
# is told it per request rather than holding its own copy).


class EmbedRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    model: str
    texts: list[str] = Field(default_factory=list)
    base_url: str = "http://127.0.0.1:11434"
    keep_alive: str | None = None
    #: PRIV-1: room privacy policy payload (see :class:`RunRequest`).
    privacy: dict[str, Any] | None = None


class GenerateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    model: str
    messages: list[Message] = Field(default_factory=list)
    base_url: str = "http://127.0.0.1:11434"
    temperature: float | None = None
    num_ctx: int | None = None
    keep_alive: str | None = None
    #: Ollama's structured-output grammar — a JSON schema. When set, the model's
    #: output is constrained to it (grammar token masking).
    format: dict[str, Any] | None = None
    #: Base64 PNGs attached to the last user turn (vision).
    images: list[str] | None = None
    #: PRIV-1: room privacy policy payload (see :class:`RunRequest`).
    privacy: dict[str, Any] | None = None


class ModelsRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    base_url: str = "http://127.0.0.1:11434"


class WarmRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    model: str
    base_url: str = "http://127.0.0.1:11434"
    keep_alive: str = "30m"


class PullRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    model: str
    base_url: str = "http://127.0.0.1:11434"


class CapabilitiesRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    model: str
    base_url: str = "http://127.0.0.1:11434"


class DeleteRequest(BaseModel):
    """Body of ``POST /delete`` — ollama.rs ``delete_model`` (``/api/delete``)."""

    model_config = ConfigDict(extra="ignore")

    model: str
    base_url: str = "http://127.0.0.1:11434"


# --- Phase-2 feature request bodies (feature logic → Python) ----------------
#
# Rust gathers the DB text (room name + file names, or the raw feedback words) and
# posts it here; the PROMPT, schema, temperature, keep_alive and parsing all live
# in :mod:`.features`. The model is still resolved on the Rust side (it knows the
# user's model preference) and named per request, same as the gateway bodies.


class TtsRequest(BaseModel):
    """Body of ``POST /tts`` — the neural spoken-voice synthesis seam.

    Only the sentence text (plus prosody knobs) reaches the service; the
    defaults are the product voice spec (Andrew multilingual, +22% rate,
    -2 Hz pitch). See :mod:`.tts` for the privacy doctrine.
    """

    model_config = ConfigDict(extra="ignore")

    text: str
    voice: str = "en-US-AndrewMultilingualNeural"
    rate: str = "+22%"
    pitch: str = "-2Hz"


class LabelRequest(BaseModel):
    """Body of ``POST /label`` — front_page.rs ``front_page_suggestions``.

    ``room_name`` + up to 30 ``files`` are all the model sees. (There is no room-
    GRAPH AI labeling to port: graph.rs ``build_room_graph`` is model-free by
    design — it links files by embedding/keyword overlap with no model call.)
    """

    model_config = ConfigDict(extra="ignore")

    model: str
    base_url: str = "http://127.0.0.1:11434"
    room_name: str = ""
    files: list[str] = Field(default_factory=list)
    #: PRIV-1: room privacy policy payload (see :class:`RunRequest`).
    privacy: dict[str, Any] | None = None


class FeedbackDraftRequest(BaseModel):
    """Body of ``POST /feedback_draft`` — feedback.rs ``feedback_draft``.

    ``text`` is the user's raw feedback (already trimmed and checked non-empty on
    the Rust side, which errors before resolving a model when it's blank)."""

    model_config = ConfigDict(extra="ignore")

    model: str
    base_url: str = "http://127.0.0.1:11434"
    text: str = ""
    #: PRIV-1: room privacy policy payload (see :class:`RunRequest`).
    privacy: dict[str, Any] | None = None


class VisionLocateRequest(BaseModel):
    """Body of ``POST /vision_locate`` (MIGRATION Phase 2 — vision.rs).

    Rust decrypts the image and picks the local vision model, then sends the
    ORIGINAL image bytes (base64) here; the sidecar does prepare/prompt/parse. The
    knobs mirror what ``locate_in_image`` handed ``chat_structured``: temperature
    pinned to 0.0 for stable boxes, and a RAM-adaptive ``keep_alive`` (HLT-5) the
    Rust side computes so a low-RAM Mac releases the multi-GB vision model quickly.
    """

    model_config = ConfigDict(extra="ignore")

    model: str
    #: Base64 of the ORIGINAL image file bytes (any PNG/JPEG/WebP). The sidecar
    #: transcodes + stretches it to the 1000×1000 grounding canvas itself.
    image_b64: str
    query: str
    base_url: str = "http://127.0.0.1:11434"
    temperature: float | None = 0.0
    #: For byte-parity Rust should pass the ORIGINAL window: chat_structured ran
    #: this with ``StructuredOpts::default()`` -> ``CtxTier::Job``, so
    #: ``num_ctx_for(false, Job)`` = 65536 (low-RAM) / 131072 (32 GB+). That large
    #: window matters — a 1000×1000 image is many vision tokens and the smaller
    #: chat window could truncate them. Omitted -> the sidecar's RAM-adaptive chat
    #: window (a fallback, NOT the original size).
    num_ctx: int | None = None
    keep_alive: str | None = None
    #: PRIV-1: room privacy policy payload (see :class:`RunRequest`).
    privacy: dict[str, Any] | None = None


class KnowledgeExtractRequest(BaseModel):
    """Body of ``POST /knowledge_extract`` (MIGRATION Phase 2 — knowledge.rs).

    Two modes, one endpoint (the file's two structured prompts):

    * ``mode="fields"`` (cmd_extract) — pull each of ``fields`` out of ``document``.
      Rust loops its @-pinned files, calls this once per file with the file text
      (clamped to 6000 chars on the Rust side, same as before), and builds the CSV
      row from the returned ``values``.
    * ``mode="list"`` (cmd_add_file "for each") — enumerate ``subject`` as short
      names from ``conversation`` (the chat history). Rust then loops the returned
      ``items`` to write one file each.

    Temperature is 0.0 for both (deterministic extraction), matching the Rust.
    """

    model_config = ConfigDict(extra="ignore")

    model: str
    base_url: str = "http://127.0.0.1:11434"
    mode: Literal["fields", "list"] = "fields"
    #: mode "fields": the requested field names, in order (row-column order).
    fields: list[str] = Field(default_factory=list)
    #: mode "fields": the (already clamped) document text to extract from.
    document: str = ""
    #: mode "list": the thing to enumerate (e.g. "tickers", "people").
    subject: str = ""
    #: mode "list": the conversation text to enumerate from.
    conversation: str = ""
    temperature: float = 0.0
    keep_alive: str = KEEP_ALIVE_WARM
    #: PRIV-1: room privacy policy payload (see :class:`RunRequest`).
    privacy: dict[str, Any] | None = None


class GenerateDocRequest(BaseModel):
    """Body of ``POST /generate_doc`` (MIGRATION Phase 2 — knowledge.rs cmd_add_file).

    One DOC_SYS document body. ``mode``:

    * ``"single"`` — a document about ``topic``, prefixed by ``context`` (Rust's
      ``refs_context`` for any @-pinned files, may be empty).
    * ``"each"`` — a note about ``item``, grounded in the conversation ``history``.

    Returns the raw HTML body; Rust checks emptiness and wraps it in the styled
    page (``html_titled_doc``), keeps the file naming / saving / events."""

    model_config = ConfigDict(extra="ignore")

    model: str
    base_url: str = "http://127.0.0.1:11434"
    mode: Literal["single", "each"] = "single"
    #: mode "single".
    topic: str = ""
    context: str = ""
    #: mode "each".
    item: str = ""
    history: str = ""
    temperature: float = 0.4
    keep_alive: str = KEEP_ALIVE_WARM
    #: PRIV-1: room privacy policy payload (see :class:`RunRequest`).
    privacy: dict[str, Any] | None = None


class PrivacyScanRequest(BaseModel):
    """Body of ``POST /privacy_scan`` (PRIV-2 — the import-time scanner and the
    chat live guard). ``model`` MUST be local — the route rejects a non-local
    model rather than scan private text through the very door being guarded.

    ``known`` carries the reals already in the room's entity map so the reply
    holds only NEW findings; ``concepts`` are the user's own topic rules.
    """

    model_config = ConfigDict(extra="ignore")

    model: str
    base_url: str = "http://127.0.0.1:11434"
    text: str = ""
    concepts: list[str] = Field(default_factory=list)
    known: list[str] = Field(default_factory=list)


class HealthResponse(BaseModel):
    ok: bool = True
    version: str


__all__ = [
    "MAX_TOOL_ROUNDS",
    "PLAIN_MAX_ROUNDS",
    "KEEP_ALIVE_WARM",
    "KEEP_ALIVE_SHORT",
    "NUM_CTX_LOW",
    "NUM_CTX_HIGH",
    "NUM_CTX_NOTOOLS_LOW",
    "NUM_CTX_NOTOOLS_HIGH",
    "num_ctx_for_chat",
    "num_ctx_chat_notools",
    "McpConfig",
    "Routing",
    "RunRequest",
    "CancelRequest",
    "HealthResponse",
    "EmbedRequest",
    "GenerateRequest",
    "ModelsRequest",
    "WarmRequest",
    "PullRequest",
    "CapabilitiesRequest",
    "DeleteRequest",
    "LabelRequest",
    "TtsRequest",
    "FeedbackDraftRequest",
    "VisionLocateRequest",
    "KnowledgeExtractRequest",
    "GenerateDocRequest",
    "PrivacyScanRequest",
]
