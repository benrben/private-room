import { useEffect, useState } from "react";
import { api } from "../api";

/** Behavior section: temperature slider + custom instructions. Owns its own
 * load + save. `clearError` clears the shell's shared model-error banner (the
 * original saveTuning began with setError("")). */
export function useBehaviorSettings(clearError: () => void) {
  const [temperature, setTemperature] = useState(0.7);
  const [instructions, setInstructions] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getSetting("temperature").then((v) => {
      if (v != null) {
        const n = parseFloat(v);
        if (!Number.isNaN(n)) {
          // The slider now caps at 1.0 (higher makes a small model ramble).
          // Clamp legacy saves above 1.0 once and persist the clamp (CHG-8).
          if (n > 1) {
            setTemperature(1);
            api.setSetting("temperature", "1.00");
          } else {
            setTemperature(n);
          }
        }
      }
    });
    api.getSetting("custom_instructions").then((v) => {
      if (v) setInstructions(v);
    });
  }, []);

  async function saveTuning() {
    clearError();
    await api.setSetting("temperature", temperature.toFixed(2));
    await api.setSetting("custom_instructions", instructions.trim());
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }

  return {
    temperature,
    setTemperature,
    instructions,
    setInstructions,
    saveTuning,
    saved,
  };
}
