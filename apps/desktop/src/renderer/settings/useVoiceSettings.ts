import { useEffect, useRef, useState } from "react";
import { api, NeuralVoiceInfo } from "../api";
import * as voice from "../workspace/voice";
import { loadVoiceCatalog } from "./voiceCatalog";
import {
  ARCHETYPE_DEFAULTS,
  VoiceArchetype,
  VoiceParams,
} from "../workspace/voice";

/** Idea 3: Spoken-voice section — neural voice + archetype + sliders,
 * persisted per room (settings K/V). Saving also reconfigures the live voice
 * singleton so the change applies without reopening the room. The voice list is
 * fetched LIVE from the service's catalog — nothing is bundled, so new service
 * voices appear on their own.
 *
 * `visible` is what makes that fetch honest. Settings renders every page at
 * once (they are `hidden`, not unmounted), so this hook ran on mount and the
 * catalog request — a call that leaves the Mac for the voice provider — went
 * out every single time the gear was opened, for users who never look at the
 * Voice page. In a privacy-first app an outbound request has to be something
 * the user walked into: it now waits for the page to actually be shown, and
 * happens once. */
export function useVoiceSettings(visible: boolean) {
  const [neuralVoiceId, setNeuralVoiceId] = useState("");
  const [archetype, setArchetype] = useState<VoiceArchetype>("off");
  const [params, setParams] = useState<VoiceParams>({
    ...ARCHETYPE_DEFAULTS.off,
  });
  const [voices, setVoices] = useState<NeuralVoiceInfo[]>([]);
  const [voicesError, setVoicesError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [previewing, setPreviewing] = useState(false);
  // What the room holds, as one comparable string. Voice is a Save-button
  // section, so picking a voice and closing used to lose the pick silently.
  // Seeded with the same values the state above starts on, so nothing reads as
  // unsaved during the moment before the room's own values arrive.
  const [stored, setStored] = useState(() =>
    voiceFingerprint("", "off", { ...ARCHETYPE_DEFAULTS.off }),
  );

  // Whether the sample this hook started is still playing. A ref, because the
  // unmount cleanup below runs after the last render and would read a stale
  // `previewing` out of that render's closure.
  const previewingRef = useRef(false);

  // Closing Settings mid-sample used to leave the room talking with nothing on
  // screen able to stop it — the "Stop preview" button unmounts with the modal,
  // and the sentence went on in the UNSAVED voice the user was auditioning.
  // Only when this hook still owns the pipeline: an unconditional cancelAll
  // here would also cut off an answer being read aloud behind the modal.
  //
  // Ownership is only as good as what voice.ts reports. cancelAll and the
  // end-of-audio path both call back with `false`, but `beginTurn` takes the
  // pipeline WITHOUT clearing the manual-state callback — so a hands-free
  // auto-send during a preview leaves this flag reading true for the length of
  // the answer, and closing Settings then cuts that answer off. Closing it for
  // real means clearing onManualState in beginTurn, in voice.ts.
  useEffect(
    () => () => {
      if (previewingRef.current) {
        previewingRef.current = false;
        voice.cancelAll();
      }
    },
    [],
  );

  // Once, and only after the Voice page is on screen. The ref (not `voices
  // .length`) is the guard because an empty catalog is a legitimate answer —
  // retrying on it would put the app back to one request per render.
  const catalogAsked = useRef(false);
  useEffect(() => {
    if (!visible || catalogAsked.current) return;
    catalogAsked.current = true;
    // Shared with the podcast panel: one fetch per session, so opening either
    // picker populates the other and a remount never restarts the request.
    loadVoiceCatalog()
      .then(setVoices)
      .catch(() => setVoicesError(true));
  }, [visible]);

  // Loaded together, not as three independent `.then`s, so the "what the room
  // holds" baseline below is taken once from a settled set of three values
  // rather than from whichever call happened to land last.
  useEffect(() => {
    void Promise.all([
      api.getSetting("voice_neural_id").catch(() => null),
      api.getSetting("voice_archetype").catch(() => null),
      api.getSetting("voice_params").catch(() => null),
    ]).then(([id, arch, raw]) => {
      const nextId = id || "";
      const nextArch = (arch || "off") as VoiceArchetype;
      // The pre-load default, unchanged: an absent or malformed save keeps the
      // "off" params, not the archetype's.
      let nextParams: VoiceParams = { ...ARCHETYPE_DEFAULTS.off };
      if (raw) {
        try {
          nextParams = JSON.parse(raw) as VoiceParams;
        } catch {
          /* malformed save — keep the "off" defaults */
        }
      }
      setNeuralVoiceId(nextId);
      setArchetype(nextArch);
      setParams(nextParams);
      setStored(voiceFingerprint(nextId, nextArch, nextParams));
    });
  }, []);

  function pickArchetype(a: VoiceArchetype) {
    setArchetype(a);
    // A preset loads its own defaults into the sliders (Custom keeps them).
    if (a !== "custom") setParams({ ...ARCHETYPE_DEFAULTS[a] });
  }

  function setParam(k: keyof VoiceParams, v: number) {
    setParams((p) => ({ ...p, [k]: v }));
    // Touching a slider means the presets no longer describe the sound.
    setArchetype("custom");
  }

  async function save() {
    setSaveError("");
    try {
      await api.setSetting("voice_neural_id", neuralVoiceId);
      await api.setSetting("voice_archetype", archetype);
      await api.setSetting("voice_params", JSON.stringify(params));
    } catch (e) {
      // Without this a failed save looked exactly like a click that did
      // nothing, and the live voice was reconfigured to settings the room had
      // not actually stored — so it reverted on the next open with no warning.
      setSaveError(`Couldn't save: ${String(e)}`);
      return;
    }
    voice.configure({
      archetype,
      params,
      neuralVoiceId: neuralVoiceId || null,
    });
    setStored(voiceFingerprint(neuralVoiceId, archetype, params));
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }

  /** Speaks a fixed phrase through the LIVE (unsaved) values — also serves as
   * the AudioContext unlock gesture. */
  function preview() {
    if (previewing) {
      voice.cancelAll();
      previewingRef.current = false;
      setPreviewing(false);
      return;
    }
    voice.ensureUnlocked();
    previewingRef.current = true;
    setPreviewing(true);
    voice.speakText("I have read every page you keep in this room.", {
      archetype,
      params,
      neuralVoiceId: neuralVoiceId || null,
      onState: (playing) => {
        if (!playing) {
          previewingRef.current = false;
          setPreviewing(false);
        }
      },
    });
  }

  return {
    /** Picked-but-not-saved voice work — Voice has a Save button, and closing
     * Settings used to drop the choice without a word. */
    voiceDirty: voiceFingerprint(neuralVoiceId, archetype, params) !== stored,
    neuralVoiceId,
    setNeuralVoiceId,
    archetype,
    pickArchetype,
    params,
    setParam,
    voices,
    voicesError,
    save,
    saved,
    saveError,
    preview,
    previewing,
  };
}

/** The three saved voice fields as ONE comparable string, so "has this changed"
 * is a single equality instead of a deep compare that has to be updated every
 * time a slider is added. */
function voiceFingerprint(
  id: string,
  archetype: VoiceArchetype,
  params: VoiceParams,
): string {
  return JSON.stringify([id, archetype, params]);
}
