from __future__ import annotations

import json
import os
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(REPO, "installers"))

import georhizome_setup as gs  # noqa: E402

DEF_FILE = "Qwen2.5-1.5B-Instruct-Q3_K_M.gguf"
OLD = "Qwen3.5" + "-0.8B-Japanese-SFT-v2-Q4_K_M.gguf"


def _am(d, model_id):
    p = os.path.join(d, "active_models.json")
    json.dump({"generative": {"model_id": model_id, "name": model_id, "port": 8003, "pid": 1}}, open(p, "w"))
    return p


def test_default_artifacts(tmp_config_dir):
    a = gs.default_artifacts(tmp_config_dir)
    assert a["llm_file"] == DEF_FILE and a["embedding"] == "cl-nagoya/ruri-v3-310m"
    assert a["reranker"] == "cl-nagoya/ruri-v3-reranker-310m"


def test_llm_file_prefers_active_custom_and_skips_legacy(tmp_config_dir):
    _am(tmp_config_dir, "custom.gguf")
    assert gs.resolve_llm_file(tmp_config_dir) == "custom.gguf"
    _am(tmp_config_dir, OLD)
    assert gs.resolve_llm_file(tmp_config_dir) == DEF_FILE
    os.remove(os.path.join(tmp_config_dir, "active_models.json"))
    assert gs.resolve_llm_file(tmp_config_dir) == DEF_FILE


def test_migrate_only_legacy(tmp_config_dir, tmp_path):
    env = tmp_path / ".env"
    env.write_text(f"X=1\nGENERIC_OPEN_AI_MODEL_PREF={OLD}\n", encoding="utf-8")
    am = _am(tmp_config_dir, OLD)
    res = gs.migrate(str(env), tmp_config_dir)
    assert res == {"env": True, "active_models": True}
    assert f"GENERIC_OPEN_AI_MODEL_PREF={DEF_FILE}" in env.read_text(encoding="utf-8")
    g = json.load(open(am))["generative"]
    assert g["model_id"] == DEF_FILE and "pid" not in g
    env.write_text("GENERIC_OPEN_AI_MODEL_PREF=mine.gguf\n", encoding="utf-8")
    _am(tmp_config_dir, "mine.gguf")
    assert gs.migrate(str(env), tmp_config_dir) == {"env": False, "active_models": False}
    assert env.read_text(encoding="utf-8") == "GENERIC_OPEN_AI_MODEL_PREF=mine.gguf\n"


def test_write_env_no_bom_and_keeps_existing(tmp_config_dir, tmp_path, monkeypatch):
    monkeypatch.setattr(gs, "CONFIG_DIR", tmp_config_dir)
    env = tmp_path / "server" / ".env"
    assert gs.cmd_write_env(str(env)) == 0
    raw = env.read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf") and b"\r\n" not in raw
    assert f"GENERIC_OPEN_AI_MODEL_PREF={DEF_FILE}".encode() in raw
    env.write_text("CUSTOM=1\n")
    gs.cmd_write_env(str(env))
    assert env.read_text() == "CUSTOM=1\n"
