import type { IconComponent } from "./types";
import { CircleCheckIcon } from "../icons";

interface Props {
  closetUrl: string;
  setClosetUrl: (v: string) => void;
  saveOllamaUrl: () => void;
  closetSaved: boolean;
  AlertIcon: IconComponent;
}

export default function RemoteAiSection({
  closetUrl,
  setClosetUrl,
  saveOllamaUrl,
  closetSaved,
  AlertIcon,
}: Props) {
  return (
    // THE CLOSET — borrow a stronger machine on your network.
    <section id="set-closet">
      <h3>Remote AI</h3>
            <p className="settings-hint">
              Point this Mac at another machine running Ollama on your network.
              Leave blank to use this Mac.
            </p>
            <label className="settings-label">Remote Ollama URL</label>
            <input
              placeholder="http://192.168.1.20:11434 — leave blank to use this Mac"
              value={closetUrl}
              onChange={(e) => setClosetUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveOllamaUrl()}
            />
            <p className="settings-hint">
              <AlertIcon size={13} className="warn-ic" /> Answers then travel
              over your local network to that machine and back. Your files still
              never leave this Mac.
            </p>
            <div className="settings-actions">
              <button className="primary btn-ic" onClick={saveOllamaUrl}>
                {closetSaved ? (<><CircleCheckIcon size={13} /> Saved</>) : "Save"}
              </button>
            </div>
    </section>
  );
}
