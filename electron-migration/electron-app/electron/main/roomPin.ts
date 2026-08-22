/**
 * The room a turn began in: which file, and which OPEN of it.
 *
 * Ported verbatim from `src-tauri/src/commands/agent.rs`'s `RoomPin`
 * (lines ~1446-1476). A real correctness invariant, not incidental: the same
 * room FILE can be closed and reopened while an answer is in flight, and the
 * chat ids of the previous session mean nothing to the new one. The epoch
 * (bumped by every open/teardown — see `AppState::room_epoch` in the Rust
 * source) is what distinguishes them, and it is the pin the OCR/STT/video
 * lanes already take for the same reason.
 *
 * `AppState`/`room_epoch` are not ported in this batch (no host-state module
 * exists yet in this rewrite), so {@link RoomPin.take} is declared against a
 * small seam, {@link RoomPinSource}, rather than a concrete state type — the
 * same shape this batch's other modules use for a not-yet-ported dependency
 * (see `mcpBridge.ts`'s `ToolDispatcher`). A future batch that ports the real
 * host room state should implement this interface (or adapt to it) rather
 * than inventing a second notion of "which room is this write pinned to".
 */

/** The minimal slice of host state {@link RoomPin.take} needs: the room
 * epoch counter, and the currently-open room's path (or `null` when no room
 * is open) — the TS analogue of `AppState::room_epoch()` +
 * `AppState::room_guard()`. */
export interface RoomPinSource {
  /** Bumped by every room open/teardown. */
  roomEpoch(): number;
  /** The open room's path, or `null` when none is open. */
  currentRoomPath(): string | null;
}

/**
 * A snapshot of "which room, which open" taken at the START of a turn, so a
 * late-finishing write can be checked against it and refused if the room
 * changed underneath it.
 */
export class RoomPin {
  private constructor(
    private readonly path: string,
    private readonly epoch: number
  ) {}

  /** The open room, or `null` when there is none to pin to. Ported from
   * `RoomPin::take`. */
  static take(source: RoomPinSource): RoomPin | null {
    // Epoch read BEFORE the path, mirroring the Rust source's own read
    // order (`state.room_epoch()` then `state.room_guard()`) — both reads
    // are against the same live state either way, but keeping the order
    // identical avoids inventing a new interleaving no one has reasoned
    // about.
    const epoch = source.roomEpoch();
    const path = source.currentRoomPath();
    if (path === null) {
      return null;
    }
    return new RoomPin(path, epoch);
  }

  /**
   * Is the room open now — at `epoch`, from `path` — the same OPEN this pin
   * was taken from? Both halves are needed: the same file closed and
   * reopened is a different session, whose chat ids are not this turn's.
   * Ported from `RoomPin::holds`.
   */
  holds(epoch: number, path: string): boolean {
    return path === this.path && epoch === this.epoch;
  }
}
