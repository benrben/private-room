"""Offline graph visualiser. No server, no browser, no LangSmith, no network.

    uv run --with grandalf python devtools/draw_graphs.py          # ascii to stdout
    uv run --with grandalf python devtools/draw_graphs.py --out ../docs/graphs

Writes one .mmd per graph. NEVER call draw_mermaid_png(): it defaults to
MermaidDrawMethod.API, which POSTs the graph to https://mermaid.ink.
"""
from __future__ import annotations

import argparse
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from arcelle_sidecar.graphs import MAIN_GRAPH  # noqa: E402


def all_graphs() -> dict[str, object]:
    # Every shape, so `draw_graphs.py > shapes.md` renders the whole roster.
    from arcelle_sidecar.graphs import TEMPLATES, build_agent_graph

    graphs: dict[str, object] = {"agent": MAIN_GRAPH}
    graphs.update({t: build_agent_graph(t) for t in TEMPLATES})
    try:  # per-agent subgraphs, once graph.py grows graph_for()
        from arcelle_sidecar.agents import REGISTRY
        from arcelle_sidecar.graph import graph_for

        for spec in REGISTRY:
            graphs[spec.id] = graph_for(spec.id)
    except ImportError:
        pass
    return graphs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=pathlib.Path, default=None)
    ap.add_argument("--ascii", action="store_true")
    args = ap.parse_args()

    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)

    for name, g in all_graphs().items():
        drawable = g.get_graph(xray=True)  # type: ignore[attr-defined]
        mermaid = drawable.draw_mermaid()
        if args.out:
            path = args.out / f"{name.replace('.', '_')}.mmd"
            path.write_text(mermaid, encoding="utf-8")
            print(f"wrote {path}")
        else:
            print(f"===== {name} =====")
            print(drawable.draw_ascii() if args.ascii else mermaid)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
