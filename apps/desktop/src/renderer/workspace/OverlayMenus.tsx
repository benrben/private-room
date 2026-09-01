import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { CheckIcon, CloseIcon, DownloadIcon, GlobeIcon, ScriptIcon, ShieldIcon } from "../icons";
import DiffPreview from "../viewers/DiffPreview";
import { languageForFile } from "../viewers/languages";
import type { WSActions } from "./actions";
import { ApproveCard, useMenuKeys } from "./Overlays";
import { SCRIPT_POWERS, SCRIPT_WORKSPACE_NOTE } from "./scriptTrust";
import type { WSState } from "./state";

export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url || "this page";
  }
}

export type McpApproval = WSState["mcpApprovals"][number];
export type BrowseApproval = WSState["browseConsents"][number];
export type EditApproval = WSState["editApprovals"][number];
export type ScriptApproval = WSState["scriptApprovals"][number];

export function ScriptApprovalDetails({ request }: { request: ScriptApproval }) {
  return (
    <>
      {request.deps.length > 0 && <ScriptApprovalLine label="Installs" values={request.deps} />}
      {request.inputs.length > 0 && <ScriptApprovalLine label="Reads" values={request.inputs} />}
      {request.outputs.length > 0 && <ScriptApprovalLine label="Writes back" values={request.outputs} />}
    </>
  );
}

export function ScriptApprovalLine({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="script-approve-line">
      <span className="script-approve-key">{label}</span>
      <pre className="approve-args">{values.join(", ")}</pre>
    </div>
  );
}

export function ScriptApprovalCard({ request, a }: { request: ScriptApproval | undefined; a: WSActions }) {
  if (!request) return null;
  return (
    <ApproveCard
      key={request.id}
      label="Run a script from this room?"
      onDecline={() => a.resolveScriptApproval(request, "deny")}
    >
      <div className="approve-kind">
        <span className="nb-cat nb-sem-pending">Permission</span>
      </div>
      <div className="approve-title">
        <ScriptIcon size={16} /> Run a script from this room?
      </div>
      <p className="approve-body">
        <strong>{request.name}</strong> is a real program: <strong>{SCRIPT_POWERS}</strong>{" "}
        {SCRIPT_WORKSPACE_NOTE}
      </p>
      <pre className="approve-args">{request.interpreterLine}</pre>
      <ScriptApprovalDetails request={request} />
      <p className="approve-body caption">
        <strong>Allow once</strong> runs it this one time and keeps it marked “Needs review”.
        <br />
        <strong>Always allow this exact script</strong> approves this version — it stops asking
        and can be scheduled. Any edit to the script asks again.
      </p>
      <div className="approve-actions">
        <button className="primary" onClick={() => a.resolveScriptApproval(request, "once")}>
          Allow once
        </button>
        <button onClick={() => a.resolveScriptApproval(request, "always")}>
          Always allow this exact script
        </button>
        <button className="danger" onClick={() => a.resolveScriptApproval(request, "deny")}>
          Don't run
        </button>
      </div>
    </ApproveCard>
  );
}

export function McpDeleteApprovalCard({ request, a }: { request: McpApproval | undefined; a: WSActions }) {
  if (!request?.confirm) return null;
  return (
    <ApproveCard
      key={request.id}
      label={`Delete the ${request.tool} “${request.server}”?`}
      onDecline={() => a.resolveMcpApproval(request, "deny")}
    >
      <div className="approve-kind">
        <span className="nb-cat nb-sem-urgent">Deletion</span>
      </div>
      <div className="approve-title">
        <ShieldIcon size={16} /> Delete the {request.tool} &ldquo;{request.server}&rdquo;?
      </div>
      <p className="approve-body">The AI asked to delete this {request.tool}. {request.confirm}</p>
      <div className="approve-actions">
        <button className="danger" onClick={() => a.resolveMcpApproval(request, "once")}>
          Delete it
        </button>
        <button className="primary" onClick={() => a.resolveMcpApproval(request, "deny")}>
          Keep it
        </button>
      </div>
    </ApproveCard>
  );
}

