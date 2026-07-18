import { useEffect, useState } from "react";
import { Props } from "./workspace/types";
import { useWorkspaceState } from "./workspace/state";
import { useWorkspaceActions } from "./workspace/actions";
import { useWorkspaceEffects } from "./workspace/effects";
import Overlays from "./workspace/Overlays";
import TopBar from "./workspace/TopBar";
import StudioModal from "./workspace/StudioModal";
import CompareModal from "./workspace/CompareModal";
import AiActionModal from "./workspace/AiActionModal";
import FeedbackModal from "./workspace/FeedbackModal";
import SettingsModals from "./workspace/SettingsModals";
import Sidebar from "./workspace/Sidebar";
import ViewerPane from "./workspace/ViewerPane";
import ChatPane from "./workspace/ChatPane";

/** The room workspace. A thin shell: it lifts all state into useWorkspaceState,
 * builds every handler (with the cross-hook wiring) in useWorkspaceActions, runs
 * the backend-event + orchestration effects in useWorkspaceEffects, and renders
 * the three panes plus the overlays/modals. All logic/JSX lives in ./workspace. */
/** Below this width the workspace + chat panes can't both be readable, so the
 * window shows one at a time behind a segmented control. */
const NARROW_QUERY = "(max-width: 1080px)";

export default function Workspace({ info, onLock }: Props) {
  const s = useWorkspaceState(info);
  const a = useWorkspaceActions(s, info, onLock);
  useWorkspaceEffects(s, a, info, onLock);

  // Narrow-window mode: one readable pane beats two clipped ones.
  const [isNarrow, setIsNarrow] = useState(() =>
    window.matchMedia(NARROW_QUERY).matches,
  );
  const [narrowPane, setNarrowPane] = useState<"workspace" | "chat">(
    "workspace",
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = () => setIsNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  // Opening a file is a clear "show me the document" — surface it.
  const openFileId = s.openFile?.id ?? null;
  useEffect(() => {
    if (openFileId) setNarrowPane("workspace");
  }, [openFileId]);

  return (
    <div className="workspace">
      <Overlays s={s} a={a} />
      <TopBar s={s} a={a} info={info} />

      <StudioModal s={s} a={a} />
      <CompareModal s={s} a={a} />
      <AiActionModal s={s} a={a} />
      <FeedbackModal s={s} />
      <SettingsModals s={s} a={a} info={info} />

      {isNarrow && (
        <div className="pane-switch" role="tablist" aria-label="Visible pane">
          <button
            role="tab"
            aria-selected={narrowPane === "workspace"}
            className={narrowPane === "workspace" ? "active" : ""}
            onClick={() => setNarrowPane("workspace")}
          >
            Workspace
          </button>
          <button
            role="tab"
            aria-selected={narrowPane === "chat"}
            className={narrowPane === "chat" ? "active" : ""}
            onClick={() => setNarrowPane("chat")}
          >
            Chat
          </button>
        </div>
      )}
      <div
        className={`body${isNarrow ? ` narrow show-${narrowPane}` : ""}`}
      >
        <Sidebar s={s} a={a} info={info} />
        <div
          className="pane-resizer"
          title="Drag to resize"
          onMouseDown={(e) => a.startPaneResize("sidebar", e)}
        />
        <ViewerPane s={s} a={a} info={info} />
        <div
          className="pane-resizer"
          title="Drag to resize"
          onMouseDown={(e) => a.startPaneResize("chat", e)}
        />
        <ChatPane s={s} a={a} info={info} />
      </div>
    </div>
  );
}
