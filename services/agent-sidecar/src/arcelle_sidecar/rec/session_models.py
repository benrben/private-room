"""Recording request models and live metadata edit operations."""

from __future__ import annotations

import base64
import uuid
from typing import Any, Callable

import numpy as np
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from arcelle_sidecar.diar.recognize import KnownVoice
from arcelle_sidecar.rec.engine import Engine, EngineConfig
from arcelle_sidecar.rec.meta import (
    By,
    NoteKind,
    RecChapter,
    RecHighlight,
    RecMeta,
    RecNote,
)

DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434"


class _CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")


class KnownVoiceIn(_CamelModel):
    """One saved voice, as Electron reads it from the room's voice table --
    see ``EngineConfig.known_voices``."""

    name: str = ""
    vec: list[float] = Field(default_factory=list)
    rejects: list[list[float]] = Field(default_factory=list)

    def to_known_voice(self) -> KnownVoice:
        return KnownVoice(
            name=self.name,
            vec=np.asarray(self.vec, dtype=np.float32),
            rejects=[np.asarray(r, dtype=np.float32) for r in self.rejects],
        )


class StartSessionRequest(_CamelModel):
    """``POST /rec/start`` -- :class:`EngineConfig`, reshaped for the wire.
    Fields map 1:1 onto it except the trailing two, which are this module's own
    wiring inputs and not part of the engine's config at all."""

    file_id: str
    #: The whisper weights, already resolved by Electron.
    model_path: str
    #: Base64 of little-endian f32 PCM (prior audio, when resuming a file), or
    #: omitted for a fresh recording.
    base_samples: str | None = None
    #: A ``RecMeta.to_dict()``-shaped object, or omitted for a fresh ``RecMeta``.
    meta: dict[str, Any] | None = None
    system_audio: bool = False
    live_translate: str | None = None
    known_voices: list[KnownVoiceIn] = Field(default_factory=list)
    diarize_model_path: str | None = None
    default_translation_model: str | None = None

    #: Where this session's encrypted spool file lives (see §5).
    spool_dir: str
    #: See :data:`DEFAULT_OLLAMA_BASE_URL`.
    base_url: str = DEFAULT_OLLAMA_BASE_URL


class FileIdBody(_CamelModel):
    file_id: str


class SetLiveSttBody(FileIdBody):
    on: bool


class SetLiveTranslateBody(FileIdBody):
    lang: str | None = None


class EditMetaRequest(FileIdBody):
    """``POST /rec/edit_meta`` -- see :func:`_build_apply` for the op set."""

    op: str
    label: str | None = None
    name: str | None = None
    t0: int | None = None
    t1: int | None = None
    kind: str | None = None
    text: str | None = None
    who: str | None = None
    note_id: str | None = None
    title: str | None = None
    chapter_id: str | None = None
    item_kind: str | None = None
    item_id: str | None = None


class CutIn(_CamelModel):
    """One studio deletion on the recording's timeline, ``{"t0", "t1"}`` in
    centiseconds -- the wire shape of :class:`~arcelle_sidecar.rec.meta.RecCut`
    (``RecCut.to_dict()``), so a host can post back exactly what it stored."""

    t0: int
    t1: int


class PriorNamingIn(_CamelModel):
    """What a rebuild inherits from the recording it is replacing (§7).

    The naming overlay AND the studio deletions -- everything anchored on the
    TIMELINE rather than on the old transcript. The transcript, its segments
    and its word timings are about to be derived again from the audio, so
    nothing anchored on THEM survives; the audio itself is unchanged, so
    ``cuts`` are still exactly true.

    ``speakerNames`` is the label -> name overlay the user typed, and
    ``recognized`` says which of those names the app GUESSED from a saved
    voice -- ``retranscribe`` drops the guesses (a guess must not outlive the
    label it was made about) and keeps the typed ones.

    ``cuts`` is load-bearing and NOT merely carried through: ``retranscribe``
    re-marks every freshly derived word that falls inside one as deleted, which
    is the only reason content the user cut does not resurface in the
    transcript, in ``files.extracted_text`` (and therefore in search and in
    every AI prompt), or in an exported copy. A host that keeps its own copy of
    the cut list and pastes it back onto the returned meta gets the spans
    without the marking -- the waveform skips the audio while the words are
    still there to read. Send them.

    Omitted entirely for a file that was never a recording: an import has no
    prior naming and no cuts at all, which is not an error, just an empty
    overlay.
    """

    speaker_names: dict[str, str] = Field(default_factory=dict)
    recognized: list[str] = Field(default_factory=list)
    cuts: list[CutIn] = Field(default_factory=list)


