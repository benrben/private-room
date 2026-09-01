import type { ReactNode } from "react";
import { ENGINE_LABELS, type ExternalModelInfo } from "../api";
import { CheckIcon, ChevronDownIcon } from "../icons";
import {
  localItemClass,
  type EngineCatalog,
  type FilterActions,
  type ModelValidation,
  type PickerFilters,
} from "./EngineModelPicker";
import { engineCatalog, ExternalModels, RemoteModels } from "./engineModelCatalog";

export function FilterChip({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={selected ? "active pick-on" : ""}
      aria-pressed={selected}
      onClick={onClick}
    >
      {selected ? <CheckIcon size={12} /> : null}
      {label}
    </button>
  );
}

export function CatalogControls({
  catalog,
  engine,
  filters,
  actions,
}: {
  catalog: EngineCatalog;
  engine: string;
  filters: PickerFilters;
  actions: FilterActions;
}) {
  if (!catalog.hasRichCatalog) return null;
  return (
    <div className="model-catalog-controls">
      <input
        type="search"
        value={filters.query}
        onChange={(event) => actions.setQuery(event.target.value)}
        placeholder={`Search ${catalog.models.length.toLocaleString()} models…`}
        aria-label={`Search ${ENGINE_LABELS[engine] ?? engine} models`}
      />
      <div
        className="model-filter-chips"
        role="group"
        aria-label="Model capabilities"
      >
        <FilterChip
          label="Tools"
          selected={filters.needsTools}
          onClick={() => actions.setNeedsTools(!filters.needsTools)}
        />
        <FilterChip
          label="Vision"
          selected={filters.needsVision}
          onClick={() => actions.setNeedsVision(!filters.needsVision)}
        />
        <FilterChip
          label="Reasoning"
          selected={filters.needsReasoning}
          onClick={() => actions.setNeedsReasoning(!filters.needsReasoning)}
        />
        <FilterChip
          label="JSON"
          selected={filters.needsStructured}
          onClick={() => actions.setNeedsStructured(!filters.needsStructured)}
        />
        <span>{catalog.visibleModels.length.toLocaleString()} shown</span>
      </div>
    </div>
  );
}

export function LoadingNotice({
  loading,
  engine,
}: {
  loading: string | null;
  engine: string;
}) {
  return loading === engine ? (
    <div className="settings-hint engine-submodel-loading" role="status">
      Checking…
    </div>
  ) : null;
}

export function LoadErrorNotice({
  error,
  engine,
}: {
  error: string | null;
  engine: string;
}) {
  if (error !== engine) return null;
  const message =
    engine === "openrouter"
      ? "Couldn't refresh the model catalog. Check the connection in Settings."
      : `Couldn't list models — using ${ENGINE_LABELS[engine] ?? engine}'s default.`;
  return (
    <div className="settings-hint engine-submodel-loading" role="status">
      {message}
    </div>
  );
}

export function EmptyFilterNotice({
  catalog,
  loading,
}: {
  catalog: EngineCatalog;
  loading: string | null;
}) {
  return !loading &&
    catalog.hasRichCatalog &&
    catalog.visibleModels.length === 0 ? (
    <div className="settings-hint engine-submodel-loading" role="status">
      No models match these filters — clear one to see more.
    </div>
  ) : null;
}

export function EmptyOpenRouterNotice({
  engine,
  catalog,
  loading,
  error,
}: {
  engine: string;
  catalog: EngineCatalog;
  loading: string | null;
  error: string | null;
}) {
  return !loading &&
    !error &&
    engine === "openrouter" &&
    catalog.models.length === 0 ? (
    <div className="settings-hint engine-submodel-loading" role="status">
      No models are available for this OpenRouter account.
    </div>
  ) : null;
}

export function EngineDefault({
  engine,
  selected,
  onSelect,
}: {
  engine: string;
  selected: string;
  onSelect: (model: string) => void;
}) {
  if (engine === "openrouter") return null;
  const isSelected = selected === engine;
  return (
    <button
      type="button"
      className={`model-menu-item engine-submodel-default${isSelected ? " sel" : ""}`}
      aria-pressed={isSelected}
      onClick={() => onSelect(engine)}
    >
      <span className="model-dot cloud" />
      <span className="model-menu-name">
        {ENGINE_LABELS[engine] ?? engine}'s default
      </span>
      {isSelected ? <CheckIcon size={14} /> : null}
    </button>
  );
}

export function ExpandedEngine({
  engine,
  catalog,
  selected,
  selectedEngine,
  selectedModel,
  loading,
  error,
  filters,
  filterActions,
  validation,
  validatingModel,
  selectValidated,
  onSelect,
}: {
  engine: string;
  catalog: EngineCatalog;
  selected: string;
  selectedEngine: string | null;
  selectedModel: string | null;
  loading: string | null;
  error: string | null;
  filters: PickerFilters;
  filterActions: FilterActions;
  validation: ModelValidation;
  validatingModel: string | null;
  selectValidated: (
    engine: string,
    exactModel: string,
    selection: string,
  ) => Promise<void>;
  onSelect: (model: string) => void;
}) {
  return (
    <div className="engine-submodel-list">
      <LoadingNotice loading={loading} engine={engine} />
      <LoadErrorNotice error={error} engine={engine} />
      <CatalogControls
        catalog={catalog}
        engine={engine}
        filters={filters}
        actions={filterActions}
      />
      {!loading ? (
        <ExternalModels
          engine={engine}
          catalog={catalog}
          selected={selected}
          selectedEngine={selectedEngine}
          selectedModel={selectedModel}
          validation={validation}
          validatingModel={validatingModel}
          selectValidated={selectValidated}
          onSelect={onSelect}
        />
      ) : null}
      <EmptyFilterNotice catalog={catalog} loading={loading} />
      <EmptyOpenRouterNotice
        engine={engine}
        catalog={catalog}
        loading={loading}
        error={error}
      />
      <EngineDefault engine={engine} selected={selected} onSelect={onSelect} />
    </div>
  );
}

