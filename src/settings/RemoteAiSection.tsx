import type { IconComponent } from "./types";
import { CircleCheckIcon } from "../icons";

interface Props {
  closetUrl: string;
  setClosetUrl: (v: string) => void;
  saveOllamaUrl: () => void;
  closetSaved: boolean;
  testOllama: () => void;
  closetTesting: boolean;
  closetTestResult: string;
  AlertIcon: IconComponent;
}

export default function RemoteAiSection({
  closetUrl,
  setClosetUrl,
  saveOllamaUrl,
  closetSaved,
  testOllama,
  closetTesting,
  closetTestResult,
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
            {/* Filling this field ends the room's locality, which is the
                promise the whole product is built on — so the sentence that
                says so is a marked note at lead size, attached to the field
                that does it, rather than a 12px hint underneath it. */}
            <p className="set-note set-note--flag set-note--lead nb-sem-urgent">
              <AlertIcon size={16} className="warn-ic" /> Set this and the room
              is no longer local. Your questions, and the parts of your files
              the AI is given to read, travel over the network to that machine —
              the same as a cloud model, and the app labels the room that way.
              Cloud privacy applies here too: with the door on, protected
              details are replaced before anything is sent.
            </p>
            <div className="settings-actions">
              {/* "Saved" only ever meant the address LOOKED like an address.
                  This one goes and asks the machine. */}
              <button className="subtle" disabled={closetTesting} onClick={testOllama}>
                {closetTesting ? "Testing\u2026" : "Test connection"}
              </button>
              <button className="primary btn-ic" onClick={saveOllamaUrl}>
                {closetSaved ? (<><CircleCheckIcon size={13} /> Saved</>) : "Save"}
              </button>
            </div>
            {closetTestResult && (
              <p className="settings-hint">{closetTestResult}</p>
            )}
    </section>
  );
}
