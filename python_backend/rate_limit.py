"""Thread-safe in-memory sliding-window rate limiter."""

from __future__ import annotations

import threading
import time


class RateLimiter:
    def __init__(self, window_seconds: int = 60, max_requests: int = 30):
        self.window_seconds = window_seconds
        self.max_requests = max_requests
        self._lock = threading.Lock()
        self._buckets: dict[str, list[float]] = {}

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        cutoff = now - self.window_seconds
        with self._lock:
            entries = [ts for ts in self._buckets.get(key, []) if ts > cutoff]
            if len(entries) >= self.max_requests:
                self._buckets[key] = entries
                return False
            entries.append(now)
            self._buckets[key] = entries
            if len(self._buckets) > 2000:
                stale = [k for k, v in self._buckets.items() if not v or v[-1] <= cutoff]
                for k in stale:
                    del self._buckets[k]
            return True
