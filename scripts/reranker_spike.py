#!/usr/bin/env python3
"""Reranker measurement spike: fp16/fp32 parity and speed, p95 latency, logit
ranges and memory. Prints one JSON document to stdout.

Usage: HF_HUB_OFFLINE=1 python scripts/reranker_spike.py [--runs 20] [--cpu-runs 20]
Runs in-process (never starts the :8001 server). Model id comes from
config/reranker_tiers.yaml.
"""

from __future__ import annotations

import argparse
import gc
import json
import math
import os
import sys
import time
import unicodedata
from typing import Any, Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(REPO, "services"))

import numpy as np  # noqa: E402
import psutil  # noqa: E402
import torch  # noqa: E402
from scipy.stats import spearmanr  # noqa: E402

import reranker_runtime as rr  # noqa: E402

TARGET_CHARS = 1024
N_CANDIDATES = 30


def _mem() -> Dict[str, Optional[float]]:
    out: Dict[str, Optional[float]] = {"rss_mb": psutil.Process().memory_info().rss / 2**20}
    mps = getattr(torch, "mps", None)
    out["mps_driver_allocated_mb"] = (
        mps.driver_allocated_memory() / 2**20 if mps is not None and hasattr(mps, "driver_allocated_memory") and torch.backends.mps.is_available() else None
    )
    out["mps_current_allocated_mb"] = (
        mps.current_allocated_memory() / 2**20 if mps is not None and hasattr(mps, "current_allocated_memory") and torch.backends.mps.is_available() else None
    )
    return out


def _free() -> None:
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    if torch.backends.mps.is_available():
        torch.mps.empty_cache()


def _labelled_pairs() -> List[Dict[str, Any]]:
    with open(rr.SELFTEST_PAIRS_PATH, encoding="utf-8") as f:
        return json.load(f)["pairs"]


def _long_candidates(fixture: List[Dict[str, Any]]) -> Tuple[str, List[str]]:
    passages = [unicodedata.normalize("NFKC", p["passage"]) for p in fixture]
    query = unicodedata.normalize("NFKC", fixture[0]["query"])
    cands = []
    for i in range(N_CANDIDATES):
        s = ""
        j = i
        while len(s) < TARGET_CHARS:
            s += passages[j % len(passages)]
            j += 1
        cands.append(s[:TARGET_CHARS])
    return query, cands


def _parity_pairs(fixture: List[Dict[str, Any]]) -> List[Tuple[str, str]]:
    queries = [unicodedata.normalize("NFKC", p["query"]) for p in fixture]
    _, cands = _long_candidates(fixture)
    return [(queries[i % len(queries)], cands[i]) for i in range(N_CANDIDATES)]


def _run(model: Any, pairs: List[Tuple[str, str]], bs: int) -> Tuple[np.ndarray, float]:
    t0 = time.perf_counter()
    s = model.predict([list(p) for p in pairs], batch_size=bs, show_progress_bar=False)
    return np.asarray(s, dtype=np.float64), time.perf_counter() - t0  # numpy => device synced


def _latency(model: Any, pairs: List[Tuple[str, str]], bs: int, runs: int) -> Dict[str, float]:
    for _ in range(2):
        _run(model, pairs, bs)
    ts = [_run(model, pairs, bs)[1] * 1000 for _ in range(runs)]
    return {
        "runs": runs,
        "batch_size": bs,
        "p50_ms": float(np.percentile(ts, 50)),
        "p95_ms": float(np.percentile(ts, 95)),
        "max_ms": float(max(ts)),
    }


def _median_time(model: Any, pairs, bs: int) -> Tuple[np.ndarray, float]:
    res = [_run(model, pairs, bs) for _ in range(3)]
    return res[-1][0], float(np.median([r[1] for r in res]))