export function McpToolArgs({ request }: { request: McpApproval }) {
  if (!request.args || request.args === "{}") return null;
  return <pre className="approve-args">{request.args}</pre>;
}

export function McpToolApprovalCard({ request, a }: { request: McpApproval | undefined; a: WSActions }) {
  if (!request || request.confirm) return null;
  return (
    <ApproveCard
      key={request.id}
      label="Allow a connected tool to run?"
      onDecline={() => a.resolveMcpApproval(request, "deny")}
    >
      <div className="approve-kind">
        <span className="nb-cat nb-sem-pending">Permission</span>
      </div>
      <div className="approve-title">
        <GlobeIcon size={16} /> Allow a connected tool to run?
      </div>
      <p className="approve-body">
        The AI wants to use <strong>{request.tool}</strong> from the <strong>{request.server}</strong>{" "}
        connector. This is a separate program that can reach the internet — what the AI sends
        it leaves this room.
      </p>
      <McpToolArgs request={request} />
      <div className="approve-actions">
        <button className="primary" onClick={() => a.resolveMcpApproval(request, "once")}>
          Allow once
        </button>
        <button onClick={() => a.resolveMcpApproval(request, "always")}>
          Always allow this connector
        </button>
        <button className="danger" onClick={() => a.resolveMcpApproval(request, "deny")}>
          Don't allow
        </button>
      </div>
    </ApproveCard>
  );
}

export function BrowseRecognised({ request }: { request: BrowseApproval }) {
  if (request.entities.length === 0) return null;
  return <p className="approve-body">Recognised: {request.entities.join(", ")}</p>;
}

export function BrowseApprovalCard({ request, a }: { request: BrowseApproval | undefined; a: WSActions }) {
  if (!request) return null;
  const privacyNote = request.entities.length > 0
    ? "It matches information you asked to keep private."
    : "This room has no list of protected details, so Arcelle cannot check it against one.";
  return (
    <ApproveCard
      key={request.id}
      label="Type this into the page?"
      onDecline={() => a.resolveBrowseConsent(request, false)}
    >
      <div className="approve-kind">
        <span className="nb-cat nb-sem-urgent">Leaves this room</span>
      </div>
      <div className="approve-title">
        <ShieldIcon size={16} /> Type this into the page?
      </div>
      <p className="approve-body">
        The assistant wants to type this into <strong>{request.field}</strong> on{" "}
        <strong>{hostOf(request.url)}</strong>. {privacyNote} Once it is typed, that site has it.
      </p>
      <pre className="approve-args">{request.text}</pre>
      <BrowseRecognised request={request} />
      <div className="approve-actions">
        <button className="primary" onClick={() => a.resolveBrowseConsent(request, true)}>
          Type it
        </button>
        <button className="danger" onClick={() => a.resolveBrowseConsent(request, false)}>
          Don't
        </button>
      </div>
    </ApproveCard>
  );
}

export function EditApprovalTitle({ request }: { request: EditApproval }) {
  const multiple = request.files.length > 1;
  const subject = multiple ? <strong>{request.files.length} files</strong> : <em>{request.files[0].name}</em>;
  return <div className="approve-title">Apply {multiple ? "these changes" : "this change"} to {subject}?</div>;
}

export function EditQueueNotice({ count }: { count: number }) {
  if (count < 2) return null;
  const waiting = count - 1;
  return (
    <p className="approve-body">
      {waiting} more change{count > 2 ? "s are" : " is"} waiting behind this one. Each is
      asked in turn, and declines itself three minutes after it was raised.
    </p>
  );
}

export function EditDiffs({ request }: { request: EditApproval }) {
  const multiple = request.files.length > 1;
  return (
    <div className="approve-diffs">
      {request.files.slice(0, 5).map((file, index) => (
        <div className="approve-diff-file" key={`${file.name}-${index}`}>
          {multiple && <div className="approve-diff-name">{file.name}</div>}
          <DiffPreview
            before={file.before}
            after={file.after}
            clipped={file.clipped}
            language={languageForFile(file.name)}
          />
        </div>
      ))}
      {request.files.length > 5 && (
        <div className="approve-diff-more">…and {request.files.length - 5} more file(s) in this change.</div>
      )}
    </div>
  );
}

