//! The QUIT door: the one exit that never passes through a window close.
//!
//! Closing the window is already guarded in JavaScript (`Workspace.tsx`
//! registers `onCloseRequested`, which makes tao hand every native close to
//! JS). ⌘Q is a different event entirely — macOS's default menu Quit calls
//! `NSApplication terminate:`, and tao only raises `CloseRequested` from
//! `windowShouldClose:` — so the JS guard never sees it and an unsaved Monaco
//! buffer went out with the process, silently.
//!
//! `RunEvent::ExitRequested` is the only hook that DOES see it. The event loop
//! handler is synchronous and cannot ask a question, so the shape is: hold the
//! exit once, ask the window, and let the window finish the quit itself.

use super::*;

/// The window event that asks the question. Named here rather than spelled out
/// at each end: the menu raises it, `Workspace.tsx` answers it, and a typo in
/// either would be a guard that silently never fires — which is the exact
/// failure this module exists to have fixed once.
pub const QUIT_REQUESTED: &str = "quit-requested";

/// Does the open editor have edits that quitting would throw away? Pushed from
/// the frontend, which is the only place that knows (the buffer lives in
/// Monaco, not in Rust).
static UNSAVED_EDITS: AtomicBool = AtomicBool::new(false);
/// Whether a quit has ALREADY been held once for this question.
///
/// A door that cannot be answered must never trap the user: if the window is
/// wedged, or the dialog never comes back, the second ⌘Q must quit. This latch
/// is what makes the guard fail open rather than closed.
static QUIT_HELD: AtomicBool = AtomicBool::new(false);

/// The frontend's answer to "is there anything to lose right now?".
///
/// Pushed rather than pulled: the event-loop handler that needs it is
/// synchronous, so it cannot ask the window anything.
#[tauri::command]
pub fn set_unsaved_edits(on: bool) {
    UNSAVED_EDITS.store(on, Ordering::SeqCst);
    if !on {
        // Nothing left to ask about — re-arm, so a LATER edit is guarded too.
        QUIT_HELD.store(false, Ordering::SeqCst);
    }
}

/// The window answered the quit question with "no". Re-arm the door.
///
/// The latch exists so a door that cannot be ANSWERED never traps the user: a
/// wedged window means the second ⌘Q quits regardless. Answering "Cancel" is
/// the opposite situation — the window is plainly alive and the user said they
/// want to stay — but it left the latch set, so the next ⌘Q minutes later quit
/// with no dialog and took the buffer with it. Clearing it here keeps the
/// fail-open property (nothing clears the latch unless the window replied)
/// while making Cancel mean "not this time" instead of "never again".
#[tauri::command]
pub fn quit_guard_rearm() {
    QUIT_HELD.store(false, Ordering::SeqCst);
}

/// Should this exit be held so the window can ask about unsaved edits?
///
/// `code` is `None` only for a quit the USER asked for (⌘Q, the Dock menu,
/// Apple menu → Quit). A programmatic `exit()` — which is exactly what the
/// window's own close guard calls once it has asked — carries a code and must
/// never be re-asked, or answering the dialog would raise the same dialog.
pub(crate) fn hold_quit(code: Option<i32>, unsaved: bool, already_held: bool) -> bool {
    code.is_none() && unsaved && !already_held
}

/// The event-loop side of the door. Returns true when the exit was held, in
/// which case the caller has asked the window and the window will finish.
pub(crate) fn hold_quit_for_unsaved(code: Option<i32>) -> bool {
    let hold = hold_quit(
        code,
        UNSAVED_EDITS.load(Ordering::SeqCst),
        QUIT_HELD.load(Ordering::SeqCst),
    );
    if hold {
        QUIT_HELD.store(true, Ordering::SeqCst);
    }
    hold
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two latches are process-global, so any two tests that write them
    /// would race under cargo's parallel runner. Every such test holds this.
    fn state_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn reset() {
        UNSAVED_EDITS.store(false, Ordering::SeqCst);
        QUIT_HELD.store(false, Ordering::SeqCst);
    }

    #[test]
    fn cmd_q_with_unsaved_edits_is_held_exactly_once() {
        // ⌘Q raises ExitRequested with no code and NO window close request, so
        // before this the JS guard never ran and the buffer went with the
        // process.
        assert!(hold_quit(None, true, false), "⌘Q with unsaved edits must be held");
        // ...and a second press must quit anyway: a guard that cannot be
        // answered would be a Quit that does nothing.
        assert!(!hold_quit(None, true, true));
        // Nothing to lose: never hold.
        assert!(!hold_quit(None, false, false));
        // The window's own close guard already asked and then called exit(0);
        // holding that would ask the same question forever.
        assert!(!hold_quit(Some(0), true, false));
    }

    #[test]
    fn the_hold_latch_re_arms_once_the_buffer_is_clean() {
        let _guard = state_lock();
        reset();
        set_unsaved_edits(true);
        assert!(hold_quit_for_unsaved(None), "first ⌘Q asks");
        assert!(!hold_quit_for_unsaved(None), "second ⌘Q quits");
        // Saving (or discarding) clears the flag, which re-arms the guard for
        // the NEXT edit — otherwise one answered dialog disabled the door for
        // the rest of the session.
        set_unsaved_edits(false);
        set_unsaved_edits(true);
        assert!(hold_quit_for_unsaved(None), "a fresh edit is guarded again");
        reset();
    }

    /// Cancel means "not this time", not "never again for this buffer".
    #[test]
    fn cancelling_the_dialog_re_arms_the_door_for_the_same_buffer() {
        let _guard = state_lock();
        reset();
        set_unsaved_edits(true);
        assert!(hold_quit_for_unsaved(None), "first ⌘Q asks");
        // The window asked, the user said Cancel, and the buffer is STILL dirty
        // — so `set_unsaved_edits(false)` is exactly what must not happen here.
        quit_guard_rearm();
        assert!(
            hold_quit_for_unsaved(None),
            "a later ⌘Q must ask again, not quit and discard the buffer"
        );
        // The fail-open property survives: an UNANSWERED hold still lets the
        // next press through, because nothing re-armed it.
        assert!(!hold_quit_for_unsaved(None));
        reset();
    }
}
