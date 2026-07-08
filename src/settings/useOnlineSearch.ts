import { useEffect, useState } from "react";
import { api } from "../api";

/** Online section: web-search provider + endpoint, save, and a real one-shot
 * test through the backend (the model is not involved). */
export function useOnlineSearch() {
  const [webProvider, setWebProvider] = useState("off");
  const [webEndpoint, setWebEndpoint] = useState("");
  const [webSaved, setWebSaved] = useState(false);
  const [webTesting, setWebTesting] = useState(false);
  const [webTestResult, setWebTestResult] = useState("");

  useEffect(() => {
    api.getSetting("web_provider").then((v) => {
      // "brave" was removed (needed an API key); those rooms now run on the
      // free DuckDuckGo provider.
      setWebProvider(v === "brave" ? "duckduckgo" : v || "off");
    });
    api.getSetting("web_endpoint").then((v) => setWebEndpoint(v || ""));
  }, []);

  async function saveWebAccess() {
    await api.setSetting("web_provider", webProvider);
    await api.setSetting("web_endpoint", webEndpoint.trim());
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
    webProvider,
    setWebProvider,
    webEndpoint,
    setWebEndpoint,
    webSaved,
    webTesting,
    webTestResult,
    saveWebAccess,
    testWebSearch,
  };
}