export function EditApprovalActions({ request, a }: { request: EditApproval; a: WSActions }) {
  return (
    <div className="approve-actions">
      <button className="primary" onClick={() => a.resolveEditApproval(request, "once")}>Apply</button>
      {request.allowTurn && (
        <button onClick={() => a.resolveEditApproval(request, "turn")}>
          Apply for the rest of this answer
        </button>
      )}
      <button onClick={() => void a.alwaysAllowEdits(request)}>Always allow in this room</button>
      <button className="danger" onClick={() => a.resolveEditApproval(request, "deny")}>Don't apply</button>
    </div>
  );
}

export function EditApprovalCard({ request, count, a }: { request: EditApproval | undefined; count: number; a: WSActions }) {
  if (!request) return null;
  return (
    <ApproveCard
      key={request.id}
      wide
      label="Apply this change?"
      onDecline={() => a.resolveEditApproval(request, "deny")}
    >
      <div className="approve-kind"><span className="nb-cat nb-sem-pending">File change</span></div>
      <EditApprovalTitle request={request} />
      <EditQueueNotice count={count} />
      <EditDiffs request={request} />
      <EditApprovalActions request={request} a={a} />
    </ApproveCard>
  );
}

export function ApprovalOverlays({ s, a }: { s: WSState; a: WSActions }) {
  const mcp = s.mcpApprovals[0];
  return (
    <>
      <ScriptApprovalCard request={s.scriptApprovals[0]} a={a} />
      <McpDeleteApprovalCard request={mcp} a={a} />
      <McpToolApprovalCard request={mcp} a={a} />
      <BrowseApprovalCard request={s.browseConsents[0]} a={a} />
      <EditApprovalCard request={s.editApprovals[0]} count={s.editApprovals.length} a={a} />
    </>
  );
}

export type ContextMenu = NonNullable<WSState["ctxMenu"]>;
export type MoveMenu = NonNullable<WSState["moveMenuFor"]>;

export function contextMoveLabel(count: number) {
  return count > 1 ? `Move ${count} files to…` : "Move to…";
}

export function contextExportLabel(count: number) {
  return count > 1 ? `Export ${count} copies…` : "Export a copy…";
}

export function exportContextFiles(files: ContextMenu["files"], a: WSActions) {
  if (files.length > 1) {
    void a.exportFiles(files);
    return;
  }
  a.exportOne(files[0].id, files[0].name);
}

export function removeContextFiles(ids: string[], a: WSActions) {
  if (ids.length > 1) {
    void a.removeFiles(ids);
    return;
  }
  void a.removeFile(ids[0]);
}

export function ContextSelectionHeading({ count }: { count: number }) {
  if (count < 2) return null;
  return (
    <div className="ctx-heading">
      <span className="nb-cat nb-sem-linked">{count} files selected</span>
    </div>
  );
}

export function ContextSingleActions({ menu, s, a }: { menu: ContextMenu; s: WSState; a: WSActions }) {
  if (menu.files.length !== 1) return null;
  const file = menu.file;
  const attached = s.attachments.some((item) => item.id === file.id);
  return (
    <>
      <button role="menuitem" tabIndex={-1} className="ctx-item" onClick={() => { a.viewFile(file.id); s.setCtxMenu(null); }}>
        Open
      </button>
      <button role="menuitem" tabIndex={-1} className="ctx-item" onClick={() => { a.toggleAttach(file); s.setCtxMenu(null); }}>
        {attached ? "Detach from chat" : "Attach to chat"}
      </button>
      <button role="menuitem" tabIndex={-1} className="ctx-item" onClick={() => { s.setRenamingFile({ id: file.id, name: file.name, where: "library" }); s.setCtxMenu(null); }}>
        Rename…
      </button>
    </>
  );
}

