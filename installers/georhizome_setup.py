#!/usr/bin/env python3
"""GeoRhizome installer/launcher helper (macOS, Linux, Windows). Run with the venv python.

  georhizome_setup.py download   --models-dir DIR   pre-download the 3 default models
  georhizome_setup.py llm-path   --models-dir DIR   print the GGUF path the launcher serves on :8003
  georhizome_setup.py write-env  --env PATH          create server/.env if missing (UTF-8, no BOM)
  georhizome_setup.py migrate    --env PATH          OTA: replace legacy default LLM only if still set

Defaults come from config/app_config.json (`llm`, `embedding`, `reranker`) and
config/model_catalog.json; literal fallbacks live in services/core/model_defaults.py.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.abspath(os.path.join(HERE, ".."))
CONFIG_DIR = os.environ.get("GEORHIZOME_CONFIG_DIR") or os.path.join(SOURCE, "config")
sys.path.insert(0, os.path.join(SOURCE, "services"))

from core import model_defaults as md  # noqa: E402

FALLBACK_EMBEDDER = "cl-nagoya/ruri-v3-310m"
FALLBACK_RERANKER = "cl-nagoya/ruri-v3-reranker-310m"


def _json(path: str) -> Dict[str, Any]:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def default_artifacts(config_dir: str = CONFIG_DIR) -> Dict[str, str]:
    cfg = _json(os.path.join(config_dir, "app_config.json"))
    llm = md.default_llm(cfg)
    return {
        "embedding": (cfg.get("embedding") or {}).get("model_name") or FALLBACK_EMBEDDER,
        "reranker": (cfg.get("reranker") or {}).get("model_name") or FALLBACK_RERANKER,
        "llm_repo": llm["repo_id"],
        "llm_file": llm["filename"],
    }


def _write_text(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:  # utf-8 = no BOM
        f.write(text)
    os.replace(tmp, path)


def gguf_shards(filename: str) -> List[str]:
    """All shard names of a split GGUF ("x-00001-of-00002.gguf"); [filename] when not split."""
    m = re.match(r"^(.*)-00001-of-(\d{5})\.gguf$", filename)
    if not m:
        return [filename]
    n = int(m.group(2))
    return [f"{m.group(1)}-{i:05d}-of-{m.group(2)}.gguf" for i in range(1, n + 1)]


def cmd_download(models_dir: str) -> int:
    from huggingface_hub import hf_hub_download, snapshot_download

    a = default_artifacts()
    os.makedirs(models_dir, exist_ok=True)
    print(f"-> Embedder: {a['embedding']} (HF cache)", flush=True)
    snapshot_download(a["embedding"])
    print(f"-> Reranker: {a['reranker']} (HF cache)", flush=True)
    snapshot_download(a["reranker"])
    print(f"-> LLM: {a['llm_repo']} / {a['llm_file']} -> {models_dir}", flush=True)
    for f in gguf_shards(a["llm_file"]):
        hf_hub_download(repo_id=a["llm_repo"], filename=f, local_dir=models_dir)
    path = os.path.join(models_dir, a["llm_file"])
    if not os.path.isfile(path):
        print(f"[ERROR] LLM file missing after download: {path}", file=sys.stderr)
        return 1
    return 0


def resolve_llm_file(config_dir: str = CONFIG_DIR) -> str:
    """GGUF filename to serve: active_models generative -> app_config llm -> fallback."""
    cfg = _json(os.path.join(config_dir, "app_config.json"))
    catalog = _json(os.path.join(config_dir, "model_catalog.json"))
    llm = md.default_llm(cfg)
    active = (_json(os.path.join(config_dir, "active_models.json")).get("generative") or {}).get("model_id")
    for cand in (active, llm["model_name"]):
        if not cand or cand in md.legacy_defaults(catalog):
            continue
        if cand.endswith(".gguf"):
            return os.path.basename(cand)
        _, f = md.resolve_generative(cand, None, catalog)
        if f:
            return f
    return llm["filename"]


def cmd_llm_path(models_dir: str) -> int:
    path = os.path.join(models_dir, resolve_llm_file())
    print(path)
    if not os.path.isfile(path):
        print(f"[ERROR] LLM model file not found: {path}", file=sys.stderr)
        return 1
    return 0


def env_text(config_dir: str = CONFIG_DIR) -> str:
    a = default_artifacts(config_dir)
    return "\n".join([
        "LLM_PROVIDER=generic-openai",
        "GENERIC_OPEN_AI_BASE_PATH=http://host.docker.internal:8003/v1",
        "GENERIC_OPEN_AI_API_KEY=sk-local",
        f"GENERIC_OPEN_AI_MODEL_PREF={a['llm_file']}",
        "EMBEDDING_ENGINE=generic-openai",
        "EMBEDDING_BASE_PATH=http://host.docker.internal:8000/v1",
        f"EMBEDDING_MODEL_PREF={a['embedding']}",
        "HARDWARE_SERVER_URL=http://host.docker.internal:8002",
        "VECTOR_DB=lancedb",
        "",
    ])


def cmd_write_env(env_path: str) -> int:
    if os.path.isfile(env_path) and os.path.getsize(env_path) > 0:
        print(f"[INFO] keeping existing {env_path}")
        return 0
    _write_text(env_path, env_text())
    print(f"[INFO] wrote {env_path}")
    return 0


def migrate(env_path: Optional[str], config_dir: str = CONFIG_DIR) -> Dict[str, bool]:
    catalog = _json(os.path.join(config_dir, "model_catalog.json"))
    legacy = md.legacy_defaults(catalog)
    new = default_artifacts(config_dir)["llm_file"]
    out = {"env": False, "active_models": False}
    if env_path and os.path.isfile(env_path):
        with open(env_path, encoding="utf-8-sig") as f:
            text, changed = md.migrate_env_text(f.read(), legacy, new)
        if changed:
            _write_text(env_path, text)
            out["env"] = True
    am_path = os.path.join(config_dir, "active_models.json")
    am = _json(am_path)
    gen = am.get("generative")
    if isinstance(gen, dict) and gen.get("model_id") in legacy:
        gen.update({"model_id": new, "name": new})
        gen.pop("pid", None)
        gen.pop("alive", None)
        _write_text(am_path, json.dumps(am, indent=2, ensure_ascii=False) + "\n")
        out["active_models"] = True
    return out


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["download", "llm-path", "write-env", "migrate"])
    ap.add_argument("--models-dir", default=os.path.join(SOURCE, "models"))
    ap.add_argument("--env", default=os.path.join(SOURCE, "georhizome-ai-source", "server", ".env"))
    a = ap.parse_args(argv)
    if a.command == "download":
        return cmd_download(a.models_dir)
    if a.command == "llm-path":
        return cmd_llm_path(a.models_dir)
    if a.command == "write-env":
        return cmd_write_env(a.env)
    res = migrate(a.env)
    print(f"[INFO] legacy default migration: {res}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
