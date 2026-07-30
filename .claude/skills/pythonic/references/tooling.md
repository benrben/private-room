# Tooling: run the tools first, then read

(And report what they find in the lazy-senior voice — the tools produce the
noise, you produce the three lines that matter.)

Most of Tier 1 and Tier 3 of the review checklist is machine-decidable. Every
minute spent hand-detecting what a rule engine detects is a minute taken from
the findings only reading can produce. The order is always:

1. **Scope** — know what you're actually auditing before opening anything:

   ```bash
   git ls-files '*.py' | xargs wc -l | sort -rn | head -30
   ```

   First-party code is usually a small fraction of what `find` returns
   (vendored deps, generated files, `.venv`). Auditing the wrong 4,000 files
   is the most expensive mistake available.

2. **Sweep** — `scripts/sweep.sh <paths>`: a ruff pass grouped in the
   checklist's own tier order, plus a suppression audit. No ruff installed →
   `scripts/zen_check.py <paths>` is the zero-dependency fallback.

3. **Duplicates** — `scripts/duplicates.py <paths>`: normalized-AST clone
   detection. The one instrument nothing else provides — the checklist's
   "duplicated logic" bullet is only greppable if you already know the name.

4. **Read** — with the mechanical layer done, reading time goes to the
   uncovered list at the bottom of this file. That's the actual review.

## Checklist item → ruff rule map

Verified against ruff 0.12.8 and 0.15.x. `sweep.sh` runs these groups in
order; use this table when you need a single item or want to wire CI.

### Tier 1 — correctness (`--select` these, gate on them)

| Checklist item | Rule(s) |
| --- | --- |
| Swallowed / overbroad exceptions | `BLE` |
| Bare `except:` | `E722` |
| Lost tracebacks (`raise` without `from`) | `B904` |
| Mutable default arguments | `B006`, `B008` |
| `is` vs `==` confusion | `F632`, `E711`, `E712` |
| `zip` silently truncating | `B905` |
| Naive datetimes | `DTZ` |
| `random` where `secrets` is required | `S311` |
| String-built SQL / shell commands | `S608`, `S602`, `S604`, `S605` |
| Blocking calls in async code | `ASYNC` |
| Missing `encoding=` on text I/O | `PLW1514` (needs `--preview`) |
| Resource without `with` | `SIM115` (needs `--preview` on some versions) |

### Tier 2 — structure

| Checklist item | Rule(s) |
| --- | --- |
| Deep nesting / high complexity | `C901`, `PLR0912` |
| Long functions | `PLR0915` |
| Too many parameters | `PLR0913` |
| Boolean flag parameters | `FBT001`, `FBT002` |
| Inconsistent/implicit returns | `RET` |
| Module-level mutable state (`global`) | `PLW0603` |
| Dead parameters | `ARG` |

### Tier 3 — idiom

| Checklist item | Rule(s) |
| --- | --- |
| Comprehension/constructor idioms | `C4` |
| Simplifiable conditionals & code | `SIM` |
| Allocation-in-loop and perf idioms | `PERF` |
| `os.path` → `pathlib` | `PTH` |
| f-strings in logging calls | `G004` |
| Modernizable patterns | `FURB` |
| Implicit string concatenation | `ISC` |
| Exception raising/handling idioms | `RSE`, `TRY` |

### Tier 4 — surface

| Checklist item | Rule(s) |
| --- | --- |
| Unused imports / variables | `F401`, `F841` |
| Commented-out code | `ERA001` |
| Import order | `I001` |

Many Tier 3/4 findings are auto-fixable: `ruff check --fix --select C4,SIM,PTH,F401,I001`
(review the diff like any other refactor; `scripts/zen_fix.py` is the
zero-dependency equivalent for its smaller fix set).

## What no rule catches — spend your reading here

Verified absent even under `ruff --select ALL`:

- **`range(len(x))` loops** — no ruff rule exists; `scripts/zen_check.py`
  catches it mechanically.
- **Duplicated logic across modules** — `scripts/duplicates.py` finds exact
  clones; *near*-clones (renamed variables, drifted copies) still need eyes.
  Before claiming two copies have diverged, diff them properly — whitespace
  and renames masquerade as divergence.
- **Float for money** — a `total: float` on an invoice is invisible to every
  linter; it's a domain judgment.
- **A generator consumed twice** — type checkers occasionally infer it; no
  linter flags it.
- **Inconsistent return shapes** — `User` / `None` / `False` from one
  function. `RET` gets fragments; the design problem is yours to see.
- **Classes that should be dataclasses / functions** — structural judgment.
- **One concept spelled three ways** across modules (`ts`, `timestamp`,
  `created_at` for the same thing) — only visible when reading widely.
- **Speculative abstraction, coincidental duplication, naming quality,
  comments doing the code's job** — the whole judgment half of the checklist.

## Auditing suppressions

The skill's doctrine is *unless explicitly silenced* — a suppression is
allowed, visible, and justified. Existing `# noqa`, `# type: ignore`, and
`contextlib.suppress` are **standing silences someone wrote once and no one
has read since**. `sweep.sh` ends by listing them all; for any tier you can
also see exactly what the suppressions currently hide:

```bash
ruff check --select BLE --ignore-noqa <paths>   # findings incl. suppressed
ruff check --select BLE <paths>                 # findings minus suppressed
```

Review each survivor like a finding: does the why still hold, is the code
that justified it still there, would a narrower suppression do? A `# noqa:
BLE001` with no comment is an undocumented decision — the checklist's
except-pass rule, one meta-level up.
