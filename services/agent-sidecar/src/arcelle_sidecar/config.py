"""Request/settings models for the sidecar HTTP API (SPEC §5)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .config_basic_requests import (
    AgentSupportRequest,
    CancelRequest,
    CapabilitiesRequest,
    DeleteRequest,
    HealthResponse,
    ModelsRequest,
    OcrRequest as OcrRequest,
    PodcastTtsRequest as PodcastTtsRequest,
    PodcastTurnRequest as PodcastTurnRequest,
    PullRequest,
    QuickLookRequest as QuickLookRequest,
    SpecialistsRequest,
    TtsRequest,
    WarmRequest,
    WebSearchRequest,
)
from .config_limits import (
    AGENT_ROUND_BACKSTOP,
    CLOUD_WORKER_PARALLEL,
    KEEP_ALIVE_SHORT,
    KEEP_ALIVE_WARM,
    NO_PROGRESS_ROUNDS,
    TURN_ROUND_BACKSTOP,
)
from .config_routing import (
    Routing,
    resolved_routing_lane as _resolved_routing_lane,
    routing_overrides as _routing_overrides,
)
from .messages import Message

class McpConfig(BaseModel):
    """The per-run room bridge: loopback URL + a fresh bearer token."""

    model_config = ConfigDict(extra="ignore")

    url: str
    token: str
    #: A write-capable workspace bridge is a run-scoped capability, not a
    #: property inferred from the user's words. Electron sets these fields only
    #: after the encrypted rollback baseline has committed.
    workspace_write: bool = False
    baseline_run_id: str = ""


class ProviderConfig(BaseModel):
    """One call's API-provider credentials, supplied from native Keychain."""

    model_config = ConfigDict(extra="ignore")

    id: str
    api_key: str
    base_url: str
    model: str
    context_window: int | None = None
    supports_tools: bool = True
    #: The provider catalog's per-model vision bit. ``None`` means an older
    #: host did not send the fact, so the adapter preserves compatibility and
    #: lets the provider decide. An explicit ``False`` is authoritative: image
    #: tools are not routed and image-bearing payloads fail before network I/O.
    supports_vision: bool | None = None


