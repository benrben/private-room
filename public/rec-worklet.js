// ADD-27: the microphone tap for a live recording.
//
// Served as a real same-origin asset (NOT a blob: URL) because the app's CSP
// allows `script-src 'self'` only — an AudioWorklet module is a script fetch,
// so a blob: URL is refused and the microphone would silently never start.
//
// Forwards every 128-frame quantum of the first input channel to the main
// thread, which batches ~250 ms of it and hands it to the Rust engine.
class PrRecTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}

registerProcessor("pr-rec-tap", PrRecTap);
