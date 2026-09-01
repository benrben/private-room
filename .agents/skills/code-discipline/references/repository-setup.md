# Repository quality environment setup

Use this guide when the user asks to prepare, bootstrap, or harden a repository
for the complete quality loop. Preserve the repository's existing runtime,
package manager, lockfile, commands, and CI conventions. Add tools as development
dependencies through that package manager so local and CI runs use the same
versions.

## Bootstrap

1. Inspect manifests, lockfiles, existing scripts, formatter/linter/type/test
   configuration, coverage output, schemas, and module layout. Record existing
   worktree changes before editing.
2. Restore the repository's dependencies and prove its baseline test command can
   run in the current environment. A quality-tool setup is not valid while the
   repository runtime or ordinary dependencies are missing.
3. From the repository root, generate the control files:

   ```bash
   python3 <skill-directory>/scripts/repo_quality_gate.py --root . --init
   ```

   `--init` creates `.quality/quality-gate.json` for commands/adapters and
   `.quality/quality-thresholds.json` for every numeric quality goal. Module boundaries
   additionally require a reviewed `.quality/quality-dependencies.json`. Review
   generated detection; do not treat it as architecture intent.
4. Configure non-mutating check commands as JSON argument arrays. Use
   `["bash", "-lc", "..."]` only when a check truly requires pipes, globbing,
   command substitution, or another shell feature.
5. Run `--fast` until every executed check is green, then run without `--fast`.
   Put that exact full command in CI. Never make CI and local development use
   different thresholds.

## Configure each quality area

### 1. Formatter and lint

Install the repository's formatter and linter as pinned development tools. Add
check-mode commands under `format_lint.commands`; commands must report drift and
must not rewrite files. Prefer existing project scripts when they already cover
the full production scope.

- Python: Ruff (`ruff format --check .`, `ruff check .`) or the repository's
  established Black/isort/linter combination.
- JavaScript/TypeScript: Prettier check plus ESLint, usually through package
  scripts such as `format:check` and `lint`.
- Go: a check around `gofmt -l` plus `go vet` or the established linter.
- Rust: `cargo fmt --check` and `cargo clippy --all-targets --all-features
  -- -D warnings`.

### 2. Static types

Use the strictest mode the repository currently promises and include every
production package. Configure `types.commands`; do not silently narrow it to the
changed file because unchanged callers must still type-check.

- Python: mypy or pyright with repository-owned configuration.
- TypeScript: `tsc --noEmit` against the production `tsconfig`.
- Go and Rust: the normal compile/check command (`go test`/`go vet`, `cargo
  check --all-targets --all-features`) can serve as the type gate when it covers
  the complete build.

### 3. Contracts and schemas

Commit schemas and compatibility policy. The runner automatically discovers
OpenAPI documents and `*.schema.json`; install the matching validator or add
repository-specific commands under `contracts.commands`. Add consumer/provider,
database migration, protobuf, GraphQL, or generated-client compatibility checks
when those are real public contracts. A syntax-only schema check is insufficient
when compatibility is the actual promise.

### 4. Tests, coverage, and complexity

Set `test.command` to one deterministic command that runs the complete required
suite and exits nonzero on any failure. Install the coverage provider that
matches the test runner. Prefer a supported report (Coverage.py JSON, Istanbul
JSON, LCOV, Cobertura/JaCoCo XML, or Go cover profile); otherwise configure a
normalized `metrics.command` and `metrics.report` containing every production
function.

The numeric goals live only in `.quality/quality-thresholds.json`:
`metrics.coverage_limit`, `metrics.complexity_limit`, and
`metrics.craap_limit`. The default requires 100% executable-line coverage,
cyclomatic complexity at most 6, and CRAAP at most 6 per function. Do not use
file-average coverage or omit hard functions from an adapter report.

### 5. Dead code

Install and configure a high-confidence detector, then place its complete command
under `dead_code.commands`. Use the repository's public-entrypoint and framework
configuration to avoid false positives; do not add broad exclusions merely to
make it green.

- Python: Vulture with an intentional minimum confidence and explicit source
  roots.
- JavaScript/TypeScript: Knip or the repository's established unused-export
  checker.
- Other ecosystems: use the language's maintained unused-code analyzer or a
  normalized project script.

### 6. Flaky-test detection

Make the baseline suite deterministic first: isolated temporary state, controlled
clocks/randomness, unique ports, awaited background work, and cleanup that runs
on failure. The full gate repeats `test.command`; the repeat count is
`flaky_tests.runs` in `.quality/quality-thresholds.json` (default 3). Do not use retries,
quarantine, or order randomization as a substitute for fixing known flakes.

### 7. Mutation testing

Set `mutation.test_command` to the real assertion-bearing test command. For
Vitest, install the Stryker core and Vitest runner versions documented by the
quality loop; a dedicated `vitest.mutation.config.*` may select fast unit tests,
but the separate baseline command must still run the complete suite. Other
stacks use the portable mutation engine unless a normalized adapter is
configured. The final run must be uncapped, and every in-scope mutant must be
killed.

### 8. Module boundaries

Create `.quality/quality-dependencies.json` from intended architecture, not current
imports. Every production file must match exactly one named module. For every
module, declare the modules it may import and explicit denied directions where
useful. The built-in checker handles common imports; configure
`dependencies.command` plus `dependencies.edges_report` for unsupported syntax.
Prove one deliberately forbidden edge fails before trusting the CI rule.

## File LOC

File LOC requires no external tool. The runner counts physical lines in every
selected production source file, including code, comments, and blank lines.
`file_loc.max_lines` in `.quality/quality-thresholds.json` defaults to 600. A failure is
a design prompt to split cohesive responsibilities while preserving behavior;
never minify code, remove useful documentation, or exclude a file to evade it.

## Verify the environment

Run these in order and retain the generated JSON state and HTML report:

```bash
python3 <skill-directory>/scripts/quality_loop.py --root . --fast --no-install
python3 <skill-directory>/scripts/quality_loop.py --root . --no-install
```

Use `--no-install` for the proof after setup: success then demonstrates that the
repository and CI environment contain every required tool rather than depending
on an ephemeral agent cache. Confirm all configured commands appear in command
evidence, all applicable gates pass, thresholds in `.quality/quality-gate-state.json`
match `.quality/quality-thresholds.json`, and the full command exits 0. If a gate is
`NOT APPLICABLE` but the repository needs it, add its command and set its
`required` flag in `.quality/quality-gate.json`.