export function CloudEngineHeader({
  engine,
  selected,
  expanded,
  onExpand,
}: {
  engine: string;
  selected: string;
  expanded: string | null;
  onExpand: (engine: string) => void;
}) {
  const isExpanded = expanded === engine;
  return (
    <button
      type="button"
      className={localItemClass(engine, selected)}
      aria-pressed={selected === engine}
      aria-expanded={isExpanded}
      onClick={() => onExpand(engine)}
    >
      <span className="model-dot cloud" />
      <span className="model-menu-name">{ENGINE_LABELS[engine] ?? engine}</span>
      <ChevronDownIcon
        size={14}
        className={`engine-expand-caret${isExpanded ? " open" : ""}`}
      />
    </button>
  );
}

export function CloudEngineGroup({
  engine,
  models,
  selected,
  selectedEngine,
  selectedModel,
  expanded,
  loading,
  error,
  filters,
  filterActions,
  validation,
  validatingModel,
  selectValidated,
  onSelect,
  onExpand,
}: {
  engine: string;
  models: ExternalModelInfo[];
  selected: string;
  selectedEngine: string | null;
  selectedModel: string | null;
  expanded: string | null;
  loading: string | null;
  error: string | null;
  filters: PickerFilters;
  filterActions: FilterActions;
  validation: ModelValidation;
  validatingModel: string | null;
  selectValidated: (
    engine: string,
    exactModel: string,
    selection: string,
  ) => Promise<void>;
  onSelect: (model: string) => void;
  onExpand: (engine: string) => void;
}) {
  const catalog = engineCatalog(models, filters);
  const isExpanded = expanded === engine;
  return (
    <div className="engine-cloud-group">
      <CloudEngineHeader
        engine={engine}
        selected={selected}
        expanded={expanded}
        onExpand={onExpand}
      />
      {isExpanded ? (
        <ExpandedEngine
          engine={engine}
          catalog={catalog}
          selected={selected}
          selectedEngine={selectedEngine}
          selectedModel={selectedModel}
          loading={loading}
          error={error}
          filters={filters}
          filterActions={filterActions}
          validation={validation}
          validatingModel={validatingModel}
          selectValidated={selectValidated}
          onSelect={onSelect}
        />
      ) : null}
    </div>
  );
}

export function CloudEngines({
  engines,
  models,
  selected,
  selectedEngine,
  selectedModel,
  expanded,
  loading,
  error,
  filters,
  filterActions,
  validation,
  validatingModel,
  selectValidated,
  onSelect,
  onExpand,
}: {
  engines: string[];
  models: Record<string, ExternalModelInfo[]>;
  selected: string;
  selectedEngine: string | null;
  selectedModel: string | null;
  expanded: string | null;
  loading: string | null;
  error: string | null;
  filters: PickerFilters;
  filterActions: FilterActions;
  validation: ModelValidation;
  validatingModel: string | null;
  selectValidated: (
    engine: string,
    exactModel: string,
    selection: string,
  ) => Promise<void>;
  onSelect: (model: string) => void;
  onExpand: (engine: string) => void;
}) {
  return engines.map((engine) => (
    <CloudEngineGroup
      key={engine}
      engine={engine}
      models={models[engine] ?? []}
      selected={selected}
      selectedEngine={selectedEngine}
      selectedModel={selectedModel}
      expanded={expanded}
      loading={loading}
      error={error}
      filters={filters}
      filterActions={filterActions}
      validation={validation}
      validatingModel={validatingModel}
      selectValidated={selectValidated}
      onSelect={onSelect}
      onExpand={onExpand}
    />
  ));
}

export function CloudTier({
  remoteModels,
  engines,
  engineModels,
  selected,
  selectedEngine,
  selectedModel,
  expanded,
  loading,
  error,
  filters,
  filterActions,
  validation,
  validatingModel,
  selectValidated,
  onSelect,
  onExpand,
  renderExtra,
}: {
  remoteModels: string[];
  engines: string[];
  engineModels: Record<string, ExternalModelInfo[]>;
  selected: string;
  selectedEngine: string | null;
  selectedModel: string | null;
  expanded: string | null;
  loading: string | null;
  error: string | null;
  filters: PickerFilters;
  filterActions: FilterActions;
  validation: ModelValidation;
  validatingModel: string | null;
  selectValidated: (
    engine: string,
    exactModel: string,
    selection: string,
  ) => Promise<void>;
  onSelect: (model: string) => void;
  onExpand: (engine: string) => void;
  renderExtra?: (model: string) => ReactNode;
}) {
  return (
    <div className="engine-tier-body">
      <RemoteModels
        models={remoteModels}
        selected={selected}
        validation={validation}
        validatingModel={validatingModel}
        selectValidated={selectValidated}
        renderExtra={renderExtra}
      />
      <CloudEngines
        engines={engines}
        models={engineModels}
        selected={selected}
        selectedEngine={selectedEngine}
        selectedModel={selectedModel}
        expanded={expanded}
        loading={loading}
        error={error}
        filters={filters}
        filterActions={filterActions}
        validation={validation}
        validatingModel={validatingModel}
        selectValidated={selectValidated}
        onSelect={onSelect}
        onExpand={onExpand}
      />
    </div>
  );
}
