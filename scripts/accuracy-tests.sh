#!/usr/bin/env bash
# Run the transcription-ACCURACY tests — the 13 `#[ignore]`d tests that feed
# real audio through the real Whisper model.
#
# Why this script exists: those tests are `#[ignore]`d because the model is a
# 574 MB download, so `cargo test` skips them and NOTHING checked accuracy
# automatically (audit #563). Skipping them is the right default; having no way
# to run them is not — the whole speech pipeline's correctness lived on
# "somebody remembers the incantation".
#
# It also refuses to pass quietly on a machine that only LOOKS ready. A stale
# app-support copy of the model is exactly what masked the bundle regression
# that shipped transcription dead in v0.15.0, so the model this run used is
# printed, and a run where zero accuracy tests executed is a FAILURE, not a
# green tick.
#
# Usage:
#   scripts/accuracy-tests.sh              # run them (downloads the model if needed)
#   scripts/accuracy-tests.sh --no-download # fail instead of downloading
set -uo pipefail
cd "$(dirname "$0")/.."

DOWNLOAD=1
[ "${1:-}" = "--no-download" ] && DOWNLOAD=0

# Kept in step with src-tauri/src/stt.rs (MODEL_FILE / MODEL_URL) by
# e2e/page-script/accuracyTests.test.mjs — a rename there fails that test rather
# than silently making this script download the wrong file.
MODEL_FILE="ggml-large-v3-turbo-q5_0.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"

# The same two locations `test_model()` looks in, in the same order.
APP_SUPPORT="$HOME/Library/Application Support/com.benreich.privateroom/models/$MODEL_FILE"
BUNDLED="src-tauri/resources/models/$MODEL_FILE"

MODEL=""
[ -f "$APP_SUPPORT" ] && MODEL="$APP_SUPPORT"
[ -z "$MODEL" ] && [ -f "$BUNDLED" ] && MODEL="$BUNDLED"

if [ -z "$MODEL" ]; then
  if [ "$DOWNLOAD" = 0 ]; then
    echo "The Whisper model is on neither path — nothing to test against." >&2
    echo "  $APP_SUPPORT" >&2
    echo "  $BUNDLED" >&2
    exit 1
  fi
  echo "Whisper model not found — downloading ~574 MB to $BUNDLED"
  mkdir -p "$(dirname "$BUNDLED")"
  curl -fL --progress-bar "$MODEL_URL" -o "$BUNDLED.part" || {
    echo "Download failed." >&2; rm -f "$BUNDLED.part"; exit 1;
  }
  mv "$BUNDLED.part" "$BUNDLED"
  MODEL="$BUNDLED"
fi

# Say which copy answered. A developer machine holds an app-support copy from
# whatever build it last installed; that is NOT evidence the shipped bundle has
# one (v0.15.0 shipped without it and every local test stayed green).
echo "model: $MODEL ($(du -h "$MODEL" | cut -f1))"
if [ "$MODEL" = "$APP_SUPPORT" ] && [ ! -f "$BUNDLED" ]; then
  echo "note: this Mac's installed-app copy answered; src-tauri/resources/models has none."
fi

FAILED=0
run() {
  echo
  echo "── cargo test --lib $1 -- --ignored"
  # `--ignored` runs ONLY the ignored tests, so a filter matching none of them
  # exits 0 with "0 passed" — silence that reads exactly like success.
  out=$(cd src-tauri && cargo test --lib "$1" -- --ignored --nocapture 2>&1)
  status=$?
  echo "$out" | tail -25
  if [ $status -ne 0 ]; then
    FAILED=1
    return
  fi
  if echo "$out" | grep -qE "^test result: ok\. 0 passed"; then
    echo "!! no accuracy test ran for '$1' — the filter matches nothing any more."
    FAILED=1
  fi
}

run recording::
run stt::
run commands::stt_cmds::

echo
if [ $FAILED -eq 0 ]; then
  echo "accuracy tests: PASS"
else
  echo "accuracy tests: FAIL"
fi
exit $FAILED
