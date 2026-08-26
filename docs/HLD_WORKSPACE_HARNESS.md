# HLD: File-Based Rooms and Unified Agent Harness

Status: implementation design and rollout contract
Primary platform: macOS
Language: simplified technical English

## 1. Goal

Arcelle rooms use a hybrid storage design.

- Current documents are normal files and folders.
- Private Arcelle state stays in an encrypted SQLCipher database.
- Private old file versions stay in an encrypted object store.
- Legacy database rooms still work.
- Every AI provider uses one common harness contract.

This design keeps the features that exist today. It also lets native CLI agents work with normal files in a safe and recoverable way.

## 2. Room layout

```text
Customer Project/
├── contract.pdf
├── notes.md
├── Research/
│   └── market.xlsx
└── .arcelle/
    ├── room.json
    ├── room.db
    ├── objects/
    ├── tmp/
    └── room.lock
```

Files outside `.arcelle` belong to the user. Finder and other applications can open them when Arcelle is closed.

`.arcelle` belongs only to Arcelle. Agents, renderers and normal file tools must not read or write it.

`room.json` is public and small. It contains only:

```json
{
  "format": "arcelle-workspace",
  "formatVersion": 2,
  "roomId": "a-random-room-id"
}
```

`room.db` is encrypted with SQLCipher. `objects/` contains encrypted, immutable history objects. Object names are random IDs. They do not contain file names or content hashes.

## 3. Source of truth

| Data | Source of truth |
|---|---|
| Current file bytes | Filesystem |
| Current file names and folders | Filesystem |
| Stable Arcelle file ID | Encrypted database |
| Extracted text and chunks | Encrypted database |
| Full-text search and embeddings | Encrypted database |
| Chats, messages and memory | Encrypted database |
| Privacy rules and scan results | Encrypted database |
| Jobs, workflows and skills | Encrypted database |
| Agent runs and audit state | Encrypted database |
| Old versions and rollback bytes | Encrypted object store |
| Cloud-safe temporary files | Redacted runtime mirror |
| Portable backup | Sealed `.arcelle` database file |

A workspace file row must have `storage_kind = 'workspace'`, a relative path, and `original_bytes = NULL`.

A legacy room file keeps `storage_kind = 'blob'` and may keep current bytes in `original_bytes`.

## 4. How a file is saved and loaded

### 4.1 Save a new file

1. The renderer sends content or a selected import path to the main Electron process.
2. `WorkspaceService` validates the relative path.
3. It rejects absolute paths, `..`, `.arcelle` and symlink segments.
4. It creates an operation-journal row with phase `prepared`.
5. It writes a temporary file in the destination folder.
6. It flushes the temporary file.
7. It renames the temporary file to the final name.
8. It saves the file ID, relative path, size, hash and filesystem identity in `room.db`.
9. It marks the search index as `pending` or `stale`.
10. It completes the journal row.

The final path never contains a partly written file.

### 4.2 Load a file

1. The UI asks for a stable `fileId`.
2. The `ContentStore` finds the row.
3. `BlobContentStore` reads legacy bytes from SQLCipher.
4. `WorkspaceContentStore` resolves the saved relative path under the room root.
5. The main process streams the bytes to the viewer or tool.

The renderer and Python sidecar do not receive the SQLCipher key. The Python sidecar also does not receive an unrestricted absolute path.

### 4.3 Save an edit

1. Arcelle compares the expected SHA-256 with the current file.
2. If they differ, Arcelle returns a conflict. It does not overwrite the file.
3. Arcelle saves an encrypted baseline object for version history.
4. Arcelle performs the atomic write.
5. Arcelle updates metadata and schedules extraction.

### 4.4 External edit or rename

Filesystem watcher events are hints. They are not final truth.

