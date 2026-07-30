import type { IconComponent } from "./types";
import { CircleCheckIcon } from "../icons";

interface Props {
  webOn: boolean;
  setWebOn: (v: boolean) => void;
  webTesting: boolean;
  testWebSearch: () => void;
  saveWebAccess: () => void;
  webSaved: boolean;
  webTestResult: string;
  AlertIcon: IconComponent;
  searchAgent: boolean;
  setSearchAgent: (v: boolean) => void;
  browseAgent: boolean;
  setBrowseAgent: (v: boolean) => void;
}

export default function OnlineSection({
  webOn,
  setWebOn,
  webTesting,
  testWebSearch,
  saveWebAccess,
  webSaved,
  webTestResult,
  AlertIcon,
  searchAgent,
  setSearchAgent,
  browseAgent,
  setBrowseAgent,
}: Props) {
  return (
    <section id="set-online">
      <h3>Online features</h3>
            <p className="settings-hint">
              This room's master internet switch. Off by default: while off, no
              online tool is even offered to the AI, and the browser's address
              bar refuses to load anything. Turn it on and you can then choose,
              below, which of the two online abilities the AI actually gets.
            </p>
            <p className="settings-hint">
              <AlertIcon size={13} className="warn-ic" /> When on, search queries and fetched pages leave this Mac.
              Your files never do.
            </p>
            <label className="settings-label">
              <input
                type="checkbox"
                checked={webOn}
                onChange={(e) => setWebOn(e.target.checked)}
              />{" "}
              Let this room reach the internet
            </label>
            <p className="settings-hint">
              There is nothing to sign up for and no key to paste. Search is
              built in: one query goes out to several independent engines at
              once and the results are merged into a single ranking, so a
              blocked or rate-limited engine quietly drops out instead of
              breaking your search.
            </p>
            {webOn && (
              <>
                <label className="settings-label">What the AI may do online</label>
                <p className="settings-hint">
                  Two separate abilities under the switch above. Turn one off and
                  the AI is not offered its tools at all — it can't use it by
                  mistake, and it will say so rather than pretend.
                </p>
                <label className="settings-label">
                  <input
                    type="checkbox"
                    checked={searchAgent}
                    onChange={(e) => setSearchAgent(e.target.checked)}
                  />{" "}
                  Search the web — look things up and read pages to answer
                  questions (<code>web_search</code>, <code>fetch_page</code>)
                </label>
                <label className="settings-label">
                  <input
                    type="checkbox"
                    checked={browseAgent}
                    onChange={(e) => setBrowseAgent(e.target.checked)}
                  />{" "}
                  Use the private browser — open a site and operate it: click,
                  fill forms, sign in
                </label>
                <p className="settings-hint">
                  With the browser on, asking the AI to “go to”, “visit”,
                  “browse to” or “navigate to” somewhere always opens the page
                  rather than searching for it.
                </p>
                {!searchAgent && !browseAgent && (
                  <p className="settings-hint">
                    <AlertIcon size={13} className="warn-ic" /> Both are off, so
                    the AI has no internet abilities in this room — the same as
                    turning the switch above off. You can still use the Browser
                    area yourself.
                  </p>
                )}
                {!browseAgent && (
                  <p className="settings-hint">
                    The <strong>Browser area stays yours</strong> — you can open
                    it and type addresses as usual. This only stops the AI from
                    driving it.
                  </p>
                )}
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
              <button className="primary btn-ic" onClick={saveWebAccess}>
                {webSaved ? (<><CircleCheckIcon size={13} /> Saved</>) : "Save"}
              </button>
            </div>
            {webTestResult && (
              <p className="settings-hint">{webTestResult}</p>
            )}
    </section>
  );
}
