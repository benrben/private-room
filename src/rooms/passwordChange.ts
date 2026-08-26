/** The parts of changing a room's password that are decisions rather than I/O.
 *
 * Three of these sentences are the product of a specific past incident, and
 * each one has to survive the next refactor of `usePrivacy.ts`, which is four
 * awaits deep and cannot be rendered without the whole Tauri backend. Kept
 * import-free so `e2e/page-script/settingsGaps.test.mjs` can type-strip and
 * run them for real. */

/** Why this new password cannot be used, or null when it can. */
export function newPasswordProblem(
  next: string,
  repeat: string,
  min: number,
): string | null {
  if (next !== repeat) return "The new passwords do not match.";
  if (next.length < min) return `New password must be at least ${min} characters.`;
  return null;
}

/** Validate an alternate password chosen for a portable sealed backup.
 * The room-password option never sends a secret to the renderer; this helper
 * is only for the explicit alternate-password fields. */
export function sealedExportPasswordProblem(
  password: string,
  repeat: string,
  min: number,
): string | null {
  if (password !== repeat) return "The backup passwords do not match.";
  if ([...password].length < min) {
    return `Backup password must be at least ${min} characters.`;
  }
  return null;
}

/** `change_password` returns null both when the room never had a recovery
 * sidecar AND when re-wrapping the existing one failed, so the caller has to
 * know which it was: a key that existed and is now gone has been revoked, and
 * the user finds out here or never. */
export function revokedRecoveryWarning(
  hadRecovery: boolean,
  freshCode: string | null,
): string | null {
  return hadRecovery && freshCode === null
    ? "Your recovery key could not be re-issued and has been revoked — create a new one in Settings → Recovery key."
    : null;
}

/** A restore point whose re-key failed still opens — with the PREVIOUS
 * password. Named now, while that password is still fresh in mind; the
 * alternative is finding out weeks later from a rollback that says the current
 * password is wrong. */
export function strandedCheckpointWarning(stranded: string[]): string | null {
  if (stranded.length === 0) return null;
  return (
    `${stranded.length} restore point${stranded.length === 1 ? "" : "s"} could not be re-locked with the new password (${stranded.join(", ")}). ` +
    "Only your PREVIOUS password opens them — keep it somewhere safe, or delete them under Settings → Restore points."
  );
}

/** The Keychain entry holds the OLD password, so a change re-saves it behind
 * Touch ID — and when that re-save fails it DELETES the entry instead
 * (safety.rs). Settings kept showing the switch as on, so the room read as
 * biometric-unlockable when only typing worked. */
export function touchIdLostWarning(was: boolean, is: boolean): string | null {
  return was && !is
    ? "Touch ID unlock was turned off: the new password could not be stored behind it. Turn it back on to re-enable it."
    : null;
}
