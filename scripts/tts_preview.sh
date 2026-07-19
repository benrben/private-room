#!/bin/bash
# Idea 3: render one WAV per voice archetype's synthesis-side params and play
# them — proves the synthesis half without launching the app. (The DSP half —
# distortion/reverb/chorus — runs in the webview; Settings → Spoken voice →
# Preview exercises that.)
#
# Runs through the harness-less tts_smoke binary because the AVSpeech buffer
# callback rides the main run loop — a libtest #[test] never owns it.
set -euo pipefail
cd "$(dirname "$0")/.."

PATH="/opt/homebrew/bin:/usr/bin:$PATH" cargo test \
  --manifest-path src-tauri/Cargo.toml \
  --test tts_smoke -- --preview

for f in /tmp/pr-tts-*.wav; do
  echo "▶ $f"
  afplay "$f"
done
