# Repository quality loop

Read this reference before running or updating the bundled quality loop.

## Entrypoint and configuration

Run from the target repository root:

```bash
python3 <skill-directory>/scripts/quality_loop.py --root .
```

In a Claude Code plugin, the skill directory is
`${CLAUDE_PLUGIN_ROOT}/skills/code-discipline`; in Codex, use the directory of
the loaded `SKILL.md`.

`.quality/quality-gate.json` owns commands and adapters. `.quality/quality-thresholds.json`
owns every numeric goal and overrides the bundled defaults in
`../quality-thresholds.json`, including `file_loc.max_lines: 600`. Never copy
thresholds into `.quality/quality-gate.json`.

To update the complete installed skill:

```bash
python3 <skill-directory>/scripts/install.py --update-current [--ref REF]
```

The updater atomically replaces only the managed skill. It must not overwrite
repository-owned quality configuration.

## Scope and modes

- `--local-changes` selects staged, unstaged, and untracked production files.
- `--commit [REF]` selects a committed diff; omitted `REF` means `HEAD`.
- Omitting both selects the whole repository.
- `--commit` and `--local-changes` are mutually exclusive.

Incremental scope limits file-aware metrics, mutation, dependency analysis, and
inferred formatter/linter commands. Complete tests and explicitly configured
commands retain repository scope so unchanged callers are still checked. Never
describe an incremental pass as whole-repository certification.

Use `--fast` only while diagnosing and repairing. It runs static gates and one
baseline tests/coverage/CRAAP pass, but defers repeated flaky tests and mutation
testing and therefore never exits `0`. When state says `ready_for_full`, run its
`full_rerun_command` immediately.

Every run writes `.quality/quality-gate-report.html` and
`.quality/quality-gate-state.json` and prints both paths. Add them to the repository's ignore file
when they should remain local. Use `--html PATH` to choose another report path
or `--artifact-dir DIR` to choose the directory for both artifacts.

## Results and repair loop

- Exit `0`: every applicable check in the selected scope passed.
- Exit `1`: read `fix_prompt` and `failures` in the printed state file, repair
  one coherent batch, run focused tests, and rerun. In fast mode it may instead
  mean the full run is ready.
- Exit `2`: configuration, an adapter, or the runner failed; repair that blocker
  before changing production behavior.

Coverage and CRAAP measurements are diagnostic until the unmodified baseline
test suite passes. Flaky and mutation checks require a green baseline. Check
`metrics.certified` before reporting function measurements as certified.

Before the first run, preserve existing worktree changes. Only one loop may run
per repository; coverage and mutation tools often share temporary paths. Do not
run mutation analysis while another process writes source files.

If `.quality/quality-dependencies.json` is missing, derive it from intended architecture
after reading the repository. Never bless current imports as architecture by
default.

## Full-run invariants

Use `--mutation-workers auto` unless an explicit positive worker limit is
needed. Native Vitest/Stryker uses related-test selection and a content-addressed
proof cache; relevant source, test, dependency, or tool changes invalidate that
proof. Other stacks use the portable snapshot engine. Both treat `Survived`,
`NoCoverage`, `Timeout`, and runner errors as failures and leave the active
worktree unchanged.

A successful full run requires all applicable formatter, lint, type, contract,
test, coverage, complexity, CRAAP, File LOC, dead-code, flaky-test, mutation,
and module-boundary goals to pass. Never lower thresholds, disable a gate, cap
the final mutation run, skip tests, weaken assertions, add pass-only
suppressions, broaden allow-lists, or replace checks with no-ops. Continue until
the selected full run exits `0` only when repair was requested; otherwise report
failures without changing production code or configuration. If a gate cannot
measure valid code, report the adapter or configuration limitation—never rewrite
correct code merely to manufacture a measurable target. Then report the run's
summaries and report paths.
