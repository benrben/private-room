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

export default function HelpersSection({
  ai,
  visionInstalled,
  groundingModel,
  visionBlock,
  recommended,
  pullSpecial,
  pullingSpecial,
  pulling,
  stopPull,
  stoppingPull,
  embedInstalled,
  pullPercent,
  pullStatus,
  DownloadIcon,
}: Props) {
  return (
    // HELPERS — vision (image marking) + embeddings (semantic search).
    <section id="set-helpers">
      <h3>AI helpers</h3>
            <p className="settings-hint">
              Two small local models that unlock extra features. Each downloads
              once and runs entirely on this Mac.
            </p>
            {ai?.running ? (
              <>
                <label className="settings-label">Vision helper</label>
                {/* "Installed" now means SOMETHING can mark an image for this
                    room — which includes the room's own model. It used to mean
                    "a local model whose name we recognise is present", so a room
                    on a cloud vision model was told its vision helper was
                    missing and offered a download it had no use for. Naming the
                    model that will do the looking makes that checkable. */}
                {visionInstalled ? (
                  /* `is-ok`, not bare `active`: this row reports a FACT (a
                     helper is present and working), and `active` alone is the
                     pink selection wash. Same distinction the Model section
                     draws — green means installed, pink means chosen. */
                  <div className="model-row active is-ok">
                    <span className="btn-ic">
                      <CircleCheckIcon size={13} /> Ready — the AI can see and mark images
                      {groundingModel ? <> (<code>{groundingModel}</code>)</> : null}.
                    </span>
                  </div>
                ) : visionBlock ? (
                  /* Something here CAN see — a download would fix nothing. The
                     engine's declared record said what is actually in the way,
                     so show that sentence instead of the Download button.
                     Marked, because it is the reason a feature is off. */
                  <p className="set-note set-note--flag nb-sem-pending">
                    {visionBlock}
                  </p>
                ) : (
                  <>
                    <p className="settings-hint">
                      Nothing can read or mark images for this room yet. Any
                      model with the “vision” badge in the Model section does
                      this — including a cloud one — or download a local helper
                      {recommended ? ` (${recommended.vision})` : ""}.
                    </p>
                    <button
                      className="btn-ic"
                      disabled={!!pullingSpecial || pulling}
                      onClick={() =>
                        recommended && pullSpecial(recommended.vision)
                      }
                    >
                      <DownloadIcon size={14} /> Download a local vision helper
                    </button>
                  </>
                )}

                <label className="settings-label" style={{ marginTop: 12 }}>
                  Semantic search
                </label>
                {embedInstalled ? (
                  <div className="model-row active is-ok">
                    <span className="btn-ic"><CircleCheckIcon size={13} /> On — search understands meaning, not just words.</span>
                  </div>
                ) : (
                  <>
                    <p className="settings-hint">
                      Adds meaning-based search across your files
                      {recommended ? ` (${recommended.embed})` : ""}. Turning it
                      on indexes what's already here.
                    </p>
                    <button
                      className="btn-ic"
                      disabled={!!pullingSpecial || pulling}
                      onClick={() => pullSpecial(recommended?.embed ?? "", true)}
                    >
                      <DownloadIcon size={14} /> Turn on semantic search
                    </button>
                  </>
                )}

                {pullingSpecial && (
                  <div className="pull-progress">
                    {pullPercent != null && (
                      <div className="pull-bar">
                        <div
                          className="pull-bar-fill"
                          style={{ width: `${pullPercent}%` }}
                        />
                      </div>
                    )}
                    <span>
                      {pullStatus}
                      {pullPercent != null && ` — ${pullPercent.toFixed(0)}%`}
                    </span>
                    {/* Helpers are the multi-gigabyte ones (a vision model is
                        ~3 GB), so this is the surface that most needed a way
                        out. */}
                    <button
                      className="subtle"
                      onClick={stopPull}
                      disabled={stoppingPull}
                    >
                      {stoppingPull ? "Stopping…" : "Stop"}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <p className="settings-hint">
                Ollama is not running — start it to add these helpers.
              </p>
            )}
    </section>
  );
}
