# Review and refactor checklist

Use this when auditing existing Python. Work top to bottom: the tiers are ordered
by what they cost the reader and the operator, so a review that stops early still
reports the things that matter most. Section references (§) point into
`idioms.md`, which has the before/after for most fixes suggested here.

**Run the tools first, then read.** Most of Tier 1 and Tier 3 is decidable by
a rule engine: `scripts/sweep.sh <paths>` (ruff, grouped in this file's tier
order) or `scripts/zen_check.py <paths>` (no dependencies), plus
`scripts/duplicates.py` for the Tier-2 duplication bullet. Items marked ⚙ are
caught mechanically; your reading time belongs to the unmarked ones —
`references/tooling.md` has the item→rule map and the list of what no rule
catches. `scripts/zen_fix.py` (or `ruff check --fix`) then applies the safe
fixes as a reviewable diff.

Report findings in this order too. A review that opens with import ordering while
a bare `except: pass` sits ten lines down has buried the lede. And report them
in the voice — one plain line each, lazy-senior style (see *How to report*
below); the tiers order the findings, the voice keeps them readable.

---

## Tier 1 — Correctness and silent failure

These are bugs, not style. Nothing else is worth mentioning until they're clear.

- ⚙ **Swallowed exceptions.** `except Exception: pass`, `except: pass`, or a broad
  catch that assigns a fallback and moves on. Ask: what failure mode does this
  hide, and how would we ever notice? *Errors should never pass silently.*
- ⚙ **Bare `except:`.** Also catches `KeyboardInterrupt` / `SystemExit`, so Ctrl-C
  and shutdown stop working.
- ⚙ **Lost tracebacks.** Re-raising a new exception without `from exc`, or logging
  `str(exc)` instead of `logger.exception(...)`.
- ⚙ **Mutable default arguments.** `def f(x, acc=[])` / `={}` — shared across calls.
- ⚙ **Unclosed resources.** `open`, sockets, locks, DB connections without `with`.
- ⚙ **Missing `encoding=`** on text file I/O — behaves differently per platform.
- **String-built SQL or shell commands.** Parameterize; never f-string user input
  into a query or a `shell=True` command.
- **Mutating a collection while iterating it.**
- **`==` where `is` is meant** (`None`, sentinels) and vice versa.
- ⚙ **`zip` silently truncating** sequences whose lengths should match — pass
  `strict=True`.
- **Float for money** (use `Decimal`); **naive datetimes** crossing timezone
  boundaries; **`random` where `secrets` is required** (tokens, resets).
- **A generator consumed twice** — the second pass silently yields nothing.
- **`assert` used to validate input** — `python -O` strips asserts, so the check
  vanishes in production. Asserts are for impossible states; bad input raises.
- ⚙ **`[mutable] * n`** — n references to one object, not n objects (§2).
- ⚙ **Leftover debugging**: `breakpoint()`, `pdb.set_trace()`, stray `print()`s
  in library code.
- ⚙ **Decorators without `functools.wraps`** — the wrapped function's identity is
  silently destroyed (§11).
- **Ambiguity resolved by guessing.** Undefined behavior for empty input, zero,
  negatives, or naive datetimes, silently picked rather than raised or documented.

## Tier 2 — Structure

Costs compound here: structure problems make every later change riskier.

- ⚙ **Deep nesting.** Three levels is a warning, four is a finding. Fix with guard
  clauses, extracted functions, or a comprehension. *Flat is better than nested.*
- ⚙ **Long functions.** If you can't state the purpose in one sentence without
  "and", it's doing several jobs. *If the implementation is hard to explain, it's
  a bad idea.*
- ⚙ **Boolean parameters that switch behavior.** Usually two functions in one.
  *Special cases aren't special enough to break the rules.*
- **Duplicated logic** in three or more places — but resist abstracting two
  similar-looking things that are similar by coincidence; that coupling costs
  more than the duplication.
- **Speculative abstraction.** ABCs with one implementation, config layers with
  one config, plugin systems with one plugin. *Simple is better than complex.*
- **Inconsistent return types.** Sometimes an object, sometimes `None`, sometimes
  `False`. Every caller pays.
- **Module-level mutable state**, or global config read from deep inside call
  stacks. *Namespaces are one honking great idea.*
