import { useEffect, useRef, useState } from "react";
import type React from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { api, ModelCaps, SttStatus } from "../api";
import type { AiStatus } from "../api";
import { PullProgress, RecommendedModels } from "./types";

/** Everything the Model + AI-helpers sections need: model pulls (shared
 * pull-progress feed), delete-confirm, per-model capabilities, the built-in
 * dictation model + shaping, and recommended vision/embed helpers. Also owns
 * the shell's shared error banner. */
export function useModelManagement(
  ai: AiStatus | null,
  onModelsChanged: () => void,
) {
  const [pullName, setPullName] = useState("");
  const [pulling, setPulling] = useState(false);
  const [pullStatus, setPullStatus] = useState("");
  const [pullPercent, setPullPercent] = useState<number | null>(null);
  const [error, setError] = useState("");
  // ADD-3: two-step confirm for deleting a model.
  const [confirmModel, setConfirmModel] = useState<string | null>(null);
  const confirmTimer = useRef<number | null>(null);
  // ADD-18: built-in dictation/transcription model (Whisper).
  const [stt, setStt] = useState<SttStatus | null>(null);
  const [sttPercent, setSttPercent] = useState<number | null>(null);
  const [sttErr, setSttErr] = useState("");
  // ADD-18: dictation shaping (alfred's translate/intent pipeline, run on the
  // room's local model). Persisted per room.
  const [dictTranslate, setDictTranslate] = useState(false);
  const [dictMode, setDictMode] = useState("off");
  // ADD-22: per-model tool/vision abilities (Ollama /api/show), for badges and a
  // warning when the chosen model can't drive the app.
  const [caps, setCaps] = useState<ModelCaps[]>([]);
  // HELPERS — vision + embedding models (recommended_models drives the pulls).
  const [recommended, setRecommended] = useState<RecommendedModels | null>(null);
  const [pullingSpecial, setPullingSpecial] = useState<string | null>(null);

  const modelsKey = ai?.models.join(",") ?? "";
  useEffect(() => {
    if (ai?.running && ai.models.length > 0) {
      api.modelCapabilities().then(setCaps).catch(() => setCaps([]));
    } else {
      setCaps([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai?.running, modelsKey]);

  useEffect(() => {
    const unlisten = listen<PullProgress>("pull-progress", (e) => {
      setPullStatus(e.payload.status);
      setPullPercent(e.payload.percent);
    });
    // ADD-18: dictation model presence + live download progress + shaping prefs.
    api.sttStatus().then(setStt).catch(() => {});
    api.getSetting("dict_translate").then((v) => setDictTranslate(v === "on"));
    api.getSetting("dict_mode").then((v) => setDictMode(v || "off"));
    const unlistenStt = api.onSttDownloadProgress((p) =>
      setSttPercent(p.percent),
    );
    invoke<RecommendedModels>("recommended_models")
      .then(setRecommended)
      .catch(() => {});
    return () => {
      unlisten.then((fn) => fn());
      unlistenStt.then((fn) => fn());
    };
  }, []);

  // ADD-18: download / delete the built-in dictation model.
  async function downloadStt() {
    setSttErr("");
    setSttPercent(0);
    try {
      await api.sttDownloadModel();
      setStt(await api.sttStatus());
    } catch (e) {
      setSttErr(String(e));
    } finally {
      setSttPercent(null);
    }
  }

  async function removeStt() {
    setSttErr("");
    try {
      await api.sttDeleteModel();
      setStt(await api.sttStatus());
    } catch (e) {
      setSttErr(String(e));
    }
  }

  async function pull() {
    const name = pullName.trim();
    if (!name || pulling) return;
    setPulling(true);
    setError("");
    setPullStatus("starting…");
    setPullPercent(null);
    try {
      await api.pullModel(name);
      setPullStatus("downloaded ✓");
      setPullName("");
      onModelsChanged();
    } catch (e) {
      setPullStatus("");
      setError(String(e));
    } finally {
      setPulling(false);
      setPullPercent(null);
    }
  }

  async function removeModel(name: string) {
    setError("");
    try {
      await api.deleteModel(name);
      onModelsChanged();
    } catch (e) {
      setError(String(e));
    }
  }

  // ADD-3: first click arms the confirm; ✓ deletes, ✕ or a 3s timeout reverts.
  function askRemoveModel(name: string) {
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    setConfirmModel(name);
    confirmTimer.current = window.setTimeout(() => setConfirmModel(null), 3000);
  }

  function cancelRemoveModel() {
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = null;
    setConfirmModel(null);
  }

  function confirmRemoveModel(name: string) {
    cancelRemoveModel();
    removeModel(name);
  }

  // HELPERS — pull a recommended model, reusing the shared pull-progress feed.
  // For the embed model we prefer ensure_embed_model (pulls AND backfills
  // semantic search) over a bare pull.
  async function pullSpecial(name: string, useEnsureEmbed = false) {
    const label = name || (useEnsureEmbed ? "embed model" : "");
    if (!label || pulling || pullingSpecial) return;
    setError("");
    setPullingSpecial(label);
    setPullStatus("starting…");
    setPullPercent(null);
    try {
      if (useEnsureEmbed) {
        // CONTRACT-NOTE: ensure_embed_model emits the same 'pull-progress' events.
        await invoke("ensure_embed_model");
      } else {
        await api.pullModel(name);
      }
      setPullStatus("ready ✓");
      onModelsChanged();
    } catch (e) {
      setPullStatus("");
      setError(String(e));
    } finally {
      setPullingSpecial(null);
      setPullPercent(null);
    }
  }

  // A model counts as installed when its base name (before any ":tag") matches.
  function hasModel(id: string | undefined): boolean {
    if (!id || !ai) return false;
    const base = (s: string) => s.split(":")[0].toLowerCase();
    const target = base(id);
    return ai.models.some((m) => base(m) === target);
  }

  // Vision counts as present if the recommended helper is installed OR any
  // installed model already reports vision. Embed is name-only.
  const visionInstalled =
    hasModel(recommended?.vision) || caps.some((c) => c.vision);
  const embedInstalled = hasModel(recommended?.embed);

  // Dictation shaping handlers (moved verbatim from the Model section JSX so the
  // presentational section component stays free of api calls).
  const onDictTranslateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDictTranslate(e.target.checked);
    api.setSetting("dict_translate", e.target.checked ? "on" : "off");
  };
  const onDictModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setDictMode(e.target.value);
    api.setSetting("dict_mode", e.target.value);
  };

  return {
    pullName,
    setPullName,
    pulling,
    pull,
    pullStatus,
    pullPercent,
    error,
    setError,
    confirmModel,
    askRemoveModel,
    cancelRemoveModel,
    confirmRemoveModel,
    stt,
    sttPercent,
    sttErr,
    downloadStt,
    removeStt,
    dictTranslate,
    dictMode,
    onDictTranslateChange,
    onDictModeChange,
    caps,
    recommended,
    pullingSpecial,
    pullSpecial,
    visionInstalled,
    embedInstalled,
  };
}
