import { useEffect, useState } from "react";
import { getOllamaUrl, setOllamaUrl, testOllamaUrl } from "../api";

/** One address, as the room writes it down: `set_ollama_url` supplies a missing
 * `http://`, lower-cases the scheme and drops trailing slashes before storing.
 * So `192.168.1.20:11434` typed and `http://192.168.1.20:11434` held are the
 * same address without being the same string — compared literally, the field
 * reads "Unsaved" over a write that already happened, and a failed test cannot
 * tell the user their address was kept. Only the three rewrites the backend
 * performs are forgiven; `https://` against a stored `http://` still differs. */
function sameAddress(a: string, b: string): boolean {
  const asStored = (s: string) => {
    const t = s.trim().replace(/\/+$/, "");
    const m = /^(https?):\/\/(.*)$/i.exec(t);
    if (m) return `${m[1].toLowerCase()}://${m[2]}`;
    return t ? `http://${t}` : "";
  };
  return asStored(a) === asStored(b);
}

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
      // The backend writes the address BEFORE it reaches for the machine, so an
      // unreachable one is still the address this room now points at. Ask what
      // it actually holds rather than assuming: assuming "not saved" left the
      // Connections page flying "Unsaved" over a write that happened, and
      // offering to discard something no longer discardable. A shape-rejected
      // address never reached the DB, and this same question says so.
      const held = await getOllamaUrl().catch(() => storedUrl);
      setStoredUrl(held);
      setClosetTestResult(
        held.trim() !== "" && sameAddress(held, closetUrl)
          ? `\u2717 ${String(e)} \u2014 the address was saved anyway. Clear the field and press Save to come back to this Mac.`
          : `\u2717 ${String(e)}`,
      );
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
    closetDirty: !sameAddress(closetUrl, storedUrl),
  };
}
