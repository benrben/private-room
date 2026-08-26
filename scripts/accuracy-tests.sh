#!/usr/bin/env bash
# Focused speech and diarization verification for the Python sidecar.
set -euo pipefail
cd "$(dirname "$0")/../sidecar"
uv run pytest -q \
  tests/test_stt_models.py tests/test_stt_live.py \
  tests/test_diar_cluster.py tests/test_diar_embed.py tests/test_diar_label.py \
  tests/test_diar_recognize.py tests/test_diar_windows.py \
  tests/test_rec_meta_diar_label_integration.py
