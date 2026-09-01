import type { IconComponent } from "./types";
import { CircleCheckIcon } from "../icons";

interface Props {
  webOn: boolean;
  setWebOn: (v: boolean) => void;
  webTesting: boolean;
  testWebSearch: () => void;
  /** Rejects when nothing was stored, so the caller must swallow it — the
   *  panel's own error line is the report, not an unhandled rejection. */
  saveWebAccess: () => Promise<void>;
  webSaved: boolean;
  webDirty: boolean;
  webError: string;
  webTestResult: string;
  AlertIcon: IconComponent;
  searchAgent: boolean;
  setSearchAgent: (v: boolean) => void;
  browseAgent: boolean;
  setBrowseAgent: (v: boolean) => void;
  resultPreviews: boolean;
  setResultPreviews: (v: boolean) => void;
}

export default function OnlineSection({
  webOn,
  setWebOn,
  webTesting,
  testWebSearch,
  saveWebAccess,
  webSaved,
  webDirty,
  webError,
  webTestResult,
  AlertIcon,
  searchAgent,
  setSearchAgent,
  browseAgent,
  setBrowseAgent,
  resultPreviews,
  setResultPreviews,
}: Props) {
  return (
    <section id="set-online">
      <h3>Online features</h3>
      <OnlineAccessControls
        webOn={webOn}
        setWebOn={setWebOn}
        AlertIcon={AlertIcon}
        searchAgent={searchAgent}
        setSearchAgent={setSearchAgent}
        browseAgent={browseAgent}
        setBrowseAgent={setBrowseAgent}
        resultPreviews={resultPreviews}
        setResultPreviews={setResultPreviews}
      />
      <OnlineActions
        webTesting={webTesting}
        testWebSearch={testWebSearch}
        saveWebAccess={saveWebAccess}
        webSaved={webSaved}
      />
      <OnlineStatus
        webDirty={webDirty}
        webSaved={webSaved}
        webError={webError}
        webTestResult={webTestResult}
        AlertIcon={AlertIcon}
      />
    </section>
  );
}

function OnlineAccessControls({
  webOn,
  setWebOn,
  AlertIcon,
  searchAgent,
  setSearchAgent,
  browseAgent,
  setBrowseAgent,
  resultPreviews,
  setResultPreviews,
}: Pick<Props, "webOn" | "setWebOn" | "AlertIcon" | "searchAgent" | "setSearchAgent" | "browseAgent" | "setBrowseAgent" | "resultPreviews" | "setResultPreviews">) {
  return (
    <>
      <p className="settings-hint">This room's master internet switch. Off by default: while off, no online tool is even offered to the AI, the browser's address bar refuses to load anything, and spoken answers stay silent (the voice is an online service). Turn it on and you can then choose, below, which of the two online abilities the AI actually gets.</p>
      <p className="set-note set-note--flag set-note--lead nb-sem-urgent"><AlertIcon size={16} className="warn-ic" /> When on, search queries and fetched pages leave this Mac — and, while an answer is being read aloud, the sentence being spoken. Your files never do.</p>
      <label className="settings-label"><input type="checkbox" checked={webOn} onChange={(event) => setWebOn(event.target.checked)} /> Let this room reach the internet</label>
      <p className="settings-hint">One query goes out to several independent engines at once, so more than one provider sees what you searched for.</p>
      <details className="set-more"><summary>How search works</summary><p className="settings-hint">There is nothing to sign up for and no key to paste. Search is built in, and the engines' results are merged into a single ranking, so a blocked or rate-limited engine quietly drops out instead of breaking your search.</p></details>
      {webOn && <OnlineAgentOptions AlertIcon={AlertIcon} searchAgent={searchAgent} setSearchAgent={setSearchAgent} browseAgent={browseAgent} setBrowseAgent={setBrowseAgent} resultPreviews={resultPreviews} setResultPreviews={setResultPreviews} />}
    </>
  );
}

