/**
 * The pending-open slot: a `.roomai` path the OS handed the app before any
 * window was ready to receive it.
 *
 * Rust kept this as `AppState.pending_open: Mutex<Option<String>>` — a single
 * process-global slot, set from `RunEvent::Opened` (macOS Finder double-click
 * on a `.roomai`, lib.rs:645-660) and read-and-cleared exactly once by the
 * `take_pending_open` command (rooms.rs:688-690), which the frontend polls
 * once it has mounted. Node's main process is single-threaded, so the
 * `Mutex` itself has no TS equivalent — a module-level variable does the
 * same job without a lock.
 *
 * Actually wiring `app.requestSingleInstanceLock()` / the `'second-instance'`
 * and `'open-file'` events to `setPendingOpen` is main-process startup-sequence
 * work for a later phase — this module is only the state-holder those events
 * will call into.
 */

let pendingOpen: string | null = null;

/**
 * Record a path the OS just handed the app. Unconditional overwrite, same as
 * the Rust `*state.pending_open.lock().unwrap() = Some(path.clone())` — a
 * second call before anything reads the first simply replaces it; there is
 * no queue and no error.
 */
export function setPendingOpen(path: string): void {
  pendingOpen = path;
}

/**
 * Read the pending path AND clear the slot, same as Rust's `Option::take()`.
 * A second call immediately after the first returns `null`, so the same
 * pending path is never handed to two different callers.
 */
export function takePendingOpen(): string | null {
  const path = pendingOpen;
  pendingOpen = null;
  return path;
}

/**
 * Read the pending path WITHOUT clearing it. Rust has no equivalent single
 * function for this (only `take()`); exported here for tests only, so a test
 * can assert on the slot's contents without consuming the value it's
 * asserting about.
 */
export function peekPendingOpen(): string | null {
  return pendingOpen;
}
