# Part 1 — Trust & Security

The app promises "private and safe". These items make the app actually keep
that promise. This part comes first because a privacy product lives or dies
on trust.

---

## SEC-1 — Ask before running room plug-ins (MCP)

**Goal**
Opening a room file that someone else made must never run programs on this
Mac without the user's clear permission.

**Task**
Before the app starts any plug-in (MCP server) saved inside a room, show an
approval dialog. Remember the approval on this Mac only — not inside the
room file.

**How to do it**
1. Today, `open_room` and `create_room` in `src-tauri/src/commands.rs`
   (~line 543) call `refresh_mcp`, which immediately spawns every server
   that is not marked `"disabled": true`. This is the hole.
2. Compute a fingerprint (SHA-256 hash) of the room's `mcp_config` JSON.
3. Keep a small list of approved fingerprints in the app's own data folder
   (outside the room — the room's author is the attacker in this story).
4. On room open: if the config has enabled servers and its fingerprint is
   not on the approved list, do NOT start anything. Show a dialog listing
   each server name and the exact command line it wants to run, with
   "Allow" and "Keep off" buttons.
5. "Allow" saves the fingerprint and starts the servers. "Keep off" leaves
   them stopped (show them as "blocked" in Settings).
6. If the config text changes, the old approval no longer counts — ask again.
7. Saving a config from the Settings screen inside an open session counts
   as approval (the user just typed it).

**How to check it**
1. Make a room, add an enabled MCP server in Settings, close the room.
2. Reopen it → the dialog must appear BEFORE anything runs (watch Activity
   Monitor: no `uvx`/server process until you click Allow).
3. Click "Keep off" → room works normally, chat works, tools stay off.
4. Reopen and click "Allow" → servers start. Reopen again → no dialog
   (remembered).
5. Change one character in the config → dialog appears again.
6. A room whose only server has `"disabled": true` → no dialog.

**Acceptance criteria**
- [ ] No process is ever started from a newly opened room before the user clicks Allow.
- [ ] Approvals are stored per Mac, never inside the `.roomai` file.
- [ ] Any change to the config invalidates the old approval.
- [ ] Declining keeps the room fully usable; servers show as "blocked".
- [ ] The dialog shows the real command line, so the user knows what would run.

---

## SEC-2 — Stronger password rules

**Goal**
Stop users from protecting a world-class safe with a toothpick key.

**Task**
Require at least 8 characters when creating a room, and show a simple
strength meter while typing.

**How to do it**
1. In `src/App.tsx`, `handleCreate` (~line 79) currently rejects passwords
   under 4 characters. Change the minimum to 8.
2. Add a small strength function (length + mix of letter kinds is enough —
   no library needed). Show a colored bar under the first password field:
   red "weak" / yellow "okay" / green "strong".
3. Update the helper text: "Longer is stronger. There is no recovery if
   you forget it."
4. Do NOT block opening old rooms that already have short passwords —
   only creation is restricted.

**How to check it**
1. Try to create a room with "1234" → blocked with a friendly message.
2. Type a long mixed password → meter turns green, creation works.
3. Open an old room that has a 4-character password → still opens fine.

**Acceptance criteria**
- [ ] Creation with fewer than 8 characters is blocked with a clear message.
- [ ] A visible strength meter updates while typing.
- [ ] Existing rooms with short passwords still open.

---

## SEC-3 — Auto-lock

**Goal**
A room left open on an unattended Mac locks itself, like a banking app.

**Task**
Add a per-room setting "Lock automatically after X minutes" (Off / 5 / 15 /
60, default 15) and lock when the Mac sleeps.

**How to do it**
1. Store the choice in the room's `settings` table (key `autolock_minutes`).
2. In `Workspace.tsx`, track the time of the last user activity (mouse,
   keys, and the moment an AI answer finishes).
3. A timer checks every ~30 seconds; if idle too long, call the existing
   lock path (`api.closeRoom()` then back to the gate screen).
4. Sleep detection, simple version: the same timer compares wall-clock
   time between ticks. If the gap is much bigger than the interval, the
   Mac slept — lock immediately on wake if the gap passed the limit.
5. Never lock while an answer is still streaming; lock right after it
   finishes if the room is overdue.
6. Add the setting to the Settings screen under a new "Privacy" section.

**How to check it**
1. Set lock time to 1 minute (temporary dev choice), wait → gate screen appears.
2. Move the mouse just before the limit → timer resets, no lock.
3. Close the MacBook lid for longer than the limit, open it → room is locked.
4. Set "Off" → nothing ever locks by itself.
5. Start a long answer, go idle → app waits for the answer, then locks.

**Acceptance criteria**
- [ ] New rooms default to auto-lock at 15 minutes.
- [ ] Any user activity resets the timer.
- [ ] Sleeping past the limit locks the room on wake.
- [ ] The room never locks in the middle of a streaming answer.
- [ ] The setting is saved per room and survives relock/reopen.

---

## SEC-4 — Change password

**Goal**
Users can rotate a room's password (for example after saying it out loud
on a call), without rebuilding the room by hand.

**Task**
Add "Change password" to Settings: current password + new password (twice),
using SQLCipher's rekey.

**How to do it**
1. New Tauri command `change_password(current, new)` in
   `src-tauri/src/commands.rs`.
