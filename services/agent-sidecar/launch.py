"""PyInstaller entry point.

PyInstaller runs its target as the top-level ``__main__`` script, which strips
the package context and breaks ``arcelle_sidecar/__main__.py``'s relative
imports (``from . import ...``). Bundling this thin launcher instead keeps the
real module a proper submodule (``arcelle_sidecar.__main__``), so its
relative imports resolve. Dev/tests still use ``python -m arcelle_sidecar``.
"""

import sys

from arcelle_sidecar.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
