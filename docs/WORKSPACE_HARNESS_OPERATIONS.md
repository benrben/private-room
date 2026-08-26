# Workspace Rooms: Upgrade, Rollback, Support, and Recovery

This guide is for support, QA, and release operators.

It uses simple technical English. It does not contain passwords, keys, file content, or protected privacy values.

## 1. What a workspace room contains

A workspace room is a normal folder.

```text
Project/
├── normal-user-files
└── .arcelle/
    ├── room.json
    ├── room.db
    ├── objects/
    ├── tmp/
    └── room.lock
```

Normal files are the source of truth for current content.

The password protects `room.db`, private history objects, chats, memory, search data, and agent history. It does not encrypt the normal current files.

Never tell a user that locking Arcelle hides the normal files from Finder.

## 2. Upgrade procedure

Before enabling workspace rooms for a release:

1. Run the complete Electron and Python test suites.
2. Check `WORKSPACE_HARNESS_TASKS.md`. Do not enable general availability while a release gate is open.
3. Keep legacy room support enabled.
4. Keep conversion opt-in. Never convert a room automatically.
5. Enable feature flags in rollout order.
6. Start with internal rooms, then test users, then general users.
7. Check provider capability diagnostics on the signed application build.

Required feature flags:

- `workspace_rooms_v2`
- `workspace_conversion`
- `sealed_export_v2`
- `unified_harness`
- `codex_app_server`
- `claude_agent_sdk`
- `deep_agent_harness`
- `cloud_redacted_mirror`

A provider is available only when its installed runtime probe and sandbox self-test pass.

## 3. Safe feature rollback

Feature rollback must not change user files.

To roll back a feature rollout:

1. Stop new workspace creation or the affected harness with its feature flag.
2. Keep existing workspace folders readable.
3. Keep `BlobContentStore` support for old rooms.
4. Do not move normal files back into `files.original_bytes`.
5. Do not delete `.arcelle/objects`; checkpoints, versions, and agent rollback may still reference them.
6. Ask users to create a sealed backup before installing an older Arcelle version.

An older application that does not understand workspace format version 2 must refuse the room. It must not try to repair or downgrade it.

## 4. Legacy conversion recovery

Legacy conversion keeps the source room unchanged.

If conversion stops:

1. Keep the original `.arcelle` or `.roomai` file.
2. Do not rename the temporary workspace by hand.
3. Start conversion again with the same source and destination.
4. Let the migration journal resume completed file exports.
5. Review the conversion report for renamed collisions and skipped entries.
6. Use the new workspace only after count, size, and SHA-256 validation succeeds.

If conversion cannot resume, remove only the named temporary destination after confirming the original legacy room still opens. Never remove the source room.

## 5. Room does not open

Check these conditions in order:

1. Confirm the selected path is the outer room folder.
2. Confirm `.arcelle/room.json` exists and has a supported format version.
3. Confirm the password is correct.
4. Check whether another Arcelle process owns the writer lease.
5. Check whether this is a raw Finder copy with a duplicate room ID.
6. Try read-only open when the lease or duplicate identity blocks writing.
7. Check the private database. Do not edit it with a normal SQLite tool.

If `room.db` is damaged, normal files are still normal files. Copy the outer folder before attempting private-state recovery.

## 6. Writer lease problems

Only one writer is allowed.

- A same-device live process keeps write ownership.
- A fresh lease from another device opens read-only.
- An expired remote lease can be recovered.
- A raw Finder copy opens read-only until the user registers it as a new copy.

Do not delete `room.lock` while another Arcelle process may be running. Confirm process and device ownership first.

## 7. Interrupted filesystem operation

On unlock, Arcelle marks incomplete journal operations as failed and runs a full reconciliation.

The normal filesystem is the final truth. Support must not guess whether an incomplete database row means a file should be deleted or overwritten.

Safe steps:

1. Close all Arcelle processes for the room.
2. Make a copy of the outer room folder.
3. Open the room once.
4. Run “Rescan room”.
5. Check watcher health and index errors.
6. Compare the normal file with the expected user copy.

## 8. Checkpoint restore

Checkpoint restore uses a verified sibling workspace.

1. Close the active room.
2. Restore into a temporary sibling.
3. Verify every hash.
4. Rename the current room to a recoverable backup.
5. Rename the restored room into place.
6. Reopen and reconcile.
7. Keep the backup until the user confirms the restore.

Never write checkpoint bytes directly over an open room.

## 9. Agent run rollback

Every write-enabled native run needs a complete encrypted baseline.

Rollback behavior:

- Created files move to Arcelle Trash.
- Deleted files are restored.
- Renames are reversed.
- Modified files use encrypted baseline objects.
- A later user edit is never overwritten automatically.
- Conflicts can be restored as a separate copy.

If baseline creation failed, the run was not allowed to write. Use read-only mode.

## 10. Cloud Privacy support

With Cloud Privacy on, a cloud provider receives a temporary redacted mirror.

The mirror must not contain:

- `.arcelle`
- `room.db`
- private objects
- original binary files
- the placeholder reverse map

Arcelle deletes mirrors after success, failure, cancellation, and application restart cleanup.

If cleanup was interrupted, close Arcelle and remove only abandoned run folders under the named `Arcelle Runtime/<room-id>/<run-id>` location. Do not remove a whole user-data folder.

## 11. Provider troubleshooting

If a native harness is unavailable:

1. Check that the provider CLI is installed.
2. Check the installed version and capability report.
3. Run the provider sandbox self-test.
4. Check for symlinks in the exposed workspace.
5. Use the restricted compatibility adapter when available.
6. Never enable permission-bypass or dangerous approval modes.

Local Ollama uses the controlled workspace backend. It does not receive database keys or unrestricted paths.

## 12. Safe support report

A support report may include:

- Arcelle version
- macOS version
- room format version
- feature-flag state
- provider name and capability status
- watcher health state
- index state counts
- journal phase and error category
- file counts and byte counts
- test or operation timestamps

A support report must not include:

- password or recovery code
- encryption key or token
- file bytes or extracted text
- chat or memory content
- protected privacy values
- cloud placeholder reverse maps
- unrestricted absolute user paths

Use counts, stable error codes, and redacted path labels.

## 13. Final safety rules

- Preserve normal files first.
- Make a copy before recovery.
- Never convert automatically.
- Never overwrite a later user edit during rollback.
- Never expose `.arcelle` to an agent.
- Never claim general availability while release gates remain open.
