"""Bounded process-local cache that shares concurrent work, never failures."""
from collections import OrderedDict
from concurrent.futures import Future
from copy import deepcopy
import threading


class SingleFlightLRU:
    def __init__(self, capacity: int):
        if type(capacity) is not int or capacity < 1:
            raise ValueError("capacity must be a positive integer")
        self.capacity = capacity
        self._values = OrderedDict()
        self._pending = {}
        self._lock = threading.RLock()

    def get_or_compute(self, key, compute):
        with self._lock:
            if key in self._values:
                self._values.move_to_end(key)
                return deepcopy(self._values[key]), True
            pending = self._pending.get(key)
            leader = pending is None
            if leader:
                pending = Future()
                self._pending[key] = pending
        if not leader:
            return deepcopy(pending.result()), True
        try:
            result = deepcopy(compute())
        except BaseException as error:
            with self._lock:
                self._pending.pop(key, None)
                pending.set_exception(error)
            raise
        with self._lock:
            self._values[key] = result
            self._values.move_to_end(key)
            while len(self._values) > self.capacity:
                self._values.popitem(last=False)
            self._pending.pop(key, None)
            pending.set_result(result)
        return deepcopy(result), False

    def clear(self):
        """Clear completed values; active computations retain their waiters."""
        with self._lock:
            self._values.clear()

    def __len__(self):
        with self._lock:
            return len(self._values)
