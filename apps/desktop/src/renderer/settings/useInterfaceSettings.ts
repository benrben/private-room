import { useCallback, useSyncExternalStore } from "react";
import { forgetSavedLayouts } from "../shell/useLayout";
import { resetNavPrefs } from "../shell/navPrefs";
import { resetSkinWorkspace } from "../skin/skinStore";

/** How much room the interface gives itself. */
export type Density = "comfortable" | "compact";
/** Whether the dotted sheet is drawn behind the room. */
export type Texture = "subtle" | "off";

const DENSITY_KEY = "prDensity";
const TEXTURE_KEY = "prTexture";

/** Device preferences, stamped on <html> and read by tokens.css / paper.css —
 * exactly the contract `theme.ts` already has, and for the same reason: these
 * describe this Mac's screen and this reader's eyes, not the contents of any
 * one room, so they belong beside the theme rather than inside an encrypted
 * room file.
 *
 * Both are applied by writing a data attribute rather than by inlining styles,
 * so the whole app changes from one place and nothing has to be re-rendered
 * for it to take effect. */
function readDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

function readTexture(): Texture {
  try {
    return localStorage.getItem(TEXTURE_KEY) === "off" ? "off" : "subtle";
  } catch {
    return "subtle";
  }
}

export function applyDensity(v: Density): void {
  // The default carries NO attribute at all, so the comfortable rules are the
  // plain ones and compact is the override. A `data-density="comfortable"`
  // would mean every spacing token needed two definitions to stay in step.
  if (v === "compact") document.documentElement.dataset.density = "compact";
  else delete document.documentElement.dataset.density;
}

export function applyTexture(v: Texture): void {
  if (v === "off") document.documentElement.dataset.texture = "off";
  else delete document.documentElement.dataset.texture;
}

/** Put both in force at startup, before React paints — called from main.tsx
 * beside `initTheme`. Without it the app opens comfortable-and-dotted for a
 * frame and then snaps, which is the same flash `applyTheme` exists to
 * prevent. */
export function initInterface(): void {
  applyDensity(readDensity());
  applyTexture(readTexture());
}

/* A tiny shared store, so the Settings section and anything else that ever
   shows these values cannot drift apart. Same shape as shell/navPrefs. */
let cache: { density: Density; texture: Texture } | null = null;
const listeners = new Set<() => void>();

function snapshot() {
  if (!cache) cache = { density: readDensity(), texture: readTexture() };
  return cache;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function commit(next: { density: Density; texture: Texture }) {
  cache = next;
  listeners.forEach((fn) => fn());
}

export function useInterfaceSettings() {
  const { density, texture } = useSyncExternalStore(subscribe, snapshot, snapshot);

  const setDensity = useCallback((v: Density) => {
    try {
      if (v === "comfortable") localStorage.removeItem(DENSITY_KEY);
      else localStorage.setItem(DENSITY_KEY, v);
    } catch {
      /* preference just won't persist */
    }
    applyDensity(v);
    commit({ ...snapshot(), density: v });
  }, []);

  const setTexture = useCallback((v: Texture) => {
    try {
      if (v === "subtle") localStorage.removeItem(TEXTURE_KEY);
      else localStorage.setItem(TEXTURE_KEY, v);
    } catch {
      /* preference just won't persist */
    }
    applyTexture(v);
    commit({ ...snapshot(), texture: v });
  }, []);

  /** Put every interface preference back to what a fresh install has.
   *
   * All THREE stores, which is the point of having one button: the customized
   * sidebar, the per-room pane layouts, and these two. A reset that left any
   * of them behind would be the worst kind — the reader concludes the setting
   * is stuck rather than that the button is partial.
   *
   * The saved layouts are per-room records keyed by a digest of each room's
   * path, so this clears them for EVERY room on this Mac, not just the one
   * that happens to be open. That is what "reset to Arcelle defaults" has to
   * mean; the alternative is a button whose effect depends on which room you
   * pressed it in. */
  const resetAll = useCallback(() => {
    setDensity("comfortable");
    setTexture("subtle");
    resetNavPrefs();
    forgetSavedLayouts();
    resetSkinWorkspace();
  }, [setDensity, setTexture]);

  return { density, setDensity, texture, setTexture, resetAll };
}
