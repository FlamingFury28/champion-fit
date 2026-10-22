#!/usr/bin/env python3
"""Run the project's local quality checks with the current Python interpreter.

    python scripts/verify_project.py
    python scripts/verify_project.py --scope frontend --smoke
    python scripts/verify_project.py --e2e
    python scripts/verify_project.py --dry-run

Dependencies must already be installed. No packages or browsers are downloaded.
The frontend build includes its application type check; browser tests also get
their own type check. Optional E2E checks use Playwright's disposable fixture
server and build once, through the existing test:e2e package script.
PostgreSQL tests remain opt-in through CHAMPION_FIT_TEST_POSTGRES_DSN and
CHAMPION_FIT_E2E_POSTGRES_DSN. This command never initiates a Riot sync.

Exit codes: 0 success; 1 a check failed; 2 setup/arguments need attention;
130 interrupted. Checks stop at the first failure, preserving its console output.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Check:
    name: str
    command: tuple[str, ...]
    cwd: Path


def make_checks(root: Path, scope: str, e2e: str | None, npm: str, node: str) -> list[Check]:
    """Use package scripts and local CLIs, never npx's download fallback."""
    checks = []
    if scope in ("all", "backend"):
        checks.append(Check("Backend tests", (sys.executable, "-m", "pytest", "-q"), root))
    if scope in ("all", "frontend"):
        frontend = root / "frontend"
        checks.extend([
            Check("Frontend lint", (npm, "run", "lint"), frontend),
            Check("Browser test types", (node, "node_modules/typescript/bin/tsc", "--noEmit",
                                         "--project", "tsconfig.e2e.json"), frontend),
            Check("Frontend unit tests", (npm, "run", "test:unit"), frontend),
        ])
        if e2e:
            command = (npm, "run", "test:e2e")
            if e2e == "smoke":
                command += ("--", "--grep", "@smoke")
            checks.append(Check(f"Frontend build + browser tests ({e2e})", command, frontend))
        else:
            checks.append(Check("Frontend types + production build", (npm, "run", "build"), frontend))
    return checks


def child_environment() -> dict[str, str]:
    environment = dict(os.environ)
    # Playwright's fixture command is `python e2e/seed_and_serve.py`. Prefer the
    # same interpreter/virtual environment used to invoke this runner.
    environment["PATH"] = str(Path(sys.executable).parent) + os.pathsep + environment.get("PATH", "")
    return environment


def prerequisites(root: Path, scope: str, e2e: str | None, npm: str | None,
                  node: str | None, environment: dict[str, str]) -> list[str]:
    problems = []
    if scope in ("all", "backend") and importlib.util.find_spec("pytest") is None:
        problems.append("pytest is missing from this Python environment. Install requirements.txt and pytest first.")
    if scope == "backend":
        return problems
    if not npm:
        problems.append("npm is not on PATH. Install the Node.js version required by frontend/package.json.")
    if not node:
        problems.append("Node.js is not on PATH. Install the version required by frontend/package.json.")
    else:
        try:
            package = json.loads((root / "frontend/package.json").read_text(encoding="utf-8"))
            requirement = package.get("engines", {}).get("node", "")
            minimum = re.fullmatch(r">=(\d+)\.(\d+)\.(\d+)", requirement)
            result = subprocess.run((node, "--version"), env=environment, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False)
            actual = re.match(r"v(\d+)\.(\d+)\.(\d+)", result.stdout.strip())
            if result.returncode or not actual:
                problems.append("Node.js could not report its version. Check the Node.js installation.")
            elif minimum and tuple(map(int, actual.groups())) < tuple(map(int, minimum.groups())):
                problems.append(f"Node.js {result.stdout.strip()} is too old; frontend/package.json requires {requirement}.")
        except (OSError, ValueError, subprocess.TimeoutExpired) as error:
            problems.append(f"Cannot check frontend prerequisites: {error}")
    required = ["eslint/bin/eslint.js", "typescript/bin/tsc", "vitest/vitest.mjs", "vite/bin/vite.js"]
    if e2e:
        required.append("@playwright/test/cli.js")
    if any(not (root / "frontend/node_modules" / path).is_file() for path in required):
        problems.append("Frontend dependencies are missing/incomplete. Run npm ci in frontend first.")
    if e2e:
        if not shutil.which("python", path=environment["PATH"]):
            problems.append("The Playwright fixture requires python on PATH. Activate your Python environment first.")
        if environment.get("CHAMPION_FIT_E2E_EXTERNAL_SERVER") == "1" or environment.get("CHAMPION_FIT_E2E_BASE_URL"):
            problems.append("Unset CHAMPION_FIT_E2E_EXTERNAL_SERVER and CHAMPION_FIT_E2E_BASE_URL: "
                            "verification starts a fresh disposable fixture server.")
    return problems


