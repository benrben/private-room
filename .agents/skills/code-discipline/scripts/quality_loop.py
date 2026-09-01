#!/usr/bin/env python3
"""Run one machine-readable repository quality-gate round.

Agents invoke this command repeatedly. Exit 0 means every required gate passed,
exit 1 means actionable failures remain, and exit 2 means setup or configuration
prevented a complete measurement.
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import importlib.util
import json
import os
import shlex
import signal
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType
from typing import Any, Iterator, Sequence, TextIO

SCRIPT_DIRECTORY = Path(__file__).resolve().parent
if str(SCRIPT_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIRECTORY))

from repo_quality_gate import analysis_state, write_json_atomic  # noqa: E402
from repo_quality_gate import command_state as command_state  # noqa: E402
from repo_quality_gate import gate_status as gate_status  # noqa: E402
from repo_quality_gate import state_fix_prompt as state_fix_prompt  # noqa: E402
from repo_quality_gate import state_status as state_status  # noqa: E402

VERSION = "3.2.0"
QUALITY_DIRECTORY = ".quality"
DEFAULT_GATE_SCRIPT = Path(__file__).resolve().with_name("repo_quality_gate.py")


class ConcurrentRunError(RuntimeError):
    """Raised when another quality loop already owns a repository."""


def raise_keyboard_interrupt(_signum: int, _frame: Any) -> None:
    raise KeyboardInterrupt


def install_interrupt_handlers() -> None:
    signal.signal(signal.SIGINT, raise_keyboard_interrupt)
    signal.signal(signal.SIGTERM, raise_keyboard_interrupt)


def load_gate(path: Path) -> ModuleType:
    """Load the bundled gate without requiring package installation."""
    spec = importlib.util.spec_from_file_location("repo_quality_gate_core", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load quality-gate engine: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def resolve_from_root(value: str | None, root: Path, default: Path) -> Path:
    if value is None:
        return default
    path = Path(value)
    return path.resolve() if path.is_absolute() else (root / path).resolve()


def default_artifact_dir(root: Path) -> Path:
    cache = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    digest = hashlib.sha256(str(root).encode()).hexdigest()[:12]
    return cache / "repo-quality-loop" / f"{root.name}-{digest}"


def repository_lock_path(root: Path) -> Path:
    """Return one stable lock path regardless of report destination."""
    return default_artifact_dir(root.resolve()) / ".run.lock"


def try_lock(handle: TextIO) -> bool:
    if os.name == "nt":
        import msvcrt

        windows_msvcrt: Any = msvcrt
        locking = windows_msvcrt.locking
        nonblocking_lock = windows_msvcrt.LK_NBLCK

        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write("\0")
            handle.flush()
        handle.seek(0)
        try:
            locking(handle.fileno(), nonblocking_lock, 1)
        except OSError as error:
            if error.errno in {errno.EACCES, errno.EDEADLK}:
                return False
            raise
        return True

    import fcntl

    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return False
    return True


def unlock(handle: TextIO) -> None:
    if os.name == "nt":
        import msvcrt

        windows_msvcrt: Any = msvcrt
        handle.seek(0)
        windows_msvcrt.locking(handle.fileno(), windows_msvcrt.LK_UNLCK, 1)
        return

    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def lock_owner(handle: TextIO) -> str:
    handle.seek(0)
    raw = handle.read().strip("\0\n ")
    if not raw:
        return "owner details unavailable"
    try:
        owner = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    pid = owner.get("pid", "unknown")
    started_at = owner.get("started_at", "unknown time")
    return f"PID {pid}, started {started_at}"


@contextmanager
def repository_run_lock(root: Path) -> Iterator[None]:
    """Allow only one quality loop to use a repository's shared tools at a time."""
    path = repository_lock_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as handle:
        if not try_lock(handle):
            raise ConcurrentRunError(
                f"quality loop already running for {root} ({lock_owner(handle)})"
            )
        try:
            handle.seek(0)
            handle.truncate()
            json.dump(
                {
                    "pid": os.getpid(),
                    "started_at": time.strftime("%Y-%m-%d %H:%M:%S %z"),
                },
                handle,
            )
            handle.flush()
            yield
        finally:
            unlock(handle)


