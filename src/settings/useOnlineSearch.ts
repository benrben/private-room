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

  useEffect(() => {
    // Any non-empty value that isn't "off" is ON — which is exactly what the
    // retired provider names ("duckduckgo", "searxng", "brave") meant, so a room
    // saved before the switch existed keeps its internet access.
    api.getSetting("web_provider").then((v) => setWebOn(!!v && v !== "off"));
    api.getSetting("web_agent_search").then((v) => setSearchAgent(v !== "off"));
    api.getSetting("web_agent_browse").then((v) => setBrowseAgent(v !== "off"));
  }, []);

  async function saveWebAccess() {
    await api.setSetting("web_provider", webOn ? "on" : "off");
    await api.setSetting("web_agent_search", searchAgent ? "on" : "off");
    await api.setSetting("web_agent_browse", browseAgent ? "on" : "off");
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
    webSaved,
    webTesting,
    webTestResult,
    saveWebAccess,
    testWebSearch,
    searchAgent,
    setSearchAgent,
    browseAgent,
    setBrowseAgent,
  };
}
