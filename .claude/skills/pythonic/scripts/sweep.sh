#!/usr/bin/env bash
# Tiered ruff sweep in the order of references/review-checklist.md.
#
# Most of Tier 1 and Tier 3 is machine-decidable; run this BEFORE reading any
# file so reading time goes where no rule reaches (references/tooling.md has
# the item->rule map and the honest list of what stays manual).
#
# Usage:
#   scripts/sweep.sh [paths...]          # default: .
#   RUFF="python3 -m ruff" scripts/sweep.sh src/   # pick a specific ruff
#
# Exit status: 1 if any Tier 1 (correctness) finding, else 0 — CI-safe.
# Rule codes verified against ruff 0.12.8 and 0.15.x.
set -u

RUFF="${RUFF:-ruff}"
if ! $RUFF --version >/dev/null 2>&1; then
    echo "ruff not found (pip install ruff)." >&2
    echo "Zero-dependency fallback: python3 scripts/zen_check.py ${*:-.}" >&2
    exit 2
fi

PATHS=("${@:-.}")
T1="BLE,E722,B904,B006,B008,F632,E711,E712,B905,DTZ,S311,S608,S602,S604,S605,ASYNC"
T1_PREVIEW="PLW1514,SIM115"          # missing encoding= / resource without with
T2="C901,PLR0912,PLR0915,PLR0913,FBT001,FBT002,RET,PLW0603,ARG"
T3="C4,SIM,PERF,PTH,G004,FURB,ISC,RSE,TRY"
T4="F401,F841,ERA001,I001"

tier1_dirty=0

run_tier() {
    local title="$1" select="$2" extra="${3:-}"
    echo
    echo "== ${title} =="
    # shellcheck disable=SC2086  # $extra is deliberately word-split (may be empty)
    if ! $RUFF check --quiet --no-cache --output-format concise $extra --select "$select" "${PATHS[@]}"; then
        [[ "$title" == TIER\ 1* ]] && tier1_dirty=1
    fi
}

run_tier "TIER 1 — correctness and silent failure" "$T1"
run_tier "TIER 1 — correctness (preview rules)"    "$T1_PREVIEW" "--preview"
run_tier "TIER 2 — structure"                      "$T2"
run_tier "TIER 3 — idiom"                          "$T3"
run_tier "TIER 4 — surface"                        "$T4"

echo
echo "== Standing silences (suppression audit) =="
echo "Each of these is a hand-written 'unless explicitly silenced' — every one needs a why."
silences=$(grep -rnH --include="*.py" -E "# *(noqa|type: *ignore|pragma: *no cover)" "${PATHS[@]}" 2>/dev/null \
    | sed -E 's/^([^:]+:[0-9]+):.*(# *(noqa|type: *ignore|pragma: *no cover)[^"'"'"']*).*/  \1  \2/')
if [[ -n "$silences" ]]; then echo "$silences"; else echo "  none found"; fi
echo "  (findings these currently hide: rerun any tier above with --ignore-noqa and diff)"

echo
echo "Not covered by any rule (read for these): range(len()) loops [zen_check.py],"
echo "duplication [duplicates.py], float-for-money, reused generators, inconsistent"
echo "return shapes, classes-that-should-be-dataclasses. See references/tooling.md."

exit $tier1_dirty
