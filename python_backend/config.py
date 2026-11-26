"""Runtime configuration and environment loader for TRAX LINK Python backend."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent


def load_dotenv(env_path: Path | None = None) -> None:
    """Populate os.environ from .env without overriding already-set variables."""
    target = env_path or (ROOT_DIR / ".env")
    if not target.is_file():
        return
    try:
        for raw_line in target.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            if not key or key in os.environ:
                continue
            val = val.strip()
            if (val.startswith('"') and val.endswith('"')) or (
                val.startswith("'") and val.endswith("'")
            ):
                val = val[1:-1]
            os.environ[key] = val
    except OSError:
        pass


def get_env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def load_firebase_web_config() -> dict[str, Any]:
    cfg_path = ROOT_DIR / "firebase-applet-config.json"
    if not cfg_path.is_file():
        return {}
    try:
        return json.loads(cfg_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