2. Verify `current` by opening the room file with it on a second, throwaway
   connection (same trick as `verify_key` in `src-tauri/src/db.rs`). This
   stops a walk-up attacker from changing the password of an open room.
3. If it checks out, run `PRAGMA rekey` with the new password on the main
   connection (`conn.pragma_update(None, "rekey", new)`).
4. Enforce the same minimum length as SEC-2 (8 characters).
5. UI: a small form in Settings under "Privacy", with the usual "there is
   no recovery" note.

**How to check it**
1. Change the password. Lock the room.
2. Old password → "Wrong password". New password → opens, all files and
   chats still there.
3. Enter a wrong "current password" → rejected, nothing changes.
4. Try a 4-character new password → rejected.

**Acceptance criteria**
- [ ] Rekey succeeds and the file only opens with the new password.
- [ ] All content is intact after the change.
- [ ] Wrong current password is rejected.
- [ ] New password must pass the SEC-2 rules.

---

## SEC-5 — Close the web-fetch loophole (DNS rebinding)

**Goal**
The AI's "fetch a web page" tool must never reach the user's own machine
or home network, even through a disguised web address.

**Task**
Before fetching, resolve the hostname to its real IP addresses, check that
every one of them is public, and connect only to the checked address.

**How to do it**
1. Today `check_public_http_url` in `src-tauri/src/web.rs` (~line 47) only
   blocks literal IPs, `localhost`, and `.local` names. A normal-looking
   hostname that secretly points at `192.168.1.1` walks right through.
2. In `fetch_page`, resolve the host first (`tokio::net::lookup_host`).
   If ANY returned IP fails the existing `is_public_ip` check, refuse.
3. Pin the connection to the checked IP with
   `reqwest::ClientBuilder::resolve(host, checked_addr)` so the answer
   can't change between the check and the fetch.
4. Redirects can also point somewhere private. Replace the plain redirect
   policy with a custom one that re-checks each hop's host the same way.
5. Leave the SearXNG search endpoint alone — the user chose it on purpose
   and it may legitimately be local. Only model-supplied URLs get the
   strict treatment.

**How to check it**
1. Ask the AI (web on) to fetch `http://localtest.me` and
   `http://127.0.0.1.nip.io` — both resolve to 127.0.0.1 and must be blocked.
2. Fetch a normal site (example.com) → still works.
3. A URL that redirects to a private address → blocked at the redirect.
4. SearXNG configured at `http://127.0.0.1:8888` → searching still works.
5. Keep/extend the unit tests in `web.rs`.

**Acceptance criteria**
- [ ] Hostnames resolving to private/loopback IPs are refused.
- [ ] Redirects to private addresses are refused.
- [ ] Public pages still fetch normally.
- [ ] Local SearXNG search is unaffected.
- [ ] Unit tests cover the new checks.

---

## SEC-6 — Always-visible "cloud mode" badge

**Goal**
The user can never forget that their questions are leaving the Mac.

**Task**
Show a permanent badge next to the message box whenever the selected
engine is a cloud CLI (Claude Code / Codex), with a one-click way back
to local.

**How to do it**
1. `Workspace.tsx` already knows the current `model`. When it is
   `claude-cli` or `codex-cli`, render a badge in the composer area
   (same style as the existing `mcp-badge`):
   "☁ Cloud engine active — questions leave this Mac · Switch to local".
2. "Switch to local" calls the existing `changeModel` with the default
   local model.
3. Also tint the model dropdown (or the status dot) while a cloud engine
   is selected, so it is visible even when the composer is off-screen.

**How to check it**
1. Select "Claude Code (cloud)" → badge appears immediately and stays.
2. Quit and reopen the app, unlock the room → badge is still there
   (the choice is saved per room).
3. Click "Switch to local" → badge disappears, local model selected.

**Acceptance criteria**
- [ ] Badge is visible the entire time a cloud engine is selected.
- [ ] It survives app restarts (setting is per room).
- [ ] One click returns to the local model.
- [ ] No badge when a local model is selected.

---

## SEC-7 — Shrink the room after deletions (vacuum)

**Goal**
Deleting files really frees space, and no stale data sits in the file's
"empty" pages forever.

**Task**
Compact (VACUUM) the room database when a meaningful amount of space has
been freed — automatically on lock, plus a "Compact room" button.

**How to do it**
1. SQLite keeps deleted data in free pages; the file never shrinks on its
   own. `PRAGMA freelist_count` × `PRAGMA page_size` tells how much is
   reclaimable.
2. In `close_room` (`src-tauri/src/commands.rs`), before dropping the
   connection: if reclaimable space is over ~10 MB, run `VACUUM`.
3. Show a small "Compacting…" state on the Lock button if it takes more
   than a second (vacuum on a big room is not instant).
4. Optional: "Compact room now" button in Settings showing how much space
   it would recover.

**How to check it**
1. Create a room, import ~50 MB of files, note the `.roomai` size in Finder.
2. Delete all the files, lock the room → the file shrinks back to near its
   empty size.
3. Reopen → everything still works (chats, settings intact).

**Acceptance criteria**
- [ ] Locking after large deletions shrinks the file.
- [ ] The room opens fine afterwards; no data loss.
- [ ] Small deletions do not trigger a slow vacuum on every lock.
- [ ] User sees feedback if compaction takes noticeable time.
