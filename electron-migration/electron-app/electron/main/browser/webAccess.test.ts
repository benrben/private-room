/**
 * Coverage of `webAccess.ts` — port of `web_access_enabled`/
 * `require_web_enabled` (`src-tauri/src/commands.rs`). Rust has no dedicated
 * `mod tests` for these two (they are exercised only through the commands that
 * call them); this file pins the documented backward-compatibility rule and
 * the two-different-refusals rule directly, rather than leaving either to be
 * hit as a side effect of some other test.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRoom } from "../db-host/open.js";
import { setSetting } from "../db-host/settings.js";
import { requireWebEnabled, webAccessEnabled } from "./webAccess.js";

let tmpDir: string;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function freshRoom() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "web-access-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

describe("webAccessEnabled", () => {
  it("is off for a brand-new room that never chose a provider, and for an explicit 'off'", () => {
    const db = freshRoom();
    expect(webAccessEnabled(db)).toBe(false);
    setSetting(db, "web_provider", "off");
    expect(webAccessEnabled(db)).toBe(false);
    // An empty value is not a choice either.
    setSetting(db, "web_provider", "");
    expect(webAccessEnabled(db)).toBe(false);
    db.close();
  });

  // There is no provider to choose any more — the app has exactly one search
  // engine — but a room saved when the switch WAS a provider dropdown still
  // holds one of these old values, and every one of them meant "internet on".
  it("stays on for every legacy provider value", () => {
    const db = freshRoom();
    for (const legacy of ["duckduckgo", "searxng", "brave"]) {
      setSetting(db, "web_provider", legacy);
      expect(webAccessEnabled(db)).toBe(true);
    }
    db.close();
  });
});

describe("requireWebEnabled", () => {
  it("tells a closed room and an offline room apart, in different words", () => {
    expect(() => requireWebEnabled(null)).toThrow("No room is open.");
    const db = freshRoom();
    expect(() => requireWebEnabled(db)).toThrow(
      "This room is offline. Turn on Settings → Online features to use the browser.",
    );
    db.close();
  });

  it("hands the open room back once the switch is on, so callers need no cast", () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "duckduckgo");
    expect(requireWebEnabled(db)).toBe(db);
    db.close();
  });
});
