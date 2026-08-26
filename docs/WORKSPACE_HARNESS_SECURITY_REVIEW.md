# Workspace Harness Security Review

Date: 2026-08-26

## Result

The reviewed security layers are implemented and tested. No open High finding remains in this review.

Security verdict: **Pass with documented residual risks.** The release owner accepts the remaining Medium and Low risks described below. All separate release gates passed and General Availability defaults are enabled.

## Scope

This review checked:

- Relative path traversal and absolute paths.
- Windows drive and network paths on macOS.
- Private `.arcelle` access.
- Symlink escape.
- Native shell and child-process escape.
- Cloud redaction and temporary mirror cleanup.
- Secret handling in arguments, errors, and logs.
- Cancellation of root runs, specialists, and native process trees.

This was a source-code and automated-test review. It was not an external penetration test.

## Control and Evidence Matrix

| Threat | Implemented control | Test evidence | Result |
|---|---|---|---|
| `..` path traversal | `normalizeRelativePath` rejects every `..` path component | `securityReview.test.ts`, `workspace.test.ts` | Pass |
| Absolute path escape | POSIX, platform, Windows drive, and UNC paths are rejected | `securityReview.test.ts`, `workspace.test.ts` | Pass |
| `.arcelle` access | The first component is blocked without case sensitivity; the native Seatbelt profile also has a final private-directory deny | `securityReview.test.ts`, `seatbelt.test.ts` | Pass |
| Symlink escape | Managed operations reject a symlink root and existing symlink segments; native direct mode refuses any exposed workspace symlink | `securityReview.test.ts`, `workspace.test.ts`, `seatbelt.test.ts` | Pass with TOCTOU residual risk |
| Native file escape | Direct mode runs only after a real sandbox canary proves room access, private-directory denial, and sibling denial | `seatbelt.test.ts` | Pass on supported macOS hosts |
| Unprotected fallback writes | Legacy Codex and Claude fallback modes use an empty read-only workspace and Room MCP only | `legacyCli.test.ts` | Pass |
| Shell-tool escape in fallback | Codex shell tools and web search are disabled; Claude receives no native tools and only the strict Room MCP config | `legacyCli.test.ts` | Pass for model tool access |
| Child process left after Stop | Native launchers use a process group; Stop sends `SIGTERM`, then `SIGKILL` after a grace period | `seatbelt.test.ts` proves both descendant cleanup and forced termination of a process that ignores `SIGTERM` | Pass |
| Cloud text or path leak | File content, extracted text, and each relative-path component are redacted before writing; inline image data is removed; the real path map remains in trusted process memory | `securityReview.test.ts`, `cloudMirror.test.ts` | Pass |
| Cloud binary leak | Original binary and image files are not copied; only redacted text companions or stubs are exposed | `securityReview.test.ts`, `cloudMirror.test.ts` | Pass |
| Placeholder corruption | Unknown or damaged protected tokens are rejected; duplication requires review; restoration happens locally | `securityReview.test.ts`, `cloudMirror.test.ts` | Pass |
| Mirror path escape | Runtime must be outside the room; room and run IDs use a strict safe character set | `securityReview.test.ts` | Pass |
| Mirror residue | Run folders use private modes, normal completion removes them, and startup removes abandoned runs | `cloudMirror.test.ts`, `controller.ts` | Pass with crash-window residual risk |
| MCP bearer token in command line | Codex receives only the environment-variable name, not the value | `legacyCli.test.ts` | Pass |
| Root and child-run cancellation | Delegated children inherit parent cancellation; Python cancellation uses a shared cancellation tree; native process groups have forced-kill escalation | `legacyCli.test.ts`, `seatbelt.test.ts`, `sidecar/tests/test_server.py`, `sidecar/tests/test_deep_harness.py` | Pass |
| Provider error or stderr leak | Provider stderr is drained but not retained; Electron and Python provider, tool, workspace-bridge, delegated MCP, and finalization failures use bounded safe messages | `failureSafety.test.ts`, `legacyCli.test.ts`, `deepAgentRuntime.test.ts`, `sidecar/tests/test_deep_harness.py`, `codexAppServer.test.ts`, `orchestrator.test.ts` | Pass |

## Closed Finding

### Protected values in file and folder names — Fixed

Commit `2b06156` redacts each provider-visible file and folder name, resolves redacted-name collisions, and keeps the real-to-mirror path mapping in trusted process memory. Binary companion files now contain only the redacted mirror path.

The adversarial privacy test now creates a binary file with a protected value in its filename, then scans every provider-visible relative path and every mirror file byte. The protected value, original binary, inline image data, and `.arcelle` state are absent.

Focused verification after the fix:

- `securityReview.test.ts`
- `cloudMirror.test.ts`
- `controller.test.ts`
- 23 tests passed.

### Provider and tool diagnostics — Fixed

Commits `1f38990` and `31aebc6` contain untrusted failure data at every reviewed harness boundary:

