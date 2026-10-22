"""Request-local timings and redacted structured backend diagnostics."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
import json
import logging
import math
from pathlib import Path
from time import perf_counter
import traceback
from uuid import uuid4


LOGGER = logging.getLogger("champion_fit.backend")
LOGGER.setLevel(logging.INFO)
_METRICS: ContextVar[dict | None] = ContextVar("backend_metrics", default=None)
_SAFE_LABELS = {"request_id", "method", "endpoint", "run_id", "mode"}


def configure_logging():
    logging.basicConfig(level=logging.INFO, format="%(message)s")


def record_metric(name: str, value: float = 1):
    metrics = _METRICS.get()
    if metrics is not None and math.isfinite(value):
        metrics[name] = metrics.get(name, 0) + value


@contextmanager
def measure(stage: str):
    if _METRICS.get() is None:
        yield
        return
    started = perf_counter()
    try:
        yield
    finally:
        record_metric(f"{stage}_ms", (perf_counter() - started) * 1000)
        record_metric(f"{stage}_calls")


@contextmanager
def metrics_scope(operation: str, **labels):
    metrics = {}
    token = _METRICS.set(metrics)
    started = perf_counter()
    outcome = "completed"
    try:
        yield metrics
    except BaseException:
        outcome = "failed"
        raise
    finally:
        _METRICS.reset(token)
        if metrics.get("http_status", 0) >= 500:
            outcome = "failed"
        payload = {
            "event": "backend_metrics", "operation": operation,
            "request_id": labels.get("request_id") or uuid4().hex,
            **{key: value for key, value in labels.items() if key in _SAFE_LABELS and value is not None},
            "outcome": outcome,
            "duration_ms": round((perf_counter() - started) * 1000, 3),
            "metrics": {key: round(value, 3) for key, value in metrics.items()},
        }
        LOGGER.info(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


def log_failure(error: Exception, **labels):
    """Record driver codes and stack locations without SQL, IDs, DSNs or secrets."""
    frames = traceback.extract_tb(error.__traceback__)[-12:]
    payload = {
        "event": "backend_error", "exception_type": type(error).__name__,
        "sqlstate": getattr(error, "sqlstate", None),
        "sqlite_errorcode": getattr(error, "sqlite_errorcode", None),
        **{key: value for key, value in labels.items() if key in _SAFE_LABELS},
        "stack": [{"file": Path(frame.filename).name, "line": frame.lineno,
                   "function": frame.name} for frame in frames],
    }
    LOGGER.error(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
