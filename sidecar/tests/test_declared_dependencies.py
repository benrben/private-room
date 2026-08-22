"""Every third-party package the sidecar IMPORTS must be one it DECLARES.

An undeclared import works right up until the transitive edge that happened to
supply it moves. Then a fresh `uv sync` succeeds, the app builds, every test
that runs against the developer's existing environment stays green — and the
feature behind the import dies at first use on a clean machine. `ollama` was in
exactly that position: `llm.py` and `chat.py` import it directly and only
`langchain-ollama` was pulling it in.
"""

from __future__ import annotations

import ast
import re
import sys
import tomllib
from pathlib import Path

SIDECAR = Path(__file__).resolve().parent.parent
PACKAGE = SIDECAR / "arcelle_sidecar"

#: Distribution name for the few imports whose module name differs from it.
IMPORT_TO_DISTRIBUTION = {
    "bs4": "beautifulsoup4",
    "PIL": "pillow",
    "edge_tts": "edge-tts",
    "langchain_core": "langchain-core",
    "langchain_ollama": "langchain-ollama",
    "langgraph": "langgraph",
    "yaml": "pyyaml",
    # The compiled C-extension module name, not a separate PyPI package.
    "_pywhispercpp": "pywhispercpp",
    # PyObjC: each framework's Python import name differs from its
    # "pyobjc-framework-*" distribution name; AppKit/Foundation/objc are all
    # provided by the two base packages (pyobjc-core, pyobjc-framework-cocoa).
    "objc": "pyobjc-core",
    "AppKit": "pyobjc-framework-cocoa",
    "Foundation": "pyobjc-framework-cocoa",
    "Vision": "pyobjc-framework-vision",
    "Quartz": "pyobjc-framework-quartz",
    "AVFoundation": "pyobjc-framework-avfoundation",
    "CoreMedia": "pyobjc-framework-coremedia",
    "QuickLookThumbnailing": "pyobjc-framework-quicklookthumbnailing",
    # odfpy's own top-level package is literally named "odf".
    "odf": "odfpy",
    "charset_normalizer": "charset-normalizer",
}


def _top_level_imports() -> set[str]:
    """Every top-level module name imported anywhere in the package."""
    names: set[str] = set()
    for path in PACKAGE.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                names.add(node.module.split(".")[0])
    return names


def _declared() -> set[str]:
    data = tomllib.loads((SIDECAR / "pyproject.toml").read_text(encoding="utf-8"))
    deps = data["project"]["dependencies"]
    return {re.split(r"[<>=!~\[ ]", d, maxsplit=1)[0].strip().lower() for d in deps}


def test_every_third_party_import_is_declared() -> None:
    declared = _declared()
    missing = set()
    for name in _top_level_imports():
        if name in sys.stdlib_module_names or name == "arcelle_sidecar":
            continue
        dist = IMPORT_TO_DISTRIBUTION.get(name, name).lower()
        if dist not in declared:
            missing.add(f"{name} (needs '{dist}' in pyproject dependencies)")
    assert not missing, f"imported but not declared: {sorted(missing)}"


def test_the_ollama_client_is_declared() -> None:
    # Named on its own because this is the one that was actually missing, and
    # the generic check above would go quiet again if the import were ever
    # spelled differently.
    assert "ollama" in _declared()
