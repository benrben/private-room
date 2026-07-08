import type { IconComponent } from "./types";

interface Props {
  webProvider: string;
  setWebProvider: (v: string) => void;
  webEndpoint: string;
  setWebEndpoint: (v: string) => void;
  webTesting: boolean;
  testWebSearch: () => void;
  saveWebAccess: () => void;
  webSaved: boolean;
  webTestResult: string;
  AlertIcon: IconComponent;
}

export default function OnlineSection({
  webProvider,
  setWebProvider,
  webEndpoint,
  setWebEndpoint,
  webTesting,
  testWebSearch,
  saveWebAccess,
  webSaved,
  webTestResult,
  AlertIcon,
}: Props) {
  return (
    <section id="set-online">
      <h3>Online features</h3>
            <p className="settings-hint">
              Give the AI two extra tools — <code>web_search</code> and{" "}
              <code>fetch_page</code> — for questions that need current or
              outside information. Off by default: while off, the tools are
              not even offered to the model.
            </p>
            <p className="settings-hint">
              <AlertIcon size={13} className="warn-ic" /> When on, search queries and fetched pages leave this Mac (to
              the provider you pick). Your files never do.
            </p>
            <label className="settings-label">Search provider</label>
            <select
              value={webProvider}
              onChange={(e) => setWebProvider(e.target.value)}
            >
              <option value="off">Off — room stays offline</option>
              <option value="duckduckgo">DuckDuckGo — free, no key or account</option>
              <option value="searxng">SearXNG (your own instance)</option>
            </select>
            {webProvider === "duckduckgo" && (
              <p className="settings-hint">
                Uses the public duckduckgo.com results page directly — nothing
                to sign up for. Heavy use can hit a temporary rate limit; the
                AI will say so and you can just retry.
              </p>
            )}
            {webProvider === "searxng" && (
              <>
                <label className="settings-label">SearXNG instance URL</label>
                <input
                  placeholder="http://127.0.0.1:8888 or https://searx.example.org"
                  value={webEndpoint}
                  onChange={(e) => setWebEndpoint(e.target.value)}
                />
                <p className="settings-hint">
                  The instance must allow JSON results (settings.yml:{" "}
                  <code>search.formats</code> includes <code>json</code>).
                </p>
              </>
            )}
            <div className="settings-actions">
              <button
                className="subtle"
                disabled={webTesting}
                onClick={testWebSearch}
              >
                {webTesting ? "Testing…" : "Test search"}
              </button>
              <button className="primary" onClick={saveWebAccess}>
                {webSaved ? "Saved ✓" : "Save"}
              </button>
            </div>
            {webTestResult && (
              <p className="settings-hint">{webTestResult}</p>
            )}
    </section>
  );
}
