import { useEffect, useState } from "react";
import { api } from "../api";

/** Behavior section: temperature slider + custom instructions, plus the Wave
 * 1b toggles — response-style preset (idea 12), auto-indexing (idea 8) and
 * memory auto-save (idea 5). Owns its own load + save. The style/checkbox
 * controls persist IMMEDIATELY on change (the dictMode pattern — a segmented
 * control reads as immediate-apply); the Save button stays for temperature +
 * instructions only. `clearError` clears the shell's shared model-error banner
 * (the original saveTuning began with setError("")). */
export function useBehaviorSettings(clearError: () => void) {
  const [temperature, setTemperature] = useState(0.7);
  const [instructions, setInstructions] = useState("");
  const [saved, setSaved] = useState(false);
  // Wave 1b (idea 12): "default" | "terse" | "friendly" | "formal".
  const [responseStyle, setResponseStyle] = useState("default");
  // Wave 1b (idea 8): absent = on ("1"); "0" = off.
  const [autoIndex, setAutoIndex] = useState(true);
  // Wave 1b (idea 5): strictly opt-in, default off.
  const [memoryAutoSave, setMemoryAutoSave] = useState(false);
  // Wave 2 (idea 6): "off" (default — undo covers mistakes) | "turn" | "edit".
  const [editApproval, setEditApproval] = useState("off");

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
    api.getSetting("response_style").then((v) => {
      if (v) setResponseStyle(v);
    });
    api.getSetting("auto_index").then((v) => setAutoIndex(v !== "0")).catch(() => {});
    api
      .getSetting("edit_approval")
      .then((v) => {
        if (v === "turn" || v === "edit") setEditApproval(v);
      })
      .catch(() => {});
    api
      .getSetting("memory_auto_save")
      .then((v) => setMemoryAutoSave(v === "1"))
      .catch(() => {});
  }, []);

  async function saveTuning() {
    clearError();
    await api.setSetting("temperature", temperature.toFixed(2));
    await api.setSetting("custom_instructions", instructions.trim());
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }

  /** Immediate persist — closing Settings without pressing Save keeps it. */
  function changeResponseStyle(v: string) {
    setResponseStyle(v);
    api.setSetting("response_style", v).catch(() => {});
  }

  function changeAutoIndex(on: boolean) {
    setAutoIndex(on);
    api.setSetting("auto_index", on ? "1" : "0").catch(() => {});
  }

  function changeMemoryAutoSave(on: boolean) {
    setMemoryAutoSave(on);
    api.setSetting("memory_auto_save", on ? "1" : "0").catch(() => {});
  }

  /** Wave 2 (idea 6): persist immediately, like the other segmented controls. */
  function changeEditApproval(v: string) {
    setEditApproval(v);
    api.setSetting("edit_approval", v).catch(() => {});
  }

  return {
    temperature,
    setTemperature,
    instructions,
    setInstructions,
    saveTuning,
    saved,
    responseStyle,
    changeResponseStyle,
    autoIndex,
    changeAutoIndex,
    memoryAutoSave,
    changeMemoryAutoSave,
    editApproval,
    changeEditApproval,
  };
}
