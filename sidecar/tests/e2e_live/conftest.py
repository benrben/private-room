"""Live-model e2e fixtures. See harness.py for the doctrine and the entry
point; the opt-in gates live in the test modules themselves."""

from __future__ import annotations

import pytest

from arcelle_sidecar import chat as chat_module
from arcelle_sidecar.model_limits import native_context_length


@pytest.fixture(autouse=True)
def _real_native_context_lookup(monkeypatch: pytest.MonkeyPatch):
    """Undo the top-level conftest's network-free stub — live e2e must
    exercise the REAL payload-fitted num_ctx path against the real catalog."""
    monkeypatch.setattr(chat_module, "native_context_length", native_context_length)
