"""Studio artifacts (MIGRATION Phase 2): flashcards / mind map / podcast script.

Ported verbatim from ``commands/studios{.rs,/flashcards.rs,/mindmap.rs,/podcast.rs}``.
Rust gathers the scope text from the encrypted DB and POSTs it here; this module owns
the whole COMPUTE — the prompts, the HTML-first-then-fallback orchestration, and the
built-in template renderers — and hands back the finished HTML (plus the structured
data when the fallback ran). Rust then saves + opens the returned HTML unchanged.

The pipeline mirrors ``run_studio`` exactly:

  1. Ask the model to AUTHOR one self-contained interactive HTML page (schema
     ``{html: string}``, temperature 0.4). If the reply is usable HTML, that IS the
     artifact — no structured extraction happens (``source == "authored"``).
  2. Only if that isn't usable HTML, FALL BACK to a structured extraction against the
     per-kind schema, then render the built-in Rust template from it
     (``source == "fallback"``).

Every model call reproduces ``ollama::chat_structured`` byte for byte: the schema is
appended to the last user turn (Ollama's ``format`` constrains the grammar but the
model never sees the schema), and the reply runs through ``recover_json`` (strip
``<think>`` spans, slice first bracket → last bracket) before parsing.

The renderers build STATIC markup (no ``<script>``) and HTML-escape all model text,
exactly like the Rust — the pages must render in WKWebView's script-blocked sandbox
and never inject live markup.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from .config import KEEP_ALIVE_WARM, _HIGH_RAM_BYTES, _total_ram_bytes
from .messages import Message


class StudioRequest(BaseModel):
    """Body of ``POST /studio`` (MIGRATION Phase 2).

    Rust gathers the scope text + label from the encrypted DB and posts them here;
    the sidecar owns the prompts, the HTML-first-then-fallback orchestration, and the
    template renderers. ``kind`` is flashcards|mindmap|podcast. ``instructions`` is the
    user's edited prompt (None/blank → the kind's default). ``label`` is the scope's
    display title (used in the prompts and as the fallback root/title default). The
    ``model`` is still resolved on the Rust side and named per request, like the
    Phase-1 gateway bodies.
    """

    model_config = ConfigDict(extra="ignore")

    kind: str
    text: str
    label: str = ""
    instructions: str | None = None
    model: str
    base_url: str = "http://127.0.0.1:11434"

# --- the model seam ---------------------------------------------------------
#
# The endpoint calls ``llm.generate`` (one non-streaming turn, raw text back).
# Typed here as a Protocol so a test can inject a scripted, queued generator and
# script "HTML fails → fallback succeeds" without a live model.


class GenerateFn(Protocol):
    async def __call__(
        self,
        model: str,
        messages: list[Message],
        base_url: str,
        *,
        temperature: float | None = None,
        num_ctx: int | None = None,
        keep_alive: str | None = None,
        format: dict[str, Any] | None = None,  # noqa: A002 - matches the Ollama arg name
        images: list[str] | None = None,
    ) -> str: ...


# --- shared prompt fragments (studios.rs) -----------------------------------

#: The default, user-editable instruction each Studio action runs with.
STUDIO_FLASHCARDS_PROMPT = "Make up to 12 flashcards that test real understanding of this material."
STUDIO_MINDMAP_PROMPT = "Build a mind map: one central topic and a short tree of the key ideas."
STUDIO_PODCAST_PROMPT = (
    "Write a two-host podcast script that discusses the key points in a natural back-and-forth."
)

#: Rules every model-authored Studio page must follow (studios.rs SELF_CONTAINED_HTML_RULES).
SELF_CONTAINED_HTML_RULES = (
    "Output ONE complete, self-contained HTML document and nothing else — no explanation, no "
    "markdown code fences. Put ALL CSS inside a <style> tag and ALL JavaScript inside a <script> "
    "tag in the same file. Use NO external resources whatsoever: no <link>, no <script src>, no "
    "CDN, no web fonts, no remote images, no fetch/XMLHttpRequest — the page runs offline in a "
    "sandbox and any network request silently fails. For images use inline SVG or a data: URI "
    "only. Make it a polished, responsive, dark-themed page: near-black background (#0b0b12), "
    "soft violet accent (#8b7cf6), light text, system font. Write correct JavaScript that runs "
    "on load with no errors."
)


def studio_instruction(supplied: str | None, default: str) -> str:
    """The user's edited prompt if non-blank, else the default (studios.rs)."""
    if supplied is not None:
        trimmed = supplied.strip()
        if trimmed:
            return trimmed
    return default


