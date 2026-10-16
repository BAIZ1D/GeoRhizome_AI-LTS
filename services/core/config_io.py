"""Atomic, lock-guarded config file IO shared by every config writer.

All read-modify-write cycles on ``config/*.json|yaml`` must hold
``CONFIG_LOCK`` and write through ``atomic_write_*`` (temp file in the same
directory + ``os.replace``) so concurrent readers (Node, Docker mounts) never
see a truncated file and concurrent Hub writers never lose updates.
Stdlib + PyYAML only.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from typing import Any, Dict

import yaml

CONFIG_LOCK = threading.RLock()

_REPLACE_ATTEMPTS = 10
_REPLACE_BACKOFF_S = 0.05


def get_config_dir() -> str:
    """Config directory: env GEORHIZOME_CONFIG_DIR, else <repo>/config."""
    env = os.environ.get("GEORHIZOME_CONFIG_DIR")
    if env:
        return env
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "config"))


def atomic_write_text(path: str, text: str) -> None:
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-", suffix=os.path.basename(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        for i in range(_REPLACE_ATTEMPTS):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                # Windows: a reader may briefly hold the target open.
                if i == _REPLACE_ATTEMPTS - 1:
                    raise
                time.sleep(_REPLACE_BACKOFF_S)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def atomic_write_json(path: str, data: Any) -> None:
    atomic_write_text(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def atomic_write_yaml(path: str, data: Any) -> None:
    atomic_write_text(path, yaml.safe_dump(data, sort_keys=False, allow_unicode=True))


def read_json(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, dict) else {}


def read_yaml(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    return data if isinstance(data, dict) else {}
