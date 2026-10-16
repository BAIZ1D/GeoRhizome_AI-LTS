"""Reranker runtime resolvers: tier, device, precision, model, builder, fp16 self-test.

Pure helpers used by ``local_reranker_server.py`` (and the measurement spike).
torch / sentence_transformers are imported lazily so resolvers stay cheap.
"""

from __future__ import annotations

import gc
import json
import logging
import os
import time
import unicodedata
from typing import Any, Callable, Dict, List, Optional, Tuple

from core.config_io import get_config_dir, read_json, read_yaml

log = logging.getLogger("reranker_runtime")

# Documented last-resort fallbacks only (config files are the source of truth).
FALLBACK_MODEL = "cl-nagoya/ruri-v3-reranker-310m"
FALLBACK_MAX_LENGTH = 1024
FALLBACK_SELFTEST_MIN_SPEARMAN = 0.99
FALLBACK_TIMEOUT_MS = 3000
FALLBACK_IDLE_UNLOAD_MINUTES = 15

LEGACY_SENTINEL = "Offloaded"
_VALID_DEVICES = ("auto", "cpu", "cuda", "mps")
SELFTEST_PAIRS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reranker_selftest_pairs.json")

_DETECT_CACHE: Optional[Tuple[float, bool, bool]] = None
_fake_elapsed: float = 0.0  # test hook


# ---------------------------------------------------------------- config
def load_tiers_doc(config_dir: Optional[str] = None) -> Dict[str, Any]:
    return read_yaml(os.path.join(config_dir or get_config_dir(), "reranker_tiers.yaml"))


def load_tiers(config_dir: Optional[str] = None) -> Dict[str, Dict[str, Any]]:
    doc = load_tiers_doc(config_dir)
    tiers = doc.get("tiers") or {}
    default_model = doc.get("model")
    out: Dict[str, Dict[str, Any]] = {}
    for name, t in tiers.items():
        t = dict(t or {})
        t.setdefault("model", default_model)
        t["name"] = name
        out[name] = t
    return out


def load_reranker_config(config_dir: Optional[str] = None) -> Dict[str, Any]:
    app = read_json(os.path.join(config_dir or get_config_dir(), "app_config.json"))
    r = dict(app.get("reranker") or {})
    r.setdefault("max_length", FALLBACK_MAX_LENGTH)
    r.setdefault("idle_unload_minutes", FALLBACK_IDLE_UNLOAD_MINUTES)
    r.setdefault("timeout_ms", FALLBACK_TIMEOUT_MS)
    r.setdefault("activation", "identity")
    r.setdefault("selftest_min_spearman", FALLBACK_SELFTEST_MIN_SPEARMAN)
    return r


def load_active(config_dir: Optional[str] = None) -> Dict[str, Any]:
    return read_json(os.path.join(config_dir or get_config_dir(), "active_models.json"))


def load_selftest_pairs(path: str = SELFTEST_PAIRS_PATH) -> List[Tuple[str, str]]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return [
        (unicodedata.normalize("NFKC", p["query"]), unicodedata.normalize("NFKC", p["passage"]))
        for p in data["pairs"]
    ]


# ---------------------------------------------------------------- resolvers
def resolve_tier(tiers: Dict[str, Dict[str, Any]], ram_gb: float, has_accel: bool) -> str:
    """Highest tier whose min_ram_gb <= ram_gb and whose accelerator need is met."""
    order = sorted(tiers.items(), key=lambda kv: float(kv[1].get("min_ram_gb", 0)), reverse=True)
    for name, t in order:
        if ram_gb >= float(t.get("min_ram_gb", 0)) and (has_accel or not t.get("requires_accelerator")):
            return name
    return order[-1][0]


def detect_ram_and_accel() -> Tuple[float, bool, bool]:
    """(ram_gb, has_cuda, has_mps). hwfit detect_system first, psutil fallback. Cached."""
    global _DETECT_CACHE
    if _DETECT_CACHE is not None:
        return _DETECT_CACHE
    import torch

    has_cuda = bool(torch.cuda.is_available())
    has_mps = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())
    ram_gb = 0.0
    try:
        from hwfit.hardware import detect_system

        ram_gb = float(detect_system().get("total_ram_gb") or 0.0)
    except Exception as e:  # noqa: BLE001
        log.warning("detect_system failed (%s); using psutil", e)
    if ram_gb <= 0:
        import psutil

        ram_gb = psutil.virtual_memory().total / (1024 ** 3)
    _DETECT_CACHE = (ram_gb, has_cuda, has_mps)
    return _DETECT_CACHE


def resolve_device(yaml_device: str, has_cuda: bool, has_mps: bool) -> str:
    """cuda > mps > cpu. A detected accelerator is never overridden by YAML."""
    yd = (yaml_device or "auto").lower()
    if yd not in _VALID_DEVICES:
        raise ValueError(f"unknown reranker device {yaml_device!r}")
    if has_cuda:
        dev = "cuda"
    elif has_mps:
        dev = "mps"
    else:
        dev = "cpu"
    if yd != "auto" and yd != dev:
        log.info("tier device %r ignored: detected %s", yd, dev)
    return dev


def resolve_precision(tier_precision: Optional[str], device: str) -> Tuple[str, Optional[str]]:
    p = (tier_precision or "fp32").lower()
    if p not in ("fp16", "fp32"):
        # bf16 and unknown values are never used: downgrade to fp32
        p = "fp32"
    if device == "cpu" and p != "fp32":
        return "fp32", f"tier precision {p} overridden to fp32 on cpu"
    return p, None


