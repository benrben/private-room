"""ADD-27 recording data model + pure helpers -- port of
``src-tauri/src/recording.rs`` lines 1-350 (module doc, every constant, the
full data model: ``RecWord``/``RecSegment``/``By``/``NoteKind``/``RecNote``/
``RecHighlight``/``RecChapter``/``RecCut``/``RecMeta``/``ReadStamp``,
``RecMeta::display_speaker``, ``ReadStamp::of``, ``cs_of_samples``,
``samples_of_cs``) and lines 355-598 (``format_stamp``, ``relabel_interval``,
``words_of``, ``text_overlap``, ``time_overlap``, ``transcript_text``,
``note_line``, ``segment_visible_text``, ``add_cut``, ``cut_shift_before``,
``inside_cut``).

``encode_wav``/``decode_wav``/``resample_to_16k`` (Rust lines ~500-627) are
DELIBERATELY NOT here -- they are already ported in
:mod:`arcelle_sidecar.media.wav`.

## The one field this port could not get "for free" from the Rust struct

``RecSegment.voice`` is a ``diarize::VoicePrint`` in Rust, which carries its
own field renames (``#[serde(rename = "v")]`` on ``vec``, ``#[serde(rename =
"f")]`` on ``voiced_frames`` -- see ``src-tauri/src/recording/diarize.rs``).
The Python port of that struct (:class:`arcelle_sidecar.diar.embed.VoicePrint`)
is a plain dataclass with no serialization of its own (that module is final
from an earlier batch and is not touched here). So the ``{"v": [...], "f":
N}`` <-> ``VoicePrint`` mapping lives in THIS module instead, as
``_voiceprint_to_dict``/``_voiceprint_from_dict`` -- free functions, not
methods added onto the borrowed class.

## BTreeMap / BTreeSet -> sorted JSON

``RecMeta.speaker_names`` (a Rust ``BTreeMap``) and ``RecMeta.recognized`` (a
``BTreeSet``) are plain ``dict``/``set`` here, but serialize with keys/items
in SORTED order -- the Rust source's own comment says this is load-bearing:
the metadata JSON is diffed by the room's file-version history, so key order
has to be stable.

## Required vs. optional JSON fields on ``RecMeta``

The Rust struct marks ``max_speakers``, ``speaker_names``, ``recognized``,
``chapters``, ``highlights``, ``notes`` and ``read_of`` with
``#[serde(default, ...)]`` -- all of them are optional on deserialize.
``duration_cs``, ``segments`` and ``cuts`` carry NO such attribute, so they
are REQUIRED: a Rust deserialize of a JSON object missing any of the three
fails outright. ``RecMeta.from_dict`` mirrors that split exactly -- the three
required keys are read with plain ``d[...]`` (a missing key raises
``KeyError``, matching Rust's hard failure), the rest with ``.get(...,
default)``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import numpy as np

from arcelle_sidecar.diar.embed import VoicePrint

# --------------------------------------------------------------- constants

SAMPLE_RATE: int = 16_000
"""16 kHz throughout -- Rust ``recording.rs`` line 31."""

FRAME: int = 512
"""VAD frame: 32 ms -- one Silero window (512 samples @ 16 kHz), so the
neural probabilities map one-to-one onto frames."""

START_FRAMES: int = 3
"""Speech starts after this many consecutive voiced frames (96 ms)."""

END_FRAMES: int = 24
"""...and ends after this many unvoiced ones (768 ms) -- long enough that a
mid-sentence breath doesn't split a phrase."""

PREROLL: int = SAMPLE_RATE // 2
"""Pre-roll kept before the detected start, so the first syllable survives
even when the opening frames were too soft to trip the detector."""

MAX_SEGMENT: int = SAMPLE_RATE * 28
"""A segment is force-closed near Whisper's native 30 s window; the cut is
made at the quietest recent frame (see ``DIP_LOOKBACK``), never mid-word at
an arbitrary sample."""

DIP_LOOKBACK: int = SAMPLE_RATE * 5
"""How far back from the forced cut to look for the quietest frame."""

VAD_OPEN: float = 0.35
"""Silero probability that OPENS a phrase (recall-biased: production capture
pipelines run 0.3-0.35, not the file-transcription default 0.5)."""

VAD_SUSTAIN: float = 0.20
"""...and the lower bar that KEEPS one open, so brief intra-word dips don't
chop a sentence (hysteresis)."""

