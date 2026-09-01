import {
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  AiStatus,
  api,
  ExternalModelInfo,
  modelLabel,
} from "../api";
import { CheckIcon } from "../icons";
import { isRemoteModel } from "./markup";
import { isEmbeddingModel } from "./localModel";
import { CloudTier } from "./EngineModelCloud";

interface Props {
  ai: AiStatus;
  model: string;
  onSelect: (model: string) => void;
  engineModels?: Record<string, ExternalModelInfo[]>;
  onModelsLoaded?: (engine: string, models: ExternalModelInfo[]) => void;
  renderLocalExtra?: (model: string) => ReactNode;
  localEmptyHint?: ReactNode;
  manage?: boolean;
}

type Tier = "local" | "cloud";
export type ModelValidation = Record<
  string,
  { selectable: boolean; reason: string | null }
>;
export type PickerFilters = {
  query: string;
  needsTools: boolean;
  needsVision: boolean;
  needsReasoning: boolean;
  needsStructured: boolean;
};
export type FilterActions = {
  setQuery: (query: string) => void;
  setNeedsTools: (value: boolean) => void;
  setNeedsVision: (value: boolean) => void;
  setNeedsReasoning: (value: boolean) => void;
  setNeedsStructured: (value: boolean) => void;
  reset: () => void;
};

interface ModelLists {
  localModels: string[];
  remoteModels: string[];
}

export interface EngineCatalog {
  models: ExternalModelInfo[];
  hasRichCatalog: boolean;
  visibleModels: ExternalModelInfo[];
}

function cloudSelection(
  model: string,
  engines: string[],
): [string | null, string | null] {
  const parts = model.split("::");
  if (!engines.includes(parts[0])) return [null, null];
  return [parts[0], parts[1] ?? null];
}

function modelsForPicker(models: string[], manage: boolean): ModelLists {
  const listed = manage
    ? models
    : models.filter((model) => !isEmbeddingModel(model));
  return {
    localModels: listed.filter((model) => !isRemoteModel(model)),
    remoteModels: listed.filter((model) => isRemoteModel(model)),
  };
}

function cloudTierAvailable(
  engines: string[],
  remoteModels: string[],
): boolean {
  return engines.length > 0 || remoteModels.length > 0;
}

function initialTier(startsInCloud: boolean, model: string): Tier {
  return startsInCloud || isRemoteModel(model) ? "cloud" : "local";
}

function initialExpanded(
  startsInCloud: boolean,
  engine: string | null,
): string | null {
  return startsInCloud ? engine : null;
}

export function validationKey(engine: string, model: string): string {
  return `${engine}\0${model}`;
}

function usePickerFilters(): [PickerFilters, FilterActions] {
  const [query, setQuery] = useState("");
  const [needsTools, setNeedsTools] = useState(false);
  const [needsVision, setNeedsVision] = useState(false);
  const [needsReasoning, setNeedsReasoning] = useState(false);
  const [needsStructured, setNeedsStructured] = useState(false);
  const reset = () => {
    setQuery("");
    setNeedsTools(false);
    setNeedsVision(false);
    setNeedsReasoning(false);
    setNeedsStructured(false);
  };
  return [
    { query, needsTools, needsVision, needsReasoning, needsStructured },
    {
      setQuery,
      setNeedsTools,
      setNeedsVision,
      setNeedsReasoning,
      setNeedsStructured,
      reset,
    },
  ];
}

function shouldLoadEngine(
  engine: string | null,
  external: string[],
  models: Record<string, ExternalModelInfo[]>,
): engine is string {
  if (!engine || !external.includes(engine)) return false;
  return engine === "openrouter" || !models[engine];
}

