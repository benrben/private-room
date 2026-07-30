#!/usr/bin/env python3
"""Audit Python source for Zen-of-Python violations that an AST can catch.

Covers the mechanical subset of references/review-checklist.md so the human
(or model) review can spend its attention on what a script can't judge:
naming, structure, and design. Findings are tiered like the checklist —
tier 1 is correctness, tier 2 structure, tier 3 idiom.

Usage:
    python zen_check.py PATH [PATH ...]        # files or directories
    python zen_check.py src/ --json            # machine-readable output
    python zen_check.py src/ --summary         # per-file counts only
    python zen_check.py src/ --max-tier 1      # only correctness findings

Exit status: 1 if any tier-1 finding exists, else 0 — safe to wire into CI.
Stdlib only; requires Python 3.10+.
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

LOG_METHODS = {"debug", "info", "warning", "error", "exception", "critical"}
MUTABLE_LITERALS = (ast.List, ast.Dict, ast.Set, ast.ListComp, ast.DictComp, ast.SetComp)
MAX_NESTING = 3
MAX_FUNCTION_LINES = 50


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    tier: int
    check: str
    message: str
    principle: str


class Auditor(ast.NodeVisitor):
    """One pass over one module; findings accumulate in self.findings."""

    def __init__(self, path: str, tree: ast.Module):
        self.path = path
        self.findings: list[Finding] = []
        self.parents: dict[ast.AST, ast.AST] = {
            child: parent
            for parent in ast.walk(tree)
            for child in ast.iter_child_nodes(parent)
        }
        self.shadowed_builtins = self._collect_shadowed(tree)
        self.reported_os_path = False

    # -- helpers ---------------------------------------------------------

    def add(self, node: ast.AST, tier: int, check: str, message: str, principle: str) -> None:
        self.findings.append(
            Finding(self.path, node.lineno, tier, check, message, principle)
        )

    @staticmethod
    def _collect_shadowed(tree: ast.Module) -> set[str]:
        """Names like `list` rebound somewhere in the module."""
        interesting = {"list", "dict", "tuple", "open", "zip", "range", "len"}
        shadowed = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Name, ast.arg)):
                name = node.id if isinstance(node, ast.Name) else node.arg
                stored = isinstance(node, ast.arg) or isinstance(
                    getattr(node, "ctx", None), ast.Store
                )
                if stored and name in interesting:
                    shadowed.add(name)
        return shadowed

    def _is_builtin_call(self, node: ast.Call, name: str) -> bool:
        return (
            isinstance(node.func, ast.Name)
            and node.func.id == name
            and name not in self.shadowed_builtins
        )

    @staticmethod
    def _dotted(node: ast.AST) -> str:
        parts = []
        while isinstance(node, ast.Attribute):
            parts.append(node.attr)
            node = node.value
        if isinstance(node, ast.Name):
            parts.append(node.id)
        return ".".join(reversed(parts))

    # -- exception handling ----------------------------------------------

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        is_bare = node.type is None
        caught = self._dotted(node.type) if node.type is not None else ""
        is_broad = is_bare or caught in {"Exception", "BaseException"}
        body_is_pass = len(node.body) == 1 and isinstance(node.body[0], ast.Pass)

        if is_bare:
            self.add(node, 1, "bare-except",
                     "bare `except:` also catches KeyboardInterrupt/SystemExit "
                     "— catch a specific exception",
                     "errors should never pass silently")
        if body_is_pass and not self._uses_suppress_style_comment(node):
            self.add(node, 1, "except-pass",
                     f"`except {caught or ''}: pass` swallows failures — "
                     "narrow it, log it, or use contextlib.suppress with a why-comment",
                     "unless explicitly silenced")
        elif is_broad and not is_bare and not self._handler_reraises_or_logs(node):
            self.add(node, 1, "swallowed-exception",
                     f"broad `except {caught}` neither re-raises nor logs — "
                     "failures vanish here",
                     "errors should never pass silently")

        for raise_node in (n for n in ast.walk(node) if isinstance(n, ast.Raise)):
            replaces = raise_node.exc is not None and isinstance(raise_node.exc, ast.Call)
            if replaces and raise_node.cause is None:
                self.add(raise_node, 1, "lost-traceback",
                         "raising a new exception inside a handler without "
                         "`from exc` discards the original traceback",
                         "errors should never pass silently")
        self.generic_visit(node)

    @staticmethod
    def _uses_suppress_style_comment(node: ast.ExceptHandler) -> bool:
        # AST carries no comments; narrow single-exception pass bodies are the
        # sanctioned shape, so only flag pass-bodies for bare/broad catches.
        caught = node.type
        return caught is not None and Auditor._dotted(caught) not in {
            "Exception", "BaseException",
        }

    @staticmethod
    def _handler_reraises_or_logs(node: ast.ExceptHandler) -> bool:
        for child in ast.walk(node):
            if isinstance(child, ast.Raise):
                return True
            if isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute):
                receiver = Auditor._dotted(child.func.value).lower()
                if child.func.attr in LOG_METHODS and "log" in receiver:
                    return True
        return False

    # -- functions --------------------------------------------------------

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._check_function(node)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._check_function(node)
        self.generic_visit(node)

    def _check_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        self._check_mutable_defaults(node)
        self._check_bool_positional(node)
        self._check_length(node)
        self._check_nesting(node)
        self._check_decorator_wraps(node)

    def _check_mutable_defaults(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        defaults = list(node.args.defaults) + [
            d for d in node.args.kw_defaults if d is not None
        ]
        for default in defaults:
            is_mutable = isinstance(default, MUTABLE_LITERALS) or (
                isinstance(default, ast.Call)
                and isinstance(default.func, ast.Name)
                and default.func.id in {"list", "dict", "set"}
            )
            if is_mutable:
                self.add(default, 1, "mutable-default",
                         f"mutable default in `{node.name}()` is created once and "
                         "shared across calls — use None and create per-call",
                         "explicit is better than implicit")

    def _check_bool_positional(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        positional = node.args.posonlyargs + node.args.args
        # defaults align with the tail of the positional args
        paired = zip(positional[len(positional) - len(node.args.defaults):],
                     node.args.defaults, strict=True)
        for arg, default in paired:
            if isinstance(default, ast.Constant) and isinstance(default.value, bool):
                self.add(default, 2, "bool-flag-param",
                         f"boolean `{arg.arg}` in `{node.name}()` can be passed "
                         "positionally — make it keyword-only (after `*`), or "
                         "split into two functions",
                         "special cases aren't special enough to break the rules")

    def _check_length(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        length = (node.end_lineno or node.lineno) - node.lineno + 1
        if length > MAX_FUNCTION_LINES:
            self.add(node, 2, "long-function",
                     f"`{node.name}()` is {length} lines — if it can't be described "
                     "in one sentence, split it",
                     "if the implementation is hard to explain, it's a bad idea")

    def _check_nesting(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        depth = _max_nesting(node.body)
        if depth > MAX_NESTING:
            self.add(node, 2, "deep-nesting",
                     f"`{node.name}()` nests {depth} levels — use guard clauses, "
                     "extract a function, or use a comprehension",
                     "flat is better than nested")

    def _check_decorator_wraps(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        returns_inner = {
            stmt.value.id
            for stmt in node.body
            if isinstance(stmt, ast.Return) and isinstance(stmt.value, ast.Name)
        }
        for stmt in node.body:
            if not isinstance(stmt, ast.FunctionDef) or stmt.name not in returns_inner:
                continue
            decorated = any("wraps" in self._dotted(d) or "wraps" in self._dotted(getattr(d, "func", d))
                            for d in stmt.decorator_list)
            takes_func = any(a.arg in {"func", "fn", "f", "wrapped"}
                             for a in node.args.args + node.args.posonlyargs)
            if takes_func and not decorated:
                self.add(stmt, 3, "missing-wraps",
                         f"`{node.name}` looks like a decorator; wrap `{stmt.name}` "
                         "with functools.wraps to preserve the target's identity",
                         "errors should never pass silently")

    # -- comparisons ------------------------------------------------------

    def visit_Compare(self, node: ast.Compare) -> None:
        if len(node.ops) == 1:
            self._check_singleton_compare(node)
            self._check_len_compare(node)
        self.generic_visit(node)

    def _check_singleton_compare(self, node: ast.Compare) -> None:
        comparator = node.comparators[0]
        if not isinstance(comparator, ast.Constant):
            return
        op = node.ops[0]
        if comparator.value is None and isinstance(op, (ast.Eq, ast.NotEq)):
            fix = "is None" if isinstance(op, ast.Eq) else "is not None"
            self.add(node, 1, "eq-none",
                     f"`== None` can be fooled by __eq__ — use `{fix}`",
                     "explicit is better than implicit")
        elif isinstance(comparator.value, bool) and isinstance(op, (ast.Eq, ast.NotEq)):
            self.add(node, 3, "eq-bool",
                     "comparing to True/False — test truthiness directly, "
                     "or `is True` in the rare case identity is meant",
                     "readability counts")

    def _check_len_compare(self, node: ast.Compare) -> None:
        is_len = (
            isinstance(node.left, ast.Call)
            and self._is_builtin_call(node.left, "len")
            and len(node.left.args) == 1
        )
        comparator = node.comparators[0]
        zero = isinstance(comparator, ast.Constant) and comparator.value == 0
        if is_len and zero and isinstance(node.ops[0], (ast.Eq, ast.NotEq, ast.Gt)):
            self.add(node, 3, "len-truthiness",
                     "`len(x) == 0` — empty containers are falsy; "
                     "use `if not x:` / `if x:`",
                     "readability counts")

    # -- calls ------------------------------------------------------------

    def visit_Call(self, node: ast.Call) -> None:
        self._check_open(node)
        self._check_zip_strict(node)
        self._check_naive_datetime(node)
        self._check_leftover_debug(node)
        self._check_lazy_logging(node)
        self._check_empty_constructor(node)
        self.generic_visit(node)

    def _check_open(self, node: ast.Call) -> None:
        if not self._is_builtin_call(node, "open"):
            return
        mode = next(
            (a.value for a in node.args[1:2] if isinstance(a, ast.Constant)),
            next((kw.value.value for kw in node.keywords
                  if kw.arg == "mode" and isinstance(kw.value, ast.Constant)), "r"),
        )
        is_text = isinstance(mode, str) and "b" not in mode
        has_encoding = any(kw.arg == "encoding" for kw in node.keywords)
        if is_text and not has_encoding:
            self.add(node, 1, "open-no-encoding",
                     "text-mode open() without encoding= uses the platform "
                     "default — pass encoding='utf-8'",
                     "explicit is better than implicit")
        parent = self.parents.get(node)
        if isinstance(parent, (ast.Assign, ast.AnnAssign)):
            self.add(node, 2, "open-outside-with",
                     "open() assigned to a variable — a `with` block guarantees "
                     "close on the failure path too",
                     "errors should never pass silently")
        elif isinstance(parent, (ast.Call, ast.Attribute)):
            self.add(node, 2, "open-never-closed",
                     "open() used inline — nothing closes this file "
                     "deterministically; use `with`",
                     "errors should never pass silently")

    def _check_zip_strict(self, node: ast.Call) -> None:
        if (
            self._is_builtin_call(node, "zip")
            and len(node.args) >= 2
            and not any(kw.arg == "strict" for kw in node.keywords)
        ):
            self.add(node, 3, "zip-not-strict",
                     "zip() silently truncates at the shorter input — pass "
                     "strict=True if the lengths should match",
                     "errors should never pass silently")

    def _check_naive_datetime(self, node: ast.Call) -> None:
        if not isinstance(node.func, ast.Attribute):
            return
        dotted = self._dotted(node.func)
        if "datetime" not in dotted and "date" not in dotted.split(".")[0]:
            return
        has_tz = bool(node.args) or any(kw.arg in {"tz", "tzinfo"} for kw in node.keywords)
        if node.func.attr == "utcnow" or (node.func.attr == "now" and not has_tz):
            self.add(node, 1, "naive-datetime",
                     f"`{dotted}()` returns a naive datetime — pass a timezone "
                     "(e.g. datetime.now(tz=timezone.utc))",
                     "in the face of ambiguity, refuse the temptation to guess")

    def _check_leftover_debug(self, node: ast.Call) -> None:
        if self._is_builtin_call(node, "breakpoint") or self._dotted(node.func) in {
            "pdb.set_trace", "ipdb.set_trace",
        }:
            self.add(node, 1, "leftover-debug",
                     "debugger call left in code",
                     "now is better than never — but clean up before shipping")

    def _check_lazy_logging(self, node: ast.Call) -> None:
        if not (isinstance(node.func, ast.Attribute) and node.func.attr in LOG_METHODS):
            return
        receiver = self._dotted(node.func.value).lower()
        first_is_fstring = bool(node.args) and isinstance(node.args[0], ast.JoinedStr)
        if "log" in receiver and first_is_fstring:
            self.add(node, 3, "fstring-logging",
                     "f-string in a logging call formats even when the level is "
                     "filtered out — use lazy %s args",
                     "practicality beats purity")

    def _check_empty_constructor(self, node: ast.Call) -> None:
        for name, literal in (("list", "[]"), ("dict", "{}"), ("tuple", "()")):
            if self._is_builtin_call(node, name) and not node.args and not node.keywords:
                self.add(node, 3, "constructor-not-literal",
                         f"`{name}()` — the literal `{literal}` is the obvious "
                         "spelling",
                         "there should be one obvious way to do it")

    # -- loops, operators, imports ----------------------------------------

    def visit_For(self, node: ast.For) -> None:
        it = node.iter
        if (
            isinstance(it, ast.Call)
            and self._is_builtin_call(it, "range")
            and len(it.args) == 1
            and isinstance(it.args[0], ast.Call)
            and self._is_builtin_call(it.args[0], "len")
        ):
            self.add(node, 3, "range-len",
                     "`for i in range(len(x))` — iterate directly, or use "
                     "enumerate() if the index is needed",
                     "there should be one obvious way to do it")
        self.generic_visit(node)

    def visit_BinOp(self, node: ast.BinOp) -> None:
        if isinstance(node.op, ast.Mult):
            for side in (node.left, node.right):
                if isinstance(side, ast.List) and any(
                    isinstance(elt, MUTABLE_LITERALS + (ast.BinOp,)) for elt in side.elts
                ):
                    self.add(node, 1, "mutable-aliasing",
                             "multiplying a list of mutables copies references — "
                             "every 'row' is the same object; use a comprehension",
                             "explicit is better than implicit")
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if any(alias.name == "*" for alias in node.names):
            self.add(node, 2, "wildcard-import",
                     f"`from {node.module} import *` makes every name "
                     "unattributable — import the module or specific names",
                     "namespaces are one honking great idea")
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if not self.reported_os_path and self._dotted(node).startswith("os.path."):
            self.reported_os_path = True
            self.add(node, 3, "os-path",
                     "os.path string surgery — pathlib.Path reads better and "
                     "composes with `/` (reported once per file)",
                     "there should be one obvious way to do it")
        self.generic_visit(node)


def _max_nesting(body: list[ast.stmt], depth: int = 0) -> int:
    deepest = depth
    for stmt in body:
        nested = isinstance(stmt, (ast.If, ast.For, ast.While, ast.With, ast.Try,
                                   ast.AsyncFor, ast.AsyncWith, ast.Match))
        child_depth = depth + 1 if nested else depth
        for field in ("body", "orelse", "finalbody"):
            children = getattr(stmt, field, [])
            if children and isinstance(children[0], ast.stmt):
                deepest = max(deepest, _max_nesting(children, child_depth))
        for handler in getattr(stmt, "handlers", []):
            deepest = max(deepest, _max_nesting(handler.body, child_depth))
        for case in getattr(stmt, "cases", []):
            deepest = max(deepest, _max_nesting(case.body, child_depth))
    return deepest


def audit_file(path: Path) -> list[Finding]:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (SyntaxError, UnicodeDecodeError) as exc:
        print(f"skipping {path}: {exc}", file=sys.stderr)
        return []
    auditor = Auditor(str(path), tree)
    auditor.visit(tree)
    return auditor.findings


# Also in zen_fix.py on purpose: each script stays standalone-runnable,
# which beats a shared import for a copy-around toolkit.
def collect_paths(raw: list[str]) -> list[Path]:
    files = []
    for entry in (Path(r) for r in raw):
        if entry.is_dir():
            files.extend(sorted(entry.rglob("*.py")))
        else:
            files.append(entry)
    return files


def render_text(findings: list[Finding]) -> str:
    lines = []
    for tier, title in ((1, "TIER 1 — correctness"), (2, "TIER 2 — structure"),
                        (3, "TIER 3 — idiom")):
        in_tier = [f for f in findings if f.tier == tier]
        if not in_tier:
            continue
        lines.append(f"\n{title} ({len(in_tier)})")
        lines.extend(
            f"  {f.path}:{f.line}: [{f.check}] {f.message}  ({f.principle})"
            for f in in_tier
        )
    return "\n".join(lines).lstrip("\n")


def render_summary(findings: list[Finding]) -> str:
    by_file: dict[str, list[int]] = {}
    for f in findings:
        by_file.setdefault(f.path, [0, 0, 0])[f.tier - 1] += 1
    rows = sorted(by_file.items(), key=lambda kv: kv[1], reverse=True)
    lines = [f"{'file':<50} t1  t2  t3"]
    lines.extend(f"{path:<50} {t1:>2}  {t2:>2}  {t3:>2}" for path, (t1, t2, t3) in rows)
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("paths", nargs="+", help="files or directories to audit")
    parser.add_argument("--json", action="store_true", help="JSON output")
    parser.add_argument("--summary", action="store_true", help="per-file counts only")
    parser.add_argument("--max-tier", type=int, default=3, choices=(1, 2, 3),
                        help="only report findings at or above this severity")
    args = parser.parse_args(argv)

    findings = [
        f
        for path in collect_paths(args.paths)
        for f in audit_file(path)
        if f.tier <= args.max_tier
    ]
    findings.sort(key=lambda f: (f.tier, f.path, f.line))

    if args.json:
        print(json.dumps([asdict(f) for f in findings], indent=2))
    elif args.summary:
        print(render_summary(findings) if findings else "clean")
    elif findings:
        print(render_text(findings))
        print(f"\n{len(findings)} finding(s).")
    else:
        print("clean — no mechanical findings (judgment checks still apply)")

    return 1 if any(f.tier == 1 for f in findings) else 0


if __name__ == "__main__":
    sys.exit(main())
