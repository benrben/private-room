/**
 * Tests for `registry.ts` — the central IPC registry. Four things are checked:
 *
 *   1. Every `registerXIpc` module is actually invoked, against one shared
 *      object graph, with no duplicate channel registration (the registry's
 *      own recording shim throws on one, so this is a real conflict check, not
 *      a hope).
 *   2. The completeness diff matches the documented gap list EXACTLY, in both
 *      directions, and every registered channel is a real `Commands` key or a
 *      documented extra.
 *   3. Real handlers answer through captured listeners end to end — including
 *      across MODULE boundaries (a room opened through `roomManagerIpc`'s
 *      `create_room` is visible to `libraryTools`'s `list_folders`), which is
 *      what proves the shared room-source adapter actually works.
 *   4. The dependency seams this registry is responsible for threading —
 *      `isRollingBack`, `onPasswordChanged`, `emit`, `explicitModel` — are
 *      genuinely wired, not left at the modules' silent no-op defaults. Every
 *      one of those four is a seam that COMPILES either way and fails
 *      silently: a dropped `emit` argument just means the renderer is never
 *      told the room changed, and a constant `explicitModel` just means three
 *      commands answer for the wrong room. The last two were added by an
 *      adversarial verify pass, which found `emitted` being collected by the
 *      harness below and never asserted on by anything.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

import type { FileContent, RoomInfo } from "../../shared/apiTypes.js";
import type { DialogDeps } from "../dialogTools.js";
import { insertFile } from "../db-host/files.js";
import { setRecMeta } from "../db-host/recordings.js";
import {
  invalidateFileContentCacheForEvent,
  type FileRuntimeStores,
} from "../fileRuntimeSurfaceIpc.js";
import type { RoomManagerState } from "../roomManager.js";
import {
  ALL_COMMAND_NAMES,
  KNOWN_EXTRA_CHANNELS,
  KNOWN_UNREGISTERED_COMMANDS,
  WIRED_MODULE_COUNT,
  buildExplicitModel,
  checkCompleteness,
  createDefaultRoomManagerDeps,
  createLiveRecBridgeCtx,
  createRoomManagerState,
  registerAllIpc,
  readViewMenuState,
} from "./registry.js";

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir !== undefined) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function freshUserDataDir(): string {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "registry-"));
  return tmpDir;
}

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/** A fake `ipcMain` that mimics real Electron's own duplicate-registration
 * behavior (`ipcMain.handle` throws "Attempted to register a second handler
 * for '<channel>'") rather than silently overwriting — so a collision fails
 * here even if the registry's own shim were removed. */
function fakeIpcMain(): {
  ipcMain: Pick<IpcMain, "handle">;
  handlers: Map<string, Listener>;
  calls: string[];
} {
  const handlers = new Map<string, Listener>();
  const calls: string[] = [];
  return {
    handlers,
    calls,
    ipcMain: {
      handle(channel: string, listener: Listener): void {
        if (handlers.has(channel)) {
          throw new Error(`Attempted to register a second handler for '${channel}'`);
        }
        handlers.set(channel, listener);
        calls.push(channel);
      },
    },
  };
}

const fakeEvent = { sender: { send: () => undefined } } as unknown as IpcMainInvokeEvent;

interface Built {
  registeredChannels: ReadonlySet<string>;
  completeness: ReturnType<typeof checkCompleteness>;
  handlers: Map<string, Listener>;
  calls: string[];
  state: RoomManagerState;
  userDataDir: string;
  emitted: [string, unknown][];
  runtimeStores: FileRuntimeStores;
  /** What the host bridge was asked to do — the four channels whose whole
   * job is to reach `main/index.ts`'s quit door, live menu and app exit.
   * Recorded rather than executed, since none of those exists outside a real
   * bootstrap; `index.test.ts` drives the real ones. */
  hostCalls: [string, unknown][];
  /** What `arcelle.dialog`/`arcelle.shell` were asked to do, same reasoning:
   * `dialogTools.test.ts`/`shellTools.test.ts` own their behavior, this file
   * only proves the registry reaches the injected objects. */
  dialogCalls: [string, unknown][];
  shellCalls: [string, unknown][];
}

