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

  const [tier, setTier] = useState<"local" | "cloud">(
    startsInCloud ? "cloud" : "local",
  );
  const [expanded, setExpanded] = useState<string | null>(
    startsInCloud ? selEngine : null,
  );
  const [loadingEngine, setLoadingEngine] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Fetch an engine's model list whenever it becomes the expanded one and
  // isn't cached yet. Keyed on `expanded` (not only on a click) so a menu that
  // OPENS with an engine already expanded — the current selection is a cloud
  // engine — still fetches, instead of showing only its default row.
  useEffect(() => {
    const engine = expanded;
    if (!engine || engineModels[engine]) return;
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
  }, [expanded]);

  function toggleExpand(engine: string) {
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
          disabled={ai.external.length === 0}
          title={
            ai.external.length === 0
              ? "No cloud AI CLIs (Claude Code, Codex) detected on this Mac"
              : undefined
          }
        >
          Cloud
        </button>
      </div>

      {tier === "local" && (
        <div className="engine-tier-body">
          {ai.models.length === 0 && (
            <div className="settings-hint">{localEmptyHint ?? "No models installed yet."}</div>
          )}
          {ai.models.map((m) => (
            // A sibling row div, not one big <button>: renderLocalExtra (Settings'
            // delete button) must never nest inside the row's own select button.
            <div key={m} className="model-menu-row">
              <button
                type="button"
                className={`model-menu-item${m === model ? " sel" : ""}`}
                aria-pressed={m === model}
                onClick={() => onSelect(m)}
              >
                <span className={`model-dot ${isRemoteModel(m) ? "cloud" : "local"}`} />
                <span className="model-menu-name">{modelLabel(m) ?? m}</span>
                <span className={`model-menu-tier${isRemoteModel(m) ? " cloud" : ""}`}>
                  {isRemoteModel(m) ? "Cloud" : "Local"}
                </span>
                {m === model && <CheckIcon size={14} />}
              </button>
              {renderLocalExtra?.(m)}
            </div>
          ))}
        </div>
      )}

      {tier === "cloud" && (
        <div className="engine-tier-body">
          {ai.external.map((engine) => {
            const models = engineModels[engine] ?? [];
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
                    size={13}
                    className={`engine-expand-caret${expanded === engine ? " open" : ""}`}
                  />
                </button>
                {expanded === engine && (
                  <div className="engine-submodel-list">
                    {loadingEngine === engine && (
                      <div className="settings-hint engine-submodel-loading">Checking…</div>
                    )}
                    {loadError === engine && (
                      <div className="settings-hint engine-submodel-loading">
                        Couldn't list models — using {ENGINE_LABELS[engine] ?? engine}'s default.
                      </div>
                    )}
                    {!loadingEngine &&
                      models.map((mi) => {
                        const base = `${engine}::${mi.slug}`;
                        const picked = selEngine === engine && selModel === mi.slug;
                        return (
                          <div key={mi.slug} className="engine-submodel">
                            <button
                              type="button"
                              className={`model-menu-item${model === base ? " sel" : ""}`}
                              aria-pressed={model === base}
                              onClick={() => onSelect(base)}
                            >
                              <span className="model-dot cloud" />
                              <span className="model-menu-name">{mi.label}</span>
                              {model === base && <CheckIcon size={14} />}
                            </button>
                            {/* Effort chips: shown once this model is the picked
                             * one, so the picker stays compact. "Default" clears
                             * the effort back to the CLI's own default. */}
                            {picked && mi.efforts.length > 0 && (
                              <div className="effort-chips" role="group" aria-label="Reasoning effort">
                                <button
                                  type="button"
                                  className={`effort-chip${model === base ? " sel" : ""}`}
                                  title={
                                    mi.defaultEffort
                                      ? `Model default (${mi.defaultEffort})`
                                      : "The CLI's default effort"
                                  }
                                  onClick={() => onSelect(base)}
                                >
                                  Default
                                </button>
                                {mi.efforts.map((eff) => {
                                  const withEffort = `${base}::${eff}`;
                                  return (
                                    <button
                                      type="button"
                                      key={eff}
                                      className={`effort-chip${model === withEffort ? " sel" : ""}`}
                                      onClick={() => onSelect(withEffort)}
                                    >
                                      {eff}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    <button
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
                    </button>
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
