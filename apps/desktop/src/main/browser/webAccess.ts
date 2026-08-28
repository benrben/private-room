/**
 * The room's single internet switch (Settings → Online features). Ported from
 * `web_access_enabled`/`require_web_enabled` in `src-tauri/src/commands.rs`.
 *
 * The model's web tools are already gated at the served catalog, but the
 * ADDRESS BAR is not a model — and without this check a room whose settings
 * read "Off — room stays offline" would still reach the internet the moment
 * the user typed a URL. That is a false privacy claim, not a missing nicety,
 * so the check lives at the one function every browser inlet goes through.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { getSetting } from "../db-host/settings.js";

/**
 * The web tools exist for the model only when the room's internet switch is
 * on. There is no provider to choose any more — the app has exactly one search
 * engine — so this is a plain on/off read.
 *
 * `web_provider` keeps its name and its old values keep working: a room saved
 * when the switch was a provider dropdown holds "duckduckgo", "searxng" or
 * "brave", and every one of those meant "internet on", so they still do. Only
 * "off" (or never having chosen) is off. That IS the migration — there is no
 * rewrite step, and a room downgraded to an older build still reads as on.
 */
export function webAccessEnabled(db: Database.Database): boolean {
  const v = getSetting(db, "web_provider");
  return v !== null && v !== "" && v !== "off";
}

/**
 * {@link webAccessEnabled} as a REFUSAL, for the inlets a PERSON drives.
 *
 * TWO refusals, never folded into one. Rust reaches the setting through
 * `state.room.lock()...ok_or("No room is open.")?`, so a room that is not open
 * at all fails with its OWN message before the switch is ever read — "there is
 * nowhere to check" and "the switch is off" are different facts and the user
 * can only act on one of them.
 *
 * Returns the open handle so callers get a non-null `Database` without a cast:
 * everything downstream of this line has, by construction, a room to work in.
 */
export function requireWebEnabled(db: Database.Database | null): Database.Database {
  if (!db) {
    throw new Error("No room is open.");
  }
  if (!webAccessEnabled(db)) {
    throw new Error("This room is offline. Turn on Settings → Online features to use the browser.");
  }
  return db;
}
