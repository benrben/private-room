"""Pure schema construction and route-label selection for workflow nodes."""

from typing import Any

from .wf_serde import _parse_or


def build_extract_schema(fields: list[str]) -> dict[str, Any]:
    props: dict[str, Any] = {}
    required: list[str] = []
    for field in (field.strip() for field in fields):
        if field:
            props[field] = {"type": "string"}
            required.append(field)
    return {"type": "object", "properties": props, "required": required}


def route_schema_of(labels: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {"label": {"type": "string", "enum": list(labels)}},
        "required": ["label"],
    }


def pick_route_label(raw: str, labels: list[str]) -> str:
    structured = _structured_route_label(_parse_or(raw, None), labels)
    if structured is not None:
        return structured
    prose = _prose_route_label(raw, labels)
    if prose is not None:
        return prose
    return _first_route_label(labels)


def _structured_route_label(parsed: Any, labels: list[str]) -> str | None:
    if not isinstance(parsed, dict):
        return None
    label = parsed.get("label")
    if not isinstance(label, str):
        return None
    return _casefold_route_label(label, labels)


def _casefold_route_label(label: str, labels: list[str]) -> str | None:
    wanted = label.strip().casefold()
    return next((candidate for candidate in labels if candidate.casefold() == wanted), None)


def _prose_route_label(raw: str, labels: list[str]) -> str | None:
    haystack = raw.lower()
    return next((candidate for candidate in labels if candidate.lower() in haystack), None)


def _first_route_label(labels: list[str]) -> str:
    return labels[0] if labels else ""