# --- JSON recovery (ollama.rs strip_think_spans / recover_json) --------------


def strip_think_spans(raw: str) -> str:
    """Drop ``<think>…</think>`` reasoning spans; an unterminated ``<think>``
    truncates the rest (ollama.rs strip_think_spans)."""
    out = raw
    while True:
        start = out.find("<think>")
        if start == -1:
            return out
        rel = out.find("</think>", start)
        if rel == -1:
            return out[:start]
        end = rel + len("</think>")
        out = out[:start] + out[end:]


def recover_json(text: str) -> str:
    """Slice the JSON payload out of a structured reply (ollama.rs recover_json):
    strip ``<think>``, then take from the first ``{``/``[`` to the last ``}``/``]``."""
    s = strip_think_spans(text.strip()).strip()
    a = _first_index(s, "{[")
    b = _last_index(s, "}]")
    if a is not None and b is not None and b >= a:
        return s[a : b + 1]
    return s


def _first_index(s: str, chars: str) -> int | None:
    for i, c in enumerate(s):
        if c in chars:
            return i
    return None


def _last_index(s: str, chars: str) -> int | None:
    for i in range(len(s) - 1, -1, -1):
        if s[i] in chars:
            return i
    return None


# --- JSON field pluckers (commands/json.rs) ----------------------------------


def _parse(raw: str) -> Any:
    try:
        return json.loads(raw.strip())
    except (ValueError, TypeError):
        return None


def json_str_field(raw: str, key: str) -> str | None:
    """The trimmed string at ``key``; ``None`` when absent/not-a-string (json.rs)."""
    obj = _parse(raw)
    if isinstance(obj, dict):
        v = obj.get(key)
        if isinstance(v, str):
            return v.strip()
    return None


def json_array(raw: str, key: str) -> list[Any]:
    """The array at ``key`` as a list; empty when absent (json.rs)."""
    obj = _parse(raw)
    if isinstance(obj, dict):
        v = obj.get(key)
        if isinstance(v, list):
            return v
    return []


def value_str(v: Any, key: str) -> str:
    """The trimmed string at ``key`` of an already-parsed object; ``""`` when absent."""
    if isinstance(v, dict):
        x = v.get(key)
        if isinstance(x, str):
            return x.strip()
    return ""


# --- HTML escaping (docs_html.rs html_escape) --------------------------------


def html_escape(s: str) -> str:
    """Escape text for literal HTML inclusion (docs_html.rs — &, <, >, " only)."""
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


# --- context window (ollama.rs num_ctx_for(false, Chat)) ---------------------


def num_ctx_for_studio() -> int:
    """The no-tools Chat-tier window studio's ``chat_structured`` sizes to
    (ollama.rs num_ctx_for(false, Chat)): 16384 on a 32 GB+ Mac, else 8192."""
    return 16384 if _total_ram_bytes() >= _HIGH_RAM_BYTES else 8192


# --- structured generation (ollama.rs chat_structured) -----------------------


