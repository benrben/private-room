/** What a `rec-state` event means for the workspace-wide live-recording state.
 *
 * Kept out of `effects.ts` so it can be tested without React or Tauri: the
 * listener there is one `applyRecState` call plus the setters.
 *
 * The engine has TWO terminal statuses, not one. `Engine::finish`
 * (src-tauri/src/recording.rs) ends a session as "saved" when the final write
 * worked and as "failed" when it did not — deliberately, so a red "could not be
 * saved" error is never sat next to a green "saved" badge. The listener used to
 * recognise only "saved", so a session that ended "failed" was read as still
 * live: the microphone tap stayed open for the rest of the app's life, pushing
 * audio at a dead session, and every "start a recording" affordance stayed
 * disabled because `recLive` never cleared. A user Stop hid it (the Stop path
 * tears the tap down itself); an engine that stopped ITSELF — the 3-hour
 * ceiling, the room closing under it — did not.
 */

/** The statuses that mean the engine is finished with this session. */
const TERMINAL = new Set(["saved", "failed"]);

export interface RecStateEvent {
  fileId: string;
  status: string;
}

export interface RecStateOutcome {
  /** What `recLive` becomes — null once the session is over. */
  live: { fileId: string; status: string } | null;
  /** Tear the microphone tap down: it must never outlive the session it fed. */
  stopTap: boolean;
  /** The save readout lives exactly as long as the save does. */
  clearSave: boolean;
  /** Fresh bytes are on disk (or the attempt is over) — reload the open view. */
  reload: boolean;
}

export function applyRecState(
  p: RecStateEvent,
  openFileId: string | undefined,
): RecStateOutcome {
  const over = TERMINAL.has(p.status);
  return {
    live: over ? null : { fileId: p.fileId, status: p.status },
    stopTap: over,
    clearSave: p.status !== "saving",
    reload: (over || p.status === "paused") && openFileId === p.fileId,
  };
}