PARTIAL_EVERY: int = SAMPLE_RATE * 3 // 2
"""Re-decode the growing phrase for a live partial roughly this often."""

FLUSH_EVERY_SEGMENTS: int = 8
"""Auto-flush to the DB every N finished segments (crash safety); pause/stop
always flush."""

RELABEL_EVERY_SEGMENTS: int = 2
"""Re-cluster the meeting's voices every N new phrases (and on every flush /
pause / stop) -- the floor of the back-off in ``relabel_interval``."""

RELABEL_TIME_BUDGET_MS: int = 40
"""Once a relabel pass costs more than this many ms it buys itself
proportionally more phrases of quiet (see ``relabel_interval``)."""

RELABEL_MAX_SEGMENTS: int = 64
"""Ceiling on that back-off: even a very expensive pass runs this often, or a
long meeting would stop correcting its speakers on screen entirely."""

MAX_SESSION_SAMPLES: int = SAMPLE_RATE * 3 * 3600
"""Hard session ceiling (3 h): the mixed timeline lives in memory while
recording (~230 MB/h of f32), so a forgotten recorder stops itself."""

RETRANSCRIBE_DECODE_PCT: int = 92
"""Share of a re-transcribe's progress bar that belongs to the phrase-by-
phrase decode. The rest is the whole-recording speaker pass."""

RETRANSCRIBE_STOPPED: str = "Stopped — the transcript is unchanged."
"""What ``retranscribe`` returns when its ``stop`` flag goes up."""

LANE_RESYNC_GAP: int = SAMPLE_RATE // 2
"""A lane that has been silent for longer than this while the OTHER lane
kept recording resyncs at the shared timeline's head instead of where the
lane left off."""

ECHO_OVERLAP: float = 0.5
"""Two phrases are the same sound reaching both lanes when they overlap in
time by this much of the shorter one."""

ECHO_SAME_TEXT: float = 0.6
"""...and when this fraction of the shorter phrase's words appear in the
other."""


# ---------------------------------------------------------------- data model


@dataclass
class RecWord:
    """One word with its place on the timeline (centiseconds). ``del_`` marks
    words removed by the transcript editor -- the audio keeps them until
    export.

    ``del`` is a Python keyword, hence the trailing underscore on the
    attribute name; the JSON key is still the literal ``"del"``, omitted
    entirely when false (Rust: ``#[serde(default, skip_serializing_if =
    "std::ops::Not::not")]``) and defaulted to false when absent.
    """

    w: str
    t0: int
    t1: int
    del_: bool = False

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"w": self.w, "t0": self.t0, "t1": self.t1}
        if self.del_:
            d["del"] = True
        return d

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "RecWord":
        return RecWord(w=d["w"], t0=d["t0"], t1=d["t1"], del_=bool(d.get("del", False)))


def _voiceprint_to_dict(vp: VoicePrint) -> dict[str, Any]:
    """``VoicePrint`` -> ``{"v": [...], "f": N}`` -- the Rust
    ``#[serde(rename = "v"/"f")]`` shape on ``diarize::VoicePrint``."""
    return {"v": [float(x) for x in np.asarray(vp.vec, dtype=np.float32).tolist()], "f": int(vp.voiced_frames)}


def _voiceprint_from_dict(d: dict[str, Any]) -> VoicePrint:
    return VoicePrint(vec=np.asarray(d.get("v", []), dtype=np.float32), voiced_frames=int(d.get("f", 0)))


@dataclass
class RecSegment:
    id: str
    source: str
    """"mic" | "sys" -- which capture lane heard it."""
    speaker: str
    """"You" for the microphone, "Speaker N" for clustered meeting voices."""
    t0: int
    t1: int
    text: str
    words: list[RecWord]
    lang: str | None = None
    """Omit the "lang" key entirely from JSON when None."""
    voice: VoicePrint | None = None
    """The phrase's voiceprint (meeting lane only). Absent on mic phrases and
    on files recorded before ADD-27; omit "voice" entirely when None, else
    ``{"v": [...], "f": N}`` (see ``_voiceprint_to_dict``)."""

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "source": self.source,
            "speaker": self.speaker,
            "t0": self.t0,
            "t1": self.t1,
            "text": self.text,
            "words": [w.to_dict() for w in self.words],
        }
        if self.lang is not None:
            d["lang"] = self.lang
        if self.voice is not None:
            d["voice"] = _voiceprint_to_dict(self.voice)
        return d

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "RecSegment":
        raw_voice = d.get("voice")
        return RecSegment(
            id=d["id"],
            source=d["source"],
            speaker=d["speaker"],
            t0=d["t0"],
            t1=d["t1"],
            text=d["text"],
            # `words` has NO `#[serde(default)]` on the Rust struct -- it is a
            # REQUIRED field, same as id/source/speaker/t0/t1/text above (a
            # missing key raises KeyError, matching a Rust deserialize of the
            # same JSON). Only `lang`/`voice` are genuinely optional.
            words=[RecWord.from_dict(w) for w in d["words"]],
            lang=d.get("lang"),
            voice=_voiceprint_from_dict(raw_voice) if raw_voice is not None else None,
        )


