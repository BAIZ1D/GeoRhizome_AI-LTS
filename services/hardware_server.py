#!/usr/bin/env python3
"""
GeoRhizome Hardware & Model Hub FastAPI Server (Port 8002).
Provides dynamic 1-to-1 Odysseus Cookbook integration: hardware detection, HuggingFace
model ranking, quantization selection, 1-click downloads, 1-click onloading, and offloading.
"""

import sys
import os
import json
import time
import subprocess
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

ACTIVE_MODELS_STATE_PATH = os.path.join(CONFIG_DIR, "active_models.json")

def load_active_state():
    if os.path.exists(ACTIVE_MODELS_STATE_PATH):
        try:
            with open(ACTIVE_MODELS_STATE_PATH, "r", encoding="utf-8") as f:
                st = json.load(f)
                for cat, info in st.items():
                    if info.get("model_id") and info.get("model_id") != "Offloaded":
                        info["alive"] = True
                return st
        except Exception:
            pass
    default_gen_model = "Qwen3-0.6B-Q8_0.gguf"
    default_emb_model = "cl-nagoya/ruri-v3-310m"
    default_rerank_model = "cl-nagoya/ruri-v3-reranker-310m"
    app_cfg_p = os.path.join(ROOT_DIR, "config", "app_config.json")
    if os.path.exists(app_cfg_p):
        try:
            with open(app_cfg_p, "r", encoding="utf-8") as f:
                c = json.load(f)
                default_gen_model = c.get("llm", {}).get("model_name") or default_gen_model
                default_emb_model = c.get("embedding", {}).get("model_name") or default_emb_model
        except Exception:
            pass

    ret_cfg_p = os.path.join(ROOT_DIR, "config", "retrieval.yaml")
    if os.path.exists(ret_cfg_p):
        try:
            with open(ret_cfg_p, "r", encoding="utf-8") as f:
                y = yaml.safe_load(f) or {}
                default_rerank_model = y.get("retrieval", {}).get("reranker_model") or default_rerank_model
        except Exception:
            pass

    return {
        "generative": {
            "model_id": default_gen_model,
            "name": default_gen_model,
            "quant": "Q4_K_M",
            "pid": os.getpid(),
            "alive": True
        },
        "embedding": {
            "model_id": default_emb_model,
            "name": default_emb_model,
            "port": 8000,
            "pid": os.getpid(),
            "alive": True
        },
        "reranker": {
            "model_id": default_rerank_model,
            "name": default_rerank_model,
            "port": 8001,
            "pid": os.getpid(),
            "alive": True
        }
    }

