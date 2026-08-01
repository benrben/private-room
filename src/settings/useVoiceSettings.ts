import { useEffect, useState } from "react";
import { api, NeuralVoiceInfo } from "../api";
import * as voice from "../workspace/voice";
import {
  ARCHETYPE_DEFAULTS,
  VoiceArchetype,
  VoiceParams,
} from "../workspace/voice";

/** Idea 3: Spoken-voice section — neural voice + archetype + sliders,
 * persisted per room (settings K/V). Saving also reconfigures the live voice
 * singleton so the change applies without reopening the room. The voice list
 * is fetched LIVE from the service's catalog each time Settings mounts —
 * nothing is bundled, so new service voices appear on their own. */
export function useVoiceSettings() {
  const [neuralVoiceId, setNeuralVoiceId] = useState("");
  const [archetype, setArchetype] = useState<VoiceArchetype>("off");
  const [params, setParams] = useState<VoiceParams>({
    ...ARCHETYPE_DEFAULTS.off,
  });
  const [voices, setVoices] = useState<NeuralVoiceInfo[]>([]);
  const [voicesError, setVoicesError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    api
      .listNeuralVoices()
      .then(setVoices)
      .catch(() => setVoicesError(true));
    api.getSetting("voice_neural_id").then((v) => {
      if (v) setNeuralVoiceId(v);
    });
    api.getSetting("voice_archetype").then((v) => {
      if (v) setArchetype(v as VoiceArchetype);
    });
    api.getSetting("voice_params").then((v) => {
      if (!v) return;
      try {
        setParams(JSON.parse(v) as VoiceParams);
      } catch {
        /* malformed save — keep defaults */
      }
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
    await api.setSetting("voice_neural_id", neuralVoiceId);
    await api.setSetting("voice_archetype", archetype);
    await api.setSetting("voice_params", JSON.stringify(params));
    voice.configure({
      archetype,
      params,
      neuralVoiceId: neuralVoiceId || null,
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }

  /** Speaks a fixed phrase through the LIVE (unsaved) values — also serves as
   * the AudioContext unlock gesture. */
  function preview() {
    if (previewing) {
      voice.cancelAll();
      setPreviewing(false);
      return;
    }
    voice.ensureUnlocked();
    setPreviewing(true);
    voice.speakText("I have read every page you keep in this room.", {
      archetype,
      params,
      neuralVoiceId: neuralVoiceId || null,
      onState: (playing) => {
        if (!playing) setPreviewing(false);
      },
    });
  }

  return {
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
    preview,
    previewing,
  };
}
