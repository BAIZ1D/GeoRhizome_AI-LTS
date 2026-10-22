#!/usr/bin/env python3
"""
Hardware-adaptive cross-encoder reranker server (:8001).

- Binds immediately; the model loads lazily on the first POST /rerank and is
  reused afterwards. It unloads after ``reranker.idle_unload_minutes`` of
  idleness (<= 0 disables unloading) and frees MPS/CUDA caches.
- Tier, device, precision and model are resolved by ``reranker_runtime`` from
  config/reranker_tiers.yaml, config/app_config.json, config/active_models.json
  and the RERANKER_MODEL_PREF env var.
- Scores are raw logits (activation_fn=Identity); the tier batch_size is passed
  to every predict().
- A single-slot semaphore guards inference; a request that cannot get the slot
  within ``reranker.timeout_ms`` gets HTTP 503.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from contextlib import asynccontextmanager
from typing import Any, Callable, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import psutil
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

import reranker_runtime as rr
from core.config_io import get_config_dir

REAPER_TICK_S = 30.0

# Injection hook for tests: a CrossEncoder-compatible factory (None = real CrossEncoder).
CE_FACTORY: Optional[Callable[..., Any]] = None


class Candidate(BaseModel):
    id: Optional[str] = None
    text: str
    metadata: Optional[Dict[str, Any]] = None


class RerankRequest(BaseModel):
    query: str
    candidates: List[Candidate]


def _accel_memory() -> Dict[str, Optional[float]]:
    out: Dict[str, Optional[float]] = {"mps_driver_allocated_mb": None, "cuda_allocated_mb": None}
    try:
        import torch

        mps = getattr(torch, "mps", None)
        if mps is not None and hasattr(mps, "driver_allocated_memory") and torch.backends.mps.is_available():
            out["mps_driver_allocated_mb"] = round(mps.driver_allocated_memory() / 2**20, 1)
        if torch.cuda.is_available():
            out["cuda_allocated_mb"] = round(torch.cuda.memory_allocated() / 2**20, 1)
    except Exception:  # noqa: BLE001
        pass
    return out


class Engine:
    def __init__(self) -> None:
        self.config_dir = get_config_dir()
        self.cfg: Dict[str, Any] = rr.load_reranker_config(self.config_dir)
        self.model: Any = None
        self.state = "unloaded"
        self.last_used = 0.0
        self.info: Dict[str, Any] = {}
        self.error: Optional[str] = None
        self._load_lock = threading.Lock()
        self.infer_slot = threading.Semaphore(1)

    # ---- planning (no model load)
    def _tier(self) -> Dict[str, Any]:
        tiers = rr.load_tiers(self.config_dir)
        ram, has_cuda, has_mps = rr.detect_ram_and_accel()
        return tiers[rr.resolve_tier(tiers, ram, has_cuda or has_mps)]

    def planned(self) -> Dict[str, Any]:
        try:
            tier = self._tier()
            _, has_cuda, has_mps = rr.detect_ram_and_accel()
            model, source = rr.resolve_model(dict(os.environ), rr.load_active(self.config_dir), tier.get("model"))
            device = rr.resolve_device(tier.get("device", "auto"), has_cuda, has_mps)
            precision, _ = rr.resolve_precision(tier.get("precision"), device)
            return {"model": model, "source": source, "tier": tier.get("name"), "device": device,
                    "precision": precision, "batch_size": tier.get("batch_size"),
                    "candidate_count": rr.effective_candidate_count(tier, self.cfg)}
        except Exception as e:  # noqa: BLE001
            return {"error": str(e)}

    # ---- lifecycle
    def ensure_loaded(self) -> None:
        if self.model is not None:
            return
        with self._load_lock:
            if self.model is not None:
                return
            self.state = "loading"
            try:
                self.cfg = rr.load_reranker_config(self.config_dir)
                model, info = rr.build_reranker(self.cfg, self._tier(), factory=CE_FACTORY)
            except Exception as e:  # noqa: BLE001
                self.state = "degraded"
                self.error = f"{type(e).__name__}: {e}"
                print(f"[Reranker Error] load failed: {self.error}", flush=True)
                raise
            self.model, self.info = model, info
            self.error = info.get("fallback")
            self.state = "degraded" if info.get("fallback") else "ready"
            print(f"[Reranker] {self.state}: {info}", flush=True)

    def unload(self) -> None:
        with self._load_lock:
            self.model = None
            rr._free_accel()
            self.state = "unloaded"
            print("[Reranker] model unloaded (idle)", flush=True)

    def reap_if_idle(self, now: Optional[float] = None) -> bool:
        minutes = float(self.cfg.get("idle_unload_minutes", rr.FALLBACK_IDLE_UNLOAD_MINUTES) or 0)
        if minutes <= 0 or self.model is None:
            return False
        now = time.time() if now is None else now
        if now - self.last_used <= minutes * 60:
            return False
        if not self.infer_slot.acquire(blocking=False):
            return False  # inference in progress
        try:
            if self.model is None or now - self.last_used <= minutes * 60:
                return False
            self.unload()
            return True
        finally:
            self.infer_slot.release()

    # ---- inference
    def score_and_rank(self, query: str, candidates: List[Candidate]) -> List[Dict[str, Any]]:
        pairs = [(query, c.text) for c in candidates]
        scores = rr.predict(self.model, self.info, pairs)
        results = [
            {"id": c.id, "text": c.text, "score": float(s), "metadata": c.metadata or {}}
            for c, s in zip(candidates, scores)
        ]
        results.sort(key=lambda x: x["score"], reverse=True)
        for rank, item in enumerate(results, start=1):
            item["rank"] = rank
        return results

    def health(self) -> Dict[str, Any]:
        base = self.info if self.model is not None else self.planned()
        out = {
            "status": "ok",
            "state": self.state,
            "model": base.get("model"),
            "source": base.get("source"),
            "tier": base.get("tier"),
            "device": base.get("device"),
            "precision": base.get("precision"),
            "batch_size": base.get("batch_size"),
            "candidate_count": base.get("candidate_count"),
            "max_length": self.cfg.get("max_length"),
            "idle_unload_minutes": self.cfg.get("idle_unload_minutes"),
            "selftest": self.info.get("selftest") if self.model is not None else None,
            "error": self.error,
            "rss_mb": round(psutil.Process().memory_info().rss / 2**20, 1),
        }
        out.update(_accel_memory())
        return out


engine = Engine()


def _reaper(stop: threading.Event) -> None:
    while not stop.wait(REAPER_TICK_S):
        try:
            engine.reap_if_idle()
        except Exception as e:  # noqa: BLE001
            print(f"[Reranker Warning] reaper: {e}", flush=True)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    stop = threading.Event()
    t = threading.Thread(target=_reaper, args=(stop,), name="reranker-reaper", daemon=True)
    t.start()
    try:
        yield
    finally:
        stop.set()


app = FastAPI(title="GeoRhizome Reranker Service", version="2.0.0", lifespan=lifespan)


@app.get("/health")
def health() -> Dict[str, Any]:
    return engine.health()


@app.post("/rerank")
def rerank(req: RerankRequest):
    if not req.query or not req.candidates:
        return {"results": []}
    timeout_s = float(engine.cfg.get("timeout_ms", rr.FALLBACK_TIMEOUT_MS)) / 1000.0
    if not engine.infer_slot.acquire(timeout=timeout_s):
        raise HTTPException(status_code=503, detail="reranker busy")
    try:
        try:
            engine.ensure_loaded()
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=503, detail=f"reranker load failed: {e}")
        cap = rr.effective_candidate_count(engine._tier(), engine.cfg)
        candidates = req.candidates[:cap] if cap > 0 else req.candidates
        ranked = engine.score_and_rank(req.query, candidates)
        engine.last_used = time.time()
        return {"query": req.query, "results": ranked, "count": len(ranked)}
    finally:
        engine.infer_slot.release()


if __name__ == "__main__":
    port = int(os.getenv("RERANKER_PORT", "8001"))
    print(f"Launching Local Reranker Server on port {port} (lazy model load)", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
