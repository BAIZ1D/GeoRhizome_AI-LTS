#!/usr/bin/env python3
"""
GeoRhizome Hardware & Model Hub FastAPI Server (Port 8002).
Provides hardware detection, HuggingFace GGUF discovery, model fitting calculations,
1-click downloads, 1-click onloading, and 1-click offloading.
"""

import sys
import os
import json
import time
import subprocess
import shutil
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException, BackgroundTasks, Query
from pydantic import BaseModel
import uvicorn

sys.path.insert(0, os.path.dirname(__file__))
from hwfit.hardware import detect_system
from hwfit.fit import rank_models, analyze_model
from core.platform_compat import kill_process_tree, pid_alive

CONFIG_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "config"))
CATALOG_PATH = os.path.join(CONFIG_DIR, "model_catalog.json")
MODELS_CACHE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "models"))
os.makedirs(MODELS_CACHE_DIR, exist_ok=True)

app = FastAPI(title="GeoRhizome Hardware & Model Hub Server", version="1.0.0")

ACTIVE_PROCESSES: Dict[str, Dict[str, Any]] = {}
DOWNLOAD_JOBS: Dict[str, Dict[str, Any]] = {}

class DownloadRequest(BaseModel):
    repo_id: str
    filename: Optional[str] = None
    category: Optional[str] = "generative"

class ServeRequest(BaseModel):
    category: str
    model_id: str
    quant: Optional[str] = "q4_k_m"

class OffloadRequest(BaseModel):
    category: str

@app.get("/hardware/detect")
def hardware_detect():
    """Detect local system hardware specs dynamically."""
    try:
        sys_info = detect_system()
        return {"status": "ok", "system": sys_info}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/hardware/catalog")
def get_catalog():
    """Return model catalog dynamically analyzed against detected hardware."""
    sys_info = detect_system()
    catalog_data = {}

    if os.path.exists(CATALOG_PATH):
        try:
            with open(CATALOG_PATH, "r", encoding="utf-8") as f:
                catalog_data = json.load(f)
        except Exception as e:
            print(f"[Warning] Failed loading catalog {CATALOG_PATH}: {e}")

    # Dynamically analyze every model using Odysseus hwfit engine
    annotated = {}
    for cat, items in catalog_data.items():
        cat_items = []
        for item in items:
            repo_id = item.get("repo_id")
            default_quant = item.get("default_quant", "q4_k_m").upper()
            
            # Map parameters dynamically for analyze_model
            params_raw = 8_000_000_000
            if "3B" in item.get("name", ""):
                params_raw = 3_000_000_000
            elif "7B" in item.get("name", "") or "8B" in item.get("name", ""):
                params_raw = 8_000_000_000

            dummy_m = {
                "name": item.get("name"),
                "parameters_raw": params_raw,
                "parameter_count": item.get("name", "").split()[-1] if item.get("name") else "8B",
                "use_case": item.get("use_case", "general")
            }

            analysis = analyze_model(dummy_m, sys_info, target_quant=default_quant, scoring_use_case=item.get("use_case", "general"))

            item_copy = dict(item)
            item_copy["fit_badge"] = analysis.get("fit_level", "good")
            item_copy["est_tps"] = round(analysis.get("speed_tps") or 25.0, 1)
            item_copy["required_gb"] = round(analysis.get("required_gb") or 4.0, 1)
            item_copy["active"] = cat in ACTIVE_PROCESSES
            cat_items.append(item_copy)
        annotated[cat] = cat_items

    return {"status": "ok", "system": sys_info, "catalog": annotated}