class RetranscribeRequest(_CamelModel):
    """``POST /rec/retranscribe`` -- see §7."""

    #: The host-staged decrypted media file. Refused unless it sits directly
    #: inside an ``arcelle-stt-*`` directory under the OS temp root (see
    #: :func:`_staged_media_path`).
    file_path: str
    #: The whisper weights, already resolved by Electron -- same contract as
    #: :class:`StartSessionRequest`.
    model_path: str
    #: The TitaNet ONNX weights, or ``None`` when the host found none. A
    #: missing diarize model DEGRADES the rebuild to the DSP voiceprint rather
    #: than refusing it; the terminal ``done`` line's ``neural`` flag says
    #: which of the two actually happened.
    diarize_model_path: str | None = None
    #: 0 (the normal value) discovers however many voices are in the file; a
    #: positive value pins the count. Negative is refused, not clamped.
    max_speakers: int = 0
    known_voices: list[KnownVoiceIn] = Field(default_factory=list)
    prior: PriorNamingIn | None = None
    #: ``"audio"`` | ``"video"``, the same knob ``/stt/transcribe_file`` takes:
    #: a video has to have its audio track extracted before the decoder can see
    #: it. OMITTED is the normal case and is not a synonym for ``"audio"`` --
    #: it means "you work it out", and :func:`_media_kind_for` reads the
    #: suffix. A value that is neither word is refused rather than quietly read
    #: as audio, which is how a video would decode to nothing at all.
    kind: str | None = None


def _decode_base_samples(b64: str | None) -> np.ndarray:
    if not b64:
        return np.zeros(0, dtype=np.float32)
    raw = base64.b64decode(b64)
    return np.frombuffer(raw, dtype="<f4").astype(np.float32, copy=True)


def _engine_config(req: StartSessionRequest) -> EngineConfig:
    return EngineConfig(
        file_id=req.file_id,
        model_path=req.model_path,
        base_samples=_decode_base_samples(req.base_samples),
        meta=RecMeta.from_dict(req.meta) if req.meta else RecMeta(),
        system_audio=req.system_audio,
        live_translate=req.live_translate,
        known_voices=[kv.to_known_voice() for kv in req.known_voices],
        diarize_model_path=req.diarize_model_path,
        default_translation_model=req.default_translation_model,
    )


# =============================================================================
# ---- edit_meta: the explicit op set (mirrors recording_cmds.rs) -------------
# =============================================================================


def _clean(text: str, cap: int) -> str:
    """Rust's ``clean``: trim, then cap the CHARACTERS -- a paste accident must
    not blow out the transcript prefix."""
    return text.strip()[:cap]


def _at_time(meta: RecMeta, engine: Engine, t0: int) -> int | str:
    """Rust's ``at_time``: where in the recording an item may sit. A time past
    the end is a bug in the caller, not something to store -- an item nobody can
    ever reach is worse than a refusal. Returns the accepted time, or the
    refusal message (the Python shape of Rust's ``Result<i64, String>``).

    Measured against the LIVE head as well as ``meta.duration_cs``: the meta's
    is stamped no more often than the engine flushes, so marking the moment
    someone just said the thing that matters -- the entire reason a mark button
    exists -- would be refused for the seconds between flushes. The horizon may
    only grow, never shrink, so taking the larger of the two is safe."""
    if t0 < 0:
        return "That moment is outside this recording."
    live_cs = max(meta.duration_cs, engine.duration_cs)
    if live_cs > 0 and t0 > live_cs:
        return "That moment is outside this recording."
    return t0


