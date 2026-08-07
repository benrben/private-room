import { api, NeuralVoiceInfo } from "../api";

/** Naming and grouping for the neural voice catalog.
 *
 * Extracted from VoiceSection so the podcast's per-host picker and Settings'
 * single picker cannot describe the same voice differently. Two places naming
 * voices independently is the shape of bug this codebase has already paid for
 * once: "Andrew — male" in one list and "AndrewMultilingual" in the other reads
 * as two voices, and the user picks the wrong one to fix a mismatch that isn't
 * real.
 *
 * There is deliberately NO bundled roster here. The catalog is fetched live
 * (`api.listNeuralVoices`), so a voice added by the service appears without an
 * app update — these are only the functions that turn ids into words. */

/** The one in-flight (or settled) catalog fetch, shared by every picker.
 *
 * WHY THIS IS MODULE-LEVEL AND NOT A HOOK. Both pickers used to fetch on mount
 * and drop the result if the component went away first (`alive && setVoices`).
 * The podcast panel mounts and unmounts as the Studio tab swaps, so its fetch
 * could be cancelled every time and the catalog would never arrive — leaving
 * "Suggest voices" permanently disabled in a room whose internet is on, with
 * nothing on screen saying why. Hoisting the promise here means the request
 * happens ONCE per session, survives any remount, and a late-mounting picker
 * gets the already-settled answer instead of starting over.
 */
let catalogPromise: Promise<NeuralVoiceInfo[]> | null = null;

/** Fetch the voice catalog, at most once per session (per success).
 *
 * A FAILURE IS NOT CACHED: the memo is cleared on rejection so the next picker
 * to open retries. Caching the failure would make one bad moment — the sidecar
 * still starting, the network briefly down — permanent for the whole session,
 * which is exactly the symptom this function exists to remove. Callers still
 * see the rejection and must say so; silence is what made this invisible.
 */
export function loadVoiceCatalog(): Promise<NeuralVoiceInfo[]> {
  if (!catalogPromise) {
    catalogPromise = api.listNeuralVoices().catch((e) => {
      catalogPromise = null;
      throw e;
    });
  }
  return catalogPromise;
}

/** "he-IL-AvriNeural" → "Avri"; "en-US-AndrewMultilingualNeural" → "Andrew". */
export function voiceName(id: string): string {
  return id
    .split("-")
    .slice(2)
    .join("-")
    .replace(/MultilingualNeural$/, "")
    .replace(/Neural$/, "");
}

/** "he-IL" → "Hebrew (Israel)" — from the platform, not a bundled table. */
export function languageLabel(locale: string): string {
  try {
    return (
      new Intl.DisplayNames(["en"], { type: "language" }).of(locale) ?? locale
    );
  } catch {
    return locale;
  }
}

/** The one-line label for a voice in a picker. */
export function optionLabel(v: NeuralVoiceInfo): string {
  return v.gender
    ? `${voiceName(v.id)} — ${v.gender.toLowerCase()}`
    : voiceName(v.id);
}

/** A voice that reads whatever language it is given, rather than one language
 * well. The distinction is load-bearing for a podcast: a Hebrew script cast in
 * `en-US` voices is not accented, it is unintelligible. */
export function isMultilingual(v: NeuralVoiceInfo): boolean {
  return v.id.includes("Multilingual");
}

export interface GroupedVoices {
  multilingual: NeuralVoiceInfo[];
  /** Language display name → its voices, languages sorted alphabetically. */
  byLanguage: [string, NeuralVoiceInfo[]][];
}

/** Multilingual first, then one group per language. The order both pickers
 * render, so a reader who learned the shape in Settings finds it again here. */
export function groupVoices(voices: NeuralVoiceInfo[]): GroupedVoices {
  const byLanguage = new Map<string, NeuralVoiceInfo[]>();
  for (const v of voices) {
    if (isMultilingual(v)) continue;
    const lang = languageLabel(v.locale);
    const group = byLanguage.get(lang);
    if (group) group.push(v);
    else byLanguage.set(lang, [v]);
  }
  return {
    multilingual: voices.filter(isMultilingual),
    byLanguage: [...byLanguage.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  };
}

/** Pick `count` voices that are as distinguishable from each other as the
 * catalog allows — the seed a fresh cast is offered.
 *
 * Two hosts in the same voice is not a two-voice podcast, and two hosts in the
 * same voice with different names is worse: the page says one thing and the
 * audio says another. So this never repeats a voice while an unused one
 * remains, and it alternates gender where the catalog reports one, because
 * that is the single strongest cue that two speakers are different people.
 *
 * Multilingual voices lead, so a script in any language is readable by default.
 * The room's already-chosen voice, when it is passed in `preferred`, keeps its
 * place at the front — the first host then sounds like the voice the user
 * already decided they liked. */
export function suggestDistinctVoices(
  voices: NeuralVoiceInfo[],
  count: number,
  preferred?: string,
): string[] {
  const pool = [
    ...voices.filter(isMultilingual),
    ...voices.filter((v) => !isMultilingual(v)),
  ];
  const picked: string[] = [];
  const lead = preferred && pool.find((v) => v.id === preferred);
  if (lead) picked.push(lead.id);
  while (picked.length < count) {
    const lastGender = picked.length
      ? pool.find((v) => v.id === picked[picked.length - 1])?.gender
      : undefined;
    const next =
      // Prefer an unused voice of the OTHER gender…
      pool.find(
        (v) =>
          !picked.includes(v.id) &&
          v.gender &&
          lastGender &&
          v.gender !== lastGender,
      ) ??
      // …then any unused voice at all…
      pool.find((v) => !picked.includes(v.id));
    // …and if the catalog is smaller than the cast, stop rather than repeat:
    // an empty id means "the product default" everywhere else, which is a
    // truthful "not chosen" rather than a duplicate pretending to be a choice.
    if (!next) break;
    picked.push(next.id);
  }
  while (picked.length < count) picked.push("");
  return picked;
}

/** True when a cast has not really been cast: some host has no voice, or two
 * hosts share one.
 *
 * THE BUG THIS NAMES. A cast is seeded server-side from the room's cached
 * catalog, and a room that has never opened the voice picker has no cache — so
 * every host is seeded with "" ("the product default"), and a fresh two-host
 * podcast comes out in ONE voice. That is not a choice the user made and it is
 * not a state worth preserving; when the live catalog is available the panel
 * fills it in with distinct voices and leaves the result unsaved, so the user
 * confirms rather than discovers it on playback.
 *
 * A DUPLICATE COUNTS, not just a blank: two hosts explicitly seeded to the same
 * id is the same failure with a different cause. */
export function castNeedsVoices(voices: { voice: string }[]): boolean {
  const ids = voices.map((h) => h.voice.trim());
  return ids.some((v) => !v) || new Set(ids).size !== ids.length;
}