async def _chat_structured(
    generate: GenerateFn,
    model: str,
    base_url: str,
    system: str,
    user: str,
    temperature: float,
    schema: dict[str, Any],
) -> str:
    """One structured turn, reproducing ``chat_structured``: append the schema to
    the last (only) user turn to ground the content, call the model, and recover
    the JSON from the reply. Returns the recovered JSON string (raw text otherwise)."""
    primed = (
        f"{user}\n\nReply with ONLY JSON matching this schema, filling every field with real "
        f"content:\n{json.dumps(schema, separators=(',', ':'))}"
    )
    messages: list[Message] = [
        {"role": "system", "content": system},
        {"role": "user", "content": primed},
    ]
    text = await generate(
        model,
        messages,
        base_url,
        temperature=temperature,
        num_ctx=num_ctx_for_studio(),
        keep_alive=KEEP_ALIVE_WARM,
        format=schema,
    )
    return recover_json(text)


# --- HTML-first authoring (studios.rs generate_studio_html/clean_studio_html) -

_HTML_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"html": {"type": "string"}},
    "required": ["html"],
}


def clean_studio_html(html: str) -> str | None:
    """Normalize model-authored HTML; ``None`` if it isn't a real page so the
    caller falls back to the built-in template (studios.rs clean_studio_html)."""
    h = html.strip()
    # Strip an accidental ```html … ``` fence despite the schema.
    if h.startswith("```"):
        rest = h[3:]
        if rest.startswith("html"):
            rest = rest[4:]
        h = rest.lstrip()
        idx = h.rfind("```")
        if idx != -1:
            h = h[:idx]
        h = h.strip()
    low = h.lower()
    looks_html = (
        "<html" in low
        or "<!doctype" in low
        or "<body" in low
        or "<style" in low
        or "<div" in low
    )
    # BYTE length, matching Rust's ``h.len()``.
    if len(h.encode("utf-8")) < 60 or not looks_html:
        return None
    if "<html" not in low:
        h = (
            '<!doctype html><html><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            f"</head><body>{h}</body></html>"
        )
    return h


async def _author_html(
    generate: GenerateFn,
    model: str,
    base_url: str,
    page_role: str,
    instr: str,
    label: str,
    text: str,
) -> str | None:
    """Ask the model to author a whole interactive HTML page; cleaned HTML or
    ``None`` when unusable (studios.rs generate_studio_html)."""
    system = f"{page_role}\n\n{SELF_CONTAINED_HTML_RULES}"
    user = f'{instr}\n\nBuild it only from this material about "{label}":\n\n{text}'
    raw = await _chat_structured(generate, model, base_url, system, user, 0.4, _HTML_SCHEMA)
    return clean_studio_html(json_str_field(raw, "html") or "")


# --- per-kind specs (flashcards.rs / mindmap.rs / podcast.rs) ----------------


@dataclass(frozen=True)
class StudioSpec:
    default_prompt: str
    page_role: str
    fallback_schema: dict[str, Any]
    fallback_system: str
    fallback_intro: str
    fallback_temp: float
    #: (recovered-JSON, label) -> (html, artifact-dict); raises StudioEmpty when
    #: the model returned nothing usable.
    render: Callable[[str, str], tuple[str, dict[str, Any]]]