export function ContextMultiAttachment({ menu, s, a }: { menu: ContextMenu; s: WSState; a: WSActions }) {
  if (menu.files.length < 2) return null;
  return (
    <button role="menuitem" tabIndex={-1} className="ctx-item" onClick={() => { a.attachFiles(menu.files); s.setCtxMenu(null); }}>
      Attach {menu.files.length} to chat
    </button>
  );
}

export function ContextMoveAndExport({ menu, s, a }: { menu: ContextMenu; s: WSState; a: WSActions }) {
  const files = menu.files;
  const closeMenu = () => s.setCtxMenu(null);
  const openMove = () => {
    s.setMoveMenuFor({ ids: files.map((file) => file.id), x: menu.x, y: menu.y });
    closeMenu();
  };
  const exportFiles = () => {
    closeMenu();
    exportContextFiles(files, a);
  };
  return (
    <>
      <button role="menuitem" tabIndex={-1} className="ctx-item" onClick={openMove}>
        {contextMoveLabel(files.length)}
      </button>
      <button role="menuitem" tabIndex={-1} className="ctx-item" onClick={exportFiles}>
        {contextExportLabel(files.length)}
      </button>
    </>
  );
}

export function ContextAiActions({ menu, s, a }: { menu: ContextMenu; s: WSState; a: WSActions }) {
  const actions = (s.aiActionDefs ?? []).filter((action) => action.scope === "file");
  if (actions.length === 0) return null;
  const scope = menu.files.length > 1 ? `these ${menu.files.length} files` : "this file";
  return (
    <>
      <div className="ctx-sep nb-rule" />
      <div className="ctx-heading"><span className="nb-cat nb-sem-saved">AI actions · {scope}</span></div>
      {actions.map((action) => (
        <button
          key={action.id}
          role="menuitem"
          tabIndex={-1}
          className="ctx-item"
          title={action.description}
          onClick={() => {
            s.setCtxMenu(null);
            a.openAiAction(action, null, menu.files.map((file) => file.id));
          }}
        >
          {action.title}
        </button>
      ))}
    </>
  );
}

export function ContextDeleteConfirm({ menu, s, a }: { menu: ContextMenu; s: WSState; a: WSActions }) {
  const remove = () => {
    const ids = menu.files.map((file) => file.id);
    a.cancelConfirm();
    s.setCtxMenu(null);
    removeContextFiles(ids, a);
  };
  const question = menu.files.length > 1 ? `Move ${menu.files.length} files to the trash?` : "Move to the trash?";
  return (
    <div className="ctx-confirm" data-agent-blocked>
      <span className="ctx-confirm-q">{question}</span>
      <button role="menuitem" tabIndex={-1} className="ctx-item danger btn-ic" onClick={remove}>
        <CheckIcon size={14} /> Move to trash
      </button>
      <button role="menuitem" tabIndex={-1} className="ctx-item btn-ic" onClick={a.cancelConfirm}>
        <CloseIcon size={14} /> Keep
      </button>
    </div>
  );
}

export function ContextDeletePrompt({ menu, a }: { menu: ContextMenu; a: WSActions }) {
  const label = menu.files.length > 1 ? `Remove ${menu.files.length} files from room` : "Remove from room";
  return (
    <button
      role="menuitem"
      tabIndex={-1}
      className="ctx-item danger"
      onClick={() => a.askConfirm(`ctx-remove-${menu.file.id}`)}
    >
      {label}
    </button>
  );
}

export function ContextRemove({ menu, s, a }: { menu: ContextMenu; s: WSState; a: WSActions }) {
  const confirmed = s.confirmDelete === `ctx-remove-${menu.file.id}`;
  if (confirmed) return <ContextDeleteConfirm menu={menu} s={s} a={a} />;
  return <ContextDeletePrompt menu={menu} a={a} />;
}

