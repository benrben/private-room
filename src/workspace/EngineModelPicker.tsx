import { useEffect, useState } from "react";
import {
  AiStatus,
  api,
  ENGINE_LABELS,
  ExternalModelInfo,
  modelLabel,
} from "../api";
import { CheckIcon, ChevronDownIcon } from "../icons";
import { isRemoteModel } from "./markup";
import { isEmbeddingModel } from "./localModel";

interface Props {
  ai: AiStatus;
  /** The currently selected model — a bare local/engine id, or a composite
   * "engine::model" / "engine::model::effort" cloud selection. */
  model: string;
  onSelect: (model: string) => void;
  /** {engine: ExternalModelInfo[]} cache. Omit both to let this component keep
   * its own (component-lifetime) cache — pass both, lifted to WSState, when a
   * host wants the fetched list to outlive this component (e.g. TopBar's pill
   * shows a friendly model+effort name even after the menu closes). */
  engineModels?: Record<string, ExternalModelInfo[]>;
  onModelsLoaded?: (engine: string, models: ExternalModelInfo[]) => void;
  /** Settings' per-local-model extras (capability badges, delete button) —
   * kept out of this component since they're host-specific. */
  renderLocalExtra?: (m: string) => React.ReactNode;
  /** Shown instead of "No models installed yet." when the Local tab has no
   * models — e.g. Settings uses this for "Ollama is not running" so the
   * message stays accurate. Cloud engines never depend on Ollama running. */
  localEmptyHint?: React.ReactNode;
  /** Settings' inventory mode: list every installed model, including the ones
   * that cannot chat (embeddings), so they can be seen and deleted — they render
   * disabled rather than selectable. The composer's pill omits this and gets a
   * list where everything shown is a valid pick. */
  manage?: boolean;
}

/** Local/Cloud toggle + (for Cloud) a list of detected cloud engines that
 * expand in place to that engine's real models, each with its reasoning-effort
 * levels as inline chips. Shared by the composer's model pill (TopBar) and
 * Settings' Model section so the two can't drift into two different pickers. */
