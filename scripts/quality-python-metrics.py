#!/usr/bin/env python3

import argparse
import ast
import json
from pathlib import Path


def is_function(node: ast.AST) -> bool:
    return isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))


class ComplexityVisitor(ast.NodeVisitor):
    def __init__(self, root: ast.AST) -> None:
        self.root = root
        self.complexity = 1

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        if node is self.root:
            self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        if node is self.root:
            self.generic_visit(node)

    def visit_Lambda(self, node: ast.Lambda) -> None:
        return

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        return

    def visit_If(self, node: ast.If) -> None:
        self.complexity += 1
        self.generic_visit(node)

    def visit_For(self, node: ast.For) -> None:
        self.complexity += 1
        self.generic_visit(node)

    def visit_AsyncFor(self, node: ast.AsyncFor) -> None:
        self.complexity += 1
        self.generic_visit(node)

    def visit_While(self, node: ast.While) -> None:
        self.complexity += 1
        self.generic_visit(node)

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        self.complexity += 1
        self.generic_visit(node)

    def visit_IfExp(self, node: ast.IfExp) -> None:
        self.complexity += 1
        self.generic_visit(node)

    def visit_BoolOp(self, node: ast.BoolOp) -> None:
        self.complexity += len(node.values) - 1
        self.generic_visit(node)

    def visit_Match(self, node: ast.Match) -> None:
        self.complexity += len(node.cases)
        self.generic_visit(node)

    def visit_comprehension(self, node: ast.comprehension) -> None:
        self.complexity += 1 + len(node.ifs)
        self.generic_visit(node)


def complexity(node: ast.AST) -> int:
    visitor = ComplexityVisitor(node)
    visitor.visit(node)
    return visitor.complexity


class FunctionCollector(ast.NodeVisitor):
    def __init__(self, root: Path, file: Path) -> None:
        self.root = root
        self.file = file
        self.scope: list[str] = []
        self.functions: list[dict[str, object]] = []

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.scope.append(node.name)
        self.generic_visit(node)
        self.scope.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.add_function(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self.add_function(node)

    def add_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        self.functions.append(
            {
                "path": self.file.relative_to(self.root).as_posix(),
                "name": ".".join([*self.scope, node.name]),
                "start_line": node.lineno,
                "end_line": node.end_lineno or node.lineno,
                "complexity": complexity(node),
                "parser": "python-ast",
            }
        )
        self.scope.append(node.name)
        self.generic_visit(node)
        self.scope.pop()


def collect(root: Path, source: Path) -> list[dict[str, object]]:
    functions: list[dict[str, object]] = []
    for file in sorted(source.rglob("*.py")):
        tree = ast.parse(file.read_text(encoding="utf-8"), filename=str(file))
        collector = FunctionCollector(root, file)
        collector.visit(tree)
        functions.extend(collector.functions)
    return functions


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    arguments = parser.parse_args()
    print(json.dumps(collect(arguments.root.resolve(), arguments.source.resolve())))


main()
