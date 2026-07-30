#!/usr/bin/env python3
"""Apply the provably-safe mechanical fixes from a zen_check audit.

Only rewrites where behavior is preserved for well-behaved code:

  * `x == None`  -> `x is None`      (and `!=` -> `is not`)
  * `list()` / `dict()` / `tuple()`  -> `[]` / `{}` / `()`   (empty, unshadowed)
  * `if len(x) == 0:` -> `if not x:` (and `!= 0` / `> 0` -> truthy)
      only when the comparison is the entire if/while test; skipped for
      objects that define __bool__ inconsistently with __len__ (rare, and
      that inconsistency is itself a bug).

Everything else zen_check reports — swallowed exceptions, nesting, naive
datetimes — needs a human or model decision, deliberately.

Usage:
    python zen_fix.py PATH [PATH ...]      # print a unified diff (no writes)
    python zen_fix.py PATH --apply         # write the fixes in place
    python zen_fix.py PATH --check         # exit 1 if anything would change

Stdlib only; requires Python 3.10+.
"""

from __future__ import annotations

import argparse
import ast
import difflib
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Edit:
    """A single-line surgical replacement, in 0-based line coordinates."""

    line: int
    col: int
    end_col: int
    replacement: str


class FixCollector(ast.NodeVisitor):
    def __init__(self, tree: ast.Module, source_lines: list[str]):
        self.lines = source_lines
        self.edits: list[Edit] = []
        self.parents: dict[ast.AST, ast.AST] = {
            child: parent
            for parent in ast.walk(tree)
            for child in ast.iter_child_nodes(parent)
        }
        self.shadowed = {
            node.id
            for node in ast.walk(tree)
            if isinstance(node, ast.Name)
            and isinstance(node.ctx, ast.Store)
            and node.id in {"list", "dict", "tuple", "len"}
        }

    # -- helpers ----------------------------------------------------------

    def _one_line(self, node: ast.AST) -> bool:
        return node.end_lineno == node.lineno

    def _source_of(self, node: ast.AST) -> str:
        return self.lines[node.lineno - 1][node.col_offset:node.end_col_offset]

    def _replace(self, node: ast.AST, replacement: str) -> None:
        self.edits.append(
            Edit(node.lineno - 1, node.col_offset, node.end_col_offset, replacement)
        )

    # -- fixes ------------------------------------------------------------

    def visit_Compare(self, node: ast.Compare) -> None:
        if len(node.ops) == 1 and self._one_line(node):
            self._fix_none_compare(node)
            self._fix_len_compare(node)
        self.generic_visit(node)

    def _fix_none_compare(self, node: ast.Compare) -> None:
        comparator = node.comparators[0]
        is_none = isinstance(comparator, ast.Constant) and comparator.value is None
        if not is_none or not isinstance(node.ops[0], (ast.Eq, ast.NotEq)):
            return
        left = self._source_of(node.left)
        op = "is" if isinstance(node.ops[0], ast.Eq) else "is not"
        self._replace(node, f"{left} {op} None")

    def _fix_len_compare(self, node: ast.Compare) -> None:
        parent = self.parents.get(node)
        is_whole_test = (
            isinstance(parent, (ast.If, ast.While)) and parent.test is node
        )
        left, op, comparator = node.left, node.ops[0], node.comparators[0]
        is_len_zero = (
            is_whole_test
            and isinstance(left, ast.Call)
            and isinstance(left.func, ast.Name)
            and left.func.id == "len"
            and "len" not in self.shadowed
            and len(left.args) == 1
            and isinstance(comparator, ast.Constant)
            and comparator.value == 0
        )
        if not is_len_zero:
            return
        subject = self._source_of(left.args[0])
        if isinstance(op, ast.Eq):
            self._replace(node, f"not {subject}")
        elif isinstance(op, (ast.NotEq, ast.Gt)):
            self._replace(node, subject)

    def visit_Call(self, node: ast.Call) -> None:
        literals = {"list": "[]", "dict": "{}", "tuple": "()"}
        if (
            self._one_line(node)
            and isinstance(node.func, ast.Name)
            and node.func.id in literals
            and node.func.id not in self.shadowed
            and not node.args
            and not node.keywords
        ):
            self._replace(node, literals[node.func.id])
        self.generic_visit(node)


def fix_source(source: str) -> str:
    """Return the fixed text (identical to input when nothing applies)."""
    tree = ast.parse(source)
    lines = source.splitlines(keepends=True)
    bare_lines = [line.rstrip("\r\n") for line in lines]
    collector = FixCollector(tree, bare_lines)
    collector.visit(tree)

    # Apply right-to-left so earlier offsets stay valid.
    for edit in sorted(collector.edits, key=lambda e: (e.line, e.col), reverse=True):
        line = lines[edit.line]
        lines[edit.line] = line[:edit.col] + edit.replacement + line[edit.end_col:]

    fixed = "".join(lines)
    ast.parse(fixed)  # a broken rewrite should crash here, not in the user's code
    return fixed


# Also in zen_check.py on purpose: each script stays standalone-runnable,
# which beats a shared import for a copy-around toolkit.
def collect_paths(raw: list[str]) -> list[Path]:
    files = []
    for entry in (Path(r) for r in raw):
        if entry.is_dir():
            files.extend(sorted(entry.rglob("*.py")))
        else:
            files.append(entry)
    return files


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("paths", nargs="+", help="files or directories to fix")
    parser.add_argument("--apply", action="store_true", help="write changes in place")
    parser.add_argument("--check", action="store_true",
                        help="no output; exit 1 if anything would change")
    args = parser.parse_args(argv)

    changed = []
    for path in collect_paths(args.paths):
        try:
            original = path.read_text(encoding="utf-8")
            fixed = fix_source(original)
        except (SyntaxError, UnicodeDecodeError) as exc:
            print(f"skipping {path}: {exc}", file=sys.stderr)
            continue
        if fixed == original:
            continue
        changed.append(path)
        if args.apply:
            path.write_text(fixed, encoding="utf-8")
        elif not args.check:
            diff = difflib.unified_diff(
                original.splitlines(keepends=True),
                fixed.splitlines(keepends=True),
                fromfile=str(path),
                tofile=f"{path} (fixed)",
            )
            sys.stdout.writelines(diff)

    if args.apply:
        print(f"fixed {len(changed)} file(s)" if changed else "nothing to fix")
    if args.check:
        return 1 if changed else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
