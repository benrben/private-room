// ADD-27: the microphone tap for a live recording.
//
// Served as a real same-origin asset (NOT a blob: URL) because the app's CSP
// allows `script-src 'self'` only — an AudioWorklet module is a script fetch,
// so a blob: URL is refused and the microphone would silently never start.
//
// Gathers the 128-frame quanta of the first input channel into BLOCK-frame
// blocks and HANDS each block over to the main thread, which batches ~250 ms
// of them and gives that to the Rust engine. Posting every quantum on its own
// meant ~375 copied messages (and 375 allocations) a second landing on the
// thread that draws the window, for the whole length of a recording.
//
// A block is smaller than the ScriptProcessor fallback's 4096-frame buffer, so
// the trailing frames still being gathered when the tap is torn down are no
// more than that path already drops.
const BLOCK = 1024;

class PrRecTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(BLOCK);
    this.filled = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // Loop rather than assume a 128-frame quantum: a quantum larger than the
    // room left in the block must span blocks, not overrun one.
    for (let at = 0; at < ch.length; ) {
      const n = Math.min(ch.length - at, BLOCK - this.filled);
      this.block.set(ch.subarray(at, at + n), this.filled);
      this.filled += n;
      at += n;
      if (this.filled === BLOCK) {
        // Transferred, not copied — this detaches the buffer, so the next
        // block starts on a fresh one.
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(BLOCK);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pr-rec-tap", PrRecTap);
