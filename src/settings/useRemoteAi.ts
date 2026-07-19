import { useEffect, useState } from "react";
import { getOllamaUrl, setOllamaUrl } from "../api";

/** THE CLOSET — point this Mac at a remote Ollama (get/set_ollama_url). */
export function useRemoteAi() {
  const [closetUrl, setClosetUrl] = useState("");
  const [closetSaved, setClosetSaved] = useState(false);

  useEffect(() => {
    getOllamaUrl()
      .then((v) => setClosetUrl(v ?? ""))
      .catch(() => {});
  }, []);

  // THE CLOSET — save the remote Ollama URL (blank = use this Mac).
  async function saveOllamaUrl() {
    await setOllamaUrl(closetUrl.trim());
    setClosetSaved(true);
    window.setTimeout(() => setClosetSaved(false), 1600);
  }

  return { closetUrl, setClosetUrl, saveOllamaUrl, closetSaved };
}
