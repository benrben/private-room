#!/usr/bin/env python3

import argparse
import ast
import json
from pathlib import Path


def module_file(base: Path) -> Path | None:
    candidates = [base.with_suffix(".py"), base / "__init__.py"]
    return next((candidate for candidate in candidates if candidate.is_file()), None)


def relative_module_base(source: Path, level: int) -> Path:
    base = source.parent
    for _ in range(level - 1):
        base = base.parent
    return base


def import_targets(node: ast.ImportFrom, source: Path, package: Path) -> list[Path]:
    base = relative_module_base(source, node.level) if node.level else package
    if node.level == 0 and (not node.module or not node.module.startswith("arcelle_sidecar")):
        return []
    module = (node.module or "").removeprefix("arcelle_sidecar").lstrip(".")
    module_base = base / module.replace(".", "/") if module else base
    targets = [module_file(module_base)]
    for alias in node.names:
        targets.append(module_file(module_base / alias.name))
    return [target for target in targets if target and target.is_relative_to(package.parent)]


def collect(root: Path, source: Path) -> list[dict[str, object]]:
    package = source / "arcelle_sidecar"
    edges: list[dict[str, object]] = []
    for file in sorted(source.rglob("*.py")):
        tree = ast.parse(file.read_text(encoding="utf-8"), filename=str(file))
        relative_source = file.relative_to(root).as_posix()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                for target in import_targets(node, file, package):
                    edges.append(
                        {
                            "from": relative_source,
                            "to": target.relative_to(root).as_posix(),
                            "line": node.lineno,
                        }
                    )
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if not alias.name.startswith("arcelle_sidecar"):
                        continue
                    target = module_file(package / alias.name.removeprefix("arcelle_sidecar").lstrip(".").replace(".", "/"))
                    if target:
                        edges.append(
                            {
                                "from": relative_source,
                                "to": target.relative_to(root).as_posix(),
                                "line": node.lineno,
                            }
                        )
    return edges


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    arguments = parser.parse_args()
    print(json.dumps(collect(arguments.root.resolve(), arguments.source.resolve())))


main()