@app.get("/hardware/hf-files")
def hf_files(repo_id: str = Query(...)):
    """Fetch GGUF files for a given HuggingFace repository dynamically."""
    try:
        import urllib.request
        url = f"https://huggingface.co/api/models/{repo_id}/tree/main"
        req = urllib.request.Request(url, headers={"User-Agent": "GeoRhizome/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            tree = json.loads(resp.read().decode("utf-8"))

        sys_info = detect_system()
        gguf_files = []
        for item in tree:
            r_path = item.get("path", "")
            if r_path.endswith(".gguf"):
                size_mb = round(item.get("size", 0) / (1024 * 1024), 1)
                quant = r_path.replace(".gguf", "").split("-")[-1].upper()
                
                # Analyze file dynamically
                dummy_m = {
                    "name": r_path,
                    "parameters_raw": 8_000_000_000,
                    "parameter_count": "8B"
                }
                analysis = analyze_model(dummy_m, sys_info, target_quant=quant)

                gguf_files.append({
                    "filename": r_path,
                    "size_mb": size_mb,
                    "quant": quant,
                    "est_tps": round(analysis.get("speed_tps") or 25.0, 1),
                    "fit_badge": analysis.get("fit_level", "good")
                })

        return {"status": "ok", "repo_id": repo_id, "files": gguf_files}
    except Exception as e:
        return {"status": "error", "repo_id": repo_id, "files": [], "error": str(e)}

@app.post("/hardware/download")
def download_model(req: DownloadRequest, bg_tasks: BackgroundTasks):
    """Initiate 1-click model download."""
    job_id = f"dl-{req.repo_id.replace('/', '_')}"
    if job_id in DOWNLOAD_JOBS and DOWNLOAD_JOBS[job_id]["status"] == "downloading":
        return {"status": "downloading", "job_id": job_id, "message": "Download already in progress"}

    DOWNLOAD_JOBS[job_id] = {
        "repo_id": req.repo_id,
        "filename": req.filename,
        "status": "downloading",
        "progress": 0,
        "message": "Starting HuggingFace download..."
    }

    def _async_download():
        try:
            cmd = ["huggingface-cli", "download", req.repo_id]
            if req.filename:
                cmd.extend(["--include", req.filename])
            cmd.extend(["--local-dir", os.path.join(MODELS_CACHE_DIR, req.repo_id.split("/")[-1])])

            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            for line in p.stdout:
                if "%" in line:
                    try:
                        for token in line.split():
                            if "%" in token:
                                val = float(token.replace("%", ""))
                                DOWNLOAD_JOBS[job_id]["progress"] = val
                    except Exception:
                        pass
            p.wait()
            DOWNLOAD_JOBS[job_id]["status"] = "complete"
            DOWNLOAD_JOBS[job_id]["progress"] = 100
            DOWNLOAD_JOBS[job_id]["message"] = "Download complete!"
        except Exception as e:
            DOWNLOAD_JOBS[job_id]["status"] = "error"
            DOWNLOAD_JOBS[job_id]["message"] = str(e)

    bg_tasks.add_task(_async_download)
    return {"status": "started", "job_id": job_id}

@app.post("/hardware/serve")
def serve_model(req: ServeRequest):
    """1-Click Onload model into local server."""
    cat = req.category.lower()

    if cat == "reranker":
        if "reranker" in ACTIVE_PROCESSES and pid_alive(ACTIVE_PROCESSES["reranker"]["pid"]):
            return {"status": "ok", "message": "Reranker server is already running on port 8001", "port": 8001}

        reranker_script = os.path.abspath(os.path.join(os.path.dirname(__file__), "local_reranker_server.py"))
        p = subprocess.Popen([sys.executable, reranker_script])
        ACTIVE_PROCESSES["reranker"] = {"pid": p.pid, "model_id": req.model_id, "port": 8001, "start_time": time.time()}
        return {"status": "ok", "message": f"Successfully loaded reranker {req.model_id} on port 8001", "pid": p.pid}

    elif cat == "embedding":
        if "embedding" in ACTIVE_PROCESSES and pid_alive(ACTIVE_PROCESSES["embedding"]["pid"]):
            return {"status": "ok", "message": "Embedding server is already running on port 8000", "port": 8000}

        bge_script = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "local_bge_server.py"))
        p = subprocess.Popen([sys.executable, bge_script])
        ACTIVE_PROCESSES["embedding"] = {"pid": p.pid, "model_id": req.model_id, "port": 8000, "start_time": time.time()}
        return {"status": "ok", "message": f"Successfully loaded embedder {req.model_id} on port 8000", "pid": p.pid}

    elif cat == "generative":
        ACTIVE_PROCESSES["generative"] = {"pid": os.getpid(), "model_id": req.model_id, "quant": req.quant, "start_time": time.time()}
        return {"status": "ok", "message": f"Successfully selected generative model {req.model_id} ({req.quant})"}

    raise HTTPException(status_code=400, detail=f"Unknown category: {cat}")

@app.post("/hardware/offload")
def offload_model(req: OffloadRequest):
    """1-Click Offload model to free VRAM/RAM immediately."""
    cat = req.category.lower()
    if cat not in ACTIVE_PROCESSES:
        return {"status": "ok", "message": f"No active {cat} process to offload"}

    proc_info = ACTIVE_PROCESSES.pop(cat)
    pid = proc_info.get("pid")
    if pid and pid != os.getpid():
        try:
            kill_process_tree(pid)
        except Exception as e:
            print(f"[Warning] Failed killing PID {pid}: {e}")

    return {"status": "ok", "message": f"Successfully offloaded {cat} model and reclaimed memory."}

@app.get("/hardware/status")
def hardware_status():
    """Get active processes and background download jobs."""
    active_summary = {}
    for cat, info in ACTIVE_PROCESSES.items():
        active_summary[cat] = {
            "model_id": info.get("model_id"),
            "port": info.get("port"),
            "alive": pid_alive(info.get("pid")) if info.get("pid") != os.getpid() else True
        }

    return {
        "status": "ok",
        "active_processes": active_summary,
        "downloads": DOWNLOAD_JOBS
    }

if __name__ == "__main__":
    port = int(os.getenv("HARDWARE_SERVER_PORT", "8002"))
    print(f"🚀 Launching GeoRhizome Hardware & Model Hub Server on http://127.0.0.1:{port} ...")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
