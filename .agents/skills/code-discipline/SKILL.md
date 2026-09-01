---
name: code-discipline
description: Engineering discipline for any programming language. Use whenever code is written, reviewed, refactored, debugged, tested, or designed. Enforces behavior-preserving changes, regression tests, explicit failure behavior, readable design, and the bundled incremental quality loop when a repository has configured it.
---

# The Zen of Modern Development

One bet under every verse: **code is read far more often than it is written —
optimize for the reader.** Each verse below is the why; the rules under it
are the do. When rules conflict, the tiebreaker: which version does the
reader understand faster? If the honest answer is the less pure one, take it
and record why — practicality beats purity.

## Repository quality loop

When `.quality/quality-gate.json` exists, run the bundled loop for every coding task:

- During implementation: `--local-changes --fast`.
- Before handoff: `--local-changes` without `--fast`; repair and rerun until it
  exits `0`.
- For a requested commit: use `--commit [REF]`.
- Use whole-repository scope only for requested hardening, audit, or release
  certification.

Audit or certification alone is read-only; repair failures only when asked.

Before running the loop, read
[references/quality-loop.md](references/quality-loop.md) completely. If the
gate is not configured, run the repository's existing focused checks; set it up
only when asked, following
[references/repository-setup.md](references/repository-setup.md).

Never weaken thresholds or checks merely to pass. Do not commit or push unless
the user asked.

## Readability counts.

> *Beautiful is better than ugly. Clear is better than clever.
> Explicit is better than implicit. Names should tell the truth.*

- Ship the version a competent stranger understands faster.
- A name that needs a comment is unfinished work — rename, split, or type
  until the comment dies; keep only comments that explain *why*.

## Functions should be small.

> *One thing should happen at one level of abstraction.
> Flat is better than nested. Boolean arguments hide two functions.*

- Extract until no function mixes a high-level step with plumbing.
- Guard clauses and early returns; happy path on the left margin.
- Arguments: none ideal, one fine, two justified, many = a named object.
- A boolean argument means two functions — give each behavior its own name.
- One obvious way per codebase — write the language you're in, and match
  the house: read the neighboring feature first; its locking, permissions,
  status reporting, and test conventions are your contract.

## Commands act; queries answer.

> *Doing both creates surprise. Side effects should be visible.
> Hidden changes become hidden defects. Complex conditions deserve names.*

- A function answers a question or changes the world — never both.
- Mutation of an argument, global, or storage shows in name and signature.
- A multi-clause boolean gets a name; then it's readable and testable.

## Errors should never pass silently.

> *Unless explicitly silenced. Errors deserve their own path.
> In the face of ambiguity, refuse the temptation to guess.
> Null is ambiguity wearing a small disguise.*

- Failure travels on its own channel; the happy path reads straight down.
- Catch the narrowest failure you can actually handle; keep the cause
  attached when wrapping — in your language's idiom.
- Silence only as a visible decision with a written reason; a bare empty
  catch is a shrug.
- Prefer a typed absence or an honest empty value over null. A documented
  "not found" from a single-item lookup is honest absence, not a crime.
- When asked to go fast, name what you're cutting — never silently drop
  error handling on money, auth, or data, or tests on the riskiest logic.
  Record every deferral as a TODO with its reason.

## Duplication is cheaper than the wrong abstraction.

> *Once the shared idea is known, say it once.
> Special cases aren't special enough to break the rules.
> Although practicality beats purity.*

- Extract when the shared idea is genuinely one domain rule — third
  occurrence is the default. Merging what only looks alike welds strangers.

## Strangers should not be reached through chains of strangers.

> *Friends may speak directly. External libraries belong behind boundaries.
> Their changes should not become your changes.*

- Don't walk `a.getB().getC().do()` — ask the friend for what you need.
- Wrap external libraries in an interface you own, sized to what you use.
- All code you didn't reason through yourself — dependencies, generated
  snippets, your own earlier output — enters through the same door: your
  interface and your tests. No trust by authorship.

## A failing test comes first.

> *Red reveals the missing behavior. Green permits refactoring.
> Tests should depend on behavior. Its failure should tell one clear story.*

- Red proves the test; a test that never failed proves nothing. A
  regression test is proven on the unfixed code — run it, watch it fail.
- Fix the reported symptom, not the first defect you find: reproduce the
  symptom itself with production-realistic values, and prove your fix cures
  that reproduction — a nearby bug is not the cause until it explains the
  report's magnitude and frequency.
- Tests drive the public path with production values, not an internal
  helper with tuned constants.
- Fast, independent, wired into CI — a test that doesn't run doesn't exist.
- One test, one behavioral promise.
- Ceremony is for code that lives — a throwaway script gets run-and-look.

## Refactoring changes structure without changing behavior.

> *A green suite makes improvement ordinary. Simple is better than complex.
> Complex is better than complicated. YAGNI is design discipline.*

- Behavior includes the error paths: partial failures, fallbacks, what
  stays set when step two throws — trace them in the diff.
- The diff of a refactor is a move, not an improvement: keep signatures,
  argument-passing, defaults, and statement order exactly as they were —
  even where a nicer shape tempts you. Improvements ship separately; never
  entangle a refactor with new features.
- Ship the smallest complete correct thing. Suite green before and after —
  run it, don't assume it.
- A fix covers its own edges: ask what sits just past its boundary — the
  sub-frame, the empty remainder, the off-by-one — nothing extra rides.
- Complicated is self-inflicted: you've drifted when you explain mechanism
  instead of purpose. Imagined requirements deserve no real complexity.

## Dependencies point inward.

> *The database is a detail. The framework and the web are details too.
> Architecture should reveal use cases. Boundaries pass simple data.
> Concurrency should be isolated. Shared mutable state should be rare and obvious.*

- One actor, one reason to change, per class or module.
- Layers and abstractions earn their place on concrete triggers — a second
  caller, a second implementation — not on diagrams.
- Every new I/O path gets a decided failure behavior: a secondary feature
  never breaks the primary path; degraded success beats total failure.
  Test the failure path.
- Shared mutable state stays named, guarded, owned. Background failures
  land somewhere visible.

## Output

Writing: the discipline shows as the shape of the code — never narrate
these rules in comments. Reviewing: quote the verse behind each finding,
order by cost — defects first, structure next, style last — and say so when
the code is already fine.
