/** Stable workspace-service facade; implementation is layered by operation family. */
export {
  ContentConflictError,
  type WorkspaceDirectoryState,
  type WorkspaceVersionSnapshot,
} from "./workspaceServiceSupport.js";
export { WorkspaceService } from "./workspaceServiceReconcile.js";
