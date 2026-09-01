import type { ReactNode } from "react";
import { ExternalModelInfo, modelLabel } from "../api";
import { CheckIcon } from "../icons";
import {
  localItemClass,
  validationKey,
  type EngineCatalog,
  type ModelValidation,
  type PickerFilters,
} from "./EngineModelPicker";

export function selectionDisabled(
  checking: boolean,
  validation: { selectable: boolean } | undefined,
): boolean {
  return checking || validation?.selectable === false;
}

export function remoteTitle(
  checking: boolean,
  validation: { reason: string | null } | undefined,
): string | undefined {
  return (
    validation?.reason ??
    (checking ? "Checking this exact Ollama model ID…" : undefined)
  );
}

export function ValidationNotice({
  validation,
}: {
  validation: { selectable: boolean; reason: string | null } | undefined;
}) {
  return validation?.selectable === false ? (
    <div className="settings-hint engine-submodel-loading" role="status">
      {validation.reason}
    </div>
  ) : null;
}

export function RemoteModelRow({
  model,
  selected,
  validation,
  checking,
  onSelect,
  renderExtra,
}: {
  model: string;
  selected: string;
  validation: { selectable: boolean; reason: string | null } | undefined;
  checking: boolean;
  onSelect: () => void;
  renderExtra?: (model: string) => ReactNode;
}) {
  const isSelected = model === selected;
  return (
    <div className="model-menu-row">
      <button
        type="button"
        className={localItemClass(model, selected)}
        aria-pressed={isSelected}
        disabled={selectionDisabled(checking, validation)}
        title={remoteTitle(checking, validation)}
        onClick={onSelect}
      >
        <span className="model-dot cloud" />
        <span className="model-menu-name">{modelLabel(model) ?? model}</span>
        <span className="model-menu-tier cloud">
          {checking ? "Checking…" : "Cloud"}
        </span>
        {isSelected ? <CheckIcon size={14} /> : null}
      </button>
      {renderExtra?.(model)}
      <ValidationNotice validation={validation} />
    </div>
  );
}

export function RemoteModels({
  models,
  selected,
  validation,
  validatingModel,
  selectValidated,
  renderExtra,
}: {
  models: string[];
  selected: string;
  validation: ModelValidation;
  validatingModel: string | null;
  selectValidated: (
    engine: string,
    exactModel: string,
    selection: string,
  ) => Promise<void>;
  renderExtra?: (model: string) => ReactNode;
}) {
  return models.map((model) => {
    const key = validationKey("ollama-cloud", model);
    return (
      <RemoteModelRow
        key={model}
        model={model}
        selected={selected}
        validation={validation[key]}
        checking={validatingModel === key}
        onSelect={() => void selectValidated("ollama-cloud", model, model)}
        renderExtra={renderExtra}
      />
    );
  });
}

export function hasCatalogDetails(model: ExternalModelInfo): boolean {
  return Boolean(model.contextWindow || model.description || model.inputPrice);
}

export function matchesSearch(model: ExternalModelInfo, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (
    needle &&
    !`${model.label} ${model.slug}`.toLowerCase().includes(needle)
  ) {
    return false;
  }
  return true;
}

export function meetsRequirement(required: boolean, supported: boolean): boolean {
  return !required || supported;
}

export function capabilityMatches(
  model: ExternalModelInfo,
  filters: PickerFilters,
): boolean {
  return [
    meetsRequirement(filters.needsTools, model.tools),
    meetsRequirement(filters.needsVision, model.vision),
    meetsRequirement(filters.needsReasoning, model.reasoning),
    meetsRequirement(filters.needsStructured, model.structuredOutputs),
  ].every(Boolean);
}

export function matchesCatalogModel(
  model: ExternalModelInfo,
  filters: PickerFilters,
): boolean {
  return (
    matchesSearch(model, filters.query) && capabilityMatches(model, filters)
  );
}

export function engineCatalog(
  models: ExternalModelInfo[],
  filters: PickerFilters,
): EngineCatalog {
  const hasRichCatalog = models.some(hasCatalogDetails);
  const visibleModels = hasRichCatalog
    ? models.filter((model) => matchesCatalogModel(model, filters))
    : models;
  return { models, hasRichCatalog, visibleModels };
}

export function priceAmount(raw: string | null): number | null {
  if (!raw) return null;
  const amount = Number(raw) * 1_000_000;
  return Number.isFinite(amount) ? amount : null;
}

export function priceLabel(amount: number): string {
  if (amount === 0) return "free";
  return `$${amount < 0.01 ? amount.toFixed(3) : amount.toFixed(2)}/M`;
}

export function perMillion(raw: string | null): string | null {
  const amount = priceAmount(raw);
  return amount === null ? null : priceLabel(amount);
}

export function contextLabel(contextWindow: number | null): string | null {
  if (!contextWindow) return null;
  const size =
    contextWindow >= 1_000_000
      ? `${(contextWindow / 1_000_000).toFixed(1)}M`
      : `${Math.round(contextWindow / 1000)}K`;
  return `${size} ctx`;
}

export function OptionalText({ value }: { value: string | null }) {
  return value ? <span>{value}</span> : null;
}