def _logits(model: Any, fixture: List[Dict[str, Any]], bs: int) -> Dict[str, Any]:
    pairs = [(unicodedata.normalize("NFKC", p["query"]), unicodedata.normalize("NFKC", p["passage"])) for p in fixture]
    s, _ = _run(model, pairs, bs)
    rel = [float(x) for x, p in zip(s, fixture) if p["relevant"]]
    irr = [float(x) for x, p in zip(s, fixture) if not p["relevant"]]
    rmin, imax = min(rel), max(irr)
    if rmin > imax:
        suggestion = math.floor((imax + (rmin - imax) / 2) * 10) / 10
        basis = "midpoint between highest irrelevant and lowest relevant logit"
    else:
        suggestion = math.floor((rmin - 1.0) * 10) / 10
        basis = "classes overlap; 1.0 below lowest relevant logit"
    return {
        "relevant": {"min": rmin, "max": max(rel), "mean": float(np.mean(rel)), "values": rel},
        "irrelevant": {"min": min(irr), "max": imax, "mean": float(np.mean(irr)), "values": irr},
        "suggested_min_reranker_score": suggestion,
        "suggestion_basis": basis + " (SUGGESTION, raw logits)",
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=20)
    ap.add_argument("--cpu-runs", type=int, default=20)
    ap.add_argument("--skip-cpu", action="store_true")
    args = ap.parse_args()

    from sentence_transformers import CrossEncoder

    tiers = rr.load_tiers()
    model_id = rr.load_tiers_doc().get("model") or rr.FALLBACK_MODEL
    cfg = rr.load_reranker_config()
    max_len = int(cfg.get("max_length") or rr.FALLBACK_MAX_LENGTH)
    ram, has_cuda, has_mps = rr.detect_ram_and_accel()
    tier_name = rr.resolve_tier(tiers, ram, has_cuda or has_mps)
    tier = tiers[tier_name]
    fixture = _labelled_pairs()
    query, cands = _long_candidates(fixture)
    rerank_pairs = [(query, c) for c in cands]
    parity_pairs = _parity_pairs(fixture)

    import sentence_transformers
    import transformers
    import huggingface_hub

    out: Dict[str, Any] = {
        "versions": {
            "python": sys.version.split()[0], "torch": torch.__version__, "transformers": transformers.__version__,
            "sentence_transformers": sentence_transformers.__version__, "huggingface_hub": huggingface_hub.__version__,
        },
        "hardware": {"ram_gb": ram, "cuda": has_cuda, "mps": has_mps, "tier": tier_name},
        "model": model_id, "max_length": max_len,
        "candidates": {"n": N_CANDIDATES, "chars_each": TARGET_CHARS},
        "memory": {"before_load": _mem()},
    }

    accel = "cuda" if has_cuda else ("mps" if has_mps else None)
    if accel:
        bs = int(tier.get("batch_size") or 8)
        t0 = time.perf_counter()
        m = rr._load(CrossEncoder, model_id, accel, torch.float32, max_len)
        cold = time.perf_counter() - t0
        out["memory"][f"{accel}_after_load_fp32"] = _mem()
        lat32 = _latency(m, rerank_pairs, bs, args.runs)
        ref, t32 = _median_time(m, parity_pairs, bs)
        log32 = _logits(m, fixture, bs)
        m.half()
        assert next(m.model.parameters()).dtype == torch.float16
        lat16 = _latency(m, rerank_pairs, bs, args.runs)
        s16, t16 = _median_time(m, parity_pairs, bs)
        log16 = _logits(m, fixture, bs)
        finite = bool(np.isfinite(s16).all())
        rho = float(spearmanr(ref, s16).statistic) if finite else float("nan")
        min_rho = float(cfg.get("selftest_min_spearman", rr.FALLBACK_SELFTEST_MIN_SPEARMAN))
        fp16_ok = finite and rho >= min_rho and t16 < t32
        out["memory"][f"{accel}_after_half"] = _mem()
        out[accel] = {
            "cold_load_fp32_s": cold,
            "parity": {"spearman": rho, "finite": finite, "max_abs_diff": float(np.max(np.abs(ref - s16))) if finite else None,
                       "fp32_median_s": t32, "fp16_median_s": t16, "min_rho": min_rho, "selftest_pass": fp16_ok},
            "latency_fp32": lat32, "latency_fp16": lat16,
            "logits_fp32": log32, "logits_fp16": log16,
            "chosen_precision": "fp16" if fp16_ok else "fp32",
        }
        del m
        _free()
        time.sleep(1)
        out["memory"][f"{accel}_after_unload"] = _mem()

    if not args.skip_cpu:
        t0 = time.perf_counter()
        m = rr._load(CrossEncoder, model_id, "cpu", torch.float32, max_len)
        cold = time.perf_counter() - t0
        out["memory"]["cpu_after_load_fp32"] = _mem()
        cpu: Dict[str, Any] = {"cold_load_fp32_s": cold, "latency": {}}
        for name in ("low", "medium"):
            bs = int(tiers[name].get("batch_size") or 8)
            if str(bs) not in cpu["latency"]:
                cpu["latency"][str(bs)] = _latency(m, rerank_pairs, bs, args.cpu_runs)
        cpu["logits_fp32"] = _logits(m, fixture, int(tiers["low"].get("batch_size") or 4))
        out["cpu"] = cpu
        del m
        _free()
        out["memory"]["cpu_after_unload"] = _mem()

    # Recommendations
    rec: Dict[str, Any] = {}
    if accel:
        a = out[accel]
        lat = a["latency_fp16"] if a["chosen_precision"] == "fp16" else a["latency_fp32"]
        p95 = lat["p95_ms"]
        rec["timeout_device"] = accel
        rec["logits_source"] = f"{accel} {a['chosen_precision']}"
        logits = a["logits_fp16"] if a["chosen_precision"] == "fp16" else a["logits_fp32"]
    else:
        p95 = out["cpu"]["latency"][str(int(tier.get("batch_size") or 8))]["p95_ms"]
        rec["timeout_device"] = "cpu"
        logits = out["cpu"]["logits_fp32"]
        rec["logits_source"] = "cpu fp32"
    rec["p95_ms"] = p95
    rec["timeout_ms"] = int(math.ceil(p95 * 1.5 / 100.0) * 100)
    rec["timeout_formula"] = "ceil(p95_ms * 1.5 / 100) * 100"
    rec["min_reranker_score"] = logits["suggested_min_reranker_score"]
    rec["relevant_min"] = logits["relevant"]["min"]
    rec["irrelevant_max"] = logits["irrelevant"]["max"]
    out["recommendation"] = rec
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