def display_path(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def append_rerun_configuration(
    command: list[str],
    root: Path,
    config_path: Path,
    explicit_config: bool,
    thresholds_path: Path,
    explicit_thresholds: bool,
    artifact_dir: Path,
    explicit_artifacts: bool,
    html_path: Path,
    explicit_html: bool,
    gate_script: Path,
    explicit_gate_script: bool,
) -> None:
    if explicit_config:
        command.extend(["--config", display_path(config_path, root)])
    if explicit_thresholds:
        command.extend(["--thresholds", display_path(thresholds_path, root)])
    if explicit_html:
        command.extend(["--html", display_path(html_path, root)])
    elif explicit_artifacts:
        command.extend(["--artifact-dir", display_path(artifact_dir, root)])
    if explicit_gate_script:
        command.extend(["--gate-script", str(gate_script)])


def append_rerun_execution(
    command: list[str],
    scope_arguments: Sequence[str],
    no_install: bool,
    fast: bool,
    mutation_workers: str | None,
) -> None:
    command.extend(scope_arguments)
    if no_install:
        command.append("--no-install")
    if mutation_workers:
        command.extend(["--mutation-workers", mutation_workers])
    if fast:
        command.append("--fast")


def build_rerun_command(
    root: Path,
    config_path: Path,
    explicit_config: bool,
    thresholds_path: Path,
    explicit_thresholds: bool,
    artifact_dir: Path,
    explicit_artifacts: bool,
    html_path: Path,
    explicit_html: bool,
    gate_script: Path,
    explicit_gate_script: bool,
    scope_arguments: Sequence[str],
    no_install: bool,
    fast: bool,
    mutation_workers: str | None,
) -> str:
    command = [sys.executable, str(Path(__file__).resolve()), "--root", "."]
    append_rerun_configuration(
        command,
        root,
        config_path,
        explicit_config,
        thresholds_path,
        explicit_thresholds,
        artifact_dir,
        explicit_artifacts,
        html_path,
        explicit_html,
        gate_script,
        explicit_gate_script,
    )
    append_rerun_execution(command, scope_arguments, no_install, fast, mutation_workers)
    return shlex.join(command)


def error_report(
    gate: ModuleType,
    root: Path,
    message: str,
    command: str,
    fast: bool,
    scope: Any,
) -> Any:
    return gate.AnalysisReport(
        root=str(root),
        generated_at=time.strftime("%Y-%m-%d %H:%M:%S %z"),
        languages=gate.detect_languages(root),
        gates=[
            gate.GateResult(
                "runner",
                "Gate runner",
                False,
                f"The quality-gate runner stopped: {message}",
                prompts=[
                    (
                        "Repair gate configuration",
                        "Repair this configuration or adapter error without disabling "
                        f"a required gate:\n\n{message}",
                    )
                ],
            )
        ],
        functions=[],
        mutations=[],
        dependency_violations=[],
        tool_setup=[],
        notes=["The run stopped before all gates could be evaluated."],
        rerun_command=command,
        mode="fast" if fast else "full",
        scope=scope,
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="repository root")
    parser.add_argument("--config", help="quality-gate JSON configuration")
    parser.add_argument("--thresholds", help="quality-threshold JSON configuration")
    output = parser.add_mutually_exclusive_group()
    output.add_argument(
        "--artifact-dir",
        help=f"report directory (default: repository {QUALITY_DIRECTORY}/ folder)",
    )
    output.add_argument(
        "--html",
        help="override the automatic HTML report path; JSON state is written beside it",
    )
    parser.add_argument(
        "--gate-script",
        help="alternate repo_quality_gate.py engine (for development)",
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
        "--max-mutants",
        type=int,
        help="diagnostic cap; capped runs can never pass",
    )
    parser.add_argument(
        "--mutation-workers",
        metavar="N|auto",
        help="run native mutation workers inside one isolated snapshot; native auto follows Stryker's CPU default, while the portable fallback uses up to 4 isolated workers",
    )
    parser.add_argument(
        "--fast",
        action="store_true",
        help="run one diagnostic pass and defer flaky-test repetitions and mutation testing; never certifies",
    )
    parser.add_argument(
        "--no-install",
        action="store_true",
        help="forbid automatic installation of missing analysis tools",
    )
    parser.add_argument(
        "--print-prompt",
        action="store_true",
        help="print the complete repair prompt after a failing run",
    )
    parser.add_argument("--version", action="version", version=VERSION)
    return parser.parse_args(argv)


def resolve_artifacts(args: argparse.Namespace, root: Path) -> tuple[Path, Path, Path]:
    default_directory = root / QUALITY_DIRECTORY
    if args.html is not None:
        html_path = resolve_from_root(
            args.html, root, default_directory / "quality-gate-report.html"
        )
        artifact_dir = html_path.parent
    else:
        artifact_dir = resolve_from_root(args.artifact_dir, root, default_directory)
        html_path = artifact_dir / "quality-gate-report.html"
    return artifact_dir, html_path, artifact_dir / "quality-gate-state.json"


def scope_cli_arguments(args: argparse.Namespace) -> list[str]:
    if args.commit:
        return ["--commit", args.commit]
    if args.local_changes:
        return ["--local-changes"]
    return []


def load_gate_safely(gate_script: Path) -> ModuleType | None:
    try:
        return load_gate(gate_script)
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        return None


def requested_scope(args: argparse.Namespace, gate: ModuleType) -> Any:
    if args.commit:
        return gate.GateScope("commit", reference=args.commit)
    if args.local_changes:
        return gate.GateScope("local_changes")
    return gate.repository_scope()


def selected_scope(args: argparse.Namespace, gate: ModuleType, root: Path) -> Any:
    if args.commit:
        return gate.commit_scope(root, args.commit)
    if args.local_changes:
        return gate.local_changes_scope(root)
    return gate.repository_scope()


def execute_analysis(
    args: argparse.Namespace,
    gate: ModuleType,
    root: Path,
    config_path: Path,
    thresholds_path: Path,
    html_path: Path,
    command: str,
) -> tuple[Any, int, str | None]:
    scope = requested_scope(args, gate)
    try:
        scope = selected_scope(args, gate, root)
        thresholds, threshold_notes = gate.load_thresholds(thresholds_path)
        config, notes = gate.load_config(
            config_path if config_path.exists() else None, thresholds
        )
        notes = [*threshold_notes, *notes]
        if args.no_install:
            config["tools"]["auto_install"] = False
        analysis = gate.run(
            root,
            config,
            html_path,
            args.max_mutants,
            notes,
            fast=args.fast,
            cli_mutation_workers=args.mutation_workers,
            scope=scope,
            thresholds=thresholds,
        )
        analysis.rerun_command = command
        return analysis, 0 if analysis.passed else 1, None
    except (OSError, ValueError, KeyError, TypeError) as error:
        message = str(error)
        analysis = error_report(gate, root, message, command, args.fast, scope)
        return analysis, 2, message


def print_run_summary(
    gate: ModuleType,
    analysis: Any,
    state: dict[str, Any],
    state_path: Path,
    html_path: Path,
    print_prompt: bool,
) -> None:
    for result in analysis.gates:
        print(f"[{gate.gate_outcome(result)}] {result.title}: {result.summary}")
    print(f"QUALITY_LOOP={state['status'].upper()}")
    print(f"STATE={state_path}")
    print(f"HTML={html_path}")
    if print_prompt and state["fix_prompt"]:
        print("\n" + state["fix_prompt"])


def run_locked(args: argparse.Namespace, root: Path) -> int:
    explicit_config = args.config is not None
    quality_directory = root / QUALITY_DIRECTORY
    config_path = resolve_from_root(
        args.config, root, quality_directory / "quality-gate.json"
    )
    explicit_thresholds = args.thresholds is not None
    thresholds_path = resolve_from_root(
        args.thresholds, root, quality_directory / "quality-thresholds.json"
    )
    explicit_artifacts = args.artifact_dir is not None
    explicit_html = args.html is not None
    artifact_dir, html_path, state_path = resolve_artifacts(args, root)
    explicit_gate_script = args.gate_script is not None
    gate_script = resolve_from_root(args.gate_script, root, DEFAULT_GATE_SCRIPT)
    scope_arguments = scope_cli_arguments(args)
    gate = load_gate_safely(gate_script)
    if gate is None:
        return 2

    if not explicit_thresholds and not thresholds_path.exists():
        thresholds_path = gate.bundled_thresholds_path()

    command = build_rerun_command(
        root,
        config_path,
        explicit_config,
        thresholds_path,
        explicit_thresholds,
        artifact_dir,
        explicit_artifacts,
        html_path,
        explicit_html,
        gate_script,
        explicit_gate_script,
        scope_arguments,
        args.no_install,
        args.fast,
        args.mutation_workers,
    )
    analysis, exit_code, run_error = execute_analysis(
        args,
        gate,
        root,
        config_path,
        thresholds_path,
        html_path,
        command,
    )

    artifact_dir.mkdir(parents=True, exist_ok=True)
    html_path.write_text(gate.html_report(analysis), encoding="utf-8")
    state = analysis_state(gate, analysis, html_path, state_path, exit_code, run_error)
    write_json_atomic(state_path, state)
    print_run_summary(
        gate,
        analysis,
        state,
        state_path,
        html_path,
        args.print_prompt,
    )
    return exit_code


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f"error: repository root does not exist: {root}", file=sys.stderr)
        return 2
    install_interrupt_handlers()
    try:
        with repository_run_lock(root):
            return run_locked(args, root)
    except ConcurrentRunError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("interrupted: quality loop stopped cleanly", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