function build(): Built {
  const userDataDir = freshUserDataDir();
  const { ipcMain, handlers, calls } = fakeIpcMain();
  const state = createRoomManagerState();
  const emitted: [string, unknown][] = [];
  const emit = (event: string, payload: unknown): void => {
    emitted.push([event, payload]);
  };
  const hostCalls: [string, unknown][] = [];
  const dialogCalls: [string, unknown][] = [];
  const shellCalls: [string, unknown][] = [];
  const deps = createDefaultRoomManagerDeps(userDataDir, emit);
  const result = registerAllIpc({
    ipcMain,
    state,
    deps,
    emit,
    host: {
      setUnsavedEdits: (on) => hostCalls.push(["setUnsavedEdits", on]),
      rearmQuitGuard: () => hostCalls.push(["rearmQuitGuard", null]),
      confirmQuit: () => hostCalls.push(["confirmQuit", null]),
      syncMenu: (view) => hostCalls.push(["syncMenu", view]),
      appVersion: () => "0.25.0",
      osVersion: () => "macOS test",
      checkForUpdate: async () => null,
      installUpdate: async () => {},
      windowContentView: () => null,
      focusMainWindow: () => {},
      openPath: async () => {},
    },
    dialog: {
      dialog: {
        showOpenDialog: ((...args: unknown[]) => {
          dialogCalls.push(["showOpenDialog", args]);
          return Promise.resolve({ canceled: false, filePaths: ["/tmp/picked"] });
        }) as unknown as DialogDeps["dialog"]["showOpenDialog"],
        showSaveDialog: ((...args: unknown[]) => {
          dialogCalls.push(["showSaveDialog", args]);
          return Promise.resolve({ canceled: true, filePath: "" });
        }) as unknown as DialogDeps["dialog"]["showSaveDialog"],
        showMessageBox: ((...args: unknown[]) => {
          dialogCalls.push(["showMessageBox", args]);
          return Promise.resolve({ response: 0, checkboxChecked: false });
        }) as unknown as DialogDeps["dialog"]["showMessageBox"],
      },
      getMainWindow: () => null,
    },
    shell: {
      shell: {
        openExternal: (url: string) => {
          shellCalls.push(["openExternal", url]);
          return Promise.resolve();
        },
        openPath: (p: string) => {
          shellCalls.push(["openPath", p]);
          return Promise.resolve("");
        },
        showItemInFolder: (p: string) => {
          shellCalls.push(["showItemInFolder", p]);
        },
        trashItem: (p: string) => {
          shellCalls.push(["trashItem", p]);
          return Promise.resolve();
        },
      },
      openWithApp: (app: string, target: string) => {
        shellCalls.push(["openWithApp", [app, target]]);
        return Promise.resolve();
      },
    },
    userDataDir,
    resourcesPath: null,
  });
  return {
    ...result,
    handlers,
    calls,
    state,
    userDataDir,
    emitted,
    hostCalls,
    dialogCalls,
    shellCalls,
  };
}

