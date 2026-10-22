"""The local quality command must run real checks and fail without hiding gaps."""
from __future__ import annotations

import subprocess
import sys
from unittest.mock import Mock

import pytest

from scripts import verify_project as verify


def test_default_plan_checks_backend_and_frontend_without_building_twice(tmp_path):
    checks = verify.make_checks(tmp_path, "all", None, "npm", "node")
    assert checks[0].command == (sys.executable, "-m", "pytest", "-q")
    assert checks[0].cwd == tmp_path
    assert [check.command[2] for check in checks if check.command[:2] == ("npm", "run")] == [
        "lint", "test:unit", "build",
    ]
    browser_types = next(check for check in checks if "tsconfig.e2e.json" in check.command)
    assert browser_types.command[:2] == ("node", "node_modules/typescript/bin/tsc")
    assert all(check.cwd == tmp_path / "frontend" for check in checks[1:])


@pytest.mark.parametrize("mode,tail", [("smoke", ("--", "--grep", "@smoke")), ("full", ())])
def test_browser_plan_reuses_building_script_and_never_invokes_download_fallback(tmp_path, mode, tail):
    checks = verify.make_checks(tmp_path, "frontend", mode, "npm", "node")
    assert checks[-1].command == ("npm", "run", "test:e2e") + tail
    assert all("build" not in check.command and "npx" not in check.command for check in checks)
    assert all("pytest" not in check.command for check in checks)


def test_failed_check_stops_pipeline_and_reports_incomplete_verification(tmp_path, monkeypatch, capsys):
    run = Mock(return_value=subprocess.CompletedProcess([], 17))
    monkeypatch.setattr(verify.subprocess, "run", run)
    checks = verify.make_checks(tmp_path, "all", None, "npm", "node")
    assert verify.run_checks(checks, {}) == 1
    assert run.call_count == 1
    assert run.call_args.kwargs["cwd"] == tmp_path
    output = capsys.readouterr()
    assert "command exit 17" in output.err
    assert "remaining checks were not run" in output.err
    assert "PASS: all" not in output.out


def test_setup_failure_is_distinct_from_failed_tests(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(verify.subprocess, "run", Mock(side_effect=FileNotFoundError("missing executable")))
    assert verify.run_checks(verify.make_checks(tmp_path, "backend", None, "npm", "node"), {}) == 2
    assert "SETUP ERROR: Backend tests" in capsys.readouterr().err


def test_success_runs_every_check_in_order_and_preserves_environment(tmp_path, monkeypatch, capsys):
    run = Mock(return_value=subprocess.CompletedProcess([], 0))
    monkeypatch.setattr(verify.subprocess, "run", run)
    checks = verify.make_checks(tmp_path, "all", None, "npm", "node")
    environment = {"PATH": "runtime-bin", "CHAMPION_FIT_TEST_POSTGRES_DSN": "test-only-dsn"}
    assert verify.run_checks(checks, environment) == 0
    assert [call.args[0] for call in run.call_args_list] == [check.command for check in checks]
    assert all(call.kwargs["env"] is environment for call in run.call_args_list)
    output = capsys.readouterr().out
    assert "PASS: all 5 checks" in output
    assert "test-only-dsn" not in output


def test_dry_run_never_probes_dependencies_or_runs_subprocesses(monkeypatch, capsys):
    probe = Mock(side_effect=AssertionError("dry run must not check dependencies"))
    monkeypatch.setattr(verify, "prerequisites", probe)
    monkeypatch.setattr(verify.subprocess, "run", probe)
    assert verify.main(["--dry-run", "--smoke"]) == 0
    output = capsys.readouterr().out
    assert "test:e2e -- --grep @smoke" in output
    assert "Plan only" in output
    probe.assert_not_called()


def test_backend_only_needs_neither_node_nor_frontend_dependencies(tmp_path, monkeypatch):
    monkeypatch.setattr(verify.importlib.util, "find_spec", Mock(return_value=object()))
    run = Mock(side_effect=AssertionError("backend-only must not probe node"))
    monkeypatch.setattr(verify.subprocess, "run", run)
    assert verify.prerequisites(tmp_path, "backend", None, None, None, {"PATH": ""}) == []
    run.assert_not_called()


def test_preflight_failure_does_not_start_any_checks(monkeypatch, capsys):
    monkeypatch.setattr(verify, "prerequisites", Mock(return_value=["pytest is missing"]))
    run = Mock()
    monkeypatch.setattr(verify, "run_checks", run)
    assert verify.main([]) == 2
    run.assert_not_called()
    assert "SETUP ERROR: pytest is missing" in capsys.readouterr().err


@pytest.mark.parametrize("version,too_old", [("v23.11.1", True), ("v24.0.0", False), ("v25.2.0", False)])
def test_node_version_gate_reads_the_package_requirement(tmp_path, monkeypatch, version, too_old):
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "package.json").write_text('{"engines":{"node":">=24.0.0"}}', encoding="utf-8")
    monkeypatch.setattr(verify.subprocess, "run", Mock(return_value=subprocess.CompletedProcess([], 0, version, "")))
    problems = verify.prerequisites(tmp_path, "frontend", None, "npm", "node", {"PATH": ""})
    assert any("is too old" in problem for problem in problems) is too_old
    assert any("dependencies are missing/incomplete" in problem for problem in problems)


def test_browser_checks_cannot_accidentally_target_an_external_application(tmp_path, monkeypatch):
    monkeypatch.setattr(verify.importlib.util, "find_spec", Mock(return_value=object()))
    environment = {"PATH": "", "CHAMPION_FIT_E2E_EXTERNAL_SERVER": "1", "CHAMPION_FIT_E2E_BASE_URL": "https://example.test"}
    problems = verify.prerequisites(tmp_path, "frontend", "smoke", None, None, environment)
    assert any("fresh disposable fixture server" in problem for problem in problems)


def test_incompatible_scope_is_rejected_before_running_checks(monkeypatch):
    run = Mock()
    monkeypatch.setattr(verify, "run_checks", run)
    with pytest.raises(SystemExit) as failure:
        verify.main(["--scope", "backend", "--e2e"])
    assert failure.value.code == 2
    run.assert_not_called()


def test_pytest_default_discovery_excludes_generated_scripts(tmp_path):
    # Exercise discovery itself: a generated script with import-time side effects
    # must never be collected just because its filename ends in _test.py.
    config = (verify.ROOT / "pytest.ini").read_text(encoding="utf-8")
    (tmp_path / "pytest.ini").write_text(config, encoding="utf-8")
    (tmp_path / "test_real.py").write_text("def test_real():\n    assert True\n", encoding="utf-8")
    for directory in ("outputs", "data", ".backups", "frontend", "node_modules"):
        generated = tmp_path / directory
        generated.mkdir()
        (generated / "generated_test.py").write_text("raise AssertionError('generated script was collected')\n", encoding="utf-8")
    result = subprocess.run((sys.executable, "-m", "pytest", "-q"), cwd=tmp_path,
                            capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "1 passed" in result.stdout
