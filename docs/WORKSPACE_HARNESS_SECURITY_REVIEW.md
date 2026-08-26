# Workspace Harness Security Review

Date: 2026-08-26

## Result

The main safety layers are implemented and tested, but this review does **not** approve General Availability.

The following two high-priority issues must be fixed or explicitly accepted by the release owner:

1. Cloud Privacy keeps the real relative file and folder names. A protected value inside a name can therefore reach a cloud provider.
2. Native provider errors and standard-error output can reach normalized failure events without a central secret scrubber.

The detailed risks and recommended fixes are listed below.

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
| Symlink escape | Managed operations reject existing symlink segments; native direct mode refuses any exposed workspace symlink | `securityReview.test.ts`, `workspace.test.ts`, `seatbelt.test.ts` | Pass with TOCTOU residual risk |
| Native file escape | Direct mode runs only after a real sandbox canary proves room access, private-directory denial, and sibling denial | `seatbelt.test.ts` | Pass on supported macOS hosts |
| Unprotected fallback writes | Legacy Codex and Claude fallback modes use an empty read-only workspace and Room MCP only | `legacyCli.test.ts` | Pass |
| Shell-tool escape in fallback | Codex shell tools and web search are disabled; Claude receives no native tools and only the strict Room MCP config | `legacyCli.test.ts` | Pass for model tool access |
| Child process left after Stop | Native launchers use a process group; Stop sends a signal to the complete group | `seatbelt.test.ts` starts a real grandchild and proves it exits | Pass with escalation residual risk |
| Cloud text leak | File content and extracted text are redacted before writing; inline image data is removed | `securityReview.test.ts`, `cloudMirror.test.ts` | Pass for content, not names |
| Cloud binary leak | Original binary and image files are not copied; only redacted text companions or stubs are exposed | `securityReview.test.ts`, `cloudMirror.test.ts` | Pass |
| Placeholder corruption | Unknown or damaged protected tokens are rejected; duplication requires review; restoration happens locally | `securityReview.test.ts`, `cloudMirror.test.ts` | Pass |
| Mirror path escape | Runtime must be outside the room; room and run IDs use a strict safe character set | `securityReview.test.ts` | Pass |
| Mirror residue | Run folders use private modes, normal completion removes them, and startup removes abandoned runs | `cloudMirror.test.ts`, `controller.ts` | Pass with crash-window residual risk |
| MCP bearer token in command line | Codex receives only the environment-variable name, not the value | `legacyCli.test.ts` | Pass |
| Root and child-run cancellation | Delegated children inherit parent cancellation; Python cancellation uses a shared cancellation tree | `legacyCli.test.ts`, `sidecar/tests/test_server.py`, `sidecar/tests/test_deep_harness.py` | Pass with escalation residual risk |

## Important Open Risks

### 1. Protected values in file and folder names — High

The cloud mirror preserves relative paths. Binary companion files also include the original path in their text. Content redaction does not redact path components.

Example: a file named `Contracts/Ben Reich.pdf` can expose `Ben Reich` even when the PDF text is fully redacted.

Required release action:

- Create opaque or redacted cloud path names.
- Keep the reverse path map only in trusted Arcelle memory or encrypted state.
- Validate names on write-back in the same way as content placeholders.
- Add an acceptance test that scans provider-visible paths and file bytes for every protected value.

Do not enable `cloud_redacted_mirror` for sensitive rooms until this is fixed or the release owner records a clear risk acceptance.

### 2. Unsanitized provider failure text — High

Codex app-server standard error and raw exception messages can become `run_failed` event text. The legacy CLI also forwards standard error on a failed exit. A provider or tool can include file content, credentials, absolute paths, or protected values in that text.

No direct `console` logging of room content was found in the reviewed harness modules. However, forwarding raw failure text to the UI or run history is still a secret-leak path.

Required release action:

- Add one central failure sanitizer before events reach the UI, database, telemetry, or logs.
- Apply privacy redaction and credential-pattern filtering.
- Store a short safe error code separately from local diagnostic details.
- Never persist provider standard error by default.
- Add tests with fake API keys, room content, passwords, and protected values in provider errors.

### 3. Symlink check/use race — Medium

Arcelle checks path segments with `lstat` and then performs the filesystem action. Another local process with access to the room can replace a checked directory with a symlink between those steps. Native direct mode reduces this risk by refusing exposed symlinks before launch, but normal managed operations still use a check-then-use design.

Recommended fix:

- Use descriptor-relative operations with no-follow semantics where the operating system supports them, or reopen and verify file identity immediately before commit.
- Reject a workspace root that is itself a symlink in the managed Workspace Service, not only in native direct mode.
- Revalidate parent identity after atomic rename.

### 4. Cancellation has no forced-kill escalation — Medium

Native cancellation sends `SIGTERM` to the provider process group. The normal test proves a cooperative shell and its grandchild exit. A hostile or stuck process can ignore `SIGTERM`. Controller shutdown has a timeout, but it does not prove the process is gone before cleanup continues.

Recommended fix:

- Send `SIGTERM`, wait for a short grace period, then send `SIGKILL` to the same process group.
- Confirm exit before releasing the write lease or deleting the runtime.
- Add a test with a child that traps and ignores `SIGTERM`.

### 5. Provider executable and network trust — Medium

The macOS Seatbelt profile protects local file locations. It does not provide a strict network allowlist. Provider-level settings disable model shell/web tools where required, but the installed Codex or Claude executable must still be trusted because the executable itself can use its cloud connection.

Recommended fix:

- Document the provider executable as part of the trusted computing base.
- Pin or verify supported executable versions.
- Add an application-level outbound destination policy if strict provider endpoint control is required.

### 6. Crash residue window — Low

Runtime folders use mode `0700`; mirror files and Claude MCP configuration use mode `0600`. Normal completion removes them and the next application start removes abandoned folders. A hard crash can leave private runtime state on disk until that cleanup runs.

Recommended fix:

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

`npm run typecheck` was also run. It was blocked by an unrelated, concurrent type error in `harness/controller.ts` around the optional `baseDispatcher` type. This security-review change does not edit that implementation file.

The cancellation and authentication evidence is covered by:

```sh
pytest -q sidecar/tests/test_server.py sidecar/tests/test_deep_harness.py
```

The focused Python command was attempted in the system Python environment, but collection could not start because the optional `fastapi` and `deepagents` packages were not installed. The referenced tests are existing evidence; they must be rerun in the configured sidecar environment before release.

## Release Decision

This review closes the audit work, not the release gate. General Availability should remain disabled until the two High risks are fixed or explicitly accepted, the focused tests are rerun, and the full release suite passes.
