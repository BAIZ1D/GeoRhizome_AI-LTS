#!/usr/bin/env python3
"""
Configurable SPLADE sparse encoder server (port from config, loopback only).

- Binds immediately; the model loads lazily on the first POST /v1/sparse/encode
  and unloads after ``sparse.idle_unload_minutes`` of idleness (<= 0 disables).
- All limits, model name, revision, device and precision come from
  config/app_config.json ``sparse`` (via sparse_state.get_sparse_settings).
- Oversized requests get HTTP 413 before any inference; a busy single inference
  slot gets HTTP 503. Request text is never silently truncated; token-level
  truncation to ``max_length`` is counted in the response ``truncated`` field.
- Documents and queries take the identical path (no prefix). Document text is
  never logged.
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import time
from contextlib import asynccontextmanager
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import psutil
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

import sparse_runtime as sr
from core.config_io import get_config_dir
from sparse_state import get_sparse_settings

REAPER_TICK_S = 30.0
PARITY_TOPK = 20
PARITY_MIN_OVERLAP = 0.95
# Tokenizer self-test: fixed probe sentence and tokens the pinned tokenizer must emit.
SELFTEST_SENTENCES = ["大阪万博は2025年に開催されます。"]
SELFTEST_TOKENS = ["202", "##5"]

# Injection hook for tests: callable(settings) -> (tokenizer, model). None = real HF loader.
SPARSE_FACTORY: Optional[Callable[[Dict[str, Any]], Tuple[Any, Any]]] = None


class SparseRequest(BaseModel):
    input: Union[str, List[str]]


def _free_accel() -> None:
    try:
        import torch

        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def _hf_factory(settings: Dict[str, Any]) -> Tuple[Any, Any]:
    import torch
    from transformers import AutoModelForMaskedLM, AutoTokenizer

    name, rev = settings["model_name"], settings["revision"]
    tok = AutoTokenizer.from_pretrained(name, revision=rev)
    model = AutoModelForMaskedLM.from_pretrained(name, revision=rev, torch_dtype=torch.float32)
    model.eval()
    return tok, model


def _resolve_device(want: str) -> str:
    want = (want or "cpu").lower()
    if want in ("cpu",):
        return "cpu"
    try:
        import torch

        if want in ("mps", "auto") and torch.backends.mps.is_available():
            return "mps"
        if want in ("cuda", "auto") and torch.cuda.is_available():
            return "cuda"
    except Exception:  # noqa: BLE001
        pass
    return "cpu"


def _topk_overlap(a: Any, b: Any, k: int) -> float:
    import torch

    ia = set(torch.topk(a.float().cpu(), k).indices.tolist())
    ib = set(torch.topk(b.float().cpu(), k).indices.tolist())
    return len(ia & ib) / float(k)


def _encode_batch(tok: Any, model: Any, texts: List[str], settings: Dict[str, Any], device: str) -> Tuple[Any, int]:
    max_len = int(settings["max_length"])
    enc = tok(texts, max_length=max_len, truncation=True, padding=True, return_tensors="pt")
    ids, mask = enc["input_ids"], enc["attention_mask"]
    truncated = int((mask.sum(dim=1) >= max_len).sum().item())
    if device != "cpu":
        ids, mask = ids.to(device), mask.to(device)
    pooled = sr.splade_pool_chunked(model, ids, mask, int(settings["pool_chunk"]))
    return pooled, truncated


class Engine:
    def __init__(self) -> None:
        self.config_dir = get_config_dir()
        self.cfg: Dict[str, Any] = get_sparse_settings(self.config_dir)
        self.tok: Any = None
        self.model: Any = None
        self.state = "unloaded"
        self.last_used = 0.0
        self.info: Dict[str, Any] = {}
        self.error: Optional[str] = None
        self.tokenizer_status: Dict[str, Any] = {"ok": None, "error": None}
        self._load_lock = threading.Lock()
        self.infer_slot = threading.Semaphore(1)

    # ---- lifecycle
    def ensure_loaded(self) -> None:
        if self.model is not None:
            return
        with self._load_lock:
            if self.model is not None:
                return
            self.state = "loading"
            try:
                self.cfg = get_sparse_settings(self.config_dir)
                t0 = time.time()
                factory = SPARSE_FACTORY or _hf_factory
                tok, model = factory(self.cfg)
                vocab = int(model.config.vocab_size)
                device = _resolve_device(str(self.cfg["device"]))
                precision = "fp32"
                note = None
                want_fp16 = str(self.cfg["precision"]).lower() == "fp16"
                if want_fp16 and device == "cpu":
                    note = "fp16 requested on cpu; forced fp32"
                st = sr.tokenizer_selftest(tok, SELFTEST_SENTENCES, SELFTEST_TOKENS)
                degraded: Optional[str] = None
                try:
                    sr.assert_uint16_vocab(vocab)
                except ValueError as e:
                    degraded = str(e)
                if not st["ok"]:
                    degraded = f"tokenizer self-test failed: {st['error']}"
                if device != "cpu" and degraded is None:
                    if want_fp16:
                        model, precision, note = self._maybe_fp16(tok, model, device)
                    else:
                        model.to(device)
            except Exception as e:  # noqa: BLE001
                self.state = "degraded"
                self.error = f"{type(e).__name__}: {e}"
                print(f"[Sparse Error] load failed: {self.error}", flush=True)
                raise
            self.tok, self.model = tok, model
            self.tokenizer_status = {"ok": bool(st["ok"]), "error": st["error"]}
            self.info = {"vocab_size": vocab, "device": device, "precision": precision,
                         "load_seconds": round(time.time() - t0, 2), "note": note}
            self.error = degraded or note
            self.state = "degraded" if degraded else "ready"
            self.last_used = time.time()
            print(f"[Sparse] {self.state}: {self.info}", flush=True)

    def _maybe_fp16(self, tok: Any, model: Any, device: str) -> Tuple[Any, str, Optional[str]]:
        import copy

        ref = copy.deepcopy(model)
        half = copy.deepcopy(model).half().to(device)
        ref_dev = ref
        overlaps = []
        for s in SELFTEST_SENTENCES:
            a, _ = _encode_batch(tok, ref_dev, [s], self.cfg, "cpu")
            b, _ = _encode_batch(tok, half, [s], self.cfg, device)
            overlaps.append(_topk_overlap(a[0], b[0], PARITY_TOPK))
        ov = min(overlaps) if overlaps else 0.0
        if ov >= PARITY_MIN_OVERLAP:
            del ref
            del model
            return half, "fp16", None
        reason = f"fp16 parity overlap {ov:.2f} < {PARITY_MIN_OVERLAP}; forced fp32"
        print(f"[Sparse] {reason}", flush=True)
        del half
        ref.to(device)
        return ref, "fp32", reason

    def unload(self) -> None:
        with self._load_lock:
            self.model = None
            self.tok = None
            _free_accel()
            self.state = "unloaded"
            self.tokenizer_status = {"ok": None, "error": None}
            print("[Sparse] model unloaded (idle)", flush=True)

    def reap_if_idle(self, now: Optional[float] = None) -> bool:
        minutes = float(self.cfg.get("idle_unload_minutes") or 0)
        if minutes <= 0 or self.model is None:
            return False
        now = time.time() if now is None else now
        if now - self.last_used <= minutes * 60:
            return False
        if not self.infer_slot.acquire(blocking=False):
            return False
        try:
            if self.model is None or now - self.last_used <= minutes * 60:
                return False
            self.unload()
            return True
        finally:
            self.infer_slot.release()

    # ---- inference
    def encode(self, texts: List[str]) -> Dict[str, Any]:
        bs = max(1, int(self.cfg["batch_size"]))
        data: List[Dict[str, Any]] = []
        truncated = 0
        for s in range(0, len(texts), bs):
            pooled, tr = _encode_batch(self.tok, self.model, texts[s:s + bs], self.cfg, self.info["device"])
            truncated += tr
            for row in pooled:
                idx, vals = sr.to_sparse(row)
                data.append({"index": len(data), "indices": idx, "values": vals})
        return {"model_id": self.cfg["model_name"], "vocab_size": self.info["vocab_size"],
                "truncated": truncated, "data": data}

    def health(self) -> Dict[str, Any]:
        loaded = self.model is not None
        return {
            "status": "ok",
            "state": self.state,
            "loaded": loaded,
            "model": self.cfg.get("model_name"),
            "vocab_size": self.info.get("vocab_size") if loaded else None,
            "device": self.info.get("device") if loaded else self.cfg.get("device"),
            "precision": self.info.get("precision") if loaded else self.cfg.get("precision"),
            "batch_size": self.cfg.get("batch_size"),
            "max_length": self.cfg.get("max_length"),
            "max_input_chars": self.cfg.get("max_input_chars"),
            "max_inputs_per_request": self.cfg.get("max_inputs_per_request"),
            "idle_unload_minutes": self.cfg.get("idle_unload_minutes"),
            "tokenizer": dict(self.tokenizer_status),
            "error": self.error,
            "rss_mb": round(psutil.Process().memory_info().rss / 2**20, 1),
        }


engine = Engine()


def _reaper(stop: threading.Event) -> None:
    while not stop.wait(REAPER_TICK_S):
        try:
            engine.reap_if_idle()
        except Exception as e:  # noqa: BLE001
            print(f"[Sparse Warning] reaper: {e}", flush=True)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    stop = threading.Event()
    t = threading.Thread(target=_reaper, args=(stop,), name="sparse-reaper", daemon=True)
    t.start()
    try:
        yield
    finally:
        stop.set()


app = FastAPI(title="GeoRhizome Sparse Encoder Service", version="1.0.0", lifespan=lifespan)


@app.get("/health")
def health() -> Dict[str, Any]:
    return engine.health()


@app.post("/v1/sparse/encode")
def sparse_encode(req: SparseRequest):
    texts = [req.input] if isinstance(req.input, str) else list(req.input)
    max_inputs = int(engine.cfg["max_inputs_per_request"])
    max_chars = int(engine.cfg["max_input_chars"])
    if len(texts) > max_inputs:
        raise HTTPException(status_code=413, detail=f"too many inputs (max {max_inputs})")
    if any(len(t) > max_chars for t in texts):
        raise HTTPException(status_code=413, detail=f"input exceeds {max_chars} characters")
    if not texts:
        return {"model_id": engine.cfg["model_name"], "vocab_size": engine.info.get("vocab_size"),
                "truncated": 0, "data": []}
    key = "timeout_ms" if engine.model is not None else "cold_timeout_ms"
    wait_s = float(engine.cfg[key]) / 1000.0
    if not engine.infer_slot.acquire(timeout=wait_s):
        raise HTTPException(status_code=503, detail="sparse encoder busy")
    try:
        try:
            engine.ensure_loaded()
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=503, detail=f"sparse load failed: {type(e).__name__}")
        if engine.state == "degraded":
            raise HTTPException(status_code=503, detail=f"sparse encoder degraded: {engine.error}")
        t0 = time.time()
        out = engine.encode(texts)
        engine.last_used = time.time()
        print(f"[Sparse] encoded n={len(texts)} truncated={out['truncated']} "
              f"in {engine.last_used - t0:.2f}s", flush=True)
        return out
    finally:
        engine.infer_slot.release()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=None)
    args = ap.parse_args()
    port = args.port or int(engine.cfg["port"])
    print(f"Launching Local Sparse Server on port {port} (lazy model load)", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