def _apply_rename_speaker(label: str, name: str) -> Callable[[RecMeta], str | None]:
    """``rec_set_speaker_name``, MINUS the saved-voice learning it also does --
    that is a real DB write and therefore Electron's job. Electron can still do
    it from the returned meta, using the same "what was this label called
    before" fact the Rust command derives from the meta it already holds."""

    def apply(meta: RecMeta) -> str | None:
        speaker = label.strip()
        refusal = _rename_speaker_refusal(meta, speaker)
        if refusal is not None:
            return refusal
        called = _clean(name, 60)
        was = _replace_speaker_name(meta, speaker, called)
        # Either way the name on this voice is now the user's own, so it stops
        # being a guess and must not be re-decided by the next pass.
        if was is not None:
            meta.recognized.discard(was)
        meta.recognized.discard(called)
        return None

    return apply


def _rename_speaker_refusal(meta: RecMeta, speaker: str) -> str | None:
    if not speaker:
        return "No speaker selected."
    if not meta.segments:
        return "That recording has no transcript yet."
    if not any(segment.speaker == speaker for segment in meta.segments):
        return f'Nobody in this recording is labelled "{speaker}".'
    return None


def _replace_speaker_name(meta: RecMeta, speaker: str, called: str) -> str | None:
    was = meta.speaker_names.get(speaker)
    # Naming someone back to their machine label is a removal, not an entry
    # that shadows itself.
    if not called or called == speaker:
        meta.speaker_names.pop(speaker, None)
    else:
        meta.speaker_names[speaker] = called
    return was


def _apply_add_note(
    engine: Engine, t0: int, kind: str, text: str, who: str | None
) -> Callable[[RecMeta], str | None]:
    def apply(meta: RecMeta) -> str | None:
        cleaned = _clean(text, 400)
        if not cleaned:
            return "A note needs some words."
        at = _at_time(meta, engine, t0)
        if isinstance(at, str):
            return at
        note_kind = {
            "decision": NoteKind.DECISION,
            "action": NoteKind.ACTION,
            "question": NoteKind.QUESTION,
        }.get(kind.strip(), NoteKind.POINT)
        author = _clean(who or "", 60) or None
        meta.notes.append(
            RecNote(id=str(uuid.uuid4()), t0=at, kind=note_kind, text=cleaned, who=author, by=By.YOU)
        )
        meta.notes.sort(key=lambda n: n.t0)
        return None

    return apply


def _apply_set_note(note_id: str, text: str) -> Callable[[RecMeta], str | None]:
    """``rec_note_set``: retyping a note the ROOM wrote makes it yours, so the
    next reading leaves it alone."""

    def apply(meta: RecMeta) -> str | None:
        cleaned = _clean(text, 400)
        if not cleaned:
            return "A note needs some words."
        for note in meta.notes:
            if note.id == note_id:
                note.text = cleaned
                note.by = By.YOU
                return None
        return "That note is no longer in this recording."

    return apply


def _apply_add_chapter(engine: Engine, t0: int, title: str) -> Callable[[RecMeta], str | None]:
    def apply(meta: RecMeta) -> str | None:
        cleaned = _clean(title, 80)
        if not cleaned:
            return "A chapter needs a name."
        at = _at_time(meta, engine, t0)
        if isinstance(at, str):
            return at
        meta.chapters.append(RecChapter(id=str(uuid.uuid4()), t0=at, title=cleaned, by=By.YOU))
        meta.chapters.sort(key=lambda c: c.t0)
        return None

    return apply


def _apply_set_chapter(chapter_id: str, title: str) -> Callable[[RecMeta], str | None]:
    def apply(meta: RecMeta) -> str | None:
        cleaned = _clean(title, 80)
        if not cleaned:
            return "A chapter needs a name."
        for chapter in meta.chapters:
            if chapter.id == chapter_id:
                chapter.title = cleaned
                chapter.by = By.YOU
                return None
        return "That chapter is no longer in this recording."

    return apply


def _apply_add_highlight(engine: Engine, t0: int, t1: int) -> Callable[[RecMeta], str | None]:
    """``rec_highlight_add``: ``t1`` before ``t0`` marks the instant."""

    def apply(meta: RecMeta) -> str | None:
        at = _at_time(meta, engine, t0)
        if isinstance(at, str):
            return at
        meta.highlights.append(RecHighlight(id=str(uuid.uuid4()), t0=at, t1=max(t1, at), by=By.YOU))
        meta.highlights.sort(key=lambda h: h.t0)
        return None

    return apply


