#!/usr/bin/env python3
"""
Hardware-Adaptive Cross-Encoder Reranker Server (Phase 6).
FastAPI service exposing POST /rerank endpoint.
Dynamically detects hardware (RAM, MPS, CUDA) and loads appropriate reranker tier from config/reranker_tiers.yaml.
"""

import sys
import os
import yaml
import psutil
import torch
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn
from sentence_transformers import CrossEncoder

CONFIG_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "config"))
TIERS_PATH = os.path.join(CONFIG_DIR, "reranker_tiers.yaml")

app = FastAPI(title="GeoRhizome Reranker Service", version="1.0.0")

class Candidate(BaseModel):
    id: Optional[str] = None
    text: str
    metadata: Optional[Dict[str, Any]] = None

class RerankRequest(BaseModel):
    query: str
    candidates: List[Candidate]

class RerankerEngine:
    def __init__(self):
        self.tier_name = "medium"
        self.model_name = "BAAI/bge-reranker-base"
        self.device = "cpu"
        self.model = None
        self._initialize_hardware_and_model()

    def _initialize_hardware_and_model(self):
        # 1. Load config tiers
        tiers_config = {}
        if os.path.exists(TIERS_PATH):
            try:
                with open(TIERS_PATH, "r", encoding="utf-8") as f:
                    tiers_config = yaml.safe_load(f).get("tiers", {})
            except Exception as e:
                print(f"[Reranker Warning] Failed to load {TIERS_PATH}: {e}")

        # 2. Hardware Detection
        ram_gb = psutil.virtual_memory().total / (1024 ** 3)
        has_mps = torch.backends.mps.is_available()
        has_cuda = torch.cuda.is_available()

        print(f"[Reranker Hardware Check] Total System RAM: {ram_gb:.2f} GB | MPS: {has_mps} | CUDA: {has_cuda}")

        if has_cuda and ram_gb >= 16:
            self.tier_name = "high"
            self.device = "cuda"
        elif ram_gb >= 8:
            self.tier_name = "medium"
            self.device = "cpu"
        else:
            self.tier_name = "low"
            self.device = "cpu"

        tier_info = tiers_config.get(self.tier_name, {})
        self.model_name = tier_info.get("model", "cl-nagoya/ruri-v3-reranker-310m")
        self.device = tier_info.get("device", "cpu")

        # 2b. Check dynamic active model state override
        active_state_path = os.path.join(CONFIG_DIR, "active_models.json")
        if os.path.exists(active_state_path):
            try:
                import json
                with open(active_state_path, "r", encoding="utf-8") as f:
                    st = json.load(f)
                    active_rerank = st.get("reranker", {}).get("model_id")
                    if active_rerank and active_rerank != "Offloaded":
                        self.model_name = active_rerank
            except Exception as e:
                print(f"[Reranker Warning] Failed loading active_models.json: {e}")

        print(f"[Reranker Model Selection] Tier: '{self.tier_name}' | Dynamic Model: '{self.model_name}' | Device: '{self.device}'")

        # 3. Load CrossEncoder model
        try:
            self.model = CrossEncoder(self.model_name, device=self.device)
            print(f"[Reranker Engine] Successfully loaded {self.model_name} on {self.device}!")
        except Exception as e:
            print(f"[Reranker Error] Failed loading on {self.device}, falling back to CPU: {e}")
            self.device = "cpu"
            self.model = CrossEncoder(self.model_name, device="cpu")

    def score_and_rank(self, query: str, candidates: List[Candidate]) -> List[Dict[str, Any]]:
        if not candidates or not self.model:
            return []

        # Build pair inputs for CrossEncoder
        pairs = [[query, cand.text] for cand in candidates]
        scores = self.model.predict(pairs)

        results = []
        for cand, score in zip(candidates, scores):
            results.append({
                "id": cand.id,
                "text": cand.text,
                "score": float(score),
                "metadata": cand.metadata or {}
            })

        # Sort descending by cross-encoder score
        results.sort(key=lambda x: x["score"], reverse=True)
        for rank, item in enumerate(results, start=1):
            item["rank"] = rank

        return results

engine = None

@app.on_event("startup")
def startup_event():
    global engine
    engine = RerankerEngine()

@app.get("/health")
def health():
    if not engine:
        raise HTTPException(status_code=503, detail="Reranker engine not initialized")
    return {
        "status": "ok",
        "tier": engine.tier_name,
        "model": engine.model_name,
        "device": engine.device
    }

@app.post("/rerank")
def rerank(req: RerankRequest):
    if not engine:
        raise HTTPException(status_code=503, detail="Reranker engine initializing")
    if not req.query or not req.candidates:
        return {"results": []}

    ranked_results = engine.score_and_rank(req.query, req.candidates)
    return {
        "query": req.query,
        "results": ranked_results,
        "count": len(ranked_results)
    }

if __name__ == "__main__":
    port = int(os.getenv("RERANKER_PORT", "8001"))
    print(f"🚀 Launching Local Reranker Server on http://127.0.0.1:{port} ...")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
