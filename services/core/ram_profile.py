"""Single RAM-tier resolver for LLM launch args and reranker candidate caps.

Stdlib + the existing config loader only (no torch). Every launcher and server
consumes ``resolve_profile`` so the n_ctx / KV / candidate values cannot drift.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.config_io import get_config_dir, read_json, read_yaml  # noqa: E402
from core.platform_compat import IS_APPLE_SILICON, IS_WINDOWS  # noqa: E402

log = logging.getLogger("ram_profile")

# Documented last-resort fallbacks (config files are the source of truth).
FALLBACK_LOW_RAM_MAX_GB = 9.0
FALLBACK_HIGH_MIN_RAM_GB = 15.0
FALLBACK_N_CTX = 16384
FALLBACK_MAX_TOKENS = 4096
FALLBACK_PROMPT_LIMIT = 12000
FALLBACK_CANDIDATES = {"low": 15, "medium": 30, "high": 30}

KV_TYPES = {"f16": "1", "q8_0": "8"}  # llama_cpp.server expects GGML type ids
N_CTX_MIN, N_CTX_MAX = 1024, 131072


def low_ram_max_gb(cfg: Optional[Dict[str, Any]]) -> float:
    try:
        return float(((cfg or {}).get("llm") or {}).get("low_ram_max_gb") or FALLBACK_LOW_RAM_MAX_GB)
    except (TypeError, ValueError):
        return FALLBACK_LOW_RAM_MAX_GB


def detect_ram_gb() -> float:
    """Total physical RAM in GiB (0.0 if undetectable)."""
    try:
        if IS_WINDOWS:
            import ctypes

            class _MEM(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            m = _MEM()
            m.dwLength = ctypes.sizeof(_MEM)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):  # type: ignore[attr-defined]
                return m.ullTotalPhys / (1024 ** 3)
            return 0.0
        if sys.platform == "darwin" or IS_APPLE_SILICON:
            out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5)
            return int(out.stdout.strip()) / (1024 ** 3)
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) / (1024 ** 2)
    except Exception as e:  # noqa: BLE001
        log.warning("RAM detection failed: %s", e)
    return 0.0


def _load_tiers(config_dir: Optional[str]) -> Dict[str, Dict[str, Any]]:
    try:
        doc = read_yaml(os.path.join(config_dir or get_config_dir(), "reranker_tiers.yaml"))
        return dict(doc.get("tiers") or {})
    except Exception as e:  # noqa: BLE001
        log.warning("reranker_tiers.yaml unavailable (%s); using documented fallbacks", e)
        return {}


def load_app_config(config_dir: Optional[str] = None) -> Dict[str, Any]:
    return read_json(os.path.join(config_dir or get_config_dir(), "app_config.json"))


def resolve_profile(
    ram_gb: float, has_accel: bool, cfg: Optional[Dict[str, Any]], config_dir: Optional[str] = None
) -> Dict[str, Any]:
    """Resolve the RAM tier and its LLM/reranker parameters from config."""
    cfg = cfg or {}
    llm = cfg.get("llm") or {}
    tiers = _load_tiers(config_dir)
    high_min = float((tiers.get("high") or {}).get("min_ram_gb", FALLBACK_HIGH_MIN_RAM_GB))

    if ram_gb < low_ram_max_gb(cfg):
        tier = "low"
    elif ram_gb >= high_min and has_accel:
        tier = "high"
    else:
        tier = "medium"

    # Explicit tier candidate_count wins; wide_candidate_count is never an input here.
    cc = (tiers.get(tier) or {}).get("candidate_count")
    candidate_count = int(cc) if cc else FALLBACK_CANDIDATES[tier]

    if tier == "low":
        lp = llm.get("low_ram_profile") or {}
        n_ctx = lp.get("n_ctx", 8192)
        kv = lp.get("kv_cache_type", "q8_0")
        flash = lp.get("flash_attn", True)
        max_tokens = lp.get("max_tokens", 2048)
        prompt_limit = lp.get("prompt_limit", 5600)
    else:
        n_ctx = llm.get("n_ctx", FALLBACK_N_CTX)
        kv = llm.get("kv_cache_type")
        flash = llm.get("flash_attn", False)
        max_tokens = llm.get("max_tokens", FALLBACK_MAX_TOKENS)
        prompt_limit = llm.get("prompt_limit", FALLBACK_PROMPT_LIMIT)

    return {
        "tier": tier,
        "reranker_tier": tier,
        "ram_gb": float(ram_gb),
        "n_ctx": int(n_ctx),
        "kv_cache_type": kv,
        "flash_attn": bool(flash),
        "max_tokens": int(max_tokens),
        "prompt_limit": int(prompt_limit),
        "candidate_count": candidate_count,
    }


def llm_cli_args(profile: Dict[str, Any], degrade: bool = False) -> List[str]:
    """argv fragment for llama_cpp.server. Validated; never shell-interpolated."""
    n_ctx = profile.get("n_ctx")
    if isinstance(n_ctx, bool) or not isinstance(n_ctx, int) or not (N_CTX_MIN <= n_ctx <= N_CTX_MAX):
        raise ValueError(f"n_ctx out of range {N_CTX_MIN}..{N_CTX_MAX}: {n_ctx!r}")
    kv = profile.get("kv_cache_type")
    if kv is not None and kv not in KV_TYPES:
        raise ValueError(f"kv_cache_type {kv!r} not in {sorted(KV_TYPES)}")
    args: List[str] = ["--n_ctx", str(n_ctx)]
    if degrade:
        return args
    flash = bool(profile.get("flash_attn"))
    if kv is not None:
        args += ["--type_k", KV_TYPES[kv]]
        if flash:
            args += ["--type_v", KV_TYPES[kv]]
    if flash:
        args += ["--flash_attn", "True"]
    return args


def _main(argv: List[str]) -> int:
    cfg = load_app_config()
    ram = detect_ram_gb()
    accel = IS_APPLE_SILICON
    profile = resolve_profile(ram, accel, cfg)
    if "--args" in argv:
        print(" ".join(llm_cli_args(profile, degrade="--degrade" in argv)))
    else:
        print(json.dumps(profile))
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