export default function EngineModelPicker({
  ai,
  model,
  onSelect,
  engineModels: liftedModels,
  onModelsLoaded: recordLifted,
  renderLocalExtra,
  localEmptyHint,
  manage = false,
}: Props) {
  const [ownModels, setOwnModels] = useState<Record<string, ExternalModelInfo[]>>({});
  const engineModels = liftedModels ?? ownModels;
  const recordModels =
    recordLifted ??
    ((engine: string, models: ExternalModelInfo[]) =>
      setOwnModels((prev) => ({ ...prev, [engine]: models })));

  const [selEngine, selModel] = (() => {
    const parts = model.split("::");
    return ai.external.includes(parts[0]) ? [parts[0], parts[1] ?? null] : [null, null];
  })();
  const startsInCloud = selEngine !== null;

  // Ollama `:cloud` models RUN REMOTELY — prompts and file context leave this
  // Mac (see markup.isRemoteModel) — so they belong under the Cloud tab, never
  // under "On this Mac". Split the raw Ollama list so each tab shows only its
  // own; the two were previously conflated, which listed cloud models (badged
  // "Cloud") inside the "On this Mac" tab.
  // An embedding-only model (nomic-embed-text, bge-*) answers /api/embed but not
  // /api/chat. `bestLocalModel` and Rust's `best_default` have always refused to
  // FALL BACK to one, but this menu still listed them, so semantic search's own
  // pull put a model in the picker that fails every turn it is chosen for with
  // "does not support chat" (HTTP 400, live QA 2026-08-03).
  //
  // Settings lists them anyway — that is where you see and delete what is
  // installed — but as a disabled row, never a pick. The composer's pill has no
  // such job, so there they are simply absent.
  const chatable = ai.models.filter((m) => !isEmbeddingModel(m));
  const listed = manage ? ai.models : chatable;
  const localModels = listed.filter((m) => !isRemoteModel(m));
  const remoteModels = listed.filter((m) => isRemoteModel(m));
  const hasCloud = ai.external.length > 0 || remoteModels.length > 0;

  const [tier, setTier] = useState<"local" | "cloud">(
    startsInCloud || isRemoteModel(model) ? "cloud" : "local",
  );
  const [expanded, setExpanded] = useState<string | null>(
    startsInCloud ? selEngine : null,
  );
  const [loadingEngine, setLoadingEngine] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [needsTools, setNeedsTools] = useState(false);
  const [needsVision, setNeedsVision] = useState(false);
  const [needsReasoning, setNeedsReasoning] = useState(false);
  const [needsStructured, setNeedsStructured] = useState(false);
  const [validatingModel, setValidatingModel] = useState<string | null>(null);
  const [modelValidation, setModelValidation] = useState<
    Record<string, { selectable: boolean; reason: string | null }>
  >({});
  const externalCatalogVersion = ai.external.join("|");

  async function selectValidated(engine: string, exactModelId: string, selection: string) {
    const key = `${engine}\0${exactModelId}`;
    const known = modelValidation[key];
    if (known?.selectable === false) return;
    if (known?.selectable === true) {
      onSelect(selection);
      return;
    }
    setValidatingModel(key);
    try {
      const result = await api.validateEngineModel(engine, exactModelId);
      setModelValidation((current) => ({ ...current, [key]: result }));
      if (result.selectable) onSelect(selection);
    } catch {
      setModelValidation((current) => ({
        ...current,
        [key]: {
          selectable: false,
          reason: "This model could not be checked. Refresh the model list and try again.",
        },
      }));
    } finally {
      setValidatingModel((current) => current === key ? null : current);
    }
  }

  // Fetch an engine's model list whenever it becomes the expanded one and
  // isn't cached yet. Keyed on `expanded` (not only on a click) so a menu that
  // OPENS with an engine already expanded — the current selection is a cloud
  // engine — still fetches, instead of showing only its default row.
  useEffect(() => {
    const engine = expanded;
    if (
      !engine ||
      !ai.external.includes(engine) ||
      (engine !== "openrouter" && engineModels[engine])
    ) {
      // Nothing to fetch — but a PREVIOUS fetch may still own the spinner. Its
      // `finally` deliberately skips the reset once its cleanup has run
      // (`cancelled`), on the assumption that the next effect run sets the flag
      // afresh. This early return breaks that assumption: collapsing the menu
      // (or re-opening it on a cached engine) lands here without touching
      // `loadingEngine`, so it stayed pinned to the engine that was open, every
      // `!loadingEngine` guard below stayed false, and the picker showed
      // "Checking…" forever with no way back. Live QA 2026-08-03 could not
      // restart its provider matrix because of exactly this.
      setLoadingEngine(null);
      return;
    }
    let cancelled = false;
    setLoadingEngine(engine);
    setLoadError(null);
    api
      .listEngineModels(engine)
      .then((models) => {
        if (!cancelled) recordModels(engine, models);
      })
      .catch(() => {
        if (!cancelled) setLoadError(engine);
      })
      .finally(() => {
        if (!cancelled) setLoadingEngine(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, externalCatalogVersion]);

  function toggleExpand(engine: string) {
    if (expanded !== engine) {
      setQuery("");
      setNeedsTools(false);
      setNeedsVision(false);
      setNeedsReasoning(false);
      setNeedsStructured(false);
    }
    setExpanded((cur) => (cur === engine ? null : engine));
  }

  return (
    <div className="engine-picker">
      <div className="engine-tier-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tier === "local"}
          className={`engine-tier-tab${tier === "local" ? " active" : ""}`}
          onClick={() => setTier("local")}
        >
          On this Mac
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tier === "cloud"}
          className={`engine-tier-tab${tier === "cloud" ? " active" : ""}`}
          onClick={() => setTier("cloud")}
          disabled={!hasCloud}
          title={
            !hasCloud
              ? "No cloud AI models or CLIs (Claude Code, Codex, Antigravity) detected on this Mac"
              : undefined
          }
        >
          Cloud
        </button>
      </div>

      {tier === "local" && (
        <div className="engine-tier-body">
          {localModels.length === 0 && (
            <div className="settings-hint">{localEmptyHint ?? "No models installed yet."}</div>
          )}
          {localModels.map((m) => {
            // Only reachable in `manage` mode — the composer's list never
            // contains one. Disabled, and SAID to be, so the row reads as
            // "installed, but not for this" rather than as a dead button.
            const embedOnly = isEmbeddingModel(m);
            return (
              // A sibling row div, not one big <button>: renderLocalExtra (Settings'
              // delete button) must never nest inside the row's own select button.
              <div key={m} className="model-menu-row">
                <button
                  type="button"
                  className={`model-menu-item${m === model ? " sel" : ""}`}
                  aria-pressed={m === model}
                  disabled={embedOnly}
                  title={
                    embedOnly
                      ? "Used for semantic search only — this model cannot hold a chat"
                      : undefined
                  }
                  onClick={() => onSelect(m)}
                >
                  <span className="model-dot local" />
                  <span className="model-menu-name">{modelLabel(m) ?? m}</span>
                  <span className="model-menu-tier">
                    {embedOnly ? "Search only" : "Local"}
                  </span>
                  {m === model && !embedOnly && <CheckIcon size={14} />}
                </button>
                {renderLocalExtra?.(m)}
              </div>
            );
          })}
        </div>
      )}

      {tier === "cloud" && (
        <div className="engine-tier-body">
          {/* Ollama `:cloud` models (bare ids, selected directly like local
              ones) live here — they run remotely. renderLocalExtra still gives
              them Settings' delete button and capability badges. */}
          {remoteModels.map((m) => {
            const validationKey = `ollama-cloud\0${m}`;
            const validation = modelValidation[validationKey];
            const checking = validatingModel === validationKey;
            return <div key={m} className="model-menu-row">
              <button
                type="button"
                className={`model-menu-item${m === model ? " sel" : ""}`}
                aria-pressed={m === model}
                disabled={checking || validation?.selectable === false}
                title={validation?.reason ?? (checking ? "Checking this exact Ollama model ID…" : undefined)}
                onClick={() => void selectValidated("ollama-cloud", m, m)}
              >
                <span className="model-dot cloud" />
                <span className="model-menu-name">{modelLabel(m) ?? m}</span>
                <span className="model-menu-tier cloud">{checking ? "Checking…" : "Cloud"}</span>
                {m === model && <CheckIcon size={14} />}
              </button>
              {renderLocalExtra?.(m)}
              {validation?.selectable === false && (
                <div className="settings-hint engine-submodel-loading" role="status">
                  {validation.reason}
                </div>
              )}
            </div>
          })}
          {ai.external.map((engine) => {
            const models = engineModels[engine] ?? [];
            const hasRichCatalog = models.some(
              (item) => item.contextWindow || item.description || item.inputPrice,
            );
            const needle = query.trim().toLowerCase();
            const visibleModels = hasRichCatalog ? models.filter((item) => {
              if (needle && !`${item.label} ${item.slug}`.toLowerCase().includes(needle)) return false;
              if (needsTools && !item.tools) return false;
              if (needsVision && !item.vision) return false;
              if (needsReasoning && !item.reasoning) return false;
              if (needsStructured && !item.structuredOutputs) return false;
              return true;
            }) : models;
            return (
              <div key={engine} className="engine-cloud-group">
                <button
                  type="button"
                  className={`model-menu-item${model === engine ? " sel" : ""}`}
                  aria-pressed={model === engine}
                  aria-expanded={expanded === engine}
                  onClick={() => toggleExpand(engine)}
                >
                  <span className="model-dot cloud" />
                  <span className="model-menu-name">{ENGINE_LABELS[engine] ?? engine}</span>
                  <ChevronDownIcon
                    size={14}
                    className={`engine-expand-caret${expanded === engine ? " open" : ""}`}
                  />
                </button>
                {expanded === engine && (
                  <div className="engine-submodel-list">
                    {/* Loading and error are designed, announced states, not
                        silent text: this list can take seconds to arrive over
                        a network, and until now nothing told a screen-reader
                        user that anything was happening at all. */}
                    {loadingEngine === engine && (
                      <div className="settings-hint engine-submodel-loading" role="status">
                        Checking…
                      </div>
                    )}
                    {loadError === engine && (
                      <div className="settings-hint engine-submodel-loading" role="status">
                        {engine === "openrouter"
                          ? "Couldn't refresh the model catalog. Check the connection in Settings."
                          : `Couldn't list models — using ${ENGINE_LABELS[engine] ?? engine}'s default.`}
                      </div>
                    )}
                    {!loadingEngine && hasRichCatalog && (
                      <div className="model-catalog-controls">
                        <input
                          type="search"
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                          placeholder={`Search ${models.length.toLocaleString()} models…`}
                          aria-label={`Search ${ENGINE_LABELS[engine] ?? engine} models`}
                        />
                        {/* An engaged filter carries a TICK as well as the
                            wash behind it. The wash alone was the only signal
                            that a capability was being required, and a filter
                            silently narrowing a 300-model catalogue is exactly
                            the kind of state that must not depend on being
                            able to tell the pen from the paper. */}
                        <div className="model-filter-chips" role="group" aria-label="Model capabilities">
                          <button
                            type="button"
                            className={needsTools ? "active pick-on" : ""}
                            aria-pressed={needsTools}
                            onClick={() => setNeedsTools((value) => !value)}
                          >
                            {needsTools && <CheckIcon size={12} />}
                            Tools
                          </button>
                          <button
                            type="button"
                            className={needsVision ? "active pick-on" : ""}
                            aria-pressed={needsVision}
                            onClick={() => setNeedsVision((value) => !value)}
                          >
                            {needsVision && <CheckIcon size={12} />}
                            Vision
                          </button>
                          <button
                            type="button"
                            className={needsReasoning ? "active pick-on" : ""}
                            aria-pressed={needsReasoning}
                            onClick={() => setNeedsReasoning((value) => !value)}
                          >
                            {needsReasoning && <CheckIcon size={12} />}
                            Reasoning
                          </button>
                          <button
                            type="button"
                            className={needsStructured ? "active pick-on" : ""}
                            aria-pressed={needsStructured}
                            onClick={() => setNeedsStructured((value) => !value)}
                          >
                            {needsStructured && <CheckIcon size={12} />}
                            JSON
                          </button>
                          <span>{visibleModels.length.toLocaleString()} shown</span>
                        </div>
                      </div>
                    )}
                    {!loadingEngine &&
                      visibleModels.map((mi) => {
                        const base = `${engine}::${mi.slug}`;
                        const picked = selEngine === engine && selModel === mi.slug;
                        const validationKey = `${engine}\0${mi.slug}`;
                        const validation = modelValidation[validationKey];
                        const checking = validatingModel === validationKey;
                        const perMillion = (raw: string | null) => {
                          if (!raw) return null;
                          const value = Number(raw) * 1_000_000;
                          if (!Number.isFinite(value)) return null;
                          return value === 0 ? "free" : `$${value < 0.01 ? value.toFixed(3) : value.toFixed(2)}/M`;
                        };
                        const context = mi.contextWindow
                          ? `${mi.contextWindow >= 1_000_000
                              ? `${(mi.contextWindow / 1_000_000).toFixed(1)}M`
                              : `${Math.round(mi.contextWindow / 1000)}K`} ctx`
                          : null;
                        return (
                          <div key={mi.slug} className="engine-submodel">
                            <button
                              type="button"
                              className={`model-menu-item${model === base ? " sel" : ""}`}
                              aria-pressed={model === base}
                              disabled={checking || validation?.selectable === false}
                              title={validation?.reason ?? (checking ? `Checking ${mi.slug}…` : mi.description ?? mi.label)}
                              onClick={() => void selectValidated(engine, mi.slug, base)}
                            >
                              <span className="model-dot cloud" />
                              <span className="model-menu-name model-catalog-name">
                                <span>{mi.label}</span>
                                {hasRichCatalog && (
                                  <span className="model-catalog-meta">
                                    {context && <span>{context}</span>}
                                    {mi.tools && <span>tools</span>}
                                    {mi.vision && <span>vision</span>}
                                    {mi.reasoning && <span>reasoning</span>}
                                    {mi.structuredOutputs && <span>structured</span>}
                                    {perMillion(mi.inputPrice) && (
                                      <span>{perMillion(mi.inputPrice)} in</span>
                                    )}
                                    {perMillion(mi.outputPrice) && (
                                      <span>{perMillion(mi.outputPrice)} out</span>
                                    )}
                                  </span>
                                )}
                              </span>
                              {model === base && <CheckIcon size={14} />}
                            </button>
                            {validation?.selectable === false && (
                              <div className="settings-hint engine-submodel-loading" role="status">
                                {validation.reason}
                              </div>
                            )}
                            {/* Effort chips: shown once this model is the picked
                             * one, so the picker stays compact. "Default" clears
                             * the effort back to the CLI's own default. */}
                            {picked && mi.efforts.length > 0 && (
                              // Exactly one of these is always the chosen one,
                              // and it used to say so with a wash and a border
                              // colour — nothing a greyscale or colour-blind
                              // reader could resolve. The tick is the shape
                              // that carries it; aria-pressed is the same fact
                              // for anyone listening.
                              <div className="effort-chips" role="group" aria-label="Reasoning effort">
                                <button
                                  type="button"
                                  className={`effort-chip${model === base ? " sel pick-on" : ""}`}
                                  aria-pressed={model === base}
                                  title={
                                    mi.defaultEffort
                                      ? `Model default (${mi.defaultEffort})`
                                      : "The CLI's default effort"
                                  }
                                  onClick={() => onSelect(base)}
                                >
                                  {model === base && <CheckIcon size={12} />}
                                  Default
                                </button>
                                {mi.efforts.map((eff) => {
                                  const withEffort = `${base}::${eff}`;
                                  return (
                                    <button
                                      type="button"
                                      key={eff}
                                      className={`effort-chip${model === withEffort ? " sel pick-on" : ""}`}
                                      aria-pressed={model === withEffort}
                                      onClick={() => onSelect(withEffort)}
                                    >
                                      {model === withEffort && <CheckIcon size={12} />}
                                      {eff}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    {!loadingEngine && hasRichCatalog && visibleModels.length === 0 && (
                      // An empty state says what would fill it: here the list
                      // is empty because of something the user did, and the
                      // way out is one click above this line.
                      <div className="settings-hint engine-submodel-loading" role="status">
                        No models match these filters — clear one to see more.
                      </div>
                    )}
                    {!loadingEngine && !loadError && engine === "openrouter" && models.length === 0 && (
                      <div className="settings-hint engine-submodel-loading" role="status">
                        No models are available for this OpenRouter account.
                      </div>
                    )}
                    {engine !== "openrouter" && <button
                      type="button"
                      className={`model-menu-item engine-submodel-default${
                        model === engine ? " sel" : ""
                      }`}
                      aria-pressed={model === engine}
                      onClick={() => onSelect(engine)}
                    >
                      <span className="model-dot cloud" />
                      <span className="model-menu-name">
                        {ENGINE_LABELS[engine] ?? engine}'s default
                      </span>
                      {model === engine && <CheckIcon size={14} />}
                    </button>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
