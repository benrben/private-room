import { describe, expect, it } from "vitest";
import {
  ALL_COMMAND_NAMES,
  ALL_EVENT_NAMES,
  COMMAND_CHANNEL_SET,
  EVENT_CHANNEL_SET,
  isKnownCommandChannel,
  isKnownEventChannel,
} from "./channelAllowlist.js";

describe("channelAllowlist command names", () => {
  it("lists every command exactly once, no duplicates", () => {
    expect(new Set(ALL_COMMAND_NAMES).size).toBe(ALL_COMMAND_NAMES.length);
  });

  it("matches the real ipc-contract.ts command count", () => {
    // `ipc-contract.ts`'s own trailing comment claims 291; the compile-checked
    // object literal in `channelAllowlist.ts` is checked against the actual
    // `Commands` type at build time, so the true count is whatever TypeScript
    // accepted. Pinned here so a future contract edit is a deliberate, noticed
    // change rather than a silent one.
    //
    // 306 = the 296 commands extracted from `api.ts`, plus the 7 this
    // migration added for surfaces Tauri answered with PLUGINS rather than
    // commands: `dialog_open`/`dialog_save`/`dialog_message` (plugin-dialog),
    // `open_url`/`open_path`/`reveal_item_in_dir` (plugin-opener), and
    // `quit_guard_confirm` (plugin-process's `exit(0)`, which finished a held
    // quit), plus the 3 Electron updater/version host commands.
    expect(ALL_COMMAND_NAMES.length).toBe(307);
  });

  it("COMMAND_CHANNEL_SET agrees with ALL_COMMAND_NAMES", () => {
    expect(COMMAND_CHANNEL_SET.size).toBe(ALL_COMMAND_NAMES.length);
    for (const name of ALL_COMMAND_NAMES) {
      expect(COMMAND_CHANNEL_SET.has(name)).toBe(true);
    }
  });

  it("isKnownCommandChannel accepts every real command name", () => {
    for (const name of ALL_COMMAND_NAMES) {
      expect(isKnownCommandChannel(name)).toBe(true);
    }
  });

  it("isKnownCommandChannel rejects an unknown string", () => {
    expect(isKnownCommandChannel("not_a_real_command")).toBe(false);
    expect(isKnownCommandChannel("")).toBe(false);
  });

  it("isKnownCommandChannel rejects prototype-pollution-shaped keys safely", () => {
    // The point of a Set-backed allowlist rather than a `{}` lookup object:
    // these must read as "unknown", never as truthy own-property lookups
    // inherited from Object.prototype.
    for (const junk of ["__proto__", "constructor", "hasOwnProperty", "toString", "valueOf"]) {
      expect(isKnownCommandChannel(junk)).toBe(false);
    }
  });

  it("an event channel is NOT a command channel", () => {
    expect(isKnownCommandChannel("ask-delta")).toBe(false);
    expect(isKnownCommandChannel("rec-level")).toBe(false);
  });

  it("known command names spot-check", () => {
    expect(isKnownCommandChannel("create_room")).toBe(true);
    expect(isKnownCommandChannel("ask")).toBe(true);
    expect(isKnownCommandChannel("touchid_has")).toBe(true);
    expect(isKnownCommandChannel("write_recovery_key")).toBe(true);
  });

  it("every command name is a snake_case identifier", () => {
    for (const name of ALL_COMMAND_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("channelAllowlist event names", () => {
  it("lists every event exactly once, no duplicates", () => {
    expect(new Set(ALL_EVENT_NAMES).size).toBe(ALL_EVENT_NAMES.length);
  });

  it("matches the real events.ts channel count", () => {
    // events.ts's trailing prose comment still says "(59 channels total)" — it
    // is stale; the TYPE has 60 keys (`pull-progress` was added after that
    // comment was written). The compile-checked object literal in
    // `channelAllowlist.ts` is checked against the actual `EventPayloads`
    // type, so the true count is whatever TypeScript accepted. Pinned here so
    // a future contract edit is a deliberate, noticed change.
    expect(ALL_EVENT_NAMES.length).toBe(60);
  });

  it("EVENT_CHANNEL_SET agrees with ALL_EVENT_NAMES", () => {
    expect(EVENT_CHANNEL_SET.size).toBe(ALL_EVENT_NAMES.length);
    for (const name of ALL_EVENT_NAMES) {
      expect(EVENT_CHANNEL_SET.has(name)).toBe(true);
    }
  });

  it("isKnownEventChannel accepts every real event name", () => {
    for (const name of ALL_EVENT_NAMES) {
      expect(isKnownEventChannel(name)).toBe(true);
    }
  });

  it("isKnownEventChannel rejects an unknown string", () => {
    expect(isKnownEventChannel("totally-made-up-event")).toBe(false);
    expect(isKnownEventChannel("")).toBe(false);
  });

  it("isKnownEventChannel rejects prototype-pollution-shaped keys safely", () => {
    for (const junk of ["__proto__", "constructor", "hasOwnProperty", "toString"]) {
      expect(isKnownEventChannel(junk)).toBe(false);
    }
  });

  it("a command channel is NOT an event channel", () => {
    expect(isKnownEventChannel("create_room")).toBe(false);
    expect(isKnownEventChannel("room_info")).toBe(false);
  });

  it("known event names spot-check", () => {
    expect(isKnownEventChannel("ask-delta")).toBe(true);
    expect(isKnownEventChannel("rec-level")).toBe(true);
    expect(isKnownEventChannel("job-progress")).toBe(true);
    expect(isKnownEventChannel("room-files-changed")).toBe(true);
  });

  it("the two allowlists are disjoint", () => {
    for (const name of ALL_EVENT_NAMES) {
      expect(COMMAND_CHANNEL_SET.has(name)).toBe(false);
    }
  });
});