function useEngineModels(
  expanded: string | null,
  external: string[],
  models: Record<string, ExternalModelInfo[]>,
  recordModels: (engine: string, models: ExternalModelInfo[]) => void,
): { loadingEngine: string | null; loadError: string | null } {
  const [loadingEngine, setLoadingEngine] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const externalCatalogVersion = external.join("|");
  useEffect(() => {
    if (!shouldLoadEngine(expanded, external, models)) {
      setLoadingEngine(null);
      return;
    }
    let cancelled = false;
    setLoadingEngine(expanded);
    setLoadError(null);
    api
      .listEngineModels(expanded)
      .then((result) => {
        if (!cancelled) recordModels(expanded, result);
      })
      .catch(() => {
        if (!cancelled) setLoadError(expanded);
      })
      .finally(() => {
        if (!cancelled) setLoadingEngine(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, externalCatalogVersion]);
  return { loadingEngine, loadError };
}

function useValidatedSelection(onSelect: (model: string) => void): {
  validatingModel: string | null;
  modelValidation: ModelValidation;
  selectValidated: (
    engine: string,
    exactModel: string,
    selection: string,
  ) => Promise<void>;
} {
  const [validatingModel, setValidatingModel] = useState<string | null>(null);
  const [modelValidation, setModelValidation] = useState<ModelValidation>({});
  async function selectValidated(
    engine: string,
    exactModel: string,
    selection: string,
  ) {
    const key = validationKey(engine, exactModel);
    const known = modelValidation[key];
    if (known?.selectable === false) return;
    if (known?.selectable === true) {
      onSelect(selection);
      return;
    }
    setValidatingModel(key);
    try {
      const result = await api.validateEngineModel(engine, exactModel);
      setModelValidation((current) => ({ ...current, [key]: result }));
      if (result.selectable) onSelect(selection);
    } catch {
      setModelValidation((current) => ({
        ...current,
        [key]: {
          selectable: false,
          reason:
            "This model could not be checked. Refresh the model list and try again.",
        },
      }));
    } finally {
      setValidatingModel((current) => (current === key ? null : current));
    }
  }
  return { validatingModel, modelValidation, selectValidated };
}

function tabClass(tier: Tier, tab: Tier): string {
  return `engine-tier-tab${tier === tab ? " active" : ""}`;
}

function cloudTabTitle(hasCloud: boolean): string | undefined {
  return hasCloud
    ? undefined
    : "No cloud AI models or CLIs (Claude Code, Codex, Antigravity) detected on this Mac";
}

function TierTabs({
  tier,
  hasCloud,
  onTier,
}: {
  tier: Tier;
  hasCloud: boolean;
  onTier: (tier: Tier) => void;
}) {
  return (
    <div className="engine-tier-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={tier === "local"}
        className={tabClass(tier, "local")}
        onClick={() => onTier("local")}
      >
        On this Mac
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tier === "cloud"}
        className={tabClass(tier, "cloud")}
        onClick={() => onTier("cloud")}
        disabled={!hasCloud}
        title={cloudTabTitle(hasCloud)}
      >
        Cloud
      </button>
    </div>
  );
}

export function localItemClass(model: string, selected: string): string {
  return `model-menu-item${model === selected ? " sel" : ""}`;
}

function embeddingTitle(embedOnly: boolean): string | undefined {
  return embedOnly
    ? "Used for semantic search only — this model cannot hold a chat"
    : undefined;
}

function localTierLabel(embedOnly: boolean): string {
  return embedOnly ? "Search only" : "Local";
}

function LocalCheck({
  selected,
  embedOnly,
}: {
  selected: boolean;
  embedOnly: boolean;
}) {
  return selected && !embedOnly ? <CheckIcon size={14} /> : null;
}

function LocalModelRow({
  model,
  selected,
  onSelect,
  renderExtra,
}: {
  model: string;
  selected: string;
  onSelect: (model: string) => void;
  renderExtra?: (model: string) => ReactNode;
}) {
  const embedOnly = isEmbeddingModel(model);
  const isSelected = model === selected;
  return (
    <div className="model-menu-row">
      <button
        type="button"
        className={localItemClass(model, selected)}
        aria-pressed={isSelected}
        disabled={embedOnly}
        title={embeddingTitle(embedOnly)}
        onClick={() => onSelect(model)}
      >
        <span className="model-dot local" />
        <span className="model-menu-name">{modelLabel(model) ?? model}</span>
        <span className="model-menu-tier">{localTierLabel(embedOnly)}</span>
        <LocalCheck selected={isSelected} embedOnly={embedOnly} />
      </button>
      {renderExtra?.(model)}
    </div>
  );
}

function LocalTier({
  models,
  selected,
  onSelect,
  renderExtra,
  emptyHint,
}: {
  models: string[];
  selected: string;
  onSelect: (model: string) => void;
  renderExtra?: (model: string) => ReactNode;
  emptyHint?: ReactNode;
}) {
  const hint = emptyHint ?? "No models installed yet.";
  return (
    <div className="engine-tier-body">
      {models.length === 0 ? <div className="settings-hint">{hint}</div> : null}
      {models.map((model) => (
        <LocalModelRow
          key={model}
          model={model}
          selected={selected}
          onSelect={onSelect}
          renderExtra={renderExtra}
        />
      ))}
    </div>
  );
}

function TierBody({
  tier,
  localProps,
  cloudProps,
}: {
  tier: Tier;
  localProps: ComponentProps<typeof LocalTier>;
  cloudProps: ComponentProps<typeof CloudTier>;
}) {
  return tier === "local" ? (
    <LocalTier {...localProps} />
  ) : (
    <CloudTier {...cloudProps} />
  );
}

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
  const [ownModels, setOwnModels] = useState<
    Record<string, ExternalModelInfo[]>
  >({});
  const engineModels = liftedModels ?? ownModels;
  const recordModels =
    recordLifted ??
    ((engine: string, models: ExternalModelInfo[]) =>
      setOwnModels((current) => ({ ...current, [engine]: models })));
  const [selectedEngine, selectedModel] = cloudSelection(model, ai.external);
  const startsInCloud = selectedEngine !== null;
  const lists = modelsForPicker(ai.models, manage);
  const [tier, setTier] = useState<Tier>(initialTier(startsInCloud, model));
  const [expanded, setExpanded] = useState<string | null>(
    initialExpanded(startsInCloud, selectedEngine),
  );
  const [filters, filterActions] = usePickerFilters();
  const { loadingEngine, loadError } = useEngineModels(
    expanded,
    ai.external,
    engineModels,
    recordModels,
  );
  const { validatingModel, modelValidation, selectValidated } =
    useValidatedSelection(onSelect);
  const toggleExpand = (engine: string) => {
    if (expanded !== engine) filterActions.reset();
    setExpanded((current) => (current === engine ? null : engine));
  };
  const localProps = {
    models: lists.localModels,
    selected: model,
    onSelect,
    renderExtra: renderLocalExtra,
    emptyHint: localEmptyHint,
  };
  const cloudProps = {
    remoteModels: lists.remoteModels,
    engines: ai.external,
    engineModels,
    selected: model,
    selectedEngine,
    selectedModel,
    expanded,
    loading: loadingEngine,
    error: loadError,
    filters,
    filterActions,
    validation: modelValidation,
    validatingModel,
    selectValidated,
    onSelect,
    onExpand: toggleExpand,
    renderExtra: renderLocalExtra,
  };
  return (
    <div className="engine-picker">
      <TierTabs
        tier={tier}
        hasCloud={cloudTierAvailable(ai.external, lists.remoteModels)}
        onTier={setTier}
      />
      <TierBody tier={tier} localProps={localProps} cloudProps={cloudProps} />
    </div>
  );
}
