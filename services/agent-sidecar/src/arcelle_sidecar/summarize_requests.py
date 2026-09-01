"""HTTP request models for summary endpoints."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from . import config

# --- HTTP request bodies ----------------------------------------------------
#
# Defined here (not the parallel-contended config module) to keep the whole
# feature self-contained. Each carries the Ollama ``base_url`` the sidecar should
# use (ollama::resolved_base_url() on the Rust side).


class SummarizeFileRequest(BaseModel):
    """Body of ``POST /summarize_file`` — the map step for ONE file."""

    model_config = ConfigDict(extra="ignore")

    model: str
    name: str
    text: str
    mime: str = ""
    base_url: str = "http://127.0.0.1:11434"
    keep_alive: str = "30m"
    #: PRIV-1: room privacy policy payload (config.RunRequest docstring).
    privacy: dict[str, Any] | None = None
    provider: config.ProviderConfig | None = None


class CombineSummaryRequest(BaseModel):
    """Body of ``POST /combine_summary`` — the reduce step from the one-liners."""

    model_config = ConfigDict(extra="ignore")

    model: str
    room_name: str
    file_lines: str
    memories: list[str] = Field(default_factory=list)
    base_url: str = "http://127.0.0.1:11434"
    keep_alive: str = "30m"
    #: PRIV-1: room privacy policy payload (config.RunRequest docstring).
    privacy: dict[str, Any] | None = None
    provider: config.ProviderConfig | None = None
