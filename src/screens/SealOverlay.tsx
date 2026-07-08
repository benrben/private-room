// THE SEAL (lock): an ink veil seals over the room while the keyhole
// contracts shut (~460ms), then the gate returns. CSS + reduced-motion
// handled in seal.css.
export function SealLockingOverlay() {
  return <div className="seal-locking-overlay" aria-hidden="true" />;
}

// THE SEAL (unlock): the keyhole blooms open over the gate on a successful
// open (~520ms), then the workspace mounts. Styling + reduced-motion handled
// in seal.css.
export function SealUnlockingOverlay() {
  return <div className="seal-unlocking" aria-hidden="true" />;
}
