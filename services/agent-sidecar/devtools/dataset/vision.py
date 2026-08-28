"""Turn captured screenshots into a vision fine-tuning set.

    cd sidecar
    uv run python devtools/dataset/vision.py ask --set calibration
    uv run python devtools/dataset/vision.py check

Input is `data/vision/_shots.jsonl`, written by the capture run
(`npm run capture`), one line per PNG carrying what that PNG depicts — area,
visual state, theme, window size. Output is `data/vision/agent.jsonl` in the
requested layout:

    {"images": ["images/0001.png"], "question": "...", "answer": "..."}

with image paths relative to the jsonl, exactly as the trainer expects.

WHY THE MANIFEST MATTERS
------------------------
The teacher is shown the image, but it is also TOLD what the image is. Without
that it has to infer the room's state from pixels, and it infers wrong in the
one place accuracy matters most: an empty pane and a still-loading pane look
similar, and a failed one looks like either. Those three are exactly the states
the calibration set exists to prove are exercised, so mislabelling them would
defeat the purpose of capturing them.

ANSWER SHAPE
------------
The brief's sharpest warning is that answers which all follow one template
produce a model that has learned the template and a score that flatters it. One
prompt asking for "a question and an answer" reliably produces that — every
answer opens by naming the screen and closes with an offer to help.

So the ASK is rotated instead: each shot draws an archetype that forces a
different answer shape — a count, a location, a refusal, a walkthrough, a
judgement about what is missing. Shape variety is designed in here for the same
reason messiness is designed into the text corpus, rather than hoped for.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
DATA = ROOT / "data" / "vision"
SHOTS = DATA / "_shots.jsonl"
OUT = DATA / "agent.jsonl"

TEACHER = os.environ.get("ARCELLE_VISION_TEACHER", "sonnet")

#: Each archetype forces a DIFFERENT answer shape. The instruction says what the
#: answer must do, not how to word it — telling it to "be varied" produces
#: varied openings on an identical skeleton.
ARCHETYPES: list[tuple[str, str]] = [
    (
        "locate",
        "Ask where a specific control or piece of information is on this screen. "
        "The answer must give its position relative to other things a person can see "
        "(which pane, which edge, what it sits under), not just name it.",
    ),
    (
        "state",
        "Ask what is going on with this screen right now — is it working, waiting, "
        "broken, or simply empty. The answer must say WHICH of those it is and name "
        "the visible evidence that settles it.",
    ),
    (
        "count",
        "Ask how many of something is visible (files, rows, chips, items in a list). "
        "The answer must give the number and then list or characterise them, and say "
        "plainly if the list is cut off by the window edge rather than guessing a total.",
    ),
    (
        "why-disabled",
        "Ask why something appears greyed out, missing, or not doing anything. The "
        "answer must explain the reason from what is on screen, and say honestly if "
        "the screen does not show enough to know.",
    ),
    (
        "how-do-i",
        "Ask how to accomplish a task from this screen. The answer must walk through "
        "the actual steps using the labels visible in the image.",
    ),
    (
        "read-value",
        "Ask for a specific value shown on screen — a filename, a size, a date, a "
        "status, a model name. The answer must quote it exactly and say where it appears.",
    ),
    (
        "whats-missing",
        "Ask what is NOT here that the person expected. The answer must address the "
        "absence directly and explain what would put it there.",
    ),
    (
        "privacy",
        "Ask whether anything on this screen leaves the computer, or what the privacy "
        "indicator means. The answer must be grounded in what the screen actually "
        "claims, and must not overpromise beyond it.",
    ),
    (
        "navigate",
        "Ask to be taken somewhere else in the app. The answer must name the control "
        "to use and where it is, and say what will appear afterwards.",
    ),
    (
        "compare",
        "Ask about the difference between two things visible on this screen. The "
        "answer must contrast them concretely.",
    ),
    (
        "ambiguous",
        "Ask something genuinely ambiguous or under-specified, the way a person types "
        "when they are half-looking. The answer must resolve the ambiguity out loud — "
        "either by picking the most likely reading and saying so, or by asking the one "
        "question that would settle it.",
    ),
    (
        "explain-layout",
        "Ask what this screen is for, or what the panes are. The answer must describe "
        "the actual arrangement in the image.",
    ),
]

PROMPT = """You are helping build a training set for an assistant that lives INSIDE the \
app shown in the screenshot. The app is Arcelle: a local-first, encrypted \
workspace on a Mac where a person keeps files, recordings, notes and an AI that \
works over them.