def resolve_model(env: Dict[str, str], active: Dict[str, Any], tier_model: Optional[str]) -> Tuple[str, str]:
    if env.get("RERANKER_MODEL_PREF"):
        return env["RERANKER_MODEL_PREF"], "env"
    mid = (active.get("reranker") or {}).get("model_id")
    if mid and mid != LEGACY_SENTINEL:
        return mid, "active"
    return tier_model or FALLBACK_MODEL, "tier"


# ---------------------------------------------------------------- self-test
def _elapsed(t0: float) -> float:
    return time.perf_counter() - t0


def _timed_impl(model: Any, pairs: List[Tuple[str, str]], bs: int):
    import numpy as np

    model.predict([list(p) for p in pairs[:2]], batch_size=bs, show_progress_bar=False)  # warm-up
    t0 = time.perf_counter()
    s = model.predict([list(p) for p in pairs], batch_size=bs, show_progress_bar=False)
    return np.asarray(s, dtype=np.float64), _elapsed(t0)


_timed = _timed_impl


def mps_fp16_self_test(model: Any, pairs: List[Tuple[str, str]], batch_size: int, min_rho: float):
    """Score with fp32, convert in place to fp16, rescore. Pass = finite, rho>=min, faster."""
    import numpy as np
    from scipy.stats import spearmanr

    ref, t32 = _timed(model, pairs, batch_size)
    model.half()
    s16, t16 = _timed(model, pairs, batch_size)
    finite = bool(np.isfinite(s16).all())
    rho = float(spearmanr(ref, s16).statistic) if finite else float("nan")
    ok = bool(finite and rho >= min_rho and t16 < t32)
    return ok, {"rho": rho, "t32_s": t32, "t16_s": t16, "finite": finite, "min_rho": min_rho}


# ---------------------------------------------------------------- builder
def _free_accel() -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def _param_dtype(model: Any):
    return next(model.model.parameters()).dtype


def _load(factory: Callable[..., Any], name: str, device: str, dtype: Any, max_len: int) -> Any:
    import torch

    m = factory(
        name,
        device=device,
        max_length=max_len,
        model_kwargs={"dtype": dtype},
        activation_fn=torch.nn.Identity(),
    )
    got = _param_dtype(m)
    if got != dtype:
        raise RuntimeError(f"dtype override not applied: expected {dtype}, got {got}")
    return m


def _default_factory():
    from sentence_transformers import CrossEncoder

    return CrossEncoder


def build_reranker(
    cfg: Dict[str, Any],
    tier: Dict[str, Any],
    factory: Optional[Callable[..., Any]] = None,
    accel: Optional[Tuple[bool, bool]] = None,
    env: Optional[Dict[str, str]] = None,
    active: Optional[Dict[str, Any]] = None,
    pairs: Optional[List[Tuple[str, str]]] = None,
) -> Tuple[Any, Dict[str, Any]]:
    """Load the reranker per resolved device/precision. Returns (model, info)."""
    import torch

    factory = factory or _default_factory()
    if accel is None:
        _, has_cuda, has_mps = detect_ram_and_accel()
    else:
        has_cuda, has_mps = accel
    env = dict(os.environ) if env is None else env
    active = load_active() if active is None else active

    model_id, source = resolve_model(env, active, tier.get("model"))
    device = resolve_device(tier.get("device", "auto"), has_cuda, has_mps)
    precision, msg = resolve_precision(tier.get("precision"), device)
    if msg:
        log.info("[Reranker] %s", msg)
    max_len = int(cfg.get("max_length") or FALLBACK_MAX_LENGTH)
    bs = int(tier.get("batch_size") or 8)
    min_rho = float(cfg.get("selftest_min_spearman", FALLBACK_SELFTEST_MIN_SPEARMAN))
    info: Dict[str, Any] = {
        "model": model_id, "source": source, "tier": tier.get("name"), "device": device,
        "precision": precision, "batch_size": bs, "max_length": max_len,
        "fallback": None, "selftest": None,
    }

    try:
        if device == "mps" and precision == "fp16":
            m = _load(factory, model_id, device, torch.float32, max_len)
            ok, metrics = mps_fp16_self_test(m, pairs or load_selftest_pairs(), bs, min_rho)
            info["selftest"] = {"ok": ok, **metrics}
            log.info("[Reranker] mps fp16 self-test %s: %s", "PASS" if ok else "FAIL", metrics)
            if ok:
                if _param_dtype(m) != torch.float16:
                    raise RuntimeError(f"fp16 conversion not applied: {_param_dtype(m)}")
            else:
                del m
                _free_accel()
                precision = "fp32"
                m = _load(factory, model_id, device, torch.float32, max_len)
        else:
            dt = torch.float16 if precision == "fp16" else torch.float32
            m = _load(factory, model_id, device, dt, max_len)
    except Exception as e:  # noqa: BLE001
        dtype_error = isinstance(e, RuntimeError) and ("dtype" in str(e) or "conversion" in str(e))
        if dtype_error or device == "cpu":
            raise
        log.warning("[Reranker] load on %s failed (%s); falling back to cpu fp32", device, e)
        _free_accel()
        info["fallback"] = f"{device} load failed: {e}"
        device, precision = "cpu", "fp32"
        m = _load(factory, model_id, "cpu", torch.float32, max_len)

    info["device"], info["precision"] = device, precision
    log.info("[Reranker] loaded %s", info)
    return m, info


def predict(model: Any, info: Dict[str, Any], pairs: List[Tuple[str, str]]):
    return model.predict([list(p) for p in pairs], batch_size=int(info["batch_size"]), show_progress_bar=False)