class StudioEmpty(Exception):
    """The fallback extraction produced nothing usable — surfaced verbatim to the
    user (Rust ``Err(String)``). Returned as 422 ``{error, code: STUDIO_EMPTY}``."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message

    def response(self) -> JSONResponse:
        return JSONResponse(status_code=422, content={"error": self.message, "code": "STUDIO_EMPTY"})


# ---- flashcards -------------------------------------------------------------

_FLASHCARDS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "cards": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "q": {"type": "string"},
                    "a": {"type": "string"},
                    "hint": {"type": "string"},
                },
                "required": ["q", "a"],
            },
        }
    },
    "required": ["cards"],
}


def _fallback_flashcards(raw: str, label: str) -> tuple[str, dict[str, Any]]:
    cards: list[dict[str, str]] = []
    for c in json_array(raw, "cards"):
        q, a = value_str(c, "q"), value_str(c, "a")
        if q and a:
            cards.append({"q": q, "a": a, "hint": value_str(c, "hint")})
    if not cards:
        raise StudioEmpty("The model didn't return any usable flashcards — try a different file.")
    return render_flashcards_html(label, cards), {"cards": cards}


def render_flashcards_html(title: str, cards: list[dict[str, str]]) -> str:
    """Render a flashcard deck as static, script-free HTML (flashcards.rs)."""
    if not cards:
        cards_html = '<p class="empty">No cards were generated.</p>'
    else:
        parts: list[str] = []
        for i, c in enumerate(cards):
            hint_txt = c.get("hint", "")
            hint = "" if not hint_txt.strip() else f'<p class="hint">Hint: {html_escape(hint_txt)}</p>'
            parts.append(
                '<label class="card"><input type="checkbox" hidden>'
                '<span class="inner">'
                f'<span class="face front"><span class="tag">Q{i + 1}</span>'
                f'<span class="txt">{html_escape(c["q"])}</span>{hint}</span>'
                '<span class="face back"><span class="tag">Answer</span>'
                f'<span class="txt">{html_escape(c["a"])}</span></span></span></label>'
            )
        cards_html = "".join(parts)
    count = f"{len(cards)} card{'' if len(cards) == 1 else 's'}"
    return (
        FLASHCARDS_TEMPLATE.replace("__TITLE__", html_escape(title))
        .replace("__COUNT__", count)
        .replace("__CARDS__", cards_html)
    )


# ---- mind map ---------------------------------------------------------------

_MINDMAP_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "root": {"type": "string"},
        "nodes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"label": {"type": "string"}, "parent": {"type": "string"}},
                "required": ["label", "parent"],
            },
        },
    },
    "required": ["root", "nodes"],
}


def _fallback_mindmap(raw: str, label: str) -> tuple[str, dict[str, Any]]:
    root = json_str_field(raw, "root") or ""
    if not root:
        root = label.strip()
    nodes: list[dict[str, str]] = []
    for n in json_array(raw, "nodes"):
        lab = value_str(n, "label")
        if lab:
            nodes.append({"label": lab, "parent": value_str(n, "parent")})
    if not nodes:
        raise StudioEmpty("The model didn't return a usable mind map — try a different file.")
    return render_mindmap_html(label, root, nodes), {"root": root, "nodes": nodes}


def render_mindmap_html(title: str, root: str, nodes: list[dict[str, str]]) -> str:
    """Render a collapsible mind map as static nested <details> (mindmap.rs)."""
    kids: dict[str, list[str]] = {}
    for n in nodes:
        parent = n["parent"].strip() or root
        if n["label"] != parent:
            kids.setdefault(parent, []).append(n["label"])

    def node_html(label: str, depth: int, seen: set[str]) -> str:
        esc = html_escape(label)
        # Guard against runaway depth and parent/child cycles from a bad tree.
        if depth > 8 or label in seen:
            return f'<span class="leaf">{esc}</span>'
        seen.add(label)
        children = kids.get(label, [])
        if not children:
            out = f'<span class="leaf">{esc}</span>'
        else:
            open_attr = " open" if depth < 2 else ""
            inner = "".join(f"<li>{node_html(c, depth + 1, seen)}</li>" for c in children)
            out = f"<details{open_attr}><summary>{esc}</summary><ul>{inner}</ul></details>"
        seen.discard(label)
        return out

    tree = f'<ul class="tree"><li>{node_html(root, 0, set())}</li></ul>'
    return MINDMAP_TEMPLATE.replace("__TITLE__", html_escape(title)).replace("__TREE__", tree)


# ---- podcast ----------------------------------------------------------------

_PODCAST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "turns": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"speaker": {"type": "string"}, "line": {"type": "string"}},
                "required": ["speaker", "line"],
            },
        },
    },
    "required": ["title", "turns"],
}


def _fallback_podcast(raw: str, label: str) -> tuple[str, dict[str, Any]]:
    title = json_str_field(raw, "title") or ""
    if not title:
        title = label.strip()
    turns: list[dict[str, str]] = []
    for t in json_array(raw, "turns"):
        line = value_str(t, "line")
        if line:
            speaker = value_str(t, "speaker") or "Host"
            turns.append({"speaker": speaker, "line": line})
    if not turns:
        raise StudioEmpty("The model didn't return a usable script — try a different file.")
    return render_podcast_html(title, turns), {"title": title, "turns": turns}


def render_podcast_html(title: str, turns: list[dict[str, str]]) -> str:
    """Render a two-host podcast script as a static transcript (podcast.rs)."""
    rows: list[str] = []
    speakers: list[str] = []
    for t in turns:
        if t["speaker"] not in speakers:
            speakers.append(t["speaker"])
        side = "a" if speakers and speakers[0] == t["speaker"] else "b"
        rows.append(
            f'<div class="turn {side}"><div class="who">{html_escape(t["speaker"])}</div>'
            f'<div class="line">{html_escape(t["line"])}</div></div>\n'
        )
    return PODCAST_TEMPLATE.replace("__TITLE__", html_escape(title)).replace("__ROWS__", "".join(rows))


# --- the specs table ---------------------------------------------------------

_SPECS: dict[str, StudioSpec] = {
    "flashcards": StudioSpec(
        default_prompt=STUDIO_FLASHCARDS_PROMPT,
        page_role=(
            "You are a front-end developer building an interactive flashcards study page. Show a "
            "deck of cards the reader flips (click, or Space/Enter, or the arrow keys) to reveal the "
            "answer, with an optional hint, a card counter, and next/previous controls. Base every "
            "card only on the provided material — test real understanding, not formatting trivia."
        ),
        fallback_schema=_FLASHCARDS_SCHEMA,
        fallback_system=(
            "You turn study material into flashcards. Write clear question/answer pairs (and a short "
            "optional hint) that test understanding of the material — not trivia about its "
            "formatting. Base every card only on the provided text."
        ),
        fallback_intro="Base every card only on this material about",
        fallback_temp=0.3,
        render=_fallback_flashcards,
    ),
    "mindmap": StudioSpec(
        default_prompt=STUDIO_MINDMAP_PROMPT,
        page_role=(
            "You are a front-end developer building an interactive mind-map page. Draw one central "
            "topic with a tree of branches; let the reader expand and collapse nodes by clicking, "
            "and gently pan the canvas if you can. Keep labels short. Base it only on the provided "
            "material."
        ),
        fallback_schema=_MINDMAP_SCHEMA,
        fallback_system=(
            "You organize material into a mind map: one central root topic and a tree of nodes, each "
            "naming its parent (the root, or another node's exact label). Keep labels short. Base it "
            "only on the provided text."
        ),
        fallback_intro="Base it only on this material about",
        fallback_temp=0.3,
        render=_fallback_mindmap,
    ),
    "podcast": StudioSpec(
        default_prompt=STUDIO_PODCAST_PROMPT,
        page_role=(
            "You are a front-end developer building a podcast transcript page for a warm, two-host "
            "conversation that explains the material. Style each speaker's turns distinctly (name + "
            "line), keep it readable, and add a small note that spoken audio is coming in a later "
            "version. Base every line only on the provided material."
        ),
        fallback_schema=_PODCAST_SCHEMA,
        fallback_system=(
            "You write a short two-host podcast script that explains material in a warm, "
            "conversational back-and-forth. Use two recurring host names as speakers. Keep each turn "
            "to a couple of sentences. Base everything on the provided text."
        ),
        fallback_intro="Base it only on this material about",
        fallback_temp=0.5,
        render=_fallback_podcast,
    ),
}


# --- the endpoint's work (studios.rs run_studio, minus DB + save + cancel) ---


@dataclass
class StudioResult:
    html: str
    data: dict[str, Any]


async def run_studio(req: StudioRequest, generate: GenerateFn) -> StudioResult:
    """The shared studio pipeline: author an HTML page, and only if that isn't
    usable HTML, extract structured data and render the built-in template.

    ``req`` carries ``kind``/``text``/``label``/``instructions``/``model``/``base_url``.
    Raises :class:`StudioEmpty` on an unusable fallback and propagates
    :class:`llm.LlmError` on an engine failure.
    """
    spec = _SPECS.get(req.kind)
    if spec is None:
        raise StudioEmpty(f"Unknown studio kind: {req.kind}")
    instr = studio_instruction(req.instructions, spec.default_prompt)

    html = await _author_html(
        generate, req.model, req.base_url, spec.page_role, instr, req.label, req.text
    )
    if html is not None:
        return StudioResult(html=html, data={"kind": req.kind, "source": "authored", "artifact": None})

    # Fallback: structured extraction rendered by the built-in template.
    user = f'{instr}\n\n{spec.fallback_intro} "{req.label}":\n\n{req.text}'
    raw = await _chat_structured(
        generate,
        req.model,
        req.base_url,
        spec.fallback_system,
        user,
        spec.fallback_temp,
        spec.fallback_schema,
    )
    rendered, artifact = spec.render(raw, req.label)
    return StudioResult(
        html=rendered, data={"kind": req.kind, "source": "fallback", "artifact": artifact}
    )


# --- the built-in templates (verbatim from the Rust) -------------------------

FLASHCARDS_TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__ — Flashcards</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--surface:#fff;--surface-2:#eef0f4;--fg:#191b1f;--muted:#63697a;--accent:#6d5cf0;--accent-2:#8b7cf6;--border:#e6e7ee;--radius:16px}
@media (prefers-color-scheme:dark){:root{--bg:#0e1014;--surface:#161a22;--surface-2:#1c212c;--fg:#e8eaf0;--muted:#8b93a7;--accent:#8b7cf6;--accent-2:#a99df8;--border:#232a37}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:52rem;margin:0 auto;padding:2.5rem 1.25rem}
.eyebrow{font-size:.72rem;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--accent)}
h1{font-size:1.9rem;margin:.25rem 0 .25rem;letter-spacing:-.02em}
.sub{color:var(--muted);font-size:.9rem;margin:0 0 1.5rem}
.deck{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:1rem}
.card{display:block;height:12rem;perspective:1200px;cursor:pointer}
.card .inner{position:relative;display:block;width:100%;height:100%;transition:transform .5s;transform-style:preserve-3d}
.card input:checked + .inner{transform:rotateY(180deg)}
.face{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);box-shadow:0 12px 30px rgba(24,24,60,.08);padding:1.3rem;display:flex;flex-direction:column;justify-content:center;text-align:center;overflow:auto}
.back{transform:rotateY(180deg);background:var(--surface-2)}
.tag{font-size:.62rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin-bottom:.5rem}
.txt{font-size:1.05rem}
.hint{margin:.6rem 0 0;font-size:.8rem;color:var(--muted)}
.tip{text-align:center;color:var(--muted);font-size:.82rem;margin:1.25rem 0 0}
.empty{text-align:center;color:var(--muted);padding:3rem 0}
</style>
</head>
<body>
<main class="wrap">
  <div class="eyebrow">Flashcards</div>
  <h1>__TITLE__</h1>
  <p class="sub">__COUNT__ · click a card to flip it</p>
  <div class="deck">__CARDS__</div>
  <p class="tip">Every answer is grounded in this room's files.</p>
</main>
</body>
</html>
"""