export function Capability({ enabled, label }: { enabled: boolean; label: string }) {
  return enabled ? <span>{label}</span> : null;
}

export function Price({ raw, kind }: { raw: string | null; kind: "in" | "out" }) {
  const label = perMillion(raw);
  return label ? (
    <span>
      {label} {kind}
    </span>
  ) : null;
}

export function CatalogMetadata({
  model,
  rich,
}: {
  model: ExternalModelInfo;
  rich: boolean;
}) {
  if (!rich) return null;
  return (
    <span className="model-catalog-meta">
      <OptionalText value={contextLabel(model.contextWindow)} />
      <Capability enabled={model.tools} label="tools" />
      <Capability enabled={model.vision} label="vision" />
      <Capability enabled={model.reasoning} label="reasoning" />
      <Capability enabled={model.structuredOutputs} label="structured" />
      <Price raw={model.inputPrice} kind="in" />
      <Price raw={model.outputPrice} kind="out" />
    </span>
  );
}

export function externalTitle(
  model: ExternalModelInfo,
  validation: { reason: string | null } | undefined,
  checking: boolean,
): string {
  if (validation?.reason) return validation.reason;
  if (checking) return `Checking ${model.slug}…`;
  return model.description ?? model.label;
}

export function EffortCheck({ selected }: { selected: boolean }) {
  return selected ? <CheckIcon size={12} /> : null;
}

export function EffortChip({
  model,
  effort,
  selected,
  onSelect,
}: {
  model: string;
  effort: string;
  selected: string;
  onSelect: (model: string) => void;
}) {
  const value = `${model}::${effort}`;
  const isSelected = selected === value;
  return (
    <button
      type="button"
      className={`effort-chip${isSelected ? " sel pick-on" : ""}`}
      aria-pressed={isSelected}
      onClick={() => onSelect(value)}
    >
      <EffortCheck selected={isSelected} />
      {effort}
    </button>
  );
}

export function EffortChips({
  model,
  base,
  picked,
  selected,
  onSelect,
}: {
  model: ExternalModelInfo;
  base: string;
  picked: boolean;
  selected: string;
  onSelect: (model: string) => void;
}) {
  if (!picked || model.efforts.length === 0) return null;
  const defaultSelected = selected === base;
  return (
    <div className="effort-chips" role="group" aria-label="Reasoning effort">
      <button
        type="button"
        className={`effort-chip${defaultSelected ? " sel pick-on" : ""}`}
        aria-pressed={defaultSelected}
        title={
          model.defaultEffort
            ? `Model default (${model.defaultEffort})`
            : "The CLI's default effort"
        }
        onClick={() => onSelect(base)}
      >
        <EffortCheck selected={defaultSelected} />
        Default
      </button>
      {model.efforts.map((effort) => (
        <EffortChip
          key={effort}
          model={base}
          effort={effort}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

export function ExternalModelRow({
  engine,
  model,
  selected,
  selectedEngine,
  selectedModel,
  rich,
  validation,
  checking,
  selectValidated,
  onSelect,
}: {
  engine: string;
  model: ExternalModelInfo;
  selected: string;
  selectedEngine: string | null;
  selectedModel: string | null;
  rich: boolean;
  validation: { selectable: boolean; reason: string | null } | undefined;
  checking: boolean;
  selectValidated: (
    engine: string,
    exactModel: string,
    selection: string,
  ) => Promise<void>;
  onSelect: (model: string) => void;
}) {
  const base = `${engine}::${model.slug}`;
  const picked = selectedEngine === engine && selectedModel === model.slug;
  const baseSelected = selected === base;
  return (
    <div className="engine-submodel">
      <button
        type="button"
        className={localItemClass(base, selected)}
        aria-pressed={baseSelected}
        disabled={selectionDisabled(checking, validation)}
        title={externalTitle(model, validation, checking)}
        onClick={() => void selectValidated(engine, model.slug, base)}
      >
        <span className="model-dot cloud" />
        <span className="model-menu-name model-catalog-name">
          <span>{model.label}</span>
          <CatalogMetadata model={model} rich={rich} />
        </span>
        {baseSelected ? <CheckIcon size={14} /> : null}
      </button>
      <ValidationNotice validation={validation} />
      <EffortChips
        model={model}
        base={base}
        picked={picked}
        selected={selected}
        onSelect={onSelect}
      />
    </div>
  );
}

export function ExternalModels({
  engine,
  catalog,
  selected,
  selectedEngine,
  selectedModel,
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
  validation: ModelValidation;
  validatingModel: string | null;
  selectValidated: (
    engine: string,
    exactModel: string,
    selection: string,
  ) => Promise<void>;
  onSelect: (model: string) => void;
}) {
  return catalog.visibleModels.map((model) => {
    const key = validationKey(engine, model.slug);
    return (
      <ExternalModelRow
        key={model.slug}
        engine={engine}
        model={model}
        selected={selected}
        selectedEngine={selectedEngine}
        selectedModel={selectedModel}
        rich={catalog.hasRichCatalog}
        validation={validation[key]}
        checking={validatingModel === key}
        selectValidated={selectValidated}
        onSelect={onSelect}
      />
    );
  });
}
