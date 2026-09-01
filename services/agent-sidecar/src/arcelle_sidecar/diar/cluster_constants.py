"""Clustering and online speaker-assignment thresholds."""

# Voiced frames before a LIVE phrase may open a brand-new speaker (~2.5 s).
# diart-style: creation is the costliest online mistake (a phantom is on
# screen until the next re-cluster), so it takes far more evidence than
# attachment. `cluster` still discovers new voices from shorter (>= 1 s)
# phrases at every re-cluster.
MIN_OPEN_FRAMES: int = 156

# Voiced frames before a live phrase may UPDATE a centroid (~1.5 s) -- noisy
# short evidence must never drag an established voice (diart's rho_update).
MIN_UPDATE_FRAMES: int = 94

# A voice below BOTH bars after clustering is a phantom: fewer phrases than
# this...
MIN_CLUSTER_PHRASES: int = 2
# ...and less cumulative voiced speech than this (16 ms frames, ~= 5 s) -- it
# is absorbed into the nearest surviving voice instead of being reported
# (pyannote's `min_cluster_size`, scaled to phrase units).
MIN_CLUSTER_FRAMES: int = 312

# Safety ceiling when the participant count is discovered rather than given
# (the normal case). Far above a real meeting's distinct voices, so it only
# ever stops pathological runaway labeling.
AUTO_MAX_SPEAKERS: int = 8

# Voiced frames (16 ms) a SUB-WINDOW needs to help define a voice (~0.3 s).
# The phrase gate (~1 s) is unreachable inside a 1.5 s window. This gate
# exists ONLY for the split pass; whole phrases keep MIN_NEW_VOICE_FRAMES.
SPLIT_MIN_VOICE_FRAMES: int = 20

# A COUNT-driven merge must still clear this centered-space similarity. The
# eigengap count is an estimate, not evidence: 0.07 sits on the measured
# plateau where every held-out meeting keeps its true speaker count and
# nothing over-splits.
COUNT_FLOOR: float = 0.07
