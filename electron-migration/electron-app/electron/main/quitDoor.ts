/**
 * The QUIT door: the one exit that never passes through a window close.
 *
 * Closing the window is already guarded in the renderer (it registers a
 * close handler that intercepts every native close request). ⌘Q is a
 * different event entirely — macOS's default menu Quit calls
 * `app.quit()` / `NSApplication terminate:` style behavior, which does not
 * necessarily route through a window's own close handler — so the
 * renderer guard can be bypassed and an unsaved editor buffer would go out
 * with the process, silently.
 *
 * The main-process "before-quit" style hook is the only place that DOES see
 * it. That handler is synchronous-ish and cannot itself ask a question, so
 * the shape is: hold the exit once, ask the window, and let the window
 * finish the quit itself.
 */

/** The window event that asks the question. Named here rather than spelled
 * out at each end: the menu raises it, the renderer answers it, and a typo
 * in either would be a guard that silently never fires — which is the
 * exact failure this module exists to have fixed once. */
export const QUIT_REQUESTED = "quit-requested";

/**
 * Should this exit be held so the window can ask about unsaved edits?
 *
 * `code` is `null` only for a quit the USER asked for (⌘Q, the Dock menu,
 * Apple menu → Quit). A programmatic exit — which is exactly what the
 * window's own close guard calls once it has asked — carries a code and
 * must never be re-asked, or answering the dialog would raise the same
 * dialog.
 */
export function holdQuit(code: number | null, unsaved: boolean, alreadyHeld: boolean): boolean {
  return code === null && unsaved && !alreadyHeld;
}

/**
 * Wraps the two mutable flags that the Rust side kept as process-global
 * atomics (`UNSAVED_EDITS`, `QUIT_HELD`). In TS these are just plain
 * instance fields — Node is single-threaded here, so no atomics are
 * needed (the Rust atomics existed for tao's event loop thread vs the
 * command-handler thread).
 */
export class QuitDoor {
  private unsavedEdits = false;
  private quitHeld = false;

  /**
   * The frontend's answer to "is there anything to lose right now?".
   *
   * Pushed rather than pulled: the handler that needs it must not need to
   * ask the window anything.
   */
  setUnsavedEdits(on: boolean): void {
    this.unsavedEdits = on;
    if (!on) {
      // Nothing left to ask about — re-arm, so a LATER edit is guarded too.
      this.quitHeld = false;
    }
  }

  /**
   * The window answered the quit question with "no". Re-arm the door.
   *
   * The latch exists so a door that cannot be ANSWERED never traps the
   * user: a wedged window means the second ⌘Q quits regardless. Answering
   * "Cancel" is the opposite situation — the window is plainly alive and
   * the user said they want to stay — but it left the latch set, so the
   * next ⌘Q minutes later quit with no dialog and took the buffer with it.
   * Clearing it here keeps the fail-open property (nothing clears the
   * latch unless the window replied) while making Cancel mean "not this
   * time" instead of "never again".
   */
  rearm(): void {
    this.quitHeld = false;
  }

  /**
   * The event-loop side of the door. Returns true when the exit was held,
   * in which case the caller has asked the window and the window will
   * finish.
   */
  holdForUnsaved(code: number | null): boolean {
    const hold = holdQuit(code, this.unsavedEdits, this.quitHeld);
    if (hold) {
      this.quitHeld = true;
    }
    return hold;
  }
}
