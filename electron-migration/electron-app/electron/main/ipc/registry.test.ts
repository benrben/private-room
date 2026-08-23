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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

import type { RoomInfo } from "../../shared/apiTypes.js";
import type { RoomManagerState } from "../roomManager.js";
import {
  ALL_COMMAND_NAMES,
  KNOWN_EXTRA_CHANNELS,
  KNOWN_UNREGISTERED_COMMANDS,
  WIRED_MODULE_COUNT,
  buildExplicitModel,
  checkCompleteness,
  createDefaultRoomManagerDeps,
  createRoomManagerState,
  registerAllIpc,
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
}

function build(): Built {
  const userDataDir = freshUserDataDir();
  const { ipcMain, handlers, calls } = fakeIpcMain();
  const state = createRoomManagerState();
  const emitted: [string, unknown][] = [];
  const emit = (event: string, payload: unknown): void => {
    emitted.push([event, payload]);
  };
  const deps = createDefaultRoomManagerDeps(userDataDir, emit);
  const result = registerAllIpc({
    ipcMain,
    state,
    deps,
    emit,
    userDataDir,
    resourcesPath: null,
  });
  return { ...result, handlers, calls, state, userDataDir, emitted };
}

describe("registerAllIpc — registration", () => {
  it("registers every wired module with no duplicate-channel conflict", () => {
    expect(() => build()).not.toThrow();
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

  it("checkCompleteness flags a documented gap that has actually been registered", () => {
    const oneExtra = new Set<string>([
      ...ALL_COMMAND_NAMES.filter((c) => !KNOWN_UNREGISTERED_COMMANDS.has(c)),
      "ask",
    ]);
    const report = checkCompleteness(oneExtra);
    expect(report.ok).toBe(false);
    expect(report.goneStale).toEqual(["ask"]);
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