- Codex and legacy CLI standard error is drained but never retained.
- Codex, Claude, Deep Harness, and legacy CLI failures use bounded messages created without raw diagnostic input.
- Failed Codex and Deep Harness tool events do not include provider error text.
- Delegated specialists and base MCP tool exceptions return safe tool failures before data can go back to a cloud provider.
- Cloud write-back and post-run reconciliation errors use safe stage-specific messages.

The affected tests include fake protected names, bearer tokens, absolute paths, and raw standard error, and prove these values are absent from normalized failures and MCP results.

### Forced native process termination — Fixed

Commit `4f2a2e2` keeps process-group `SIGTERM` as the normal stop path and schedules `SIGKILL` after a grace period. The test uses a real child that ignores `SIGTERM` and proves forced termination succeeds.

## Important Open Risks

### 1. Symlink check/use race — Medium

Arcelle checks path segments with `lstat` and then performs the filesystem action. Another local process with access to the room can replace a checked directory with a symlink between those steps. Native direct mode reduces this risk by refusing exposed symlinks before launch, but normal managed operations still use a check-then-use design.

Accepted residual and future hardening:

- Use descriptor-relative operations with no-follow semantics where the operating system supports them, or reopen and verify file identity immediately before commit.
- Workspace roots are now rejected when they are symlinks. Descriptor-relative no-follow operations remain future hardening for the smaller check/use window.
- Revalidate parent identity after atomic rename.

### 2. Provider executable and network trust — Medium

The macOS Seatbelt profile protects local file locations. It does not provide a strict network allowlist. Provider-level settings disable model shell/web tools where required, but the installed Codex or Claude executable must still be trusted because the executable itself can use its cloud connection.

Accepted trust boundary and future hardening:

- Document the provider executable as part of the trusted computing base.
- Pin or verify supported executable versions.
- Add an application-level outbound destination policy if strict provider endpoint control is required.

### 3. Crash residue window — Low

Runtime folders use mode `0700`; mirror files and Claude MCP configuration use mode `0600`. Normal completion removes them and the next application start removes abandoned folders. A hard crash can leave private runtime state on disk until that cleanup runs.

Accepted residual and future hardening:

- Keep startup cleanup mandatory and run it before accepting new harness work.
- Consider an operating-system protected temporary location and short expiry.
- Verify cleanup failure is visible to the user instead of silently ignored.

## Verified Design Boundaries

- The Python sidecar uses the trusted bridge and does not receive unrestricted room paths or SQLCipher keys.
- Current files remain normal plaintext files by product design. The room password protects Arcelle private state, not the live workspace files.
- The native sandbox test is a runtime capability gate. Unsupported or failed hosts must use the restricted MCP fallback.
- Hooks and provider events are fast signals, not the final boundary. Baseline objects, manifest reconciliation, optimistic hashes, and rollback remain required.

## Commands Run

From `electron-migration/electron-app`:

```sh
npx vitest run electron/main/harness/securityReview.test.ts electron/main/harness/legacyCli.test.ts electron/main/harness/seatbelt.test.ts electron/main/workspace/workspace.test.ts electron/main/workspace/hardeningAcceptance.test.ts
```

Result at review time: 5 test files passed, 42 tests passed. A concurrent harness test was then added to the same focused set; the post-commit harness rerun passed 26 tests across the three harness test files.

`npm run typecheck` also passed after the concurrent harness integration work settled.

After the path, failure-containment, and forced-cancellation fixes, this affected security suite was rerun:

```sh
npx vitest run electron/main/harness/securityReview.test.ts electron/main/harness/failureSafety.test.ts electron/main/harness/legacyCli.test.ts electron/main/harness/deepAgentRuntime.test.ts electron/main/harness/codexAppServer.test.ts electron/main/harness/orchestrator.test.ts electron/main/harness/cloudMirror.test.ts electron/main/harness/controller.test.ts electron/main/harness/seatbelt.test.ts
```

Result: 9 test files passed, 51 tests passed. `npm run typecheck` also passed after this run.

The cancellation and authentication evidence is covered by:

From `sidecar`:

```sh
.venv/bin/python -m pytest -q tests/test_server.py tests/test_deep_harness.py
```

Result: 43 tests passed. Five third-party SWIG deprecation warnings were reported.

Final release validation:

- Complete Electron suite: 248 test files passed, with 6,436 tests passed and 8 environment-specific tests skipped.
- Complete Python sidecar suite: 2,663 tests passed and 6 environment-specific tests skipped.
- Production Electron build and TypeScript checks passed.
- Live local Deep Harness acceptance passed with `qwen3.5:4b-mlx`, loopback-only networking, workspace MCP access, one final answer, and cancellation.
- Installed Codex and Claude CLI cancellation and process-tree cleanup tests passed.

## Release Decision

Security verdict: **approved for General Availability.** The release owner accepts the managed-path symlink check/use race, the installed provider executable/network trust boundary, and the short crash-residue window. Mitigations remain mandatory: native symlink/root rejection, runtime sandbox probes, restricted fallbacks, encrypted baselines, reconciliation, rollback, private runtime permissions, and startup cleanup. The complete Electron, Python, live local-model, migration, performance, packaging, and parity gates passed before the GA defaults were enabled.