export function FileContextMenu({ menu, s, a, onKeyDown }: { menu: ContextMenu; s: WSState; a: WSActions; onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void }) {
  return (
    <div
      ref={s.ctxMenuElRef}
      className="ctx-menu"
      role="menu"
      aria-label={`Actions for ${menu.file.name}`}
      onKeyDown={onKeyDown}
      style={{ top: menu.y, left: menu.x }}
    >
      <ContextSelectionHeading count={menu.files.length} />
      <ContextSingleActions menu={menu} s={s} a={a} />
      <ContextMultiAttachment menu={menu} s={s} a={a} />
      <ContextMoveAndExport menu={menu} s={s} a={a} />
      <ContextAiActions menu={menu} s={s} a={a} />
      <div className="ctx-sep nb-rule" />
      <ContextRemove menu={menu} s={s} a={a} />
    </div>
  );
}

export function closeContextMenu(event: React.MouseEvent<HTMLDivElement>, s: WSState) {
  event.preventDefault();
  s.setCtxMenu(null);
}

export function ContextMenuOverlay({ s, a }: { s: WSState; a: WSActions }) {
  const keys = useMenuKeys(s.ctxMenu !== null, () => s.setCtxMenu(null), s.ctxMenuElRef, s.confirmDelete);
  const menu = s.ctxMenu;
  if (!menu) return null;
  return (
    <>
      <div className="ctx-backdrop" onMouseDown={() => s.setCtxMenu(null)} onContextMenu={(event) => closeContextMenu(event, s)} />
      <FileContextMenu menu={menu} s={s} a={a} onKeyDown={keys.onKeyDown} />
    </>
  );
}

export function movingFiles(s: WSState, ids: string[]) {
  return s.files.filter((file) => ids.includes(file.id));
}

export function isAlreadyInFolder(files: WSState["files"], folderId: string | null) {
  return files.length > 0 && files.every((file) => (file.folderId ?? null) === folderId);
}

export function MoveDestinationRows({ menu, s, a }: { menu: MoveMenu; s: WSState; a: WSActions }) {
  const files = movingFiles(s, menu.ids);
  const move = (folderId: string | null) => void a.moveFiles(menu.ids, folderId);
  return (
    <>
      <button role="menuitem" tabIndex={-1} className="ctx-item" disabled={isAlreadyInFolder(files, null)} onClick={() => move(null)}>
        No folder
      </button>
      {s.folders.map((folder) => (
        <button key={folder.id} role="menuitem" tabIndex={-1} className="ctx-item" disabled={isAlreadyInFolder(files, folder.id)} onClick={() => move(folder.id)}>
          {folder.name}
        </button>
      ))}
      {s.folders.length === 0 && (
        <div className="ctx-empty">No folders yet — make one from &ldquo;Add page or source&rdquo; in the Library.</div>
      )}
    </>
  );
}

export function MoveMenuOverlay({ s, a }: { s: WSState; a: WSActions }) {
  const keys = useMenuKeys(s.moveMenuFor !== null, () => s.setMoveMenuFor(null), s.moveMenuElRef);
  const menu = s.moveMenuFor;
  if (!menu) return null;
  const label = menu.ids.length > 1 ? `Move ${menu.ids.length} files to…` : "Move to…";
  return (
    <>
      <div className="ctx-backdrop" onMouseDown={() => s.setMoveMenuFor(null)} onContextMenu={(event) => { event.preventDefault(); s.setMoveMenuFor(null); }} />
      <div ref={s.moveMenuElRef} className="ctx-menu" role="menu" aria-label="Move to a folder" onKeyDown={keys.onKeyDown} style={{ top: menu.y, left: menu.x }}>
        <div className="ctx-heading"><span className="nb-cat nb-sem-linked">{label}</span></div>
        <MoveDestinationRows menu={menu} s={s} a={a} />
      </div>
    </>
  );
}

export function DragOverlay({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div className="drop-overlay">
      <div className="drop-overlay-inner"><DownloadIcon size={28} /><span>Drop to add to this room</span></div>
    </div>
  );
}
