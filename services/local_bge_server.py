#!/usr/bin/env python3
"""
Local embedding server (:8000).

- Binds immediately; the SentenceTransformer loads lazily on the first
  POST /v1/embeddings and unloads after ``embedding.idle_unload_seconds`` idle
  (<= 0 disables unloading), freeing MPS/CUDA caches.
- torch / sentence_transformers are imported lazily (never at module import).
- Handlers are plain ``def`` (threadpool) so GET /health stays responsive.
- Single-slot semaphore guards inference; batch size and chunk cap bound memory.
"""

from __future__ import annotations

import gc
import json
import os
import sys
import threading
import time
from contextlib import asynccontextmanager
from typing import Any, Callable, Dict, List, Optional, Union

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from core.config_io import get_config_dir

REAPER_TICK_S = 30.0
FALLBACK_MODEL = "cl-nagoya/ruri-v3-310m"
FALLBACK_IDLE_UNLOAD_SECONDS = 300
FALLBACK_PARITY_MIN_COSINE = 0.999

# Short Japanese + ASCII probes for the fp16-vs-fp32 cosine parity self-test.
PARITY_PROBES: List[str] = [
    "吾輩は猫である。名前はまだ無い。",
    "検索拡張生成では、埋め込みモデルの精度が重要です。",
    "The quick brown fox jumps over the lazy dog.",
    "Retrieval-augmented generation relies on dense embeddings.",
    "2024年度の売上高は前年比12.5%増加しました。",
    "東京都千代田区丸の内1-9-1",
]

# Injection hook for tests: SentenceTransformer-compatible factory (None = real).
ST_FACTORY: Optional[Callable[..., Any]] = None