class RunRequest(BaseModel):
    """Body of ``POST /run``."""

    model_config = ConfigDict(extra="ignore")

    model: str
    question: str
    #: Provider-neutral agent runtime. Classic remains the compatibility default;
    #: the host enables Deep Harness only after its capability probe passes.
    harness: Literal["classic", "deep"] = "classic"
    messages: list[Message] = Field(default_factory=list)
    temperature: float | None = None
    ollama_base_url: str = "http://127.0.0.1:11434"
    mcp: McpConfig | None = None
    routing: Routing | None = None
    web_enabled: bool = False
    #: Host-authoritative hard boundary. ``none`` means an empty catalog is
    #: intentional: do not list, plan, delegate, or call any tool.
    tool_policy: Literal["auto", "none"] = "auto"
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
    #: Per-model image-input capability for Ollama/local relay models. API
    #: providers carry the same fact inside ``provider``. Absent is compatible
    #: with older hosts; explicit false is a fail-closed routing boundary.
    supports_vision: bool | None = None
    #: Display-only context window for the token bar, resolved by the host
    #: (live from the Codex catalog for ``codex-cli``). NOT a cap — nothing in
    #: the sidecar truncates or refuses on its account; a cloud CLI owns its
    #: own window. Absent for engines that report a window themselves.
    max_context: int | None = None

    #: Which advisor connectors the room has installed. Only the emptiness of
    #: this list is read (``graph.py`` gates the ``consult_advisor`` tool on it).
    advisors: list[str] = Field(default_factory=list)

    def image_input_available(self) -> bool:
        """Whether this run may dispatch tools whose result is raw pixels.

        This combines transport truth with the host's live per-model catalog.
        Antigravity's print-mode adapter has no image argument at all, so it is
        always false even if a stale caller claims otherwise. Unknown remains
        allowed solely for backward compatibility with hosts predating the
        capability field; once a host sends false it is authoritative.
        """
        # Split at the first colon without spelling the IPv6 wildcard token;
        # the package-wide bind audit deliberately rejects that literal in
        # every source file. This handles both ``engine::model`` and Ollama's
        # ordinary ``model:tag`` shape.
        engine = self.model.partition(":")[0]
        if engine == "antigravity-cli":
            return False
        if self.provider is not None:
            return self.provider.supports_vision is not False
        return self.supports_vision is not False

    def resolved_tool_policy(self) -> Literal["auto", "none"]:
        """The host boundary plus a narrow fallback for explicit prohibitions.

        ``tool_policy`` remains authoritative.  The fallback covers headless
        and older hosts that pass the user's literal "do not use tools" but
        have not translated it into policy yet; treating that sentence as mere
        prompt text caused unrelated room sources to be opened and attached.
        It is intentionally not a broad intent classifier.
        """
        if self.tool_policy == "none":
            return "none"
        q = " ".join(self.question.casefold().replace("’", "'").split())
        forbidden = (
            "do not use tools",
            "do not use any tools",
            "don't use tools",
            "don't use any tools",
            "without using tools",
            "no tools or sources",
        )
        return "none" if any(phrase in q for phrase in forbidden) else "auto"

    def cloud_privacy_restricted(self) -> bool:
        """Whether this run must expose only inspect-safe room tools."""
        from .privacy import is_nonlocal_model

        payload = self.privacy or {}
        return bool(
            payload.get("active", False)
            and (is_nonlocal_model(self.model) or payload.get("relayed", False))
        )

    def resolved_write(self) -> bool:
        """Just the write lane — host decision else router.

        The ONE lane the agent run reads. Asking :meth:`resolved_routing` for it
        and subscripting ``[0]`` still scanned the question four more times for
        answers that went straight into the bin, which is the waste this exists
        to remove; the full tuple stays for the callers that really want all
        five (the Rust-vs-sidecar agreement checks).
        """
        from .routing import wants_write_tools

        r = self.routing
        if r and r.write is not None:
            return r.write
        return wants_write_tools(self.question)

    def deep_workspace_write_authorized(self) -> bool:
        """True only for a Deep Harness bridge protected by this run's baseline."""
        return bool(
            self.resolved_write()
            and self.run_id
            and self.mcp is not None
            and self.mcp.workspace_write
            and self.mcp.baseline_run_id == self.run_id
        )

    def resolved_routing(self) -> tuple[bool, bool, bool, bool, bool]:
        """(write, ui, jobs, skills, connectors) — host decision else router."""
        from .routing import (
            wants_job_tools,
            wants_mcp_management_tools,
            wants_skill_tools,
            wants_ui_tools,
            wants_write_tools,
        )

        write, ui, jobs, skills, connectors = _routing_overrides(self.routing)
        return (
            _resolved_routing_lane(write, self.question, wants_write_tools),
            _resolved_routing_lane(ui, self.question, wants_ui_tools),
            _resolved_routing_lane(jobs, self.question, wants_job_tools),
            _resolved_routing_lane(skills, self.question, wants_skill_tools),
            _resolved_routing_lane(
                connectors, self.question, wants_mcp_management_tools
            ),
        )

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
    provider: ProviderConfig | None = None


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


# --- Phase-2 feature request bodies (feature logic → Python) ----------------
#
# Rust gathers the DB text (room name + file names, or the raw feedback words) and
# posts it here; the PROMPT, schema, temperature, keep_alive and parsing all live
# in :mod:`.features`. The model is still resolved on the Rust side (it knows the
# user's model preference) and named per request, same as the gateway bodies.


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


