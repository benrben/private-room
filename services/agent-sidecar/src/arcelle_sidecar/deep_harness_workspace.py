"""Authenticated workspace adapters used by the Deep Harness."""

from __future__ import annotations

import json
import posixpath
from dataclasses import dataclass
from typing import Any, Protocol

from deepagents.backends import BackendProtocol, StateBackend
from deepagents.backends.protocol import (
    DeleteResult,
    EditResult,
    GlobResult,
    GrepResult,
    LsResult,
    ReadResult,
    WriteResult,
)
from langchain_core.tools import BaseTool, StructuredTool

from .mcp_client import McpClient

SAFE_WORKSPACE_FAILURE = (
    "Workspace operation failed. Raw diagnostics were omitted to protect room data."
)


class WorkspaceBridge(Protocol):
    async def call(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]: ...


@dataclass(slots=True)
class McpWorkspaceBridge:
    """Language-neutral workspace protocol carried over Arcelle MCP tools."""

    mcp: McpClient

    async def call(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
        result = await self.mcp.call_tool(f"workspace_{operation}", arguments)
        if result.is_error:
            return {"error": SAFE_WORKSPACE_FAILURE}
        try:
            payload = json.loads(result.text)
        except json.JSONDecodeError:
            return {"error": "The workspace bridge returned an invalid response."}
        return payload if isinstance(payload, dict) else {"error": "Invalid workspace response."}


def _safe_virtual_path(value: str) -> str:
    parts = _virtual_path_parts(value)
    _reject_unsafe_virtual_path(parts)
    return "/" + "/".join(parts)


def _virtual_path_parts(value: str) -> list[str]:
    return [part for part in value.replace("\\", "/").split("/") if part not in ("", ".")]


def _reject_unsafe_virtual_path(parts: list[str]) -> None:
    if ".." in parts:
        raise ValueError("Workspace paths cannot leave the room.")
    if _is_private_virtual_path(parts):
        raise ValueError("The .arcelle directory is private.")


def _is_private_virtual_path(parts: list[str]) -> bool:
    return bool(parts) and parts[0].casefold() == ".arcelle"


def _rename_source_or_error(file_path: str) -> tuple[str | None, str | None]:
    try:
        return _safe_virtual_path(file_path), None
    except ValueError as exc:
        return None, str(exc)


def _safe_rename_name(new_name: str) -> str | None:
    requested = new_name.strip()
    if _is_unsafe_rename_name(requested):
        return None
    return requested


def _is_unsafe_rename_name(name: str) -> bool:
    return name in {"", ".", ".."} or "/" in name or "\\" in name or name.casefold() == ".arcelle"


class ArcelleWorkspaceBackend(BackendProtocol):
    """Deep Agents filesystem backend that delegates every byte to Electron."""

    def __init__(self, bridge: WorkspaceBridge, *, write_enabled: bool, cancel: Any = None) -> None:
        self.bridge = bridge
        self.write_enabled = write_enabled
        self.cancel = cancel
        self._mutations: dict[str, dict[str, Any]] = {}

    async def _call(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if self.cancel is not None and self.cancel.cancelled:
            return {"error": "This run was cancelled."}
        try:
            payload = await self.bridge.call(operation, arguments)
            if payload.get("error"):
                return {"error": SAFE_WORKSPACE_FAILURE}
            return payload
        except Exception:  # noqa: BLE001 - raw bridge errors can contain private data
            return {"error": SAFE_WORKSPACE_FAILURE}

    async def _mutate(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
        key = f"{operation}:{json.dumps(arguments, sort_keys=True, separators=(',', ':'))}"
        cached = self._mutations.get(key)
        if cached is not None:
            return cached
        payload = await self._call(operation, arguments)
        if not payload.get("error"):
            self._mutations[key] = payload
        return payload

    async def als(self, path: str) -> LsResult:
        try:
            safe = _safe_virtual_path(path)
        except ValueError as exc:
            return LsResult(error=str(exc))
        payload = await self._call("list", {"path": safe})
        return LsResult(error=payload.get("error"), entries=payload.get("entries"))

    async def aread(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        try:
            safe = _safe_virtual_path(file_path)
        except ValueError as exc:
            return ReadResult(error=str(exc))
        payload = await self._call("read", {"path": safe, "offset": offset, "limit": limit})
        if payload.get("error"):
            return ReadResult(error=payload["error"])
        return ReadResult(
            file_data=payload.get("file_data"),
            total_lines=payload.get("total_lines"),
            start_line=payload.get("start_line"),
            end_line=payload.get("end_line"),
            next_offset=payload.get("next_offset"),
        )

    async def awrite(self, file_path: str, content: str) -> WriteResult:
        if not self.write_enabled:
            return WriteResult(error="This run is read-only.")
        try:
            safe = _safe_virtual_path(file_path)
        except ValueError as exc:
            return WriteResult(error=str(exc))
        payload = await self._mutate("write", {"path": safe, "content": content})
        return WriteResult(error=payload.get("error"), path=payload.get("path"))

    async def aedit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        if not self.write_enabled:
            return EditResult(error="This run is read-only.")
        try:
            safe = _safe_virtual_path(file_path)
        except ValueError as exc:
            return EditResult(error=str(exc))
        payload = await self._mutate(
            "edit",
            {
                "path": safe,
                "old_string": old_string,
                "new_string": new_string,
                "replace_all": replace_all,
            },
        )
        return EditResult(
            error=payload.get("error"),
            path=payload.get("path"),
            occurrences=payload.get("occurrences"),
        )

    async def adelete(self, file_path: str) -> DeleteResult:
        if not self.write_enabled:
            return DeleteResult(error="This run is read-only.")
        try:
            safe = _safe_virtual_path(file_path)
        except ValueError as exc:
            return DeleteResult(error=str(exc))
        payload = await self._mutate("delete", {"path": safe})
        return DeleteResult(error=payload.get("error"), path=payload.get("path"))

    async def amove(self, source_path: str, destination_path: str) -> dict[str, Any]:
        """Move one normal workspace file without reading or rewriting its bytes."""
        if not self.write_enabled:
            return {"error": "This run is read-only."}
        try:
            source = _safe_virtual_path(source_path)
            destination = _safe_virtual_path(destination_path)
        except ValueError as exc:
            return {"error": str(exc)}
        return await self._mutate("move", {"source_path": source, "destination_path": destination})

    async def arename(self, file_path: str, new_name: str) -> dict[str, Any]:
        """Rename one normal workspace file in place without touching its bytes."""
        if not self.write_enabled:
            return {"error": "This run is read-only."}
        source, source_error = _rename_source_or_error(file_path)
        if source_error is not None:
            return {"error": source_error}
        requested = _safe_rename_name(new_name)
        if requested is None:
            return {"error": "The new name must be one safe file name."}
        assert source is not None
        destination = posixpath.join(posixpath.dirname(source), requested)
        return await self._mutate(
            "rename",
            {"source_path": source, "new_name": requested, "destination_path": destination},
        )

    async def aglob(self, pattern: str, path: str | None = None) -> GlobResult:
        try:
            safe = _safe_virtual_path(path or "/")
        except ValueError as exc:
            return GlobResult(error=str(exc))
        payload = await self._call("glob", {"path": safe, "pattern": pattern})
        return GlobResult(
            error=payload.get("error"),
            matches=payload.get("matches"),
            truncated=bool(payload.get("truncated", False)),
        )

    async def agrep(
        self,
        pattern: str,
        path: str | None = None,
        glob: str | None = None,
        *,
        max_count: int | None = None,
    ) -> GrepResult:
        try:
            safe = _safe_virtual_path(path or "/")
        except ValueError as exc:
            return GrepResult(error=str(exc))
        payload = await self._call(
            "grep", {"path": safe, "pattern": pattern, "glob": glob, "max_count": max_count}
        )
        return GrepResult(
            error=payload.get("error"),
            matches=payload.get("matches"),
            truncated=bool(payload.get("truncated", False)),
        )


class ArcelleStateBackend(StateBackend):
    """Named Deep Agents state backend for temporary plans and spill files."""


@dataclass(slots=True)
class ArcelleToolBackend:
    """Restricted adapter for Arcelle special tools; no shell or raw paths."""

    mcp: McpClient

    async def call(self, name: str, arguments: dict[str, Any]) -> str:
        result = await self.mcp.call_tool(name, arguments)
        if result.is_error:
            raise RuntimeError(result.text)
        return result.text


def _tool_result_json(error: Any, path: Any) -> str:
    values = {
        key: value for key, value in {"error": error, "path": path}.items() if value is not None
    }
    return json.dumps(values, sort_keys=True, separators=(",", ":"))


def _workspace_mutation_tools(backend: ArcelleWorkspaceBackend) -> list[BaseTool]:
    """Tools missing from Deep Agents' text-focused filesystem middleware."""

    async def workspace_delete(path: str) -> str:
        """Move one normal workspace file to recoverable Arcelle Trash.

        Use this tool when the user asks to delete a file. Do not simulate a
        deletion by renaming or moving the file to another workspace folder.
        Arcelle permits the operation only after a rollback baseline exists.
        """
        result = await backend.adelete(path)
        return _tool_result_json(result.error, result.path)

    async def workspace_move(source_path: str, destination_path: str) -> str:
        """Move or rename a normal workspace file to an exact virtual path.

        This moves the filesystem entry directly, so it also works for PDFs,
        recordings, images, sketches, spreadsheets, and other binary files.
        Arcelle permits the operation only after a rollback baseline exists.
        """
        return json.dumps(
            await backend.amove(source_path, destination_path),
            sort_keys=True,
            separators=(",", ":"),
        )

    async def workspace_rename(source_path: str, new_name: str) -> str:
        """Rename a normal workspace file while keeping it in its current folder.

        Give only the new file name, including its extension. Arcelle moves the
        filesystem entry directly and requires an authorized rollback baseline.
        """
        return json.dumps(
            await backend.arename(source_path, new_name),
            sort_keys=True,
            separators=(",", ":"),
        )

    return [
        StructuredTool.from_function(
            name="workspace_delete",
            description=workspace_delete.__doc__ or "Move a workspace file to Arcelle Trash.",
            coroutine=workspace_delete,
        ),
        StructuredTool.from_function(
            name="workspace_move",
            description=workspace_move.__doc__ or "Move a workspace file.",
            coroutine=workspace_move,
        ),
        StructuredTool.from_function(
            name="workspace_rename",
            description=workspace_rename.__doc__ or "Rename a workspace file.",
            coroutine=workspace_rename,
        ),
    ]