def display_command(command: tuple[str, ...]) -> str:
    return subprocess.list2cmdline(command) if os.name == "nt" else shlex.join(command)


def run_checks(checks: list[Check], environment: dict[str, str], dry_run: bool = False) -> int:
    started = time.monotonic()
    for index, check in enumerate(checks, start=1):
        print(f"\n[{index}/{len(checks)}] {check.name}\n  cwd: {check.cwd}\n  {display_command(check.command)}", flush=True)
        if dry_run:
            continue
        phase_started = time.monotonic()
        try:
            result = subprocess.run(check.command, cwd=check.cwd, env=environment, check=False)
        except OSError as error:
            print(f"SETUP ERROR: {check.name}: {error}", file=sys.stderr, flush=True)
            return 2
        if result.returncode:
            print(f"FAILED: {check.name} (command exit {result.returncode}). "
                  f"{index - 1}/{len(checks)} checks passed; remaining checks were not run.",
                  file=sys.stderr, flush=True)
            return 1
        print(f"PASS: {check.name} ({time.monotonic() - phase_started:.1f}s)", flush=True)
    if dry_run:
        print("\nPlan only: no checks or prerequisite probes were executed.", flush=True)
    else:
        print(f"\nPASS: all {len(checks)} checks completed in {time.monotonic() - started:.1f}s.", flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--scope", choices=("all", "backend", "frontend"), default="all",
                        help="checks to run (default: all)")
    browser = parser.add_mutually_exclusive_group()
    browser.add_argument("--e2e", action="store_true", help="also run all Playwright browser tests")
    browser.add_argument("--smoke", action="store_true", help="also run Playwright tests tagged @smoke")
    parser.add_argument("--dry-run", action="store_true", help="show commands without running checks or requiring dependencies")
    args = parser.parse_args(argv)
    e2e = "smoke" if args.smoke else "full" if args.e2e else None
    if e2e and args.scope == "backend":
        parser.error("--e2e/--smoke require --scope all or frontend")
    environment = child_environment()
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm", path=environment["PATH"])
    node = shutil.which("node", path=environment["PATH"])
    checks = make_checks(ROOT, args.scope, e2e, npm or "npm", node or "node")
    if not args.dry_run:
        problems = prerequisites(ROOT, args.scope, e2e, npm, node, environment)
        if problems:
            for problem in problems:
                print(f"SETUP ERROR: {problem}", file=sys.stderr, flush=True)
            return 2
    print(f"Champion Fit verification: {args.scope}" + (f", E2E {e2e}" if e2e else ""), flush=True)
    if args.scope in ("all", "backend") and not environment.get("CHAMPION_FIT_TEST_POSTGRES_DSN"):
        print("PostgreSQL integration tests require CHAMPION_FIT_TEST_POSTGRES_DSN; they may be skipped.", flush=True)
    return run_checks(checks, environment, args.dry_run)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nVerification interrupted.", file=sys.stderr, flush=True)
        raise SystemExit(130)
