"""Bounded OLE compound-file stream access for legacy Office formats."""

import io

import olefile

_OLE_MAGIC = bytes((0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1))
_MAX_OLE_STREAM_BYTES = 200 * 1024 * 1024


def is_ole_compound(data: bytes) -> bool:
    return data.startswith(_OLE_MAGIC)


def read_ole_stream(data: bytes, names: list[str]) -> bytes | None:
    """Read the first matching stream without treating short bytes as a path."""
    try:
        ole = olefile.OleFileIO(io.BytesIO(data))
    except Exception:
        return None
    try:
        for name in names:
            if not ole.exists(name):
                continue
            try:
                stream = ole.openstream(name)
            except Exception:
                continue
            return stream.read(_MAX_OLE_STREAM_BYTES)
        return None
    finally:
        ole.close()