function OnlineAgentOptions({
  AlertIcon,
  searchAgent,
  setSearchAgent,
  browseAgent,
  setBrowseAgent,
  resultPreviews,
  setResultPreviews,
}: Pick<Props, "AlertIcon" | "searchAgent" | "setSearchAgent" | "browseAgent" | "setBrowseAgent" | "resultPreviews" | "setResultPreviews">) {
  return (
    <>
      <label className="settings-label">What the AI may do online</label>
      <p className="settings-hint">Two separate abilities under the switch above. Turn one off and the AI is not offered its tools at all — it can't use it by mistake, and it will say so rather than pretend.</p>
      <label className="settings-label"><input type="checkbox" checked={searchAgent} onChange={(event) => setSearchAgent(event.target.checked)} /> Search the web — look things up and read pages to answer questions (<code>web_search</code>, <code>fetch_page</code>)</label>
      <label className="settings-label"><input type="checkbox" checked={browseAgent} onChange={(event) => setBrowseAgent(event.target.checked)} /> Use the private browser — open a site and operate it: click, fill forms, sign in</label>
      <p className="settings-hint">With the browser on, asking the AI to “go to”, “visit”, “browse to” or “navigate to” somewhere always opens the page rather than searching for it.</p>
      <NoAgentWarning AlertIcon={AlertIcon} searchAgent={searchAgent} browseAgent={browseAgent} />
      <BrowserOwnership browseAgent={browseAgent} />
      <label className="settings-label">Search results</label>
      <label className="settings-label"><input type="checkbox" checked={resultPreviews} onChange={(event) => setResultPreviews(event.target.checked)} /> Show previews on the results page — read the top few result pages for their own picture and description</label>
      <p className="settings-hint">Arcelle reads those pages itself: no cookies, no scripts, no browser fingerprint. Turn it off and a search contacts only the search engines — the cards then show initials instead of pictures.</p>
    </>
  );
}

function NoAgentWarning({ AlertIcon, searchAgent, browseAgent }: Pick<Props, "AlertIcon" | "searchAgent" | "browseAgent">) {
  if (searchAgent || browseAgent) return null;
  return <p className="set-note set-note--flag nb-sem-pending"><AlertIcon size={16} className="warn-ic" /> Both are off, so the AI has no internet abilities in this room — the same as turning the switch above off. You can still use the Browser area yourself.</p>;
}

function BrowserOwnership({ browseAgent }: Pick<Props, "browseAgent">) {
  if (browseAgent) return null;
  return <p className="settings-hint">The <strong>Browser area stays yours</strong> — you can open it and type addresses as usual. This only stops the AI from driving it.</p>;
}

function OnlineActions({ webTesting, testWebSearch, saveWebAccess, webSaved }: Pick<Props, "webTesting" | "testWebSearch" | "saveWebAccess" | "webSaved">) {
  return <div className="settings-actions"><button className="subtle" disabled={webTesting} onClick={testWebSearch}>{webTesting ? "Testing…" : "Save & test search"}</button><button className="primary btn-ic" onClick={() => void saveWebAccess().catch(() => {})}>{webSaved ? <><CircleCheckIcon size={14} /> Saved</> : "Save"}</button></div>;
}

function OnlineStatus({ webDirty, webSaved, webError, webTestResult, AlertIcon }: Pick<Props, "webDirty" | "webSaved" | "webError" | "webTestResult" | "AlertIcon">) {
  return <><UnsavedWarning dirty={webDirty} saved={webSaved} /><ErrorWarning webError={webError} AlertIcon={AlertIcon} /><TestResult webTestResult={webTestResult} /></>;
}

function UnsavedWarning({ dirty, saved }: { dirty: boolean; saved: boolean }) {
  if (!dirty || saved) return null;
  return <p className="set-note set-note--flag nb-sem-pending" role="status"><span className="nb-tape set-note-tag">Not saved yet</span> — press Save, or these changes are discarded when you close Settings.</p>;
}

function ErrorWarning({ webError, AlertIcon }: Pick<Props, "webError" | "AlertIcon">) {
  if (!webError) return null;
  return <p className="set-note set-note--flag nb-sem-urgent" role="alert"><AlertIcon size={16} className="warn-ic" /> {webError}</p>;
}

function TestResult({ webTestResult }: Pick<Props, "webTestResult">) {
  if (!webTestResult) return null;
  return <p className="settings-hint">{webTestResult}</p>;
}
