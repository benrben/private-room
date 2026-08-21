# S3 — pywhispercpp Metal wheel spike — PASS

Ran 2026-08-22 on this machine (Apple M4, macOS 26.5.1, Xcode Command Line Tools only —
**no full Xcode.app installed**).

## Build

```
python3 -m venv venv && source venv/bin/activate
CMAKE_ARGS="-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON" pip install --no-binary pywhispercpp pywhispercpp
```

First attempt used `GGML_METAL_EMBED_LIBRARY=OFF` and failed: that mode precompiles a
standalone `default.metallib` via `xcrun metal`/`xcrun metallib`, which requires the Metal
Toolchain component that only ships with full Xcode.app — this machine only has the Command
Line Tools, so `xcrun` couldn't find `metal`. Switching to `GGML_METAL_EMBED_LIBRARY=ON`
(matching plan D5 and what `whisper-rs-sys`'s build.rs already uses for the Rust build)
**embeds the `.metal` SOURCE as an assembly `.incbin`** — no offline shader compiler needed at
all; Metal's runtime (`newLibraryWithSource:`) JIT-compiles it on first load. Build succeeded
with plain Command Line Tools. **This corrects an assumption in the plan** (D5/Q8 worried
about needing to "self-build" against a real Metal toolchain) — ordinary CLT is enough as
long as embedding is on.

## Packaging gotcha found (real, will hit the vendored wheel too)

The built `_pywhispercpp*.so`'s `LC_RPATH` pointed at the ephemeral pip build temp dir:

```
otool -l _pywhispercpp*.so | grep -A1 LC_RPATH
  path /private/var/folders/.../pip-install-.../build/lib.macosx-15.6-arm64-cpython-313
```

The five `libggml-*.dylib`/`libwhisper.dylib` files ARE copied next to the `.so` in
site-packages, but the `.so` doesn't know to look there — `dlopen` failed the moment the temp
dir was gone (i.e., always, once pip cleans up). Fixed for this spike with:

```
install_name_tool -delete_rpath "<temp-build-dir>" _pywhispercpp*.so
install_name_tool -add_rpath "@loader_path" _pywhispercpp*.so
```

**For the real vendored wheel**: run `delocate-wheel` (or this same `install_name_tool` repair)
as a required step of "build once, vendor in-repo" — Part C §9 build checklist item 8 should
include this explicitly, or the committed wheel will dlopen-fail on every machine it's
installed on.

## Bench: same methodology as `src-tauri/src/stt.rs::bench_transcribe_60s`

60s of `say`-synthesized speech ("The quick brown fox jumps over the lazy dog." × 20),
decoded via the identical `afconvert -f WAVE -d LEI16@16000` path, warm-transcribe a 1s clip
first (context load, not counted), then time one full transcribe:

| | audio | decode | realtime factor |
|---|---|---|---|
| **Rust** (`whisper-rs` 0.16, Metal, this machine) | 55.5s | 8.1s | 6.8x |
| **Python** (`pywhispercpp` 1.5.0, Metal, this machine, same model file) | 55.5s | 1.95s | **28.5x** |

Python came out over 4x faster. Whisper.cpp log lines (`ggml_metal_library_init: using
embedded metal library`, `ggml_metal_device_init: GPU name: MTL0`, `MTLGPUFamilyMetal4`)
confirm Metal, not CPU fallback, on both sides — but pywhispercpp's vendored whisper.cpp/ggml
(1.8.4-era: flash attention, residency sets, graph fusion) is simply newer than whisper-rs
0.16's vendored copy. Transcript correctness verified (`"quick brown fox"` present, timestamp
format intact via the model's own segment API).

## Acceptance gate (plan §8 Phase 1 exit criterion: "STT bench")

**PASS** — Metal confirmed via the startup log line assertion (this becomes
`sidecar/arcelle_sidecar/stt/engine.py`'s own startup assert per Part C §4), transcription
correct, and performance is not a regression — it's an improvement.

## Reproduce

```
cd electron-migration/spikes/s3-metal-wheel
source venv/bin/activate   # after the CMAKE_ARGS build above
python3 bench.py
```