Look at the image at {path}.

Here is what this screenshot is, so you do not have to guess:
{facts}

Write ONE question and ONE answer.

The question must be typed the way a REAL person types to an assistant while \
looking at this screen — lowercase is fine, typos are fine, shorthand and \
half-sentences are fine, no punctuation is fine. Do NOT write a polished or \
grammatical question. Never mention "the screenshot", "the image", or "this \
dataset" — the person is looking at their own app, not at a picture.

{archetype}

The answer must:
- be grounded ONLY in what is actually visible in the image
- be more than one sentence
- say plainly when the screen does not show enough to answer, instead of inventing
- NOT begin by restating the question or by naming the screen

Return ONLY this JSON, nothing else:
{{"question": "...", "answer": "..."}}"""


def facts_of(shot: dict) -> str:
    bits = [f"- window: {shot.get('w')}x{shot.get('h')}", f"- theme: {shot.get('theme')}"]
    if shot.get("area"):
        bits.append(f"- product area open: {shot.get('label') or shot['area']}")
    if shot.get("viewer"):
        bits.append(f"- a {shot['viewer']} file is open in the viewer: {shot.get('file')}")
    if shot.get("detail"):
        bits.append(f"- what is showing: {shot['detail']}")
    state = shot.get("state")
    if state == "empty":
        bits.append("- the room's data is EMPTY: panes show their empty states")
    elif state == "loading":
        bits.append("- the room's data is STILL LOADING: nothing has arrived yet")
    elif state == "error":
        bits.append("- the room's data FAILED to load: panes show an error")
    return "\n".join(bits)


def recover_json(text: str) -> dict | None:
    """The CLI fences JSON often enough that a strict parse loses good rows."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    try:
        v = json.loads(text)
        return v if isinstance(v, dict) else None
    except ValueError:
        pass
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            v = json.loads(m.group(0))
            if isinstance(v, dict):
                return v
        except ValueError:
            pass
    # Last resort: pull the two fields out directly. A real newline inside a
    # JSON string is invalid JSON but a perfectly good answer, and throwing the
    # row away over the model's punctuation wastes a paid call.
    q = re.search(r'"question"\s*:\s*"(.*?)"\s*,\s*"answer"', text, re.S)
    a = re.search(r'"answer"\s*:\s*"(.*)"\s*\}?\s*$', text, re.S)
    if q and a:
        unescape = lambda s: s.replace('\\"', '"').replace("\\n", "\n").strip()  # noqa: E731
        return {"question": unescape(q.group(1)), "answer": unescape(a.group(1))}
    return None


