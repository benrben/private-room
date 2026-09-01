"""Deterministic rendering of recording metadata into searchable transcript text."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .meta import RecChapter, RecHighlight, RecMeta, RecNote, RecSegment


def format_stamp(cs: int) -> str:
    seconds = max(cs // 100, 0)
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours > 0:
        return f"[{hours}:{minutes:02d}:{secs:02d}]"
    return f"[{minutes}:{secs:02d}]"


_NOTE_LABELS = {
    "decision": "Decision",
    "action": "Action",
    "question": "Open question",
    "point": "Point",
}


def _note_line(note: RecNote) -> str:
    kind = note.kind.value
    label = _NOTE_LABELS[kind]
    if kind == "action" and note.who:
        return f"{label} ({note.who}): {note.text}"
    return f"{label}: {note.text}"


def segment_visible_text(segment: RecSegment) -> str:
    if not segment.words:
        return segment.text.strip()
    kept = [word.w.strip() for word in segment.words if not word.del_]
    return " ".join(word for word in kept if word)


def _append_chapters_through(
    out: list[str], chapters: list[RecChapter], index: int, timestamp: int
) -> int:
    while index < len(chapters) and chapters[index].t0 <= timestamp:
        chapter = chapters[index]
        out.append(f"\n## {format_stamp(chapter.t0)} {chapter.title}\n")
        index += 1
    return index


def _append_notes_through(
    out: list[str], notes: list[RecNote], index: int, timestamp: int
) -> int:
    while index < len(notes) and notes[index].t0 <= timestamp:
        note = notes[index]
        out.append(f"{format_stamp(note.t0)} {_note_line(note)}\n")
        index += 1
    return index


def _segment_is_highlighted(
    segment: RecSegment, highlights: list[RecHighlight]
) -> bool:
    return any(
        highlight.t0 < segment.t1
        and segment.t0 < max(highlight.t1, highlight.t0 + 1)
        for highlight in highlights
    )


def _transcript_segment_line(meta: RecMeta, segment: RecSegment, text: str) -> str:
    mark = "* " if _segment_is_highlighted(segment, meta.highlights) else ""
    return f"{mark}{format_stamp(segment.t0)} {meta.display_speaker(segment.speaker)}: {text}\n"


def _append_transcript_segment(
    out: list[str],
    meta: RecMeta,
    segment: RecSegment,
    chapter_index: int,
    note_index: int,
) -> tuple[int, int]:
    text = segment_visible_text(segment)
    if not text:
        return chapter_index, note_index
    chapter_index = _append_chapters_through(
        out, meta.chapters, chapter_index, segment.t0
    )
    note_index = _append_notes_through(out, meta.notes, note_index, segment.t0)
    out.append(_transcript_segment_line(meta, segment, text))
    return chapter_index, note_index


def _append_remaining_annotations(
    out: list[str],
    chapters: list[RecChapter],
    notes: list[RecNote],
    chapter_index: int,
    note_index: int,
) -> None:
    for chapter in chapters[chapter_index:]:
        out.append(f"\n## {format_stamp(chapter.t0)} {chapter.title}\n")
    for note in notes[note_index:]:
        out.append(f"{format_stamp(note.t0)} {_note_line(note)}\n")


def transcript_text(meta: RecMeta) -> str:
    out: list[str] = ["(live recording)\n"]
    chapter_index = 0
    note_index = 0
    for segment in meta.segments:
        chapter_index, note_index = _append_transcript_segment(
            out, meta, segment, chapter_index, note_index
        )
    _append_remaining_annotations(
        out, meta.chapters, meta.notes, chapter_index, note_index
    )
    return "".join(out)
