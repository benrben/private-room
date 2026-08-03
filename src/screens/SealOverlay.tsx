// THE SEAL (lock): an ink veil seals over the room while the keyhole
// contracts shut (~460ms), then the gate returns. CSS + reduced-motion
// handled in seal.css.
//
// `slow` is what the animation cannot say. Behind the veil the host stops
// recordings, waits for running jobs and may compact the room file, and on a
// big room that outlasts the ritual by many seconds — leaving a blank dark
// screen with no message, no spinner and nothing to distinguish it from a
// frozen app. Once the ritual is over and the close is still going, say so.
export function SealLockingOverlay({ slow = false }: { slow?: boolean }) {
  return (
    <div className="seal-locking-overlay" aria-hidden={!slow}>
      {slow && (
        <div className="seal-note" role="status">
          <span className="seal-note-spinner" aria-hidden="true" />
          <span>
            Sealing this room — stopping recordings, letting jobs finish and
            tidying the file. Large rooms can take a little while.
          </span>
        </div>
      )}
    </div>
  );
}

// THE SEAL (unlock): the keyhole blooms open over the gate on a successful
// open (~520ms), then the workspace mounts. Styling + reduced-motion handled
// in seal.css.
export function SealUnlockingOverlay() {
  return <div className="seal-unlocking" aria-hidden="true" />;
}
