import ToolBadgeIcon from "./ToolBadgeIcon";
import type { AiStatus, IconComponent, ModelCaps, SttStatus } from "./types";
import { CircleCheckIcon } from "../icons";
import EngineModelPicker from "../workspace/EngineModelPicker";
import DeleteControl from "../workspace/DeleteControl";

/** A small, understandable starting shelf from Ollama's public model library.
 * The free-form field stays below it, so this never prevents installing a new
 * or private registry tag. Sizes are approximate download sizes and are shown
 * before a multi-gigabyte pull begins. */
export const DOWNLOAD_MODEL_CHOICES = [
  { value: "qwen3.5:0.8b", label: "Qwen 3.5 0.8B — about 1 GB" },
  { value: "qwen3.5:2b", label: "Qwen 3.5 2B — about 2.7 GB" },
  { value: "qwen3.5:4b", label: "Qwen 3.5 4B — about 3.4 GB" },
  { value: "qwen3.5:4b-mlx", label: "Qwen 3.5 4B MLX — about 4 GB, recommended on Apple silicon" },
  { value: "qwen3.5:9b", label: "Qwen 3.5 9B — about 6.6 GB" },
  { value: "gemma3:1b", label: "Gemma 3 1B — about 815 MB" },
  { value: "gemma3:4b", label: "Gemma 3 4B — about 3.3 GB" },
] as const;

interface Props {
  ai: AiStatus | null;
  model: string;
  onModelChange: (model: string) => void;
  caps: ModelCaps[];
  confirmModel: string | null;
  confirmRemoveModel: (name: string) => void;
  cancelRemoveModel: () => void;
  askRemoveModel: (name: string) => void;
  pullName: string;
  setPullName: (v: string) => void;
  pulling: boolean;
  pull: () => void;
  stopPull: () => void;
  stoppingPull: boolean;
  pullStatus: string;
  pullPercent: number | null;
  stt: SttStatus | null;
  removeStt: () => void;
  sttPercent: number | null;
  downloadStt: () => void;
  cancelStt: () => void;
  sttErr: string;
  dictTranslate: boolean;
  onDictTranslateChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  dictMode: string;
  onDictModeChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  AlertIcon: IconComponent;
  EyeIcon: IconComponent;
  TrashIcon: IconComponent;
  DownloadIcon: IconComponent;
}

function ModelIntro({ remoteRelay }: { remoteRelay: boolean | undefined }) {
  if (remoteRelay) return <p className="settings-hint">The AI that lives in this room. This room's Ollama is another machine on your network (Settings → Remote AI), so every model listed below runs there, not on this Mac — your prompts and file context travel to it.</p>;
  return <p className="settings-hint">The AI that lives in this room. Models run locally through Ollama — except <b>:cloud</b> models, which run on Ollama's servers: your prompts and file context leave this Mac.</p>;
}

function CapabilityBadges({ name, caps, EyeIcon }: { name: string; caps: ModelCaps[]; EyeIcon: IconComponent }) {
  const capability = caps.find((cap) => cap.name === name);
  if (!capability) return null;
  return <span className="model-badges">{capability.tools && <span className="model-badge" title="Can control the app: open, edit, highlight files"><ToolBadgeIcon /> tools</span>}{capability.vision && <span className="model-badge" title="Can see and mark images"><EyeIcon size={12} className="model-badge-ic" /> vision</span>}</span>;
}

function ModelDelete({ name, active, confirmModel, confirmRemoveModel, cancelRemoveModel, askRemoveModel, TrashIcon }: Pick<Props, "confirmModel" | "confirmRemoveModel" | "cancelRemoveModel" | "askRemoveModel" | "TrashIcon"> & { name: string; active: boolean }) {
  if (active) return <button className="chip-btn" title="Can't delete the active model" aria-label="Can't delete the active model" disabled><TrashIcon size={14} /></button>;
  return <DeleteControl k={name} trigger={<TrashIcon size={14} />} title={`Delete ${name} from disk`} confirmDelete={confirmModel} askConfirm={askRemoveModel} cancelConfirm={cancelRemoveModel} onConfirm={() => confirmRemoveModel(name)} />;
}

function ModelRowExtras({ name, props }: { name: string; props: Props }) {
  return <>{name.endsWith(":cloud") && <span className="model-badge model-badge-cloud" title="Runs on Ollama's servers — prompts and file context leave this Mac">cloud · leaves this Mac</span>}<CapabilityBadges name={name} caps={props.caps} EyeIcon={props.EyeIcon} /><ModelDelete name={name} active={name === props.model} confirmModel={props.confirmModel} confirmRemoveModel={props.confirmRemoveModel} cancelRemoveModel={props.cancelRemoveModel} askRemoveModel={props.askRemoveModel} TrashIcon={props.TrashIcon} /></>;
}

function SelectedModelWarning({ caps, model, AlertIcon }: Pick<Props, "caps" | "model" | "AlertIcon">) {
  const selected = caps.find((capability) => capability.name === model);
  if (!selected || selected.tools) return null;
  return <p className="model-warn set-note set-note--flag nb-sem-pending"><AlertIcon size={16} className="warn-ic" /> This model can chat but can't control the app (open, edit, or highlight files). Pick a model badged <strong><ToolBadgeIcon /> tools</strong> for full features.</p>;
}

function CloudEngineWarning({ ai, AlertIcon }: Pick<Props, "ai" | "AlertIcon">) {
  if (!ai || ai.external.length === 0) return null;
  return <p className="set-note set-note--flag set-note--lead nb-sem-urgent"><AlertIcon size={16} className="warn-ic" /> Cloud engines send your questions and room context to your connected AI provider or account — content leaves this Mac. Images stay on this Mac only while Cloud privacy is on for this room: with the door off, a cloud model that can see images is handed them for vision and image marking.</p>;
}

