"""Request/settings models for the sidecar HTTP API (SPEC §5)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .messages import Message
from .tts import DEFAULT_PITCH, DEFAULT_RATE, DEFAULT_VOICE

#: LangGraph requires a finite recursion ceiling. This is deliberately far above
#: a real run: all chat lanes share it, while no-calls, duplicate detection,
#: forced synthesis, and Stop remain the normal termination mechanisms.
AGENT_ROUND_BACKSTOP: int = 10_000

#: The RUNAWAY NET for one ask — the Main agent's own rounds plus every round of
#: every specialist it delegates to.
#:
#: :data:`AGENT_ROUND_BACKSTOP` bounds a single loop, and each delegated child
#: starts a FRESH loop at round 0, so the per-loop ceiling multiplies with the
#: tree instead of bounding it. Something turn-wide is therefore needed.
#:
#: It is NOT the termination policy — :data:`NO_PROGRESS_ROUNDS` is. This was 64,
#: sized off "even six specialists at eight rounds each is 52", which quietly
#: made a COUNT the thing that ends a turn: a genuinely large errand (split a
#: long document, work through forty files) is not converging any less for
#: needing a hundred rounds, but at 64 every remaining loop was disarmed
#: mid-task and had to answer from whatever it had. Raised far above any real
#: errand so that tripping it means a loop is spinning, not working.
#:
#: Kept at all — rather than deleted for the progress gate — because progress
#: alone cannot bound the hub. A supervisor can keep delegating with a freshly
#: worded instruction every round; each child returns a differently worded
#: report, so nothing ever looks like a repeat while no work advances. That is
#: exactly the measured 2026-07-28 runaway (32 rounds, 890 s, 16 delegations,
#: ``search_room`` called 14 times, and an answer of "not included in this
#: room's content"). Two different failures need two different nets.
#:
#: Tripping it does not abort: every remaining round is served TOOL-LESS, so each
#: loop unwinds into a text answer from what it already has.
TURN_ROUND_BACKSTOP: int = 400

#: How many CONSECUTIVE rounds may produce nothing new before a loop is made
#: tool-less. THIS is the termination policy: a loop stops because it stopped
#: getting anywhere, not because a counter ran out.
#:
#: It replaced a one-strike rule — a single all-duplicate round forced synthesis
#: immediately. That fired on legitimate work: re-reading a file just written to
#: confirm the write, polling a job, retrying a call that failed for a transient
#: reason. One wasted round is a model correcting itself; three in a row is a
#: model stuck.
NO_PROGRESS_ROUNDS: int = 3

#: How many delegated children a CLOUD room may run at once
#: (``graph.Deps.worker_parallel``).
#:
#: A LOCAL room pins 1: one resident model means concurrent children are
#: contention, not throughput. A cloud room has no resident model, so it was
#: given no bound at all — and a plan with twenty tasks then opened twenty PAID
#: conversations in the same instant, which is a rate-limit wall and a cost
#: spike rather than twenty-way speed. This is the middle: real fan-out, with a
#: ceiling small enough that no plan can turn into a burst the provider refuses.
#: Nothing is dropped — a child past the ceiling waits for a slot.
CLOUD_WORKER_PARALLEL: int = 4

#: models.rs:72 — the chat model stays warm across the conversation.
KEEP_ALIVE_WARM: str = "30m"

#: models.rs:74 — the short warmth for one-shot shaping calls (feedback drafting).
#: The model need not linger after a single, rare structured turn.
KEEP_ALIVE_SHORT: str = "2m"

class McpConfig(BaseModel):
    """The per-run room bridge: loopback URL + a fresh bearer token."""

    model_config = ConfigDict(extra="ignore")

    url: str
    token: str


class ProviderConfig(BaseModel):
    """One call's API-provider credentials, supplied from native Keychain."""

    model_config = ConfigDict(extra="ignore")

    id: str
    api_key: str
    base_url: str
    model: str
    context_window: int | None = None
    supports_tools: bool = True


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
    #: Whole-ask runaway net across the delegation tree
    #: (:data:`TURN_ROUND_BACKSTOP` when absent). 0 or negative disables it.
    turn_max_rounds: int | None = None
    #: Consecutive no-progress rounds a loop may spend before it is made
    #: tool-less (:data:`NO_PROGRESS_ROUNDS` when absent). 0 or negative
    #: disables the progress gate entirely.
    turn_max_stalls: int | None = None
    run_id: str = ""
    #: PRIV-1: the room's resolved privacy policy (:func:`.privacy.policy_from_payload`
    #: shape). Engages only when ``model`` is non-local; None/absent = door open.
    privacy: dict[str, Any] | None = None
    provider: ProviderConfig | None = None
    #: Display-only context window for the token bar, resolved by the host
    #: (live from the Codex catalog for ``codex-cli``). NOT a cap — nothing in
    #: the sidecar truncates or refuses on its account; a cloud CLI owns its
    #: own window. Absent for engines that report a window themselves.
    max_context: int | None = None

    #: Which advisor connectors the room has installed. Only the emptiness of
    #: this list is read (``graph.py`` gates the ``consult_advisor`` tool on it).
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

    def resolved_max_rounds(self, *_lanes: bool) -> int:
        """Return the shared high runaway backstop for every agent lane.

        Takes no input: every lane gets the same ceiling, and only an explicit
        ``max_rounds`` on the request narrows it. The routing flags older call
        sites still hand over positionally are accepted and dropped — nothing
        here has read them since the per-lane budgets were removed.
        """
        return (
            self.max_rounds
            if self.max_rounds and self.max_rounds > 0
            else AGENT_ROUND_BACKSTOP
        )

    def resolved_turn_rounds(self) -> int | None:
        """The whole-ask runaway net, or None if the caller disabled it."""
        if self.turn_max_rounds is None:
            return TURN_ROUND_BACKSTOP
        return self.turn_max_rounds if self.turn_max_rounds > 0 else None

    def resolved_turn_stalls(self) -> int | None:
        """Consecutive no-progress rounds allowed, or None if the gate is off."""
        if self.turn_max_stalls is None:
            return NO_PROGRESS_ROUNDS
        return self.turn_max_stalls if self.turn_max_stalls > 0 else None


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
    provider: ProviderConfig | None = None


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
    defaults come from :mod:`.tts`, which owns the product voice spec — they
    are NOT restated here, because this body is the one the app actually goes
    through and a second copy would silently win over the named one. See
    :mod:`.tts` for the privacy doctrine.
    """

    model_config = ConfigDict(extra="ignore")

    text: str
    voice: str = DEFAULT_VOICE
    rate: str = DEFAULT_RATE
    pitch: str = DEFAULT_PITCH


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
    provider: ProviderConfig | None = None


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
    provider: ProviderConfig | None = None


class VisionLocateRequest(BaseModel):
    """Body of ``POST /vision_locate`` (MIGRATION Phase 2 — vision.rs).

    Rust decrypts the image and picks the local vision model, then sends the
    ORIGINAL image bytes (base64) here; the sidecar does prepare/prompt/parse. The
    knobs mirror what ``locate_in_image`` handed ``chat_structured``: temperature
    pinned to 0.0 for stable boxes, and a ``keep_alive`` (HLT-5) value the
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
    #: Optional explicit engine override. Normal app calls omit this so the
    #: selected model/server owns its context window.
    num_ctx: int | None = None
    keep_alive: str | None = None
    #: PRIV-1: room privacy policy payload (see :class:`RunRequest`).
    privacy: dict[str, Any] | None = None
    provider: ProviderConfig | None = None


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
    provider: ProviderConfig | None = None


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
    provider: ProviderConfig | None = None


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


class WebSearchRequest(BaseModel):
    """Body of ``POST /web_search`` — the room's ONE web search provider.

    No model, no engine choice: Settings → Online features is a bare on/off
    switch, Rust checks it before calling, and :mod:`.websearch` fuses its own
    fixed engine set. The query is the only thing that crosses the network.

    There is deliberately no ``resolve_dates`` knob: filling in missing dates
    means fetching each RESULT url from Python, which would bypass the Rust SSRF
    guard that every other outbound fetch in this app goes through.
    """

    model_config = ConfigDict(extra="ignore")

    query: str
    limit: int = Field(default=12, ge=1, le=50)


class HealthResponse(BaseModel):
    ok: bool = True
    version: str


__all__ = [
    "AGENT_ROUND_BACKSTOP",
    "TURN_ROUND_BACKSTOP",
    "NO_PROGRESS_ROUNDS",
    "CLOUD_WORKER_PARALLEL",
    "KEEP_ALIVE_WARM",
    "KEEP_ALIVE_SHORT",
    "McpConfig",
    "ProviderConfig",
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
    "WebSearchRequest",
]
