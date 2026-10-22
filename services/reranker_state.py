"""Single locked, atomic writer of reranker state across the three config files.

Files kept consistent:
  - active_models.json   reranker.{model_id, name, port, enabled}  (no pid here)
  - retrieval.yaml       retrieval.{reranker_enabled, reranker_model}
  - app_config.json      reranker.{enabled, model_name}

The legacy "Offloaded" sentinel is never written; disabling keeps the last real
model name and sets enabled=false.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

from core.config_io import CONFIG_LOCK, atomic_write_json, atomic_write_yaml, read_json, read_yaml
from reranker_runtime import FALLBACK_MODEL, LEGACY_SENTINEL

ACTIVE = "active_models.json"
ACTIVE_DEFAULT = "active_models.default.json"
RETRIEVAL = "retrieval.yaml"
APP = "app_config.json"
TIERS = "reranker_tiers.yaml"
FALLBACK_RERANKER_PORT = 8001


def _real(v: Any) -> Optional[str]:
    return v if isinstance(v, str) and v and v != LEGACY_SENTINEL else None


def _tier_default(config_dir: str) -> str:
    return _real(read_yaml(os.path.join(config_dir, TIERS)).get("model")) or FALLBACK_MODEL


def _default_port(config_dir: str) -> int:
    d = read_json(os.path.join(config_dir, ACTIVE_DEFAULT))
    return int((d.get("reranker") or {}).get("port") or FALLBACK_RERANKER_PORT)


def seed_active_models(config_dir: str) -> Dict[str, Any]:
    """Load active_models.json, creating it from the tracked defaults if missing.
    Persisted ``alive`` flags are stripped (liveness is computed, never stored)."""
    with CONFIG_LOCK:
        p = os.path.join(config_dir, ACTIVE)
        if not os.path.exists(p):
            st = read_json(os.path.join(config_dir, ACTIVE_DEFAULT))
            atomic_write_json(p, st)
        else:
            st = read_json(p)
        dirty = False
        for info in st.values():
            if isinstance(info, dict) and "alive" in info:
                info.pop("alive")
                dirty = True
        if dirty:
            atomic_write_json(p, st)
        return st


def sync_reranker_state(config_dir: str, enabled: bool, model_id: Optional[str] = "") -> str:
    """Write reranker enabled/model to all three files atomically under CONFIG_LOCK.
    Returns the model name written."""
    with CONFIG_LOCK:
        ap = os.path.join(config_dir, ACTIVE)
        rp = os.path.join(config_dir, RETRIEVAL)
        cp = os.path.join(config_dir, APP)
        active = read_json(ap)
        ret = read_yaml(rp)
        app = read_json(cp)

        rr = dict(active.get("reranker") or {})
        rsec = ret.setdefault("retrieval", {})
        csec = app.setdefault("reranker", {})

        name = (
            _real(model_id)
            or _real(csec.get("model_name"))
            or _real(rsec.get("reranker_model"))
            or _real(rr.get("model_id"))
            or _tier_default(config_dir)
        )
        enabled = bool(enabled)

        rr["model_id"] = name
        rr["name"] = name
        rr.setdefault("port", _default_port(config_dir))
        rr["enabled"] = enabled
        # Any previous pid refers to a process being replaced or stopped; the Hub
        # records the new pid after Popen.
        rr.pop("alive", None)
        rr.pop("pid", None)
        rr.pop("start_time", None)
        active["reranker"] = rr

        rsec["reranker_enabled"] = enabled
        rsec["reranker_model"] = name
        csec["enabled"] = enabled
        csec["model_name"] = name

        atomic_write_json(ap, active)
        atomic_write_yaml(rp, ret)
        atomic_write_json(cp, app)
        return name


def write_effective_candidate_count(config_dir: str, count: int) -> None:
    """Write reranker.effective_candidate_count (separate key; wide_candidate_count untouched)."""
    with CONFIG_LOCK:
        cp = os.path.join(config_dir, APP)
        app = read_json(cp)
        csec = app.setdefault("reranker", {})
        if csec.get("effective_candidate_count") == int(count):
            return
        csec["effective_candidate_count"] = int(count)
        atomic_write_json(cp, app)


def migrate_legacy_sentinel(config_dir: str) -> bool:
    """Replace a legacy reranker "Offloaded" sentinel in any of the three files
    with the default model and enabled=false. Returns True if anything changed."""
    with CONFIG_LOCK:
        active = read_json(os.path.join(config_dir, ACTIVE))
        ret = read_yaml(os.path.join(config_dir, RETRIEVAL))
        app = read_json(os.path.join(config_dir, APP))
        found = (
            (active.get("reranker") or {}).get("model_id") == LEGACY_SENTINEL
            or (active.get("reranker") or {}).get("name") == LEGACY_SENTINEL
            or (ret.get("retrieval") or {}).get("reranker_model") == LEGACY_SENTINEL
            or (app.get("reranker") or {}).get("model_name") == LEGACY_SENTINEL
        )
        if not found:
            return False
        default = _tier_default(config_dir)
        # Clear sentinels first so sync falls through to the default model.
        if (active.get("reranker") or {}).get("model_id") == LEGACY_SENTINEL or (active.get("reranker") or {}).get("name") == LEGACY_SENTINEL:
            active["reranker"]["model_id"] = default
            active["reranker"]["name"] = default
            atomic_write_json(os.path.join(config_dir, ACTIVE), active)
        sync_reranker_state(config_dir, False, default)
        return True
