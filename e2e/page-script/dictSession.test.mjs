import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const source = readFileSync(join(root, "src/workspace/dictSession.ts"), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const M = await import(`data:text/javascript,${encodeURIComponent(js)}`);

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];
  OPEN = 1;
  readyState = 0;
  sent = [];
  listeners = new Map();
  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, listener) {
    const values = this.listeners.get(type) ?? [];
    values.push(listener);
    this.listeners.set(type, values);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((fn) => fn !== listener));
  }
  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  send(value) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
}

globalThis.WebSocket = FakeWebSocket;
globalThis.window = globalThis;

function pcmBase64(values) {
  return Buffer.from(new Float32Array(values).buffer).toString("base64");
}

test("dictation sends the exact binary protocol and resolves the final transcript", async () => {
  const partials = [];
  const connecting = M.connectDictSession(
    { url: "ws://sidecar/dict/session?token=t", stopBaseMs: 1000, stopPerAudioSecondMs: 10 },
    (text) => partials.push(text),
  );
  const ws = FakeWebSocket.instances.at(-1);
  ws.open();
  const session = await connecting;

  await session.push(16000, pcmBase64([0.25, -0.5]));
  assert.equal(ws.sent.length, 1);
  const view = new DataView(ws.sent[0]);
  assert.equal(view.getUint32(0, true), 16000);
  assert.equal(view.getUint32(4, true), 2);
  assert.equal(view.getFloat32(8, true), 0.25);
  assert.equal(view.getFloat32(12, true), -0.5);

  ws.emit("message", { data: JSON.stringify({ type: "partial", text: "hello" }) });
  assert.deepEqual(partials, ["hello"]);
  const stopping = session.stop();
  assert.equal(ws.sent[1], JSON.stringify({ type: "stop" }));
  ws.emit("message", { data: JSON.stringify({ type: "final", ok: true, text: "hello world" }) });
  assert.equal(await stopping, "hello world");
});

test("a missing model close is surfaced as STT_MODEL_MISSING", async () => {
  const connecting = M.connectDictSession(
    { url: "ws://sidecar/dict/session", stopBaseMs: 1000, stopPerAudioSecondMs: 10 },
    () => {},
  );
  const ws = FakeWebSocket.instances.at(-1);
  ws.emit("close", { code: 4404, reason: "" });
  await assert.rejects(connecting, /STT_MODEL_MISSING/);
});
