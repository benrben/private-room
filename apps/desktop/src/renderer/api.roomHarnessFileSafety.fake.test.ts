import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("./platform", () => bridge);

import { api } from "./api";

beforeEach(() => {
  bridge.invoke.mockReset().mockResolvedValue(undefined);
  bridge.listen.mockReset();
  bridge.open.mockReset();
  bridge.save.mockReset();
});

describe("room, harness, and file safety API IPC wrappers", () => {
  it("preserves fabricated room and sealed-package payload contracts", async () => {
    await Promise.all([
      api.createRoom("/fabricated/room", "password"),
      api.createRoom("/fabricated/sealed", "password", "Named room", "sealed-db"),
      api.convertLegacyRoom("/fabricated/legacy.roomai", "old-password", "/fabricated/converted"),
      api.createSealedPackage("/fabricated/backup"),
      api.createSealedPackage("/fabricated/export", "export-password", "share"),
      api.inspectSealedPackage("/fabricated/backup.arcelle", "export-password"),
      api.extractSealedFiles("/fabricated/backup.arcelle", "export-password", ["file-1"], "/fabricated/files"),
      api.importSealedPackage("/fabricated/backup.arcelle", "export-password", "/fabricated/restored"),
      api.openRoom("/fabricated/room", "password"),
      api.closeRoom(),
    ]);

    expect(bridge.invoke.mock.calls).toEqual([
      ["create_room", { path: "/fabricated/room", password: "password", name: null, format: "workspace-folder" }],
      ["create_room", { path: "/fabricated/sealed", password: "password", name: "Named room", format: "sealed-db" }],
      ["convert_legacy_room", { sourcePath: "/fabricated/legacy.roomai", password: "old-password", destinationPath: "/fabricated/converted" }],
      ["create_sealed_package", { destinationPath: "/fabricated/backup", exportPassword: null, purpose: "backup" }],
      ["create_sealed_package", { destinationPath: "/fabricated/export", exportPassword: "export-password", purpose: "share" }],
      ["inspect_sealed_package", { packagePath: "/fabricated/backup.arcelle", password: "export-password" }],
      ["extract_sealed_files", { packagePath: "/fabricated/backup.arcelle", password: "export-password", fileIds: ["file-1"], destinationPath: "/fabricated/files" }],
      ["import_sealed_package", { packagePath: "/fabricated/backup.arcelle", packagePassword: "export-password", destinationPath: "/fabricated/restored", workspacePassword: null }],
      ["open_room", { path: "/fabricated/room", password: "password" }],
      ["close_room"],
    ]);
  });

  it("preserves fabricated room-session, watcher, and harness commands", async () => {
    const request = {
      provider: "codex" as const,
      model: "fabricated-model",
      privacyMode: "local" as const,
      writeEnabled: false,
      text: "Inspect only fabricated files.",
      threadId: "thread-1",
      systemPrompt: "Use the test seam.",
    };
    await Promise.all([
      api.touchIdHas("/fabricated/room"), api.touchIdEnable(), api.touchIdDisable("/fabricated/room"), api.touchIdOpen("/fabricated/room"),
      api.roomInfo(), api.roomStorageUsage(), api.workspaceWatcherStatus(), api.rescanWorkspaceRoom(), api.setWorkspaceWatcherPolling(true),
      api.harnessCapabilities(), api.harnessListRuns(), api.harnessStart(request), api.harnessApprove("run-1", "request-1", "allow-run"),
      api.harnessCancel("run-1"), api.harnessCloudWriteback("run-1", true), api.harnessRollback("run-1"),
      api.harnessRestoreBaselineCopies("run-1", ["notes.md"]), api.renameRoom("Fabricated room"), api.registerWorkspaceCopy(),
      api.takePendingOpen(), api.takeRecRecoveryError(),
    ]);

    expect(bridge.invoke.mock.calls).toEqual([
      ["touchid_has", { path: "/fabricated/room" }], ["touchid_enable"], ["touchid_disable", { path: "/fabricated/room" }], ["touchid_open", { path: "/fabricated/room" }],
      ["room_info"], ["room_storage_usage"], ["workspace_watcher_status"], ["rescan_workspace_room"], ["set_workspace_watcher_polling", { enabled: true }],
      ["harness_capabilities", {}], ["harness_list_runs", {}], ["harness_start", request], ["harness_approve", { runId: "run-1", requestId: "request-1", decision: "allow-run" }],
      ["harness_cancel", { runId: "run-1" }], ["harness_cloud_writeback", { runId: "run-1", approved: true }], ["harness_rollback", { runId: "run-1" }],
      ["harness_restore_baseline_copies", { runId: "run-1", relativePaths: ["notes.md"] }], ["rename_room", { name: "Fabricated room" }], ["register_workspace_copy"],
      ["take_pending_open"], ["take_rec_recovery_error"],
    ]);
  });

  it("preserves fabricated file, media, and edit payloads including nullable options", async () => {
    await Promise.all([
      api.importFiles(["/fabricated/notes.md"]), api.listFiles(), api.getFileContent("file-1"), api.decodeFileText("file-1", null),
      api.audioPeaks("file-2"), api.audioPeaks("file-2", 32), api.probeVideoMeta("video-1"), api.videoTrim("video-1", 1.5, 8.25),
      api.saveVideoFrame("video-1", "ZmFrZQ==", 2.5), api.quicklookPreview("file-3"), api.slidePreview("slides-1", 4), api.officeHtml("legacy-1"),
      api.updateFileContent("file-1", "fabricated content"), api.updateDocxText("docx-1", "fabricated document"),
      api.setCell("sheet-1", null, "B2", "42"),
    ]);

    expect(bridge.invoke.mock.calls).toEqual([
      ["import_files", { paths: ["/fabricated/notes.md"] }], ["list_files"], ["get_file_content", { id: "file-1" }], ["decode_file_text", { id: "file-1", encoding: null }],
      ["audio_peaks", { id: "file-2", buckets: null }], ["audio_peaks", { id: "file-2", buckets: 32 }], ["probe_video_meta", { id: "video-1" }], ["video_trim", { id: "video-1", startSecs: 1.5, endSecs: 8.25 }],
      ["save_video_frame", { id: "video-1", pngB64: "ZmFrZQ==", atSecs: 2.5 }], ["quicklook_preview", { id: "file-3" }], ["slide_preview", { id: "slides-1", index: 4 }], ["office_html", { id: "legacy-1" }],
      ["update_file_content", { id: "file-1", content: "fabricated content" }], ["update_docx_text", { id: "docx-1", content: "fabricated document" }],
      ["set_cell", { id: "sheet-1", sheet: null, cell: "B2", value: "42" }],
    ]);
  });

  it("preserves fabricated trash, batch, version, and checkpoint operations", async () => {
    await Promise.all([
      api.trashFile("file-1"), api.listTrashedFiles(), api.restoreFile("file-1"), api.setFileInLibrary("file-1", true), api.deleteFilePermanently("file-1"), api.emptyTrash(),
      api.trashFiles(["file-2"]), api.moveFilesToFolder(["file-2"], null), api.restoreFiles(["file-2"]), api.deleteFilesPermanently(["file-2"]),
      api.listFileVersions("file-3"), api.getFileProvenance("file-3"), api.restoreFileVersion("version-1"), api.fileVersionsKept(), api.pinFileVersion("version-1", true), api.deleteFileVersion("version-1"), api.getFileVersion("version-1"),
      api.createRoomCheckpoint("Before changes"), api.listRoomCheckpoints(), api.deleteRoomCheckpoint("checkpoint-1"), api.rollbackRoomCheckpoint("checkpoint-1"), api.listStrandedCheckpoints(),
    ]);

    expect(bridge.invoke.mock.calls).toEqual([
      ["trash_file", { id: "file-1" }], ["list_trashed_files"], ["restore_file", { id: "file-1" }], ["set_file_in_library", { id: "file-1", linked: true }], ["delete_file_permanently", { id: "file-1" }], ["empty_trash"],
      ["trash_files", { ids: ["file-2"] }], ["move_files_to_folder", { fileIds: ["file-2"], folderId: null }], ["restore_files", { ids: ["file-2"] }], ["delete_files_permanently", { ids: ["file-2"] }],
      ["list_file_versions", { id: "file-3" }], ["get_file_provenance", { id: "file-3" }], ["restore_file_version", { versionId: "version-1" }], ["file_versions_kept"], ["pin_file_version", { versionId: "version-1", pinned: true }], ["delete_file_version", { versionId: "version-1" }], ["get_file_version", { versionId: "version-1" }],
      ["create_room_checkpoint", { name: "Before changes" }], ["list_room_checkpoints"], ["delete_room_checkpoint", { id: "checkpoint-1" }], ["rollback_room_checkpoint", { id: "checkpoint-1" }], ["list_stranded_checkpoints"],
    ]);
  });

  it("preserves fabricated export, recovery, recent-room, and preview operations", async () => {
    await Promise.all([
      api.exportFile("file-1", "/fabricated/export.md"), api.exportAll("/fabricated/export"), api.changePassword("old", "new"), api.duplicateRoom("/fabricated/copy", null),
      api.compactRoom(), api.listRecent(), api.removeRecent("/fabricated/old-room"), api.clearRecent(), api.trashRoom("/fabricated/room"),
      api.saveGeneratedFile("generated.md", "fabricated"), api.openHtmlInBrowser("preview.html", "<p>fabricated</p>"), api.stagePreviewHtml("<p>isolated</p>"),
    ]);

    expect(bridge.invoke.mock.calls).toEqual([
      ["export_file", { id: "file-1", destPath: "/fabricated/export.md" }], ["export_all", { destDir: "/fabricated/export" }], ["change_password", { current: "old", newPassword: "new" }], ["duplicate_room", { destPath: "/fabricated/copy", newPassword: null }],
      ["compact_room"], ["list_recent"], ["remove_recent", { path: "/fabricated/old-room" }], ["clear_recent"], ["trash_room", { path: "/fabricated/room" }],
      ["save_generated_file", { name: "generated.md", content: "fabricated" }], ["open_html_in_browser", { name: "preview.html", html: "<p>fabricated</p>" }], ["stage_preview_html", { html: "<p>isolated</p>" }],
    ]);
  });

  it("preserves fabricated memory, folder, search, and privacy operations", async () => {
    await Promise.all([
      api.addMemory("fabricated fact"), api.listMemories(), api.deleteMemory("memory-1"), api.updateMemory("memory-1", "revised", "project"), api.updateMemory("memory-2", "uncategorized"), api.openScratchPad(),
      api.listFolders(), api.createFolder("Research"), api.renameFolder("folder-1", "Archive"), api.deleteFolder("folder-1"), api.renameFile("file-1", "renamed.md"), api.moveFileToFolder("file-1", null),
      api.searchAll("fabricated query"), api.getSetting("theme"),
      api.privacyStatus(), api.setPrivacyRoom("on"), api.setPrivacyGlobal(true), api.addPrivacyBlock("Alice", "person"), api.removePrivacyEntity("privacy-1"), api.setPrivacyConcepts(["names", "places"]), api.privacyPreview("file-1"), api.startPrivacyScan(),
    ]);

    expect(bridge.invoke.mock.calls).toEqual([
      ["add_memory", { content: "fabricated fact", category: null }], ["list_memories"], ["delete_memory", { id: "memory-1" }], ["update_memory", { id: "memory-1", content: "revised", category: "project" }], ["update_memory", { id: "memory-2", content: "uncategorized", category: null }], ["open_scratch_pad"],
      ["list_folders"], ["create_folder", { name: "Research" }], ["rename_folder", { id: "folder-1", name: "Archive" }], ["delete_folder", { id: "folder-1" }], ["rename_file", { id: "file-1", name: "renamed.md" }], ["move_file_to_folder", { fileId: "file-1", folderId: null }],
      ["search_all", { query: "fabricated query" }], ["get_setting", { key: "theme" }],
      ["privacy_status"], ["set_privacy_room", { mode: "on" }], ["set_privacy_global", { on: true }], ["add_privacy_block", { text: "Alice", category: "person" }], ["remove_privacy_entity", { id: "privacy-1" }], ["set_privacy_concepts", { concepts: ["names", "places"] }], ["privacy_preview", { fileId: "file-1" }], ["start_privacy_scan"],
    ]);
  });

  it("preserves a fabricated IPC failure without changing its room-open request", async () => {
    const failure = new Error("fabricated room-open failure");
    bridge.invoke.mockRejectedValueOnce(failure);

    await expect(api.openRoom("/fabricated/unavailable", "password")).rejects.toBe(failure);

    expect(bridge.invoke).toHaveBeenCalledWith("open_room", { path: "/fabricated/unavailable", password: "password" });
  });
});
