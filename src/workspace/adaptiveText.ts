/* Generic "adaptive UI text" client layer — the frontend half of a small,
 * generic "write me a short piece of adaptive UI text from local facts"
 * service (an area subtitle, a 2-3 word tab title, a one-line activity
 * summary, ...). This module owns NO prompt wording of its own — the caller
 * composes the whole prompt — it is only the cache + timing harness around
 * `api.generateUiText`, built once against a fixed cross-layer contract that
 * the sidecar (ai_actions.py) and Rust (ai_actions.rs) built their halves of
 * in parallel, with no ability to coordinate live.
 *
 * The core rule this hook exists to enforce ("never blocks, 400ms or next
 * time, null is valid, no mid-read swap"):
 *
 *   - A cache hit (including a cached `null`) renders synchronously, with no
 *     async delay at all.
 *   - A cache miss ALWAYS renders the caller's static fallback first — this
 *     hook never returns a "loading" state and a consumer must never show a
 *     spinner for it. Generation runs in the background.
 *   - If that background call resolves within ~400ms, the result is shown
 *     for THIS render (still fast enough to read as "the same view"). If it
 *     resolves later, the result is cached for NEXT time only — this view
 *     has already committed to its static fallback and swapping the text
 *     under the user's eyes mid-read is exactly the failure mode this rule
 *     exists to prevent.
 *
 * KNOWN LIMITATIONS (v1, by design — see the report that shipped this):
 *   - The cache is in-memory only (a plain Map) and does not survive an app
 *     restart. DB/localStorage persistence is explicitly out of scope here.
 *   - The master on/off flag (below) is read once per app session into a
 *     module-level variable; a change to it does not instantly re-render
 *     already-mounted consumers, only ones that mount/re-key afterward. A
 *     Settings row (Behavior section) does flip it — see
 *     settings/BehaviorSection.tsx / useBehaviorSettings.ts, following the
 *     existing `auto_index` / `memory_auto_save` convention — but toggling it
 *     there only persists the setting for next session/mount; it does not
 *     reach back into this module-level variable to change what's already on
 *     screen.
 *   - The cache key intentionally does NOT include `maxWords` (the contract
 *     specifies roomId+kind+prompt+facts only). A `maxWords`-only change
 *     still re-triggers generation (see the effect's dependency array) and
 *     overwrites whatever was cached under that key — so it can't get stuck
 *     stale, it just isn't a distinct cache slot from a same-prompt call at
 *     a different word budget.
 */
import { useEffect, useState } from "react";
import { api, generateUiText } from "../api";

/** A cache hit (including a cached `null`) is available synchronously — the
 * fast path. A cache miss returns `undefined` for the current render (show
 * the static fallback) while generation runs in the background. `null` means
 * "known: there is no generated text" (feature off, or the sidecar degraded
 * — offline model, failed validation, etc). Both `null` and `undefined` are
 * nullish, so most callers can just do `useAdaptiveText(...) ?? staticText`
 * and never need to tell the two apart. */
export type AdaptiveText = string | null | undefined;

export interface UseAdaptiveTextOptions {
  /** Included in the cache key so switching rooms can never show stale text
   * generated for a different room. */
  roomId: string;
  /** Free-form label ("dek" / "tab_title" / "activity_summary" / ...) —
   * forwarded to the sidecar for logging only, plays no role in caching
   * beyond being part of the key (two features with the same prompt+facts
   * but different `kind` get separate cache slots). */
  kind: string;
  /** The full, already-composed instruction text. This module adds no
   * wording of its own. */
  prompt: string;
  /** The raw structured facts `prompt` was built from. Sent to the sidecar
   * for its numeral-fabrication guard; also folded into the cache key so a
   * change in the underlying facts (even with `prompt` text unchanged)
   * invalidates the cache. */
  facts: unknown;
  maxWords: number;
  /** Per-call opt-out — lets a caller skip generating entirely (e.g. not
   * enough facts yet to be worth a call). Independent of, and ANDed with,
   * the module-level master switch below. */
  enabled: boolean;
}

/** Room-setting key for the top-level master switch on the whole
 * adaptive-text layer, stored the same way as the other optional-AI-feature
 * toggles (api.getSetting/setSetting — see auto_index/memory_auto_save in
 * settings/useBehaviorSettings.ts): absent = on, "0" = off. Default ON. */
const MASTER_FLAG_SETTING_KEY = "adaptive_text_enabled";

/** How long the background call is allowed to still land in THIS render.
 * Past this, the result is cache-only — the view already committed to its
 * static fallback and must not swap text under the user mid-read. */
