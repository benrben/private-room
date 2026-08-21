"""S3 spike: pywhispercpp Metal wheel — same methodology as
src-tauri/src/stt.rs bench_transcribe_60s (60s of `say`-synthesized speech,
warm on a 1s clip, then time one full transcribe, print realtime factor).
Also asserts the Metal device log line fires at load (plan's acceptance gate).
"""
import io
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

import numpy as np

MODEL = "/Users/benreich/private-room/src-tauri/resources/models/ggml-large-v3-turbo-q5_0.bin"


def synth_and_decode(text: str) -> np.ndarray:
    with tempfile.TemporaryDirectory() as d:
        aiff = Path(d) / "bench.aiff"
        wav = Path(d) / "bench.wav"
        subprocess.run(["say", "-o", str(aiff), text], check=True)
        subprocess.run(
            ["/usr/bin/afconvert", "-f", "WAVE", "-d", "LEI16@16000", str(aiff), str(wav)],
            check=True,
        )
        with wave.open(str(wav), "rb") as w:
            assert w.getframerate() == 16000
            raw = w.readframes(w.getnframes())
            pcm16 = np.frombuffer(raw, dtype="<i2")
            if w.getnchannels() > 1:
                pcm16 = pcm16.reshape(-1, w.getnchannels()).mean(axis=1)
            return (pcm16.astype(np.float32) / 32768.0)


def main() -> int:
    from pywhispercpp.model import Model

    text = "The quick brown fox jumps over the lazy dog. " * 20
    pcm = synth_and_decode(text)
    audio_secs = len(pcm) / 16000.0

    log_path = Path(tempfile.gettempdir()) / "pywhispercpp-bench.log"
    with open(log_path, "w+") as log_file:
        t_load0 = time.perf_counter()
        model = Model(MODEL, redirect_whispercpp_logs_to=log_file)
        load_secs = time.perf_counter() - t_load0

    log_text = log_path.read_text()
    metal_ok = "Metal" in log_text and (
        "found device" in log_text.lower() or "using device" in log_text.lower() or "GPU" in log_text
    )

    t_warm0 = time.perf_counter()
    model.transcribe(pcm[:16000])
    warm_secs = time.perf_counter() - t_warm0

    t1 = time.perf_counter()
    segments = model.transcribe(pcm)
    decode_secs = time.perf_counter() - t1

    out = " ".join(s.text for s in segments).lower()
    ok = "quick brown fox" in out

    print(f"MODEL LOAD: {load_secs:.2f}s")
    print(f"WARM (1s clip): {warm_secs:.2f}s")
    print(f"AUDIO: {audio_secs:.1f}s | DECODE: {decode_secs:.2f}s | {audio_secs / decode_secs:.1f}x realtime")
    print(f"TRANSCRIPT CONTAINS 'quick brown fox': {ok}")
    print(f"METAL LOG LINE PRESENT: {metal_ok}")
    print("--- whisper.cpp log (first 40 lines) ---")
    for line in log_text.splitlines()[:40]:
        print(line)

    return 0 if ok and metal_ok else 1


if __name__ == "__main__":
    sys.exit(main())
