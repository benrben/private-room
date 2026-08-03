import { useEffect, useState } from "react";
import { api } from "../api";

/** Online section: the room's internet switch, save, and a real one-shot test
 * through the backend (the model is not involved).
 *
 * There is no provider to choose: the app has exactly one search engine, which
 * fuses several engines behind the scenes. The setting is still called
 * `web_provider` and its old values still mean ON — see `web_access_enabled` in
 * commands.rs for why that is the whole migration. */
export function useOnlineSearch() {
  const [webOn, setWebOn] = useState(false);
  const [webSaved, setWebSaved] = useState(false);
  const [webTesting, setWebTesting] = useState(false);
  const [webTestResult, setWebTestResult] = useState("");
  // The two per-agent lanes under the master provider switch. ABSENT MEANS ON,
  // matching the Rust default — a room saved before these existed keeps both.
  const [searchAgent, setSearchAgent] = useState(true);
  const [browseAgent, setBrowseAgent] = useState(true);
  // BROWSE-3b result previews. Same absent-means-ON convention as the two
  // lanes above, matching `search.rs::result_previews_enabled`. The results
  // page has always told people to turn this off in Settings; until now there
  // was nothing there to turn off.
  const [resultPreviews, setResultPreviews] = useState(true);

  // What is actually STORED right now, so the panel can tell a typed-but-unsaved
  // switch from a saved one. Unticking "use the internet" and closing Settings
  // used to discard the change silently: the user believed the room was offline
  // and it was not, which is the one kind of wrong this panel does not get to be.
  const [savedState, setSavedState] = useState<string | null>(null);
  // A save that FAILS looked exactly like a click that did nothing — no error,
  // no tick, no toast.
  const [webError, setWebError] = useState("");

  const current = JSON.stringify([webOn, searchAgent, browseAgent, resultPreviews]);
  // Never "unsaved" before the stored values have loaded.
  const webDirty = savedState !== null && savedState !== current;

  useEffect(() => {
    // Any non-empty value that isn't "off" is ON — which is exactly what the
    // retired provider names ("duckduckgo", "searxng", "brave") meant, so a room
    // saved before the switch existed keeps its internet access.
    void (async () => {
      const [provider, search, browse, previews] = await Promise.all([
        api.getSetting("web_provider"),
        api.getSetting("web_agent_search"),
        api.getSetting("web_agent_browse"),
        api.getSetting("web_result_previews"),
      ]);
      const on = !!provider && provider !== "off";
      setWebOn(on);
      setSearchAgent(search !== "off");
      setBrowseAgent(browse !== "off");
      setResultPreviews(previews !== "off");
      setSavedState(
        JSON.stringify([on, search !== "off", browse !== "off", previews !== "off"]),
      );
    })();
  }, []);

  async function saveWebAccess() {
    setWebError("");
    try {
      await api.setSetting("web_provider", webOn ? "on" : "off");
      await api.setSetting("web_agent_search", searchAgent ? "on" : "off");
      await api.setSetting("web_agent_browse", browseAgent ? "on" : "off");
      await api.setSetting("web_result_previews", resultPreviews ? "on" : "off");
    } catch (e) {
      // Leave `savedState` alone: nothing was stored, so the panel must keep
      // saying "not saved yet".
      setWebError(`Couldn't save: ${String(e)}`);
      throw e;
    }
    setSavedState(current);
    setWebSaved(true);
    window.setTimeout(() => setWebSaved(false), 1600);
  }

  /** Saves first (so what's tested is what's active), then runs one real
   * search through the backend — the model is not involved. */
  async function testWebSearch() {
    setWebTesting(true);
    setWebTestResult("");
    try {
      await saveWebAccess();
      setWebTestResult(await api.webSearchTest());
    } catch (e) {
      setWebTestResult(`✗ ${String(e)}`);
    } finally {
      setWebTesting(false);
    }
  }

  return {
    webOn,
    setWebOn,
    webDirty,
    webError,
    webSaved,
    webTesting,
    webTestResult,
    saveWebAccess,
    testWebSearch,
    searchAgent,
    setSearchAgent,
    browseAgent,
    setBrowseAgent,
    resultPreviews,
    setResultPreviews,
  };
}