- **Classes that should be functions** (single method, no state) or **classes
  that should be dataclasses** (fields plus a hand-written `__init__`).

## Tier 3 — Idiom and clarity

Real findings, but they don't change behavior — so they go after the above.

- ⚙ `range(len(x))` where `enumerate` or direct iteration fits (§1).
- Manual index counters that want `enumerate`; parallel indexing that wants `zip` (§1).
- Accumulator loops that want a comprehension, `sum`, `any`, or `all` (§2–3).
- Whole lists built where a generator would stream (§3); comparator-style sorting
  where `key=` fits (§8).
- Flow control via exceptions for expected outcomes, or custom exceptions with no
  shared base (§13).
- Mixed string-formatting styles; `%`/`.format` where f-strings would read better;
  ⚙ f-strings inside `logger.*` calls (should be `%s` lazy args).
- ⚙ `os.path` string surgery where `pathlib` is cleaner.
- Hand-rolled versions of `Counter`, `defaultdict`, `groupby`, `lru_cache`.
- ⚙ `if len(x) == 0` / `== True` / `!= None`.
- Comprehensions dense enough to need re-reading — nested `for` plus a filter plus
  a conditional expression. *Sparse is better than dense.*
- Positional args whose meaning isn't recoverable at the call site.
- Missing type hints on a public API.
- **Comments doing the code's job.** A comment that explains *what* means the
  code failed to say it — the fix is a rename, an extracted function named after
  the comment, or an explaining variable; then the comment is deleted, not
  polished. Only *why*-comments (constraints, workarounds, rejected
  alternatives) belong in the final code.

## Tier 4 — Surface

Mention briefly, or skip entirely if a formatter is in use — an autoformatter
makes most of this a non-conversation.

- Naming: `data`, `tmp`, `x2`, abbreviations only the author knows; `CamelCase`
  functions or `lower_case` classes.
- Dead code, commented-out blocks, unused imports and variables.
- Import order and grouping (stdlib / third-party / local), PEP 8 spacing.
- Missing docstrings on public functions and modules.

---

## Verify before you assert

Before calling anything a defect, spend the thirty seconds that kills false
findings — a review that's wrong once is distrusted everywhere:

- **Read the signature** before flagging dead code — that "pointless ternary"
  may exist because of a default parameter you didn't scroll up to see.
- **Read the tests** before flagging odd behavior — the strange guard may be
  pinned by a test that encodes a real requirement; the test names the intent.
- **Read the call sites** before flagging an API — a "redundant" parameter may
  be load-bearing for one caller three modules away.
- **Diff suspected duplicates properly** before claiming they've diverged —
  whitespace and renames masquerade as divergence, and "these copies have
  drifted" is a serious claim to get wrong.
- **Audit existing suppressions** rather than skipping past them: every
  `# noqa` and `# type: ignore` is a standing silence someone wrote once and
  no one has read since (`sweep.sh` lists them; see tooling.md). Each needs a
  why that still holds.

## How to report

Lazy-senior voice: one line per finding, tier order, plain words.

> `billing.py:42` — every error vanishes here, including the typos. Catch
> `FileNotFoundError`, let the rest crash — crashes are free bug reports.
> *(errors should never pass silently)*

Location, what breaks in words a non-programmer follows, the fix, principle in
parentheses. Consequences persuade; "this isn't Pythonic" doesn't. Show a
before/after snippet only when the fix isn't obvious from the sentence.

Close with one line: the single highest-payoff change. If the file is fine,
the whole report is "This is fine. Ship it." — padding a clean review with
Tier-4 crumbs costs the reader more than it gives.

## Refactoring safely

*Practicality beats purity*, and behavior preservation beats both.

1. Run the test suite FIRST — before touching anything — and record the
   number: passed, failed, skipped. A red suite discovered late invalidates
   recommendations you already made; a red suite discovered first is itself
   the top finding. No tests? Write a quick characterization script capturing
   current outputs, or restrict yourself to changes you can verify by reading.
2. One category of change per pass. Renaming and restructuring in the same commit
   makes the diff unreviewable.
3. Start with the highest tier present. Flattening a function is worth more than
   converting its string formatting.
4. Verify after each pass, not at the end.
5. Leave what you deliberately didn't fix as a specific note. *Now is better than
   never; although never is often better than right now.*
