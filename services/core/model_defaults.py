"""Default generative-model resolution shared by hardware_server and the installer helper.

Stdlib only. The source of truth is config/app_config.json `llm` (model_name, repo_id,
filename) and config/model_catalog.json; FALLBACK_LLM is the documented fallback used
only when config is missing (e.g. installer bootstrap).
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

FALLBACK_LLM: Dict[str, str] = {
    "model_name": "Q8_0-00001-of-00002.gguf",
    "repo_id": "webbigdata/Qwen3-0.6B_WBD",
    "filename": "Q8_0-00001-of-00002.gguf",
}

ENV_KEY = "GENERIC_OPEN_AI_MODEL_PREF"


def default_llm(app_cfg: Optional[Dict[str, Any]]) -> Dict[str, str]:
    """Return {model_name, repo_id, filename} from app_config `llm`, filling gaps from FALLBACK_LLM."""
    llm = (app_cfg or {}).get("llm") or {}
    out = dict(FALLBACK_LLM)
    for k in ("model_name", "repo_id", "filename"):
        v = llm.get(k)
        if isinstance(v, str) and v.strip():
            out[k] = v.strip()
    return out


def _quant_key(quant: Optional[str]) -> str:
    return (quant or "").strip().lower().replace("-", "_")


def resolve_generative(model_id: Optional[str], quant: Optional[str], catalog: Optional[Dict[str, Any]]) -> Tuple[Optional[str], Optional[str]]:
    """Map a repo id or a GGUF filename to (repo_id, filename) via the catalog.

    Quant preference: requested quant if the entry has it, else the entry's default_quant,
    else the first listed file. Returns (None, None) when the model is not catalogued.
    """
    if not model_id:
        return None, None
    for m in (catalog or {}).get("generative", []) or []:
        files: Dict[str, str] = m.get("files") or {}
        repo = m.get("repo_id")
        if repo == model_id:
            f = files.get(_quant_key(quant)) or files.get(_quant_key(m.get("default_quant"))) or next(iter(files.values()), None)
            return repo, f
        if model_id in files.values():
            return repo, model_id
    return None, None


def split_gguf_id(model_id: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """Split an uncatalogued id into (repo_id, filename).

    "file.gguf" -> (None, "file.gguf"); "owner/repo/file.gguf" -> ("owner/repo", "file.gguf");
    "owner/repo" -> ("owner/repo", None).
    """
    if not model_id:
        return None, None
    if not model_id.lower().endswith(".gguf"):
        return model_id, None
    parts = model_id.split("/")
    if len(parts) >= 3:
        return "/".join(parts[:2]), "/".join(parts[2:])
    return None, parts[-1]


def pick_repo_for_gguf(filename: str, search_results: List[Dict[str, Any]]) -> Optional[str]:
    """First HF search result whose siblings contain exactly this GGUF filename."""
    for m in search_results or []:
        names = {s.get("rfilename") for s in m.get("siblings") or []}
        if filename in names:
            return m.get("id")
    return None


def legacy_defaults(catalog: Optional[Dict[str, Any]]) -> List[str]:
    """Former default generative model names (catalog data `legacy_defaults.generative`)."""
    return list(((catalog or {}).get("legacy_defaults") or {}).get("generative") or [])


def migrate_env_text(text: str, legacy: List[str], new_default: str) -> Tuple[str, bool]:
    """Rewrite GENERIC_OPEN_AI_MODEL_PREF only when it equals a legacy default."""
    pat = re.compile(r"^(\s*" + ENV_KEY + r"\s*=\s*)(['\"]?)(.*?)\2\s*$")
    changed = False
    out: List[str] = []
    for line in text.splitlines(keepends=True):
        body = line.rstrip("\r\n")
        m = pat.match(body)
        if m and m.group(3) in legacy:
            out.append(f"{ENV_KEY}={new_default}" + line[len(body):])
            changed = True
        else:
            out.append(line)
    return "".join(out), changed