def _read_json(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def load_settings(config_dir: str) -> Dict[str, Any]:
    """Resolve embedder settings from config files + env, with fallbacks."""
    cfg = _read_json(os.path.join(config_dir, "app_config.json"))
    emb = cfg.get("embedding", {}) or {}
    ts = cfg.get("text_splitter", {}) or {}
    model = emb.get("model_name", FALLBACK_MODEL)
    active = (_read_json(os.path.join(config_dir, "active_models.json")).get("embedding") or {}).get("model_id")
    if active and active != "Offloaded":
        model = active
    model = os.getenv("EMBEDDING_MODEL_PREF", model)
    return {
        "model": model,
        "chunk_size": int(os.getenv("EMBEDDING_MAX_CHUNK_LENGTH", ts.get("chunk_size", 1024))),
        "batch_size": int(os.getenv("EMBEDDING_BATCH_SIZE", emb.get("max_concurrent_chunks", 2))),
        "idle_unload_seconds": float(emb.get("idle_unload_seconds", FALLBACK_IDLE_UNLOAD_SECONDS) or 0),
        "mps_fp16": bool(emb.get("mps_fp16", True)),
        "parity_min_cosine": float(emb.get("parity_min_cosine", FALLBACK_PARITY_MIN_COSINE)),
    }


class EmbeddingRequest(BaseModel):
    input: Union[str, List[str]]
    model: Optional[str] = None


def _free_memory() -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def _resolve_device() -> str:
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:  # noqa: BLE001
        pass
    return "cpu"


def _rss_mb() -> Optional[float]:
    try:
        import psutil

        return round(psutil.Process().memory_info().rss / 2**20, 1)
    except Exception:  # noqa: BLE001
        return None


class Engine:
    def __init__(self) -> None:
        self.config_dir = get_config_dir()
        self.cfg: Dict[str, Any] = load_settings(self.config_dir)
        self.model: Any = None
        self.state = "unloaded"
        self.last_used = 0.0
        self.device: Optional[str] = None
        self.precision: Optional[str] = None
        self.selftest: Optional[Dict[str, Any]] = None
        self.error: Optional[str] = None
        self._load_lock = threading.Lock()
        self.infer_slot = threading.Semaphore(1)

    def _new_model(self, device: str) -> Any:
        factory = ST_FACTORY
        if factory is None:
            from sentence_transformers import SentenceTransformer as factory  # lazy
        return factory(self.cfg["model"], device=device)

    # ---- lifecycle
    def ensure_loaded(self) -> None:
        if self.model is not None:
            return
        with self._load_lock:
            if self.model is not None:
                return
            self.state = "loading"
            try:
                self.cfg = load_settings(self.config_dir)
                device = _resolve_device()
                print(f"[Embedder] loading {self.cfg['model']} on {device}...", flush=True)
                model = self._new_model(device)
                self.device, self.precision, self.selftest = device, "fp32", None
                model = self._select_precision(model, device)
            except Exception as e:  # noqa: BLE001
                self.state = "degraded"
                self.error = f"{type(e).__name__}: {e}"
                print(f"[Embedder Error] load failed: {self.error}", flush=True)
                raise
            self.model = model
            self.error = None
            self.state = "ready"
            print(f"[Embedder] ready on {self.device} ({self.precision})", flush=True)

    def _select_precision(self, model: Any, device: str) -> Any:
        """MPS fp16 only if per-text cosine vs fp32 >= parity_min_cosine and all finite."""
        if device != "mps":
            print(f"[Embedder] precision fp32 ({device}: fp16 not attempted)", flush=True)
            return model
        if not self.cfg.get("mps_fp16", True):
            print("[Embedder] precision fp32 (embedding.mps_fp16 disabled)", flush=True)
            return model
        import numpy as np

        min_cos = float(self.cfg.get("parity_min_cosine", FALLBACK_PARITY_MIN_COSINE))
        t0 = time.time()
        bs = self.cfg["batch_size"]
        ref = np.asarray(model.encode(PARITY_PROBES, batch_size=bs, normalize_embeddings=True), dtype=np.float64)
        model.half()
        half = np.asarray(model.encode(PARITY_PROBES, batch_size=bs, normalize_embeddings=True), dtype=np.float64)
        finite = bool(np.isfinite(half).all())
        if finite:
            num = (ref * half).sum(axis=1)
            den = np.linalg.norm(ref, axis=1) * np.linalg.norm(half, axis=1)
            min_seen = float((num / np.where(den == 0, 1.0, den)).min())
        else:
            min_seen = float("nan")
        elapsed = round(time.time() - t0, 3)
        ok = finite and min_seen >= min_cos
        self.selftest = {"verdict": "fp16" if ok else "fp32-fallback", "min_cosine": min_seen,
                         "threshold": min_cos, "finite": finite, "seconds": elapsed}
        if ok:
            self.precision = "fp16"
            print(f"[Embedder] fp16 accepted: min_cosine={min_seen:.6f} >= {min_cos} ({elapsed}s)", flush=True)
            return model
        reason = "non-finite output" if not finite else f"min_cosine={min_seen:.6f} < {min_cos}"
        print(f"[Embedder] fp16 rejected ({reason}); reloading fresh fp32 model", flush=True)
        del model, ref, half
        _free_memory()
        return self._new_model(device)  # fresh fp32 weights from disk, never .float() on halved

    def unload(self) -> None:
        with self._load_lock:
            self.model = None
            _free_memory()
            self.state = "unloaded"
            print("[Embedder] model unloaded (idle)", flush=True)

    def reap_if_idle(self, now: Optional[float] = None) -> bool:
        secs = float(self.cfg.get("idle_unload_seconds", FALLBACK_IDLE_UNLOAD_SECONDS) or 0)
        if secs <= 0 or self.model is None:
            return False
        now = time.time() if now is None else now
        if now - self.last_used < secs:
            return False
        if not self.infer_slot.acquire(blocking=False):
            return False  # inference in progress
        try:
            if self.model is None or now - self.last_used < secs:
                return False
            self.unload()
            return True
        finally:
            self.infer_slot.release()

    # ---- inference
    def encode(self, texts: List[str]) -> Any:
        return self.model.encode(texts, batch_size=self.cfg["batch_size"], normalize_embeddings=True)

    def health(self) -> Dict[str, Any]:
        return {
            "status": "ok",
            "state": self.state,
            "loaded": self.model is not None,
            "model": self.cfg.get("model"),
            "device": self.device,
            "precision": self.precision,
            "batch_size": self.cfg.get("batch_size"),
            "idle_unload_seconds": self.cfg.get("idle_unload_seconds"),
            "selftest": self.selftest,
            "error": self.error,
            "rss_mb": _rss_mb(),
        }


engine = Engine()


def _reaper(stop: threading.Event) -> None:
    while not stop.wait(REAPER_TICK_S):
        try:
            engine.reap_if_idle()
        except Exception as e:  # noqa: BLE001
            print(f"[Embedder Warning] reaper: {e}", flush=True)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    stop = threading.Event()
    t = threading.Thread(target=_reaper, args=(stop,), name="embedder-reaper", daemon=True)
    t.start()
    try:
        yield
    finally:
        stop.set()


app = FastAPI(title="GeoRhizome Embedding Service", version="2.0.0", lifespan=lifespan)


@app.get("/health")
def health() -> Dict[str, Any]:
    return engine.health()


@app.post("/v1/embeddings")
@app.post("/embeddings")
def create_embedding(req: EmbeddingRequest):
    input_text = [req.input] if isinstance(req.input, str) else list(req.input)
    chunk = engine.cfg["chunk_size"]
    # Capped to chunk_size chars per text to prevent attention matrix memory explosion
    truncated = [str(t)[:chunk] if t else "" for t in input_text]
    with engine.infer_slot:
        engine.ensure_loaded()
        t0 = time.time()
        embeddings = engine.encode(truncated)
        duration = time.time() - t0
        engine.last_used = time.time()
    data = [{"object": "embedding", "index": i, "embedding": e.tolist()} for i, e in enumerate(embeddings)]
    n = sum(len(t) for t in truncated)
    return JSONResponse(content={
        "object": "list",
        "data": data,
        "model": engine.cfg["model"],
        "usage": {"prompt_tokens": n, "total_tokens": n},
        "latency_sec": round(duration, 4),
    })


if __name__ == "__main__":
    port = int(os.getenv("EMBEDDING_PORT", "8000"))
    host = os.getenv("EMBEDDING_HOST", "127.0.0.1")
    print(f"Launching Local Embedding Server on {host}:{port} (lazy model load)", flush=True)
    uvicorn.run(app, host=host, port=port)
