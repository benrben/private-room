#!/usr/bin/env python3
"""Find duplicated function bodies across a codebase by normalized-AST hash.

The one instrument no linter provides: the checklist's Tier-2 bullet
"duplicated logic in three or more places" is only findable by grep if you
already know the function's name. This hashes every function body with
positions stripped and docstrings dropped, so exact logic clones surface no
matter what they were renamed to or where they were pasted.

What counts as a clone here: identical AST after normalization — same
statements, same names inside. Renamed-variable near-clones are out of scope
on purpose; they need eyes, and false positives would erode trust in the tool.

Usage:
    python duplicates.py PATH [PATH ...]
    python duplicates.py src/ --min-statements 3
    python duplicates.py src/ --same-file          # also report within-file clones
    python duplicates.py src/ --json

Exit status: 1 if any clone group spans 2+ files (CI/test gate), else 0.
Stdlib only; requires Python 3.10+.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path

EXCLUDED_DIR_PARTS = {".git", ".venv", "venv", "node_modules", "__pycache__",
                      ".tox", ".eggs", "build", "dist"}


@dataclass(frozen=True)
class Site:
    path: str
    name: str
    line: int
    statements: int


def normalized_body(func: ast.FunctionDef | ast.AsyncFunctionDef) -> list[ast.stmt]:
    body = func.body
    has_docstring = (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    )
    return body[1:] if has_docstring else body


def body_hash(body: list[ast.stmt]) -> str:
    # include_attributes=False drops lineno/col, so layout and location
    # differences vanish and only the logic itself is hashed.
    dump = ast.dump(ast.Module(body=body, type_ignores=[]), include_attributes=False)
    return hashlib.sha256(dump.encode("utf-8")).hexdigest()[:16]


def collect_sites(paths: list[Path], min_statements: int) -> dict[str, list[Site]]:
    groups: dict[str, list[Site]] = {}
    for path in iter_python_files(paths):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except (SyntaxError, UnicodeDecodeError) as exc:
            print(f"skipping {path}: {exc}", file=sys.stderr)
            continue
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            body = normalized_body(node)
            if len(body) < min_statements:
                continue
            site = Site(str(path), node.name, node.lineno, len(body))
            groups.setdefault(body_hash(body), []).append(site)
    return groups


def iter_python_files(paths: list[Path]):
    for entry in paths:
        candidates = sorted(entry.rglob("*.py")) if entry.is_dir() else [entry]
        for candidate in candidates:
            if not EXCLUDED_DIR_PARTS.intersection(candidate.parts):
                yield candidate


def clone_groups(groups: dict[str, list[Site]], *, same_file: bool) -> list[list[Site]]:
    clones = []
    for sites in groups.values():
        if len(sites) < 2:
            continue
        spans_files = len({s.path for s in sites}) >= 2
        if spans_files or same_file:
            clones.append(sorted(sites, key=lambda s: (s.path, s.line)))
    # Biggest bodies first: more duplicated logic = more valuable finding.
    clones.sort(key=lambda sites: sites[0].statements, reverse=True)
    return clones


def render(clones: list[list[Site]]) -> str:
    lines = []
    for sites in clones:
        names = {s.name for s in sites}
        label = names.pop() if len(names) == 1 else "under different names"
        files = len({s.path for s in sites})
        lines.append(
            f"\n{len(sites)} copies of `{label}` "
            f"({sites[0].statements} statements, {files} file(s)):"
        )
        lines.extend(f"  {s.path}:{s.line}  {s.name}()" for s in sites)
    return "\n".join(lines).lstrip("\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("paths", nargs="+", help="files or directories to scan")
    parser.add_argument("--min-statements", type=int, default=3,
                        help="ignore bodies smaller than this (default 3)")
    parser.add_argument("--same-file", action="store_true",
                        help="also report clone groups within a single file")
    parser.add_argument("--json", action="store_true", help="JSON output")
    args = parser.parse_args(argv)

    groups = collect_sites([Path(p) for p in args.paths], args.min_statements)
    clones = clone_groups(groups, same_file=args.same_file)
    cross_file = [c for c in clones if len({s.path for s in c}) >= 2]

    if args.json:
        print(json.dumps(
            [[s.__dict__ for s in sites] for sites in clones], indent=2,
        ))
    elif clones:
        print(render(clones))
        print(f"\n{len(clones)} clone group(s), {len(cross_file)} spanning multiple files.")
    else:
        print("no duplicated function bodies found")

    return 1 if cross_file else 0


if __name__ == "__main__":
    sys.exit(main())