class By(str, Enum):
    """Who put an annotation on the recording: the room's reading pass, or
    the person.

    The distinction is the whole safety property of the feature. The room
    reads every recording automatically, and it is sometimes wrong -- an
    action item attributed to a real colleague, a decision nobody made.
    Marked as the room's, that is a claim you can check at a glance and
    correct in one click. Unmarked, it is indistinguishable from something
    you wrote yourself, in the transcript and in everything exported from
    it.

    It is also the re-run rule: a fresh pass replaces everything ``ROOM``
    and never touches anything ``YOU``. Editing an item makes it yours,
    permanently.
    """

    ROOM = "room"
    YOU = "you"

    def is_room(self) -> bool:
        return self is By.ROOM


class NoteKind(str, Enum):
    """What the room found in a stretch of the conversation."""

    #: Something settled ("we ship Thursday").
    DECISION = "decision"
    #: Something somebody agreed to do.
    ACTION = "action"
    #: Something raised and left open.
    QUESTION = "question"
    #: What a stretch of the meeting was about.
    POINT = "point"


@dataclass
class RecNote:
    """A note pinned to a moment: what was decided, who agreed to do what,
    what is still open, what a stretch was about.

    ``t0`` is ORIGINAL-timeline centiseconds -- the same timeline ``RecCut``
    is stated on. Not a segment id: ``retranscribe`` mints every segment id
    afresh, so an id-anchored note would orphan on every rebuild, while the
    audio does not change, so a time stays exactly true.
    """

    id: str
    t0: int
    kind: NoteKind
    text: str
    who: str | None = None
    """Who the action is on, when the transcript actually says. Omit the
    "who" key entirely from JSON when None."""
    by: By = By.ROOM
    """ALWAYS present in JSON (Rust has no skip_serializing_if here, only
    ``#[serde(default)]`` for deserialize) -- defaults to ROOM when absent."""

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"id": self.id, "t0": self.t0, "kind": self.kind.value, "text": self.text}
        if self.who is not None:
            d["who"] = self.who
        d["by"] = self.by.value
        return d

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "RecNote":
        return RecNote(
            id=d["id"],
            t0=d["t0"],
            kind=NoteKind(d["kind"]),
            text=d["text"],
            who=d.get("who"),
            by=By(d["by"]) if d.get("by") is not None else By.ROOM,
        )


@dataclass
class RecHighlight:
    """A stretch worth coming back to. The words are the transcript's own --
    a highlight marks them, it does not copy them."""

    id: str
    t0: int
    t1: int
    by: By = By.ROOM
    """ALWAYS present in JSON, same rule as ``RecNote.by``."""

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "t0": self.t0, "t1": self.t1, "by": self.by.value}

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "RecHighlight":
        return RecHighlight(
            id=d["id"], t0=d["t0"], t1=d["t1"], by=By(d["by"]) if d.get("by") is not None else By.ROOM
        )


@dataclass
class RecChapter:
    """A named section of the recording, starting at ``t0`` and running to
    the next chapter (or the end)."""

    id: str
    t0: int
    title: str
    by: By = By.ROOM
    """ALWAYS present in JSON, same rule as ``RecNote.by``."""

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "t0": self.t0, "title": self.title, "by": self.by.value}

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "RecChapter":
        return RecChapter(
            id=d["id"], t0=d["t0"], title=d["title"], by=By(d["by"]) if d.get("by") is not None else By.ROOM
        )