def save_active_state():
    try:
        with open(ACTIVE_MODELS_STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(ACTIVE_PROCESSES, f, indent=2)
    except Exception as e:
        print("[Error] Failed saving active models state:", e)

def update_app_config_embedding(model_id: str, dimension: int):
    """Dynamically write embedding model name & derived vector dimension to app_config.json & server/.env."""
    root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    app_config_path = os.path.join(root_dir, "config", "app_config.json")
    env_path = os.path.join(root_dir, "georhizome-ai-source", "server", ".env")

    # 1. Update config/app_config.json
    if os.path.exists(app_config_path):
        try:
            with open(app_config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            old_dim = cfg.get("embedding", {}).get("dimension")
            cfg.setdefault("embedding", {})["model_name"] = model_id
            cfg.setdefault("embedding", {})["dimension"] = dimension
            with open(app_config_path, "w", encoding="utf-8") as f:
                json.dump(cfg, f, indent=2)
            print(f"[DynamicConfig] Updated app_config.json -> embedding.model_name={model_id}, dimension={dimension}")

            # If vector dimension changed, purge vector stores automatically to avoid LanceDB mismatch crashes!
            if old_dim is not None and old_dim != dimension and dimension > 0:
                print(f"[DynamicConfig] Vector dimension changed from {old_dim} to {dimension}! Triggering vector store purge...")
                purge_script = os.path.join(root_dir, "scripts", "purge_all_vector_stores.sh")
                if os.path.exists(purge_script):
                    subprocess.run(["bash", purge_script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as e:
            print(f"[DynamicConfig Error] Failed updating app_config.json: {e}")

    # 2. Update server/.env
    if os.path.exists(env_path):
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                content = f.read()
            lines = content.splitlines()
            new_lines = []
            has_pref = False
            has_dim = False
            for line in lines:
                if line.startswith("EMBEDDING_MODEL_PREF="):
                    new_lines.append(f"EMBEDDING_MODEL_PREF='{model_id}'")
                    has_pref = True
                elif line.startswith("EMBEDDING_DIMENSION="):
                    new_lines.append(f"EMBEDDING_DIMENSION={dimension}")
                    has_dim = True
                else:
                    new_lines.append(line)
            if not has_pref:
                new_lines.append(f"EMBEDDING_MODEL_PREF='{model_id}'")
            if not has_dim:
                new_lines.append(f"EMBEDDING_DIMENSION={dimension}")
            with open(env_path, "w", encoding="utf-8") as f:
                f.write("\n".join(new_lines) + "\n")
            print(f"[DynamicConfig] Updated server/.env -> EMBEDDING_MODEL_PREF='{model_id}', EMBEDDING_DIMENSION={dimension}")
        except Exception as e:
            print(f"[DynamicConfig Error] Failed updating server/.env: {e}")


def probe_and_sync_embedder(model_id: str):
    """Background task to poll Port 8000 until active, derive runtime vector dimension, and sync configs."""
    import time, requests
    time.sleep(2)
    for _ in range(20):
        try:
            res = requests.post("http://127.0.0.1:8000/v1/embeddings", json={"input": "dimension_probe"}, timeout=5)
            if res.status_code == 200:
                vec = res.json()["data"][0]["embedding"]
                dim = len(vec)
                print(f"[DynamicEmbedderProbe] Probed live model '{model_id}' -> derived dimension: {dim}")
                update_app_config_embedding(model_id, dim)
                break
        except Exception:
            time.sleep(1)


def probe_and_sync_llm(model_id: str, default_n_ctx: int = 16384):
    """Background task to poll Port 8003 until active, extract model name and context limit, and sync configs."""
    import time, requests
    time.sleep(2)
    for _ in range(20):
        try:
            res = requests.get("http://127.0.0.1:8003/v1/models", timeout=5)
            if res.status_code == 200:
                data = res.json()
                active_models = data.get("data", [])
                served_id = model_id
                if active_models:
                    raw_id = active_models[0].get("id", "")
                    if raw_id:
                        served_id = raw_id.split("/")[-1]
                print(f"[DynamicLLMProbe] Probed live generative LLM '{served_id}' -> context limit: {default_n_ctx}")
                update_app_config_llm(served_id, default_n_ctx)
                break
        except Exception:
            time.sleep(1)


def update_app_config_llm(model_id: str, token_limit: int = 16384):
    """Dynamically write LLM model name & token limit to app_config.json & server/.env."""
    root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    app_config_path = os.path.join(root_dir, "config", "app_config.json")
    env_path = os.path.join(root_dir, "georhizome-ai-source", "server", ".env")

    if os.path.exists(app_config_path):
        try:
            with open(app_config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            cfg.setdefault("llm", {})["model_name"] = model_id
            cfg.setdefault("llm", {})["token_limit"] = token_limit
            with open(app_config_path, "w", encoding="utf-8") as f:
                json.dump(cfg, f, indent=2)
            print(f"[DynamicConfig] Updated app_config.json -> llm.model_name={model_id}, token_limit={token_limit}")
        except Exception as e:
            print(f"[DynamicConfig Error] Failed updating app_config.json: {e}")

    if os.path.exists(env_path):
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                content = f.read()
            lines = content.splitlines()
            new_lines = []
            has_pref = False
            has_limit = False
            for line in lines:
                if line.startswith("GENERIC_OPEN_AI_MODEL_PREF="):
                    new_lines.append(f"GENERIC_OPEN_AI_MODEL_PREF='{model_id}'")
                    has_pref = True
                elif line.startswith("GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT="):
                    new_lines.append(f"GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT={token_limit}")
                    has_limit = True
                else:
                    new_lines.append(line)
            if not has_pref:
                new_lines.append(f"GENERIC_OPEN_AI_MODEL_PREF='{model_id}'")
            if not has_limit:
                new_lines.append(f"GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT={token_limit}")
            with open(env_path, "w", encoding="utf-8") as f:
                f.write("\n".join(new_lines) + "\n")
            print(f"[DynamicConfig] Updated server/.env -> GENERIC_OPEN_AI_MODEL_PREF='{model_id}', GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT={token_limit}")
        except Exception as e:
            print(f"[DynamicConfig Error] Failed updating server/.env: {e}")

    # 3. Dynamically sync SQLite workspaces database so all generic-openai workspaces track the active model
    db_path = os.path.join(root_dir, "..", "storage", "anythingllm.db")
    if os.path.exists(db_path):
        try:
            import sqlite3
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE workspaces SET chatModel = ? WHERE chatProvider = 'generic-openai'",
                (model_id,)
            )
            cursor.execute(
                "UPDATE workspaces SET agentModel = ? WHERE agentProvider = 'generic-openai'",
                (model_id,)
            )
            conn.commit()
            conn.close()
            print(f"[DynamicConfig] Dynamically synchronized SQLite workspaces with active model '{model_id}'")
        except Exception as e:
            print(f"[DynamicConfig Error] Failed syncing SQLite workspaces: {e}")


def update_retrieval_reranker(enabled: bool, model_id: str = ""):
    """Dynamically sync reranker state in retrieval.yaml."""
    root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    ret_path = os.path.join(root_dir, "config", "retrieval.yaml")
    if os.path.exists(ret_path):
        try:
            with open(ret_path, "r", encoding="utf-8") as f:
                ydata = yaml.safe_load(f) or {}
            if "retrieval" in ydata:
                ydata["retrieval"]["reranker_enabled"] = enabled
                if model_id:
                    ydata["retrieval"]["reranker_model"] = model_id
                with open(ret_path, "w", encoding="utf-8") as f:
                    yaml.dump(ydata, f)
            print(f"[DynamicConfig] Updated retrieval.yaml -> reranker_enabled={enabled}, reranker_model={model_id}")
        except Exception as e:
            print(f"[DynamicConfig Error] Failed updating retrieval.yaml: {e}")

ACTIVE_PROCESSES: Dict[str, Dict[str, Any]] = load_active_state()
DOWNLOAD_JOBS: Dict[str, Dict[str, Any]] = {}

class DownloadRequest(BaseModel):
    repo_id: Optional[str] = None
    model_id: Optional[str] = None
    filename: Optional[str] = None
    category: Optional[str] = "generative"
    quant: Optional[str] = "Q4_K_M"

class ServeRequest(BaseModel):
    category: Optional[str] = "generative"
    model_id: Optional[str] = None
    repo_id: Optional[str] = None
    quant: Optional[str] = "Q4_K_M"

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
def get_catalog(
    category: Optional[str] = None,
    search: Optional[str] = None,
    quant: Optional[str] = None,
    limit: int = 50
):
    """
    Return dynamic Odysseus Cookbook ranking for all HuggingFace & local models.
    Supports filtering by category (generative/chat/reasoning, embedding, reranker),
    quantization (Q2_K, Q3_K_M, Q4_K_M, Q5_K_M, Q8_0, FP16), and search term.
    """
    try:
        sys_info = detect_system()

        # Fetch custom local catalog if present
        local_catalog = {}
        if os.path.exists(CATALOG_PATH):
            try:
                with open(CATALOG_PATH, "r", encoding="utf-8") as f:
                    local_catalog = json.load(f)
            except Exception:
                pass

        annotated_categories = {}

        # Categories mapping
        valid_cats = ["generative", "embedding", "reranker"]
        if category and category.lower() in valid_cats:
            categories_to_process = [category.lower()]
        else:
            categories_to_process = valid_cats

        for cat in categories_to_process:
            use_case_filter = None
            if cat == "generative":
                use_case_filter = None  # Returns top general, chat, coding & reasoning models
            elif cat == "embedding":
                use_case_filter = "embedding"
            elif cat == "reranker":
                use_case_filter = "embedding"

            # Call Odysseus rank_models for hardware fitting
            ranked = rank_models(
                sys_info,
                use_case=use_case_filter,
                limit=limit,
                search=search,
                quant=quant
            )

            # Format items for frontend display
            formatted_items = []
            seen_repos = set()

            for m in ranked:
                repo_id = m.get("name")
                seen_repos.add(repo_id.lower())
                is_active = cat in ACTIVE_PROCESSES and ACTIVE_PROCESSES[cat].get("model_id") == repo_id
                
                formatted_items.append({
                    "name": repo_id.split("/")[-1] if "/" in repo_id else repo_id,
                    "repo_id": repo_id,
                    "provider": m.get("provider", "HuggingFace"),
                    "parameter_count": m.get("parameter_count", "8B"),
                    "use_case": m.get("use_case", "general"),
                    "fit_badge": m.get("fit_level", "good"),
                    "run_mode": m.get("run_mode", "metal"),
                    "quant": m.get("quant", "Q4_K_M"),
                    "est_tps": round(m.get("speed_tps") or 15.0, 1),
                    "required_gb": round(m.get("required_gb") or 4.0, 1),
                    "description": m.get("description", f"{m.get('parameter_count', '8B')} model"),
                    "active": is_active,
                    "gguf_sources": m.get("gguf_sources", [])
                })

            # If user entered a search query, query HuggingFace REST API dynamically like a real-time search engine!
            if search and search.strip():
                try:
                    search_clean = search.strip()
                    hf_search_url = f"https://huggingface.co/api/models?search={urllib.parse.quote(search_clean)}&limit=15"
                    req = urllib.request.Request(hf_search_url, headers={"User-Agent": "GeoRhizome/1.0"})
                    with urllib.request.urlopen(req, timeout=8) as resp:
                        hf_models = json.loads(resp.read().decode("utf-8"))

                    for hfm in hf_models:
                        h_id = hfm.get("id", "")
                        if h_id.lower() not in seen_repos:
                            seen_repos.add(h_id.lower())
                            q_type = "Safetensors/FP16" if cat in ["embedding", "reranker"] or "ruri" in h_id.lower() or "bge" in h_id.lower() else (quant or "Q4_K_M")
                            analysis = analyze_model(
                                {"name": h_id, "parameters_raw": 310_000_000 if cat in ["embedding", "reranker"] else 8_000_000_000, "parameter_count": "310M" if cat in ["embedding", "reranker"] else "8B"},
                                sys_info,
                                target_quant=q_type
                            ) or {}

                            is_act = cat in ACTIVE_PROCESSES and ACTIVE_PROCESSES[cat].get("model_id") == h_id
                            formatted_items.insert(0, {
                                "name": h_id.split("/")[-1] if "/" in h_id else h_id,
                                "repo_id": h_id,
                                "provider": h_id.split("/")[0] if "/" in h_id else "HuggingFace",
                                "parameter_count": "310M" if cat in ["embedding", "reranker"] else "8B",
                                "use_case": cat,
                                "fit_badge": analysis.get("fit_level", "good"),
                                "run_mode": analysis.get("run_mode", "metal"),
                                "quant": q_type.upper(),
                                "est_tps": round(analysis.get("speed_tps") or (45.0 if cat in ["embedding", "reranker"] else 9.8), 1),
                                "required_gb": round(analysis.get("required_gb") or (0.8 if cat in ["embedding", "reranker"] else 4.5), 1),
                                "description": f"Live HuggingFace model ({h_id})",
                                "active": is_act,
                                "gguf_sources": []
                            })
                except Exception as e:
                    print("[Search Engine Error] HuggingFace live search query failed:", e)

            # Append custom local catalog models
            if cat in local_catalog:
                for item in local_catalog[cat]:
                    if item.get("repo_id", "").lower() not in seen_repos:
                        seen_repos.add(item.get("repo_id", "").lower())
                        default_q = quant or item.get("default_quant", "Q4_K_M").upper()
                        params_raw = 8_000_000_000
                        if "3B" in item.get("name", ""):
                            params_raw = 3_000_000_000
                        elif "310M" in item.get("name", ""):
                            params_raw = 310_000_000
                        
                        analysis = analyze_model(
                            {"name": item.get("name"), "parameters_raw": params_raw, "parameter_count": "8B"},
                            sys_info,
                            target_quant=default_q
                        ) or {}

                        is_active = cat in ACTIVE_PROCESSES and ACTIVE_PROCESSES[cat].get("model_id") == item.get("repo_id")
                        
                        formatted_items.insert(0, {
                            "name": item.get("name"),
                            "repo_id": item.get("repo_id"),
                            "provider": "Tokyo Tech / HuggingFace",
                            "parameter_count": "310M" if "310M" in item.get("name", "") else "8B",
                            "use_case": item.get("use_case", "reasoning"),
                            "fit_badge": analysis.get("fit_level", "good"),
                            "run_mode": analysis.get("run_mode", "metal"),
                            "quant": default_q,
                            "est_tps": round(analysis.get("speed_tps") or 12.0, 1),
                            "required_gb": round(analysis.get("required_gb") or 4.5, 1),
                            "description": item.get("description", ""),
                            "active": is_active,
                            "gguf_sources": item.get("files", {})
                        })

            annotated_categories[cat] = formatted_items

        return {"status": "ok", "system": sys_info, "catalog": annotated_categories}

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/hardware/hf-files")
def hf_files(repo_id: str = Query(...)):
    """Fetch GGUF files for a given HuggingFace repository or general search query."""
    try:
        import urllib.request, urllib.parse
        sys_info = detect_system()
        gguf_files = []

        clean_query = repo_id.strip()
        if "/" in clean_query:
            # Direct repository inspection
            url = f"https://huggingface.co/api/models/{urllib.parse.quote(clean_query, safe='/')}"
            req = urllib.request.Request(url, headers={"User-Agent": "GeoRhizome/1.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))

            siblings = data.get("siblings", [])
            model_files = [s.get("rfilename", "") for s in siblings if any(s.get("rfilename", "").endswith(ext) for ext in [".gguf", ".safetensors", ".bin", ".onnx", "config.json"])]
            
            if model_files:
                for r_filename in model_files:
                    if r_filename.endswith(".gguf") or r_filename.endswith(".safetensors") or r_filename.endswith(".bin") or r_filename.endswith(".onnx") or r_filename == "config.json":
                        quant = "Q4_K_M" if ".gguf" in r_filename else "Safetensors/FP16"
                        analysis = analyze_model(
                            {"name": r_filename, "parameters_raw": 310_000_000, "parameter_count": "310M"},
                            sys_info,
                            target_quant=quant
                        ) or {}
                        gguf_files.append({
                            "filename": r_filename,
                            "repo_id": clean_query,
                            "size_mb": 620.0 if "310m" in clean_query.lower() else 4500.0,
                            "quant": quant.upper(),
                            "est_tps": round(analysis.get("speed_tps") or 45.0, 1),
                            "required_gb": round(analysis.get("required_gb") or 0.8, 1),
                            "fit_badge": analysis.get("fit_level", "good")
                        })
            else:
                analysis = analyze_model(
                    {"name": clean_query, "parameters_raw": 310_000_000, "parameter_count": "310M"},
                    sys_info,
                    target_quant="Safetensors"
                ) or {}
                gguf_files.append({
                    "filename": f"{clean_query.split('/')[-1]}.safetensors",
                    "repo_id": clean_query,
                    "size_mb": 620.0,
                    "quant": "SAFETENSORS",
                    "est_tps": round(analysis.get("speed_tps") or 45.0, 1),
                    "required_gb": round(analysis.get("required_gb") or 0.8, 1),
                    "fit_badge": analysis.get("fit_level", "good")
                })
        else:
            # Search across all Hugging Face repositories for matching models
            search_url = f"https://huggingface.co/api/models?search={urllib.parse.quote(clean_query)}&limit=15"
            req = urllib.request.Request(search_url, headers={"User-Agent": "GeoRhizome/1.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                models_found = json.loads(resp.read().decode("utf-8"))

            for m in models_found:
                m_id = m.get("id", "")
                analysis = analyze_model(
                    {"name": m_id, "parameters_raw": 8_000_000_000, "parameter_count": "8B"},
                    sys_info,
                    target_quant="Q4_K_M"
                ) or {}
                gguf_files.append({
                    "filename": f"{m_id.split('/')[-1]}.Q4_K_M.gguf",
                    "repo_id": m_id,
                    "size_mb": 4500.0,
                    "quant": "Q4_K_M",
                    "est_tps": round(analysis.get("speed_tps") or 9.8, 1),
                    "required_gb": round(analysis.get("required_gb") or 5.4, 1),
                    "fit_badge": analysis.get("fit_level", "good")
                })

        return {"status": "ok", "repo_id": clean_query, "files": gguf_files}
    except Exception as e:
        import traceback
        traceback.print_exc()
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
        target_fn = req.filename or f"{req.repo_id.split('/')[-1]}.Q4_K_M.gguf"
        ACTIVE_DOWNLOAD_STATE["is_downloading"] = True
        ACTIVE_DOWNLOAD_STATE["filename"] = target_fn
        ACTIVE_DOWNLOAD_STATE["target_model"] = req.repo_id
        ACTIVE_DOWNLOAD_STATE["start_time"] = time.time()
        try:
            from huggingface_hub import hf_hub_download
            print(f"[HardwareServer] Downloading GGUF {target_fn} from HF {req.repo_id}...")
            hf_hub_download(repo_id=req.repo_id, filename=target_fn if req.filename else None, local_dir=MODELS_CACHE_DIR)
            DOWNLOAD_JOBS[job_id]["status"] = "complete"
            DOWNLOAD_JOBS[job_id]["progress"] = 100
            DOWNLOAD_JOBS[job_id]["message"] = "Download complete!"
        except Exception as e:
            print(f"[HardwareServer] Download error: {e}")
            DOWNLOAD_JOBS[job_id]["status"] = "error"
            DOWNLOAD_JOBS[job_id]["message"] = str(e)
        finally:
            ACTIVE_DOWNLOAD_STATE["is_downloading"] = False

    bg_tasks.add_task(_async_download)
    return {"status": "started", "job_id": job_id}

ACTIVE_DOWNLOAD_STATE = {"is_downloading": False, "filename": "", "target_model": "", "start_time": 0}

@app.post("/hardware/serve")
def serve_model(req: ServeRequest, background_tasks: BackgroundTasks):
    """1-Click Onload model into local server."""
    cat = req.category.lower()

    if cat == "reranker":
        try:
            pids = subprocess.check_output("lsof -ti:8001", shell=True, text=True).strip()
            if pids:
                for p in pids.splitlines():
                    subprocess.run(f"kill -9 {p}", shell=True)
        except Exception:
            pass

        reranker_script = os.path.abspath(os.path.join(os.path.dirname(__file__), "local_reranker_server.py"))
        env = os.environ.copy()
        if req.model_id:
            env["RERANKER_MODEL_PREF"] = req.model_id
        p = subprocess.Popen([sys.executable, reranker_script], env=env)
        ACTIVE_PROCESSES["reranker"] = {"pid": p.pid, "model_id": req.model_id, "name": req.model_id, "port": 8001, "start_time": time.time(), "alive": True}
        
        # Enable reranker in retrieval.yaml
        try:
            ret_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "config", "retrieval.yaml"))
            if os.path.exists(ret_path):
                with open(ret_path, "r", encoding="utf-8") as f:
                    ydata = yaml.safe_load(f) or {}
                if "retrieval" in ydata:
                    ydata["retrieval"]["reranker_enabled"] = True
                    with open(ret_path, "w", encoding="utf-8") as f:
                        yaml.dump(ydata, f)
        except Exception as e:
            print(f"[HardwareServer Error] Failed to update retrieval.yaml: {e}")

        update_retrieval_reranker(True, req.model_id)
        save_active_state()
        return {"status": "ok", "message": f"Successfully loaded reranker {req.model_id} on port 8001", "pid": p.pid}

    elif cat == "embedding":
        try:
            pids = subprocess.check_output("lsof -ti:8000", shell=True, text=True).strip()
            if pids:
                for p in pids.splitlines():
                    subprocess.run(f"kill -9 {p}", shell=True)
        except Exception:
            pass

        bge_script = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "local_bge_server.py"))
        env = os.environ.copy()
        if req.model_id:
            env["EMBEDDING_MODEL_PREF"] = req.model_id
        p = subprocess.Popen([sys.executable, bge_script], env=env)
        ACTIVE_PROCESSES["embedding"] = {"pid": p.pid, "model_id": req.model_id, "name": req.model_id, "port": 8000, "start_time": time.time(), "alive": True}
        
        # Automatically probe live model for runtime dimension and update configs
        background_tasks.add_task(probe_and_sync_embedder, req.model_id)
        save_active_state()
        return {"status": "ok", "message": f"Successfully loaded embedder {req.model_id} on port 8000", "pid": p.pid}

    elif cat == "generative":
        default_model = "Qwen3-0.6B-Q8_0.gguf"
        app_cfg_path = os.path.join(ROOT_DIR, "config", "app_config.json")
        if os.path.exists(app_cfg_path):
            try:
                with open(app_cfg_path, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                    default_model = cfg.get("llm", {}).get("model_name") or default_model
            except Exception:
                pass
        actual_model_id = req.model_id or req.repo_id or default_model
        update_app_config_llm(actual_model_id, 16384)
        # Kill any old listener on port 8003
        try:
            pids = subprocess.check_output("lsof -ti:8003", shell=True, text=True).strip()
            if pids:
                for p in pids.splitlines():
                    subprocess.run(f"kill -9 {p}", shell=True)
        except Exception:
            pass

        # Look up model filename in catalog if present and ensure local download
        catalog_data = {}
        if os.path.exists(CATALOG_PATH):
            try:
                with open(CATALOG_PATH, "r", encoding="utf-8") as f:
                    catalog_data = json.load(f)
            except Exception:
                pass

        target_file = None
        for m in catalog_data.get("generative", []):
            if m.get("repo_id") == actual_model_id:
                quant_key = (req.quant or "").lower().replace("-", "_")
                target_file = m.get("files", {}).get(quant_key) or m.get("files", {}).get("q4_k_m")
                break

        if not target_file:
            try:
                import requests
                r = requests.get(f"https://huggingface.co/api/models/{actual_model_id}", timeout=5)
                if r.status_code == 200:
                    siblings = r.json().get("siblings", [])
                    ggufs = [f["rfilename"] for f in siblings if f.get("rfilename", "").endswith(".gguf")]
                    if ggufs:
                        q_target = (req.quant or "Q4_K_M").lower().replace("-", "_")
                        matched = [f for f in ggufs if q_target in f.lower()]
                        target_file = matched[0] if matched else ggufs[0]
            except Exception as e:
                print(f"[HardwareServer] HF API resolution error: {e}")

        models_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "models"))
        os.makedirs(models_dir, exist_ok=True)

        is_mlx = "mlx" in actual_model_id.lower() or (req.quant and "mlx" in req.quant.lower())

        def run_gguf_serve_task():
            nonlocal target_file
            if is_mlx:
                # MLX Model Serving Flow (mlx_lm server)
                model_folder_name = actual_model_id.split("/")[-1]
                mlx_model_path = os.path.join(models_dir, model_folder_name)
                ACTIVE_DOWNLOAD_STATE["is_downloading"] = True
                ACTIVE_DOWNLOAD_STATE["filename"] = model_folder_name
                ACTIVE_DOWNLOAD_STATE["target_model"] = actual_model_id
                ACTIVE_DOWNLOAD_STATE["start_time"] = time.time()
                try:
                    from huggingface_hub import snapshot_download
                    print(f"[HardwareServer] Downloading MLX model weights for {actual_model_id} into {mlx_model_path}...")
                    snapshot_download(repo_id=actual_model_id, local_dir=mlx_model_path)
                except Exception as e:
                    print(f"[HardwareServer] MLX download error: {e}")
                    ACTIVE_DOWNLOAD_STATE["error"] = str(e)
                finally:
                    ACTIVE_DOWNLOAD_STATE["is_downloading"] = False

                cmd = [
                    sys.executable, "-m", "mlx_lm", "server",
                    "--model", mlx_model_path,
                    "--port", "8003",
                    "--host", "127.0.0.1"
                ]
                p = subprocess.Popen(cmd)
                ACTIVE_PROCESSES["generative"] = {
                    "pid": p.pid,
                    "model_id": actual_model_id,
                    "name": actual_model_id,
                    "quant": req.quant or "MLX-4bit",
                    "port": 8003,
                    "start_time": time.time(),
                    "alive": True
                }
                save_active_state()
                return

            # 1. Check if model already exists locally in models/ directory
            local_direct_path = os.path.join(models_dir, req.model_id)
            has_valid_weights = False
            if os.path.exists(local_direct_path):
                if os.path.isfile(local_direct_path):
                    has_valid_weights = True
                elif os.path.isdir(local_direct_path):
                    # Check for .safetensors files inside directory
                    for root, _, files in os.walk(local_direct_path):
                        if any(f.endswith(".safetensors") for f in files):
                            has_valid_weights = True
                            break

            if has_valid_weights:
                print(f"[HardwareServer] Serving existing local model file directly from {local_direct_path}...")
                is_mlx_local = os.path.isdir(local_direct_path) or "mlx" in req.model_id.lower() or req.model_id.endswith(".safetensors")
                if is_mlx_local:
                    cmd = [sys.executable, "-m", "mlx_lm", "server", "--model", local_direct_path, "--port", "8003", "--host", "127.0.0.1"]
                else:
                    cmd = [sys.executable, "-m", "llama_cpp.server", "--model", local_direct_path, "--n_ctx", "16384", "--n_gpu_layers", "-1", "--port", "8003", "--host", "127.0.0.1"]
                
                p = subprocess.Popen(cmd)
                ACTIVE_PROCESSES["generative"] = {
                    "pid": p.pid,
                    "model_id": req.model_id,
                    "name": req.model_id,
                    "quant": req.quant or ("MLX" if is_mlx_local else "GGUF"),
                    "port": 8003,
                    "start_time": time.time(),
                    "alive": True
                }
                background_tasks.add_task(probe_and_sync_llm, req.model_id, 16384)
                save_active_state()
                return

            # GGUF Model Download & Serving Flow (llama_cpp.server)
            if not target_file:
                try:
                    import requests
                    r = requests.get(f"https://huggingface.co/api/models/{req.model_id}", timeout=10)
                    if r.status_code == 200:
                        siblings = r.json().get("siblings", [])
                        ggufs = [f["rfilename"] for f in siblings if f.get("rfilename", "").endswith(".gguf")]
                        if ggufs:
                            q_target = (req.quant or "Q4_K_M").lower().replace("-", "_")
                            matched = [f for f in ggufs if q_target in f.lower()]
                            target_file = matched[0] if matched else ggufs[0]
                except Exception as e:
                    print(f"[HardwareServer] HF API resolution error: {e}")

            if not target_file:
                target_file = f"{req.model_id.split('/')[-1]}.Q4_K_M.gguf"

            model_path = os.path.join(models_dir, target_file)
            if os.path.exists(model_path):
                print(f"[HardwareServer] Model file {target_file} already exists on disk. Serving directly...")
                cmd = [sys.executable, "-m", "llama_cpp.server", "--model", model_path, "--n_ctx", "16384", "--n_gpu_layers", "-1", "--port", "8003", "--host", "127.0.0.1"]
                p = subprocess.Popen(cmd)
                ACTIVE_PROCESSES["generative"] = {
                    "pid": p.pid,
                    "model_id": req.model_id,
                    "name": req.model_id,
                    "quant": req.quant or "GGUF",
                    "port": 8003,
                    "start_time": time.time(),
                    "alive": True
                }
                background_tasks.add_task(probe_and_sync_llm, req.model_id, 16384)
                save_active_state()
                return

            ACTIVE_DOWNLOAD_STATE["is_downloading"] = True
            ACTIVE_DOWNLOAD_STATE["filename"] = target_file
            ACTIVE_DOWNLOAD_STATE["target_model"] = req.model_id
            ACTIVE_DOWNLOAD_STATE["start_time"] = time.time()
            try:
                from huggingface_hub import hf_hub_download
                print(f"[HardwareServer] Downloading single GGUF file {target_file} for {req.model_id}...")
                hf_hub_download(
                    repo_id=req.model_id,
                    filename=target_file,
                    local_dir=models_dir
                )
            except Exception as e:
                print(f"[HardwareServer] GGUF download error: {e}")
                ACTIVE_DOWNLOAD_STATE["error"] = str(e)
            finally:
                ACTIVE_DOWNLOAD_STATE["is_downloading"] = False

            if os.path.exists(model_path):
                cmd = [
                    sys.executable, "-m", "llama_cpp.server",
                    "--model", model_path,
                    "--n_ctx", "16384",
                    "--n_gpu_layers", "-1",
                    "--port", "8003",
                    "--host", "127.0.0.1"
                ]
                p = subprocess.Popen(cmd)
                ACTIVE_PROCESSES["generative"] = {
                    "pid": p.pid,
                    "model_id": req.model_id,
                    "name": req.model_id,
                    "quant": req.quant,
                    "port": 8003,
                    "start_time": time.time(),
                    "alive": True
                }
                background_tasks.add_task(probe_and_sync_llm, req.model_id, 16384)
                save_active_state()
            else:
                print(f"[HardwareServer] Error: Model file {model_path} could not be downloaded.")

        background_tasks.add_task(run_gguf_serve_task)
        return {"status": "ok", "message": f"Successfully initiated onboarding for {req.model_id} on Port 8003"}

    raise HTTPException(status_code=400, detail=f"Unknown category: {cat}")

@app.post("/hardware/offload")
def offload_model(req: OffloadRequest):
    """1-Click Offload model to free VRAM/RAM immediately."""
    cat = req.category.lower()

    if cat == "embedding":
        # Kill processes listening on port 8000 (Fast-BGE Embedder)
        try:
            pids = subprocess.check_output("lsof -ti:8000", shell=True, text=True).strip()
            if pids:
                for p in pids.splitlines():
                    subprocess.run(f"kill -9 {p}", shell=True)
        except Exception:
            pass
        ACTIVE_PROCESSES["embedding"] = {
            "model_id": "Offloaded",
            "name": "No Embedder Loaded (Offloaded)",
            "port": 8000,
            "alive": False
        }
        save_active_state()
        update_app_config_embedding("Offloaded", 0)
        return {"status": "ok", "message": "Successfully offloaded BGE embedder from Port 8000 and reclaimed RAM/VRAM."}

    elif cat == "reranker":
        # Kill processes listening on port 8001 (Reranker)
        try:
            pids = subprocess.check_output("lsof -ti:8001", shell=True, text=True).strip()
            if pids:
                for p in pids.splitlines():
                    subprocess.run(f"kill -9 {p}", shell=True)
        except Exception:
            pass
        ACTIVE_PROCESSES["reranker"] = {
            "model_id": "Offloaded",
            "name": "No Reranker Loaded (Offloaded)",
            "port": 8001,
            "alive": False
        }
        save_active_state()
        update_retrieval_reranker(False, "Offloaded")
        return {"status": "ok", "message": "Successfully offloaded Reranker from Port 8001 and reclaimed RAM/VRAM."}

    elif cat == "generative":
        # Kill process listening on port 8003 (Chat LLM Server)
        try:
            pids = subprocess.check_output("lsof -ti:8003", shell=True, text=True).strip()
            if pids:
                for p in pids.splitlines():
                    subprocess.run(f"kill -9 {p}", shell=True)
        except Exception:
            pass
        ACTIVE_PROCESSES["generative"] = {
            "model_id": "Offloaded",
            "name": "No Generative LLM Loaded (Offloaded)",
            "port": 8003,
            "alive": False
        }
        save_active_state()
        update_app_config_llm("Offloaded", 0)
        return {"status": "ok", "message": "Successfully offloaded Generative LLM from Port 8003 and reclaimed RAM/VRAM."}

@app.post("/hardware/cancel_download")
def cancel_download():
    """Cancel all active GGUF download requests and purge .cache directory."""
    ACTIVE_DOWNLOAD_STATE["is_downloading"] = False
    ACTIVE_DOWNLOAD_STATE["filename"] = ""
    ACTIVE_DOWNLOAD_STATE["target_model"] = ""
    cache_dir = os.path.join(MODELS_CACHE_DIR, ".cache")
    if os.path.exists(cache_dir):
        try:
            shutil.rmtree(cache_dir)
        except Exception:
            pass
    return {"status": "ok", "message": "All download requests cancelled and temporary download cache purged."}

@app.post("/hardware/purge_cache")
def purge_model_cache():
    """Purge all downloaded GGUF files and caches sitting in models/ directory."""
    ACTIVE_DOWNLOAD_STATE["is_downloading"] = False
    ACTIVE_DOWNLOAD_STATE["filename"] = ""
    ACTIVE_DOWNLOAD_STATE["target_model"] = ""
    models_dir = MODELS_CACHE_DIR
    deleted_count = 0
    if os.path.exists(models_dir):
        for item in os.listdir(models_dir):
            fp = os.path.join(models_dir, item)
            try:
                if os.path.isfile(fp) or os.path.islink(fp):
                    os.unlink(fp)
                    deleted_count += 1
                elif os.path.isdir(fp):
                    shutil.rmtree(fp)
                    deleted_count += 1
            except Exception:
                pass
    return {"status": "ok", "message": f"Successfully purged model cache and deleted {deleted_count} items."}

@app.post("/hardware/download")
def download_model_endpoint(req: ServeRequest, background_tasks: BackgroundTasks):
    """Download and onboard model endpoint alias."""
    return serve_model(req, background_tasks)

DOWNLOAD_JOBS: Dict[str, Any] = {}

def get_formatted_size(bytes_size: int) -> str:
    if bytes_size >= 1024 ** 3:
        return f"{bytes_size / (1024 ** 3):.2f} GB"
    elif bytes_size >= 1024 ** 2:
        return f"{bytes_size / (1024 ** 2):.1f} MB"
    elif bytes_size >= 1024:
        return f"{bytes_size / 1024:.0f} KB"
    return f"{bytes_size} B"

@app.get("/hardware/downloaded")
def list_downloaded_files():
    """List all downloaded model binary files sitting in models/ directory."""
    files_list = []
    models_dir = MODELS_CACHE_DIR
    if os.path.exists(models_dir):
        for root, dirs, files in os.walk(models_dir):
            if ".cache" in root:
                continue
            for f in files:
                if f.endswith(".gguf") or f.endswith(".safetensors") or f.endswith(".bin"):
                    fp = os.path.join(root, f)
                    if os.path.isfile(fp):
                        sz = os.path.getsize(fp)
                        if sz > 1024 * 1024:  # Only count real model binaries > 1MB
                            files_list.append({
                                "filename": f,
                                "filepath": fp,
                                "size_bytes": sz,
                                "size_formatted": get_formatted_size(sz)
                            })
    return {"status": "ok", "files": files_list}

@app.delete("/hardware/downloaded/{filename:path}")
def delete_downloaded_file(filename: str):
    """Permanently delete a downloaded GGUF/model file from models/ directory."""
    fp = os.path.join(MODELS_CACHE_DIR, filename)
    if os.path.exists(fp) and os.path.isfile(fp):
        try:
            os.remove(fp)
            return {"status": "ok", "message": f"Successfully deleted {filename} from disk."}
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to delete file: {e}")
    raise HTTPException(status_code=404, detail=f"File {filename} not found.")

def is_port_active(port: Optional[int]) -> bool:
    if not port:
        return False
    try:
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.2)
            return s.connect_ex(('127.0.0.1', port)) == 0
    except Exception:
        return False

@app.get("/hardware/status")
def hardware_status():
    """Get active processes and background download jobs."""
    active_summary = {}
    for cat, info in ACTIVE_PROCESSES.items():
        mid = info.get("model_id", "Offloaded")
        is_alive = mid != "Offloaded" and info.get("alive", True)

        active_summary[cat] = {
            "model_id": mid,
            "name": info.get("name", mid),
            "quant": info.get("quant", "FP16"),
            "port": info.get("port"),
            "alive": is_alive
        }

    # Scan models/.cache for active download metrics if ACTIVE_DOWNLOAD_STATE is active
    downloads_info = {"is_downloading": False, "files": []}
    if ACTIVE_DOWNLOAD_STATE.get("is_downloading"):
        start_t = ACTIVE_DOWNLOAD_STATE.get("start_time", 0)
        total_dl = 0
        cache_download_dir = os.path.join(MODELS_CACHE_DIR, ".cache", "huggingface", "download")
        if os.path.exists(cache_download_dir):
            for f in os.listdir(cache_download_dir):
                if f.endswith(".incomplete"):
                    fp = os.path.join(cache_download_dir, f)
                    if os.path.isfile(fp):
                        try:
                            # Count if modified after start_time or within last 10 minutes
                            mtime = os.path.getmtime(fp)
                            if mtime >= start_t - 5:
                                total_dl += os.path.getsize(fp)
                        except Exception:
                            pass

        fn = ACTIVE_DOWNLOAD_STATE.get("filename") or "GGUF model"
        formatted_sz = get_formatted_size(total_dl) if total_dl > 0 else "Connecting..."
        status_msg = f"Downloading {fn} from HuggingFace ({formatted_sz})..." if total_dl > 0 else f"Connecting to HuggingFace to download {fn}..."

        downloads_info = {
            "is_downloading": True,
            "filename": fn,
            "target_model": ACTIVE_DOWNLOAD_STATE.get("target_model"),
            "downloaded_bytes": total_dl,
            "downloaded_formatted": formatted_sz,
            "status_text": status_msg
        }

    return {
        "status": "ok",
        "active_processes": active_summary,
        "downloads": downloads_info
    }

if __name__ == "__main__":
    port = int(os.getenv("HARDWARE_SERVER_PORT", "8002"))
    print(f"🚀 Launching GeoRhizome Hardware & Model Hub Server on http://127.0.0.1:{port} ...")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
