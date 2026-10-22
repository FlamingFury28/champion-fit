"""Canceled static downloads must not be reported as server failures."""

from http.client import IncompleteRead
from http.server import ThreadingHTTPServer
from threading import Event
import json
import sys

import pytest

import app
from test_web_server import isolated_server, request


@pytest.mark.parametrize("error_type,reported", [
    (BrokenPipeError, False),
    (ConnectionResetError, False),
    (ConnectionAbortedError, False),
    (RuntimeError, True),
])
def test_static_download_disconnect_is_contained_and_next_request_works(
    isolated_server, monkeypatch, error_type, reported,
):
    failures = []
    finished = Event()
    process_request = ThreadingHTTPServer.process_request_thread

    def track_request(server, connection, address):
        try:
            process_request(server, connection, address)
        finally:
            finished.set()

    def record_error(server, connection, address):
        failures.append(sys.exc_info()[0])

    def interrupted_copy(handler, source, output):
        raise error_type("interrupted fixture transfer")

    monkeypatch.setattr(ThreadingHTTPServer, "process_request_thread", track_request)
    monkeypatch.setattr(ThreadingHTTPServer, "handle_error", record_error)
    monkeypatch.setattr(app.DashboardHandler, "copyfile", interrupted_copy)

    with pytest.raises(IncompleteRead):
        request(isolated_server, "GET", "/assets/app-a1b2c3.js")
    assert finished.wait(2), "the interrupted HTTP request did not finish"
    assert failures == ([error_type] if reported else [])

    # A HEAD request does not use copyfile and must still complete normally.
    status, _, body = request(isolated_server, "HEAD", "/app/overview")
    assert status == 200
    assert body == b""


@pytest.mark.parametrize("error_type", [BrokenPipeError, ConnectionResetError, ConnectionAbortedError])
@pytest.mark.parametrize("response_status", [None, 200])
def test_api_disconnects_close_without_error_logs_or_replacement_responses(
    caplog, error_type, response_status,
):
    class Handler:
        path = "/api/accounts?account=private-account"
        command = "GET"
        close_connection = False

        def __init__(self):
            self.error_responses = []

        def _send_json_error(self, status, message):
            self.error_responses.append(status)
            self._response_status = int(status)

    def interrupted_response(handler):
        handler._response_status = response_status
        raise error_type("private transport error")

    handler = Handler()
    app.api_operation(interrupted_response)(handler)

    assert handler.close_connection
    assert handler.error_responses == []
    events = [json.loads(record.message) for record in caplog.records]
    assert not any(event["event"] == "backend_error" for event in events)
    metrics = events[-1]["metrics"]
    assert metrics["client_disconnect"] == 1
    if response_status is None:
        assert "http_status" not in metrics
    else:
        assert metrics["http_status"] == response_status
    assert events[-1]["outcome"] != "failed"
    assert "private" not in caplog.text


@pytest.mark.parametrize("response_status", [None, 200])
def test_real_api_errors_remain_logged_before_and_after_headers(caplog, response_status):
    class Handler:
        path = "/api/accounts"
        command = "GET"
        close_connection = False

        def __init__(self):
            self.error_responses = []

        def _send_json_error(self, status, message):
            self.error_responses.append(status)
            self._response_status = int(status)

    def failed_response(handler):
        handler._response_status = response_status
        raise RuntimeError("private server failure")

    handler = Handler()
    app.api_operation(failed_response)(handler)

    assert handler.close_connection
    assert handler.error_responses == ([500] if response_status is None else [])
    events = [json.loads(record.message) for record in caplog.records]
    failures = [event for event in events if event["event"] == "backend_error"]
    assert [event["exception_type"] for event in failures] == ["RuntimeError"]
    assert "client_disconnect" not in events[-1]["metrics"]
    assert events[-1]["metrics"]["http_status"] == (response_status or 500)
    assert "private" not in caplog.text


@pytest.mark.parametrize("transport_error,disconnect", [
    (BrokenPipeError, True),
    (ConnectionResetError, True),
    (ConnectionAbortedError, True),
    (OSError, False),
])
def test_disconnected_error_response_keeps_original_failure_without_duplicate_transport_error(
    caplog, transport_error, disconnect,
):
    class Handler:
        path = "/api/accounts"
        command = "GET"
        close_connection = False

        def _send_json_error(self, status, message):
            self._response_status = int(status)
            raise transport_error("private transport failure")

    def failed_response(_handler):
        raise RuntimeError("private server failure")

    handler = Handler()
    app.api_operation(failed_response)(handler)

    assert handler.close_connection
    events = [json.loads(record.message) for record in caplog.records]
    failures = [event for event in events if event["event"] == "backend_error"]
    assert [event["exception_type"] for event in failures] == (
        ["RuntimeError"] if disconnect else ["RuntimeError", "OSError"]
    )
    assert events[-1]["metrics"].get("client_disconnect", 0) == int(disconnect)
    assert events[-1]["metrics"]["http_status"] == 500
    assert events[-1]["outcome"] == "failed"
    assert "private" not in caplog.text