@dataclass(frozen=True)
class RecCut:
    """A span deleted from the transcript. Playback skips it; "export edited
    copy" cuts it out of the audio for real. Kept separate from the words so
    the edit is non-destructive and undoable via file versions."""

    t0: int
    t1: int

    def to_dict(self) -> dict[str, Any]:
        return {"t0": self.t0, "t1": self.t1}

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "RecCut":
        return RecCut(t0=d["t0"], t1=d["t1"])


@dataclass
class ReadStamp:
    """The fingerprint of the transcript a reading pass was made from. Cheap
    and exact enough: any edit to the words moves one of the two numbers."""

    turns: int
    chars: int

    @staticmethod
    def of(segments: list[RecSegment]) -> "ReadStamp":
        # Rust's `s.text.len()` is a UTF-8 BYTE length, not Python's `len()`
        # (a code-point count) -- encode to match exactly.
        return ReadStamp(turns=len(segments), chars=sum(len(s.text.encode("utf-8")) for s in segments))

    def to_dict(self) -> dict[str, Any]:
        return {"turns": self.turns, "chars": self.chars}

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "ReadStamp":
        return ReadStamp(turns=d["turns"], chars=d["chars"])


@dataclass
class RecMeta:
    """A recording's stored metadata. Shape changes are handled by
    (de)serialization alone -- new fields carry a Python-side default and are
    read leniently, retired ones (there used to be a ``version`` counter
    nobody read) are simply ignored when an older room's JSON is parsed.
    There is no version dispatch, so nothing here may pretend there is one.
    """

    duration_cs: int = 0
    segments: list[RecSegment] = field(default_factory=list)
    cuts: list[RecCut] = field(default_factory=list)
    max_speakers: int = 0
    """How many meeting voices to tell apart. 0 (the default, and what the
    UI always sends) means "discover them" -- nobody is asked how many
    people are in the call. A non-zero value pins the count; older rooms
    that stored one keep it."""
    speaker_names: dict[str, str] = field(default_factory=dict)
    """GH #5: the human names, machine label -> what the user calls them
    ("Speaker 2" -> "Dana"). A ``BTreeMap`` in Rust -- serialized here with
    SORTED keys (see module docstring), omitted entirely when empty."""
    recognized: set[str] = field(default_factory=set)
    """Which of ``speaker_names`` the app GUESSED from a voice it had heard
    before, rather than the user typing them. A ``BTreeSet`` in Rust --
    serialized here sorted, omitted when empty."""
    chapters: list[RecChapter] = field(default_factory=list)
    highlights: list[RecHighlight] = field(default_factory=list)
    notes: list[RecNote] = field(default_factory=list)
    read_of: ReadStamp | None = None
    """The transcript the last reading pass was made from. ``None`` means
    never read; omit "readOf" entirely in that case."""

    def display_speaker(self, label: str) -> str:
        """What a speaker should be CALLED -- the user's name if they set
        one, else the machine label. Every user-visible rendering of a
        speaker goes through here so the screen and the file can't drift
        apart."""
        return self.speaker_names.get(label, label)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "durationCs": self.duration_cs,
            "segments": [s.to_dict() for s in self.segments],
            "cuts": [c.to_dict() for c in self.cuts],
            "maxSpeakers": self.max_speakers,
        }
        if self.speaker_names:
            d["speakerNames"] = {k: self.speaker_names[k] for k in sorted(self.speaker_names)}
        if self.recognized:
            d["recognized"] = sorted(self.recognized)
        if self.chapters:
            d["chapters"] = [c.to_dict() for c in self.chapters]
        if self.highlights:
            d["highlights"] = [h.to_dict() for h in self.highlights]
        if self.notes:
            d["notes"] = [n.to_dict() for n in self.notes]
        if self.read_of is not None:
            d["readOf"] = self.read_of.to_dict()
        return d

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "RecMeta":
        # duration_cs/segments/cuts have NO `#[serde(default)]` on the Rust
        # struct -- they are REQUIRED fields, so a missing key here raises
        # KeyError just as a Rust deserialize of the same JSON would fail.
        # Every other field carries `#[serde(default, ...)]` and is read
        # leniently below.
        raw_read_of = d.get("readOf")
        return RecMeta(
            duration_cs=d["durationCs"],
            segments=[RecSegment.from_dict(s) for s in d["segments"]],
            cuts=[RecCut.from_dict(c) for c in d["cuts"]],
            max_speakers=d.get("maxSpeakers", 0),
            speaker_names=dict(d.get("speakerNames", {})),
            recognized=set(d.get("recognized", [])),
            chapters=[RecChapter.from_dict(c) for c in d.get("chapters", [])],
            highlights=[RecHighlight.from_dict(h) for h in d.get("highlights", [])],
            notes=[RecNote.from_dict(n) for n in d.get("notes", [])],
            read_of=ReadStamp.from_dict(raw_read_of) if raw_read_of is not None else None,
        )


