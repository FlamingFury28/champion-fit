#!/usr/bin/env python3
"""Probe frontend BuildKit caching without modifying the working checkout.

Run manually with Docker Desktop available:
    python scripts/verify_docker_cache.py

The probe snapshots tracked and untracked, nonignored Git files into a temporary
directory. It builds only the frontend stage, changes copied tests, then changes
copied production CSS. Plain BuildKit logs and a JSON report stay under outputs/.
BuildKit uses cache-only output: no image is exported, loaded, or tagged. The
probe never starts containers, connects to a database, or prunes builder cache.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path, PureWindowsPath


_BUILD_STEP = re.compile(r"^#(\d+) \[[^\]]+\] RUN npm run build\s*$", re.MULTILINE)


def frontend_build_state(log: str) -> str:
    """Require one finished build instruction; never infer hits from other steps."""
    steps = _BUILD_STEP.findall(log)
    if len(steps) != 1:
        raise ValueError(f"expected one frontend RUN npm run build instruction, found {len(steps)}")
    step_id = steps[0]
    if re.search(rf"^#{step_id} CACHED\s*$", log, re.MULTILINE):
        return "cached"
    if re.search(rf"^#{step_id} DONE(?:\s+[\d.]+s)?\s*$", log, re.MULTILINE):
        return "executed"
    raise ValueError("frontend build instruction has no successful completion")


def snapshot_context(root: Path, destination: Path) -> int:
    """Copy current file contents, including dirty work, without generated data."""
    root = root.resolve(strict=True)
    destination = destination.resolve(strict=True)
    if root == destination or destination.is_relative_to(root) or root.is_relative_to(destination):
        raise ValueError("snapshot directory must be separate from the source checkout")
    result = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=root, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    copied = 0
    for relative in dict.fromkeys(os.fsdecode(item) for item in result.stdout.split(b"\0") if item):
        relative_path = Path(relative)
        windows_path = PureWindowsPath(relative)
        if (relative_path.anchor or windows_path.anchor
                or ".." in relative_path.parts or ".." in windows_path.parts):
            raise ValueError(f"refusing nonrelative or traversing Git path: {relative}")
        source = root / relative
        target = destination / relative
        if not target.resolve().is_relative_to(destination):
            raise ValueError(f"snapshot target escapes its temporary directory: {relative}")
        if not source.exists():
            continue  # A tracked file deleted in the working tree stays deleted.
        if source.is_symlink() or not source.resolve().is_relative_to(root):
            raise ValueError(f"refusing linked file outside the copied checkout: {relative}")
        if not source.is_file():
            raise ValueError(f"expected a regular Git file: {relative}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied += 1
    for required in ("Dockerfile", ".dockerignore", "frontend/package-lock.json", "frontend/src/styles.css"):
        if not (destination / required).is_file():
            raise ValueError(f"snapshot is missing required build input: {required}")
    return copied


def run_build(context: Path, log_path: Path) -> dict:
    started = time.monotonic()
    with log_path.open("w", encoding="utf-8") as log:
        result = subprocess.run(
            ["docker", "build", "--target", "frontend-build", "--progress=plain", "--output=type=cacheonly", str(context)],
            stdout=log, stderr=subprocess.STDOUT, text=True, timeout=900,
        )
    if result.returncode:
        raise RuntimeError(f"Docker build failed; inspect {log_path}")
    build_log = log_path.read_text(encoding="utf-8")
    if "exporting to image" in build_log:
        raise RuntimeError("cache-only probe unexpectedly exported an image")
    return {"build": frontend_build_state(build_log),
            "duration_seconds": round(time.monotonic() - started, 2), "log": str(log_path)}


def verify_cache(root: Path, output: Path) -> dict:
    root = root.resolve(strict=True)
    output.mkdir(parents=True, exist_ok=False)
    probe_id = uuid.uuid4().hex
    report = {"output_mode": "cacheonly", "image_exported": False,
              "source": str(root), "phases": {}, "result": "failed"}
    context = None
    try:
        with tempfile.TemporaryDirectory(prefix="champion-fit-cache-probe-") as temporary:
            context = Path(temporary)
            report["copied_files"] = snapshot_context(root, context)
            print("Building temporary frontend baseline", flush=True)
            report["phases"]["baseline"] = run_build(context, output / "baseline.log")

            # These are existing copied files, not a synthetic extension that
            # could accidentally miss the repository's real test exclusions.
            unit = next(iter(sorted(context.glob("frontend/src/**/*.test.tsx"))), None)
            browser = next(iter(sorted(context.glob("frontend/e2e/*.spec.ts"))), None)
            if unit is None or browser is None:
                raise ValueError("probe requires existing unit and browser test files")
            for test_file in (unit, browser):
                with test_file.open("a", encoding="utf-8") as handle:
                    handle.write(f"\n// Disposable cache probe {probe_id}\n")
            report["test_inputs"] = [str(path.relative_to(context)) for path in (unit, browser)]
            print("Checking cache after copied test-only changes", flush=True)
            report["phases"]["tests_only"] = run_build(context, output / "tests-only.log")
            if report["phases"]["tests_only"]["build"] != "cached":
                raise AssertionError("test-only changes reran the frontend production build")

            with (context / "frontend/src/styles.css").open("a", encoding="utf-8") as handle:
                handle.write(f"\n/* Disposable production cache probe {probe_id} */\n")
            print("Checking invalidation after copied production CSS change", flush=True)
            report["phases"]["production_source"] = run_build(context, output / "production-source.log")
            if report["phases"]["production_source"]["build"] != "executed":
                raise AssertionError("production CSS changes failed to rerun the frontend build")
            report["result"] = "passed"
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        # TemporaryDirectory owns the only disposable filesystem state. Docker
        # retains ordinary BuildKit cache; no images or services were created.
        report["temporary_context_removed"] = context is None or not context.exists()
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, sort_keys=True), flush=True)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, help="new directory for plain build logs and JSON report")
    args = parser.parse_args()
    if not shutil.which("docker"):
        parser.error("Docker CLI is required")
    output = args.output or args.root / "outputs" / f"docker-cache-probe-{uuid.uuid4().hex[:12]}"
    verify_cache(args.root, output.resolve())


if __name__ == "__main__":
    main()