describe("registerAllIpc — registration", () => {
  it("registers every wired module with no duplicate-channel conflict", () => {
    expect(() => build()).not.toThrow();
  });

  it("lets recording use the same installed voice model reported by stt_status", async () => {
    const built = build();
    const modelDir = path.join(built.userDataDir, "models");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(path.join(modelDir, "ggml-large-v3-turbo-q5_0.bin"), "lmgg-test-model");

    expect(built.handlers.get("stt_status")!({} as IpcMainInvokeEvent)).toMatchObject({
      installed: true,
    });

    // The production recording-context factory must resolve that same file.
    // The regression left this dependency at createRecBridgeCtx's default
    // null resolver even though stt_status above said installed=true.
    const recCtx = createLiveRecBridgeCtx(() => null, built.userDataDir, null);
    expect(recCtx.deps.resolveSttModel()).toBe(
      path.join(modelDir, "ggml-large-v3-turbo-q5_0.bin"),
    );
  });

  it("gives the recording bridge the SPEAKER model too, not just the STT model", () => {
    // The P0 this test exists for: `createLiveRecBridgeCtx` supplied only
    // `currentRoom` + `resolveSttModel`. `recBridge.ts` declares
    // `diarizeModelPath` as an OPTIONAL dep and reads it as
    // `ctx.deps.diarizeModelPath?.() ?? null`, so the omission compiled, booted
    // and recorded — every `/rec/start` just POSTed `diarizeModelPath: null`.
    // Downstream of that null the sidecar substitutes a 21-dim DSP embedding,
    // `identityPrint` (192-dim TitaNet) returns null, `learnVoice`
    // early-returns, and saved-voice enrollment plus cross-recording
    // recognition have never worked in a shipped build — with the 40MB model
    // sitting bundled in `resources/models/` the whole time. Nothing throws
    // anywhere along that chain, which is exactly why it needs a test rather
    // than a code reading.
    const built = build();
    const modelDir = path.join(built.userDataDir, "models");
    mkdirSync(modelDir, { recursive: true });
    // The file name is spelled out rather than imported from the
    // implementation on purpose: a test that borrows the constant it is
    // checking cannot catch the constant changing out from under the bundled
    // `resources/models/` file.
    const titanet = path.join(modelDir, "nemo_en_titanet_small.onnx");
    writeFileSync(titanet, "titanet-test-model");

    const recCtx = createLiveRecBridgeCtx(() => null, built.userDataDir, null);
    // The RESOLVED PATH is the assertion that carries the regression, not the
    // presence of the field. `createRecBridgeCtx` now fills an omitted
    // `diarizeModelPath` with an explicit `() => null` of its own, so a
    // registry that supplies nothing still hands back a function here — it
    // just answers `null`, which is the silent-degradation state this test
    // exists to catch. The typeof check below is kept only so a future
    // `diarizeModelPath?: string` shape change fails loudly instead of
    // comparing a string to a path.
    expect(typeof recCtx.deps.diarizeModelPath).toBe("function");
    expect(
      recCtx.deps.diarizeModelPath?.(),
      "createLiveRecBridgeCtx resolved no TitaNet path — recBridge then POSTs " +
        "`diarizeModelPath: null` and speaker recognition is silently off",
    ).toBe(titanet);
  });

  it("records exactly the channels the underlying ipcMain received", () => {
    const { registeredChannels, calls } = build();
    expect(new Set(calls).size).toBe(calls.length);
    expect(registeredChannels).toEqual(new Set(calls));
  });

  it("registers a channel count consistent with the wired module list", () => {
    const { registeredChannels } = build();
    // 296 Commands keys minus the documented gap, plus the two documented
    // non-Commands extras.
    expect(registeredChannels.size).toBe(
      ALL_COMMAND_NAMES.length - KNOWN_UNREGISTERED_COMMANDS.size + KNOWN_EXTRA_CHANNELS.size
    );
  });

  it("WIRED_MODULE_COUNT matches the number of registerXIpc calls in registry.ts itself", () => {
    // A hand-maintained module count is exactly the claim that goes quietly
    // wrong (one merge candidate shipped `moduleCount: 30` beside 31 real
    // calls, with its own test asserting the 30). Count the real call sites in
    // the source instead, so the constant cannot drift from the code.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, "registry.ts"), "utf8");
    const callSites = source.match(/^ {2}register[A-Za-z]*Ipc\(\s*$|^ {2}register[A-Za-z]*Ipc\(/gm) ?? [];
    expect(callSites.length).toBe(WIRED_MODULE_COUNT);
  });

  it("hands the media-download surface the real resourcesPath, not its null default", () => {
    // `registerMediaDownloadSurfaceIpc`'s sixth parameter is
    // `resourcesPath: string | null = null`. A DEFAULTED parameter is the one
    // kind of missing dependency the compiler cannot report: this call site
    // omitted it and typechecked clean, which in a packaged build means every
    // downloaded podcast resolves no bundled speech model, answers
    // `model-missing`, and silently arrives with no transcript — while
    // Settings, reading the same weights through the real `resourcesPath`,
    // says the model is installed. It is also the exact promise
    // `download_media`'s tool description makes to the model.
    //
    // Scanned from the source rather than asserted on behavior: the download
    // engine's deps are built inside the registrar with no seam to observe,
    // and this catches the whole failure (the argument being absent), which is
    // how it actually shipped. It cannot catch the WRONG value being passed —
    // `mediaDownloadSurfaceIpc.ts`'s own tests own that half.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, "registry.ts"), "utf8");
    const call = /\n {2}registerMediaDownloadSurfaceIpc\(([^;]*?)\n {2}\);/.exec(source);
    expect(call, "registerMediaDownloadSurfaceIpc call site not found — did it get reformatted?")
      .not.toBeNull();
    const args = call![1].split(",").map((arg) => arg.trim()).filter((arg) => arg !== "");
    expect(
      args,
      "registerMediaDownloadSurfaceIpc was called without resourcesPath, so it fell back " +
        "to its `= null` default and downloads cannot see the bundled models",
    ).toContain("resourcesPath");
  });
});

describe("registerAllIpc — completeness", () => {
  it("the completeness diff matches the documented gap list EXACTLY", () => {
    const { completeness } = build();
    // Assert each half separately so a failure names exactly what drifted,
    // rather than just "ok: false".
    expect(
      completeness.missingUndocumented,
      "channels silently dropped by a wired module"
    ).toEqual([]);
    expect(
      completeness.goneStale,
      "KNOWN_UNREGISTERED_COMMANDS lists something that IS now registered — trim the gap list"
    ).toEqual([]);
    expect(
      completeness.unexpectedChannels,
      "a registered channel is neither a Commands key nor in KNOWN_EXTRA_CHANNELS"
    ).toEqual([]);
    expect(completeness.ok).toBe(true);
  });

  it("registered + documented-gap accounts for every Commands key", () => {
    const { registeredChannels } = build();
    for (const name of ALL_COMMAND_NAMES) {
      const covered = registeredChannels.has(name) || KNOWN_UNREGISTERED_COMMANDS.has(name);
      expect(covered, `"${name}" is neither registered nor a documented gap`).toBe(true);
    }
  });

  it("every registered channel is a real Commands key or a documented extra", () => {
    const { registeredChannels } = build();
    const allowed = new Set<string>([...ALL_COMMAND_NAMES, ...KNOWN_EXTRA_CHANNELS]);
    expect([...registeredChannels].filter((c) => !allowed.has(c))).toEqual([]);
  });

  it("KNOWN_EXTRA_CHANNELS is real and complete — no forgotten extras", () => {
    const { registeredChannels } = build();
    const commandSet = new Set<string>(ALL_COMMAND_NAMES);
    const trulyExtra = new Set([...registeredChannels].filter((c) => !commandSet.has(c)));
    expect(trulyExtra).toEqual(new Set(KNOWN_EXTRA_CHANNELS));
  });

  it("checkCompleteness flags a channel silently missing from an otherwise-complete set", () => {
    const missingOne = new Set(ALL_COMMAND_NAMES.filter((c) => c !== "list_roles"));
    const report = checkCompleteness(missingOne);
    expect(report.ok).toBe(false);
    expect(report.missingUndocumented).toContain("list_roles");
  });

  it("checkCompleteness flags an unknown channel string", () => {
    const withJunk = new Set<string>([...ALL_COMMAND_NAMES, "not_a_real_command"]);
    const report = checkCompleteness(withJunk);
    expect(report.ok).toBe(false);
    expect(report.unexpectedChannels).toEqual(["not_a_real_command"]);
  });

  it("has no documented command gaps after the migration is complete", () => {
    expect([...KNOWN_UNREGISTERED_COMMANDS]).toEqual([]);
    expect(checkCompleteness(new Set(ALL_COMMAND_NAMES)).goneStale).toEqual([]);
  });
});

describe("registerAllIpc — real round trips with no room open", () => {
  it("list_roles answers a real, non-empty catalog", async () => {
    const { handlers } = build();
    const listRoles = handlers.get("list_roles");
    expect(listRoles).toBeDefined();
    const result = (await listRoles!(fakeEvent, {})) as unknown[];
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it("room_info answers null (not a throw)", async () => {
    const { handlers } = build();
    const roomInfo = handlers.get("room_info");
    expect(await roomInfo!(fakeEvent, {})).toBeNull();
  });

  it("list_recent answers an empty array against a fresh userDataDir", async () => {
    const { handlers } = build();
    expect(await handlers.get("list_recent")!(fakeEvent, {})).toEqual([]);
  });

  it("a room-scoped command refuses with the real 'No room is open.' message", async () => {
    // `Promise.resolve().then(...)`: these ported handlers are synchronous, so
    // the refusal is a THROWN error, not a rejected promise, until Electron's
    // own `ipcMain.handle` wraps it. Calling it inside a `then` gives the same
    // shape a renderer's `await invoke(...)` sees.
    const { handlers } = build();
    await expect(
      Promise.resolve().then(() =>
        handlers.get("add_memory")!(fakeEvent, { content: "hello", category: null })
      )
    ).rejects.toThrow("No room is open.");
  });

  it("a room-scoped command from a DIFFERENT module refuses the same way", async () => {
    const { handlers } = build();
    await expect(
      Promise.resolve().then(() => handlers.get("search_all")!(fakeEvent, { query: "anything" }))
    ).rejects.toThrow("No room is open.");
  });

  it("touchid_has answers a real boolean — the keychain is wired, not stubbed", async () => {
    // Was `NOT_IMPLEMENTED: touchid_has` before `roomManager.ts` was wired onto
    // `keychain.ts` (ADD-11). `keychain.has()` never prompts and never throws,
    // so with no biometric entry for this path the honest answer is `false`.
    const { handlers } = build();
    const result = await handlers.get("touchid_has")!(fakeEvent, {
      path: path.join(os.tmpdir(), `no-such-room-${randomUUID()}.roomai`),
    });
    expect(result).toBe(false);
  });
});

describe("registerAllIpc — one shared room across module boundaries", () => {
  it("a room opened through roomManagerIpc is visible to libraryTools' own channel", async () => {
    const { handlers, userDataDir } = build();
    const roomPath = path.join(userDataDir, `pr-test-${randomUUID()}.roomai`);

    const info = (await handlers.get("create_room")!(fakeEvent, {
      path: roomPath,
      password: "correct horse battery staple",
      name: null,
    })) as RoomInfo;
    expect(info.path).toBe(roomPath);

    // roomManagerIpc.ts's own handler, reading the SAME RoomManagerState...
    const again = (await handlers.get("room_info")!(fakeEvent, {})) as RoomInfo | null;
    expect(again?.path).toBe(roomPath);

    // ...and libraryTools.ts's handler, reading through the shared room-source
    // adapter, sees the identical open room with no "No room is open." refusal.
    expect(await handlers.get("list_folders")!(fakeEvent, {})).toEqual([]);

    // ...and safetyTools.ts's, which reads a DIFFERENT adapter shape
    // (`conn`/`password`, not `db`) off the same state.
    expect(await handlers.get("file_versions_kept")!(fakeEvent, {})).toEqual(expect.any(Number));
  });

  it("preserves the workspace service across the shared room adapter", async () => {
    const { handlers, userDataDir } = build();
    const roomPath = path.join(userDataDir, "Sketch Workspace");
    await handlers.get("create_room")!(fakeEvent, {
      path: roomPath,
      password: "correct horse battery staple",
      name: "Sketch Workspace",
      format: "workspace-folder",
    });
    const sketch = (await handlers.get("create_sketch")!(fakeEvent, {
      name: "Normal file",
    })) as { id: string };
    const doc = JSON.stringify({
      version: 1,
      width: 1600,
      height: 1000,
      seq: 1,
      elements: [{ id: "e1", type: "rect", x: 10, y: 10, w: 80, h: 60, ink: "blue" }],
    });

    await handlers.get("save_sketch")!(fakeEvent, {
      id: sketch.id,
      doc,
      snapshot: false,
    });

    expect(readFileSync(path.join(roomPath, "Normal file.sketch"), "utf8")).toBe(doc);
    const publicFiles = await handlers.get("list_files")!(fakeEvent, {}) as Array<{
      id: string;
      name: string;
      libraryVisibility: string;
    }>;
    expect(publicFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: sketch.id,
        name: "Normal file.sketch",
        libraryVisibility: "sectionOnly",
      }),
    ]));
  });

  it("reuses a staged media token until a file-change event invalidates it", async () => {
    const { handlers, runtimeStores, state, userDataDir } = build();
    const roomPath = path.join(userDataDir, `pr-media-${randomUUID()}.roomai`);
    await handlers.get("create_room")!(fakeEvent, {
      path: roomPath,
      password: "correct horse battery staple",
      name: null,
    });
    const id = insertFile(
      state.room!.conn,
      "large-enough-to-stage.mp4",
      "video/mp4",
      Buffer.alloc(1024 * 1024, 7),
      null,
      "import",
    ).id;

    const first = await handlers.get("get_file_content")!(fakeEvent, { id }) as FileContent;
    const second = await handlers.get("get_file_content")!(fakeEvent, { id }) as FileContent;
    expect(first.mediaToken).toBeTruthy();
    expect(second.mediaToken).toBe(first.mediaToken);
    expect(runtimeStores.mediaStreams.next).toBe(1);

    invalidateFileContentCacheForEvent(runtimeStores, "file-updated");
    const afterChange = await handlers.get("get_file_content")!(fakeEvent, { id }) as FileContent;
    expect(afterChange.mediaToken).not.toBe(first.mediaToken);
    expect(runtimeStores.mediaStreams.next).toBe(2);
  });

  it("routes a WAV with recording metadata to the recording editor", async () => {
    const { handlers, state, userDataDir } = build();
    await handlers.get("create_room")!(fakeEvent, {
      path: path.join(userDataDir, `pr-recording-${randomUUID()}.roomai`),
      password: "correct horse battery staple",
      name: null,
    });
    const file = insertFile(
      state.room!.conn,
      "Recording.wav",
      "audio/wav",
      Buffer.from("RIFF fixture"),
      "(live recording)\n",
      "recording",
    );
    setRecMeta(state.room!.conn, file.id, "{}");

    const content = await handlers.get("get_file_content")!(fakeEvent, { id: file.id }) as FileContent;
    expect(content.kind).toBe("recording");
    expect(content.mediaToken).toBeTruthy();
  });
});