# ------------------------------------------------------------- pure helpers


def cs_of_samples(samples: int) -> int:
    """Samples (16 kHz) -> centiseconds."""
    # Rust: `(samples as i64) * 100 / SAMPLE_RATE as i64` -- truncating i64
    # division. For non-negative operands (samples is always >= 0 here),
    # Python's `//` (floor) and Rust's `/` (trunc toward zero) agree exactly.
    return samples * 100 // SAMPLE_RATE


def samples_of_cs(cs: int) -> int:
    """Centiseconds -> samples (16 kHz)."""
    return (max(cs, 0) * SAMPLE_RATE) // 100


def format_stamp(cs: int) -> str:
    """``[m:ss]`` or ``[h:mm:ss]`` -- minutes/seconds zero-padded to 2 digits
    when hours are shown; with no hours, seconds is still zero-padded but
    minutes is NOT (matches the Rust ``format!`` exactly: ``"{m}"``, not
    ``"{m:02}"``, in the no-hours branch)."""
    # Rust: `(cs / 100).max(0)` -- Rust's `/` truncates toward zero, Python's
    # `//` floors toward -inf. They can only disagree when cs is negative, in
    # which case both quotients are <= 0 and the following `max(..., 0)`
    # clamps either to the same 0 -- so plain `//` is safe here.
    s = max(cs // 100, 0)
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    if h > 0:
        return f"[{h}:{m:02d}:{sec:02d}]"
    return f"[{m}:{sec:02d}]"


def relabel_interval(elapsed_ms: int) -> int:
    """How many phrases to wait before the next whole-recording re-cluster,
    given how long the last one took (``ceil(elapsed_ms /
    RELABEL_TIME_BUDGET_MS)``, clamped to ``[RELABEL_EVERY_SEGMENTS,
    RELABEL_MAX_SEGMENTS]``)."""
    # Rust: `elapsed_ms.div_ceil(RELABEL_TIME_BUDGET_MS)`. `-(-a // b)` is the
    # standard ceiling-division identity for non-negative integers in Python
    # (elapsed_ms is always >= 0 here) and agrees with div_ceil(0, b) == 0.
    interval = -(-elapsed_ms // RELABEL_TIME_BUDGET_MS)
    return max(RELABEL_EVERY_SEGMENTS, min(RELABEL_MAX_SEGMENTS, interval))


def _words_of(text: str) -> set[str]:
    """Words, lowercased, punctuation dropped -- split on any
    non-alphanumeric character (Unicode-aware, matching Rust's
    ``!c.is_alphanumeric()``), empty tokens dropped. Whisper punctuates the
    same sound differently on a clean lane and on its echo."""
    words: set[str] = set()
    current: list[str] = []
    for ch in text.lower():
        if ch.isalnum():
            current.append(ch)
        elif current:
            words.add("".join(current))
            current = []
    if current:
        words.add("".join(current))
    return words


def text_overlap(a: str, b: str) -> float:
    """How much of the shorter phrase's vocabulary the longer one repeats.
    Uses the smaller set as the denominator (not the union) so a phrase
    heard whole on one lane and clipped on the other still matches."""
    wa, wb = _words_of(a), _words_of(b)
    smaller = min(len(wa), len(wb))
    if smaller == 0:
        return 0.0
    return len(wa & wb) / smaller


def time_overlap(a: tuple[int, int], b: tuple[int, int]) -> float:
    """Shared time as a fraction of the shorter span (centiseconds)."""
    shared = max(0, min(a[1], b[1]) - max(a[0], b[0]))
    shorter = max(1, min(a[1] - a[0], b[1] - b[0]))
    return shared / shorter


_NOTE_LABELS: dict[NoteKind, str] = {
    NoteKind.DECISION: "Decision",
    NoteKind.ACTION: "Action",
    NoteKind.QUESTION: "Open question",
    NoteKind.POINT: "Point",
}


def _note_line(n: RecNote) -> str:
    """One note as the transcript states it. Labelled by kind so a reader --
    human or model -- can tell a decision from an open question without
    guessing, and so "action items" is a searchable phrase."""
    label = _NOTE_LABELS[n.kind]
    if n.kind == NoteKind.ACTION and n.who:
        return f"{label} ({n.who}): {n.text}"
    return f"{label}: {n.text}"


def segment_visible_text(seg: RecSegment) -> str:
    """A segment's text with deleted words removed. Falls back to the raw
    text (stripped) when a segment has no word list (partial-only or legacy
    rows)."""
    if not seg.words:
        return seg.text.strip()
    kept = [w.w.strip() for w in seg.words if not w.del_]
    kept = [w for w in kept if w]
    return " ".join(kept)


def transcript_text(meta: RecMeta) -> str:
    """The searchable/actionable transcript stored as the file's extracted
    text -- the same "[m:ss] ..." contract the audio viewer, RAG index, and
    every AI action already consume. Deleted words are simply absent.

    Ported exactly against the Rust source's actual control flow: a
    segment's ``segment_visible_text`` is computed and checked FIRST -- an
    empty segment is skipped immediately, before any pending chapter/note is
    flushed against its ``t0``. A chapter/note anchored at-or-before an
    empty segment therefore is NOT flushed by that segment; it waits for the
    next non-empty one (or the final flush after the loop) to be emitted.
    ``meta.chapters``/``meta.notes`` are assumed already in ``t0`` order --
    this walks them with two index pointers rather than sorting, matching
    the Rust source's own assumption (``.iter().peekable()`` over the stored
    order).

    Highlights are marked, NOT repeated. A highlight is a pointer at words
    already on the line below it; copying them would put every marked
    sentence into the search index and into every AI prompt twice.
    """
    out: list[str] = ["(live recording)\n"]
    chapters = meta.chapters
    notes = meta.notes
    ci = 0
    ni = 0
    nc = len(chapters)
    nn = len(notes)
    for seg in meta.segments:
        text = segment_visible_text(seg)
        if not text:
            continue
        while ci < nc and chapters[ci].t0 <= seg.t0:
            c = chapters[ci]
            out.append(f"\n## {format_stamp(c.t0)} {c.title}\n")
            ci += 1
        while ni < nn and notes[ni].t0 <= seg.t0:
            n = notes[ni]
            out.append(f"{format_stamp(n.t0)} {_note_line(n)}\n")
            ni += 1
        marked = any(h.t0 < seg.t1 and seg.t0 < max(h.t1, h.t0 + 1) for h in meta.highlights)
        # The user's name for the speaker, when they set one (GH #5) -- this
        # text is what search and the AI read, so it has to match the
        # screen.
        who = meta.display_speaker(seg.speaker)
        mark = "* " if marked else ""
        out.append(f"{mark}{format_stamp(seg.t0)} {who}: {text}\n")
    # Anything anchored past the last phrase still belongs in the text.
    for c in chapters[ci:]:
        out.append(f"\n## {format_stamp(c.t0)} {c.title}\n")
    for n in notes[ni:]:
        out.append(f"{format_stamp(n.t0)} {_note_line(n)}\n")
    return "".join(out)


def add_cut(cuts: list[RecCut], new: RecCut) -> list[RecCut]:
    """Merge a new cut into the (sorted, disjoint) cut list, mutating
    ``cuts`` in place (matching Rust's ``&mut Vec<RecCut>``) and returning it
    too for convenience."""
    cuts.append(new)
    cuts.sort(key=lambda c: c.t0)
    merged: list[RecCut] = []
    for c in cuts:
        if merged and c.t0 <= merged[-1].t1:
            last = merged[-1]
            merged[-1] = RecCut(t0=last.t0, t1=max(last.t1, c.t1))
        else:
            merged.append(c)
    cuts[:] = merged
    return cuts


def cut_shift_before(cuts: list[RecCut], t: int) -> int:
    """How much cut time (cs) lies strictly before ``t`` -- the timestamp
    shift an exported (spliced) copy needs."""
    return sum(max(0, min(c.t1, t) - c.t0) for c in cuts)


def inside_cut(cuts: list[RecCut], t: int) -> bool:
    """Is ``t`` inside a deleted span? An annotation there points at words
    the exported copy no longer contains, so the copy drops it rather than
    carrying a note about nothing. The original keeps it -- cuts are
    undoable, and un-deleting a span must bring its notes back with it."""
    return any(c.t0 <= t < c.t1 for c in cuts)
