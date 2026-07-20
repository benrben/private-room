import type { AiStatus, IconComponent, RecommendedModels } from "./types";
import { CircleCheckIcon } from "../icons";

interface Props {
  ai: AiStatus | null;
  visionInstalled: boolean;
  recommended: RecommendedModels | null;
  pullSpecial: (name: string, useEnsureEmbed?: boolean) => void;
  pullingSpecial: string | null;
  pulling: boolean;
  embedInstalled: boolean;
  pullPercent: number | null;
  pullStatus: string;
  DownloadIcon: IconComponent;
}

export default function HelpersSection({
  ai,
  visionInstalled,
  recommended,
  pullSpecial,
  pullingSpecial,
  pulling,
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
                {visionInstalled ? (
                  <div className="model-row active">
                    <span className="btn-ic"><CircleCheckIcon size={13} /> Installed — the AI can see and mark images.</span>
                  </div>
                ) : (
                  <>
                    <p className="settings-hint">
                      Lets the AI read and mark up images
                      {recommended ? ` (${recommended.vision})` : ""}.
                    </p>
                    <button
                      className="btn-ic"
                      disabled={!!pullingSpecial || pulling}
                      onClick={() =>
                        recommended && pullSpecial(recommended.vision)
                      }
                    >
                      <DownloadIcon size={14} /> Download the vision helper (for
                      image marking)
                    </button>
                  </>
                )}

                <label className="settings-label" style={{ marginTop: 12 }}>
                  Semantic search
                </label>
                {embedInstalled ? (
                  <div className="model-row active">
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
