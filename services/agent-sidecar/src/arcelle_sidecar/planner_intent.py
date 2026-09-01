"""Deterministic visual-intent recognition for the specialist planner."""

import re

_VIDEO_FILE_RE = re.compile(r"(?i)\.(?:mp4|mov|m4v|webm)\b")
_VIDEO_MEDIUM_RE = re.compile(r"(?i)\b(?:video|footage|clip|recording)\b")
_FRAME_RE = re.compile(r"(?i)\bframe\b")
_TRANSCRIPT_RE = re.compile(r"(?i)\btranscri(?:be|bed|bing|pt|ption)\b")
_TIMESTAMP_RE = re.compile(r"(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?!\d)")
_VISUAL_WORDS_RE = re.compile(
    r"(?i)(?:\bwhat\b.{0,48}\b(?:see|visible|shown)\b|"
    r"\b(?:show|describe|inspect|look at|watch)\b.{0,48}"
    r"\b(?:frame|scene|screen|video|footage|clip|recording)\b|"
    r"\b(?:on screen|which slide is (?:up|visible|shown))\b)"
)
_STATIC_VISUAL_ANCHOR_RE = re.compile(
    r"(?i)(?:\.(?:png|jpe?g|gif|webp|avif|heic|heif|tiff?|svg|sketch)\b|"
    r"\b(?:image|photo|picture|screenshot|sketch|drawing|diagram|chart|canvas)\b)"
)
_STATIC_VISUAL_WORDS_RE = re.compile(
    r"(?i)(?:\bwhat\b.{0,56}\b(?:see|visible|shown|written|depicted|pictured)\b|"
    r"\b(?:describe|inspect|look at)\b.{0,80}(?:"
    r"\.(?:png|jpe?g|gif|webp|avif|heic|heif|tiff?|svg|sketch)\b|"
    r"\b(?:image|photo|picture|screenshot|sketch|drawing|diagram|chart|canvas)\b)|"
    r"\bwhat does\b.{0,56}\b(?:look like|say|show)\b|"
    r"\b(?:colour|color|layout|arrangement)\b.{0,40}"
    r"\b(?:image|photo|picture|screenshot|sketch|drawing|diagram|chart|canvas)\b)"
)


def is_visual_video_intent(question: str) -> bool:
    normalized = " ".join(question.split())
    frame = bool(_FRAME_RE.search(normalized))
    if _is_transcript_without_frame(normalized, frame=frame):
        return False
    return _video_pixels_are_requested(normalized, frame=frame)


def _is_transcript_without_frame(question: str, *, frame: bool) -> bool:
    return bool(_TRANSCRIPT_RE.search(question)) and not frame


def _video_pixels_are_requested(question: str, *, frame: bool) -> bool:
    return (
        _has_frame_timestamp(question, frame=frame)
        or _has_visual_timestamp(question)
        or _has_visual_video_medium(question)
    )


def _has_frame_timestamp(question: str, *, frame: bool) -> bool:
    return frame and bool(_TIMESTAMP_RE.search(question))


def _has_visual_timestamp(question: str) -> bool:
    return bool(_TIMESTAMP_RE.search(question)) and bool(
        _VISUAL_WORDS_RE.search(question)
    )


def _has_visual_video_medium(question: str) -> bool:
    return _has_video_medium(question) and bool(_VISUAL_WORDS_RE.search(question))


def _has_video_medium(question: str) -> bool:
    return bool(_VIDEO_FILE_RE.search(question) or _VIDEO_MEDIUM_RE.search(question))


def is_static_visual_intent(question: str) -> bool:
    normalized = " ".join(question.split())
    if is_visual_video_intent(normalized):
        return False
    return bool(
        _STATIC_VISUAL_ANCHOR_RE.search(normalized)
        and _STATIC_VISUAL_WORDS_RE.search(normalized)
    )
