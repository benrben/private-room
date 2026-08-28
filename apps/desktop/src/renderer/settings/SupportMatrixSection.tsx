import { useEffect, useState } from "react";
import { api } from "../api";
import type { Support, SupportMatrix } from "../apiTypes";

/** One capability cell. Three states, never two: an engine we could not reach
 *  must not be drawn as a tick OR a cross. The dash is the honest third mark,
 *  and its title says why it is there. */
function Cell({ value }: { value: Support }) {
  const mark = value === "yes" ? "✓" : value === "no" ? "✕" : "–";
  const title =
    value === "yes"
      ? "Yes"
      : value === "no"
        ? "No"
        : "Varies by model, or the engine could not be asked";
  return (
    <td className={`cap-cell cap-${value}`} title={title}>
      <span aria-hidden="true">{mark}</span>
      <span className="sr-only">{title}</span>
    </td>
  );
}

/**
 * WHAT EACH AI CAN DO — the published provider × agent matrix (owner decision
 * #3).
 *
 * Every number and tick here is DERIVED and none of it is written down twice:
 * the capability columns are the host's one declared record per engine
 * (`commands/capabilities.rs`), and the agent rows come from the sidecar
 * answering which workers each bridge tier can actually reach, using the same
 * predicate a live turn uses. A hand-kept table would have been wrong the first
 * time anyone added an agent or moved a tool between tiers — and this is shown
 * to the user, so being wrong is a truthfulness failure, not a docs nit.
 */
export default function SupportMatrixSection() {
  const [matrix, setMatrix] = useState<SupportMatrix | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .engineSupportMatrix()
      .then((m) => live && setMatrix(m))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, []);

  return (
    <section id="set-support-matrix">
      <h3>What each AI can do</h3>
      <p className="settings-hint">
        Generated from what each engine declares about itself and from the
        agents this app actually offers each one — not a hand-written list, so
        it cannot drift out of date.
      </p>
      {error ? (
        <p className="set-note set-note--flag nb-sem-pending">
          The support matrix could not be built: {error}
        </p>
      ) : !matrix ? (
        <p className="settings-hint">Checking…</p>
      ) : (
        <>
          <div className="cap-matrix-scroll">
            <table className="cap-matrix">
              <thead>
                <tr>
                  <th scope="col">Provider</th>
                  <th scope="col">Runs on</th>
                  <th scope="col">Live typing</th>
                  <th scope="col">Tools</th>
                  <th scope="col">Images</th>
                  <th scope="col">Strict output</th>
                  <th scope="col">Agents</th>
                </tr>
              </thead>
              <tbody>
                {matrix.providers.map((p) => (
                  <tr key={p.engine} className={p.available ? "" : "cap-unavailable"}>
                    <th scope="row">
                      {p.label}
                      {p.available ? null : (
                        <span className="cap-note"> — not set up on this Mac</span>
                      )}
                    </th>
                    <td>{p.local ? "This Mac" : "The cloud"}</td>
                    <Cell value={p.streaming} />
                    <Cell value={p.toolCalling} />
                    <Cell value={p.vision} />
                    <Cell value={p.structuredOutput} />
                    <td>
                      {/* Counts, not ticks: the per-agent detail is the grid
                          below, and a count here answers "does this engine lose
                          anything?" at a glance. `agentsKnown` guards it — an
                          unreached sidecar must show nothing, never a zero,
                          because a zero is a claim. */}
                      {matrix.agentsKnown ? (
                        `${p.agents.length} of ${matrix.agents.length}`
                      ) : (
                        <span className="cap-note">not known</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="settings-hint">
            “–” means it depends on the individual model you pick, or the engine
            could not be asked. “Images” is about handing the AI a picture; a
            cloud model that can see still receives nothing while this room’s
            privacy door is on.
          </p>
          {matrix.agentsKnown ? (
            /* The per-agent grid is providers x agents — the single biggest
               object in Settings, and it was pushing everything else off the
               page. It is the DETAIL behind the "n of m" count in the table
               above, so it folds behind a disclosure: the count answers "does
               this engine lose anything?", and opening this answers "what?".
               Nothing is removed — the whole grid stays in the DOM and in the
               accessibility tree. */
            <details className="set-more">
              <summary>Which agents each provider can run</summary>
              <div className="cap-matrix-scroll">
                <table className="cap-matrix">
                  <thead>
                    <tr>
                      <th scope="col">Agent</th>
                      {matrix.providers.map((p) => (
                        <th scope="col" key={p.engine}>
                          {p.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {matrix.agents.map((a) => (
                      <tr key={a.id}>
                        <th scope="row">{a.label}</th>
                        {matrix.providers.map((p) => (
                          <Cell
                            key={p.engine}
                            value={p.agents.includes(a.id) ? "yes" : "no"}
                          />
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : (
            <p className="settings-hint">
              The per-agent half needs the AI engine, which could not be reached
              {matrix.agentsError ? `: ${matrix.agentsError}` : "."} The
              capability columns above are still accurate — they come from the
              app itself.
            </p>
          )}
        </>
      )}
    </section>
  );
}
