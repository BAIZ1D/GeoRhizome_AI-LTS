from __future__ import annotations

import json
import os

from core import model_defaults as md

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEF_REPO = "webbigdata/Qwen3-0.6B_WBD"
DEF_FILE = "Q8_0-00001-of-00002.gguf"


def _cfg(name):
    return json.load(open(os.path.join(REPO, "config", name), encoding="utf-8"))


def test_fallback_is_qwen3_wbd():
    assert md.FALLBACK_LLM["filename"] == DEF_FILE
    assert md.FALLBACK_LLM["repo_id"] == DEF_REPO


def test_default_llm_reads_config_then_falls_back():
    assert md.default_llm({"llm": {"model_name": "x.gguf", "repo_id": "a/b", "filename": "x.gguf"}})["filename"] == "x.gguf"
    d = md.default_llm({})
    assert d["filename"] == DEF_FILE and d["model_name"] == DEF_FILE


def test_repo_config_defaults_match():
    llm = _cfg("app_config.json")["llm"]
    assert (llm["model_name"], llm["repo_id"], llm["filename"]) == (DEF_FILE, DEF_REPO, DEF_FILE)
    assert _cfg("active_models.default.json")["generative"]["model_id"] == DEF_FILE


def test_catalog_has_default_with_explicit_filename():
    cat = _cfg("model_catalog.json")
    assert md.resolve_generative(DEF_REPO, None, cat) == (DEF_REPO, DEF_FILE)
    assert md.resolve_generative(DEF_REPO, "Q3_K_M", cat) == (DEF_REPO, DEF_FILE)
    # served by filename (what app_config.llm.model_name holds) resolves to its repo
    assert md.resolve_generative(DEF_FILE, None, cat) == (DEF_REPO, DEF_FILE)


def test_resolve_unknown_returns_none():
    assert md.resolve_generative("nobody/none", "Q4_K_M", {"generative": []}) == (None, None)


def test_legacy_defaults_from_catalog_and_migrate_env():
    legacy = md.legacy_defaults(_cfg("model_catalog.json"))
    assert len(legacy) >= 2 and DEF_FILE not in legacy
    old = legacy[0]
    text = f"A=1\nGENERIC_OPEN_AI_MODEL_PREF={old}\nB=2\n"
    new, changed = md.migrate_env_text(text, legacy, DEF_FILE)
    assert changed and f"GENERIC_OPEN_AI_MODEL_PREF={DEF_FILE}" in new and "A=1" in new and "B=2" in new
    custom = "GENERIC_OPEN_AI_MODEL_PREF=my-own.gguf\n"
    assert md.migrate_env_text(custom, legacy, DEF_FILE) == (custom, False)


def test_hardware_server_uses_shared_defaults():
    src = open(os.path.join(REPO, "services", "hardware_server.py"), encoding="utf-8").read()
    assert "model_defaults" in src
    assert "Qwen3" + "-0.6B" not in src
    assert "huggingface" + "-cli" not in src


def test_hardware_server_generative_fallback_and_catalog(tmp_config_dir, tmp_path, monkeypatch):
    import importlib

    import hardware_server

    hs = importlib.reload(hardware_server)
    monkeypatch.setattr(hs, "SERVER_ENV_PATH", str(tmp_path / "server.env"))

    def no_ports(*a, **k):
        raise FileNotFoundError("no lsof in test")

    monkeypatch.setattr(hs.subprocess, "check_output", no_ports)
    # app_config without llm block -> fallback default
    p = os.path.join(tmp_config_dir, "app_config.json")
    cfg = json.load(open(p, encoding="utf-8"))
    cfg.pop("llm", None)
    json.dump(cfg, open(p, "w", encoding="utf-8"))
    assert hs.default_generative_model() == DEF_FILE
    assert hs.resolve_generative_target(DEF_FILE, None) == (DEF_REPO, DEF_FILE)
    assert hs.resolve_generative_target(DEF_REPO, None) == (DEF_REPO, DEF_FILE)
    assert hs.resolve_generative_target(DEF_REPO, "Q4_K_M") == (DEF_REPO, DEF_FILE)

    seen = {}
    monkeypatch.setattr(hs, "update_app_config_llm", lambda mid, n=None: seen.setdefault("id", mid))
    from fastapi import BackgroundTasks

    res = hs.serve_model(hs.ServeRequest(category="generative"), BackgroundTasks())
    assert res["status"] == "ok" and seen["id"] == DEF_FILE


def test_split_gguf_id_uncatalogued():
    # bare filename: no repo known, filename kept verbatim (never "<file>.Q4_K_M.gguf")
    assert md.split_gguf_id("Foo-7B-Q5_K_M.gguf") == (None, "Foo-7B-Q5_K_M.gguf")
    # repo-qualified filename
    assert md.split_gguf_id("acme/Foo-GGUF/Foo-7B-Q5_K_M.gguf") == ("acme/Foo-GGUF", "Foo-7B-Q5_K_M.gguf")
    # plain repo id: no filename
    assert md.split_gguf_id("acme/Foo-GGUF") == ("acme/Foo-GGUF", None)
    assert md.split_gguf_id(None) == (None, None)


def test_pick_repo_for_gguf_from_search():
    results = [
        {"id": "x/other", "siblings": [{"rfilename": "Other.gguf"}]},
        {"id": "acme/Foo-GGUF", "siblings": [{"rfilename": "Foo-7B-Q5_K_M.gguf"}]},
    ]
    assert md.pick_repo_for_gguf("Foo-7B-Q5_K_M.gguf", results) == "acme/Foo-GGUF"
    assert md.pick_repo_for_gguf("Missing.gguf", results) is None
