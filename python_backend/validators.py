"""Input validation helpers for TRAX LINK Python API."""

from __future__ import annotations

import re
from typing import Any

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def is_valid_email(value: Any, max_len: int = 254) -> bool:
    return isinstance(value, str) and len(value.strip()) <= max_len and bool(EMAIL_RE.match(value.strip()))


def clean_str(value: Any, min_len: int = 0, max_len: int = 500) -> str | None:
    if not isinstance(value, str):
        return None
    s = value.strip()
    if len(s) < min_len or len(s) > max_len:
        return None
    return s


def clean_opt_str(value: Any, max_len: int = 500) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    return s[:max_len]


def clean_int(value: Any, min_val: int, max_val: int, default: int | None = None) -> int | None:
    if value is None:
        return default
    if isinstance(value, bool):
        return None
    try:
        num = int(value)
    except (TypeError, ValueError):
        return None
    if num < min_val or num > max_val:
        return None
    return num


def clean_bool(value: Any, default: bool | None = None) -> bool | None:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return None


def clean_enum(value: Any, allowed: tuple[str, ...] | set[str], default: str | None = None) -> str | None:
    if value is None:
        return default
    if not isinstance(value, str):
        return None
    val = value.strip()
    return val if val in allowed else None
