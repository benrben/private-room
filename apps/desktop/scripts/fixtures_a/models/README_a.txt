Packaging fixture data, not real model weights.

These three files exist ONLY so electron-builder.config.mjs's --dir proof build
has something to copy into Contents/Resources/models/ with the exact
filenames src/main/sttTools.ts's MODEL_FILE constant (and the
diarization/VAD equivalents named in the research doc section 2) expect at
runtime. They are a few dozen bytes each -- nowhere close to the real
574,041,195 / 40,257,283 / 885,098-byte weights RELEASING.md records, and
must NEVER be treated as real bundled models by anything other than a
structural packaging proof.

A real package build points ARCELLE_MODELS_DIR (see electron-builder.config.mjs)
at the real staged weights directory instead of this fixtures_a/models/
fallback.
