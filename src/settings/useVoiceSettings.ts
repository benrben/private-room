import { useEffect, useState } from "react";
import { api, VoiceInfo } from "../api";
import * as voice from "../workspace/voice";
import {
  ARCHETYPE_DEFAULTS,
  VoiceArchetype,
  VoiceParams,
} from "../workspace/voice";

/** Idea 3: Spoken-voice section — archetype + sliders + system voice,
 * persisted per room (settings K/V). Saving also reconfigures the live voice
 * singleton so the change applies without reopening the room. */
export function useVoiceSettings() {
  const [archetype, setArchetype] = useState<VoiceArchetype>("off");
  const [params, setParams] = useState<VoiceParams>({
    ...ARCHETYPE_DEFAULTS.off,
  });
  const [voiceId, setVoiceId] = useState("");
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [saved, setSaved] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    api.listSpeechVoices().then(setVoices).catch(() => {});
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
    api.getSetting("voice_id").then((v) => {
      if (v) setVoiceId(v);
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
    await api.setSetting("voice_archetype", archetype);
    await api.setSetting("voice_params", JSON.stringify(params));
    await api.setSetting("voice_id", voiceId);
    voice.configure({ archetype, params, voiceId: voiceId || null });
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
      voiceId: voiceId || null,
      onState: (playing) => {
        if (!playing) setPreviewing(false);
      },
    });
  }

  return {
    archetype,
    pickArchetype,
    params,
    setParam,
    voiceId,
    setVoiceId,
    voices,
    save,
    saved,
    preview,
    previewing,
  };
}