MINDMAP_TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__ — Mind map</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--surface:#fff;--surface-2:#eef0f4;--fg:#191b1f;--muted:#63697a;--accent:#6d5cf0;--accent-2:#8b7cf6;--border:#e6e7ee}
@media (prefers-color-scheme:dark){:root{--bg:#0e1014;--surface:#161a22;--surface-2:#1c212c;--fg:#e8eaf0;--muted:#8b93a7;--accent:#8b7cf6;--accent-2:#a99df8;--border:#232a37}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:50rem;margin:0 auto;padding:2.5rem 1.25rem}
.eyebrow{font-size:.72rem;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--accent)}
h1{font-size:1.9rem;margin:.25rem 0 1.5rem;letter-spacing:-.02em}
ul{list-style:none;margin:0;padding-left:1.4rem;border-left:2px solid var(--border)}
ul.tree{border-left:none;padding-left:0}
li{margin:.4rem 0}
details{display:block}
summary,.leaf{display:inline-flex;align-items:center;gap:.5rem;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:.4rem .7rem;box-shadow:0 4px 14px rgba(24,24,60,.05);list-style:none;margin:.1rem 0}
summary{cursor:pointer}
summary::-webkit-details-marker{display:none}
summary::before{content:'\25B8';color:var(--muted);font-size:.85rem;transition:transform .15s}
details[open]>summary::before{transform:rotate(90deg)}
ul.tree>li>details>summary,ul.tree>li>.leaf{background:var(--accent);color:#fff;border-color:transparent;font-weight:650}
ul.tree>li>details>summary::before{color:rgba(255,255,255,.85)}
</style>
</head>
<body>
<main class="wrap">
  <div class="eyebrow">Mind map</div>
  <h1>__TITLE__</h1>
  __TREE__
</main>
</body>
</html>
"""

PODCAST_TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__ — Podcast script</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--surface:#fff;--surface-2:#eef0f4;--fg:#191b1f;--muted:#63697a;--accent:#6d5cf0;--accent-2:#8b7cf6;--border:#e6e7ee}
@media (prefers-color-scheme:dark){:root{--bg:#0e1014;--surface:#161a22;--surface-2:#1c212c;--fg:#e8eaf0;--muted:#8b93a7;--accent:#8b7cf6;--accent-2:#a99df8;--border:#232a37}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:44rem;margin:0 auto;padding:2.5rem 1.25rem}
.eyebrow{font-size:.72rem;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--accent)}
h1{font-size:1.9rem;margin:.25rem 0 .5rem;letter-spacing:-.02em}
.note{background:var(--surface-2);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:12px;padding:.7rem .9rem;color:var(--muted);font-size:.9rem;margin:1rem 0 1.75rem}
.turn{display:flex;gap:.8rem;margin:.9rem 0}
.turn .who{flex:none;width:6.5rem;text-align:right;font-weight:650;color:var(--accent);font-size:.92rem;padding-top:.55rem}
.turn.b .who{color:var(--accent-2)}
.turn .line{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:.55rem .9rem;box-shadow:0 4px 14px rgba(24,24,60,.05)}
.turn.b .line{background:var(--surface-2)}
</style>
</head>
<body>
<main class="wrap">
  <div class="eyebrow">Podcast script</div>
  <h1>__TITLE__</h1>
  <div class="note">Audio narration is coming in a later version — this is the script.</div>
  __ROWS__
</main>
</body>
</html>
"""


__all__ = [
    "GenerateFn",
    "StudioRequest",
    "StudioSpec",
    "StudioResult",
    "StudioEmpty",
    "run_studio",
    "clean_studio_html",
    "recover_json",
    "strip_think_spans",
    "render_flashcards_html",
    "render_mindmap_html",
    "render_podcast_html",
    "studio_instruction",
    "num_ctx_for_studio",
    "STUDIO_FLASHCARDS_PROMPT",
    "STUDIO_MINDMAP_PROMPT",
    "STUDIO_PODCAST_PROMPT",
    "SELF_CONTAINED_HTML_RULES",
]
