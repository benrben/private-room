import { Props } from "./workspace/types";
import { useWorkspaceState } from "./workspace/state";
import { useWorkspaceActions } from "./workspace/actions";
import { useWorkspaceEffects } from "./workspace/effects";
import Overlays from "./workspace/Overlays";
import TopBar from "./workspace/TopBar";
import StudioModal from "./workspace/StudioModal";
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
export default function Workspace({ info, onLock }: Props) {
  const s = useWorkspaceState(info);
  const a = useWorkspaceActions(s, info, onLock);
  useWorkspaceEffects(s, a, info, onLock);

  return (
    <div className="workspace">
      <Overlays s={s} a={a} />
      <TopBar s={s} a={a} info={info} />

      <StudioModal s={s} a={a} />
      <AiActionModal s={s} a={a} />
      <FeedbackModal s={s} />
      <SettingsModals s={s} a={a} info={info} />

      <div className="body">
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