async def _one_call(prompt: str) -> tuple[str | None, str]:
    """One teacher call. Returns (result text, why-it-failed)."""
    # `Read` is the whole point: it is how the CLI actually opens the PNG. With
    # no tools it answers from the prompt alone and invents a plausible screen.
    cmd = (
        f"claude -p --output-format json --model '{TEACHER}' "
        f"--allowedTools 'Read' --strict-mcp-config"
    )
    proc = await asyncio.create_subprocess_exec(
        "zsh",
        "-ilc",
        cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate(prompt.encode("utf-8"))
    if proc.returncode != 0:
        return None, (err.decode()[:160] or out.decode()[:200])
    try:
        envelope = json.loads(out.decode("utf-8", "replace"))
    except ValueError:
        return None, "unparsable CLI envelope"
    if envelope.get("is_error"):
        return None, str(envelope.get("result"))[:160]
    return str(envelope.get("result") or ""), ""


async def ask_one(
    shot: dict, archetype: tuple[str, str], sem: asyncio.Semaphore, tries: int = 3
) -> dict | None:
    path = (DATA / shot["image"]).resolve()
    prompt = PROMPT.format(path=path, facts=facts_of(shot), archetype=archetype[1])
    qa: dict | None = None
    why = ""
    async with sem:
        # A reply that will not parse is TRANSIENT, not a property of the image:
        # the identical prompt on the identical PNG parsed cleanly on the next
        # attempt. Discarding it lost 2 of 12 sampled rows — and, worse, lost
        # them unevenly across archetypes, quietly reshaping the mix.
        for _ in range(tries):
            text, why = await _one_call(prompt)
            if text is None:
                continue
            qa = recover_json(text)
            if qa and qa.get("question") and qa.get("answer"):
                break
            qa, why = None, "no question/answer in reply"
    if qa is None:
        print(f"  skip {shot['image']}: {why}", file=sys.stderr)
        return None
    return {
        "images": [shot["image"]],
        "question": str(qa["question"]).strip(),
        "answer": str(qa["answer"]).strip(),
        # Kept for coverage auditing; harmless extra keys in a jsonl row.
        "meta": {k: shot.get(k) for k in ("kind", "area", "state", "theme", "viewer", "detail")},
        "archetype": archetype[0],
    }


async def run(shots: list[dict], per_image: int, concurrency: int) -> dict:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    done: set[tuple[str, str]] = set()
    if OUT.exists():
        for line in OUT.open(encoding="utf-8"):
            try:
                r = json.loads(line)
            except ValueError:
                continue
            done.add((r["images"][0], r.get("archetype", "")))

    jobs: list[tuple[dict, tuple[str, str]]] = []
    for i, shot in enumerate(shots):
        for j in range(per_image):
            # Rotate the archetype by BOTH position and repeat, so neighbouring
            # shots of the same screen do not all draw the same one.
            arch = ARCHETYPES[(i + j * 5) % len(ARCHETYPES)]
            if (shot["image"], arch[0]) not in done:
                jobs.append((shot, arch))

    sem = asyncio.Semaphore(max(1, concurrency))
    fh = OUT.open("a", encoding="utf-8")
    lock = asyncio.Lock()
    stats = {"kept": 0, "failed": 0}

    async def one(shot: dict, arch: tuple[str, str]) -> None:
        rec = await ask_one(shot, arch, sem)
        async with lock:
            if rec is None:
                stats["failed"] += 1
            else:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                stats["kept"] += 1
                if stats["kept"] % 20 == 0:
                    fh.flush()
                    print(f"  {stats['kept']}/{len(jobs)} rows", file=sys.stderr)

    try:
        await asyncio.gather(*(one(s, a) for s, a in jobs))
    finally:
        fh.close()
    return {"asked": len(jobs), "skipped_already_done": len(done), **stats}


def check() -> int:
    if not OUT.exists():
        print("no agent.jsonl yet")
        return 1
    rows, qs, short, bad = 0, set(), 0, 0
    missing_img = 0
    shapes: dict[str, int] = {}
    cover: dict[str, int] = {}
    for n, line in enumerate(OUT.open(encoding="utf-8"), 1):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except ValueError as e:
            print(f"line {n}: BAD JSON — {e}")
            bad += 1
            continue
        rows += 1
        q, a = r.get("question", ""), r.get("answer", "")
        if not q or not a:
            bad += 1
        qs.add(q.strip().lower())
        if len(a) < 150:
            short += 1
        for img in r.get("images", []):
            if not (DATA / img).exists():
                missing_img += 1
        shapes[r.get("archetype", "?")] = shapes.get(r.get("archetype", "?"), 0) + 1
        m = r.get("meta") or {}
        key = f"{m.get('kind')}/{m.get('state')}/{m.get('theme')}"
        cover[key] = cover.get(key, 0) + 1

    print(f"rows={rows}  unique_questions={len(qs)}  dupes={rows - len(qs)}")
    print(f"answers under 150 chars: {short}")
    print(f"malformed rows: {bad}   missing image files: {missing_img}")
    print(f"archetypes: {json.dumps(shapes, indent=2)}")
    print(f"coverage (kind/state/theme): {len(cover)} distinct buckets")
    for k in sorted(cover):
        print(f"   {k:<34} {cover[k]}")
    return 0 if (bad == 0 and missing_img == 0 and rows > 0) else 1


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("ask")
    a.add_argument("--per-image", type=int, default=1)
    a.add_argument("--concurrency", type=int, default=6)
    a.add_argument("--limit", type=int, default=0)
    sub.add_parser("check")
    args = ap.parse_args()

    if args.cmd == "check":
        sys.exit(check())

    if not SHOTS.exists():
        raise SystemExit(f"missing {SHOTS} — run `npm run capture` first")
    shots = [json.loads(x) for x in SHOTS.read_text(encoding="utf-8").splitlines() if x.strip()]
    if args.limit:
        shots = shots[: args.limit]
    res = asyncio.run(run(shots, args.per_image, args.concurrency))
    print(res)


if __name__ == "__main__":
    main()
