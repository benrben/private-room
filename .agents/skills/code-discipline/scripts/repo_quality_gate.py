#!/usr/bin/env python3
"""Portable, language-neutral repository quality gate.

Copy this file into a repository and run:

    python3 repo_quality_gate.py --root .

The runner auto-detects common toolchains and also accepts commands that emit
normalized JSON, which makes every gate extensible to arbitrary languages. It
installs missing coverage and complexity tools into isolated caches by default,
writes a self-contained HTML report, and exits non-zero unless every applicable
gate can be measured and passes.
"""

from __future__ import annotations

import argparse
import ast
import contextlib
import dataclasses
import fnmatch
import hashlib
import html
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import tokenize
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Iterable, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

VERSION = "4.1.0"
QUALITY_DIRECTORY = ".quality"
CONFIG_NAME = f"{QUALITY_DIRECTORY}/quality-gate.json"
THRESHOLDS_NAME = f"{QUALITY_DIRECTORY}/quality-thresholds.json"
DEPENDENCIES_NAME = f"{QUALITY_DIRECTORY}/quality-dependencies.json"
DEFAULT_REPORT = f"{QUALITY_DIRECTORY}/quality-gate-report.html"
STRYKER_VERSION = "9.6.1"
GITHUB_REPOSITORY = "benrben/code-skills"
GITHUB_DEFAULT_REF = "main"
GITHUB_RAW_BASE = f"https://raw.githubusercontent.com/{GITHUB_REPOSITORY}"
JAVASCRIPT_MUTATION_EXTENSIONS = {
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
}
STRYKER_EXCLUDED_MUTATORS = [
    "ArrayDeclaration",
    "ArrowFunction",
    "BlockStatement",
    "BooleanLiteral",
    "ConditionalExpression",
    "LogicalOperator",
    "MethodExpression",
    "ObjectLiteral",
    "OptionalChaining",
    "Regex",
    "StringLiteral",
    "UnaryOperator",
    "UpdateOperator",
]

THRESHOLD_KEYS = {
    "format_lint": {"max_violations"},
    "types": {"max_errors"},
    "contracts": {"max_violations"},
    "metrics": {
        "max_test_failures",
        "coverage_limit",
        "complexity_limit",
        "craap_limit",
    },
    "file_loc": {"max_lines"},
    "dead_code": {"max_findings"},
    "flaky_tests": {"runs", "max_failures"},
    "mutation": {"max_surviving_mutants"},
    "dependencies": {"max_violations"},
}

SOURCE_EXTENSIONS = {
    ".py",
    ".pyi",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".java",
    ".kt",
    ".kts",
    ".go",
    ".rs",
    ".rb",
    ".php",
    ".cs",
    ".c",
    ".h",
    ".cc",
    ".cpp",
    ".cxx",
    ".hpp",
    ".swift",
    ".scala",
    ".lua",
    ".ex",
    ".exs",
    ".dart",
    ".groovy",
    ".sol",
    ".zig",
}

LIZARD_EXTENSIONS = {
    ".c",
    ".h",
    ".cc",
    ".cpp",
    ".cxx",
    ".hpp",
    ".cs",
    ".go",
    ".java",
    ".js",
    ".jsx",
    ".kt",
    ".kts",
    ".lua",
    ".mjs",
    ".cjs",
    ".php",
    ".rb",
    ".rs",
    ".scala",
    ".sol",
    ".swift",
    ".ts",
    ".tsx",
    ".zig",
}

DEFAULT_EXCLUDED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".idea",
    ".vscode",
    ".venv",
    "venv",
    "node_modules",
    "vendor",
    "target",
    "dist",
    "build",
    "out",
    "bin",
    "obj",
    "coverage",
    "htmlcov",
    ".coverage",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "__pycache__",
    ".next",
    ".nuxt",
}

DEFAULT_TEST_PATTERNS = (
    "tests/**",
    "test/**",
    "spec/**",
    "features/**",
    "e2e/**",
    "qa/**",
    "**/tests/**",
    "**/test/**",
    "**/spec/**",
    "**/__tests__/**",
    "**/*_test.*",
    "**/test_*.*",
    "test.*",
    "**/test.*",
    "test-d.*",
    "**/test-d.*",
    "**/*.test-d.*",
    "**/*.test.*",
    "**/*.spec.*",
)

OPERATOR_MUTATIONS = {
    "==": "!=",
    "!=": "==",
    "<=": ">",
    ">=": "<",
    "<": ">",
    ">": "<",
    "+": "-",
    "-": "+",
}

MANIFEST_LANGUAGES = {
    "pyproject.toml": "Python",
    "setup.py": "Python",
    "requirements.txt": "Python",
    "package.json": "JavaScript/TypeScript",
    "go.mod": "Go",
    "Cargo.toml": "Rust",
    "Gemfile": "Ruby",
    "composer.json": "PHP",
    "pom.xml": "Java",
    "build.gradle": "Java/Kotlin",
    "build.gradle.kts": "Java/Kotlin",
    "Package.swift": "Swift",
    "mix.exs": "Elixir",
    "pubspec.yaml": "Dart",
}

EXTENSION_LANGUAGES = {
    ".py": "Python",
    ".pyi": "Python",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".mjs": "JavaScript",
    ".cjs": "JavaScript",
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".java": "Java",
    ".kt": "Kotlin",
    ".kts": "Kotlin",
    ".go": "Go",
    ".rs": "Rust",
    ".rb": "Ruby",
    ".php": "PHP",
    ".cs": "C#",
    ".c": "C",
    ".h": "C/C++",
    ".cc": "C++",
    ".cpp": "C++",
    ".cxx": "C++",
    ".hpp": "C++",
    ".swift": "Swift",
    ".scala": "Scala",
    ".lua": "Lua",
    ".ex": "Elixir",
    ".exs": "Elixir",
    ".dart": "Dart",
    ".groovy": "Groovy",
    ".sol": "Solidity",
    ".zig": "Zig",
}


@dataclasses.dataclass
class CommandResult:
    command: list[str]
    returncode: int
    stdout: str
    duration_seconds: float
    timed_out: bool = False


@dataclasses.dataclass
class CheckCommand:
    command: list[str]
    fail_on_output: bool = False


@dataclasses.dataclass
class FunctionMetric:
    path: str
    name: str
    start_line: int
    end_line: int
    complexity: int
    covered_lines: int
    total_lines: int
    coverage_percent: float
    craap_score: float
    parser: str
    coverage_limit: float = 100.0
    complexity_limit: float = 6.0
    craap_limit: float = 6.0

    @property
    def passed(self) -> bool:
        return (
            self.coverage_percent >= self.coverage_limit
            and self.complexity <= self.complexity_limit
            and self.craap_score <= self.craap_limit
        )


@dataclasses.dataclass(frozen=True)
class FileLineMetric:
    path: str
    lines: int
    limit: int

    @property
    def passed(self) -> bool:
        return self.lines <= self.limit


@dataclasses.dataclass
class Mutation:
    mutant_id: str
    path: str
    line: int
    column: int
    original: str
    replacement: str
    survived: bool
    timed_out: bool
    duration_seconds: float
    output: str
    status: str = ""
    static: bool = False


@dataclasses.dataclass(frozen=True)
class MutationCandidate:
    path: str
    offset: int
    line: int
    column: int
    original: str
    replacement: str


@dataclasses.dataclass
class DependencyViolation:
    source: str
    source_module: str
    target: str
    target_module: str
    rule: str
    line: int = 0


@dataclasses.dataclass
class GateResult:
    key: str
    title: str
    passed: bool
    summary: str
    details: list[str] = dataclasses.field(default_factory=list)
    command_results: list[CommandResult] = dataclasses.field(default_factory=list)
    prompts: list[tuple[str, str]] = dataclasses.field(default_factory=list)
    applicable: bool = True
    deferred: bool = False


@dataclasses.dataclass
class ToolContext:
    cache_dir: Path
    python: str
    python_path: Path
    lizard_available: bool = False
    cargo_llvm_cov: str | None = None
    stryker_command: list[str] | None = None
    setup_results: list[CommandResult] = dataclasses.field(default_factory=list)

    @property
    def python_env(self) -> dict[str, str]:
        existing = os.environ.get("PYTHONPATH", "")
        value = str(self.python_path)
        if existing:
            value += os.pathsep + existing
        return {"PYTHONPATH": value}


@dataclasses.dataclass(frozen=True)
class GateScope:
    kind: str
    paths: tuple[str, ...] = ()
    reference: str | None = None

    @property
    def incremental(self) -> bool:
        return self.kind != "repository"

    def includes(self, relative_path: str) -> bool:
        return not self.incremental or relative_path in self.paths

    @property
    def description(self) -> str:
        if self.kind == "commit":
            return f"commit {self.reference or 'HEAD'}"
        if self.kind == "local_changes":
            return "local changes"
        return "the entire repository"


def repository_scope() -> GateScope:
    return GateScope("repository")


@dataclasses.dataclass
class AnalysisReport:
    root: str
    generated_at: str
    languages: list[str]
    gates: list[GateResult]
    functions: list[FunctionMetric]
    mutations: list[Mutation]
    dependency_violations: list[DependencyViolation]
    tool_setup: list[CommandResult]
    notes: list[str]
    files: list[FileLineMetric] = dataclasses.field(default_factory=list)
    thresholds: dict[str, Any] = dataclasses.field(default_factory=dict)
    rerun_command: str | None = None
    mode: str = "full"
    scope: GateScope = dataclasses.field(default_factory=repository_scope)

    @property
    def passed(self) -> bool:
        return (
            self.mode == "full"
            and bool(self.gates)
            and all(gate.passed for gate in self.gates)
        )

    @property
    def ready_for_full(self) -> bool:
        executed = [gate for gate in self.gates if not gate.deferred]
        return (
            self.mode == "fast"
            and bool(executed)
            and all(gate.passed for gate in executed)
        )


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def validate_update_ref(reference: str) -> str:
    if (
        not reference
        or reference.startswith("/")
        or ".." in reference.split("/")
        or not re.fullmatch(r"[A-Za-z0-9._/-]+", reference)
    ):
        raise ValueError(
            "GitHub update ref may contain only letters, digits, '.', '_', '-', and '/'"
        )
    return reference


def github_raw_url(reference: str, relative_path: str) -> str:
    safe_reference = quote(validate_update_ref(reference), safe="/")
    safe_path = quote(relative_path, safe="/")
    return f"{GITHUB_RAW_BASE}/{safe_reference}/{safe_path}"


def download_update_file(url: str, maximum_bytes: int) -> bytes:
    request = Request(url, headers={"User-Agent": f"repo-quality-gate/{VERSION}"})
    try:
        with urlopen(request, timeout=30) as response:
            payload = bytes(response.read(maximum_bytes + 1))
    except (HTTPError, URLError, TimeoutError, OSError) as error:
        raise ValueError(f"Could not download {url}: {error}") from error
    if len(payload) > maximum_bytes:
        raise ValueError(
            f"Downloaded file exceeds the {maximum_bytes}-byte limit: {url}"
        )
    return payload


def downloaded_runner_version(payload: bytes) -> str:
    try:
        source = payload.decode("utf-8")
        tree = ast.parse(source, filename="downloaded repo_quality_gate.py")
        compile(tree, "downloaded repo_quality_gate.py", "exec")
    except (UnicodeDecodeError, SyntaxError, ValueError) as error:
        raise ValueError(
            f"The downloaded runner is not valid Python: {error}"
        ) from error
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if any(
            isinstance(target, ast.Name) and target.id == "VERSION"
            for target in node.targets
        ):
            if isinstance(node.value, ast.Constant) and isinstance(
                node.value.value, str
            ):
                return node.value.value
    raise ValueError("The downloaded runner does not declare a string VERSION")


def validate_downloaded_thresholds(payload: bytes) -> None:
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(
            f"The downloaded thresholds are not valid JSON: {error}"
        ) from error
    if not isinstance(value, dict) or not isinstance(value.get("schema_version"), int):
        raise ValueError(
            "The downloaded thresholds must be a JSON object with schema_version"
        )


def atomic_replace_bytes(path: Path, payload: bytes, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".update"
    )
    try:
        with os.fdopen(handle, "wb") as temporary:
            temporary.write(payload)
            temporary.flush()
            os.fsync(temporary.fileno())
        if mode is not None:
            os.chmod(temporary_name, mode)
        os.replace(temporary_name, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary_name)


def install_standalone_release(
    runner_path: Path,
    bundled_thresholds_path: Path,
    runner_payload: bytes,
    thresholds_payload: bytes,
) -> str:
    version = downloaded_runner_version(runner_payload)
    validate_downloaded_thresholds(thresholds_payload)
    original_runner = runner_path.read_bytes() if runner_path.exists() else None
    original_thresholds = (
        bundled_thresholds_path.read_bytes()
        if bundled_thresholds_path.exists()
        else None
    )
    runner_mode = runner_path.stat().st_mode & 0o777 if runner_path.exists() else 0o755
    thresholds_mode = (
        bundled_thresholds_path.stat().st_mode & 0o777
        if bundled_thresholds_path.exists()
        else 0o644
    )
    try:
        atomic_replace_bytes(
            bundled_thresholds_path, thresholds_payload, thresholds_mode
        )
        atomic_replace_bytes(runner_path, runner_payload, runner_mode)
    except OSError as error:
        if original_thresholds is None:
            with contextlib.suppress(FileNotFoundError):
                bundled_thresholds_path.unlink()
        else:
            atomic_replace_bytes(
                bundled_thresholds_path, original_thresholds, thresholds_mode
            )
        if original_runner is not None:
            atomic_replace_bytes(runner_path, original_runner, runner_mode)
        raise ValueError(
            f"Could not install the downloaded release: {error}"
        ) from error
    return version


def normalized_git_remote(value: str) -> str:
    normalized = value.strip().removesuffix(".git").removesuffix("/")
    if normalized.startswith("git@github.com:"):
        normalized = "https://github.com/" + normalized.removeprefix("git@github.com:")
    return normalized.lower()


