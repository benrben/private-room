"""Model-free and speech request bodies for the sidecar HTTP API."""

from pydantic import BaseModel, ConfigDict, Field

from .tts import DEFAULT_PITCH, DEFAULT_RATE, DEFAULT_VOICE


class CancelRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    run_id: str


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


class SpecialistsRequest(BaseModel):
    """Tool names and web setting used to resolve available specialists."""

    model_config = ConfigDict(extra="ignore")
    web_enabled: bool = False
    served_names: list[str] = Field(default_factory=list)


class AgentSupportRequest(BaseModel):
    """Tool names by tier used to resolve the provider/agent matrix."""

    model_config = ConfigDict(extra="ignore")
    web_enabled: bool = False
    tiers: dict[str, list[str]] = Field(default_factory=dict)


class DeleteRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    model: str
    base_url: str = "http://127.0.0.1:11434"


class TtsRequest(BaseModel):
    """One spoken-voice synthesis request."""

    model_config = ConfigDict(extra="ignore")
    text: str
    voice: str = DEFAULT_VOICE
    rate: str = DEFAULT_RATE
    pitch: str = DEFAULT_PITCH


class PodcastTurnRequest(BaseModel):
    """One spoken turn: what is said, and in whose voice."""

    model_config = ConfigDict(extra="ignore")
    text: str
    voice: str = ""
    rate: str = ""
    pitch: str = ""


class PodcastTtsRequest(BaseModel):
    """A complete multi-speaker episode with one loudness pass."""

    model_config = ConfigDict(extra="ignore")
    turns: list[PodcastTurnRequest] = Field(default_factory=list)
    gap_ms: int = 420


class QuickLookRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    data_b64: str


class OcrRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    mime: str
    ext: str
    data_b64: str


class WebSearchRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    query: str
    limit: int = Field(default=12, ge=1, le=50)


class HealthResponse(BaseModel):
    ok: bool = True
    version: str
