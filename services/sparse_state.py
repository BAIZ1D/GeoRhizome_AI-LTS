"""Single locked, atomic writer of sparse (SPLADE) state.

Files kept consistent:
  - active_models.json   sparse.{model_id, name, port, enabled}  (no pid/alive here)
  - app_config.json      sparse.{enabled, model_name}

The legacy "Offloaded" sentinel is never written; disabling keeps the last real
model name and sets enabled=false.

``sparse.max_input_chars`` in app_config.json is the only limit key sparse code
reads. It is seeded once from text_splitter.chunk_size; after seeding it is an
independent value: neither the Model Hub nor sync_sparse_state auto-sync it
with text_splitter.chunk_size.

Only the configured sparse.model_name is accepted as a model id (no arbitrary
repo ids).
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

from core.config_io import CONFIG_LOCK, atomic_write_json, read_json

ACTIVE = "active_models.json"
ACTIVE_DEFAULT = "active_models.default.json"
APP = "app_config.json"
SENTINEL = "Offloaded"

_REQUIRED = (
    "model_name",
    "revision",
    "base_url",
    "port",
    "batch_size",
    "max_length",
    "max_input_chars",
    "max_inputs_per_request",
    "idle_unload_minutes",
    "timeout_ms",
    "cold_timeout_ms",
    "device",
    "precision",
)


def _real(v: Any) -> Optional[str]:
    return v if isinstance(v, str) and v and v != SENTINEL else None


def get_sparse_settings(config_dir: str) -> Dict[str, Any]:
    """Return the app_config sparse block; raise naming any missing key."""
    block = read_json(os.path.join(config_dir, APP)).get("sparse")
    if not isinstance(block, dict):
        raise KeyError("app_config.json: missing 'sparse' block")
    for k in _REQUIRED:
        if block.get(k) in (None, ""):
            raise KeyError(f"app_config.json: sparse.{k} is missing")
    return dict(block)


def seed_sparse_entry(config_dir: str) -> Dict[str, Any]:
    """Ensure active_models.json has a ``sparse`` entry (from the tracked defaults),
    without pid/alive. Returns the sparse entry."""
    with CONFIG_LOCK:
        ap = os.path.join(config_dir, ACTIVE)
        if os.path.exists(ap):
            active = read_json(ap)
        else:
            active = read_json(os.path.join(config_dir, ACTIVE_DEFAULT))
            atomic_write_json(ap, active)
        entry = active.get("sparse")
        dirty = False
        if not isinstance(entry, dict):
            default = read_json(os.path.join(config_dir, ACTIVE_DEFAULT)).get("sparse")
            if not isinstance(default, dict):
                raise KeyError("active_models.default.json: missing 'sparse' entry")
            entry = dict(default)
            dirty = True
        for k in ("pid", "alive", "start_time"):
            if k in entry:
                entry.pop(k)
                dirty = True
        if dirty:
            active["sparse"] = entry
            atomic_write_json(ap, active)
        return entry


def sync_sparse_state(config_dir: str, enabled: bool, model_id: Optional[str] = "") -> str:
    """Write sparse enabled/model to active_models.json and app_config.json
    atomically under CONFIG_LOCK. Returns the model name written.

    ``model_id`` must equal the configured sparse.model_name (ValueError
    otherwise); empty or the legacy sentinel means "keep the configured name"."""
    with CONFIG_LOCK:
        cp = os.path.join(config_dir, APP)
        app = read_json(cp)
        csec = app.get("sparse")
        if not isinstance(csec, dict) or not _real(csec.get("model_name")):
            raise KeyError("app_config.json: sparse.model_name is missing")
        configured = csec["model_name"]
        requested = _real(model_id)
        if requested is not None and requested != configured:
            raise ValueError(f"unsupported sparse model id: {requested!r}")

        seed_sparse_entry(config_dir)
        ap = os.path.join(config_dir, ACTIVE)
        active = read_json(ap)
        entry = dict(active.get("sparse") or {})
        enabled = bool(enabled)
        entry["model_id"] = configured
        entry["name"] = configured
        if entry.get("port") is None:
            entry["port"] = csec.get("port")
        entry["enabled"] = enabled
        for k in ("alive", "pid", "start_time"):
            entry.pop(k, None)
        active["sparse"] = entry

        csec["enabled"] = enabled
        csec["model_name"] = configured

        atomic_write_json(ap, active)
        atomic_write_json(cp, app)
        return configured