class ImageGenerateRequest(BaseModel):
    """Body of ``POST /image_generate`` — the Create page's generation seam.

    ``model`` is the composite ``"openrouter::vendor/slug"``, which is what
    makes the host attach ``privacy`` and ``provider`` at all: ``sidecar_json``
    only injects them for a body that names a model. A generation body without
    one would be the un-modelled outbound seam that let TTS slip the door (see
    ``speech_cmds.rs``), so the field is required rather than defaulted.

    ``reference_b64`` are optional source pictures (PNG, base64). They are
    REFUSED rather than stripped when the door is on — see :mod:`.imagegen`.
    """

    model_config = ConfigDict(extra="ignore")

    model: str
    prompt: str = ""
    #: ``"image"`` or ``"video"`` — what the caller asked for, so a model that
    #: answers with the wrong medium is caught rather than saved as a broken file.
    kind: str = "image"
    reference_b64: list[str] = Field(default_factory=list)
    #: MIME per entry of ``reference_b64``, positionally. Short lists are padded
    #: with PNG rather than rejected: an absent type is a caller that did not
    #: know, and PNG is what every picture this room generates already is.
    reference_mime: list[str] = Field(default_factory=list)
    #: The user saw these specific pictures and pressed a button saying they
    #: would be sent. Only this opens the door — never a bare setting. See
    #: :func:`videogen.guard` for why consent has to name the files.
    references_ack: bool = False
    #: Frame shape, e.g. ``"16:9"``. Declared here rather than left to
    #: ``extra="ignore"``: the host has been sending this field since the
    #: Create page shipped and Pydantic was dropping it on the floor, so every
    #: picture came back in the model's default shape however it was asked for.
    #: An undeclared field on an ``extra="ignore"`` model is not a no-op the
    #: caller can see — it is a control that silently does nothing.
    aspect_ratio: str = ""
    #: Output size, e.g. ``"1K"`` / ``"2K"``. Only ever a value the model's own
    #: ``/images/models`` entry lists, so an invented size never reaches a
    #: billable call.
    resolution: str = ""
    #: PRIV-1: room privacy policy payload (see :class:`RunRequest`).
    privacy: dict[str, Any] | None = None
    provider: ProviderConfig | None = None


class VideoFrame(BaseModel):
    """One picture pinned to an end of the clip.

    ``frame_type`` is what separates this from a reference: a frame IS the
    first (or last) image of the video, so the model animates out of it,
    while a reference only guides how things look.
    """

    model_config = ConfigDict(extra="ignore")

    b64: str
    mime: str = "image/png"
    frame_type: str = "first_frame"


class VideoReference(BaseModel):
    """A picture that guides the look — a hero, a place — but is not a frame."""

    model_config = ConfigDict(extra="ignore")

    b64: str
    mime: str = "image/png"


class VideoStartRequest(BaseModel):
    """Body of ``POST /video_start`` — submit one clip, do not wait for it.

    ``model`` is the composite ``"openrouter::vendor/slug"`` for the same
    reason :class:`ImageGenerateRequest` requires it: ``sidecar_json`` attaches
    ``privacy`` and ``provider`` only to a body that names a model, so a body
    without one would be an outbound seam the door never sees.
    """

    model_config = ConfigDict(extra="ignore")

    model: str
    prompt: str = ""
    #: Length in seconds. The host sends only a value the model's own catalog
    #: entry lists, so an illegal duration never reaches a billable call.
    seconds: int | None = None
    resolution: str = ""
    aspect_ratio: str = ""
    frames: list[VideoFrame] = Field(default_factory=list)
    references: list[VideoReference] = Field(default_factory=list)
    references_ack: bool = False
    #: Tri-state on purpose: ``None`` means "whatever the model does by
    #: default", which is not the same as asking for silence.
    generate_audio: bool | None = None
    privacy: dict[str, Any] | None = None
    provider: ProviderConfig | None = None


class VideoJobRequest(BaseModel):
    """Body of ``POST /video_status`` and ``POST /video_fetch``.

    ``model`` carries no information the provider needs — the job id is the
    whole address — but it must be here anyway, because it is the field the
    host keys provider-credential injection on.
    """

    model_config = ConfigDict(extra="ignore")

    model: str
    video_id: str
    #: Which output to download, for the models that return more than one.
    index: int = 0
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
    #: ``mode="cast"`` (story.rs) — read a character sheet into people. Returns
    #: ``{"cast": [{name, description, story}]}``. Windowed inside the sidecar,
    #: never clamped: a clamp reads the first N characters and reports the rest
    #: as "no characters found", which is a confident answer about the part it
    #: happened to see.
    mode: Literal["fields", "list", "cast"] = "fields"
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
    "SpecialistsRequest",
    "AgentSupportRequest",
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