def shared_checkout_root(runner_path: Path) -> Path | None:
    if not shutil.which("git"):
        return None
    root_result = subprocess.run(
        ["git", "-C", str(runner_path.parent), "rev-parse", "--show-toplevel"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    if root_result.returncode != 0:
        return None
    root = Path(root_result.stdout.strip()).resolve()
    supported_runners = {
        root / "repo_quality_gate.py",
        root / "skills" / "code-discipline" / "scripts" / "repo_quality_gate.py",
    }
    if runner_path.resolve() not in supported_runners:
        return None
    remote_result = subprocess.run(
        ["git", "-C", str(root), "remote", "get-url", "origin"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    expected = normalized_git_remote(f"https://github.com/{GITHUB_REPOSITORY}")
    if (
        remote_result.returncode != 0
        or normalized_git_remote(remote_result.stdout) != expected
    ):
        return None
    return root


def update_from_github(runner_path: Path, reference: str) -> int:
    reference = validate_update_ref(reference)
    checkout = shared_checkout_root(runner_path)
    if checkout:
        dirty = subprocess.run(
            ["git", "-C", str(checkout), "status", "--porcelain"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        if dirty.returncode != 0:
            print(dirty.stderr.strip() or "error: git status failed", file=sys.stderr)
            return 2
        if dirty.stdout.strip():
            print(
                "error: shared code-skills checkout has local changes; commit or stash them before updating",
                file=sys.stderr,
            )
            return 2
        completed = subprocess.run(
            ["git", "-C", str(checkout), "pull", "--ff-only", "origin", reference],
            text=True,
            check=False,
        )
        if completed.returncode != 0:
            return 2
        print(f"Updated shared code-skills checkout from GitHub ref {reference}.")
        print("All repositories symlinked to this checkout now use the update.")
        return 0

    skill_directory = runner_path.parent.parent
    installer = runner_path.with_name("install.py")
    if (skill_directory / "SKILL.md").is_file() and installer.is_file():
        completed = subprocess.run(
            [
                sys.executable,
                str(installer),
                "--update-current",
                "--ref",
                reference,
            ],
            text=True,
            check=False,
        )
        return completed.returncode

    runner_url = github_raw_url(
        reference, "skills/code-discipline/scripts/repo_quality_gate.py"
    )
    thresholds_url = github_raw_url(
        reference, "skills/code-discipline/quality-thresholds.json"
    )
    try:
        runner_payload = download_update_file(runner_url, 2_000_000)
        thresholds_payload = download_update_file(thresholds_url, 100_000)
        version = install_standalone_release(
            runner_path,
            runner_path.parent / "quality-thresholds.json",
            runner_payload,
            thresholds_payload,
        )
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(f"Updated standalone repository quality gate to {version} from {reference}.")
    print(
        f"Preserved repository-owned {CONFIG_NAME}, {THRESHOLDS_NAME}, and {DEPENDENCIES_NAME} files."
    )
    return 0


def bundled_thresholds_path() -> Path:
    directory = Path(__file__).resolve().parent
    candidates = (
        directory.parent / "quality-thresholds.json",
        directory / "skills" / "code-discipline" / "quality-thresholds.json",
        directory / "quality-thresholds.json",
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise ValueError(
        "Bundled quality thresholds were not found. Copy quality-thresholds.json "
        "beside repo_quality_gate.py or pass --thresholds PATH."
    )


def threshold_number(thresholds: dict[str, Any], section: str, key: str) -> int | float:
    value = thresholds.get(section, {}).get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"Threshold {section}.{key} must be a number")
    return value if isinstance(value, (int, float)) else 0


def validate_thresholds(thresholds: dict[str, Any]) -> None:
    expected_root = {"schema_version", *THRESHOLD_KEYS}
    unknown_root = sorted(set(thresholds) - expected_root)
    missing_root = sorted(expected_root - set(thresholds))
    if unknown_root or missing_root:
        problems = []
        if missing_root:
            problems.append(f"missing keys: {', '.join(missing_root)}")
        if unknown_root:
            problems.append(f"unknown keys: {', '.join(unknown_root)}")
        raise ValueError("Invalid threshold file (" + "; ".join(problems) + ")")
    if thresholds["schema_version"] != 1:
        raise ValueError("Threshold schema_version must be 1")
    for section, keys in THRESHOLD_KEYS.items():
        value = thresholds.get(section)
        if not isinstance(value, dict):
            raise ValueError(f"Threshold section {section} must be a JSON object")
        unknown = sorted(set(value) - keys)
        missing = sorted(keys - set(value))
        if unknown or missing:
            problems = []
            if missing:
                problems.append(f"missing keys: {', '.join(missing)}")
            if unknown:
                problems.append(f"unknown keys: {', '.join(unknown)}")
            raise ValueError(
                f"Invalid threshold section {section} (" + "; ".join(problems) + ")"
            )
        for key in keys:
            number = threshold_number(thresholds, section, key)
            if number < 0:
                raise ValueError(f"Threshold {section}.{key} cannot be negative")
    coverage = threshold_number(thresholds, "metrics", "coverage_limit")
    if coverage > 100:
        raise ValueError("Threshold metrics.coverage_limit cannot exceed 100")
    if threshold_number(thresholds, "file_loc", "max_lines") < 1:
        raise ValueError("Threshold file_loc.max_lines must be at least 1")
    if threshold_number(thresholds, "flaky_tests", "runs") < 2:
        raise ValueError("Threshold flaky_tests.runs must be at least 2")
    integer_paths = (
        ("format_lint", "max_violations"),
        ("types", "max_errors"),
        ("contracts", "max_violations"),
        ("metrics", "max_test_failures"),
        ("file_loc", "max_lines"),
        ("dead_code", "max_findings"),
        ("flaky_tests", "runs"),
        ("flaky_tests", "max_failures"),
        ("mutation", "max_surviving_mutants"),
        ("dependencies", "max_violations"),
    )
    for section, key in integer_paths:
        if not isinstance(thresholds[section][key], int):
            raise ValueError(f"Threshold {section}.{key} must be an integer")
    zero_only_paths = (
        ("format_lint", "max_violations"),
        ("types", "max_errors"),
        ("contracts", "max_violations"),
        ("metrics", "max_test_failures"),
        ("dead_code", "max_findings"),
        ("flaky_tests", "max_failures"),
        ("mutation", "max_surviving_mutants"),
        ("dependencies", "max_violations"),
    )
    for section, key in zero_only_paths:
        if thresholds[section][key] != 0:
            raise ValueError(
                f"Threshold {section}.{key} must remain 0 for certification"
            )


def load_thresholds(path: Path) -> tuple[dict[str, Any], list[str]]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Cannot read thresholds {path}: {error}") from error
    if not isinstance(loaded, dict):
        raise ValueError(f"Threshold file {path} must contain a JSON object")
    validate_thresholds(loaded)
    return loaded, [f"Loaded quality thresholds from {path}"]


def default_thresholds() -> dict[str, Any]:
    thresholds, _ = load_thresholds(bundled_thresholds_path())
    return thresholds


def threshold_config(thresholds: dict[str, Any]) -> dict[str, Any]:
    validate_thresholds(thresholds)
    return {key: value for key, value in thresholds.items() if key != "schema_version"}


def without_threshold_values(config: dict[str, Any]) -> dict[str, Any]:
    result = deep_merge({}, config)
    for section, keys in THRESHOLD_KEYS.items():
        values = result.get(section)
        if not isinstance(values, dict):
            continue
        for key in keys:
            values.pop(key, None)
        if not values:
            result.pop(section, None)
    return result


def default_config(thresholds: dict[str, Any] | None = None) -> dict[str, Any]:
    base = {
        "source": {
            "include": [],
            "exclude": list(DEFAULT_TEST_PATTERNS),
            "extensions": sorted(SOURCE_EXTENSIONS),
        },
        "test": {"command": None, "timeout_seconds": 600},
        "format_lint": {
            "enabled": "auto",
            "required": False,
            "commands": [],
            "timeout_seconds": 300,
        },
        "types": {
            "enabled": "auto",
            "required": False,
            "commands": [],
            "timeout_seconds": 600,
        },
        "contracts": {
            "enabled": "auto",
            "required": False,
            "commands": [],
            "patterns": [
                "**/openapi.json",
                "**/openapi.yaml",
                "**/openapi.yml",
                "**/*.schema.json",
                "**/schemas/*.json",
            ],
            "timeout_seconds": 300,
        },
        "metrics": {
            "command": None,
            "report": None,
            "coverage_commands": [],
            "coverage_report": None,
            "coverage_format": "auto",
        },
        "mutation": {
            "enabled": True,
            "engine": "auto",
            "incremental": True,
            "test_command": None,
            "test_files": [],
            "vitest_config": None,
            "vitest_dir": None,
            "vitest_related": True,
            "timeout_seconds": 600,
            "max_mutants": 0,
            "workers": "auto",
            "operators": OPERATOR_MUTATIONS,
            "exclude": [],
        },
        "dead_code": {
            "enabled": "auto",
            "required": False,
            "commands": [],
            "timeout_seconds": 300,
        },
        "flaky_tests": {
            "enabled": True,
            "timeout_seconds": 600,
        },
        "dependencies": {
            "command": None,
            "edges_report": None,
            "rules": DEPENDENCIES_NAME,
            "timeout_seconds": 300,
        },
        "tools": {"auto_install": True, "cache_dir": None},
    }
    return deep_merge(base, threshold_config(thresholds or default_thresholds()))


def normalize_path(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def load_config(
    path: Path | None, thresholds: dict[str, Any] | None = None
) -> tuple[dict[str, Any], list[str]]:
    notes: list[str] = []
    active_thresholds = thresholds or default_thresholds()
    config = default_config(active_thresholds)
    if path and path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"Cannot read configuration {path}: {error}") from error
        if not isinstance(loaded, dict):
            raise ValueError(f"Configuration {path} must contain a JSON object")
        config = deep_merge(config, loaded)
        config = deep_merge(config, threshold_config(active_thresholds))
        notes.append(f"Loaded configuration from {path}")
    else:
        notes.append("No configuration file found; using runtime auto-detection")
    return config, notes


def command_list(
    value: Any, substitutions: dict[str, str] | None = None
) -> list[str] | None:
    if value is None or value == "":
        return None
    if isinstance(value, str):
        command = shlex.split(value)
    elif isinstance(value, list) and all(
        isinstance(item, (str, int, float)) for item in value
    ):
        command = [str(item) for item in value]
    else:
        raise ValueError(
            "Commands must be a shell-style string or a JSON array of arguments"
        )
    substitutions = substitutions or {}
    return [substitute_text(part, substitutions) for part in command]


def command_lists(
    value: Any, substitutions: dict[str, str] | None = None
) -> list[list[str]]:
    if value is None or value == [] or value == "":
        return []
    if isinstance(value, str):
        command = command_list(value, substitutions)
        return [command] if command else []
    if isinstance(value, list) and all(
        isinstance(item, (str, int, float)) for item in value
    ):
        command = command_list(value, substitutions)
        return [command] if command else []
    if isinstance(value, list):
        commands = []
        for raw_command in value:
            command = command_list(raw_command, substitutions)
            if command:
                commands.append(command)
        return commands
    raise ValueError("Commands must be a command or an array of commands")


def substitute_text(value: str, substitutions: dict[str, str]) -> str:
    for key, replacement in substitutions.items():
        value = value.replace("{" + key + "}", replacement)
    return value


def run_command(
    command: Sequence[str],
    root: Path,
    timeout_seconds: int,
    extra_env: dict[str, str] | None = None,
) -> CommandResult:
    started = time.monotonic()
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    try:
        process_options: dict[str, Any] = {}
        if os.name == "nt":
            windows_subprocess: Any = subprocess
            process_options["creationflags"] = int(
                windows_subprocess.CREATE_NEW_PROCESS_GROUP
            )
        else:
            process_options["start_new_session"] = True
        process = subprocess.Popen(
            list(command),
            cwd=root,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            **process_options,
        )
        try:
            stdout, _ = process.communicate(timeout=max(1, timeout_seconds))
        except subprocess.TimeoutExpired:
            stdout = stop_process_tree(process)
            return CommandResult(
                command=list(command),
                returncode=124,
                stdout=stdout[-12000:],
                duration_seconds=time.monotonic() - started,
                timed_out=True,
            )
        except BaseException:
            stop_process_tree(process)
            raise
        return CommandResult(
            command=list(command),
            returncode=process.returncode,
            stdout=stdout[-12000:],
            duration_seconds=time.monotonic() - started,
        )
    except OSError as error:
        return CommandResult(
            command=list(command),
            returncode=127,
            stdout=str(error),
            duration_seconds=time.monotonic() - started,
        )


def stop_process_tree(process: subprocess.Popen[str]) -> str:
    """Stop a command and every descendant while preserving captured output."""
    if process.poll() is None:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        else:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
    try:
        stdout, _ = process.communicate(timeout=2)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            process.kill()
        else:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
        stdout, _ = process.communicate()
    return stdout or ""


def executable(root: Path, name: str) -> str | None:
    local_candidates = [
        root / ".venv" / "bin" / name,
        root / "venv" / "bin" / name,
        root / "node_modules" / ".bin" / name,
        root / "vendor" / "bin" / name,
    ]
    for candidate in local_candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return name if shutil.which(name) else None


def detect_languages(root: Path) -> list[str]:
    languages = {
        language
        for manifest, language in MANIFEST_LANGUAGES.items()
        if (root / manifest).exists()
    }
    counts: dict[str, int] = {}
    for path in walk_files(root):
        language = EXTENSION_LANGUAGES.get(path.suffix.lower())
        if language:
            counts[language] = counts.get(language, 0) + 1
    languages.update(language for language, count in counts.items() if count > 0)
    return sorted(languages) or ["Unknown"]


def walk_files(root: Path) -> Iterable[Path]:
    if (root / ".git").exists() and shutil.which("git"):
        listed = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-co", "--exclude-standard", "-z"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if listed.returncode == 0:
            for raw_path in listed.stdout.split(b"\0"):
                if not raw_path:
                    continue
                path = root / os.fsdecode(raw_path)
                if is_file_within(path, root) and not any(
                    part in DEFAULT_EXCLUDED_DIRS
                    for part in path.relative_to(root).parts
                ):
                    yield path
            return
    for current, dirs, files in os.walk(root):
        dirs[:] = [
            directory for directory in dirs if directory not in DEFAULT_EXCLUDED_DIRS
        ]
        for filename in files:
            path = Path(current) / filename
            if is_file_within(path, root):
                yield path


def is_file_within(path: Path, root: Path) -> bool:
    if not path.is_file():
        return False
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def git_changed_paths(root: Path, arguments: Sequence[str]) -> tuple[str, ...]:
    if not shutil.which("git"):
        raise ValueError("Git is required for an incremental quality-gate scope.")
    result = subprocess.run(
        ["git", "-C", str(root), *arguments, "-z"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        output = result.stderr.decode(errors="replace").strip()
        raise ValueError(output or "Git could not determine the changed files.")
    paths: set[str] = set()
    for raw_path in result.stdout.split(b"\0"):
        if not raw_path:
            continue
        relative = Path(os.fsdecode(raw_path))
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError(f"Git returned a path outside the repository: {relative}")
        paths.add(relative.as_posix())
    return tuple(sorted(paths))


def git_revision(root: Path, reference: str) -> str:
    if not shutil.which("git"):
        raise ValueError("Git is required for an incremental quality-gate scope.")
    result = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--verify", f"{reference}^{{commit}}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        output = result.stderr.strip()
        raise ValueError(output or f"Git commit does not exist: {reference}")
    return result.stdout.strip()


def commit_scope(root: Path, reference: str = "HEAD") -> GateScope:
    revision = git_revision(root, reference)
    parent = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--verify", f"{revision}^1"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    if parent.returncode == 0:
        paths = git_changed_paths(
            root,
            ["diff", "--name-only", parent.stdout.strip(), revision],
        )
    else:
        paths = git_changed_paths(
            root,
            ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", revision],
        )
    return GateScope("commit", paths, reference)


def local_changes_scope(root: Path) -> GateScope:
    unstaged = git_changed_paths(root, ["diff", "--name-only"])
    staged = git_changed_paths(root, ["diff", "--cached", "--name-only"])
    untracked = git_changed_paths(root, ["ls-files", "--others", "--exclude-standard"])
    return GateScope("local_changes", tuple(sorted({*unstaged, *staged, *untracked})))


def matches_any(relative: str, patterns: Sequence[str]) -> bool:
    path = Path(relative)
    lowered = relative.lower()
    return any(
        fnmatch.fnmatch(relative, pattern)
        or path.match(pattern)
        or (
            pattern.startswith("**/")
            and fnmatch.fnmatch(relative, pattern.removeprefix("**/"))
        )
        or fnmatch.fnmatch(lowered, pattern.lower())
        or Path(lowered).match(pattern.lower())
        or (
            pattern.lower().startswith("**/")
            and fnmatch.fnmatch(lowered, pattern.lower().removeprefix("**/"))
        )
        for pattern in patterns
    )


def discover_source_files(
    root: Path,
    source_config: dict[str, Any],
    scope: GateScope | None = None,
) -> list[Path]:
    scope = scope or repository_scope()
    includes = [str(pattern) for pattern in source_config.get("include", [])]
    excludes = [str(pattern) for pattern in source_config.get("exclude", [])]
    extensions = {
        str(extension).lower()
        for extension in source_config.get("extensions", SOURCE_EXTENSIONS)
    }
    result: list[Path] = []
    for path in walk_files(root):
        relative = normalize_path(path, root)
        if not scope.includes(relative):
            continue
        if path.name in {Path(__file__).name, DEFAULT_REPORT}:
            continue
        if includes:
            if not matches_any(relative, includes):
                continue
        elif path.suffix.lower() not in extensions:
            continue
        if matches_any(relative, excludes):
            continue
        result.append(path)
    return sorted(result)


def physical_line_count(path: Path) -> int:
    with path.open("r", encoding="utf-8", errors="replace", newline=None) as source:
        return sum(1 for _ in source)


def file_loc_prompt(metric: FileLineMetric) -> str:
    return f"""Split the oversized production file `{metric.path}` ({metric.lines} physical lines; required maximum: {metric.limit}).

Read the file, its callers, tests, and module-boundary rules before editing. Extract cohesive responsibilities behind honest names while preserving public behavior, signatures, imports, initialization order, and error paths. Keep dependency direction inward and avoid creating a generic dumping-ground module. Run focused tests after each extraction, then the complete repository quality gate. Do not change the File LOC threshold, exclude the file, or compress multiple statements onto fewer lines."""


def run_file_loc_gate(
    root: Path,
    source_files: Sequence[Path],
    config: dict[str, Any],
) -> tuple[GateResult, list[FileLineMetric]]:
    limit = int(config["max_lines"])
    files = sorted(
        (
            FileLineMetric(normalize_path(path, root), physical_line_count(path), limit)
            for path in source_files
        ),
        key=lambda item: (-item.lines, item.path),
    )
    failures = [item for item in files if not item.passed]
    if failures:
        return GateResult(
            "file_loc",
            "File LOC",
            False,
            f"{len(failures)} of {len(files)} production files exceed {limit} physical lines.",
            [f"{item.path}: {item.lines} lines" for item in failures],
            prompts=[
                (f"Split {item.path}", file_loc_prompt(item)) for item in failures
            ],
        ), files
    return GateResult(
        "file_loc",
        "File LOC",
        True,
        f"All {len(files)} production files are at or below {limit} physical lines.",
    ), files


def read_package_json(root: Path) -> dict[str, Any]:
    path = root / "package.json"
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def package_dependencies(root: Path) -> dict[str, str]:
    dependencies: dict[str, str] = {}
    for path in walk_files(root):
        if path.name != "package.json":
            continue
        try:
            package = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(package, dict):
            continue
        for key in ("dependencies", "devDependencies"):
            values = package.get(key, {})
            if isinstance(values, dict):
                dependencies.update(
                    {str(name): str(version) for name, version in values.items()}
                )
    return dependencies


def default_tool_cache() -> Path:
    configured = os.environ.get("XDG_CACHE_HOME")
    base = Path(configured) if configured else Path.home() / ".cache"
    return base / "repo-quality-gate"


def node_package_version(root: Path, package_name: str) -> str | None:
    package_path = root / "node_modules" / package_name / "package.json"
    try:
        value = json.loads(package_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    version = value.get("version") if isinstance(value, dict) else None
    return str(version) if version else None


def bootstrap_tools(
    root: Path,
    config: dict[str, Any],
    source_files: Sequence[Path],
) -> ToolContext:
    tools_config = config.get("tools", {})
    cache_value = tools_config.get("cache_dir")
    cache_dir = (
        resolve_config_path(str(cache_value), root)
        if cache_value
        else default_tool_cache()
    )
    python = executable(root, "python") or executable(root, "python3") or sys.executable
    python_key = hashlib.sha256(str(python).encode()).hexdigest()[:10]
    python_path = (
        cache_dir
        / f"python-{sys.version_info.major}.{sys.version_info.minor}-{python_key}"
    )
    python_path.mkdir(parents=True, exist_ok=True)
    context = ToolContext(cache_dir, python, python_path)
    auto_install = bool(tools_config.get("auto_install", True))

    metrics_config = config.get("metrics", {})
    has_metrics_adapter = bool(
        metrics_config.get("report") or metrics_config.get("command")
    )
    needs_lizard = not has_metrics_adapter and any(
        path.suffix.lower() in LIZARD_EXTENSIONS for path in source_files
    )
    test_command = command_list(
        config.get("test", {}).get("command")
    ) or infer_test_command(root)
    needs_coverage = bool(
        not has_metrics_adapter
        and any(path.suffix.lower() in {".py", ".pyi"} for path in source_files)
        and test_command
        and (
            Path(test_command[0]).name.startswith("python")
            or "pytest" in " ".join(test_command)
        )
    )
    python_env = context.python_env
    missing_packages: list[str] = []
    if needs_lizard and not _python_module_available(
        python, "lizard", root, python_env
    ):
        missing_packages.append("lizard")
    if needs_coverage and not _python_module_available(
        python, "coverage", root, python_env
    ):
        missing_packages.append("coverage")
    has_python = any(path.suffix.lower() in {".py", ".pyi"} for path in source_files)
    optional_python_tools = []
    if has_python and (
        any((root / name).exists() for name in ("ruff.toml", ".ruff.toml"))
        or project_config_contains(root, "[tool.ruff")
    ):
        optional_python_tools.append(("ruff", "ruff"))
    if has_python and (
        (root / "mypy.ini").exists()
        or project_config_contains(root, "[tool.mypy")
        or project_config_contains(root, "[mypy")
    ):
        optional_python_tools.append(("mypy", "mypy"))
    if has_python and project_config_contains(root, "[tool.vulture"):
        optional_python_tools.append(("vulture", "vulture"))
    contract_files = discover_contract_files(root, config.get("contracts", {}))
    if any(path.name.lower().endswith(".schema.json") for path in contract_files):
        optional_python_tools.append(("jsonschema", "jsonschema"))
    if any(
        path.name.lower() in {"openapi.json", "openapi.yaml", "openapi.yml"}
        for path in contract_files
    ):
        optional_python_tools.append(
            ("openapi_spec_validator", "openapi-spec-validator")
        )
    for module, package in optional_python_tools:
        if not _python_module_available(python, module, root, python_env):
            missing_packages.append(package)
    missing_packages = list(dict.fromkeys(missing_packages))
    if auto_install and missing_packages:
        install = run_command(
            [
                python,
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--upgrade",
                "--target",
                str(python_path),
                *missing_packages,
            ],
            root,
            900,
        )
        context.setup_results.append(install)
    context.lizard_available = needs_lizard and _python_module_available(
        python, "lizard", root, python_env
    )

    dependencies = package_dependencies(root)
    vitest_version = node_package_version(root, "vitest")
    needs_vitest_coverage = (
        not has_metrics_adapter
        and "vitest" in dependencies
        and not node_package_version(root, "@vitest/coverage-v8")
    )
    if auto_install and needs_vitest_coverage and executable(root, "npm"):
        requested = vitest_version or dependencies.get("vitest", "latest")
        install = run_command(
            [
                executable(root, "npm") or "npm",
                "install",
                "--no-save",
                "--package-lock=false",
                "--ignore-scripts",
                f"@vitest/coverage-v8@{requested}",
            ],
            root,
            900,
        )
        context.setup_results.append(install)

    mutation_config = config.get("mutation", {})
    mutation_engine = str(mutation_config.get("engine", "auto")).lower()
    needs_stryker = (
        mutation_config.get("enabled", True)
        and mutation_engine in {"auto", "stryker"}
        and "vitest" in dependencies
        and any(
            path.suffix.lower() in JAVASCRIPT_MUTATION_EXTENSIONS
            for path in source_files
        )
    )
    has_stryker = bool(
        node_package_version(root, "@stryker-mutator/core")
        and node_package_version(root, "@stryker-mutator/vitest-runner")
    )
    stryker_install_succeeded = False
    if needs_stryker and not has_stryker and auto_install and executable(root, "npm"):
        install = run_command(
            [
                executable(root, "npm") or "npm",
                "install",
                "--no-save",
                "--package-lock=false",
                "--ignore-scripts",
                f"@stryker-mutator/core@{STRYKER_VERSION}",
                f"@stryker-mutator/vitest-runner@{STRYKER_VERSION}",
            ],
            root,
            900,
        )
        context.setup_results.append(install)
        stryker_install_succeeded = install.returncode == 0
    if needs_stryker and (has_stryker or stryker_install_succeeded):
        binary_name = "stryker.cmd" if os.name == "nt" else "stryker"
        context.stryker_command = [str(root / "node_modules" / ".bin" / binary_name)]

    cargo_root = cache_dir / "cargo"
    cargo_binary = (
        cargo_root
        / "bin"
        / ("cargo-llvm-cov.exe" if os.name == "nt" else "cargo-llvm-cov")
    )
    existing_cargo_cov = executable(root, "cargo-llvm-cov")
    if existing_cargo_cov:
        context.cargo_llvm_cov = existing_cargo_cov
    elif cargo_binary.exists():
        context.cargo_llvm_cov = str(cargo_binary)
    elif (
        auto_install
        and not has_metrics_adapter
        and (root / "Cargo.toml").exists()
        and executable(root, "cargo")
    ):
        install = run_command(
            [
                executable(root, "cargo") or "cargo",
                "+stable",
                "install",
                "cargo-llvm-cov",
                "--locked",
                "--root",
                str(cargo_root),
            ],
            root,
            1800,
        )
        context.setup_results.append(install)
        if cargo_binary.exists():
            context.cargo_llvm_cov = str(cargo_binary)
    return context


def infer_test_command(root: Path) -> list[str] | None:
    package = read_package_json(root)
    scripts = (
        package.get("scripts", {}) if isinstance(package.get("scripts"), dict) else {}
    )
    if "test" in scripts and executable(root, "npm"):
        return [executable(root, "npm") or "npm", "test"]
    python = executable(root, "python") or executable(root, "python3")
    if python and any(
        (root / name).exists()
        for name in ("pyproject.toml", "pytest.ini", "setup.cfg", "tests")
    ):
        if executable(root, "pytest") or _python_module_available(
            python, "pytest", root
        ):
            return [python, "-m", "pytest", "-q"]
    if (root / "go.mod").exists() and executable(root, "go"):
        return [executable(root, "go") or "go", "test", "./..."]
    if (root / "Cargo.toml").exists() and executable(root, "cargo"):
        return [executable(root, "cargo") or "cargo", "test", "--all"]
    if (root / "Gemfile").exists() and executable(root, "bundle"):
        if (root / "spec").exists():
            return [executable(root, "bundle") or "bundle", "exec", "rspec"]
        return [executable(root, "bundle") or "bundle", "exec", "rake", "test"]
    if (root / "composer.json").exists() and (root / "vendor/bin/phpunit").exists():
        return [str(root / "vendor/bin/phpunit")]
    if (root / "pom.xml").exists() and executable(root, "mvn"):
        return [executable(root, "mvn") or "mvn", "test"]
    if (root / "gradlew").exists():
        return [str(root / "gradlew"), "test"]
    if list(root.glob("*.sln")) and executable(root, "dotnet"):
        return [executable(root, "dotnet") or "dotnet", "test"]
    return None


def package_scripts(root: Path) -> dict[str, str]:
    package = read_package_json(root)
    scripts = package.get("scripts", {})
    if not isinstance(scripts, dict):
        return {}
    return {str(name): str(command) for name, command in scripts.items()}


def package_script_command(root: Path, name: str) -> list[str] | None:
    if name not in package_scripts(root):
        return None
    if (root / "pnpm-lock.yaml").exists() and executable(root, "pnpm"):
        return [executable(root, "pnpm") or "pnpm", "run", name]
    if (root / "yarn.lock").exists() and executable(root, "yarn"):
        return [executable(root, "yarn") or "yarn", "run", name]
    if executable(root, "npm"):
        return [executable(root, "npm") or "npm", "run", name]
    return None


def first_package_script(root: Path, names: Sequence[str]) -> CheckCommand | None:
    for name in names:
        command = package_script_command(root, name)
        if command:
            return CheckCommand(command)
    return None


def configured_check_commands(
    section: dict[str, Any], root: Path
) -> list[CheckCommand]:
    substitutions = {"root": str(root)}
    value = section.get("commands")
    if not value and section.get("command"):
        value = section["command"]
    return [CheckCommand(command) for command in command_lists(value, substitutions)]


def unique_check_commands(commands: Sequence[CheckCommand]) -> list[CheckCommand]:
    seen: set[tuple[str, ...]] = set()
    result = []
    for command in commands:
        key = tuple(command.command)
        if key not in seen:
            seen.add(key)
            result.append(command)
    return result


def project_config_contains(root: Path, text: str) -> bool:
    for name in ("pyproject.toml", "setup.cfg", "tox.ini"):
        path = root / name
        try:
            if text in path.read_text(encoding="utf-8"):
                return True
        except (OSError, UnicodeDecodeError):
            continue
    return False


def infer_format_lint_commands(
    root: Path,
    source_files: Sequence[Path],
    tools: ToolContext,
    scope: GateScope | None = None,
) -> list[CheckCommand]:
    scope = scope or repository_scope()
    commands: list[CheckCommand] = []
    lint = first_package_script(root, ("lint:check", "check:lint", "lint"))
    formatting = first_package_script(
        root, ("format:check", "check:format", "format-check", "fmt:check")
    )
    if lint:
        commands.append(lint)
    if formatting:
        commands.append(formatting)

    eslint_configs = (
        ".eslintrc",
        ".eslintrc.json",
        ".eslintrc.js",
        ".eslintrc.cjs",
        "eslint.config.js",
        "eslint.config.mjs",
        "eslint.config.cjs",
    )
    eslint = executable(root, "eslint")
    javascript_files = [
        normalize_path(path, root)
        for path in source_files
        if path.suffix.lower() in JAVASCRIPT_MUTATION_EXTENSIONS
    ]
    if (
        not lint
        and eslint
        and javascript_files
        and any((root / name).exists() for name in eslint_configs)
    ):
        commands.append(
            CheckCommand([eslint, *(javascript_files if scope.incremental else ["."])])
        )
    prettier = executable(root, "prettier")
    prettier_configs = (
        ".prettierrc",
        ".prettierrc.json",
        ".prettierrc.js",
        "prettier.config.js",
        "prettier.config.cjs",
    )
    if (
        not formatting
        and prettier
        and source_files
        and any((root / name).exists() for name in prettier_configs)
    ):
        prettier_targets = (
            [normalize_path(path, root) for path in source_files]
            if scope.incremental
            else ["."]
        )
        commands.append(CheckCommand([prettier, "--check", *prettier_targets]))

    has_python = any(path.suffix.lower() in {".py", ".pyi"} for path in source_files)
    has_ruff_config = any(
        (root / name).exists() for name in ("ruff.toml", ".ruff.toml")
    ) or project_config_contains(root, "[tool.ruff")
    if (
        has_python
        and has_ruff_config
        and _python_module_available(tools.python, "ruff", root, tools.python_env)
    ):
        python_targets = (
            [
                normalize_path(path, root)
                for path in source_files
                if path.suffix.lower() in {".py", ".pyi"}
            ]
            if scope.incremental
            else ["."]
        )
        commands.extend(
            [
                CheckCommand([tools.python, "-m", "ruff", "check", *python_targets]),
                CheckCommand(
                    [
                        tools.python,
                        "-m",
                        "ruff",
                        "format",
                        "--check",
                        *python_targets,
                    ]
                ),
            ]
        )
    go_files = [path for path in source_files if path.suffix.lower() == ".go"]
    gofmt = executable(root, "gofmt")
    if go_files and gofmt:
        commands.append(
            CheckCommand(
                [gofmt, "-l", *[normalize_path(path, root) for path in go_files]],
                fail_on_output=True,
            )
        )
    cargo = executable(root, "cargo")
    if (root / "Cargo.toml").exists() and cargo:
        commands.append(CheckCommand([cargo, "fmt", "--all", "--", "--check"]))
    return unique_check_commands(commands)


def infer_type_commands(
    root: Path, source_files: Sequence[Path], tools: ToolContext
) -> list[CheckCommand]:
    commands: list[CheckCommand] = []
    script = first_package_script(
        root, ("typecheck", "type-check", "check:types", "types:check")
    )
    if script:
        commands.append(script)
    elif list(root.glob("tsconfig*.json")) and executable(root, "tsc"):
        commands.append(CheckCommand([executable(root, "tsc") or "tsc", "--noEmit"]))
    has_python = any(path.suffix.lower() in {".py", ".pyi"} for path in source_files)
    has_mypy_config = (
        (root / "mypy.ini").exists()
        or project_config_contains(root, "[tool.mypy")
        or project_config_contains(root, "[mypy")
    )
    if (
        has_python
        and has_mypy_config
        and _python_module_available(tools.python, "mypy", root, tools.python_env)
    ):
        commands.append(CheckCommand([tools.python, "-m", "mypy", "."]))
    if (root / "go.mod").exists() and executable(root, "go"):
        commands.append(CheckCommand([executable(root, "go") or "go", "vet", "./..."]))
    if (root / "Cargo.toml").exists() and executable(root, "cargo"):
        commands.append(
            CheckCommand(
                [executable(root, "cargo") or "cargo", "check", "--all-targets"]
            )
        )
    if list(root.glob("*.sln")) and executable(root, "dotnet"):
        commands.append(
            CheckCommand(
                [executable(root, "dotnet") or "dotnet", "build", "--no-restore"]
            )
        )
    return unique_check_commands(commands)


def discover_contract_files(root: Path, section: dict[str, Any]) -> list[Path]:
    patterns = [str(pattern) for pattern in section.get("patterns", [])]
    return sorted(
        path
        for path in walk_files(root)
        if matches_any(normalize_path(path, root), patterns)
    )


def infer_contract_commands(root: Path) -> list[CheckCommand]:
    commands = []
    for name in package_scripts(root):
        lowered = name.lower()
        if "contract" in lowered or lowered in {
            "schema:check",
            "check:schema",
            "openapi:check",
            "check:openapi",
        }:
            command = package_script_command(root, name)
            if command:
                commands.append(CheckCommand(command))
    return unique_check_commands(commands)


def infer_dead_code_commands(
    root: Path, source_files: Sequence[Path], tools: ToolContext
) -> list[CheckCommand]:
    commands = []
    for name in package_scripts(root):
        lowered = name.lower()
        if any(
            token in lowered for token in ("dead-code", "deadcode", "unused")
        ) or lowered in {
            "knip",
            "ts-prune",
        }:
            command = package_script_command(root, name)
            if command:
                commands.append(CheckCommand(command))
    dependencies = package_dependencies(root)
    npx = executable(root, "npx")
    if npx and "knip" in dependencies and not commands:
        commands.append(CheckCommand([npx, "--no-install", "knip"]))
    elif npx and "ts-prune" in dependencies and not commands:
        commands.append(CheckCommand([npx, "--no-install", "ts-prune"]))
    has_python = any(path.suffix.lower() in {".py", ".pyi"} for path in source_files)
    if (
        has_python
        and project_config_contains(root, "[tool.vulture")
        and _python_module_available(tools.python, "vulture", root, tools.python_env)
    ):
        commands.append(CheckCommand([tools.python, "-m", "vulture", "."]))
    return unique_check_commands(commands)


def unavailable_check(
    key: str, title: str, section: dict[str, Any], guidance: str
) -> GateResult:
    if bool(section.get("required", False)):
        return GateResult(
            key,
            title,
            False,
            f"No configured or supported {title.lower()} command was available.",
            [guidance],
            prompts=[
                (
                    f"Configure {title.lower()}",
                    f"Configure a deterministic {title.lower()} command that exits non-zero on violations. {guidance} Do not disable the requested gate.",
                )
            ],
        )
    return GateResult(
        key,
        title,
        True,
        f"Not applicable: no configured or supported {title.lower()} command was detected.",
        [guidance],
        applicable=False,
    )


def deferred_check(key: str, title: str, reason: str) -> GateResult:
    return GateResult(
        key,
        title,
        False,
        f"Deferred in fast mode: {reason}",
        ["Run the full certification command without --fast before shipping."],
        deferred=True,
    )


def run_command_check_gate(
    root: Path,
    key: str,
    title: str,
    section: dict[str, Any],
    inferred: Sequence[CheckCommand],
    guidance: str,
    extra_env: dict[str, str] | None = None,
) -> GateResult:
    if section.get("enabled", "auto") is False:
        return GateResult(
            key,
            title,
            False,
            f"{title} is disabled; a requested gate cannot be skipped.",
            prompts=[
                (
                    f"Enable {title.lower()}",
                    f"Enable and configure the {title.lower()} gate, then repair every reported violation.",
                )
            ],
        )
    configured = configured_check_commands(section, root)
    commands = configured or list(inferred)
    if not commands:
        return unavailable_check(key, title, section, guidance)
    timeout = int(section.get("timeout_seconds", 300))
    results = []
    failures = []
    for check in commands:
        result = run_command(check.command, root, timeout, extra_env)
        results.append(result)
        if result.returncode != 0 or (check.fail_on_output and result.stdout.strip()):
            failures.append(result)
    if failures:
        details = [format_command(result) for result in failures]
        first = failures[0]
        return GateResult(
            key,
            title,
            False,
            f"{len(failures)} of {len(results)} {title.lower()} commands failed.",
            details,
            results,
            [
                (
                    f"Repair {title.lower()}",
                    generic_adapter_prompt(title.lower(), first),
                )
            ],
        )
    return GateResult(
        key,
        title,
        True,
        f"All {len(results)} {title.lower()} commands passed with zero violations.",
        command_results=results,
    )


JSON_SCHEMA_CHECK = """\
import json
import sys
from jsonschema.validators import validator_for

with open(sys.argv[1], encoding="utf-8") as handle:
    schema = json.load(handle)
validator_for(schema).check_schema(schema)
print(f"valid JSON Schema: {sys.argv[1]}")
"""


def contract_file_commands(
    files: Sequence[Path], tools: ToolContext
) -> list[CheckCommand]:
    commands = []
    for path in files:
        lowered = path.name.lower()
        if lowered in {"openapi.json", "openapi.yaml", "openapi.yml"}:
            commands.append(
                CheckCommand([tools.python, "-m", "openapi_spec_validator", str(path)])
            )
        else:
            commands.append(
                CheckCommand([tools.python, "-c", JSON_SCHEMA_CHECK, str(path)])
            )
    return commands


def run_contract_gate(
    root: Path, config: dict[str, Any], tools: ToolContext
) -> GateResult:
    section = config["contracts"]
    files = discover_contract_files(root, section)
    commands = configured_check_commands(section, root)
    commands.extend(infer_contract_commands(root))
    if files:
        commands.extend(contract_file_commands(files, tools))
    effective_section = dict(section)
    effective_section["command"] = None
    effective_section["commands"] = []
    result = run_command_check_gate(
        root,
        "contracts",
        "Contract/schema validation",
        effective_section,
        unique_check_commands(commands),
        "Add OpenAPI or *.schema.json documents, or configure contracts.commands for repository-specific compatibility checks.",
        tools.python_env,
    )
    if result.applicable and result.passed and files:
        result.summary = (
            f"All {len(files)} detected contract/schema files and "
            f"{len(result.command_results) - len(files)} configured checks passed."
        )
    return result


def run_test_baseline(
    root: Path, config: dict[str, Any]
) -> tuple[list[str] | None, CommandResult | None]:
    command = command_list(config["test"].get("command")) or infer_test_command(root)
    if not command:
        return None, None
    return command, run_command(
        command, root, int(config["test"].get("timeout_seconds", 600))
    )


def combine_test_and_metrics_gate(
    metrics_gate: GateResult,
    test_command: list[str] | None,
    baseline: CommandResult | None,
) -> GateResult:
    title = "Tests, coverage & CRAAP"
    if not test_command or baseline is None:
        return GateResult(
            "quality",
            title,
            False,
            "No complete test command could be configured or inferred. "
            f"Coverage and CRAAP still ran diagnostically: {metrics_gate.summary}",
            metrics_gate.details,
            metrics_gate.command_results,
            prompts=[
                (
                    "Configure the complete test suite",
                    "Configure test.command as an argument array that runs every required test and exits non-zero on failure. Then rerun coverage and CRAAP analysis.",
                ),
                *metrics_gate.prompts,
            ],
        )
    if baseline.returncode != 0:
        details = [baseline.stdout] if baseline.stdout else []
        details.extend(metrics_gate.details)
        return GateResult(
            "quality",
            title,
            False,
            "The complete test suite failed. Coverage and CRAAP ran diagnostically: "
            f"{metrics_gate.summary} These measurements cannot be certified until the baseline tests pass.",
            details,
            [baseline, *metrics_gate.command_results],
            [
                ("Repair tests", generic_adapter_prompt("test", baseline)),
                *metrics_gate.prompts,
            ],
        )
    metrics_gate.key = "quality"
    metrics_gate.title = title
    metrics_gate.command_results.insert(0, baseline)
    if metrics_gate.passed:
        metrics_gate.summary = f"Tests pass. {metrics_gate.summary}"
    return metrics_gate


def run_flaky_test_gate(
    root: Path,
    config: dict[str, Any],
    test_command: list[str] | None,
    baseline: CommandResult | None,
) -> GateResult:
    section = config["flaky_tests"]
    if section.get("enabled", True) is False:
        return GateResult(
            "flaky",
            "Flaky-test detection",
            False,
            "Flaky-test detection is disabled; a requested gate cannot be skipped.",
        )
    if not test_command or baseline is None:
        return GateResult(
            "flaky",
            "Flaky-test detection",
            True,
            "Not applicable: no complete test command was available.",
            applicable=False,
        )
    if baseline.returncode != 0:
        return GateResult(
            "flaky",
            "Flaky-test detection",
            True,
            "Not evaluated because the baseline test suite failed consistently before repeat runs.",
            [baseline.stdout],
            [baseline],
            applicable=False,
        )
    runs = max(2, int(section.get("runs", 3)))
    timeout = int(
        section.get("timeout_seconds", config["test"].get("timeout_seconds", 600))
    )
    results = [baseline]
    for _ in range(runs - 1):
        results.append(run_command(test_command, root, timeout))
    exit_codes = {result.returncode for result in results}
    if exit_codes == {0}:
        return GateResult(
            "flaky",
            "Flaky-test detection",
            True,
            f"The complete test suite passed consistently across {runs} runs; zero flakes were observed.",
            command_results=results,
        )
    return GateResult(
        "flaky",
        "Flaky-test detection",
        False,
        f"The test suite was inconsistent across {runs} runs; exit codes were {sorted(exit_codes)}.",
        [format_command(result) for result in results if result.returncode != 0],
        results,
        [
            (
                "Eliminate flaky tests",
                "Reproduce the inconsistent complete-suite result. Remove dependencies on timing, order, shared mutable state, randomness, network state, and leaked resources. Do not add retries or quarantine the test merely to hide the flake. Rerun the full suite repeatedly until every configured run passes.",
            )
        ],
    )


def _python_module_available(
    python: str,
    module: str,
    root: Path,
    extra_env: dict[str, str] | None = None,
) -> bool:
    result = run_command([python, "-c", f"import {module}"], root, 10, extra_env)
    return result.returncode == 0


def infer_coverage_commands(
    root: Path,
    report_path: Path,
    tools: ToolContext | None = None,
) -> tuple[list[list[str]], str] | None:
    python = executable(root, "python") or executable(root, "python3")
    if (
        python
        and infer_test_command(root)
        and _python_module_available(
            python, "coverage", root, tools.python_env if tools else None
        )
    ):
        test = infer_test_command(root) or []
        if len(test) >= 3 and test[1:3] == ["-m", "pytest"]:
            return (
                [
                    [python, "-m", "coverage", "erase"],
                    [python, "-m", "coverage", "run", "--branch", "-m", "pytest", "-q"],
                    [python, "-m", "coverage", "json", "-o", str(report_path)],
                ],
                "coverage-json",
            )
    if (root / "go.mod").exists() and executable(root, "go"):
        return (
            [
                [
                    executable(root, "go") or "go",
                    "test",
                    "./...",
                    f"-coverprofile={report_path}",
                ]
            ],
            "go-cover",
        )
    dependencies = package_dependencies(root)
    if "jest" in dependencies and executable(root, "npx"):
        return (
            [
                [
                    executable(root, "npx") or "npx",
                    "jest",
                    "--coverage",
                    "--coverageReporters=lcov",
                    "--runInBand",
                ]
            ],
            "lcov",
        )
    if "vitest" in dependencies and executable(root, "npx"):
        return (
            [
                [
                    executable(root, "npx") or "npx",
                    "vitest",
                    "run",
                    "--coverage",
                    "--coverage.reporter=lcov",
                ]
            ],
            "lcov",
        )
    cargo_llvm_cov = (
        tools.cargo_llvm_cov if tools else executable(root, "cargo-llvm-cov")
    )
    if (root / "Cargo.toml").exists() and cargo_llvm_cov:
        return (
            [
                [
                    cargo_llvm_cov,
                    "--all",
                    "--lcov",
                    "--output-path",
                    str(report_path),
                ]
            ],
            "lcov",
        )
    return None


def discover_coverage_report(root: Path) -> tuple[Path, str] | None:
    candidates = [
        (root / "coverage.json", "coverage-json"),
        (root / "coverage" / "coverage-final.json", "istanbul-json"),
        (root / "coverage" / "lcov.info", "lcov"),
        (root / "lcov.info", "lcov"),
        (root / "coverage.xml", "cobertura"),
        (root / "coverage" / "cobertura-coverage.xml", "cobertura"),
        (root / "cover.out", "go-cover"),
        (root / "coverage.out", "go-cover"),
    ]
    for path, format_name in candidates:
        if path.exists():
            return path, format_name
    for path in root.glob("**/jacoco.xml"):
        if not any(part in DEFAULT_EXCLUDED_DIRS for part in path.parts):
            return path, "jacoco"
    return None


def load_normalized_metrics(
    path: Path,
    root: Path,
    coverage_limit: float = 100.0,
    complexity_limit: float = 6.0,
    craap_limit: float = 6.0,
) -> list[FunctionMetric]:
    value = json.loads(path.read_text(encoding="utf-8"))
    rows = value.get("functions", []) if isinstance(value, dict) else []
    if not isinstance(rows, list):
        raise ValueError("Normalized metrics report must contain a 'functions' array")
    functions: list[FunctionMetric] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError(f"Function metric #{index + 1} must be an object")
        complexity = int(row["complexity"])
        covered = int(row.get("covered_lines", 0))
        total = int(row.get("total_lines", 0))
        coverage = float(
            row.get("coverage_percent", (100.0 * covered / total) if total else 0.0)
        )
        score = float(row.get("craap_score", craap_score(complexity, coverage)))
        functions.append(
            FunctionMetric(
                path=normalize_report_path(str(row["path"]), root),
                name=str(row["name"]),
                start_line=int(row.get("start_line", 1)),
                end_line=int(row.get("end_line") or row.get("start_line") or 1),
                complexity=complexity,
                covered_lines=covered,
                total_lines=total,
                coverage_percent=coverage,
                craap_score=score,
                parser=str(row.get("parser", "adapter")),
                coverage_limit=coverage_limit,
                complexity_limit=complexity_limit,
                craap_limit=craap_limit,
            )
        )
    return functions


def normalize_report_path(value: str, root: Path) -> str:
    path = Path(value)
    if path.is_absolute():
        return normalize_path(path, root)
    return Path(value).as_posix().lstrip("./")


def parse_coverage(
    path: Path, format_name: str, root: Path
) -> dict[str, dict[int, int]]:
    if format_name == "auto":
        name = path.name.lower()
        if name.endswith(".info"):
            format_name = "lcov"
        elif name.endswith(".xml"):
            format_name = "cobertura"
        elif name.endswith(".out"):
            format_name = "go-cover"
        else:
            format_name = "coverage-json"
    if format_name == "coverage-json":
        return parse_coverage_json(path, root)
    if format_name == "istanbul-json":
        return parse_istanbul_json(path, root)
    if format_name == "lcov":
        return parse_lcov(path, root)
    if format_name in {"cobertura", "jacoco"}:
        return parse_xml_coverage(path, root)
    if format_name == "go-cover":
        return parse_go_cover(path, root)
    raise ValueError(f"Unknown coverage format: {format_name}")


def parse_coverage_json(path: Path, root: Path) -> dict[str, dict[int, int]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    files = value.get("files", {}) if isinstance(value, dict) else {}
    result: dict[str, dict[int, int]] = {}
    for filename, details in files.items():
        executed = details.get("executed_lines", [])
        missing = details.get("missing_lines", [])
        lines = {int(line): 1 for line in executed}
        lines.update({int(line): 0 for line in missing})
        result[normalize_report_path(str(filename), root)] = lines
    return result


def parse_istanbul_json(path: Path, root: Path) -> dict[str, dict[int, int]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    result: dict[str, dict[int, int]] = {}
    for filename, details in value.items():
        if not isinstance(details, dict):
            continue
        statement_map = details.get("statementMap", {})
        statement_hits = details.get("s", {})
        lines: dict[int, int] = {}
        for statement_id, location in statement_map.items():
            try:
                line = int(location["start"]["line"])
                hit = int(statement_hits.get(statement_id, 0))
            except (KeyError, TypeError, ValueError):
                continue
            lines[line] = max(lines.get(line, 0), hit)
        result[normalize_report_path(str(filename), root)] = lines
    return result


def parse_lcov(path: Path, root: Path) -> dict[str, dict[int, int]]:
    result: dict[str, dict[int, int]] = {}
    current: str | None = None
    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if raw_line.startswith("SF:"):
            current = normalize_report_path(raw_line[3:], root)
            result.setdefault(current, {})
        elif raw_line.startswith("DA:") and current:
            parts = raw_line[3:].split(",")
            if len(parts) >= 2:
                result[current][int(parts[0])] = int(parts[1])
    return result


def parse_xml_coverage(path: Path, root: Path) -> dict[str, dict[int, int]]:
    tree = ET.parse(path)
    result: dict[str, dict[int, int]] = {}
    for class_node in tree.findall(".//class"):
        filename = class_node.attrib.get("filename")
        if not filename:
            continue
        relative = normalize_report_path(filename, root)
        lines = result.setdefault(relative, {})
        for line_node in class_node.findall(".//line"):
            if "number" in line_node.attrib:
                lines[int(line_node.attrib["number"])] = int(
                    float(line_node.attrib.get("hits", "0"))
                )
    if result:
        return result
    # JaCoCo stores package/sourcefile rather than a filename on class nodes.
    for package in tree.findall(".//package"):
        package_name = package.attrib.get("name", "")
        for source in package.findall("sourcefile"):
            filename = "/".join(
                part for part in (package_name, source.attrib.get("name", "")) if part
            )
            lines = result.setdefault(normalize_report_path(filename, root), {})
            for line_node in source.findall("line"):
                line = int(line_node.attrib["nr"])
                lines[line] = int(line_node.attrib.get("ci", "0"))
    return result


def parse_go_cover(path: Path, root: Path) -> dict[str, dict[int, int]]:
    result: dict[str, dict[int, int]] = {}
    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if raw_line.startswith("mode:") or not raw_line.strip():
            continue
        match = re.match(r"(.+):(\d+)\.\d+,(\d+)\.\d+\s+\d+\s+(\d+)$", raw_line)
        if not match:
            continue
        filename, start, end, count = match.groups()
        relative = _match_report_suffix(filename, root)
        lines = result.setdefault(relative, {})
        for line in range(int(start), int(end) + 1):
            lines[line] = max(lines.get(line, 0), int(count))
    return result


def _match_report_suffix(filename: str, root: Path) -> str:
    normalized = filename.replace("\\", "/")
    candidates = [normalize_path(path, root) for path in walk_files(root)]
    matching = [candidate for candidate in candidates if normalized.endswith(candidate)]
    return min(matching, key=len) if matching else normalized


def craap_score(complexity: int, coverage_percent: float) -> float:
    """The standard CRAP formula, named CRAAP here to match the requested gate."""
    uncovered = max(0.0, min(1.0, 1.0 - coverage_percent / 100.0))
    return complexity**2 * uncovered**3 + complexity


def parse_functions(path: Path, root: Path) -> list[tuple[str, int, int, int, str]]:
    if path.suffix.lower() in {".py", ".pyi"}:
        return parse_python_functions(path)
    return parse_brace_functions(path)


class PythonFunctionVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.functions: list[tuple[str, int, int, int, str]] = []
        self.scope: list[str] = []

    def visit_ClassDef(self, node: ast.ClassDef) -> Any:
        self.scope.append(node.name)
        self.generic_visit(node)
        self.scope.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> Any:
        self._visit_function(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> Any:
        self._visit_function(node)

    def _visit_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        name = ".".join([*self.scope, node.name])
        complexity = python_complexity(node)
        self.functions.append(
            (
                name,
                node.lineno,
                getattr(node, "end_lineno", node.lineno),
                complexity,
                "python-ast",
            )
        )
        self.scope.append(node.name)
        self.generic_visit(node)
        self.scope.pop()


class PythonComplexityVisitor(ast.NodeVisitor):
    def __init__(self, root: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        self.root = root
        self.complexity = 1

    def visit_FunctionDef(self, node: ast.FunctionDef) -> Any:
        if node is self.root:
            self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> Any:
        if node is self.root:
            self.generic_visit(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> Any:
        return None

    def visit_Lambda(self, node: ast.Lambda) -> Any:
        return None

    def generic_visit(self, node: ast.AST) -> Any:
        if isinstance(
            node,
            (
                ast.If,
                ast.For,
                ast.AsyncFor,
                ast.While,
                ast.ExceptHandler,
                ast.IfExp,
                ast.comprehension,
            ),
        ):
            self.complexity += 1
        elif isinstance(node, ast.BoolOp):
            self.complexity += max(0, len(node.values) - 1)
        elif isinstance(node, ast.Match):
            self.complexity += len(node.cases)
        return super().generic_visit(node)


def python_complexity(node: ast.FunctionDef | ast.AsyncFunctionDef) -> int:
    visitor = PythonComplexityVisitor(node)
    visitor.visit(node)
    return visitor.complexity


def parse_python_functions(path: Path) -> list[tuple[str, int, int, int, str]]:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (OSError, UnicodeDecodeError, SyntaxError):
        return []
    visitor = PythonFunctionVisitor()
    visitor.visit(tree)
    return visitor.functions


CONTROL_PREFIXES = {
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "with",
    "when",
    "match",
    "else",
    "do",
}
FUNCTION_HEADER = re.compile(
    r"(?P<name>[A-Za-z_$~][\w$.:<>~]*)\s*\([^;{}]*\)\s*(?:throws\s+[^{]+)?\{\s*$",
    re.MULTILINE,
)


def parse_brace_functions(path: Path) -> list[tuple[str, int, int, int, str]]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    masked = mask_strings_and_comments(text)
    functions: list[tuple[str, int, int, int, str]] = []
    for match in FUNCTION_HEADER.finditer(masked):
        name = match.group("name").split("::")[-1].split(".")[-1]
        if name in CONTROL_PREFIXES:
            continue
        open_brace = masked.rfind("{", match.start(), match.end())
        close_brace = matching_brace(masked, open_brace)
        if close_brace < 0:
            continue
        start_line = text.count("\n", 0, match.start()) + 1
        end_line = text.count("\n", 0, close_brace) + 1
        body = masked[open_brace + 1 : close_brace]
        branches = re.findall(
            r"\b(?:if|for|while|case|catch|when)\b|&&|\|\||(?<!\?)\?(?!\?)", body
        )
        functions.append(
            (name, start_line, end_line, 1 + len(branches), "generic-brace")
        )
    return remove_nested_duplicates(functions)


def remove_nested_duplicates(
    functions: list[tuple[str, int, int, int, str]],
) -> list[tuple[str, int, int, int, str]]:
    seen: set[tuple[int, int]] = set()
    result = []
    for function in functions:
        span = (function[1], function[2])
        if span not in seen:
            result.append(function)
            seen.add(span)
    return result


def mask_strings_and_comments(text: str) -> str:
    chars = list(text)
    index = 0
    state = "code"
    quote = ""
    while index < len(chars):
        current = chars[index]
        following = chars[index + 1] if index + 1 < len(chars) else ""
        if state == "code":
            if current in {"'", '"', "`"}:
                state, quote = "string", current
                chars[index] = " "
            elif current == "/" and following == "/":
                state = "line-comment"
                chars[index] = chars[index + 1] = " "
                index += 1
            elif current == "/" and following == "*":
                state = "block-comment"
                chars[index] = chars[index + 1] = " "
                index += 1
            elif current == "#":
                state = "line-comment"
                chars[index] = " "
        elif state == "string":
            if current == "\\":
                chars[index] = " "
                if index + 1 < len(chars) and chars[index + 1] != "\n":
                    chars[index + 1] = " "
                    index += 1
            elif current == quote:
                chars[index] = " "
                state = "code"
            elif current != "\n":
                chars[index] = " "
        elif state == "line-comment":
            if current == "\n":
                state = "code"
            else:
                chars[index] = " "
        elif state == "block-comment":
            if current == "*" and following == "/":
                chars[index] = chars[index + 1] = " "
                index += 1
                state = "code"
            elif current != "\n":
                chars[index] = " "
        index += 1
    return "".join(chars)


def mask_comments(text: str) -> str:
    """Blank comments while preserving strings and character positions."""
    chars = list(text)
    index = 0
    state = "code"
    quote = ""
    while index < len(chars):
        current = chars[index]
        following = chars[index + 1] if index + 1 < len(chars) else ""
        if state == "code":
            if current in {"'", '"', "`"}:
                state, quote = "string", current
            elif current == "/" and following == "/":
                state = "line-comment"
                chars[index] = chars[index + 1] = " "
                index += 1
            elif current == "/" and following == "*":
                state = "block-comment"
                chars[index] = chars[index + 1] = " "
                index += 1
            elif current == "#" and not re.match(r"#\s*include\b", text[index:]):
                state = "line-comment"
                chars[index] = " "
        elif state == "string":
            if current == "\\":
                index += 1
            elif current == quote:
                state = "code"
        elif state == "line-comment":
            if current == "\n":
                state = "code"
            else:
                chars[index] = " "
        elif state == "block-comment":
            if current == "*" and following == "/":
                chars[index] = chars[index + 1] = " "
                index += 1
                state = "code"
            elif current != "\n":
                chars[index] = " "
        index += 1
    return "".join(chars)


def matching_brace(text: str, open_index: int) -> int:
    depth = 0
    for index in range(open_index, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return index
    return -1


def build_function_metrics(
    source_files: Sequence[Path],
    root: Path,
    coverage: dict[str, dict[int, int]],
    coverage_limit: float = 100.0,
    complexity_limit: float = 6.0,
    craap_limit: float = 6.0,
    external_functions: dict[str, list[tuple[str, int, int, int, str]]] | None = None,
) -> list[FunctionMetric]:
    external_functions = external_functions or {}
    functions: list[FunctionMetric] = []
    for path in source_files:
        relative = normalize_path(path, root)
        line_hits = find_coverage_lines(relative, coverage)
        parsed = external_functions.get(relative)
        if parsed is None:
            parsed = parse_functions(path, root)
        for name, start, end, complexity, parser in parsed:
            relevant = {
                line: hits for line, hits in line_hits.items() if start <= line <= end
            }
            covered = sum(1 for hits in relevant.values() if hits > 0)
            total = len(relevant)
            percent = (100.0 * covered / total) if total else 0.0
            functions.append(
                FunctionMetric(
                    path=relative,
                    name=name,
                    start_line=start,
                    end_line=end,
                    complexity=complexity,
                    covered_lines=covered,
                    total_lines=total,
                    coverage_percent=percent,
                    craap_score=craap_score(complexity, percent),
                    parser=parser,
                    coverage_limit=coverage_limit,
                    complexity_limit=complexity_limit,
                    craap_limit=craap_limit,
                )
            )
    return sorted(functions, key=lambda item: (item.path, item.start_line, item.name))


LIZARD_HELPER = r"""
import json
from pathlib import Path
import sys
import lizard

request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
result = {"files": {}}
for filename in request["files"]:
    analysis = lizard.analyze_file(filename)
    result["files"][filename] = [
        {
            "name": function.name,
            "start_line": function.start_line,
            "end_line": function.end_line,
            "complexity": function.cyclomatic_complexity,
        }
        for function in analysis.function_list
    ]
Path(sys.argv[2]).write_text(json.dumps(result), encoding="utf-8")
"""


def analyze_with_lizard(
    source_files: Sequence[Path],
    root: Path,
    workspace: Path,
    tools: ToolContext,
) -> tuple[dict[str, list[tuple[str, int, int, int, str]]], CommandResult | None]:
    candidates = [
        path for path in source_files if path.suffix.lower() in LIZARD_EXTENSIONS
    ]
    if not candidates or not tools.lizard_available:
        return {}, None
    request_path = workspace / "lizard-request.json"
    output_path = workspace / "lizard-result.json"
    request_path.write_text(
        json.dumps({"files": [str(path) for path in candidates]}), encoding="utf-8"
    )
    result = run_command(
        [
            tools.python,
            "-c",
            LIZARD_HELPER,
            str(request_path),
            str(output_path),
        ],
        root,
        600,
        tools.python_env,
    )
    if result.returncode != 0 or not output_path.exists():
        return {}, result
    try:
        value = json.loads(output_path.read_text(encoding="utf-8"))
        files = value.get("files", {})
        parsed: dict[str, list[tuple[str, int, int, int, str]]] = {}
        for filename, rows in files.items():
            relative = normalize_report_path(str(filename), root)
            parsed[relative] = [
                (
                    str(row["name"]),
                    int(row["start_line"]),
                    int(row["end_line"]),
                    int(row["complexity"]),
                    "lizard",
                )
                for row in rows
            ]
        return parsed, result
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError):
        return {}, result


def find_coverage_lines(
    relative: str, coverage: dict[str, dict[int, int]]
) -> dict[int, int]:
    if relative in coverage:
        return coverage[relative]
    matches = [
        lines
        for name, lines in coverage.items()
        if name.endswith(relative) or relative.endswith(name)
    ]
    return matches[0] if len(matches) == 1 else {}


def cleaner_prompt(function: FunctionMetric) -> str:
    return f"""You are the cleaner agent. Fix the CRAAP gate failure in {function.path}:{function.start_line} for `{function.name}`.

Current evidence:
- line coverage: {function.coverage_percent:.2f}% ({function.covered_lines}/{function.total_lines})
- cyclomatic complexity: {function.complexity}
- CRAAP score: {function.craap_score:.2f}
- required: {function.coverage_limit:g}% coverage, complexity <= {function.complexity_limit:g}, and CRAAP <= {function.craap_limit:g}

Read the function, its callers, and neighboring tests. Add behavior-focused tests for every uncovered path, then simplify control flow without changing behavior until complexity and CRAAP satisfy the threshold. Preserve error paths and public contracts. Run the repository's real coverage command and report the exact before/after metrics; do not exclude lines, weaken assertions, or mock the function under test."""


def report_fingerprint(path: Path) -> tuple[int, int, int] | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return stat.st_ino, stat.st_size, stat.st_mtime_ns


def report_was_refreshed(
    path: Path, previous_fingerprint: tuple[int, int, int] | None
) -> bool:
    current_fingerprint = report_fingerprint(path)
    return (
        current_fingerprint is not None and current_fingerprint != previous_fingerprint
    )


def failed_metrics_command_gate(
    summary: str,
    commands: Sequence[CommandResult],
    failures: Sequence[CommandResult],
    repair_kind: str,
) -> GateResult:
    return GateResult(
        "craap",
        "CRAAP: coverage + complexity",
        False,
        summary,
        [result.stdout for result in failures if result.stdout],
        list(commands),
        [
            (
                f"Repair {repair_kind}",
                generic_adapter_prompt(repair_kind, result),
            )
            for result in failures
        ],
    )


def mark_metrics_report_diagnostic(
    result: GateResult,
    failures: Sequence[CommandResult],
    repair_kind: str,
) -> GateResult:
    count = len(failures)
    noun = "command" if count == 1 else "commands"
    result.passed = False
    result.summary = (
        f"{count} {repair_kind} {noun} exited non-zero, but the valid report was "
        f"parsed diagnostically. {result.summary}"
    )
    result.details = [
        f"Diagnostic report retained after exit {failure.returncode}: "
        f"{shlex.join(failure.command)}"
        for failure in failures
    ] + result.details
    result.prompts = [
        (
            f"Repair {repair_kind}",
            generic_adapter_prompt(repair_kind, failure),
        )
        for failure in failures
    ] + result.prompts
    return result


def run_metrics_gate(
    root: Path,
    config: dict[str, Any],
    source_files: Sequence[Path],
    workspace: Path,
    tools: ToolContext,
) -> tuple[GateResult, list[FunctionMetric]]:
    metrics = config["metrics"]
    coverage_limit = float(metrics.get("coverage_limit", 100))
    complexity_limit = float(metrics.get("complexity_limit", 6))
    craap_limit = float(metrics.get("craap_limit", metrics.get("complexity_limit", 6)))
    command_results: list[CommandResult] = []
    substitutions = {"root": str(root), "report": str(workspace / "metrics.json")}
    adapter_command = command_list(metrics.get("command"), substitutions)
    report_value = metrics.get("report")
    metrics_path = (
        resolve_config_path(substitute_text(str(report_value), substitutions), root)
        if report_value
        else None
    )
    metrics_report_before = report_fingerprint(metrics_path) if metrics_path else None
    adapter_failures: list[CommandResult] = []
    if adapter_command:
        command_results.append(
            run_command(
                adapter_command,
                root,
                int(metrics.get("timeout_seconds", 600)),
                tools.python_env,
            )
        )
        if command_results[-1].returncode != 0:
            adapter_failures.append(command_results[-1])
            if not metrics_path or not report_was_refreshed(
                metrics_path, metrics_report_before
            ):
                return failed_metrics_command_gate(
                    "The metrics adapter failed and did not produce a fresh report.",
                    command_results,
                    adapter_failures,
                    "metrics adapter",
                ), []
    if report_value:
        assert metrics_path is not None
        if metrics_path.exists():
            try:
                functions = load_normalized_metrics(
                    metrics_path,
                    root,
                    coverage_limit,
                    complexity_limit,
                    craap_limit,
                )
                selected_paths = {normalize_path(path, root) for path in source_files}
                functions = [
                    function
                    for function in functions
                    if function.path in selected_paths
                ]
                result = finish_metrics_gate(functions, command_results)
                if adapter_failures:
                    result = mark_metrics_report_diagnostic(
                        result, adapter_failures, "metrics adapter"
                    )
                return result, functions
            except (
                OSError,
                ValueError,
                KeyError,
                TypeError,
                json.JSONDecodeError,
            ) as error:
                return GateResult(
                    "craap",
                    "CRAAP: coverage + complexity",
                    False,
                    f"The normalized metrics report is invalid: {error}",
                    [],
                    command_results,
                    [("Fix metrics report", normalized_metrics_prompt(str(error)))],
                ), []
        return GateResult(
            "craap",
            "CRAAP: coverage + complexity",
            False,
            f"Metrics report not found: {metrics_path}",
            [],
            command_results,
            [
                (
                    "Configure metrics",
                    normalized_metrics_prompt("report file was not produced"),
                )
            ],
        ), []

    coverage_report: tuple[Path, str] | None = None
    configured_commands = metrics.get("coverage_commands", [])
    configured_report = metrics.get("coverage_report")
    coverage_substitutions = {
        "root": str(root),
        "report": str(workspace / "coverage.data"),
    }
    configured_report_path = (
        resolve_config_path(
            substitute_text(str(configured_report), coverage_substitutions), root
        )
        if configured_report
        else None
    )
    coverage_report_before = (
        report_fingerprint(configured_report_path) if configured_report_path else None
    )
    coverage_failures: list[CommandResult] = []
    if configured_commands:
        for raw_command in configured_commands:
            command = command_list(raw_command, coverage_substitutions)
            if not command:
                continue
            command_result = run_command(
                command,
                root,
                int(metrics.get("timeout_seconds", 600)),
                tools.python_env,
            )
            command_results.append(command_result)
            if command_result.returncode != 0:
                coverage_failures.append(command_result)
        if configured_report_path:
            coverage_report = (
                configured_report_path,
                str(metrics.get("coverage_format", "auto")),
            )
    elif configured_report_path:
        coverage_report = (
            configured_report_path,
            str(metrics.get("coverage_format", "auto")),
        )
    else:
        inferred_path = workspace / "coverage.data"
        discovered_before = discover_coverage_report(root)
        discovered_before_fingerprint = (
            report_fingerprint(discovered_before[0]) if discovered_before else None
        )
        inferred = infer_coverage_commands(root, inferred_path, tools)
        if inferred:
            commands, format_name = inferred
            for command in commands:
                command_result = run_command(
                    command,
                    root,
                    int(metrics.get("timeout_seconds", 600)),
                    tools.python_env,
                )
                command_results.append(command_result)
                if command_result.returncode != 0:
                    coverage_failures.append(command_result)
            if format_name == "lcov" and not inferred_path.exists():
                discovered = discover_coverage_report(root)
                coverage_report = discovered
                if (
                    discovered_before
                    and discovered
                    and discovered_before[0] == discovered[0]
                ):
                    coverage_report_before = discovered_before_fingerprint
            else:
                coverage_report = (inferred_path, format_name)
        else:
            coverage_report = discover_coverage_report(root)

    if coverage_failures and (
        not coverage_report
        or not report_was_refreshed(coverage_report[0], coverage_report_before)
    ):
        return failed_metrics_command_gate(
            "Coverage commands failed and did not produce a fresh report.",
            command_results,
            coverage_failures,
            "coverage",
        ), []

    if not coverage_report or not coverage_report[0].exists():
        return GateResult(
            "craap",
            "CRAAP: coverage + complexity",
            False,
            "No coverage adapter or supported coverage report was available.",
            [
                "Configure metrics.command + metrics.report for any language, or coverage_commands + coverage_report for a supported coverage format."
            ],
            command_results,
            [
                (
                    "Configure language metrics",
                    normalized_metrics_prompt("coverage could not be measured"),
                )
            ],
        ), []
    try:
        coverage = parse_coverage(coverage_report[0], coverage_report[1], root)
    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        json.JSONDecodeError,
        ET.ParseError,
    ) as error:
        return GateResult(
            "craap",
            "CRAAP: coverage + complexity",
            False,
            f"Coverage report could not be parsed: {error}",
            [],
            command_results,
            [("Fix coverage report", normalized_metrics_prompt(str(error)))],
        ), []
    lizard_functions, lizard_result = analyze_with_lizard(
        source_files, root, workspace, tools
    )
    if lizard_result:
        command_results.append(lizard_result)
    functions = build_function_metrics(
        source_files,
        root,
        coverage,
        coverage_limit,
        complexity_limit,
        craap_limit,
        lizard_functions,
    )
    heuristic_files = sorted(
        normalize_path(path, root)
        for path in source_files
        if path.suffix.lower() not in {".py", ".pyi"}
        and normalize_path(path, root) not in lizard_functions
    )
    result = finish_metrics_gate(functions, command_results, heuristic_files)
    if coverage_failures:
        result = mark_metrics_report_diagnostic(result, coverage_failures, "coverage")
    return result, functions


def finish_metrics_gate(
    functions: list[FunctionMetric],
    commands: list[CommandResult],
    heuristic_files: Sequence[str] = (),
) -> GateResult:
    if not functions:
        return GateResult(
            "craap",
            "CRAAP: coverage + complexity",
            False,
            "No function-level metrics were produced.",
            [
                "Use a normalized metrics adapter when the built-in syntax scanner does not understand the repository language."
            ],
            commands,
            [
                (
                    "Add a metrics adapter",
                    normalized_metrics_prompt("no functions were discovered"),
                )
            ],
        )
    coverage_limit = functions[0].coverage_limit
    complexity_limit = functions[0].complexity_limit
    craap_limit = functions[0].craap_limit
    failures = sorted(
        (function for function in functions if not function.passed),
        key=lambda function: (
            -function.craap_score,
            function.coverage_percent,
            function.path,
            function.start_line,
        ),
    )
    details = [
        f"{function.path}:{function.start_line} {function.name}: coverage {function.coverage_percent:.2f}%, complexity {function.complexity}, CRAAP {function.craap_score:.2f}"
        for function in failures[:100]
    ]
    prompts = [
        (
            f"Fix {function.path}:{function.start_line} {function.name}",
            cleaner_prompt(function),
        )
        for function in failures
    ]
    if heuristic_files:
        details.insert(
            0,
            f"A semantic metrics adapter is required for {len(heuristic_files)} non-Python source files; the built-in brace scan is diagnostic only.",
        )
        prompts.insert(
            0,
            (
                "Add a semantic language adapter",
                normalized_metrics_prompt(
                    f"{len(heuristic_files)} files use syntax that the portable fallback cannot certify"
                ),
            ),
        )
        return GateResult(
            "craap",
            "CRAAP: coverage + complexity",
            False,
            f"Semantic adapter required for {len(heuristic_files)} files; {len(failures)} measured functions also fail thresholds.",
            details,
            commands,
            prompts,
        )
    if failures:
        return GateResult(
            "craap",
            "CRAAP: coverage + complexity",
            False,
            f"{len(failures)} of {len(functions)} functions fail {coverage_limit:g}% coverage, complexity <= {complexity_limit:g}, or CRAAP <= {craap_limit:g}.",
            details,
            commands,
            prompts,
        )
    return GateResult(
        "craap",
        "CRAAP: coverage + complexity",
        True,
        f"All {len(functions)} functions have {coverage_limit:g}% coverage, complexity <= {complexity_limit:g}, and CRAAP <= {craap_limit:g}.",
        [],
        commands,
    )


def resolve_config_path(value: str, root: Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else root / path


def generic_adapter_prompt(kind: str, result: CommandResult) -> str:
    return f"""Repair the repository's {kind} quality-gate adapter.

Command: {shlex.join(result.command)}
Exit code: {result.returncode}
Timed out: {result.timed_out}
Output:
{result.stdout[-4000:]}

Run the command directly, diagnose the first real failure, and make the smallest correct change. Do not disable the gate or replace a failing command with a no-op. Re-run the full quality gate and preserve the command's deterministic non-zero-on-failure contract."""


def normalized_metrics_prompt(reason: str) -> str:
    return f"""Create or repair a language adapter for the repository quality gate. Reason: {reason}.

Configure `metrics.command` to run the language's real coverage and cyclomatic-complexity tools and `metrics.report` to point to normalized JSON with this shape:
{{"functions":[{{"path":"src/file.ext","name":"functionName","start_line":1,"end_line":10,"complexity":2,"covered_lines":5,"total_lines":5,"coverage_percent":100}}]}}

Include every production function. Use executable-line coverage, not file averages. The gate requires exactly 100% coverage and computes CRAAP as complexity^2 * (1 - coverage/100)^3 + complexity, with a maximum of 6. Do not invent measurements or omit failing functions."""


def operator_offsets(
    path: Path, operators: dict[str, str]
) -> list[tuple[int, int, int, str, str]]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    if path.suffix.lower() in {".py", ".pyi"}:
        return python_operator_offsets(text, operators)
    masked = mask_strings_and_comments(text)
    pattern = re.compile(
        "|".join(
            re.escape(operator) for operator in sorted(operators, key=len, reverse=True)
        )
    )
    offsets: list[tuple[int, int, int, str, str]] = []
    for match in pattern.finditer(masked):
        original = match.group(0)
        if original in {"+", "-"} and not is_binary_sign(
            masked, match.start(), match.end()
        ):
            continue
        if original in {"<", ">"} and _part_of_compound_operator(
            masked, match.start(), match.end()
        ):
            continue
        line = text.count("\n", 0, match.start()) + 1
        line_start = text.rfind("\n", 0, match.start()) + 1
        offsets.append(
            (
                match.start(),
                line,
                match.start() - line_start + 1,
                original,
                str(operators[original]),
            )
        )
    return offsets


def python_operator_offsets(
    text: str, operators: dict[str, str]
) -> list[tuple[int, int, int, str, str]]:
    line_offsets = [0]
    for match in re.finditer("\n", text):
        line_offsets.append(match.end())
    offsets: list[tuple[int, int, int, str, str]] = []
    try:
        tokens = tokenize.generate_tokens(iter(text.splitlines(keepends=True)).__next__)
        for token in tokens:
            if token.type != tokenize.OP or token.string not in operators:
                continue
            line, column_zero = token.start
            absolute = line_offsets[line - 1] + column_zero
            if token.string in {"+", "-"} and not is_binary_sign(
                text, absolute, absolute + 1
            ):
                continue
            offsets.append(
                (
                    absolute,
                    line,
                    column_zero + 1,
                    token.string,
                    str(operators[token.string]),
                )
            )
    except (tokenize.TokenError, IndentationError):
        return []
    return offsets


def is_binary_sign(text: str, start: int, end: int) -> bool:
    left = start - 1
    while left >= 0 and text[left].isspace():
        left -= 1
    right = end
    while right < len(text) and text[right].isspace():
        right += 1
    if left < 0 or right >= len(text):
        return False
    left_char, right_char = text[left], text[right]
    if left_char in "([{,:;=<>!&|?+-*/%^~" or right_char in ")]},:;=<>!&|?+-*/%^~":
        return False
    return True


def _part_of_compound_operator(text: str, start: int, end: int) -> bool:
    before = text[start - 1] if start else ""
    after = text[end] if end < len(text) else ""
    return before in "-=<>" or after in "=-<>"


def mutation_prompt(mutation: Mutation) -> str:
    return f"""You are the hardener agent. Kill surviving mutant `{mutation.mutant_id}` in {mutation.path}:{mutation.line}:{mutation.column}.

Mutation: `{mutation.original}` -> `{mutation.replacement}`
Mutation result: `{mutation.status or "Survived"}`. {mutation.output}

First decide which externally visible behavior differs under this mutation. Add the smallest behavior-focused test through the production API that fails with the mutant and passes on the original code. If the mutant is genuinely equivalent, simplify the production expression so the equivalent mutation site disappears; do not mark it ignored. Re-run the single mutant, then the full mutation gate. Do not assert implementation details or weaken the zero-survivor threshold."""


def stryker_config(
    root: Path,
    source_files: Sequence[Path],
    report_path: Path,
    incremental_path: Path,
    workers: int,
    incremental: bool = True,
    mutation_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a semantic operator-only Stryker configuration for an isolated snapshot."""
    mutation_config = mutation_config or {}
    mutate = [
        normalize_path(path, root)
        for path in source_files
        if path.suffix.lower() in JAVASCRIPT_MUTATION_EXTENSIONS
        and not path.name.endswith(".d.ts")
    ]
    test_files = mutation_config.get("test_files", [])
    if not isinstance(test_files, list) or any(
        not isinstance(pattern, str) or not pattern.strip() for pattern in test_files
    ):
        raise ValueError("mutation.test_files must be an array of non-empty globs")
    if any(
        Path(pattern.lstrip("!")).is_absolute()
        or ".." in Path(pattern.lstrip("!")).parts
        for pattern in test_files
    ):
        raise ValueError("mutation.test_files globs must stay inside the repository")
    related = mutation_config.get("vitest_related", True)
    if not isinstance(related, bool):
        raise ValueError("mutation.vitest_related must be true or false")
    vitest: dict[str, Any] = {"related": related}
    config_path = mutation_vitest_config_path(
        root, mutation_config.get("vitest_config")
    )
    if config_path:
        vitest["configFile"] = config_path
    vitest_dir = snapshot_relative_directory(
        root, mutation_config.get("vitest_dir"), "mutation.vitest_dir"
    )
    if vitest_dir:
        vitest["dir"] = vitest_dir
    config: dict[str, Any] = {
        "testRunner": "vitest",
        "mutate": mutate,
        "mutator": {"excludedMutations": STRYKER_EXCLUDED_MUTATORS},
        "reporters": ["json"],
        "jsonReporter": {"fileName": str(report_path)},
        "incremental": incremental,
        "incrementalFile": str(incremental_path),
        "inPlace": True,
        "tempDirName": "node_modules/.cache/repo-quality-gate-stryker",
        "cleanTempDir": "always",
        "concurrency": workers,
        "vitest": vitest,
        "thresholds": {"high": 100, "low": 100, "break": 100},
    }
    if test_files:
        config["testFiles"] = test_files
    return config


MUTATION_VITEST_CONFIG_NAMES = (
    "vitest.mutation.config.ts",
    "vitest.mutation.config.js",
    "vitest.mutation.config.mts",
    "vitest.mutation.config.mjs",
    "vitest.mutation.config.cts",
    "vitest.mutation.config.cjs",
)


def snapshot_relative_path(root: Path, value: Any, key: str) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValueError(f"{key} must be a repository-relative path")
    path = Path(value)
    resolved = path.resolve() if path.is_absolute() else (root / path).resolve()
    try:
        relative = resolved.relative_to(root.resolve())
    except ValueError as error:
        raise ValueError(f"{key} must stay inside the repository") from error
    return relative.as_posix()


def mutation_vitest_config_path(root: Path, configured: Any) -> str | None:
    relative = snapshot_relative_path(root, configured, "mutation.vitest_config")
    if relative is None:
        relative = next(
            (name for name in MUTATION_VITEST_CONFIG_NAMES if (root / name).is_file()),
            None,
        )
    if relative is not None and not (root / relative).is_file():
        raise ValueError(f"mutation.vitest_config does not exist: {relative}")
    return relative


def snapshot_relative_directory(root: Path, value: Any, key: str) -> str | None:
    relative = snapshot_relative_path(root, value, key)
    if relative is not None and not (root / relative).is_dir():
        raise ValueError(f"{key} is not a directory: {relative}")
    return relative


def source_range(source: str, start: dict[str, Any], end: dict[str, Any]) -> str:
    lines = source.splitlines(keepends=True)
    try:
        start_line = int(start["line"])
        end_line = int(end["line"])
        start_column = int(start["column"])
        end_column = int(end["column"])
        start_offset = sum(len(line) for line in lines[: start_line - 1]) + start_column
        end_offset = sum(len(line) for line in lines[: end_line - 1]) + end_column
    except (KeyError, TypeError, ValueError):
        return "unknown"
    return source[start_offset:end_offset]


def parse_stryker_report(path: Path) -> list[Mutation]:
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(
            f"Cannot read Stryker mutation report {path}: {error}"
        ) from error
    files = report.get("files") if isinstance(report, dict) else None
    if not isinstance(files, dict):
        raise ValueError("Stryker mutation report is missing its files object")
    results: list[Mutation] = []
    for filename, file_report in files.items():
        if not isinstance(file_report, dict):
            continue
        source = str(file_report.get("source", ""))
        mutants = file_report.get("mutants", [])
        if not isinstance(mutants, list):
            continue
        for mutant in mutants:
            if not isinstance(mutant, dict):
                continue
            location = mutant.get("location", {})
            start = location.get("start", {}) if isinstance(location, dict) else {}
            end = location.get("end", {}) if isinstance(location, dict) else {}
            original = source_range(source, start, end)
            replacement = str(mutant.get("replacement", ""))
            status = str(mutant.get("status", "Unknown"))
            mutator_name = str(mutant.get("mutatorName", ""))
            if status == "Ignored" and mutator_name in STRYKER_EXCLUDED_MUTATORS:
                continue
            line = int(start.get("line", 0)) if isinstance(start, dict) else 0
            column = int(start.get("column", 0)) + 1 if isinstance(start, dict) else 0
            identity = hashlib.sha256(
                f"{filename}:{line}:{column}:{original}:{replacement}".encode()
            ).hexdigest()[:12]
            reason = str(mutant.get("statusReason", "")).strip()
            output = f"Stryker status: {status}"
            if reason:
                output += f" ({reason})"
            results.append(
                Mutation(
                    identity,
                    str(filename),
                    line,
                    column,
                    original[:200],
                    replacement[:200],
                    status != "Killed",
                    status == "Timeout",
                    float(mutant.get("duration", 0) or 0),
                    output,
                    status,
                    bool(mutant.get("static", False)),
                )
            )
    return results


def stryker_environment_fingerprint(
    root: Path, mutation_config: dict[str, Any] | None = None
) -> str:
    digest = hashlib.sha256(f"stryker-{STRYKER_VERSION}".encode())
    mutation_config = mutation_config or {}
    digest.update(
        json.dumps(
            {
                key: mutation_config.get(key)
                for key in (
                    "test_files",
                    "vitest_config",
                    "vitest_dir",
                    "vitest_related",
                )
            },
            sort_keys=True,
        ).encode()
    )
    relevant_names = {
        "package.json",
        "package-lock.json",
        "npm-shrinkwrap.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lock",
        "bun.lockb",
    }
    for path in sorted(walk_files(root)):
        name = path.name.lower()
        if not (
            name in relevant_names
            or name.startswith("tsconfig")
            or name.startswith("vitest.config")
            or name.startswith("vitest.mutation.config")
            or name.startswith("vite.config")
        ):
            continue
        digest.update(normalize_path(path, root).encode())
        with contextlib.suppress(OSError):
            digest.update(path.read_bytes())
    configured_vitest = mutation_vitest_config_path(
        root, mutation_config.get("vitest_config")
    )
    if configured_vitest:
        path = root / configured_vitest
        digest.update(configured_vitest.encode())
        with contextlib.suppress(OSError):
            digest.update(path.read_bytes())
    return digest.hexdigest()[:16]


def stryker_incremental_path(
    root: Path,
    tools: ToolContext,
    mutation_config: dict[str, Any] | None = None,
) -> Path:
    repository_key = hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:16]
    fingerprint = stryker_environment_fingerprint(root, mutation_config)
    return tools.cache_dir / "mutation" / repository_key / f"stryker-{fingerprint}.json"


def mutation_proof_fingerprint(
    root: Path,
    source_files: Sequence[Path],
    mutation_config: dict[str, Any],
) -> str:
    digest = hashlib.sha256(
        stryker_environment_fingerprint(root, mutation_config).encode()
    )
    digest.update(json.dumps(mutation_config, sort_keys=True).encode())
    digest.update(json.dumps(STRYKER_EXCLUDED_MUTATORS, sort_keys=True).encode())
    included: set[Path] = set()
    for path in source_files:
        included.add(path.resolve())
    for path in walk_files(root):
        relative = normalize_path(path, root)
        if matches_any(relative, DEFAULT_TEST_PATTERNS):
            included.add(path.resolve())
    for path in sorted(included):
        digest.update(normalize_path(path, root).encode())
        try:
            digest.update(path.read_bytes())
        except OSError as error:
            digest.update(f"unreadable:{error}".encode())
    return digest.hexdigest()


def load_stryker_proof_cache(
    report_path: Path, metadata_path: Path, fingerprint: str
) -> list[Mutation] | None:
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(metadata, dict):
        return None
    if (
        metadata.get("fingerprint") != fingerprint
        or metadata.get("complete") is not True
    ):
        return None
    try:
        mutations = parse_stryker_report(report_path)
    except ValueError:
        return None
    return mutations or None


def store_stryker_proof_cache(
    source_report: Path,
    report_path: Path,
    metadata_path: Path,
    fingerprint: str,
) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_temporary = report_path.with_name(f".{report_path.name}.{os.getpid()}.tmp")
    metadata_temporary = metadata_path.with_name(
        f".{metadata_path.name}.{os.getpid()}.tmp"
    )
    shutil.copyfile(source_report, report_temporary)
    os.replace(report_temporary, report_path)
    metadata_temporary.write_text(
        json.dumps(
            {
                "complete": True,
                "fingerprint": fingerprint,
                "stryker_version": STRYKER_VERSION,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    os.replace(metadata_temporary, metadata_path)


def resolve_stryker_workers(value: Any) -> int:
    if isinstance(value, bool):
        raise ValueError("mutation workers must be `auto` or a positive integer")
    if isinstance(value, str) and value.strip().lower() == "auto":
        available = os.cpu_count() or 1
        return available if available <= 4 else available - 1
    try:
        workers = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(
            "mutation workers must be `auto` or a positive integer"
        ) from error
    if workers < 1:
        raise ValueError("mutation workers must be `auto` or a positive integer")
    return workers


def supports_native_vitest_mutation(
    root: Path, source_files: Sequence[Path], tools: ToolContext | None
) -> bool:
    return bool(
        tools
        and tools.stryker_command
        and source_files
        and all(
            path.suffix.lower() in JAVASCRIPT_MUTATION_EXTENSIONS
            for path in source_files
        )
        and "vitest" in package_dependencies(root)
    )


def finish_stryker_mutation_gate(
    mutations: list[Mutation],
    baseline: CommandResult,
    result: CommandResult,
    workers: int,
    cache_summary: str,
) -> tuple[GateResult, list[Mutation]]:
    if not mutations:
        return GateResult(
            "mutation",
            "Mutation testing",
            False,
            "The native adapter generated no semantic operator mutants.",
            prompts=[
                (
                    "Repair mutation discovery",
                    "Inspect the selected JavaScript/TypeScript production files and Stryker configuration. Do not claim zero survivors from an empty mutant set.",
                )
            ],
        ), []
    failures = [mutation for mutation in mutations if mutation.survived]
    static_count = sum(mutation.static for mutation in mutations)
    performance_summary = (
        f"; {static_count} static mutant{'s' if static_count != 1 else ''}; "
        f"native phase {result.duration_seconds:.2f}s"
    )
    prompts = [
        (f"Kill mutant {mutation.mutant_id}", mutation_prompt(mutation))
        for mutation in failures
    ]
    if failures:
        status_counts: dict[str, int] = {}
        for mutation in failures:
            status_counts[mutation.status] = status_counts.get(mutation.status, 0) + 1
        status_summary = ", ".join(
            f"{count} {status}" for status, count in sorted(status_counts.items())
        )
        return GateResult(
            "mutation",
            "Mutation testing",
            False,
            f"Native semantic mutation tested {len(mutations)} mutants with {workers} workers{cache_summary}{performance_summary}; {len(failures)} were not assertion-killed ({status_summary}).",
            [
                f"{mutation.path}:{mutation.line}:{mutation.column} {mutation.status} {mutation.original}->{mutation.replacement}{' [static]' if mutation.static else ''}"
                for mutation in failures
            ],
            [baseline, result],
            prompts,
        ), mutations
    return GateResult(
        "mutation",
        "Mutation testing",
        True,
        f"Native semantic mutation assertion-killed all {len(mutations)} mutants with {workers} workers{cache_summary}{performance_summary}.",
        [],
        [baseline, result],
    ), mutations


def run_stryker_mutation_gate(
    root: Path,
    mutation_config: dict[str, Any],
    source_files: Sequence[Path],
    baseline: CommandResult,
    tools: ToolContext,
    requested_workers: Any,
    timeout: int,
) -> tuple[GateResult, list[Mutation]]:
    workers = resolve_stryker_workers(requested_workers)
    incremental_path = stryker_incremental_path(root, tools, mutation_config)
    incremental_path.parent.mkdir(parents=True, exist_ok=True)
    proof_report_path = incremental_path.with_name(
        f"{incremental_path.stem}-proof-report.json"
    )
    proof_metadata_path = incremental_path.with_name(
        f"{incremental_path.stem}-proof.json"
    )
    proof_fingerprint = mutation_proof_fingerprint(root, source_files, mutation_config)
    cached = load_stryker_proof_cache(
        proof_report_path, proof_metadata_path, proof_fingerprint
    )
    if cached is not None:
        cached_result = CommandResult(
            [*(tools.stryker_command or ["stryker"]), "proof-cache"],
            0,
            "Exact source, test, configuration, and dependency fingerprint matched the completed native mutation proof.",
            0.0,
        )
        return finish_stryker_mutation_gate(
            cached,
            baseline,
            cached_result,
            workers,
            f"; reused exact proof for all {len(cached)} mutants",
        )
    with tempfile.TemporaryDirectory(
        prefix="quality-gate-stryker-worker-"
    ) as temporary:
        worker_parent = Path(temporary)
        worker_root = worker_parent / "repository"
        report_path = worker_parent / "mutation.json"
        config_path = worker_parent / "stryker.config.json"
        copy_repository_snapshot(root, worker_root)
        config_value = stryker_config(
            root,
            source_files,
            report_path,
            incremental_path,
            workers,
            bool(mutation_config.get("incremental", True)),
            mutation_config,
        )
        config_path.write_text(
            json.dumps(config_value, indent=2) + "\n", encoding="utf-8"
        )
        command = command_for_snapshot(tools.stryker_command or [], root, worker_root)
        result = run_command(
            [*command, "run", str(config_path)],
            worker_root,
            timeout,
            {"QUALITY_GATE_MUTATION_WORKER": "1"},
        )
        if not report_path.exists():
            return GateResult(
                "mutation",
                "Mutation testing",
                False,
                "The native Vitest mutation adapter failed before producing a report.",
                [result.stdout],
                [baseline, result],
                [
                    (
                        "Repair native mutation adapter",
                        generic_adapter_prompt("mutation", result),
                    )
                ],
            ), []
        try:
            mutations = parse_stryker_report(report_path)
        except ValueError as error:
            return GateResult(
                "mutation",
                "Mutation testing",
                False,
                str(error),
                [result.stdout],
                [baseline, result],
                [
                    (
                        "Repair native mutation report",
                        generic_adapter_prompt("mutation", result),
                    )
                ],
            ), []
        if not result.timed_out:
            store_stryker_proof_cache(
                report_path,
                proof_report_path,
                proof_metadata_path,
                proof_fingerprint,
            )
    reused_match = re.search(
        r"(\d+) of (\d+) mutant result\(s\) (?:are|is) reused", result.stdout
    )
    if reused_match:
        reused_count = min(int(reused_match.group(1)), len(mutations))
        cache_summary = (
            f"; reused {reused_count}/{len(mutations)} in-scope cached results"
        )
    else:
        cache_summary = "; initialized or refreshed the incremental cache"
    return finish_stryker_mutation_gate(
        mutations, baseline, result, workers, cache_summary
    )


def resolve_mutation_workers(value: Any, candidate_count: int) -> int:
    if candidate_count < 1:
        return 1
    if isinstance(value, bool):
        raise ValueError("mutation workers must be `auto` or a positive integer")
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized == "auto":
            available = os.cpu_count() or 1
            work_to_amortize_snapshots = max(1, candidate_count // 8)
            return min(
                candidate_count,
                work_to_amortize_snapshots,
                max(1, min(4, available // 2)),
            )
        try:
            requested = int(normalized)
        except ValueError as error:
            raise ValueError(
                "mutation workers must be `auto` or a positive integer"
            ) from error
    elif isinstance(value, int):
        requested = value
    else:
        raise ValueError("mutation workers must be `auto` or a positive integer")
    if requested < 1:
        raise ValueError("mutation workers must be `auto` or a positive integer")
    return min(candidate_count, requested)


def copy_repository_snapshot(root: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    copy_command: list[str] | None = None
    cp = shutil.which("cp")
    if cp and sys.platform == "darwin":
        copy_command = [cp, "-cRp", f"{root}{os.sep}.", str(destination)]
    elif cp and sys.platform.startswith("linux"):
        copy_command = [
            cp,
            "--archive",
            "--reflink=auto",
            f"{root}{os.sep}.",
            str(destination),
        ]
    if copy_command:
        destination.mkdir()
        copied = subprocess.run(
            copy_command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if copied.returncode == 0:
            return
        shutil.rmtree(destination)
    shutil.copytree(root, destination, symlinks=True)


def command_for_snapshot(
    command: Sequence[str], root: Path, snapshot: Path
) -> list[str]:
    rewritten: list[str] = []
    for argument in command:
        path = Path(argument)
        if path.is_absolute():
            with contextlib.suppress(ValueError):
                argument = str(snapshot / path.relative_to(root))
        rewritten.append(argument)
    return rewritten


def mutation_id(candidate: MutationCandidate) -> str:
    return hashlib.sha256(
        f"{candidate.path}:{candidate.offset}:{candidate.original}:{candidate.replacement}".encode()
    ).hexdigest()[:12]


def execute_mutation_candidate(
    candidate: MutationCandidate,
    execution_root: Path,
    test_command: Sequence[str],
    timeout: int,
    runtime_root: Path,
    worker_number: int,
) -> Mutation:
    mutant_id = mutation_id(candidate)
    path = execution_root / candidate.path
    try:
        original_bytes = path.read_bytes()
        text = original_bytes.decode("utf-8")
    except (OSError, UnicodeDecodeError) as error:
        return Mutation(
            mutant_id,
            candidate.path,
            candidate.line,
            candidate.column,
            candidate.original,
            candidate.replacement,
            True,
            False,
            0.0,
            str(error),
        )
    if (
        text[candidate.offset : candidate.offset + len(candidate.original)]
        != candidate.original
    ):
        return Mutation(
            mutant_id,
            candidate.path,
            candidate.line,
            candidate.column,
            candidate.original,
            candidate.replacement,
            True,
            False,
            0.0,
            "Source changed during mutation run",
        )
    mutated = (
        text[: candidate.offset]
        + candidate.replacement
        + text[candidate.offset + len(candidate.original) :]
    )
    original_stat = path.stat()
    result: CommandResult | None = None
    mutation_error = ""
    try:
        path.write_text(mutated, encoding="utf-8")
        os.chmod(path, original_stat.st_mode)
        with tempfile.TemporaryDirectory(
            prefix=f"mutant-{mutant_id}-", dir=runtime_root
        ) as mutation_temp:
            result = run_command(
                test_command,
                execution_root,
                timeout,
                {
                    "PYTHONPYCACHEPREFIX": mutation_temp,
                    "TMPDIR": mutation_temp,
                    "TMP": mutation_temp,
                    "TEMP": mutation_temp,
                    "QUALITY_GATE_MUTATION_WORKER": str(worker_number),
                    "QUALITY_GATE_MUTANT_ID": mutant_id,
                },
            )
    except OSError as error:
        mutation_error = str(error)
    finally:
        path.write_bytes(original_bytes)
        os.chmod(path, original_stat.st_mode)
        os.utime(path, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    if result is None:
        return Mutation(
            mutant_id,
            candidate.path,
            candidate.line,
            candidate.column,
            candidate.original,
            candidate.replacement,
            True,
            False,
            0.0,
            mutation_error,
        )
    return Mutation(
        mutant_id,
        candidate.path,
        candidate.line,
        candidate.column,
        candidate.original,
        candidate.replacement,
        result.returncode == 0,
        result.timed_out,
        result.duration_seconds,
        result.stdout,
    )


def run_mutations_serially(
    root: Path,
    candidates: Sequence[MutationCandidate],
    test_command: Sequence[str],
    timeout: int,
) -> list[Mutation]:
    results: list[Mutation] = []
    with tempfile.TemporaryDirectory(
        prefix="quality-gate-mutation-worker-"
    ) as temporary:
        worker_parent = Path(temporary)
        worker_root = worker_parent / "repository"
        runtime_root = worker_parent / "runtime"
        copy_repository_snapshot(root, worker_root)
        runtime_root.mkdir()
        worker_command = command_for_snapshot(test_command, root, worker_root)
        for index, candidate in enumerate(candidates, start=1):
            if sys.stderr.isatty():
                print(
                    f"[mutation {index}/{len(candidates)}] {candidate.path}:{candidate.line}:{candidate.column} {candidate.original}->{candidate.replacement}",
                    file=sys.stderr,
                    flush=True,
                )
            results.append(
                execute_mutation_candidate(
                    candidate,
                    worker_root,
                    worker_command,
                    timeout,
                    runtime_root,
                    1,
                )
            )
    return results


def run_mutations_in_parallel(
    root: Path,
    candidates: Sequence[MutationCandidate],
    test_command: Sequence[str],
    timeout: int,
    worker_count: int,
) -> list[Mutation]:
    indexed = list(enumerate(candidates, start=1))
    assignments = [indexed[index::worker_count] for index in range(worker_count)]
    stop_requested = threading.Event()

    def run_worker(
        worker_number: int,
        assigned: Sequence[tuple[int, MutationCandidate]],
        pool_root: Path,
    ) -> list[tuple[int, Mutation]]:
        worker_parent = pool_root / f"worker-{worker_number}"
        worker_root = worker_parent / "repository"
        runtime_root = worker_parent / "runtime"
        copy_repository_snapshot(root, worker_root)
        runtime_root.mkdir()
        worker_command = command_for_snapshot(test_command, root, worker_root)
        completed: list[tuple[int, Mutation]] = []
        for index, candidate in assigned:
            if stop_requested.is_set():
                break
            if sys.stderr.isatty():
                print(
                    f"[mutation {index}/{len(candidates)} worker {worker_number}] {candidate.path}:{candidate.line}:{candidate.column} {candidate.original}->{candidate.replacement}",
                    file=sys.stderr,
                    flush=True,
                )
            completed.append(
                (
                    index,
                    execute_mutation_candidate(
                        candidate,
                        worker_root,
                        worker_command,
                        timeout,
                        runtime_root,
                        worker_number,
                    ),
                )
            )
        return completed

    by_index: dict[int, Mutation] = {}
    with tempfile.TemporaryDirectory(
        prefix="quality-gate-mutation-workers-"
    ) as temporary:
        pool_root = Path(temporary)
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = [
                executor.submit(run_worker, index + 1, assigned, pool_root)
                for index, assigned in enumerate(assignments)
            ]
            try:
                for future in futures:
                    by_index.update(future.result())
            except BaseException:
                stop_requested.set()
                for future in futures:
                    future.cancel()
                raise
    return [by_index[index] for index in range(1, len(candidates) + 1)]


def run_mutation_gate(
    root: Path,
    config: dict[str, Any],
    source_files: Sequence[Path],
    cli_max_mutants: int | None,
    test_baseline: CommandResult | None = None,
    cli_mutation_workers: str | int | None = None,
    tools: ToolContext | None = None,
    scope: GateScope | None = None,
) -> tuple[GateResult, list[Mutation]]:
    scope = scope or repository_scope()
    mutation_config = config["mutation"]
    if not mutation_config.get("enabled", True):
        return GateResult(
            "mutation",
            "Mutation testing",
            False,
            "Mutation testing is disabled; a required gate cannot be skipped.",
            prompts=[
                (
                    "Enable mutation testing",
                    "Enable the mutation gate and run every generated mutant. The required threshold is zero surviving mutants.",
                )
            ],
        ), []
    test_command = (
        command_list(mutation_config.get("test_command"))
        or command_list(config["test"].get("command"))
        or infer_test_command(root)
    )
    if not test_command:
        return GateResult(
            "mutation",
            "Mutation testing",
            False,
            "No full-suite test command could be configured or inferred.",
            prompts=[
                (
                    "Configure tests",
                    "Configure `test.command` or `mutation.test_command` as an argument array that runs the repository's complete test suite and exits non-zero on any failure.",
                )
            ],
        ), []
    timeout = int(
        mutation_config.get(
            "timeout_seconds", config["test"].get("timeout_seconds", 600)
        )
    )
    baseline = (
        test_baseline
        if test_baseline and test_baseline.command == test_command
        else run_command(test_command, root, timeout)
    )
    if baseline.returncode != 0:
        return GateResult(
            "mutation",
            "Mutation testing",
            False,
            "The unmodified baseline test suite failed, so mutation results would be invalid.",
            [baseline.stdout],
            [baseline],
            [("Repair baseline tests", generic_adapter_prompt("test", baseline))],
        ), []
    engine = str(mutation_config.get("engine", "auto")).strip().lower()
    if engine not in {"auto", "builtin", "stryker"}:
        raise ValueError("mutation.engine must be `auto`, `builtin`, or `stryker`")
    configured_max = int(mutation_config.get("max_mutants", 0))
    max_mutants = cli_max_mutants if cli_max_mutants is not None else configured_max
    configured_workers = mutation_config.get("workers", "auto")
    requested_workers = (
        cli_mutation_workers if cli_mutation_workers is not None else configured_workers
    )
    native_supported = supports_native_vitest_mutation(root, source_files, tools)
    if engine == "stryker" and not native_supported:
        return GateResult(
            "mutation",
            "Mutation testing",
            False,
            "The Stryker engine was requested but a compatible local Vitest runner is unavailable.",
            prompts=[
                (
                    "Install native mutation tools",
                    f"Install @stryker-mutator/core@{STRYKER_VERSION} and @stryker-mutator/vitest-runner@{STRYKER_VERSION}, or enable automatic tool installation. Keep the complete Vitest suite green before rerunning.",
                )
            ],
        ), []
    if native_supported and not max_mutants and engine in {"auto", "stryker"}:
        assert tools is not None
        return run_stryker_mutation_gate(
            root,
            mutation_config,
            source_files,
            baseline,
            tools,
            requested_workers,
            timeout,
        )
    operators = {
        str(key): str(value)
        for key, value in mutation_config.get("operators", OPERATOR_MUTATIONS).items()
    }
    excludes = [str(pattern) for pattern in mutation_config.get("exclude", [])]
    candidates: list[MutationCandidate] = []
    for path in source_files:
        relative = normalize_path(path, root)
        if matches_any(relative, excludes):
            continue
        for offset, line, column, original, replacement in operator_offsets(
            path, operators
        ):
            candidates.append(
                MutationCandidate(relative, offset, line, column, original, replacement)
            )
    total_candidates = len(candidates)
    if max_mutants and len(candidates) > max_mutants:
        candidates = candidates[:max_mutants]
    if not candidates:
        if scope.incremental:
            return GateResult(
                "mutation",
                "Mutation testing",
                True,
                f"Not applicable: no supported mutation candidates were found in the selected {scope.description} production files.",
                applicable=False,
            ), []
        return GateResult(
            "mutation",
            "Mutation testing",
            False,
            "No mutation candidates were generated; zero survivors cannot be claimed.",
            prompts=[
                (
                    "Repair mutation discovery",
                    "Inspect production source selection and mutation operators. Ensure all production files are included and configure language-specific operators if the repository uses syntax outside the built-in operator set.",
                )
            ],
        ), []
    worker_count = resolve_mutation_workers(requested_workers, len(candidates))
    if worker_count == 1:
        results = run_mutations_serially(root, candidates, test_command, timeout)
    else:
        results = run_mutations_in_parallel(
            root, candidates, test_command, timeout, worker_count
        )
    worker_summary = f"using {worker_count} worker{'s' if worker_count != 1 else ''}"
    survivors = [mutation for mutation in results if mutation.survived]
    prompts = [
        (f"Kill mutant {mutation.mutant_id}", mutation_prompt(mutation))
        for mutation in survivors
    ]
    if max_mutants and max_mutants < total_candidates:
        return GateResult(
            "mutation",
            "Mutation testing",
            False,
            f"Diagnostic limit tested {len(results)} mutants {worker_summary}; a limited run cannot pass the full gate. {len(survivors)} survived.",
            [
                f"{mutation.path}:{mutation.line}:{mutation.column} {mutation.original}->{mutation.replacement}"
                for mutation in survivors
            ],
            [baseline],
            prompts,
        ), results
    if survivors:
        return GateResult(
            "mutation",
            "Mutation testing",
            False,
            f"{len(survivors)} of {len(results)} mutants survived {worker_summary}; required: zero.",
            [
                f"{mutation.path}:{mutation.line}:{mutation.column} {mutation.original}->{mutation.replacement}"
                for mutation in survivors
            ],
            [baseline],
            prompts,
        ), results
    return GateResult(
        "mutation",
        "Mutation testing",
        True,
        f"All {len(results)} mutants were killed by the full test suite {worker_summary}.",
        [],
        [baseline],
    ), results


IMPORT_PATTERNS = [
    re.compile(r"^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))", re.MULTILINE),
    re.compile(r"(?:import|export)\s+(?:[^;]*?\s+from\s+)?['\"]([^'\"]+)['\"]"),
    re.compile(r"require\s*\(\s*['\"]([^'\"]+)['\"]\s*\)"),
    re.compile(r"^\s*use\s+(?:crate::)?([\w:]+)", re.MULTILINE),
    re.compile(r"^\s*(?:import|using)\s+([\w.]+)", re.MULTILINE),
    re.compile(r"^\s*#include\s*[<\"]([^>\"]+)[>\"]", re.MULTILINE),
    re.compile(r"^\s*require_relative\s+['\"]([^'\"]+)['\"]", re.MULTILINE),
    re.compile(r"^\s*require\s+['\"]([^'\"]+)['\"]", re.MULTILINE),
]


def module_for_path(relative: str, modules: Sequence[dict[str, Any]]) -> str | None:
    matches = modules_for_path(relative, modules)
    return matches[0] if len(matches) == 1 else None


def modules_for_path(relative: str, modules: Sequence[dict[str, Any]]) -> list[str]:
    return [
        str(module["name"])
        for module in modules
        if matches_any(relative, [str(pattern) for pattern in module.get("paths", [])])
    ]


def import_specs(path: Path) -> list[tuple[str, int]]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    result: list[tuple[str, int]] = []
    masked = mask_comments(text)
    for pattern in IMPORT_PATTERNS:
        for match in pattern.finditer(masked):
            specifier = next((group for group in match.groups() if group), "")
            if specifier:
                result.append((specifier, text.count("\n", 0, match.start()) + 1))
    return result


def resolve_import(
    source: Path, specifier: str, root: Path, source_files: Sequence[Path]
) -> str | None:
    relative_files = {normalize_path(path, root): path for path in source_files}
    clean = (
        specifier.replace("::", "/").replace(".", "/")
        if not specifier.startswith(".")
        else specifier
    )
    candidate_strings: list[str] = []
    if specifier.startswith("."):
        if specifier.startswith(("./", "../")):
            base = (source.parent / specifier).resolve()
        else:
            leading_dots = len(specifier) - len(specifier.lstrip("."))
            base = source.parent
            for _ in range(max(0, leading_dots - 1)):
                base = base.parent
            remainder = specifier[leading_dots:].replace(".", "/")
            base = (base / remainder).resolve()
        for extension in SOURCE_EXTENSIONS:
            candidate_strings.extend(
                [
                    normalize_path(Path(str(base) + extension), root),
                    normalize_path(base / ("index" + extension), root),
                ]
            )
    else:
        clean = clean.removeprefix("crate/").lstrip("/")
        for extension in SOURCE_EXTENSIONS:
            candidate_strings.extend(
                [
                    clean + extension,
                    clean + "/index" + extension,
                    clean + "/__init__" + extension,
                ]
            )
        candidate_strings.append(clean)
    for candidate in candidate_strings:
        if candidate in relative_files:
            return candidate
    suffixes = [
        candidate
        for candidate in relative_files
        if candidate.endswith("/" + clean)
        or candidate.endswith("/" + clean + Path(candidate).suffix)
    ]
    return min(suffixes, key=len) if len(suffixes) == 1 else None


def load_dependency_edges(path: Path, root: Path) -> list[tuple[str, str, int]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    edges = value.get("edges", []) if isinstance(value, dict) else []
    result = []
    for edge in edges:
        result.append(
            (
                normalize_report_path(str(edge["from"]), root),
                normalize_report_path(str(edge["to"]), root),
                int(edge.get("line", 0)),
            )
        )
    return result


def dependency_prompt(violation: DependencyViolation) -> str:
    return f"""Repair this module-dependency violation:

- source: {violation.source}:{violation.line} (module `{violation.source_module}`)
- target: {violation.target} (module `{violation.target_module}`)
- violated rule: {violation.rule}

Read the dependency specification and neighboring architecture before editing. Restore the permitted direction with the smallest coherent change: invert the dependency behind an owned interface, move the responsibility to the correct module, or split the mixed module. Preserve behavior and add or update tests around the boundary. Do not broaden the allow-list merely to make the checker green. Re-run dependency analysis and the complete test suite."""


def run_dependency_gate(
    root: Path,
    config: dict[str, Any],
    source_files: Sequence[Path],
    workspace: Path | None = None,
    resolution_files: Sequence[Path] | None = None,
) -> tuple[GateResult, list[DependencyViolation]]:
    dependency = config["dependencies"]
    rules_path = resolve_config_path(
        str(dependency.get("rules", DEPENDENCIES_NAME)), root
    )
    command_results: list[CommandResult] = []
    adapter_report = (workspace or root) / "dependency-edges.json"
    substitutions = {"root": str(root), "report": str(adapter_report)}
    command = command_list(
        dependency.get("command"),
        substitutions,
    )
    if command:
        result = run_command(command, root, int(dependency.get("timeout_seconds", 300)))
        command_results.append(result)
        if result.returncode != 0:
            return GateResult(
                "dependencies",
                "Module dependencies",
                False,
                "The dependency adapter failed.",
                [result.stdout],
                command_results,
                [
                    (
                        "Repair dependency adapter",
                        generic_adapter_prompt("dependency", result),
                    )
                ],
            ), []
    if not rules_path.exists():
        return GateResult(
            "dependencies",
            "Module dependencies",
            False,
            f"Dependency specification not found: {rules_path}",
            prompts=[("Define architecture rules", dependency_spec_prompt())],
        ), []
    try:
        rules = json.loads(rules_path.read_text(encoding="utf-8"))
        if not isinstance(rules, dict):
            raise ValueError("the root must be a JSON object")
        modules = rules.get("modules", [])
        allowed = rules.get("allow", {})
        denied = rules.get("deny", [])
        if not isinstance(modules, list) or not modules:
            raise ValueError("'modules' must be a non-empty array")
        if not isinstance(allowed, dict):
            raise ValueError("'allow' must be an object keyed by module name")
        names: list[str] = []
        for module in modules:
            if (
                not isinstance(module, dict)
                or not isinstance(module.get("name"), str)
                or not isinstance(module.get("paths"), list)
                or not module["paths"]
            ):
                raise ValueError(
                    "every module needs a string name and non-empty paths array"
                )
            names.append(module["name"])
        if len(names) != len(set(names)):
            raise ValueError("module names must be unique")
        missing_allow = sorted(set(names) - set(allowed))
        if missing_allow:
            raise ValueError(
                f"allow rules missing for modules: {', '.join(missing_allow)}"
            )
        unknown_allowed = sorted(
            {
                str(target)
                for targets in allowed.values()
                if isinstance(targets, list)
                for target in targets
                if str(target) not in names
            }
        )
        if unknown_allowed:
            raise ValueError(
                f"allow rules name unknown modules: {', '.join(unknown_allowed)}"
            )
    except (OSError, json.JSONDecodeError, ValueError, TypeError) as error:
        return GateResult(
            "dependencies",
            "Module dependencies",
            False,
            f"Dependency specification is invalid: {error}",
            prompts=[("Fix architecture rules", dependency_spec_prompt(str(error)))],
        ), []
    edges_path_value = dependency.get("edges_report")
    selected_paths = {normalize_path(path, root) for path in source_files}
    resolvable_files = resolution_files or source_files
    try:
        if edges_path_value:
            edges = load_dependency_edges(
                resolve_config_path(
                    substitute_text(str(edges_path_value), substitutions), root
                ),
                root,
            )
            edges = [edge for edge in edges if edge[0] in selected_paths]
        else:
            edges = []
            for source in source_files:
                for specifier, line in import_specs(source):
                    target = resolve_import(source, specifier, root, resolvable_files)
                    if target:
                        edges.append((normalize_path(source, root), target, line))
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        return GateResult(
            "dependencies",
            "Module dependencies",
            False,
            f"Dependency edges report is invalid: {error}",
            prompts=[("Fix dependency edges", dependency_spec_prompt(str(error)))],
        ), []
    violations: list[DependencyViolation] = []
    for source in source_files:
        relative = normalize_path(source, root)
        owners = modules_for_path(relative, modules)
        if not owners:
            violations.append(
                DependencyViolation(
                    relative,
                    "(unassigned)",
                    "(module specification)",
                    "(none)",
                    "every production file must belong to exactly one module",
                )
            )
        elif len(owners) > 1:
            violations.append(
                DependencyViolation(
                    relative,
                    ", ".join(owners),
                    "(module specification)",
                    "(ambiguous)",
                    "module path patterns overlap",
                )
            )
    deny_pairs = {
        (str(item.get("from")), str(item.get("to")))
        for item in denied
        if isinstance(item, dict)
    }
    for edge_source, edge_target, line in edges:
        source_module = module_for_path(edge_source, modules)
        target_module = module_for_path(edge_target, modules)
        if not source_module or not target_module or source_module == target_module:
            continue
        allowed_targets = allowed.get(source_module)
        violation_rule = ""
        if (source_module, target_module) in deny_pairs:
            violation_rule = f"deny {source_module} -> {target_module}"
        elif isinstance(allowed_targets, list) and target_module not in [
            str(value) for value in allowed_targets
        ]:
            violation_rule = f"allow[{source_module}] excludes {target_module}"
        if violation_rule:
            violations.append(
                DependencyViolation(
                    edge_source,
                    source_module,
                    edge_target,
                    target_module,
                    violation_rule,
                    line,
                )
            )
    prompts = [
        (f"Fix {item.source_module} -> {item.target_module}", dependency_prompt(item))
        for item in violations
    ]
    if violations:
        return GateResult(
            "dependencies",
            "Module dependencies",
            False,
            f"{len(violations)} dependency-rule violations found; required: zero.",
            [
                f"{item.source}:{item.line} {item.source_module} -> {item.target_module}"
                for item in violations
            ],
            command_results,
            prompts,
        ), violations
    return GateResult(
        "dependencies",
        "Module dependencies",
        True,
        f"Zero dependency-rule violations across {len(edges)} resolved edges and {len(modules)} declared modules.",
        command_results=command_results,
    ), []


def dependency_spec_prompt(reason: str = "no specification exists") -> str:
    return f"""Define the repository's enforceable module dependency contract ({reason}). Create `{DEPENDENCIES_NAME}`:

{{
  "modules": [
    {{"name": "domain", "paths": ["src/domain/**"]}},
    {{"name": "application", "paths": ["src/application/**"]}},
    {{"name": "infrastructure", "paths": ["src/infrastructure/**"]}}
  ],
  "allow": {{
    "domain": [],
    "application": ["domain"],
    "infrastructure": ["application", "domain"]
  }},
  "deny": [{{"from": "domain", "to": "infrastructure"}}]
}}

Replace the example with actual repository boundaries. Every production file must match exactly one intended module. Declare dependency direction from architecture, not from the current accidental imports. For an unsupported import syntax, configure `dependencies.command` and `dependencies.edges_report` to emit `{{"edges":[{{"from":"path","to":"path","line":1}}]}}`."""


def format_command(result: CommandResult) -> str:
    status = "timeout" if result.timed_out else f"exit {result.returncode}"
    return f"$ {shlex.join(result.command)}\n[{status}; {result.duration_seconds:.2f}s]\n{result.stdout}".strip()


def without_fast_flag(command: str) -> str:
    try:
        parts = shlex.split(command)
    except ValueError:
        return command.replace(" --fast", "")
    return shlex.join([part for part in parts if part != "--fast"])


def master_fix_prompt(report: AnalysisReport) -> str:
    failing_functions = sorted(
        (function for function in report.functions if not function.passed),
        key=lambda function: (
            -function.craap_score,
            function.coverage_percent,
            function.path,
            function.start_line,
        ),
    )
    survivors = [mutation for mutation in report.mutations if mutation.survived]
    oversized_files = [file for file in report.files if not file.passed]
    failed_installs = [result for result in report.tool_setup if result.returncode != 0]
    gate_summary = "\n".join(
        f"- {gate.title}: {gate_outcome(gate)} — {gate.summary}"
        for gate in report.gates
    )
    failure_evidence = (
        "\n\n".join(
            f"{gate.title}:\n"
            + "\n".join(f"- {detail}" for detail in gate.details[:20])
            for gate in report.gates
            if gate.applicable
            and not gate.deferred
            and not gate.passed
            and gate.details
        )
        or "No additional command output was recorded. Read each gate summary above."
    )
    function_summary = (
        "\n".join(
            f"- {function.path}:{function.start_line} `{function.name}` — coverage {function.coverage_percent:.2f}%, complexity {function.complexity}, CRAAP {function.craap_score:.2f}"
            for function in failing_functions[:50]
        )
        or "- None in the current report."
    )
    file_summary = (
        "\n".join(
            f"- {file.path} — {file.lines} physical lines (maximum {file.limit})"
            for file in oversized_files[:50]
        )
        or "- None in the current report."
    )
    mutation_summary = (
        "\n".join(
            f"- {mutation.path}:{mutation.line}:{mutation.column} — `{mutation.original}` -> `{mutation.replacement}` (mutant {mutation.mutant_id})"
            for mutation in survivors[:50]
        )
        or "- None in the current report."
    )
    dependency_summary = (
        "\n".join(
            f"- {item.source}:{item.line} ({item.source_module}) -> {item.target} ({item.target_module}): {item.rule}"
            for item in report.dependency_violations[:50]
        )
        or "- None in the current report."
    )
    install_summary = (
        "\n\n".join(format_command(result) for result in failed_installs)
        or "No automatic tool installation failed."
    )
    rerun_command = report.rerun_command or (
        f"python3 {shlex.quote(str(Path(__file__).resolve()))} --root ."
    )
    full_command = without_fast_flag(rerun_command)
    thresholds = report.thresholds or default_thresholds()
    coverage_limit = threshold_number(thresholds, "metrics", "coverage_limit")
    complexity_limit = threshold_number(thresholds, "metrics", "complexity_limit")
    craap_limit = threshold_number(thresholds, "metrics", "craap_limit")
    file_loc_limit = threshold_number(thresholds, "file_loc", "max_lines")
    if report.mode == "fast" and report.ready_for_full:
        objective = """The fast diagnostic checks are green. Do not claim the repository is ready to ship yet. Run the full certification command now; it executes the deferred flaky-test repetitions and exhaustive mutation gate."""
        run_instructions = f"""Run from the repository root:
{full_command}"""
        loop_rule = "Run the full certification command now. If it finds failures, repair them and rerun the full gate until it exits 0."
    elif report.mode == "fast":
        objective = """Fix every issue measured by this fast diagnostic run. Work autonomously and rerun fast mode after each coherent batch. Fast mode can never certify the repository: once its executed checks are green, run the full certification command and continue until that full gate exits 0."""
        run_instructions = f"""Fast diagnostic command:
{rerun_command}

Required full certification command:
{full_command}"""
        loop_rule = "Rerun fast mode after each coherent repair batch. Once it reports READY_FOR_FULL, run the full certification command and continue until the full gate exits 0."
    else:
        objective = """Fix every issue reported by the repository quality gate. Work autonomously and keep looping until the gate exits with code 0. Do not stop after fixing only the examples listed here; each rerun may reveal the next failures."""
        run_instructions = f"""Run from the repository root:
{rerun_command}"""
        loop_rule = "After each coherent batch, run the focused tests, then rerun the full gate. Continue until the full gate exits 0 and report final evidence for every applicable check."
    return f"""You are the lead quality-repair agent for this repository:
{report.root}

Active gate scope: {report.scope.description}. Incremental scope results apply only to the selected changed production files; repository-wide commands still retain their configured scope.

{objective}

{run_instructions}

Non-negotiable finish conditions:
1. Every applicable formatter and linter command passes with zero violations.
2. Every applicable static type checker passes with zero errors.
3. Every detected or configured contract/schema check passes.
4. The complete test suite passes; every production function has {coverage_limit:g}% executable-line coverage, complexity <= {complexity_limit:g}, and CRAAP <= {craap_limit:g}.
5. Every production file has at most {file_loc_limit:g} physical lines.
6. Every applicable dead-code detector reports zero findings.
7. The complete test suite passes consistently across every configured flaky-test run.
8. The complete test suite kills every generated operator mutant; zero survive.
9. The dependency checker reports zero ownership or direction-rule violations.

Current gate status:
{gate_summary}

Highest-priority CRAAP failures ({len(failing_functions)} total; first 50 shown):
{function_summary}

Oversized production files ({len(oversized_files)} total; first 50 shown):
{file_summary}

Surviving mutants ({len(survivors)} total; first 50 shown):
{mutation_summary}

Dependency violations ({len(report.dependency_violations)} total; first 50 shown):
{dependency_summary}

Other failing-gate evidence:
{failure_evidence}

Automatic installation failures:
{install_summary}

Repair rules:
- Read neighboring production code and tests before editing.
- For uncovered behavior or a surviving mutant, add a behavior-focused test through the production API and prove it fails against the unfixed or mutated code.
- Simplify control flow without changing behavior until each function meets the CRAAP limit. Preserve public contracts and error paths.
- Split oversized files along cohesive responsibilities without changing public behavior or hiding code through formatting tricks.
- Fix formatter, lint, type, contract, and dead-code findings in production code; do not hide them with ignore comments, generated baselines, exclusions, or weakened configuration.
- Eliminate test nondeterminism at its source. Do not use retries or quarantine to conceal flaky behavior.
- Fix architecture violations by moving responsibility, splitting a mixed module, or inverting the dependency behind an owned interface. Do not broaden rules merely to make the checker green.
- Do not disable a gate, lower thresholds, cap mutants, add coverage exclusions, skip tests, weaken assertions, add suppressions, or replace commands with no-ops.
- {loop_rule}"""


def gate_outcome(gate: GateResult) -> str:
    if gate.deferred:
        return "DEFERRED"
    if not gate.applicable:
        return "NOT APPLICABLE"
    return "PASS" if gate.passed else "FAIL"


def function_measurement(function: Any) -> dict[str, Any]:
    return {
        "path": function.path,
        "name": function.name,
        "line": function.start_line,
        "covered_lines": function.covered_lines,
        "total_lines": function.total_lines,
        "coverage_percent": round(function.coverage_percent, 2),
        "complexity": function.complexity,
        "craap_score": round(function.craap_score, 2),
        "passed": function.passed,
    }


def file_measurement(file: Any) -> dict[str, Any]:
    return {
        "path": file.path,
        "lines": file.lines,
        "limit": file.limit,
        "passed": file.passed,
    }


def mutation_failure(mutation: Any) -> dict[str, Any]:
    return {
        "id": mutation.mutant_id,
        "path": mutation.path,
        "line": mutation.line,
        "column": mutation.column,
        "change": f"{mutation.original} -> {mutation.replacement}",
        "status": mutation.status or ("Survived" if mutation.survived else "Killed"),
        "static": bool(getattr(mutation, "static", False)),
    }


def dependency_failure(violation: Any) -> dict[str, Any]:
    return {
        "source": violation.source,
        "line": violation.line,
        "source_module": violation.source_module,
        "target": violation.target,
        "target_module": violation.target_module,
        "rule": violation.rule,
    }


def state_status(analysis: Any, error: str | None) -> str:
    if error:
        return "error"
    if analysis.passed:
        return "pass"
    return "ready_for_full" if analysis.ready_for_full else "fail"


def command_state(command: Any) -> dict[str, Any]:
    return {
        "command": command.command,
        "returncode": command.returncode,
        "timed_out": command.timed_out,
        "duration_seconds": round(command.duration_seconds, 3),
    }


def gate_status(result: Any) -> str:
    if result.deferred:
        return "deferred"
    if not result.applicable:
        return "not_applicable"
    return "pass" if result.passed else "fail"


def gate_state(result: Any) -> dict[str, Any]:
    return {
        "key": result.key,
        "status": gate_status(result),
        "summary": result.summary,
        "details": result.details[:100],
        "commands": [command_state(item) for item in result.command_results],
    }


def quality_gate_for(analysis: Any) -> Any:
    return next((result for result in analysis.gates if result.key == "quality"), None)


def metrics_state(analysis: Any, quality_gate: Any) -> dict[str, Any]:
    return {
        "certified": bool(analysis.functions and quality_gate and quality_gate.passed),
        "functions": [function_measurement(item) for item in analysis.functions],
        "files": [file_measurement(item) for item in analysis.files],
    }


def count_state(
    analysis: Any,
    failing_functions: Sequence[Any],
    survivors: Sequence[Any],
    violations: Sequence[Any],
) -> dict[str, int]:
    outcomes = [gate_status(item) for item in analysis.gates]
    return {
        "checks_total": len(outcomes),
        "checks_executed": len(outcomes) - outcomes.count("deferred"),
        "checks_deferred": outcomes.count("deferred"),
        "checks_applicable": outcomes.count("pass") + outcomes.count("fail"),
        "checks_passing": outcomes.count("pass"),
        "functions_total": len(analysis.functions),
        "functions_failing": len(failing_functions),
        "files_total": len(analysis.files),
        "files_failing_loc": sum(not item.passed for item in analysis.files),
        "mutants_total": len(analysis.mutations),
        "mutants_surviving": len(survivors),
        "mutants_static": sum(
            bool(getattr(item, "static", False)) for item in analysis.mutations
        ),
        "dependency_violations": len(violations),
    }


def failed_check_state(gates: Sequence[Any]) -> list[dict[str, Any]]:
    return [
        {
            "key": item.key,
            "title": item.title,
            "summary": item.summary,
            "details": item.details[:100],
        }
        for item in gates
        if item.applicable and not item.deferred and not item.passed
    ]


def failed_file_state(files: Sequence[Any]) -> list[dict[str, Any]]:
    return [file_measurement(item) for item in files if not item.passed][:200]


def failed_tool_state(failed_setup: Sequence[Any]) -> list[dict[str, Any]]:
    return [
        {
            "command": item.command,
            "returncode": item.returncode,
            "output": item.stdout[-4000:],
        }
        for item in failed_setup
    ]


def failure_state(
    analysis: Any,
    failing_functions: Sequence[Any],
    survivors: Sequence[Any],
    violations: Sequence[Any],
    failed_setup: Sequence[Any],
) -> dict[str, Any]:
    return {
        "checks": failed_check_state(analysis.gates),
        "functions": [function_measurement(item) for item in failing_functions[:200]],
        "files": failed_file_state(analysis.files),
        "surviving_mutants": [mutation_failure(item) for item in survivors[:200]],
        "dependencies": [dependency_failure(item) for item in violations[:200]],
        "tool_setup": failed_tool_state(failed_setup),
    }


def failing_function_items(analysis: Any) -> list[Any]:
    return sorted(
        (item for item in analysis.functions if not item.passed),
        key=lambda item: (-item.craap_score, item.coverage_percent, item.path),
    )


def surviving_mutation_items(analysis: Any) -> list[Any]:
    return [item for item in analysis.mutations if item.survived]


def failed_setup_items(analysis: Any) -> list[Any]:
    return [item for item in analysis.tool_setup if item.returncode != 0]


def repository_certified(analysis: Any) -> bool:
    return bool(analysis.passed and not analysis.scope.incremental)


def state_fix_prompt(gate: Any, analysis: Any) -> str | None:
    return None if analysis.passed else gate.master_fix_prompt(analysis)


def analysis_state(
    gate: Any,
    analysis: Any,
    html_path: Path,
    state_path: Path,
    exit_code: int,
    error: str | None = None,
) -> dict[str, Any]:
    failing_functions = failing_function_items(analysis)
    survivors = surviving_mutation_items(analysis)
    violations = analysis.dependency_violations
    failed_setup = failed_setup_items(analysis)
    quality_gate = quality_gate_for(analysis)
    return {
        "schema_version": 1,
        "status": state_status(analysis, error),
        "mode": analysis.mode,
        "certified": repository_certified(analysis),
        "scope_certified": analysis.passed,
        "ready_for_full": analysis.ready_for_full,
        "exit_code": exit_code,
        "repository": analysis.root,
        "generated_at": analysis.generated_at,
        "artifacts": {"html": str(html_path), "state": str(state_path)},
        "rerun_command": analysis.rerun_command,
        "full_rerun_command": gate.without_fast_flag(analysis.rerun_command or ""),
        "scope": {
            "kind": analysis.scope.kind,
            "reference": analysis.scope.reference,
            "changed_files": list(analysis.scope.paths),
        },
        "metrics": metrics_state(analysis, quality_gate),
        "thresholds": analysis.thresholds,
        "gates": [gate_state(result) for result in analysis.gates],
        "counts": count_state(analysis, failing_functions, survivors, violations),
        "failures": failure_state(
            analysis, failing_functions, survivors, violations, failed_setup
        ),
        "fix_prompt": state_fix_prompt(gate, analysis),
        "error": error,
    }


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", text=True
    )
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as temporary:
            json.dump(value, temporary, indent=2)
            temporary.write("\n")
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def gate_card_html(
    gate: GateResult,
    presentation: tuple[str, str, str, str],
    metric_details: str = "",
) -> str:
    step, question, kicker, explanation = presentation
    state = (
        "deferred"
        if gate.deferred
        else ("na" if not gate.applicable else ("pass" if gate.passed else "fail"))
    )
    return f"""<details class="check-row {state}">
      <summary><span class="check-title"><span class="step">{html.escape(step)}</span>
      <span><strong>{html.escape(kicker)}</strong><small>{html.escape(question)}</small></span></span>
      <span class="check-status">{gate_outcome(gate)}</span></summary>
      <div class="check-body"><p class="explain">{html.escape(explanation)}</p>
      <p class="result">{html.escape(gate.summary)}</p>
      {details_html(gate.details)}
      {commands_html(gate.command_results)}
      {metric_details}</div>
    </details>"""


def optional_gate_setup_prompt(report: AnalysisReport, gate: GateResult) -> str:
    guidance = (
        "\n".join(gate.details)
        or "Inspect the repository and choose its native toolchain."
    )
    return f"""Add and configure the optional `{gate.title}` quality check for this repository:
{report.root}

Current state: {gate.summary}
Guidance: {guidance}

Inspect the repository's languages, package managers, existing scripts, and CI before choosing a tool. Install the smallest maintained dependency that fits the existing toolchain, configure a deterministic non-interactive check command, and add it to `{CONFIG_NAME}`. Do not disable another gate, weaken thresholds, add broad ignores, or replace the check with a no-op. Run the new check directly, then rerun the repository quality gate and report the exact command and result."""


def html_report(report: AnalysisReport) -> str:
    if report.mode == "fast":
        status = (
            "READY FOR FULL RUN" if report.ready_for_full else "FAST CHECKS NEED WORK"
        )
        page_heading = (
            "Fast quality check"
            if not report.scope.incremental
            else f"Fast quality check for {report.scope.description}"
        )
        verdict_class = "diagnostic"
    else:
        if report.scope.kind == "commit":
            status = "COMMIT SCOPE PASSED" if report.passed else "COMMIT NEEDS WORK"
            page_heading = f"Is {report.scope.description} ready?"
        elif report.scope.kind == "local_changes":
            status = (
                "LOCAL CHANGES PASSED" if report.passed else "LOCAL CHANGES NEED WORK"
            )
            page_heading = "Are local changes ready?"
        else:
            status = "READY TO SHIP" if report.passed else "NOT READY YET"
            page_heading = "Can I ship this?"
        verdict_class = "pass" if report.passed else "fail"
    thresholds = report.thresholds or default_thresholds()
    coverage_limit = threshold_number(thresholds, "metrics", "coverage_limit")
    complexity_limit = threshold_number(thresholds, "metrics", "complexity_limit")
    craap_limit = threshold_number(thresholds, "metrics", "craap_limit")
    file_loc_limit = int(threshold_number(thresholds, "file_loc", "max_lines"))
    applicable_gates = sum(
        gate.applicable and not gate.deferred for gate in report.gates
    )
    passed_gates = sum(
        gate.passed and gate.applicable and not gate.deferred for gate in report.gates
    )
    not_applicable_gates = sum(not gate.applicable for gate in report.gates)
    deferred_gates = sum(gate.deferred for gate in report.gates)
    gate_language = {
        "format_lint": (
            "1",
            "Is the code formatted and idiomatic?",
            "Formatter + lint",
            "Every detected project formatter and linter must pass without changing files.",
        ),
        "types": (
            "2",
            "Do the types agree?",
            "Static types",
            "Configured type checkers must report zero errors before tests run.",
        ),
        "contracts": (
            "3",
            "Are service contracts valid?",
            "Contracts + schemas",
            "Detected OpenAPI and JSON Schema files, plus configured compatibility checks, must pass.",
        ),
        "quality": (
            "4",
            "Are all code paths tested?",
            "Tests + coverage + complexity",
            f"The complete suite must pass, with {coverage_limit:g}% function coverage, complexity {complexity_limit:g} or lower, and CRAAP {craap_limit:g} or lower.",
        ),
        "file_loc": (
            "5",
            "Are files small enough to understand?",
            "File LOC",
            f"Every production file must contain at most {file_loc_limit} physical lines.",
        ),
        "dead_code": (
            "6",
            "Is unused code gone?",
            "Dead code",
            "Configured high-confidence unused-code detectors must report zero findings.",
        ),
        "flaky": (
            "7",
            "Are the tests repeatable?",
            "Flaky-test detection",
            "Repeated complete-suite runs must produce consistent passing results.",
        ),
        "mutation": (
            "8",
            "Would tests catch wrong code?",
            "Mutation testing",
            "The gate makes tiny wrong changes. Your tests must catch every one.",
        ),
        "dependencies": (
            "9",
            "Does the architecture stay clean?",
            "Module boundaries",
            "Imports must follow the dependency rules declared by the project.",
        ),
    }
    ordered_functions = sorted(
        report.functions,
        key=lambda function: (
            function.passed,
            -function.craap_score,
            function.path,
            function.start_line,
        ),
    )
    shown_functions = ordered_functions[:200]
    function_rows = (
        "".join(
            f"""<tr class="{"ok" if function.passed else "bad"}">
          <td><code>{html.escape(function.path)}:{function.start_line}</code></td>
          <td>{html.escape(function.name)}</td><td>{function.coverage_percent:.2f}%</td>
          <td>{function.complexity}</td><td>{function.craap_score:.2f}</td>
          <td>{html.escape(function.parser)}</td><td>{"PASS" if function.passed else "FAIL"}</td>
        </tr>"""
            for function in shown_functions
        )
        or '<tr><td colspan="7">No function metrics produced.</td></tr>'
    )
    if len(ordered_functions) > len(shown_functions):
        function_rows += f'<tr><td colspan="7">Showing the 200 highest-priority functions out of {len(ordered_functions)}. Fix and rerun to refresh this list.</td></tr>'
    ordered_files = sorted(
        report.files, key=lambda file: (file.passed, -file.lines, file.path)
    )
    shown_files = ordered_files[:200]
    file_rows = (
        "".join(
            f"""<tr class="{"ok" if file.passed else "bad"}">
          <td><code>{html.escape(file.path)}</code></td><td>{file.lines}</td>
          <td>{file.limit}</td><td>{"PASS" if file.passed else "FAIL"}</td>
        </tr>"""
            for file in shown_files
        )
        or '<tr><td colspan="4">No production files selected.</td></tr>'
    )
    if len(ordered_files) > len(shown_files):
        file_rows += f'<tr><td colspan="4">Showing 200 largest files out of {len(ordered_files)}.</td></tr>'
    ordered_mutations = sorted(
        report.mutations,
        key=lambda mutation: (
            not mutation.survived,
            mutation.path,
            mutation.line,
            mutation.column,
        ),
    )
    shown_mutations = ordered_mutations[:200]
    mutation_rows = (
        "".join(
            f"""<tr class="{"bad" if mutation.survived else "ok"}"><td><code>{mutation.mutant_id}</code></td>
        <td><code>{html.escape(mutation.path)}:{mutation.line}:{mutation.column}</code></td>
        <td><code>{html.escape(mutation.original)} → {html.escape(mutation.replacement)}</code></td>
        <td>{html.escape((mutation.status or ("Survived" if mutation.survived else "Killed")).upper())}</td><td>{"YES" if mutation.static else "NO"}</td><td>{mutation.duration_seconds:.2f}s</td></tr>"""
            for mutation in shown_mutations
        )
        or '<tr><td colspan="6">No mutants executed.</td></tr>'
    )
    if len(ordered_mutations) > len(shown_mutations):
        mutation_rows += f'<tr><td colspan="6">Showing 200 priority mutants out of {len(ordered_mutations)}.</td></tr>'
    shown_dependencies = report.dependency_violations[:200]
    dependency_rows = (
        "".join(
            f"""<tr class="bad"><td><code>{html.escape(item.source)}:{item.line}</code></td>
        <td>{html.escape(item.source_module)}</td><td><code>{html.escape(item.target)}</code></td>
        <td>{html.escape(item.target_module)}</td><td>{html.escape(item.rule)}</td></tr>"""
            for item in shown_dependencies
        )
        or '<tr><td colspan="5">No dependency violations.</td></tr>'
    )
    if len(report.dependency_violations) > len(shown_dependencies):
        dependency_rows += f'<tr><td colspan="5">Showing 200 violations out of {len(report.dependency_violations)}.</td></tr>'
    metric_details_by_gate = {
        "quality": f"""<div class="check-detail"><h4>Function metrics</h4><div class="table-wrap"><table><thead><tr><th>Location</th><th>Function</th><th>Coverage</th><th>Complexity</th><th>CRAAP</th><th>Parser</th><th>Status</th></tr></thead><tbody>{function_rows}</tbody></table></div></div>""",
        "file_loc": f"""<div class="check-detail"><h4>Measured files</h4><div class="table-wrap"><table><thead><tr><th>File</th><th>Physical LOC</th><th>Limit</th><th>Status</th></tr></thead><tbody>{file_rows}</tbody></table></div></div>""",
        "mutation": f"""<div class="check-detail"><h4>Mutation evidence</h4><div class="table-wrap"><table><thead><tr><th>ID</th><th>Location</th><th>Change</th><th>Result</th><th>Static</th><th>Time</th></tr></thead><tbody>{mutation_rows}</tbody></table></div></div>""",
        "dependencies": f"""<div class="check-detail"><h4>Architecture boundaries</h4><div class="table-wrap"><table><thead><tr><th>Source</th><th>From module</th><th>Target</th><th>To module</th><th>Broken rule</th></tr></thead><tbody>{dependency_rows}</tbody></table></div></div>""",
    }
    gate_cards = "".join(
        gate_card_html(
            gate,
            gate_language.get(gate.key, ("•", gate.title, gate.title, gate.summary)),
            metric_details_by_gate.get(gate.key, ""),
        )
        for gate in report.gates
    )
    failed_gates = [
        gate
        for gate in report.gates
        if gate.applicable and not gate.deferred and not gate.passed
    ]
    optional_gates = [gate for gate in report.gates if not gate.applicable]
    repair_action_html = ""
    if not report.passed:
        repair_action_html = f"""<button class="copy primary" data-copy="prompt-fix-everything">
          <span aria-hidden="true">▣</span> Copy repair prompt
        </button><pre class="copy-source" id="prompt-fix-everything" hidden>{html.escape(master_fix_prompt(report))}</pre>"""

    fix_rows = "".join(
        f"""<div class="issue-row"><span class="state-label fail">{gate_outcome(gate)}</span>
        <div><strong>{html.escape(gate.title)}</strong><p>{html.escape(gate.summary)}</p></div></div>"""
        for gate in failed_gates
    )
    fix_section = ""
    if failed_gates:
        fix_section = f"""<details class="group-section fix-section" open>
          <summary><span><span class="summary-icon fail">!</span>Fix first</span><span>{len(failed_gates)}</span></summary>
          <div class="group-body">{fix_rows}</div>
        </details>"""

    optional_rows = []
    optional_prompts = []
    for index, gate in enumerate(optional_gates):
        prompt_id = f"prompt-install-{index}"
        prompt = optional_gate_setup_prompt(report, gate)
        optional_prompts.append(f"## {gate.title}\n\n{prompt}")
        reason = gate.details[0] if gate.details else gate.summary
        optional_rows.append(
            f"""<div class="optional-row"><span class="na-mark">N/A</span>
            <div><strong>{html.escape(gate.title)}</strong><p>{html.escape(reason)}</p></div>
            <button class="copy secondary" data-copy="{prompt_id}"><span aria-hidden="true">▣</span> Copy install prompt</button>
            <pre class="copy-source" id="{prompt_id}" hidden>{html.escape(prompt)}</pre></div>"""
        )
    optional_section = ""
    if optional_rows:
        all_optional_prompt = "\n\n---\n\n".join(optional_prompts)
        optional_section = f"""<details class="group-section optional-section" open>
          <summary><span><span class="summary-icon na">N/A</span>Add optional checks</span><span>{len(optional_gates)} not applicable</span></summary>
          <div class="optional-heading"><p>These checks were not detected. Copy a prompt only if you want to add one.</p>
          <button class="copy secondary" data-copy="prompt-install-all"><span aria-hidden="true">▣</span> Copy all install prompts</button></div>
          <pre class="copy-source" id="prompt-install-all" hidden>{html.escape(all_optional_prompt)}</pre>
          <div class="group-body">{"".join(optional_rows)}</div>
        </details>"""

    notes_html = "".join(f"<li>{html.escape(note)}</li>" for note in report.notes)
    language_text = ", ".join(report.languages)
    setup_failed = sum(result.returncode != 0 for result in report.tool_setup)
    if report.tool_setup:
        setup_summary = (
            f"Ran {len(report.tool_setup)} automatic install command(s); "
            f"{setup_failed} failed."
        )
        setup_evidence = commands_html(report.tool_setup)
    else:
        setup_summary = "No install was needed. Built-in tools and existing project tools were enough."
        setup_evidence = ""
    total_gates = max(1, len(report.gates))
    failed_count = len(failed_gates)
    outcome_segments = "".join(
        f'<span class="segment {state}" style="flex:{count}" title="{count} {label}"></span>'
        for state, count, label in (
            ("pass", passed_gates, "passed"),
            ("fail", failed_count, "failed"),
            ("deferred", deferred_gates, "deferred"),
            ("na", not_applicable_gates, "not applicable"),
        )
        if count
    )
    outcome_legend = "".join(
        f'<span><i class="{state}"></i><strong>{count}</strong> {label}</span>'
        for state, count, label in (
            ("pass", passed_gates, "Passed"),
            ("fail", failed_count, "Failed"),
            ("deferred", deferred_gates, "Deferred"),
            ("na", not_applicable_gates, "Not applicable"),
        )
    )
    function_count = len(report.functions)
    file_count = len(report.files)
    average_craap = (
        f"{sum(item.craap_score for item in report.functions) / function_count:.2f}"
        if function_count
        else "—"
    )
    average_complexity = (
        f"{sum(item.complexity for item in report.functions) / function_count:.2f}"
        if function_count
        else "—"
    )
    average_coverage = (
        f"{sum(item.coverage_percent for item in report.functions) / function_count:.1f}%"
        if function_count
        else "—"
    )
    mean_file_loc = (
        f"{sum(item.lines for item in report.files) / file_count:.0f}"
        if file_count
        else "—"
    )
    metric_tiles = f"""<div class="metric-grid">
      <div class="metric-tile"><strong>{average_craap}</strong><span>Average CRAAP</span><small>Target ≤ {craap_limit:g}</small></div>
      <div class="metric-tile"><strong>{mean_file_loc}</strong><span>Mean file LOC</span><small>Limit ≤ {file_loc_limit:,}</small></div>
      <div class="metric-tile"><strong>{average_complexity}</strong><span>Average complexity</span><small>Target ≤ {complexity_limit:g}</small></div>
      <div class="metric-tile"><strong>{average_coverage}</strong><span>Average coverage</span><small>Target {coverage_limit:g}%</small></div>
    </div>"""
    gate_flow_items = []
    for gate in report.gates:
        if gate.deferred:
            state, symbol, state_text = "deferred", "◷", "DEFERRED"
        elif not gate.applicable:
            state, symbol, state_text = "na", "−", "N/A"
        elif gate.passed:
            state, symbol, state_text = "pass", "✓", "PASS"
        else:
            state, symbol, state_text = "fail", "×", "FAIL"
        short_title = gate_language.get(
            gate.key, ("", gate.title, gate.title, gate.summary)
        )[2]
        gate_flow_items.append(
            f"""<div class="flow-item {state}"><span class="flow-symbol">{symbol}</span>
            <strong>{html.escape(short_title)}</strong><small>{state_text}</small></div>"""
        )
    gate_flow = "".join(gate_flow_items)
    thresholds_html = html.escape(json.dumps(thresholds, indent=2))
    repository_name = Path(report.root).name or report.root
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{page_heading} — {status}</title>
<style>
:root{{--bg:#f4f6f8;--ink:#111318;--secondary:#606773;--card:rgba(255,255,255,.94);--glass:rgba(248,251,255,.76);--line:rgba(41,50,65,.12);--blue:#087cff;--good:#16a05d;--good-soft:#eaf8f0;--bad:#ef3939;--bad-soft:#fff0f0;--deferred:#7b4ce2;--deferred-soft:#f1ebff;--na:#8b929d;--na-soft:#f0f2f4;--code:#1f232b}}
*{{box-sizing:border-box}} body{{margin:0;overflow-x:hidden;background:radial-gradient(circle at 50% -20%,#dcecff 0,transparent 35%),var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif}}
main{{max-width:1280px;margin:auto;padding:18px 24px 46px}} h1,h2,h3,p{{margin-top:0}} h1{{font-size:clamp(34px,4vw,50px);line-height:1.04;letter-spacing:-.035em;margin:5px 0 8px}} h2{{font-size:19px}} button{{font:inherit}}
.toolbar{{position:sticky;top:12px;z-index:5;display:flex;align-items:center;gap:18px;padding:11px 16px;border:1px solid rgba(255,255,255,.72);border-radius:18px;background:var(--glass);backdrop-filter:blur(24px) saturate(150%);box-shadow:0 8px 30px rgba(40,58,90,.11)}} .brand{{font-weight:700}} .repo{{padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.62);border:1px solid var(--line)}} .toolbar-meta{{margin-left:auto;display:flex;gap:18px;color:var(--secondary);font-size:13px}} .toolbar-meta strong{{color:var(--ink)}}
.hero{{display:grid;grid-template-columns:1fr auto;align-items:end;gap:24px;padding:28px 4px 18px}} .eyebrow{{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--secondary)}} .verdict{{display:inline-flex;margin-top:8px;padding:5px 9px;border-radius:8px;font-size:12px;font-weight:700}} .verdict.pass{{color:var(--good);background:var(--good-soft)}} .verdict.fail{{color:var(--bad);background:var(--bad-soft)}} .verdict.diagnostic{{color:var(--deferred);background:var(--deferred-soft)}} .meta{{color:var(--secondary)}}
.copy{{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:38px;padding:8px 13px;border-radius:10px;border:1px solid rgba(8,124,255,.48);background:#fff;color:var(--blue);font-weight:650;cursor:pointer}} .copy.primary{{background:var(--blue);border-color:var(--blue);color:#fff;box-shadow:0 5px 14px rgba(8,124,255,.2)}} .copy:hover{{filter:brightness(.97)}} .copy.copied{{background:var(--good);border-color:var(--good);color:#fff}}
.dashboard{{display:grid;grid-template-columns:1fr 1fr;gap:14px}} .card{{min-width:0;background:var(--card);border:1px solid rgba(255,255,255,.85);border-radius:18px;padding:16px;box-shadow:0 7px 24px rgba(35,45,70,.07)}} .card h2{{margin-bottom:14px}} .outcome-bar{{display:flex;height:22px;overflow:hidden;border-radius:7px;background:#e8ebef}} .segment.pass,.bar-track .pass,.legend i.pass{{background:var(--good)}} .segment.fail,.bar-track .fail,.legend i.fail{{background:var(--bad)}} .segment.deferred,.legend i.deferred{{background:var(--deferred)}} .segment.na,.legend i.na{{background:var(--na)}} .legend{{display:flex;flex-wrap:wrap;gap:20px;margin-top:14px;color:var(--secondary)}} .legend span{{display:flex;align-items:center;gap:6px}} .legend i{{width:10px;height:10px;border-radius:3px}}
.metric-grid{{display:grid;grid-template-columns:1fr 1fr;gap:10px}} .metric-tile{{display:grid;gap:1px;padding:12px;border:1px solid var(--line);border-radius:13px;background:rgba(255,255,255,.62)}} .metric-tile strong{{font-size:25px;line-height:1.05;letter-spacing:-.03em}} .metric-tile span{{font-size:12px;font-weight:700}} .metric-tile small{{color:var(--secondary);font-size:10px}}
.flow-card{{grid-column:1/-1;overflow:hidden}} .gate-flow{{display:grid;grid-template-columns:repeat({total_gates},minmax(94px,1fr));gap:4px;overflow:auto;padding:4px 0}} .flow-item{{position:relative;display:grid;justify-items:center;gap:3px;text-align:center;color:var(--secondary)}} .flow-item:not(:last-child)::after{{content:"";position:absolute;top:16px;left:64%;width:72%;height:1px;background:var(--line)}} .flow-symbol{{position:relative;z-index:1;display:grid;place-items:center;width:34px;height:34px;border:1.5px solid currentColor;border-radius:50%;background:#fff;font-size:19px}} .flow-item strong{{font-size:12px;color:var(--ink);font-weight:600}} .flow-item small{{font-size:10px;font-weight:700}} .flow-item.pass{{color:var(--good)}} .flow-item.fail{{color:var(--bad)}} .flow-item.deferred{{color:var(--deferred)}} .flow-item.na{{color:var(--na)}}
.accordion{{margin-top:14px;overflow:hidden;border:1px solid rgba(255,255,255,.82);border-radius:18px;background:var(--glass);backdrop-filter:blur(18px) saturate(135%);box-shadow:0 8px 28px rgba(35,45,70,.08)}} .group-section,.data-section{{margin:0;border-bottom:1px solid var(--line)}} .accordion>details:last-child{{border-bottom:0}} summary{{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:44px;padding:10px 16px;cursor:pointer;font-weight:650;list-style:none}} summary::-webkit-details-marker{{display:none}} summary::after{{content:"›";font-size:22px;font-weight:400;transform:rotate(0);transition:.18s}} details[open]>summary::after{{transform:rotate(90deg)}} summary>span:first-child{{display:flex;align-items:center;gap:9px}} .summary-icon{{display:grid;place-items:center;min-width:24px;height:24px;border-radius:50%;font-size:11px}} .summary-icon.fail{{color:var(--bad);border:1px solid var(--bad)}} .summary-icon.na{{color:var(--na);border:1px solid var(--na)}} .group-body{{border-top:1px solid var(--line)}}
.issue-row,.optional-row{{display:grid;grid-template-columns:94px 1fr auto;align-items:center;gap:16px;padding:10px 16px;border-bottom:1px solid var(--line)}} .issue-row:last-child,.optional-row:last-child{{border-bottom:0}} .issue-row p,.optional-row p,.optional-heading p{{margin:2px 0 0;color:var(--secondary);font-size:13px}} .state-label{{font-size:12px;font-weight:750}} .state-label.fail{{color:var(--bad)}} .na-mark{{display:grid;place-items:center;width:28px;height:28px;border:1px solid var(--na);border-radius:50%;color:var(--na);font-size:10px}} .optional-heading{{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:10px 16px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}} .optional-heading p{{margin:0}} .panel{{padding:16px;border-top:1px solid var(--line)}}
.checks-list{{border-bottom:1px solid var(--line)}} .check-row{{margin:0;border-bottom:1px solid var(--line);background:rgba(255,255,255,.5)}} .check-row:last-child{{border-bottom:0}} .check-row summary{{padding:11px 16px}} .check-title{{display:flex;align-items:center;gap:12px}} .check-title>span:last-child{{display:grid;gap:1px}} .check-title strong{{font-size:14px}} .check-title small{{color:var(--secondary);font-size:12px;font-weight:450}} .step{{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#edf0f4}} .check-status{{margin-left:auto;margin-right:8px;font-size:11px;font-weight:800}} .check-row.pass .check-status{{color:var(--good)}} .check-row.fail .check-status{{color:var(--bad)}} .check-row.deferred .check-status{{color:var(--deferred)}} .check-row.na .check-status{{color:var(--na)}} .check-body{{padding:0 56px 14px}} .check-detail{{margin-top:16px}} .check-detail h4{{margin:0 0 8px;font-size:13px}} .explain{{color:var(--secondary);font-size:12px}} .result{{font-weight:600;font-size:13px}} code,pre{{font-family:"SFMono-Regular",Consolas,monospace}} pre{{white-space:pre-wrap;word-break:break-word;background:var(--code);color:#f5f7fa;padding:14px;border-radius:12px;max-height:400px;overflow:auto}}
.table-wrap{{overflow:auto;border:1px solid var(--line);border-radius:12px;background:#fff}} table{{width:100%;border-collapse:collapse}} th,td{{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}} th{{font-size:11px;text-transform:uppercase;letter-spacing:.04em;background:#f5f6f8}} tr.bad{{background:#fff8f8}} tr.ok td:last-child{{color:var(--good);font-weight:700}} ul{{margin:0;padding-left:20px}} footer{{padding:22px 8px 0;text-align:center;color:var(--secondary);font-size:12px}}
@media(max-width:900px){{main{{padding:12px}}.toolbar-meta span{{display:none}}.hero{{grid-template-columns:1fr}}.dashboard{{grid-template-columns:1fr}}.flow-card{{grid-column:auto}}.issue-row,.optional-row{{grid-template-columns:72px 1fr}}.issue-row .copy,.optional-row .copy{{grid-column:2}}}}
@media(max-width:620px){{.toolbar{{justify-content:center;gap:9px}}.brand,.toolbar-meta{{display:none}}.repo{{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}}h1{{font-size:34px}}.legend{{display:grid;grid-template-columns:1fr 1fr;gap:9px}}.metric-tile{{padding:10px}}.check-title small{{display:none}}.check-body{{padding-left:16px;padding-right:16px}}.optional-heading{{align-items:flex-start;flex-direction:column}}.copy{{width:100%}}}}
</style></head><body><main>
<header class="toolbar"><span class="brand">Code Confidence</span><span class="repo">{html.escape(repository_name)} · {html.escape(report.scope.description)}</span>
<div class="toolbar-meta"><strong>{report.mode.upper()} RUN</strong><span>{html.escape(report.generated_at)}</span></div></header>
<section class="hero"><div><div class="eyebrow">Repository health · v{VERSION}</div><h1>{page_heading}</h1>
<div class="meta">{html.escape(report.root)} · {html.escape(language_text)}</div><span class="verdict {verdict_class}">{status}</span></div>{repair_action_html}</section>
<section class="dashboard"><article class="card"><h2>Gate outcomes</h2><div class="outcome-bar" aria-label="{passed_gates} passed, {failed_count} failed, {deferred_gates} deferred, {not_applicable_gates} not applicable">{outcome_segments}</div><div class="legend">{outcome_legend}</div></article>
<article class="card"><h2>Code metrics</h2>{metric_tiles}</article>
<article class="card flow-card"><h2>Quality gates</h2><div class="gate-flow">{gate_flow}</div></article></section>
<section class="accordion">{fix_section}{optional_section}
<div class="checks-list">{gate_cards}</div>
<details class="data-section"><summary><span>Run details</span><span>{report.mode} mode · {html.escape(report.scope.description)} · {html.escape(language_text)}</span></summary><div class="panel"><h3>Thresholds</h3><pre>{thresholds_html}</pre><h3>Automatic tool setup</h3><p>{html.escape(setup_summary)}</p>{setup_evidence}<h3>Notes</h3><ul>{notes_html}</ul></div></details>
</section><footer>{applicable_gates} applicable · {deferred_gates} deferred · generated {html.escape(report.generated_at)}</footer>
</main><script>
document.querySelectorAll('[data-copy]').forEach(button=>button.addEventListener('click',async()=>{{
 const text=document.getElementById(button.dataset.copy).textContent;
 const originalLabel=button.textContent;
 try{{await navigator.clipboard.writeText(text)}}catch(error){{
   const area=document.createElement('textarea'); area.value=text; document.body.appendChild(area);
   area.select(); document.execCommand('copy'); area.remove();
 }}
 button.textContent='Copied'; button.classList.add('copied'); setTimeout(()=>{{button.textContent=originalLabel;button.classList.remove('copied')}},1600);
}}));
</script></body></html>"""


def details_html(details: Sequence[str]) -> str:
    if not details:
        return ""
    content = "\n".join(details)
    return f"<details><summary>Details ({len(details)})</summary><pre>{html.escape(content)}</pre></details>"


def commands_html(results: Sequence[CommandResult]) -> str:
    if not results:
        return ""
    content = "\n\n".join(format_command(result) for result in results)
    return f"<details><summary>Command evidence ({len(results)})</summary><pre>{html.escape(content)}</pre></details>"


def config_template(
    root: Path, thresholds: dict[str, Any] | None = None
) -> dict[str, Any]:
    test = infer_test_command(root)
    package = read_package_json(root)
    config = deep_merge(
        default_config(thresholds),
        {
            "test": {"command": test},
            "mutation": {"test_command": test},
            "_adapter_contract": {
                "metrics": {
                    "functions": [
                        {
                            "path": "src/file.ext",
                            "name": "functionName",
                            "start_line": 1,
                            "end_line": 10,
                            "complexity": 2,
                            "covered_lines": 5,
                            "total_lines": 5,
                            "coverage_percent": 100,
                        }
                    ]
                },
                "dependencies": {
                    "edges": [{"from": "src/a.ext", "to": "src/b.ext", "line": 1}]
                },
            },
            "_note": "Commands are argument arrays. Use ['bash','-lc','...'] only when shell syntax is required. Remove underscore-prefixed documentation keys if desired.",
            "_detected_package": package.get("name") if package else None,
        },
    )
    return without_threshold_values(config)


def write_initial_config(
    root: Path, path: Path, thresholds: dict[str, Any] | None = None
) -> None:
    if path.exists():
        raise FileExistsError(f"Refusing to overwrite existing configuration: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(config_template(root, thresholds), indent=2) + "\n",
        encoding="utf-8",
    )


def write_initial_thresholds(path: Path) -> None:
    if path.exists():
        raise FileExistsError(f"Refusing to overwrite existing thresholds: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(default_thresholds(), indent=2) + "\n", encoding="utf-8")


def run(
    root: Path,
    config: dict[str, Any],
    report_path: Path,
    cli_max_mutants: int | None,
    notes: list[str],
    fast: bool = False,
    cli_mutation_workers: str | int | None = None,
    scope: GateScope | None = None,
    thresholds: dict[str, Any] | None = None,
) -> AnalysisReport:
    scope = scope or repository_scope()
    languages = detect_languages(root)
    all_source_files = discover_source_files(root, config["source"])
    source_files = discover_source_files(root, config["source"], scope)
    notes.append(f"Detected languages: {', '.join(languages)}")
    notes.append(
        f"Selected {len(source_files)} production source files from {scope.description}"
    )
    if fast:
        notes.append(
            "Fast diagnostic mode: flaky-test repetitions and mutation testing are deferred; this run cannot certify the repository."
        )
    tools = bootstrap_tools(root, config, source_files)
    if tools.stryker_command:
        notes.append(
            "Mutation testing selected the native Vitest/Stryker adapter with semantic operator discovery, per-test execution, and a persistent incremental cache."
        )
        mutation_config = config["mutation"]
        dedicated_test_files = mutation_config.get("test_files", [])
        if dedicated_test_files:
            notes.append(
                f"Native mutation is restricted to {len(dedicated_test_files)} configured fast-test glob(s); the complete baseline suite still runs separately."
            )
        configured_vitest = mutation_vitest_config_path(
            root, mutation_config.get("vitest_config")
        )
        if configured_vitest:
            notes.append(
                f"Native mutation uses the dedicated Vitest configuration {configured_vitest}."
            )
    else:
        notes.append(
            "Mutation testing selected the portable built-in fallback; dependency checking remains built in."
        )
    if tools.setup_results:
        succeeded = sum(result.returncode == 0 for result in tools.setup_results)
        notes.append(
            f"Automatic tool setup completed {succeeded}/{len(tools.setup_results)} install commands successfully."
        )
    else:
        notes.append(
            "All detected analysis tools were already available or unnecessary."
        )
    with tempfile.TemporaryDirectory(prefix="repo-quality-gate-") as temporary:
        workspace = Path(temporary)
        format_lint_gate = run_command_check_gate(
            root,
            "format_lint",
            "Formatter & lint",
            config["format_lint"],
            infer_format_lint_commands(root, source_files, tools, scope),
            "Configure format_lint.commands with non-mutating check-mode formatter and linter commands.",
            tools.python_env,
        )
        types_gate = run_command_check_gate(
            root,
            "types",
            "Static type checking",
            config["types"],
            infer_type_commands(root, source_files, tools),
            "Configure types.commands with the repository's complete static type checker.",
            tools.python_env,
        )
        contracts_gate = run_contract_gate(root, config, tools)
        test_command, test_baseline = run_test_baseline(root, config)
        if scope.incremental and not source_files:
            raw_metrics_gate = GateResult(
                "craap",
                "CRAAP: coverage + complexity",
                True,
                f"No changed production source files were selected from {scope.description}; file metrics were not needed.",
            )
            functions: list[FunctionMetric] = []
        else:
            raw_metrics_gate, functions = run_metrics_gate(
                root, config, source_files, workspace, tools
            )
        quality_gate = combine_test_and_metrics_gate(
            raw_metrics_gate, test_command, test_baseline
        )
        if scope.incremental and not source_files:
            file_loc_gate = GateResult(
                "file_loc",
                "File LOC",
                True,
                f"Not applicable: no changed production source files were selected from {scope.description}.",
                applicable=False,
            )
            files: list[FileLineMetric] = []
        else:
            file_loc_gate, files = run_file_loc_gate(
                root, source_files, config["file_loc"]
            )
        dead_code_gate = run_command_check_gate(
            root,
            "dead_code",
            "Dead code",
            config["dead_code"],
            infer_dead_code_commands(root, source_files, tools),
            "Configure dead_code.commands with a high-confidence unused-code detector such as Vulture, Knip, or ts-prune.",
            tools.python_env,
        )
        if fast:
            flaky_gate = deferred_check(
                "flaky",
                "Flaky-test detection",
                "repeated complete-suite runs are reserved for full certification.",
            )
            mutation_gate = deferred_check(
                "mutation",
                "Mutation testing",
                "the exhaustive mutant run is reserved for full certification.",
            )
            mutations: list[Mutation] = []
        elif scope.incremental and not source_files:
            flaky_gate = run_flaky_test_gate(root, config, test_command, test_baseline)
            mutation_gate = GateResult(
                "mutation",
                "Mutation testing",
                True,
                f"Not applicable: no changed production source files were selected from {scope.description}.",
                applicable=False,
            )
            mutations = []
        else:
            flaky_gate = run_flaky_test_gate(root, config, test_command, test_baseline)
            mutation_gate, mutations = run_mutation_gate(
                root,
                config,
                source_files,
                cli_max_mutants,
                test_baseline,
                cli_mutation_workers,
                tools,
                scope,
            )
        if scope.incremental and not source_files:
            dependency_gate = GateResult(
                "dependencies",
                "Module dependencies",
                True,
                f"Not applicable: no changed production source files were selected from {scope.description}.",
                applicable=False,
            )
            violations: list[DependencyViolation] = []
        else:
            dependency_gate, violations = run_dependency_gate(
                root,
                config,
                source_files,
                workspace,
                resolution_files=all_source_files,
            )
    analysis = AnalysisReport(
        root=str(root),
        generated_at=time.strftime("%Y-%m-%d %H:%M:%S %z"),
        languages=languages,
        gates=[
            format_lint_gate,
            types_gate,
            contracts_gate,
            quality_gate,
            file_loc_gate,
            dead_code_gate,
            flaky_gate,
            mutation_gate,
            dependency_gate,
        ],
        functions=functions,
        mutations=mutations,
        dependency_violations=violations,
        tool_setup=tools.setup_results,
        notes=notes,
        files=files,
        thresholds=thresholds or default_thresholds(),
        mode="fast" if fast else "full",
        scope=scope,
    )
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(html_report(analysis), encoding="utf-8")
    return analysis


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--root", default=".", help="repository root (default: current directory)"
    )
    parser.add_argument(
        "--config",
        help=f"JSON configuration (default: ROOT/{CONFIG_NAME} when present)",
    )
    parser.add_argument(
        "--thresholds",
        help=f"quality-threshold JSON (default: ROOT/{THRESHOLDS_NAME}, then bundled defaults)",
    )
    parser.add_argument(
        "--update-from-github",
        nargs="?",
        const=GITHUB_DEFAULT_REF,
        type=validate_update_ref,
        metavar="REF",
        help=f"update from {GITHUB_REPOSITORY} (default REF: {GITHUB_DEFAULT_REF}) and exit",
    )
    parser.add_argument(
        "--html",
        default=DEFAULT_REPORT,
        help=f"HTML report path (default: {DEFAULT_REPORT})",
    )
    parser.add_argument(
        "--init", action="store_true", help=f"write a detected {CONFIG_NAME} and exit"
    )
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument(
        "--commit",
        nargs="?",
        const="HEAD",
        metavar="REF",
        help="gate production files changed by one commit (default REF: HEAD)",
    )
    scope.add_argument(
        "--local-changes",
        action="store_true",
        help="gate production files in staged, unstaged, and untracked changes",
    )
    parser.add_argument(
        "--max-mutants", type=int, help="diagnostic cap; a capped run can never pass"
    )
    parser.add_argument(
        "--mutation-workers",
        metavar="N|auto",
        help="run mutants with N workers; native auto follows Stryker's CPU default, while the portable fallback uses up to 4 isolated workers",
    )
    parser.add_argument(
        "--fast",
        action="store_true",
        help="run one diagnostic pass and defer flaky-test repetitions and mutation testing; never certifies",
    )
    parser.add_argument(
        "--no-install",
        action="store_true",
        help="do not automatically install missing analysis tools",
    )
    parser.add_argument("--version", action="version", version=VERSION)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if args.update_from_github:
        return update_from_github(Path(__file__).resolve(), args.update_from_github)
    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f"error: repository root does not exist: {root}", file=sys.stderr)
        return 2
    config_path = Path(args.config).resolve() if args.config else root / CONFIG_NAME
    local_thresholds_path = root / THRESHOLDS_NAME
    thresholds_path = (
        Path(args.thresholds).resolve()
        if args.thresholds
        else (
            local_thresholds_path
            if local_thresholds_path.exists() or args.init
            else bundled_thresholds_path()
        )
    )
    if args.init:
        try:
            if config_path.exists():
                raise FileExistsError(
                    f"Refusing to overwrite existing configuration: {config_path}"
                )
            if thresholds_path.exists():
                raise FileExistsError(
                    f"Refusing to overwrite existing thresholds: {thresholds_path}"
                )
            thresholds = default_thresholds()
            write_initial_thresholds(thresholds_path)
            write_initial_config(root, config_path, thresholds)
        except (OSError, ValueError) as error:
            print(f"error: {error}", file=sys.stderr)
            return 2
        print(f"Wrote {config_path}")
        print(f"Wrote {thresholds_path}")
        print(
            "Review source, format/lint, types, contracts, tests, metrics, dead-code, flaky-test, mutation, and dependency settings before the first enforcing run."
        )
        return 0
    report_path = Path(args.html)
    if not report_path.is_absolute():
        report_path = root / report_path
    if args.commit:
        scope = GateScope("commit", reference=args.commit)
    elif args.local_changes:
        scope = GateScope("local_changes")
    else:
        scope = repository_scope()
    try:
        if args.commit:
            scope = commit_scope(root, args.commit)
        elif args.local_changes:
            scope = local_changes_scope(root)
        thresholds, threshold_notes = load_thresholds(thresholds_path)
        config, notes = load_config(
            config_path if config_path.exists() else None, thresholds
        )
        notes = [*threshold_notes, *notes]
        if args.no_install:
            config["tools"]["auto_install"] = False
        analysis = run(
            root,
            config,
            report_path,
            args.max_mutants,
            notes,
            fast=args.fast,
            cli_mutation_workers=args.mutation_workers,
            scope=scope,
            thresholds=thresholds,
        )
        rerun = [sys.executable, str(Path(__file__).resolve()), "--root", "."]
        if args.config:
            rerun.extend(["--config", str(config_path)])
        if args.thresholds:
            rerun.extend(["--thresholds", str(thresholds_path)])
        rerun.extend(["--html", str(report_path)])
        if args.no_install:
            rerun.append("--no-install")
        if args.mutation_workers:
            rerun.extend(["--mutation-workers", args.mutation_workers])
        if args.commit:
            rerun.extend(["--commit", args.commit])
        elif args.local_changes:
            rerun.append("--local-changes")
        if args.fast:
            rerun.append("--fast")
        analysis.rerun_command = shlex.join(rerun)
        report_path.write_text(html_report(analysis), encoding="utf-8")
    except (OSError, ValueError, KeyError, TypeError) as error:
        failure = AnalysisReport(
            root=str(root),
            generated_at=time.strftime("%Y-%m-%d %H:%M:%S %z"),
            languages=detect_languages(root),
            gates=[
                GateResult(
                    "runner",
                    "Gate runner",
                    False,
                    f"The quality-gate runner stopped: {error}",
                    prompts=[
                        (
                            "Repair gate configuration",
                            f"Run the repository quality gate and repair this configuration or adapter error without disabling a required gate:\n\n{error}",
                        )
                    ],
                )
            ],
            functions=[],
            mutations=[],
            dependency_violations=[],
            tool_setup=[],
            notes=["The run stopped before all gates could be evaluated."],
            thresholds={},
            mode="fast" if args.fast else "full",
            scope=scope,
        )
        with contextlib.suppress(OSError):
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(html_report(failure), encoding="utf-8")
        print(f"error: {error}", file=sys.stderr)
        print(f"HTML report: {report_path}", file=sys.stderr)
        return 2
    for gate in analysis.gates:
        print(f"[{gate_outcome(gate)}] {gate.title}: {gate.summary}")
    print(f"HTML report: {report_path}")
    return 0 if analysis.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
