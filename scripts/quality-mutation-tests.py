"""Run tests related to the source file changed by the quality mutant.

The portable mutation adapter exposes only the mutant id. Immutable baseline
hashes identify the one source file changed inside each isolated worker. A
baseline invocation still runs both complete assertion-bearing suites.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "apps" / "desktop"
SIDECAR = ROOT / "services" / "agent-sidecar"

SOURCE_HASHES = {
    "apps/desktop/src/main/bootstrapElectron.ts": "28ac3224a61647c88d3dbb1efe154515dee12c45f6e190cfef2e7ea1f2879473",
    "apps/desktop/src/main/bridgeCatalog.ts": "cb8a630ebcbe458ed6d9e07a9b396e52e3b75b811e7e656d30ce472e02d2bebb",
    "apps/desktop/src/main/execToolDispatch.ts": "054a2a57bdd6cb7e26a1e973de2c08f26c4c3c751be2c58e5874e611e6932afd",
    "apps/desktop/src/main/execToolDispatchCore.ts": "6fe121f74187c28f3ea2de39f6fe02a6be2b2bc764cabf9e0679c8b9e213a5f8",
    "apps/desktop/src/main/execToolEffects.ts": "715406c128fd51b1a11f7f745d66ac1213088ec9e934e6a2bb359a32b65e4699",
    "apps/desktop/src/main/toolSchema.ts": "8b53c361185d7140cfee505398efe73e99e150aabd33bb8e05866047ef764b06",
    "apps/desktop/src/main/toolSpecs.ts": "7d9f794ce944cd8b920b5d98596846acc5cfe23eca0fab968c367bec8ab977e2",
    "apps/desktop/src/main/toolSpecsCatalog.ts": "1a46925478381fc1b115fde996cf695bc17e3415c93d7a8b17c3be1dba1082e7",
    "apps/desktop/src/main/toolSpecsSkin.ts": "0895dc6ddca39a69d7f6dc735a8d51791bcc3bdb850ed2e010417b0b7244ba64",
    "apps/desktop/src/main/toolSpecsTypes.ts": "859babad8d6c4349195e06c60670070786b6717afdac7cfbdb74c6046a0c0fa3",
    "apps/desktop/src/renderer/agent/driver.ts": "8674871ea2fbaaaab9b9fbc2b162b7169a9ee77fbfd99fbe0d48a3cac6eabba3",
    "apps/desktop/src/renderer/main.tsx": "082e971026161fc1258007002c3b69160e19e09194a93783f9cadfa4195afc35",
    "apps/desktop/src/renderer/settings/useInterfaceSettings.ts": "32936d72ee743500b233b835678dcd998bb2307e842a412f76b8c398062e7cc0",
    "apps/desktop/src/renderer/shell/navPrefs.tsx": "155cf8a7839c28fdb7baecb24e21e7f020e403f85d41c3744dcfff69edf571f3",
    "apps/desktop/src/renderer/shell/useLayout.ts": "e926c07a632ba4fd4e7090e103a9c9b62d6ef318aed42d23faab1830de7f1de7",
    "apps/desktop/src/renderer/skin/SkinControls.tsx": "9d0c234416ce208c45385d27fae9d8da3ffff73a2f7bab2636fbd285db22af97",
    "apps/desktop/src/renderer/skin/SkinStudio.tsx": "a69bf48f9622c3b46d82b489d7f45c4adb38b12e0ba7483c65dc9eda15ef4565",
    "apps/desktop/src/renderer/skin/skinAgentBridge.ts": "80cd5e8a4c0a86ccafb3afc32e34c72ae38673f0c55abc56008a6ddb0d9ece15",
    "apps/desktop/src/renderer/skin/skinModel.ts": "882a4d606dca996d75fdba2d3af401aa9bce4662bf10058a1fee603b5a5be5df",
    "apps/desktop/src/renderer/skin/skinStore.ts": "b95a51ccc25aaf15af5f19a51cfc5454fe1d73482909b6c75a8657c0b15136c2",
    "apps/desktop/src/renderer/skin/skinValidation.ts": "86bb510fa20f4b222c119b53fd6f06aa624c5ffae5b48dd7f0a6ae717bb2430e",
    "apps/desktop/src/renderer/workspace/FrontPage.tsx": "acf1bab7b5cdc3e99bff94cf95e80e66fdc47823e45859fdbf27c738e4d643db",
    "apps/desktop/src/renderer/workspace/Sidebar.tsx": "81ff810f3a1aa787cd6b0db97b53bad562184ae35c2cc2a8adb652ce0da5d250",
    "apps/desktop/src/renderer/workspace/ViewerPane.tsx": "f2076ffb2eb2018c65fcc4f648451caac026a3abad7502f63a90565df84879b7",
    "apps/desktop/src/renderer/workspace/agentGraphShared.ts": "a482fbcbdd8e8f4650bd583659ffd28a2091550ce28a65f3ec0cd800d528455a",
    "apps/desktop/src/renderer/workspace/destinations.ts": "a0309f5e969acd16cb19d84a1b852c7d7327ee7ec07bca5d2eed460d016d668a",
    "apps/desktop/src/renderer/workspace/types.ts": "f859836c59ba04319a8bc4571df934417018816809a0a93dbd899c8aef474a9d",
    "apps/desktop/src/shared/apiTypesMedia.ts": "10bf3d9f6cd5fe6da85033d746cb8250c575d24eb663aeb0941a97ca8d04ef3b",
    "services/agent-sidecar/src/arcelle_sidecar/agent_capabilities.py": "076c828f7812e7cbcdc3e103c71c5095d80c626c6979d4c88e75cba73958148b",
    "services/agent-sidecar/src/arcelle_sidecar/agent_registry_1.py": "5f076e66c1c5c53ffe29496dc107257fd97ae31763cb4bd683cd332d759172e7",
    "services/agent-sidecar/src/arcelle_sidecar/graphs.py": "6c451e3fc4875cdb37b4f2e551850cf6f00a18d405cb289627da34912888d81d",
    "services/agent-sidecar/src/arcelle_sidecar/labels.py": "b544ccd4621f48b0313dfe3d9b3d0fae1da2cb93b8dc87545fc3b6670fb396e8",
    "services/agent-sidecar/src/arcelle_sidecar/privacy.py": "3f428c191843487cd529ff434e58ee88c7ea4236be76ff3f530ba918dee644b9",
    "services/agent-sidecar/src/arcelle_sidecar/prompts.py": "8c64edc5b552dde0e2c197fa5292d34154edbd37f53544b9003fd535e96431ef",
    "services/agent-sidecar/src/arcelle_sidecar/prompts_templates.py": "87bb962e77b74b2c9d2e637e1104010bcfc9ea21378f0bcded44e7ceafbe172a",
    "services/agent-sidecar/src/arcelle_sidecar/routing.py": "e39dec4d8a2155b7054e11e5d0af5def4b2f20b8f8ce0b7a5d02b9b96de8ac32",
}

TYPESCRIPT_TESTS = {
    "apps/desktop/src/main/bootstrapElectron.ts": [
        "src/main/index.test.ts",
    ],
    "apps/desktop/src/main/bridgeCatalog.ts": [
        "src/main/bridgeDispatcher.test.ts",
        "src/main/toolSpecs.test.ts",
        "src/main/toolSchema.test.ts",
    ],
    "apps/desktop/src/main/execToolDispatch.ts": [
        "src/main/execToolDispatch.test.ts", "src/main/execTool.test.ts",
    ],
    "apps/desktop/src/main/execToolDispatchCore.ts": [
        "src/main/execToolDispatch.test.ts", "src/main/execTool.test.ts",
    ],
    "apps/desktop/src/main/execToolEffects.ts": [
        "src/main/execToolDispatch.test.ts", "src/main/execTool.test.ts",
    ],
    "apps/desktop/src/main/toolSchema.ts": [
        "src/main/toolSchema.test.ts", "src/main/execTool.test.ts",
    ],
    "apps/desktop/src/main/toolSpecs.ts": [
        "src/main/toolSpecs.test.ts", "src/main/bridgeDispatcher.test.ts",
    ],
    "apps/desktop/src/main/toolSpecsCatalog.ts": [
        "src/main/toolSpecs.test.ts", "src/main/bridgeDispatcher.test.ts",
    ],
    "apps/desktop/src/main/toolSpecsSkin.ts": [
        "src/main/toolSpecs.test.ts", "src/main/toolSchema.test.ts",
    ],
    "apps/desktop/src/main/toolSpecsTypes.ts": [
        "src/main/toolSpecs.test.ts", "src/main/toolSchema.test.ts",
    ],
    "apps/desktop/src/renderer/agent/driver.ts": [
        "src/renderer/agent/driver.test.ts",
    ],
    "apps/desktop/src/renderer/main.tsx": [
        "src/renderer/App.test.ts", "src/renderer/skin/skinStore.test.ts",
    ],
    "apps/desktop/src/renderer/settings/useInterfaceSettings.ts": [
        "src/renderer/settings/useInterfaceSettings.test.tsx",
        "src/renderer/settings/InterfaceSection.unit.test.tsx",
    ],
    "apps/desktop/src/renderer/shell/navPrefs.tsx": [
        "src/renderer/shell/navPrefs.test.ts",
        "src/renderer/shell/navPrefs.store.unit.test.tsx",
        "src/renderer/shell/CustomizeSidebar.test.tsx",
        "src/renderer/shell/CustomizeSidebar.modal.test.tsx",
    ],
    "apps/desktop/src/renderer/shell/useLayout.ts": [
        "src/renderer/shell/useLayout.test.tsx",
        "src/renderer/skin/SkinStudio.test.tsx",
    ],
    "apps/desktop/src/renderer/skin/SkinControls.tsx": [
        "src/renderer/skin/SkinStudio.test.tsx",
    ],
    "apps/desktop/src/renderer/skin/SkinStudio.tsx": [
        "src/renderer/skin/SkinStudio.test.tsx",
    ],
    "apps/desktop/src/renderer/skin/skinAgentBridge.ts": [
        "src/renderer/skin/skinAgentBridge.test.ts",
        "src/renderer/skin/skinModel.test.ts",
    ],
    "apps/desktop/src/renderer/skin/skinModel.ts": [
        "src/renderer/skin/skinModel.test.ts",
        "src/renderer/skin/skinStore.test.ts",
    ],
    "apps/desktop/src/renderer/skin/skinStore.ts": [
        "src/renderer/skin/skinStore.test.ts",
        "src/renderer/skin/SkinStudio.test.tsx",
    ],
    "apps/desktop/src/renderer/skin/skinValidation.ts": [
        "src/renderer/skin/skinModel.test.ts",
        "src/renderer/skin/skinStore.test.ts",
    ],
    "apps/desktop/src/renderer/workspace/FrontPage.tsx": [
        "src/renderer/workspace/FrontPage.test.ts",
    ],
    "apps/desktop/src/renderer/workspace/Sidebar.tsx": [
        "src/renderer/workspace/Sidebar.test.ts",
        "src/renderer/workspace/destinations.test.ts",
    ],
    "apps/desktop/src/renderer/workspace/ViewerPane.tsx": [
        "src/renderer/workspace/ViewerPane.test.ts",
    ],
    "apps/desktop/src/renderer/workspace/agentGraphShared.ts": [
        "src/renderer/workspace/AgentGraph.test.ts",
    ],
    "apps/desktop/src/renderer/workspace/destinations.ts": [
        "src/renderer/workspace/destinations.test.ts",
        "src/renderer/workspace/FrontPage.test.ts",
        "src/renderer/workspace/Sidebar.test.ts",
    ],
    "apps/desktop/src/renderer/workspace/types.ts": [
        "src/renderer/workspace/types.test.ts",
    ],
    "apps/desktop/src/shared/apiTypesMedia.ts": [
        "src/shared/apiTypes.test.ts",
    ],
}

PYTHON_TESTS = {
    "agent_capabilities.py": [
        "tests/test_manager.py", "tests/test_agent_support.py",
        "tests/test_capability_truth.py", "tests/test_server.py",
        "tests/test_arc_review_e2e.py",
    ],
    "agent_registry_1.py": [
        "tests/test_manager.py", "tests/test_agent_support.py",
        "tests/test_skill_agent_parity.py", "tests/test_specialist_tag.py",
        "tests/test_graphs.py", "tests/test_server.py",
    ],
    "graphs.py": [
        "tests/test_graphs.py", "tests/test_graph.py", "tests/test_manager.py",
        "tests/test_arc_review_e2e.py", "tests/test_e2e_tasks.py",
    ],
    "labels.py": [
        "tests/test_labels.py", "tests/test_manager.py", "tests/test_handoff.py",
        "tests/test_external_llm.py", "tests/test_wf_nodes.py",
    ],
    "privacy.py": [
        "tests/test_privacy.py", "tests/test_privacy_gate.py",
        "tests/test_privacy_restore_value_unit.py", "tests/test_manager.py",
        "tests/test_server.py", "tests/test_arc_review_e2e.py",
        "tests/test_specialist_tag.py", "tests/test_provider_api.py",
        "tests/test_external_llm.py", "tests/test_graph.py",
    ],
    "prompts.py": [
        "tests/test_manager.py", "tests/test_graph.py", "tests/test_hub_mcp.py",
        "tests/test_external_agent_hub.py", "tests/test_capability_truth.py",
        "tests/test_planner.py", "tests/test_external_llm.py",
        "tests/test_specialist_tag.py",
    ],
    "prompts_templates.py": [
        "tests/test_manager.py", "tests/test_agents_doc.py",
        "tests/test_graphs.py",
    ],
    "routing.py": [
        "tests/test_routing.py", "tests/test_manager.py", "tests/test_graphs.py",
        "tests/test_server.py", "tests/test_specialist_tag.py",
        "tests/test_arc_review_e2e.py", "tests/test_browse_agent.py",
        "tests/test_integration.py",
    ],
}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def mutated_source() -> str | None:
    changed = [
        relative
        for relative, expected in SOURCE_HASHES.items()
        if digest(ROOT / relative) != expected
    ]
    return changed[0] if len(changed) == 1 else None


def run(command: list[str], cwd: Path) -> int:
    return subprocess.run(command, cwd=cwd, check=False).returncode


def run_complete_baseline() -> int:
    desktop = run(["npm", "run", "test:electron:unit"], ROOT)
    if desktop != 0:
        return desktop
    return run([str(SIDECAR / ".venv" / "bin" / "python"), "-m", "pytest", "-q"], SIDECAR)


def run_typescript_tests(relative: str) -> int:
    tests = TYPESCRIPT_TESTS.get(relative)
    if not tests:
        print(f"No TypeScript behavior tests mapped for {relative}; treating it as a survivor.")
        return 0
    behavior = run([
        "npm", "exec", "vitest", "run", "--", *tests,
        "--maxWorkers", "1", "--exclude", "src/main/index.electron.test.ts",
    ], DESKTOP)
    if behavior != 0:
        return behavior
    return run(["npm", "run", "typecheck"], DESKTOP)


def run_python_tests(relative: str) -> int:
    tests = PYTHON_TESTS.get(Path(relative).name)
    if not tests:
        return 0
    return run([
        str(SIDECAR / ".venv" / "bin" / "python"), "-m", "pytest", "-q", *tests,
    ], SIDECAR)


def main() -> int:
    if not os.environ.get("QUALITY_GATE_MUTANT_ID"):
        return run_complete_baseline()
    relative = mutated_source()
    if relative is None:
        print("Could not identify exactly one mutated source; treating it as a survivor.")
        return 0
    if relative.endswith((".ts", ".tsx")):
        return run_typescript_tests(relative)
    return run_python_tests(relative)


if __name__ == "__main__":
    sys.exit(main())