function InstalledModels({ props }: { props: Props }) {
  if (!props.ai) return null;
  return <><EngineModelPicker ai={props.ai} model={props.model} onSelect={props.onModelChange} manage localEmptyHint={props.ai.running ? undefined : "Ollama is not running — start it to manage local models."} renderLocalExtra={(name) => <ModelRowExtras name={name} props={props} />} /><SelectedModelWarning caps={props.caps} model={props.model} AlertIcon={props.AlertIcon} /><CloudEngineWarning ai={props.ai} AlertIcon={props.AlertIcon} /></>;
}

function isDownloadChoice(name: string) {
  return DOWNLOAD_MODEL_CHOICES.some((choice) => choice.value === name);
}

function PullProgress({ pulling, status, percent }: { pulling: boolean; status: string; percent: number | null }) {
  if (!pulling || (!status && percent == null)) return null;
  return <div className="pull-progress">{percent != null && <div className="pull-bar"><div className="pull-bar-fill" style={{ width: `${percent}%` }} /></div>}<span>{status}{percent != null && ` — ${percent.toFixed(0)}%`}</span></div>;
}

function DownloadControls({ props }: { props: Props }) {
  const submitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => { if (event.key === "Enter") props.pull(); };
  return <><label className="settings-label" htmlFor="download-model-choice">Choose a model to download</label><select id="download-model-choice" data-testid="download-model-choice" value={isDownloadChoice(props.pullName) ? props.pullName : ""} disabled={props.pulling} onChange={(event) => props.setPullName(event.target.value)}><option value="">Select a model and size…</option>{DOWNLOAD_MODEL_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select><p className="settings-hint">Or enter any Ollama library tag below. The installed-model list above shows exact versions, tool and vision capabilities, and a delete control for every inactive local model.</p><div className="pull-row"><input placeholder="Download a model… e.g. qwen3.5:9b, gemma3:4b" value={props.pullName} disabled={props.pulling} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => props.setPullName(event.target.value)} onKeyDown={submitOnEnter} /><button className="btn-ic" onClick={props.pull} disabled={props.pulling || !props.pullName.trim()}><props.DownloadIcon size={14} /> {props.pulling ? "Downloading…" : "Download"}</button>{props.pulling && <button className="subtle" onClick={props.stopPull} disabled={props.stoppingPull}>{props.stoppingPull ? "Stopping…" : "Stop"}</button>}</div><PullProgress pulling={props.pulling} status={props.pullStatus} percent={props.pullPercent} /><details className="set-more"><summary>Which size should I download?</summary><p className="settings-hint">Tip: on a 16 GB Mac keep one model around 4B parameters — larger models are smarter but slower and heavier.</p></details></>;
}

function InstalledVoiceModel({ props }: { props: Props }) {
  return <div className="model-row active is-ok"><span className="btn-ic"><CircleCheckIcon size={14} /> Voice model installed</span><button className="subtle btn-ic" title="Delete the dictation model from disk" aria-label="Delete the dictation model from disk" onClick={props.removeStt}><props.TrashIcon size={14} /></button></div>;
}

function VoiceDownload({ props }: { props: Props }) {
  const percent = props.sttPercent ?? 0;
  if (props.sttPercent != null || props.stt?.downloading) return <div className="pull-progress"><div className="pull-bar"><div className="pull-bar-fill" style={{ width: `${percent}%` }} /></div><span>Downloading voice model — {percent}%</span><button className="subtle btn-ic" onClick={props.cancelStt}>Stop</button></div>;
  return <button className="btn-ic" onClick={props.downloadStt}><props.DownloadIcon size={14} /> Download voice model</button>;
}

function DictationPreferences({ props }: { props: Props }) {
  if (!props.stt?.installed) return null;
  return <><label className="settings-label" style={{ marginTop: 10 }}><input type="checkbox" checked={props.dictTranslate} onChange={props.onDictTranslateChange} /> Translate dictation to English (local AI)</label><label className="settings-label">Shape dictation as <select value={props.dictMode} onChange={props.onDictModeChange}><option value="off">Exact words (no shaping)</option><option value="raw">Cleaned up (remove ums, fix grammar)</option><option value="notes">Notes / bullets</option><option value="email">Email body</option><option value="message">Chat message</option><option value="commit">Commit message</option><option value="prompt">Optimized AI prompt</option></select></label><p className="set-note">Shaping and translation run on this room's local AI — dictated words never reach a cloud engine. If the local AI is off, the exact transcript is used instead.</p></>;
}

function DictationControls({ props }: { props: Props }) {
  return <><label className="settings-label">Dictation &amp; transcription</label><p className="settings-hint">Turns speech into text fully on this Mac — voice messages, and imported recordings/videos become searchable transcripts. The engine is built in; it needs a one-time model download{props.stt ? ` (~${props.stt.sizeMb} MB)` : ""}.</p>{props.stt?.installed ? <InstalledVoiceModel props={props} /> : <VoiceDownload props={props} />}{props.sttErr && <div className="gate-error">{props.sttErr}</div>}<DictationPreferences props={props} /></>;
}

export default function ModelSection(props: Props) {
  return <section id="set-model"><h3>Model</h3><ModelIntro remoteRelay={props.ai?.remoteRelay} /><InstalledModels props={props} /><DownloadControls props={props} /><DictationControls props={props} /></section>;
}