Arcelle runs a full manifest scan after unlock, after a native agent run, after watcher errors, before packaging, and on a timer. This is needed because operating-system file watchers can miss or combine events. See the [Node filesystem watcher notes](https://nodejs.org/api/fs.html#fswatchfilename-options-listener) and [Chokidar documentation](https://github.com/paulmillr/chokidar).

Arcelle keeps the same file ID when it can prove a rename by filesystem identity and hash. Hash-only rename matching is allowed only when there is one possible source and one possible destination. Arcelle never guesses between identical files.

## 5. Main components

```text
React UI
   |
Electron IPC compatibility layer
   |
   +-- Room Manager
   +-- Workspace Service
   +-- Content Store
   +-- Extraction and Index Service
   +-- Version and Rollback Service
   +-- Privacy Mirror Service
   +-- Harness Orchestrator
          |
          +-- Codex app-server driver
          +-- Claude Agent SDK driver
          +-- Arcelle Deep Harness
                 +-- Ollama local
                 +-- Ollama cloud
                 +-- OpenRouter
```

### Room Manager

The Room Manager detects a legacy file or workspace folder. It opens the correct database, owns the password, acquires the one-writer lease, starts recovery and reconciliation, and releases all private state on lock.

Room display name follows the outer workspace folder name. Legacy room display names continue to use encrypted metadata.

### Workspace Service

This is the only trusted Arcelle service that changes normal room files. It owns path validation, atomic writes, imports, moves, trash, restore, reconciliation and the operation journal.

### Content Store

All higher layers use one interface:

```ts
interface ContentStore {
  enumerate(): AsyncIterable<ContentEntry>;
  stat(fileId: string): Promise<ContentStat>;
  readStream(fileId: string): Promise<Readable>;
  writeAtomic(fileId: string, content: Readable, expectedHash?: string): Promise<WriteResult>;
  importFile(sourcePath: string, destination: string): Promise<ContentEntry>;
  move(fileId: string, destination: string, expectedHash?: string): Promise<void>;
  trash(fileId: string, expectedHash?: string): Promise<void>;
  restore(fileId: string, destination?: string): Promise<void>;
  createSnapshot(fileId: string): Promise<ContentObjectRef>;
}
```

`BlobContentStore` keeps old rooms working. `WorkspaceContentStore` uses normal files.

### Extraction and index service

The indexer reads a stable file, calculates SHA-256, extracts text, creates chunks, and updates FTS and embeddings. It commits only when the source hash is still current. A failed extraction never changes the normal file.

Index states are `pending`, `ready`, `stale`, `offline`, `unsupported` and `failed`.

## 6. Database changes

The `files` table adds:

- `storage_kind`
- `relative_path`
- `path_key`
- `content_sha256`
- `mtime_ns`
- `fs_identity`
- `index_state`
- `index_error`
- `last_seen_at`

Absolute workspace paths are not stored in file rows.

### Encrypted content objects

`content_objects` stores encrypted object metadata. `content_object_refs` connects objects to file versions, trash records, checkpoints and agent runs.

Objects use authenticated AES-256-GCM encryption with a random per-room key. That key is stored only inside SQLCipher. Encryption and decryption are streamed. Deduplication uses the plaintext SHA-256 stored inside SQLCipher.

Objects are immutable. Garbage collection removes only objects that have no reachable reference.

### Filesystem operation journal

`fs_operations` records:

1. `prepared`
2. `filesystem_committed`
3. `database_committed`
4. `completed`
5. `failed`

Startup marks incomplete work for reconciliation. It does not guess a destructive repair.

### Agent run history

`agent_runs` records provider, harness, model, privacy mode, status and rollback state.

`agent_run_files` records the path, hash and encrypted baseline object before a write run, plus the final path and hash after the run.

## 7. Password and lock behavior

The password protects chats, memory, metadata, indexes, workflows, agent history, file history and deleted-file recovery.

The password does not encrypt the current normal files. The unlock UI must state this clearly.

On lock Arcelle:

- cancels agent and index work;
- stops the watcher;
- closes SQLCipher;
- removes private keys and decrypted caches from memory;
- deletes redacted mirrors;
- releases the writer lease.

Normal files stay visible in Finder. Arcelle reconciles them after the next unlock.

Password change rekeys SQLCipher and the recovery wrapper. It does not rewrite all encrypted objects because their random key is stored inside SQLCipher.

## 8. Room lifecycle

### Create

Arcelle builds a complete workspace in a sibling temporary folder. It creates `.arcelle`, SQLCipher, the object folders and public marker. It validates the result and atomically renames the temporary folder to the final name.

### Open

Arcelle reads the public marker, acquires the lease, asks for the password, opens SQLCipher, recovers journal state, reconciles normal files, and starts the watcher.

Only one writable Arcelle process may own a room. Read-only multi-process opening is a separate rollout gate.

### Trash and restore

Arcelle Trash creates an encrypted recovery object before it removes a normal file. External deletion is marked `offline`. It is recoverable only when another baseline or version exists.

### Recordings and generated output

Final recordings, accepted generated artifacts, downloads and workflow results are normal files. Transcripts, speakers, chunks, provenance and job state remain in SQLCipher.

## 9. Packaging, checkpoints and conversion

A sealed `.arcelle` export is one encrypted database containing a consistent database snapshot, every current file, required history objects and an integrity manifest.

The packager pauses mutations, builds a temporary export, verifies hashes and decryption, flushes it, and then publishes it atomically. SQLite provides a consistent [online backup API](https://www.sqlite.org/backup.html). SQLCipher provides encrypted export operations in its [API documentation](https://www.zetetic.net/sqlcipher/sqlcipher-api/).

Checkpoints use the same packager. Restore builds a temporary sibling workspace, verifies it, renames the current room to a recoverable backup, and publishes the restored folder.

Legacy conversion is explicit and resumable. The original legacy room is never changed. Every live blob is streamed to a normal file, verified by SHA-256, and represented in the new database with `original_bytes = NULL`.

## 10. Unified agent harness

Every provider implements this contract:

```ts
interface HarnessRuntime {
  startTurn(context: HarnessContext, input: HarnessInput): Promise<HarnessRun>;
  approve(runId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  cancel(runId: string): Promise<void>;
  rollback(runId: string): Promise<RollbackResult>;
}
```

Normalized events include run start, agent start, plan updates, text deltas, tool requests, approvals, tool start/end, file changes, usage, failures and completion.

The UI reads only normalized events.

The live Electron controller owns room-derived paths. A renderer can choose a
provider, model, privacy mode and write permission, but it cannot supply an
absolute workspace path. The controller publishes normalized events on one
typed `harness-event` channel and keeps provider-specific output out of the UI.

Provider completion is provisional. Arcelle first applies an approved redacted
mirror write-back, runs the full workspace reconciliation, records final file
hashes, and only then sends the final `run_completed` event. Room lock cancels
and drains harness runs while the encrypted database is still open.

Native direct mode is fail-closed. The outer macOS Seatbelt denies file content
and writes in writable data roots such as `/Users`, `/Volumes`, `/private` and
`/Library`, then adds narrow access only for the selected workspace, one
run-private directory, system runtime files and the provider executable. A more
specific rule always blocks `.arcelle`. Read-only runs receive no workspace
write rule.

Every start creates canaries in the normal workspace, `.arcelle` and a sibling
outside the runtime directory. The sandbox must read the normal canary, obey the
requested write mode, and fail to read or write the other two. Arcelle also
refuses an exposed workspace containing any symlink. Finally, the installed
provider executable must start inside the same profile. Capability reporting is
per provider: one failing provider does not weaken or disable another provider.
A feature flag alone cannot bypass these gates.

### Shared agent manifest

`config/agent-manifest.json` defines all 16 specialists and their graph shape, tools, file permission, model capability, timeout policy, privacy inheritance and instructions. Provider adapters generate their own runtime definitions from this file.

The current eight graph names remain supported: `react`, `supervisor`, `react_verify`, `route_act`, `probe_gate_act`, `perceive_act`, `chain_stage` and `recall_act_check`.

### Codex

The native driver uses Codex app-server JSONL. It performs `initialize`, `thread/start` and `turn/start`, and maps structured notifications and approval requests. It uses workspace-write mode, disables network access, protects `.arcelle`, and runs a sandbox self-test. The text CLI remains a restricted fallback.

The [Codex app-server documentation](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) describes the structured client protocol.

### Claude

The native driver uses the TypeScript Claude Agent SDK. It streams partial messages, uses `canUseTool`, installs pre/post hooks, and enables Claude's strict filesystem and network sandbox. It never uses permission bypass. The restricted CLI remains a fallback.

See the [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) and [Claude hooks](https://code.claude.com/docs/en/hooks).

### Ollama and OpenRouter

The Arcelle Deep Harness adapts Arcelle's model stream to LangChain, adapts the existing compiled specialist graphs to Deep Agents subagents, and exposes normal files through an MCP-backed virtual backend.

The backend never receives database keys or a raw host filesystem root. Arcelle does not use Deep Agents `LocalShellBackend`. Script execution stays behind Arcelle consent and sandbox rules.

Deep Agents supports [custom backends](https://docs.langchain.com/oss/python/deepagents/backends) and [compiled subagents](https://docs.langchain.com/oss/python/deepagents/subagents).

Small models can continue using the deterministic Arcelle graph under the same outer harness contract.

## 11. Write safety and rollback

Before native write access Arcelle:

1. acquires the write lease;
2. completes reconciliation;
3. creates or reuses an encrypted baseline for every normal file;
4. records paths and hashes;
5. proves `.arcelle` is blocked;
6. runs the sandbox escape test.

If any baseline fails, the run stays read-only.

At run end Arcelle performs a complete scan and records created, changed, moved and deleted files. Hooks and provider events are fast hints only.

Rollback restores only when the current file still matches the recorded final hash. Later user edits are never overwritten. Conflicts can restore the baseline as a copy.

## 12. Cloud privacy

With Cloud Privacy enabled, cloud providers receive a temporary redacted mirror, not the real workspace.

The mirror contains redacted text, text companions for structured documents and stubs for unsupported binaries. It contains no `.arcelle`, database, original binary or placeholder reverse map.

Write-back validates every placeholder, restores protected values locally, and applies safe text edits atomically. Structured and binary changes use trusted Arcelle tools.

With Cloud Privacy disabled, the user sees a clear warning. `.arcelle`, baseline and rollback protection still apply.

## 13. Security boundaries

- Reject absolute paths and `..`.
- Block `.arcelle` at the Workspace Service, provider hooks and OS sandbox.
- Never follow symlinks for managed operations.
- Disable native direct mode when isolation cannot be proven.
- Block shell network access. Use approved browser tools.
- Block executable permission changes.
- Do not log passwords, keys, protected values or file contents.
- Keep one workspace writer.
- Treat hooks as hints. Baselines, scans and rollback are the final protection.

## 14. Feature flags and rollout

Flags:

- `workspace_rooms_v2`
- `workspace_conversion`
- `sealed_export_v2`
- `unified_harness`
- `codex_app_server`
- `claude_agent_sdk`
- `deep_agent_harness`
- `cloud_redacted_mirror`

Rollout order: internal workspace rooms, opt-in user rooms, conversion, local Deep Harness, Claude, Codex, redacted cloud mirror, then general availability.

Native mode is enabled only after a capability probe and sandbox self-test pass. Otherwise Arcelle uses its restricted compatibility adapter.

## 15. Acceptance gates

General availability requires:

- every current byte path moved behind `ContentStore`;
- legacy feature parity;
- conversion and sealed-package recovery tests;
- provider parity for streaming, approval, cancellation and usage;
- complete write baselines and conflict-safe rollback;
- cloud-mirror privacy tests;
- power-loss tests for every journal phase;
- path, symlink, Unicode, case and network-drive tests;
- a security review.
