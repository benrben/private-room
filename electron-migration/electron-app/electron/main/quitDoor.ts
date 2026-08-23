/**
 * The QUIT door: every way out of the app, asked once.
 *
 * ============================================================================
 * WHAT CHANGED IN THE PORT, AND WHY THIS FILE'S ORIGINAL PREMISE NO LONGER
 * HOLDS
 * ============================================================================
 * Under Tauri this module guarded ⌘Q alone, and said so: "closing the window
 * is already guarded in the renderer (it registers a close handler that
 * intercepts every native close request)". That was true there —
 * `Workspace.tsx` registers `getCurrentWindow().onCloseRequested(...)`, and
 * Tauri prevents every native close for a window that has a JS listener. ⌘Q
 * was the exception, because tao has no `applicationShouldTerminate:` hook, so
 * a real macOS Quit never reached JS at all.
 *
 * Electron inverts exactly that. `app.on("before-quit")` DOES see ⌘Q, the Dock
 * menu, logout and every internal `app.quit()` — the original bug simply does
 * not exist here. But an isolated Electron renderer has no
 * `onCloseRequested` equivalent: the red button and ⌘W reach
 * `BrowserWindow`'s own `close` event in the MAIN process and nowhere else. So
 * the guard the renderer used to own has to move here too, or closing the
 * window becomes the new silent way to throw an unsaved buffer away.
 *
 * `main/index.ts` therefore asks this one door from THREE entrances — the
 * menu's ⌘Q row (via `menu.ts`'s `quit`), `before-quit`, and the window's
 * `close` — all sharing the single {@link QuitDoor} instance, so its one-shot
 * latch means "held once", not "held once per entrance".
 *
 * The event-loop side of each is synchronous and cannot itself ask a question,
 * so the shape is unchanged from the Rust original: hold the exit once, ask the
 * window, and let the window answer — {@link QuitDoor.rearm} for "stay",
 * {@link QuitDoor.confirmQuit} for "go".
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
   * The window answered the quit question with "yes" — the user was shown what
   * they stand to lose and chose to go anyway.
   *
   * THE STEP THE TAURI BUILD DID NOT NEED A DOOR METHOD FOR. There, the
   * frontend answered "Quit and discard" by calling
   * `@tauri-apps/plugin-process`'s bare `exit(0)`; an isolated Electron
   * renderer cannot exit anything, so the answer comes back as the
   * `quit_guard_confirm` command and the caller (`main/index.ts`'s host bridge)
   * runs the real `app.quit()`.
   *
   * Both flags, not just the latch: the buffer is being discarded on purpose,
   * so leaving `unsavedEdits` armed would make the very quit the user just
   * authorized get held all over again by the next entrance it passes through
   * — `app.quit()` fires `before-quit` AND the window's `close`, so a door left
   * armed here would re-ask twice on the way out.
   */
  confirmQuit(): void {
    this.unsavedEdits = false;
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
