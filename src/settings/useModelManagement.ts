import { useEffect, useRef, useState } from "react";
import type React from "react";
import { listen } from "@tauri-apps/api/event";
import { api, ModelCaps, SttStatus, recommendedModels, ensureEmbedModel } from "../api";
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
  // The exact model name the running download was started with. The backend
  // files a multi-gigabyte pull's cancel flag under `pull:<that name>` and
  // nothing was ever calling it, so a 3 GB helper could not be stopped short of
  // quitting the app (`models.rs::pull_cancel_key`). A ref, not state: Stop has
  // to reach the name the CURRENT call used, not a re-render behind.
  const pullingRef = useRef<string | null>(null);
  const [stoppingPull, setStoppingPull] = useState(false);
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
  // Which model would actually mark an image for this room (null = none can).
  // Asked, not derived: this section used to answer it from the local Ollama
  // list alone, so a room running a cloud vision model was told its vision
  // helper was missing and offered a download it did not need.
  const [groundingModel, setGroundingModel] = useState<string | null>(null);
  /** Why this room cannot mark an image, when the reason is NOT "download a
   *  vision helper". Null means either it can, or the honest answer really is
   *  "nothing here can see" — which the download offer already covers. */
  const [visionBlock, setVisionBlock] = useState<string | null>(null);

  const modelsKey = ai?.models.join(",") ?? "";
  useEffect(() => {
    if (ai?.running && ai.models.length > 0) {
      api.modelCapabilities().then(setCaps).catch(() => setCaps([]));
    } else {
      setCaps([]);
    }
    // The room's model can see even when Ollama is down or empty (a cloud
    // engine), so this ask is NOT gated on either.
    api
      .groundingModelForRoom()
      .then(setGroundingModel)
      .catch(() => setGroundingModel(null));
    // PREFLIGHT, not a second guess: when nothing can mark an image, ASK the
    // engine's declared record why before advising a download. "Your model can
    // see but this room's privacy door removes the pixels" is fixed by a switch,
    // not by a 3 GB download — and offering the download was the only thing this
    // screen ever said.
    //
    // ONLY the door. `blocked` alone is not the question: the ordinary "this
    // model cannot see" answer is ALSO blocked, and that is precisely the case
    // the download button exists for — keying off the status swallowed the
    // button on the most common Mac in the world (one text-only local model, no
    // vision helper yet) and replaced it with "choose a different model". The
    // record already separates the two; read its code, do not re-derive it.
    api
      .enginePreflight("vision")
      .then((v) =>
        setVisionBlock(
          v.status === "blocked" && v.code === "privacy-door" ? v.reason : null,
        ),
      )
      .catch(() => setVisionBlock(null));
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
    recommendedModels()
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

  /** Stop the 574 MB download. It ran for many minutes with no way out — the
   * button disabled itself and quitting the app mid-write was the only exit. */
  async function cancelStt() {
    try {
      if (await api.sttCancelDownload()) setSttErr("Download stopped.");
    } catch (e) {
      setSttErr(String(e));
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

  /** Did this failure come from the user pressing Stop? `ollama::PULL_CANCELLED`
   *  is a sentence rather than a sentinel, so match its wording — a stopped
   *  download is not an error and must not be reported as one. */
  function wasStopped(msg: string): boolean {
    return msg.includes("download was cancelled");
  }

  /** Abandon the running download. Reaches the SAME cancel registry chat's Stop
   *  uses, keyed by the model name the pull was started with. */
  async function stopPull() {
    const name = pullingRef.current;
    if (!name || stoppingPull) return;
    setStoppingPull(true);
    try {
      await api.cancelAsk(`pull:${name}`);
      setPullStatus("stopping…");
    } catch (e) {
      setError(String(e));
    } finally {
      setStoppingPull(false);
    }
  }

  async function pull() {
    const name = pullName.trim();
    if (!name || pulling) return;
    setPulling(true);
    pullingRef.current = name;
    setError("");
    setPullStatus("starting…");
    setPullPercent(null);
    try {
      await api.pullModel(name);
      setPullStatus("downloaded ✓");
      setPullName("");
      onModelsChanged();
    } catch (e) {
      const msg = String(e);
      setPullStatus(wasStopped(msg) ? "download stopped" : "");
      if (!wasStopped(msg)) setError(msg);
    } finally {
      pullingRef.current = null;
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
    // `ensure_embed_model` pulls under the embed model's own name, so Stop has
    // to reach THAT key, not the empty `name` this was called with.
    pullingRef.current = name || recommended?.embed || null;
    setPullStatus("starting…");
    setPullPercent(null);
    try {
      if (useEnsureEmbed) {
        await ensureEmbedModel();
      } else {
        await api.pullModel(name);
      }
      setPullStatus("ready ✓");
      onModelsChanged();
    } catch (e) {
      const msg = String(e);
      setPullStatus(wasStopped(msg) ? "download stopped" : "");
      if (!wasStopped(msg)) setError(msg);
    } finally {
      pullingRef.current = null;
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

  // Vision counts as present when SOMETHING can actually mark an image for this
  // room — the room's own model included. Was `hasModel(recommended.vision) ||
  // caps.some(c => c.vision)`: a name match plus the local capability list, both
  // blind to the cloud model the room may be running. Embed is name-only.
  const visionInstalled = groundingModel != null;
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
    stopPull,
    stoppingPull,
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
    cancelStt,
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
    groundingModel,
    visionBlock,
    embedInstalled,
  };
}