describe("registerAllIpc — dependency seams this registry owns", () => {
  it("isRollingBack is the REAL state flag, not the module default of 'never busy'", async () => {
    const { handlers, state, userDataDir } = build();
    const roomPath = path.join(userDataDir, `pr-rollback-${randomUUID()}.roomai`);
    await handlers.get("create_room")!(fakeEvent, {
      path: roomPath,
      password: "correct horse battery staple",
      name: null,
    });

    state.rollingBack = true;
    await expect(
      handlers.get("change_password")!(fakeEvent, {
        current: "correct horse battery staple",
        newPassword: "a different long password",
      })
    ).rejects.toThrow("The room is rolling back");
  });

  it("onPasswordChanged updates the in-memory room password, so the NEXT password-using command works", async () => {
    // `changePasswordCore`'s own doc: "CALLER OWNS THE IN-MEMORY PASSWORD …
    // A future host-state batch that wires registerSafetyIpc should pass an
    // `onPasswordChanged` that does exactly this." Without it `state.room`
    // keeps the OLD password and the next command that needs it (here
    // `duplicate_room`, which re-keys the copy from the room's current
    // password) fails on a room that is perfectly fine.
    const { handlers, state, userDataDir } = build();
    const roomPath = path.join(userDataDir, `pr-pw-${randomUUID()}.roomai`);
    await handlers.get("create_room")!(fakeEvent, {
      path: roomPath,
      password: "correct horse battery staple",
      name: null,
    });

    await handlers.get("change_password")!(fakeEvent, {
      current: "correct horse battery staple",
      newPassword: "a different long password",
    });
    expect(state.room?.password).toBe("a different long password");

    const destPath = path.join(userDataDir, `pr-copy-${randomUUID()}.roomai`);
    await handlers.get("duplicate_room")!(fakeEvent, {
      destPath,
      newPassword: "a third long password",
    });
    expect(existsSync(destPath)).toBe(true);
  });

  it("`emit` is threaded into the wired modules, so a room change actually reaches the renderer", async () => {
    // The harness has always COLLECTED `emitted` — nothing ever asserted on
    // it, so dropping the `emit` argument from a `registerXIpc(...)` call site
    // compiled, ran, and left the whole suite green while the renderer was
    // never told the room had changed. `create_sketch` is the cheapest
    // reachable command whose handler ends in `emitSafely(emit, …)`.
    const { handlers, emitted, userDataDir } = build();
    const roomPath = path.join(userDataDir, `pr-emit-${randomUUID()}.roomai`);
    await handlers.get("create_room")!(fakeEvent, {
      path: roomPath,
      password: "correct horse battery staple",
      name: null,
    });
    const before = emitted.length;

    await handlers.get("create_sketch")!(fakeEvent, { name: "emit probe" });

    expect(emitted.slice(before).map(([event]) => event)).toContain("room-files-changed");
  });

  it("rec_retranscribe refuses in words rather than resolving to something the renderer dereferences", async () => {
    // `ipc-contract.ts` declares `rec_retranscribe -> RecMeta`, and
    // `RecordingView.tsx`'s `runRetranscribe` reads `updated.durationCs` the
    // statement after the await. The registry's override used to `await` a
    // text-only helper and return `undefined`, so the button threw a TypeError
    // in the renderer on EVERY press. The replacement returns the real
    // `RecMeta` — and when the transcription lane declines the file it answers
    // `null`, which would land the renderer in the identical crash, so the
    // registry converts that into a catchable message the toast can show.
    //
    // A `.txt` is the one refusal reachable with no sidecar: the lane
    // recognises it as non-media and declines locally, before staging or any
    // HTTP call.
    const { handlers, state, userDataDir } = build();
    await handlers.get("create_room")!(fakeEvent, {
      path: path.join(userDataDir, `pr-retrans-${randomUUID()}.roomai`),
      password: "correct horse battery staple",
      name: null,
    });
    const file = insertFile(
      state.room!.conn,
      "not-audio.txt",
      "text/plain",
      Buffer.from("just words"),
      "just words",
      "import",
    );

    await expect(
      Promise.resolve().then(() => handlers.get("rec_retranscribe")!(fakeEvent, { id: file.id })),
    ).rejects.toThrow("could not be transcribed");
  });

  it("explicitModel reads the OPEN ROOM's own model setting, not a constant null", async () => {
    // `ai_status`/`warm_model`/`grounding_model_for_room` all resolve through
    // this seam. `() => null` — the modules' own default, and what one merge
    // candidate shipped — makes all three answer for a room the user does not
    // have open. Untestable through the handlers themselves: every one of them
    // hits `listModels()` (the network) before it reaches this value.
    const { handlers, state, userDataDir } = build();
    const explicitModel = buildExplicitModel(state);

    expect(explicitModel()).toBeNull(); // no room open

    const roomPath = path.join(userDataDir, `pr-model-${randomUUID()}.roomai`);
    await handlers.get("create_room")!(fakeEvent, {
      path: roomPath,
      password: "correct horse battery staple",
      name: null,
    });
    // A brand-new room has chosen no model yet — still null, but now for the
    // real reason rather than because the seam is hardcoded.
    expect(explicitModel()).toBeNull();

    await handlers.get("set_setting")!(fakeEvent, { key: "model", value: "qwen3.5:4b-mlx" });
    expect(explicitModel()).toBe("qwen3.5:4b-mlx");

    await handlers.get("close_room")!(fakeEvent, {});
    expect(explicitModel()).toBeNull();
  });
});

