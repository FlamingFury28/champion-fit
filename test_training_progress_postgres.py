"""Concurrent PostgreSQL plan starts keep the same durable, immutable choice."""
from contextlib import closing
from threading import Barrier, Lock
from uuid import uuid4

import pytest

import training_progress
from test_postgres_api import postgres_api_fixture  # noqa: F401
from test_postgres_mutations import postgres_http, race_requests  # noqa: F401


@pytest.mark.parametrize("second_budget", [20, 21], ids=["same-choice", "different-choice"])
def test_concurrent_postgres_plan_start_returns_saved_choice(postgres_http, monkeypatch, second_budget):
    request, storage = postgres_http
    plan_id = str(uuid4())
    bodies = []
    for budget in (20, second_budget):
        status, preview = request("GET", f"/api/training-plan?budget={budget}&role=MIDDLE&queue=420&days=all")
        assert status == 200, preview
        bodies.append({"id": plan_id, "fingerprint": preview["plan_fingerprint"],
                       "params": {"budget": [str(budget)], "role": ["MIDDLE"],
                                  "queue": ["420"], "days": ["all"]}})

    original_load = training_progress.load_plan
    both_read = Barrier(2)
    lock = Lock()
    initial_reads = 0

    def read_before_either_writer(connection, requested_id):
        nonlocal initial_reads
        saved = original_load(connection, requested_id)
        with lock:
            pause = requested_id == plan_id and saved is None and initial_reads < 2
            if pause:
                initial_reads += 1
        if pause:
            # Both serializable transactions see the UUID as absent. The loser
            # must retry from a fresh snapshot, not fail or overwrite the winner.
            both_read.wait(timeout=10)
        return saved

    monkeypatch.setattr(training_progress, "load_plan", read_before_either_writer)
    responses = race_requests(request, "POST", "/api/training-progress", bodies)
    assert sorted(result[0] for _, result in responses) == ([200, 200] if second_budget == 20 else [200, 409])
    winner, (_, acknowledged) = next((body, result) for body, result in responses if result[0] == 200)
    assert acknowledged["fingerprint"] == winner["fingerprint"]
    assert acknowledged["planned"] == int(winner["params"]["budget"][0])
    assert acknowledged["completed"] == 0
    if second_budget == 20:
        assert responses[0][1][1] == responses[1][1][1]
    status, loaded = request("GET", f"/api/training-progress?id={plan_id}")
    assert status == 200 and loaded == acknowledged
    assert request("POST", "/api/training-progress", winner) == (200, acknowledged)
    with closing(storage.connect()) as connection:
        assert connection.execute("SELECT COUNT(*) AS n FROM training_plan_runs WHERE id=?", (plan_id,)).fetchone()["n"] == 1
        snapshot = original_load(connection, plan_id)
        assert snapshot["fingerprint"] == winner["fingerprint"]