const SWAP_WINDOW_MS = 400;

let masterFlagOn = true;
let masterFlagLoadStarted = false;

/** Kick off (once per app session) the async read of the master flag. Safe
 * to call on every hook render — only the first call actually fires the
 * `getSetting` round trip. An unreachable/offline read leaves the default
 * (on) in place rather than turning the feature off by accident. */
function ensureMasterFlagLoaded(): void {
  if (masterFlagLoadStarted) return;
  masterFlagLoadStarted = true;
  api
    .getSetting(MASTER_FLAG_SETTING_KEY)
    .then((v) => {
      masterFlagOn = v !== "0";
    })
    .catch(() => {
      // Leave masterFlagOn at its default (true, i.e. on).
    });
}

/** Recursively sorts object keys so two facts objects with the same content
 * but different key insertion order produce the same cache key. Arrays keep
 * their order (order is meaningful there); only plain-object key order is
 * normalized. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k]);
    return out;
  }
  return value;
}

/** Stable, collision-resistant-enough cache key for one (room, kind, prompt,
 * facts) tuple — not a cryptographic hash, just a canonicalized
 * JSON.stringify, which this cache's scale (a handful of short-lived UI
 * strings per session) doesn't need more than. Exported for the test file;
 * not expected to be called directly by feature code. */
export function adaptiveTextCacheKey(
  roomId: string,
  kind: string,
  prompt: string,
  facts: unknown,
): string {
  return JSON.stringify({ roomId, kind, prompt, facts: canonicalize(facts) });
}

/** Module-level cache: content-based invalidation only, no TTL — a key's
 * entry is valid forever until its (roomId, kind, prompt, facts) content
 * changes and produces a different key. In-memory only; see the file-level
 * comment for why that's an accepted v1 limitation, not an oversight. */
const cache = new Map<string, AdaptiveText>();

/** Generate (or serve from cache) one short piece of adaptive UI text.
 *
 * Returns `undefined` on a fresh cache miss (show your static fallback —
 * never a spinner), `null` once it's known there is no generated text
 * (feature disabled, or the sidecar degraded), or the generated `string`.
 * See {@link AdaptiveText} — `?? staticFallback` covers both empty states.
 *
 * Safe against the component unmounting before the background call
 * resolves (no state update fires after unmount). */
export function useAdaptiveText(opts: UseAdaptiveTextOptions): AdaptiveText {
  const { roomId, kind, prompt, facts, maxWords, enabled } = opts;
  ensureMasterFlagLoaded();
  const active = enabled && masterFlagOn;
  const key = adaptiveTextCacheKey(roomId, kind, prompt, facts);
  // `active` rides along in the identity string (not just `key`) so a caller
  // flipping `enabled` — or the master flag finishing its load — on the same
  // key is treated as a fresh state, not silently ignored.
  const identity = `${active ? "1" : "0"} ${key}`;

  const [appliedIdentity, setAppliedIdentity] = useState(identity);
  const [text, setText] = useState<AdaptiveText>(() =>
    active ? cache.get(key) : null,
  );

  // React's documented "adjusting state during render" pattern: when the
  // identity changes, synchronously reset `text` to whatever this identity's
  // cache holds (a hit, including a cached `null`) BEFORE this render is
  // painted. This is what makes a cache hit render with no async delay at
  // all, and what keeps a key/enabled change from ever showing a moment of
  // the PREVIOUS key's text.
  if (identity !== appliedIdentity) {
    setAppliedIdentity(identity);
    setText(active ? cache.get(key) : null);
  }

  useEffect(() => {
    if (!active) return;
    if (cache.has(key)) return; // already served by the synchronous path above
    let cancelled = false;
    const startedAt = Date.now();
    generateUiText(kind, prompt, facts, maxWords)
      .catch(() => null)
      .then((result) => {
        if (cancelled) return;
        cache.set(key, result);
        if (Date.now() - startedAt <= SWAP_WINDOW_MS) {
          setText(result);
        }
        // Past the window: cache-only write. This view already committed to
        // its static fallback for this viewing — do not swap it now.
      });
    return () => {
      cancelled = true;
    };
    // `kind`/`prompt`/`facts` are intentionally NOT deps: they're fully
    // encoded in `key`, and re-running this effect on every referentially-
    // new-but-content-equal `facts` object (a common shape for an inline
    // object literal passed by a caller) would fire duplicate, wasted
    // generation calls mid-flight. `maxWords` IS a dep on purpose — see the
    // file-level comment on why it sits outside the cache key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active, maxWords]);

  return text;
}
