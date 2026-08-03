import { useEffect, useState } from "react";
import { getOllamaUrl, setOllamaUrl, testOllamaUrl } from "../api";

/** THE CLOSET — point this Mac at a remote Ollama (get/set_ollama_url). */
export function useRemoteAi() {
  const [closetUrl, setClosetUrl] = useState("");
  // The address the room actually holds, so a typed-but-unsaved one can be
  // spotted before Settings closes and drops it.
  const [storedUrl, setStoredUrl] = useState("");
  const [closetSaved, setClosetSaved] = useState(false);
  const [closetTesting, setClosetTesting] = useState(false);
  const [closetTestResult, setClosetTestResult] = useState("");

  useEffect(() => {
    getOllamaUrl()
      .then((v) => {
        setClosetUrl(v ?? "");
        setStoredUrl(v ?? "");
      })
      .catch(() => {});
  }, []);

  // THE CLOSET — save the remote Ollama URL (blank = use this Mac).
  // A failure here used to be indistinguishable from a click that did nothing:
  // no tick, no error, and the room quietly kept the old address.
  async function saveOllamaUrl() {
    try {
      await setOllamaUrl(closetUrl.trim());
    } catch (e) {
      setClosetTestResult(`✗ Couldn't save: ${String(e)}`);
      return;
    }
    setStoredUrl(closetUrl.trim());
    setClosetSaved(true);
    window.setTimeout(() => setClosetSaved(false), 1600);
  }

  /** Saves first (so what is tested is what is active), then actually reaches
   *  for the machine. Nothing here invents a verdict: the sentence shown is the
   *  backend's own answer, error included. */
  async function testOllama() {
    setClosetTesting(true);
    setClosetTestResult("");
    try {
      setClosetTestResult(await testOllamaUrl(closetUrl.trim()));
      setStoredUrl(closetUrl.trim());
      setClosetSaved(true);
      window.setTimeout(() => setClosetSaved(false), 1600);
    } catch (e) {
      setClosetTestResult(`\u2717 ${String(e)}`);
    } finally {
      setClosetTesting(false);
    }
  }

  return {
    closetUrl,
    setClosetUrl,
    saveOllamaUrl,
    closetSaved,
    testOllama,
    closetTesting,
    closetTestResult,
    /** A remote-AI address typed but not saved. */
    closetDirty: closetUrl.trim() !== storedUrl.trim(),
  };
}
