from __future__ import annotations

import json
import os
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(REPO, "installers"))

import georhizome_setup as gs  # noqa: E402

DEF_FILE = "Q8_0-00001-of-00002.gguf"
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


def test_migrate_only_legacy(tmp_config_dir, tmp_path, monkeypatch):
    monkeypatch.setattr(gs.ram_profile, "detect_ram_gb", lambda: 16.0)
    env = tmp_path / ".env"
    env.write_text(f"X=1\nGENERIC_OPEN_AI_MODEL_PREF={OLD}\n", encoding="utf-8")
    am = _am(tmp_config_dir, OLD)
    res = gs.migrate(str(env), tmp_config_dir)
    assert res == {"env": True, "active_models": True}
    assert f"GENERIC_OPEN_AI_MODEL_PREF={DEF_FILE}" in env.read_text(encoding="utf-8")
    g = json.load(open(am))["generative"]
    assert g["model_id"] == DEF_FILE and "pid" not in g
    budget = "".join(f"{k}={v}\n" for k, v in gs.token_budget(gs.current_profile(tmp_config_dir)).items())
    env.write_text("GENERIC_OPEN_AI_MODEL_PREF=mine.gguf\n" + budget, encoding="utf-8")
    _am(tmp_config_dir, "mine.gguf")
    assert gs.migrate(str(env), tmp_config_dir) == {"env": False, "active_models": False}
    assert env.read_text(encoding="utf-8") == "GENERIC_OPEN_AI_MODEL_PREF=mine.gguf\n" + budget


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


def test_gguf_shards():
    assert gs.gguf_shards("a.gguf") == ["a.gguf"]
    assert gs.gguf_shards("Q8_0-00001-of-00002.gguf") == ["Q8_0-00001-of-00002.gguf", "Q8_0-00002-of-00002.gguf"]


def _mock_ram(monkeypatch, gb):
    monkeypatch.setattr(gs.ram_profile, "detect_ram_gb", lambda: gb)
    monkeypatch.setattr(gs, "IS_APPLE_SILICON", True)


def test_llm_args_low_and_high(tmp_config_dir, monkeypatch, capsys):
    monkeypatch.setattr(gs, "CONFIG_DIR", tmp_config_dir)
    _mock_ram(monkeypatch, 8.0)
    assert gs.cmd_llm_args() == 0
    out = capsys.readouterr().out.strip()
    assert out == "--n_ctx 8192 --type_k 8 --type_v 8 --flash_attn True"
    gs.cmd_llm_args(degrade=True)
    assert capsys.readouterr().out.strip() == "--n_ctx 8192"
    _mock_ram(monkeypatch, 16.0)
    gs.cmd_llm_args()
    assert capsys.readouterr().out.strip() == "--n_ctx 16384"


def test_write_env_and_migrate_token_budget(tmp_config_dir, tmp_path, monkeypatch):
    monkeypatch.setattr(gs, "CONFIG_DIR", tmp_config_dir)
    _mock_ram(monkeypatch, 8.0)
    env = tmp_path / ".env"
    gs.cmd_write_env(str(env))
    t = env.read_text()
    assert "GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT=5600" in t and "GENERIC_OPEN_AI_MAX_TOKENS=2048" in t
    old = tmp_path / "old.env"
    old.write_text("CUSTOM=1\nGENERIC_OPEN_AI_MODEL_TOKEN_LIMIT=16384")
    assert gs.migrate(str(old), tmp_config_dir)["env"] is True
    t1 = old.read_text()
    assert "CUSTOM=1" in t1 and "GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT=5600" in t1 and "GENERIC_OPEN_AI_MAX_TOKENS=2048" in t1
    assert t1.count("TOKEN_LIMIT") == 1
    assert gs.migrate(str(old), tmp_config_dir)["env"] is False  # idempotent
    assert old.read_text() == t1
