import ToolBadgeIcon from "./ToolBadgeIcon";
import type { AiStatus, IconComponent, ModelCaps, SttStatus } from "./types";
import { CheckIcon, CloseIcon, CircleCheckIcon } from "../icons";
import EngineModelPicker from "../workspace/EngineModelPicker";

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

export default function ModelSection({
  ai,
  model,
  onModelChange,
  caps,
  confirmModel,
  confirmRemoveModel,
  cancelRemoveModel,
  askRemoveModel,
  pullName,
  setPullName,
  pulling,
  pull,
  stopPull,
  stoppingPull,
  pullStatus,
  pullPercent,
  stt,
  removeStt,
  sttPercent,
  downloadStt,
  cancelStt,
  sttErr,
  dictTranslate,
  onDictTranslateChange,
  dictMode,
  onDictModeChange,
  AlertIcon,
  EyeIcon,
  TrashIcon,
  DownloadIcon,
}: Props) {
  return (
    <section id="set-model">
      <h3>Model</h3>
            <p className="settings-hint">
              The AI that lives in this room. Models run locally through
              Ollama — except <b>:cloud</b> models, which run on Ollama's
              servers: your prompts and file context leave this Mac.
            </p>
            {ai && (
              <>
                <EngineModelPicker
                  ai={ai}
                  model={model}
                  onSelect={onModelChange}
                  // Settings is the inventory: embedding models stay listed here
                  // so they can be seen and deleted, but cannot be chosen to chat.
                  manage
                  localEmptyHint={
                    ai.running ? undefined : "Ollama is not running — start it to manage local models."
                  }
                  renderLocalExtra={(m) => (
                    <>
                      {m.endsWith(":cloud") && (
                        <span
                          className="model-badge model-badge-cloud"
                          title="Runs on Ollama's servers — prompts and file context leave this Mac"
                        >
                          cloud · leaves this Mac
                        </span>
                      )}
                      {(() => {
                        const cap = caps.find((c) => c.name === m);
                        if (!cap) return null;
                        return (
                          <span className="model-badges">
                            {cap.tools && (
                              <span className="model-badge" title="Can control the app: open, edit, highlight files">
                                <ToolBadgeIcon /> tools
                              </span>
                            )}
                            {cap.vision && (
                              <span className="model-badge" title="Can see and mark images">
                                <EyeIcon size={11} className="model-badge-ic" /> vision
                              </span>
                            )}
                          </span>
                        );
                      })()}
                      {confirmModel === m ? (
                        <span className="model-confirm">
                          <span className="settings-hint">Delete?</span>
                          <button
                            className="subtle btn-ic confirm-yes"
                            title="Confirm delete"
                            aria-label="Confirm delete"
                            onClick={() => confirmRemoveModel(m)}
                          >
                            <CheckIcon size={14} />
                          </button>
                          <button
                            className="subtle btn-ic confirm-no"
                            title="Keep model"
                            aria-label="Keep model"
                            onClick={cancelRemoveModel}
                          >
                            <CloseIcon size={14} />
                          </button>
                        </span>
                      ) : (
                        <button
                          className="subtle btn-ic"
                          title={m === model ? "Can't delete the active model" : "Delete model from disk"}
                          disabled={m === model}
                          onClick={() => askRemoveModel(m)}
                        >
                          <TrashIcon size={13} />
                        </button>
                      )}
                    </>
                  )}
                />
                {(() => {
                  const sel = caps.find((c) => c.name === model);
                  if (!sel || sel.tools) return null;
                  return (
                    /* A capability the chosen model lacks: caution, not
                       alarm — nothing is leaving the Mac, something merely
                       will not work. */
                    <p className="model-warn set-note set-note--flag nb-sem-pending">
                      <AlertIcon size={16} className="warn-ic" /> This model can chat
                      but can't control the app (open, edit, or highlight files).
                      Pick a model badged{" "}
                      <strong>
                        <ToolBadgeIcon /> tools
                      </strong>{" "}
                      for full features.
                    </p>
                  );
                })()}
                {ai.external.length > 0 && (
                  /* Content leaving this Mac is the urgent meaning, and the
                     sentence is a core promise, so it runs at lead size. */
                  <p className="set-note set-note--flag set-note--lead nb-sem-urgent">
                    <AlertIcon size={16} className="warn-ic" /> Cloud engines send your questions and room context to your
                    connected AI provider or account — content leaves this Mac. Images stay
                    local (vision and image marking always use the local model).
                  </p>
                )}
              </>
            )}
            <div className="pull-row">
              <input
                placeholder="Download a model… e.g. qwen3.5:9b, gemma3:4b"
                value={pullName}
                disabled={pulling}
                onChange={(e) => setPullName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && pull()}
              />
              <button className="btn-ic" onClick={pull} disabled={pulling || !pullName.trim()}>
                <DownloadIcon size={14} /> {pulling ? "Downloading…" : "Download"}
              </button>
              {/* A multi-gigabyte download had no way out but quitting the app.
                  The backend's cancel flag was already there and tested; this is
                  the button that reaches it. */}
              {pulling && (
                <button className="subtle" onClick={stopPull} disabled={stoppingPull}>
                  {stoppingPull ? "Stopping…" : "Stop"}
                </button>
              )}
            </div>
            {(pullStatus || pullPercent != null) && (
              <div className="pull-progress">
                {pullPercent != null && (
                  <div className="pull-bar">
                    <div className="pull-bar-fill" style={{ width: `${pullPercent}%` }} />
                  </div>
                )}
                <span>
                  {pullStatus}
                  {pullPercent != null && ` — ${pullPercent.toFixed(0)}%`}
                </span>
              </div>
            )}
            {/* Sizing guidance is the kind of detail a returning user does not
                need on screen every time. Folded, not cut. */}
            <details className="set-more">
              <summary>Which size should I download?</summary>
              <p className="settings-hint">
                Tip: on a 16 GB Mac keep one model around 4B parameters — larger
                models are smarter but slower and heavier.
              </p>
            </details>

            <label className="settings-label">Dictation &amp; transcription</label>
            <p className="settings-hint">
              Turns speech into text fully on this Mac — voice messages, and
              imported recordings/videos become searchable transcripts. The
              engine is built in; it needs a one-time model download
              {stt ? ` (~${stt.sizeMb} MB)` : ""}.
            </p>
            {stt?.installed ? (
              <div className="model-row active is-ok">
                <span className="btn-ic"><CircleCheckIcon size={13} /> Voice model installed</span>
                <button
                  className="subtle btn-ic"
                  title="Delete the dictation model from disk"
                  aria-label="Delete the dictation model from disk"
                  onClick={removeStt}
                >
                  <TrashIcon size={13} />
                </button>
              </div>
            ) : sttPercent != null || stt?.downloading ? (
              <div className="pull-progress">
                <div className="pull-bar">
                  <div
                    className="pull-bar-fill"
                    style={{ width: `${sttPercent ?? 0}%` }}
                  />
                </div>
                <span>Downloading voice model — {sttPercent ?? 0}%</span>
                {/* 574 MB over a slow line is many minutes, and there was no
                    way out of it but quitting the app. */}
                <button className="subtle btn-ic" onClick={cancelStt}>
                  Stop
                </button>
              </div>
            ) : (
              <button className="btn-ic" onClick={downloadStt}>
                <DownloadIcon size={14} /> Download voice model
              </button>
            )}
            {sttErr && <div className="gate-error">{sttErr}</div>}
            {stt?.installed && (
              <>
                <label className="settings-label" style={{ marginTop: 10 }}>
                  <input
                    type="checkbox"
                    checked={dictTranslate}
                    onChange={onDictTranslateChange}
                  />{" "}
                  Translate dictation to English (local AI)
                </label>
                <label className="settings-label">
                  Shape dictation as{" "}
                  <select
                    value={dictMode}
                    onChange={onDictModeChange}
                  >
                    <option value="off">Exact words (no shaping)</option>
                    <option value="raw">Cleaned up (remove ums, fix grammar)</option>
                    <option value="notes">Notes / bullets</option>
                    <option value="email">Email body</option>
                    <option value="message">Chat message</option>
                    <option value="commit">Commit message</option>
                    <option value="prompt">Optimized AI prompt</option>
                  </select>
                </label>
                {/* Where dictated words go is a privacy fact, so it is an
                    attached note rather than a trailing hint. Quiet, because
                    the state it describes is the safe one. */}
                <p className="set-note">
                  Shaping and translation run on this room's local AI — dictated
                  words never reach a cloud engine. If the local AI is off, the
                  exact transcript is used instead.
                </p>
              </>
            )}
    </section>
  );
}
