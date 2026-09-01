"""Shared server imports, constants, and facade lookup."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import hmac
import logging
import os
import tempfile
import sys
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, TypeVar
from urllib.parse import parse_qsl

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import (
    __version__,
    ai_actions,
    chat_docs,
    compaction,
    features,
    file_pass,
    handoff,
    imagegen,
    llm,
    model_limits,
    rec_read,
    videogen,
    vision,
    websearch,
    wf_nodes,
)
from . import privacy as privacy_mod
from . import privacy_scan as privacy_scan_mod
from . import summarize as summarize_feature
from . import tts as tts_mod
from .docs.dispatch import extract_text as extract_document_text
from .chat import ChatModel, OllamaChatModel
from .config import (
    CLOUD_WORKER_PARALLEL,
    CancelRequest,
    CapabilitiesRequest,
    DeleteRequest,
    EmbedRequest,
    FeedbackDraftRequest,
    GenerateDocRequest,
    GenerateRequest,
    HealthResponse,
    ImageGenerateRequest,
    KnowledgeExtractRequest,
    LabelRequest,
    ModelsRequest,
    OcrRequest,
    PrivacyScanRequest,
    PullRequest,
    RunRequest,
    AgentSupportRequest,
    SpecialistsRequest,
    PodcastTtsRequest,
    TtsRequest,
    VideoJobRequest,
    VideoStartRequest,
    VisionLocateRequest,
    QuickLookRequest,
    WarmRequest,
    WebSearchRequest,
)
from .media.ocr import recognize as ocr_recognize
from .agents import agent_roster, reachable_agent_ids, specialist_catalog
from .external_llm import ExternalChatModel, is_external_model
from .graph import CancelToken, Deps, Emit, stream_events
from .mcp_client import McpClient
from .messages import compact_json
from .provider_api import OpenAICompatibleChatModel
from .rec.session_ws import register_rec_routes
from .stt.dictation import register_dict_routes
from .stt import engine as stt_engine
from .media.decode import MediaKind as SttMediaKind, decode_to_pcm
from .media.quicklook import preview_png as quicklook_preview_png
from .media.visual_index import register_visual_index_routes

log = logging.getLogger("arcelle_sidecar")

#: Ceiling on one incoming request body. Only programs already on this Mac can
#: reach the port, so this is hardening, not a live defence: the biggest real
#: body is a base64 image or a file-pass window, orders of magnitude under this,
#: and holding an unbounded one whole in memory on a machine already running a
#: multi-GB model is the failure worth refusing. Enforced on the declared
#: ``Content-Length``, which is what every caller of ours sends.
MAX_REQUEST_BYTES: int = 128 << 20

#: Environment variable carrying the shared secret the Rust host hands us at
#: spawn. See :class:`TokenAuthMiddleware`.
TOKEN_ENV = "ARCELLE_SIDECAR_TOKEN"

#: The one route that answers without the token: the host's own liveness probe,
#: which runs before anything is configured and reveals nothing but "yes, and
#: this is my version".
_OPEN_PATHS = frozenset({"/health"})

#: How often a one-shot handler checks whether its caller is still there.
_HANGUP_POLL_SECS = 0.25

#: A factory so tests can inject a scripted model instead of a real Ollama.
ChatModelFactory = Callable[[RunRequest], ChatModel]
McpFactory = Callable[[RunRequest], McpClient | None]




def facade() -> Any:
    """Return the public server facade so monkeypatch seams remain live."""
    return sys.modules[f"{__package__}.server"]


__all__ = ['AgentSupportRequest', 'Any', 'AsyncIterator', 'Awaitable', 'CLOUD_WORKER_PARALLEL', 'Callable', 'CancelRequest', 'CancelToken', 'CapabilitiesRequest', 'ChatModel', 'ChatModelFactory', 'DeleteRequest', 'Deps', 'EmbedRequest', 'Emit', 'ExternalChatModel', 'FastAPI', 'FeedbackDraftRequest', 'GenerateDocRequest', 'GenerateRequest', 'HealthResponse', 'ImageGenerateRequest', 'JSONResponse', 'KnowledgeExtractRequest', 'LabelRequest', 'MAX_REQUEST_BYTES', 'McpClient', 'McpFactory', 'ModelsRequest', 'OcrRequest', 'OllamaChatModel', 'OpenAICompatibleChatModel', 'Path', 'PodcastTtsRequest', 'PrivacyScanRequest', 'PullRequest', 'QuickLookRequest', 'Request', 'RunRequest', 'SpecialistsRequest', 'StreamingResponse', 'SttMediaKind', 'TOKEN_ENV', 'TtsRequest', 'TypeVar', 'VideoJobRequest', 'VideoStartRequest', 'VisionLocateRequest', 'WarmRequest', 'WebSearchRequest', '_HANGUP_POLL_SECS', '_OPEN_PATHS', '__version__', 'agent_roster', 'ai_actions', 'asyncio', 'base64', 'chat_docs', 'compact_json', 'compaction', 'contextlib', 'decode_to_pcm', 'extract_document_text', 'features', 'file_pass', 'handoff', 'hmac', 'httpx', 'imagegen', 'is_external_model', 'llm', 'log', 'logging', 'model_limits', 'ocr_recognize', 'os', 'parse_qsl', 'privacy_mod', 'privacy_scan_mod', 'quicklook_preview_png', 'reachable_agent_ids', 'rec_read', 'register_dict_routes', 'register_rec_routes', 'register_visual_index_routes', 'specialist_catalog', 'stream_events', 'stt_engine', 'summarize_feature', 'sys', 'tempfile', 'tts_mod', 'videogen', 'vision', 'websearch', 'wf_nodes']
