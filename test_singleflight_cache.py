from concurrent.futures import ThreadPoolExecutor
import threading

import pytest

from singleflight_cache import SingleFlightLRU


def test_same_key_computes_once_and_returned_values_are_isolated():
    cache = SingleFlightLRU(2)
    started, release = threading.Event(), threading.Event()
    calls = []
    def compute():
        calls.append(1)
        started.set()
        assert release.wait(5)
        return {"nested": [1]}
    with ThreadPoolExecutor(3) as pool:
        first = pool.submit(cache.get_or_compute, "a", compute)
        assert started.wait(5)
        second = pool.submit(cache.get_or_compute, "a", compute)
        third = pool.submit(cache.get_or_compute, "b", lambda: {"independent": True})
        assert third.result(timeout=5)[0] == {"independent": True}
        release.set()
        values = [first.result(timeout=5), second.result(timeout=5)]
    assert calls == [1]
    assert sorted(hit for _, hit in values) == [False, True]
    values[0][0]["nested"].append(2)
    assert values[1][0] == {"nested": [1]}
    assert cache.get_or_compute("a", compute)[0] == {"nested": [1]}


def test_leader_failure_reaches_all_waiters_and_retry_succeeds():
    cache = SingleFlightLRU(2)
    started, release = threading.Event(), threading.Event()
    calls = []
    def fail():
        calls.append(1)
        started.set()
        assert release.wait(5)
        raise ValueError("synthetic computation failure")
    with ThreadPoolExecutor(3) as pool:
        leader = pool.submit(cache.get_or_compute, "a", fail)
        assert started.wait(5)
        # A barrier around Future.result ensures both are waiting before release.
        pending = cache._pending["a"]
        original = pending.result
        waiter_barrier = threading.Barrier(3)
        def waited_result(*args, **kwargs):
            waiter_barrier.wait(timeout=5)
            return original(*args, **kwargs)
        pending.result = waited_result
        waiters = [pool.submit(cache.get_or_compute, "a", fail) for _ in range(2)]
        waiter_barrier.wait(timeout=5)
        release.set()
        for future in [leader, *waiters]:
            with pytest.raises(ValueError, match="synthetic"):
                future.result(timeout=5)
    assert calls == [1]
    assert cache.get_or_compute("a", lambda: {"recovered": True}) == ({"recovered": True}, False)


def test_lru_is_bounded_and_recent_hits_retain_entries():
    cache = SingleFlightLRU(2)
    cache.get_or_compute("a", lambda: 1)
    cache.get_or_compute("b", lambda: 2)
    assert cache.get_or_compute("a", lambda: 0) == (1, True)
    cache.get_or_compute("c", lambda: 3)
    assert len(cache) == 2
    assert cache.get_or_compute("b", lambda: 4) == (4, False)