def _apply_delete_item(item_kind: str, item_id: str) -> Callable[[RecMeta], str | None]:
    """``rec_item_delete``. Deleting something the ROOM wrote is a real removal,
    not a correction, so the next reading may find it again -- which is right:
    you removed this reading's claim, not the fact that the words are there."""

    def apply(meta: RecMeta) -> str | None:
        items = _deletable_meta_items(meta, item_kind)
        if items is None:
            return f'Unknown item kind "{item_kind}".'
        if not _remove_meta_item(items, item_id):
            return "That item is no longer in this recording."
        return None

    return apply


def _deletable_meta_items(meta: RecMeta, item_kind: str) -> list[Any] | None:
    return {
        "note": meta.notes,
        "chapter": meta.chapters,
        "highlight": meta.highlights,
    }.get(item_kind)


def _remove_meta_item(items: list[Any], item_id: str) -> bool:
    before = len(items)
    items[:] = [item for item in items if item.id != item_id]
    return len(items) != before


def _rename_speaker_apply(req: EditMetaRequest, _engine: Engine) -> Callable[[RecMeta], str | None]:
    if req.label is None or req.name is None:
        raise ValueError("rename_speaker needs 'label' and 'name'.")
    return _apply_rename_speaker(req.label, req.name)


def _add_note_apply(req: EditMetaRequest, engine: Engine) -> Callable[[RecMeta], str | None]:
    if req.t0 is None or req.kind is None or req.text is None:
        raise ValueError("add_note needs 't0', 'kind' and 'text'.")
    return _apply_add_note(engine, req.t0, req.kind, req.text, req.who)


def _set_note_apply(req: EditMetaRequest, _engine: Engine) -> Callable[[RecMeta], str | None]:
    if req.note_id is None or req.text is None:
        raise ValueError("set_note needs 'noteId' and 'text'.")
    return _apply_set_note(req.note_id, req.text)


def _add_chapter_apply(req: EditMetaRequest, engine: Engine) -> Callable[[RecMeta], str | None]:
    if req.t0 is None or req.title is None:
        raise ValueError("add_chapter needs 't0' and 'title'.")
    return _apply_add_chapter(engine, req.t0, req.title)


def _set_chapter_apply(req: EditMetaRequest, _engine: Engine) -> Callable[[RecMeta], str | None]:
    if req.chapter_id is None or req.title is None:
        raise ValueError("set_chapter needs 'chapterId' and 'title'.")
    return _apply_set_chapter(req.chapter_id, req.title)


def _add_highlight_apply(req: EditMetaRequest, engine: Engine) -> Callable[[RecMeta], str | None]:
    if req.t0 is None or req.t1 is None:
        raise ValueError("add_highlight needs 't0' and 't1'.")
    return _apply_add_highlight(engine, req.t0, req.t1)


def _delete_item_apply(req: EditMetaRequest, _engine: Engine) -> Callable[[RecMeta], str | None]:
    if req.item_kind is None or req.item_id is None:
        raise ValueError("delete_item needs 'itemKind' and 'itemId'.")
    return _apply_delete_item(req.item_kind, req.item_id)


EditApplyBuilder = Callable[[EditMetaRequest, Engine], Callable[[RecMeta], str | None]]

EDIT_APPLY_BUILDERS: dict[str, EditApplyBuilder] = {
    "rename_speaker": _rename_speaker_apply,
    "add_note": _add_note_apply,
    "set_note": _set_note_apply,
    "add_chapter": _add_chapter_apply,
    "set_chapter": _set_chapter_apply,
    "add_highlight": _add_highlight_apply,
    "delete_item": _delete_item_apply,
}


def _build_apply(req: EditMetaRequest, engine: Engine) -> Callable[[RecMeta], str | None]:
    """Build the server-side ``apply`` closure :class:`MsgEditMeta` wants, from
    one of an explicit set of ops -- nothing crosses this boundary as executable
    code. Raises :class:`ValueError` (a 400 at the route) for an unknown op or a
    missing field; the op's own REFUSALS (a name nobody has, a moment past the
    end) come back through ``apply``'s return value instead, exactly like
    Rust's ``Result``."""
    builder = EDIT_APPLY_BUILDERS.get(req.op)
    if builder is None:
        raise ValueError(f"Unknown edit op {req.op!r}.")
    return builder(req, engine)
