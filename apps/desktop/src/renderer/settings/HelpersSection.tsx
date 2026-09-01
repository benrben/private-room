import type { AiStatus, IconComponent, RecommendedModels } from "./types";
import { CircleCheckIcon } from "../icons";

interface Props {
  ai: AiStatus | null;
  visionInstalled: boolean;
  /** The model that would actually mark an image for this room — the room's own
   *  model when it can see, otherwise a local one. Named in the "Installed" row
   *  so the answer to "what is looking at my pictures?" is visible, not implied. */
  groundingModel: string | null;
  /** PREFLIGHT: why this room cannot mark an image, when the answer is NOT
   *  "download a vision helper" (today: the privacy door blinding a capable
   *  cloud model). Null = the download offer is the right advice. */
  visionBlock: string | null;
  recommended: RecommendedModels | null;
  pullSpecial: (name: string, useEnsureEmbed?: boolean) => void;
  pullingSpecial: string | null;
  pulling: boolean;
  stopPull: () => void;
  stoppingPull: boolean;
  embedInstalled: boolean;
  pullPercent: number | null;
  pullStatus: string;
  DownloadIcon: IconComponent;
}

type DownloadProps = Pick<Props, "ai" | "recommended" | "pullSpecial" | "pulling" | "pullingSpecial" | "DownloadIcon">;

export default function HelpersSection(props: Props) {
  return (
    <section id="set-helpers">
      <h3>AI helpers</h3>
      <p className="settings-hint">
        Two small local models that unlock extra features. Each downloads once and runs entirely on this Mac.
      </p>
      <VisionHelper {...props} />
      <SemanticSearchHelper {...props} />
      <HelperPullProgress {...props} />
    </section>
  );
}

function VisionHelper(props: Pick<Props, "groundingModel" | "visionBlock" | "visionInstalled"> & DownloadProps) {
  return (
    <>
      <label className="settings-label">Vision helper</label>
      <VisionHelperState {...props} />
    </>
  );
}

function VisionHelperState({
  groundingModel,
  visionBlock,
  visionInstalled,
  ...downloadProps
}: Pick<Props, "groundingModel" | "visionBlock" | "visionInstalled"> & DownloadProps) {
  if (visionInstalled) return <VisionReady groundingModel={groundingModel} />;
  if (visionBlock) return <VisionBlocked message={visionBlock} />;
  return <VisionDownloadOffer {...downloadProps} />;
}

function VisionReady({ groundingModel }: Pick<Props, "groundingModel">) {
  return (
    <div className="model-row active is-ok">
      <span className="btn-ic">
        <CircleCheckIcon size={14} /> Ready — the AI can see and mark images
        {groundingModel ? <> (<code>{groundingModel}</code>)</> : null}.
      </span>
    </div>
  );
}

function VisionBlocked({ message }: { message: string }) {
  return <p className="set-note set-note--flag nb-sem-pending">{message}</p>;
}

function VisionDownloadOffer(props: DownloadProps) {
  const { recommended } = props;
  return (
    <>
      <p className="settings-hint">
        Nothing can read or mark images for this room yet. Any model with the “vision” badge in the Model section does this — including a cloud one — or download a local helper
        {recommended ? ` (${recommended.vision})` : ""}.
      </p>
      <VisionDownloadButton {...props} />
    </>
  );
}

function VisionDownloadButton({ ai, recommended, pullSpecial, pulling, pullingSpecial, DownloadIcon }: DownloadProps) {
  if (!ai?.running) return <p className="settings-hint">Ollama is not running — start it to download a local helper.</p>;
  return (
    <button
      className="btn-ic"
      disabled={downloadIsBusy(pullingSpecial, pulling)}
      onClick={() => requestVisionDownload(recommended, pullSpecial)}
    >
      <DownloadIcon size={14} /> Download a local vision helper
    </button>
  );
}

function requestVisionDownload(recommended: RecommendedModels | null, pullSpecial: Props["pullSpecial"]) {
  if (recommended) pullSpecial(recommended.vision);
}

function SemanticSearchHelper(props: Pick<Props, "embedInstalled"> & DownloadProps) {
  return (
    <>
      <label className="settings-label" style={{ marginTop: 12 }}>Semantic search</label>
      <SemanticSearchState {...props} />
    </>
  );
}

function SemanticSearchState({ embedInstalled, ...downloadProps }: Pick<Props, "embedInstalled"> & DownloadProps) {
  if (embedInstalled) return <SemanticSearchReady />;
  return <SemanticSearchDownloadOffer {...downloadProps} />;
}

function SemanticSearchReady() {
  return (
    <div className="model-row active is-ok">
      <span className="btn-ic"><CircleCheckIcon size={14} /> On — search understands meaning, not just words.</span>
    </div>
  );
}

function SemanticSearchDownloadOffer(props: DownloadProps) {
  const { recommended } = props;
  return (
    <>
      <p className="settings-hint">
        Adds meaning-based search across your files
        {recommended ? ` (${recommended.embed})` : ""}. Turning it on indexes what's already here.
      </p>
      <SemanticSearchDownloadButton {...props} />
    </>
  );
}

function SemanticSearchDownloadButton({ ai, recommended, pullSpecial, pulling, pullingSpecial, DownloadIcon }: DownloadProps) {
  if (!ai?.running) return <p className="settings-hint">Ollama is not running — start it to turn this on.</p>;
  return (
    <button
      className="btn-ic"
      disabled={downloadIsBusy(pullingSpecial, pulling)}
      onClick={() => pullSpecial(recommended?.embed ?? "", true)}
    >
      <DownloadIcon size={14} /> Turn on semantic search
    </button>
  );
}

function downloadIsBusy(pullingSpecial: string | null, pulling: boolean) {
  return !!pullingSpecial || pulling;
}

function HelperPullProgress({ pullPercent, pullStatus, pullingSpecial, stopPull, stoppingPull }: Pick<Props, "pullPercent" | "pullStatus" | "pullingSpecial" | "stopPull" | "stoppingPull">) {
  if (!pullingSpecial) return null;
  return (
    <div className="pull-progress">
      <HelperPullBar percent={pullPercent} />
      <HelperPullStatus percent={pullPercent} status={pullStatus} />
      <HelperPullStop stopPull={stopPull} stoppingPull={stoppingPull} />
    </div>
  );
}

function HelperPullBar({ percent }: { percent: number | null }) {
  if (percent == null) return null;
  return (
    <div className="pull-bar">
      <div className="pull-bar-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

function HelperPullStatus({ percent, status }: { percent: number | null; status: string }) {
  return <span>{status}{percent != null && ` — ${percent.toFixed(0)}%`}</span>;
}

function HelperPullStop({ stopPull, stoppingPull }: Pick<Props, "stopPull" | "stoppingPull">) {
  return (
    <button className="subtle" onClick={stopPull} disabled={stoppingPull}>
      {stoppingPull ? "Stopping…" : "Stop"}
    </button>
  );
}
