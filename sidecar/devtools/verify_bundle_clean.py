"""Assert the shipped PyInstaller bundle contains no Studio/dev tooling.

Run AFTER build-sidecar.sh, against the staged tree the release signs:
    uv run --with pyinstaller python devtools/verify_bundle_clean.py \
        ../src-tauri/resources/sidecar/arcelle-sidecar/arcelle-sidecar
"""
from __future__ import annotations
import sys
import tempfile
import os
from PyInstaller.archive.readers import CArchiveReader, ZlibArchiveReader

FORBIDDEN_ROOTS = {
    "langgraph_cli", "langgraph_api", "langgraph_runtime_inmem",
    "langgraph_license", "devtools", "studio", "studio_graphs",
}

def modules(exe: str) -> list[str]:
    c = CArchiveReader(exe)
    pyz_name = [n for n, e in c.toc.items() if e[4] == "z"][0]
    raw = c.extract(pyz_name)
    fd, tmp = tempfile.mkstemp(suffix=".pyz")
    with os.fdopen(fd, "wb") as fh:
        fh.write(raw)
    try:
        return sorted(ZlibArchiveReader(tmp).toc)
    finally:
        os.unlink(tmp)

def main() -> int:
    exe = sys.argv[1] if len(sys.argv) > 1 else "dist/arcelle-sidecar/arcelle-sidecar"
    mods = modules(exe)
    bad = sorted({m.split(".")[0] for m in mods if m.split(".")[0] in FORBIDDEN_ROOTS})
    print(f"{len(mods)} modules in PYZ; {len([m for m in mods if m.startswith('arcelle_sidecar')])} arcelle_sidecar")
    has_langsmith = any(m == "langsmith" for m in mods)
    print(f"langsmith SDK present (expected True — langchain-core pulls it; disable_tracing() is what neuters it): {has_langsmith}")
    if bad:
        print(f"FAIL: dev/Studio packages in the shipped bundle: {bad}")
        return 1
    print("PASS: no langgraph-cli / langgraph-api / devtools in the bundle")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
