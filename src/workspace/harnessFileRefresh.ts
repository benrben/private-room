/**
 * Refresh the one shared room-file list after a harness reports a file change.
 * Library, Home, and the workspace footer all render from this same list.
 *
 * Kept transport-agnostic so the event-to-store contract can be regression
 * tested without mounting the whole Electron renderer.
 */
export async function refreshSharedFilesForHarnessEvent<T>(
  event: { type: string },
  listFiles: () => Promise<T[]>,
  setFiles: (files: T[]) => void,
): Promise<boolean> {
  if (event.type !== "file_changed") return false;
  setFiles(await listFiles());
  return true;
}
