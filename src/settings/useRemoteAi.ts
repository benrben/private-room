import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** THE CLOSET — point this Mac at a remote Ollama (get/set_ollama_url). */
export function useRemoteAi() {
  const [closetUrl, setClosetUrl] = useState("");
  const [closetSaved, setClosetSaved] = useState(false);

  useEffect(() => {
    // CONTRACT-NOTE: intended wrapper getOllamaUrl().
    invoke<string>("get_ollama_url")
      .then((v) => setClosetUrl(v ?? ""))
      .catch(() => {});
  }, []);

  // THE CLOSET — save the remote Ollama URL (blank = use this Mac).
  async function saveOllamaUrl() {
    // CONTRACT-NOTE: intended wrapper setOllamaUrl(url).
    await invoke("set_ollama_url", { url: closetUrl.trim() });
    setClosetSaved(true);
    window.setTimeout(() => setClosetSaved(false), 1600);
  }

  return { closetUrl, setClosetUrl, saveOllamaUrl, closetSaved };
}