// ============================================================================
// The host bridge — the four channels registerAllIpc registers itself
// ============================================================================

describe("registerAllIpc — the host-bridge channels", () => {
  it("registers all five through the recording shim, so the completeness diff sees them", () => {
    // The point of registering these HERE rather than on `ipcMain` directly in
    // `main/index.ts`: a channel outside the shim stays listed as an unwired
    // gap forever while being live. Both halves are asserted — present in the
    // observed set, absent from the documented gap list.
    const { registeredChannels } = build();
    for (const channel of [
      "run_command",
      "set_unsaved_edits",
      "quit_guard_rearm",
      "quit_guard_confirm",
      "menu_sync",
    ]) {
      expect(registeredChannels.has(channel), `${channel} was not registered`).toBe(true);
      expect(KNOWN_UNREGISTERED_COMMANDS.has(channel), `${channel} is still listed as a gap`).toBe(
        false
      );
    }
  });

  it("set_unsaved_edits / quit_guard_rearm / quit_guard_confirm reach the host's quit door", async () => {
    const { handlers, hostCalls } = build();
    await handlers.get("set_unsaved_edits")!(fakeEvent, { on: true });
    await handlers.get("quit_guard_rearm")!(fakeEvent, {});
    await handlers.get("quit_guard_confirm")!(fakeEvent, {});
    expect(hostCalls).toEqual([
      ["setUnsavedEdits", true],
      ["rearmQuitGuard", null],
      ["confirmQuit", null],
    ]);
  });

  it("set_unsaved_edits REFUSES a non-boolean payload rather than reading it as false", async () => {
    // Coercing would silently disarm the guard — see the handler's own comment.
    // A synchronous throw, which is what real Electron's `ipcMain.handle`
    // turns into a rejected `invoke()` on the renderer side either way.
    const { handlers, hostCalls } = build();
    expect(() => handlers.get("set_unsaved_edits")!(fakeEvent, { on: "yes" })).toThrow(
      "needs a boolean"
    );
    expect(() => handlers.get("set_unsaved_edits")!(fakeEvent, {})).toThrow("needs a boolean");
    expect(hostCalls).toEqual([]);
  });

  it("menu_sync hands the host a complete ViewMenuState, defaulted field by field", async () => {
    const { handlers, hostCalls } = build();
    await handlers.get("menu_sync")!(fakeEvent, {
      view: { enabled: true, library: true, sidebar: "Sketches" },
    });
    expect(hostCalls).toEqual([
      [
        "syncMenu",
        {
          enabled: true,
          library: true,
          assistant: false,
          focus: false,
          railLabels: false,
          railLabelsSettable: false,
          sidebar: "Sketches",
        },
      ],
    ]);
  });

  it("the six dialog/shell channels are registered over the INJECTED modules", async () => {
    // `dialogTools.test.ts`/`shellTools.test.ts` own what these handlers do.
    // What this owns is that the registry wired them at all, and wired them to
    // the objects the caller handed in rather than to something of its own —
    // the failure mode being a registry that registers the channel names (so
    // the completeness diff is happy) over a module nothing can observe.
    const { registeredChannels, handlers, dialogCalls, shellCalls } = build();
    for (const channel of [
      "dialog_open",
      "dialog_save",
      "dialog_message",
      "open_url",
      "open_path",
      "reveal_item_in_dir",
    ]) {
      expect(registeredChannels.has(channel), `${channel} was not registered`).toBe(true);
      expect(KNOWN_UNREGISTERED_COMMANDS.has(channel), `${channel} is listed as a gap`).toBe(false);
    }

    await handlers.get("dialog_open")!(fakeEvent, {});
    await handlers.get("dialog_message")!(fakeEvent, { message: "hi" });
    await handlers.get("open_url")!(fakeEvent, { url: "https://example.com/x" });
    await handlers.get("reveal_item_in_dir")!(fakeEvent, { paths: ["/tmp/a"] });

    expect(dialogCalls.map(([name]) => name)).toEqual(["showOpenDialog", "showMessageBox"]);
    expect(shellCalls).toEqual([
      ["openExternal", "https://example.com/x"],
      ["showItemInFolder", "/tmp/a"],
    ]);
  });

  it("readViewMenuState survives a missing view, a null payload and a wrong-typed sidebar", () => {
    const allOff = {
      enabled: false,
      library: false,
      assistant: false,
      focus: false,
      railLabels: false,
      railLabelsSettable: false,
      sidebar: "",
    };
    expect(readViewMenuState(undefined)).toEqual(allOff);
    expect(readViewMenuState(null)).toEqual(allOff);
    expect(readViewMenuState({})).toEqual(allOff);
    expect(readViewMenuState({ view: { sidebar: 7 } })).toEqual(allOff);
  });

  it("run_command reaches the real runCommand: a real catalog refusal, then a real room refusal", async () => {
    const { handlers } = build();
    const req = {
      askId: randomUUID(),
      chatId: randomUUID(),
      command: "not-a-real-command",
      args: "",
      refs: [],
      raw: "#not-a-real-command",
    };
    // Catalog validation happens before the room is even looked at, so this
    // message can only come from `runCommand` itself.
    await expect(handlers.get("run_command")!(fakeEvent, req)).rejects.toThrow(
      "Unknown command #not-a-real-command."
    );
    await expect(
      handlers.get("run_command")!(fakeEvent, { ...req, command: "checkpoint", raw: "#checkpoint" })
    ).rejects.toThrow("No room is open.");
  });
});
