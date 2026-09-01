"""Shared text sizing for legacy Office extraction."""


def utf8_len(value: str) -> int:
    """Byte length matching Rust's UTF-8 ``String::len``."""
    return len(value.encode("utf-8"))
