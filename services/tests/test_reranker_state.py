from __future__ import annotations

import json
import os
import subprocess

import yaml

import reranker_state as rs
from conftest import REPO_CONFIG, REPO_ROOT
from core import config_io

SENT = "Offloaded"


def _read_all(d):
    a = json.load(open(os.path.join(d, "active_models.json"), encoding="utf-8"))
    r = yaml.safe_load(open(os.path.join(d, "retrieval.yaml"), encoding="utf-8"))
    c = json.load(open(os.path.join(d, "app_config.json"), encoding="utf-8"))
    return a, r, c


def _raw_all(d):
    return "".join(open(os.path.join(d, n), encoding="utf-8").read() for n in ("active_models.json", "retrieval.yaml", "app_config.json"))


def _tier_default(d):
    return yaml.safe_load(open(os.path.join(d, "reranker_tiers.yaml")))["model"]


def _ensure_active(d):
    p = os.path.join(d, "active_models.json")
    if not os.path.exists(p):
        rs.seed_active_models(d)


def test_sync_enable_writes_all_three(tmp_config_dir):
    _ensure_active(tmp_config_dir)
    before_llm = json.load(open(os.path.join(tmp_config_dir, "app_config.json")))["llm"]
    rs.sync_reranker_state(tmp_config_dir, True, "org/X")
    a, r, c = _read_all(tmp_config_dir)
    assert a["reranker"]["model_id"] == "org/X" and a["reranker"]["name"] == "org/X"
    assert a["reranker"]["enabled"] is True and "pid" not in a["reranker"]
    assert a["reranker"]["port"] == 8001
    assert r["retrieval"]["reranker_enabled"] is True and r["retrieval"]["reranker_model"] == "org/X"
    assert "wide_candidate_count" in r["retrieval"]
    assert c["reranker"]["enabled"] is True and c["reranker"]["model_name"] == "org/X"
    assert c["llm"] == before_llm


def test_sync_disable_keeps_name_no_sentinel(tmp_config_dir):
    _ensure_active(tmp_config_dir)
    rs.sync_reranker_state(tmp_config_dir, True, "org/X")
    rs.sync_reranker_state(tmp_config_dir, False, SENT)
    a, r, c = _read_all(tmp_config_dir)
    assert a["reranker"]["enabled"] is False and a["reranker"]["model_id"] == "org/X"
    assert r["retrieval"]["reranker_enabled"] is False and r["retrieval"]["reranker_model"] == "org/X"
    assert c["reranker"]["enabled"] is False and c["reranker"]["model_name"] == "org/X"
    assert SENT not in _raw_all(tmp_config_dir)
    rs.sync_reranker_state(tmp_config_dir, False, "")
    assert SENT not in _raw_all(tmp_config_dir)


def test_serve_offload_serve_cycle(tmp_config_dir):
    _ensure_active(tmp_config_dir)
    rs.sync_reranker_state(tmp_config_dir, True, "org/X")
    rs.sync_reranker_state(tmp_config_dir, False)
    rs.sync_reranker_state(tmp_config_dir, True, "org/Y")
    a, r, c = _read_all(tmp_config_dir)
    assert a["reranker"]["model_id"] == r["retrieval"]["reranker_model"] == c["reranker"]["model_name"] == "org/Y"
    assert a["reranker"]["enabled"] and r["retrieval"]["reranker_enabled"] and c["reranker"]["enabled"]


def test_empty_model_with_nothing_uses_tier_default(tmp_config_dir):
    for n in ("active_models.json",):
        p = os.path.join(tmp_config_dir, n)
        if os.path.exists(p):
            os.remove(p)
    c = json.load(open(os.path.join(tmp_config_dir, "app_config.json")))
    c["reranker"].pop("model_name", None)
    config_io.atomic_write_json(os.path.join(tmp_config_dir, "app_config.json"), c)
    y = yaml.safe_load(open(os.path.join(tmp_config_dir, "retrieval.yaml")))
    y["retrieval"].pop("reranker_model", None)
    config_io.atomic_write_yaml(os.path.join(tmp_config_dir, "retrieval.yaml"), y)
    rs.sync_reranker_state(tmp_config_dir, True, None)
    a, r, c = _read_all(tmp_config_dir)
    want = _tier_default(tmp_config_dir)
    assert a["reranker"]["model_id"] == r["retrieval"]["reranker_model"] == c["reranker"]["model_name"] == want


def test_migrate_legacy_sentinel(tmp_config_dir):
    d = tmp_config_dir
    config_io.atomic_write_json(os.path.join(d, "active_models.json"),
                                {"reranker": {"model_id": SENT, "name": SENT, "port": 8001, "pid": 5, "alive": True}})
    y = yaml.safe_load(open(os.path.join(d, "retrieval.yaml")))
    y["retrieval"]["reranker_model"] = SENT
    config_io.atomic_write_yaml(os.path.join(d, "retrieval.yaml"), y)
    c = json.load(open(os.path.join(d, "app_config.json")))
    c["reranker"]["model_name"] = SENT
    config_io.atomic_write_json(os.path.join(d, "app_config.json"), c)
    changed = rs.migrate_legacy_sentinel(d)
    assert changed
    a, r, c = _read_all(d)
    want = _tier_default(d)
    assert a["reranker"]["model_id"] == want and a["reranker"]["enabled"] is False
    assert r["retrieval"]["reranker_model"] == want and r["retrieval"]["reranker_enabled"] is False
    assert c["reranker"]["model_name"] == want and c["reranker"]["enabled"] is False
    assert SENT not in _raw_all(d)


def test_migrate_noop_when_clean(tmp_config_dir):
    _ensure_active(tmp_config_dir)
    rs.sync_reranker_state(tmp_config_dir, True, "org/X")
    assert rs.migrate_legacy_sentinel(tmp_config_dir) is False


def test_seed_active_models_from_default(tmp_config_dir):
    p = os.path.join(tmp_config_dir, "active_models.json")
    if os.path.exists(p):
        os.remove(p)
    st = rs.seed_active_models(tmp_config_dir)
    assert os.path.exists(p)
    assert st["reranker"]["port"] == 8001
    assert "alive" not in json.dumps(st)


def test_seed_strips_alive(tmp_config_dir):
    config_io.atomic_write_json(os.path.join(tmp_config_dir, "active_models.json"),
                                {"generative": {"model_id": "g", "pid": 3, "alive": True},
                                 "embedding": {"model_id": SENT, "alive": True}})
    st = rs.seed_active_models(tmp_config_dir)
    assert "alive" not in st["generative"] and st["generative"]["pid"] == 3
    assert st["embedding"]["model_id"] == SENT


def test_holds_lock_and_no_tmp(tmp_config_dir, monkeypatch):
    _ensure_active(tmp_config_dir)
    entered = {"n": 0}
    real = config_io.CONFIG_LOCK

    class Spy:
        def __enter__(self):
            entered["n"] += 1
            return real.__enter__()

        def __exit__(self, *a):
            return real.__exit__(*a)

    monkeypatch.setattr(rs, "CONFIG_LOCK", Spy())
    written = []
    orig = rs.atomic_write_json

    def spy_write(p, d):
        assert real._is_owned()
        written.append(p)
        orig(p, d)

    monkeypatch.setattr(rs, "atomic_write_json", spy_write)
    rs.sync_reranker_state(tmp_config_dir, True, "org/X")
    assert entered["n"] >= 1 and len(written) == 2
    assert [n for n in os.listdir(tmp_config_dir) if n.startswith(".tmp-")] == []


# ---- Task 2: shipped config -------------------------------------------
def test_repo_retrieval_yaml():
    r = yaml.safe_load(open(os.path.join(REPO_CONFIG, "retrieval.yaml")))["retrieval"]
    tiers_model = yaml.safe_load(open(os.path.join(REPO_CONFIG, "reranker_tiers.yaml")))["model"]
    assert r["reranker_enabled"] is True and r["reranker_model"] == tiers_model


def test_repo_app_config_reranker_keys():
    c = json.load(open(os.path.join(REPO_CONFIG, "app_config.json")))["reranker"]
    for k in ("enabled", "base_url", "web_search_top_k", "web_search_fetch_k", "snippet_max_length",
              "model_name", "activation", "max_length", "idle_unload_minutes", "timeout_ms",
              "wide_candidate_count", "final_top_k", "min_reranker_score", "selftest_min_spearman"):
        assert k in c, k
    assert c["activation"] == "identity" and c["max_length"] == 512 and c["wide_candidate_count"] == 30
    assert c["timeout_ms"] >= 20000 and c["cold_timeout_ms"] > c["timeout_ms"]


def test_repo_active_defaults():
    p = os.path.join(REPO_CONFIG, "active_models.default.json")
    d = json.load(open(p))
    raw = open(p).read()
    assert '"pid"' not in raw and '"alive"' not in raw
    app = json.load(open(os.path.join(REPO_CONFIG, "app_config.json")))
    assert d["generative"]["model_id"] == app["llm"]["model_name"]
    assert d["embedding"]["port"] == 8000 and d["reranker"]["port"] == 8001 and d["reranker"]["enabled"] is True


def test_runtime_active_models_untracked():
    rc = subprocess.run(["git", "-C", REPO_ROOT, "check-ignore", "-q", "config/active_models.json"]).returncode
    assert rc == 0
    out = subprocess.run(["git", "-C", REPO_ROOT, "ls-files", "config/active_models.json"],
                         capture_output=True, text=True).stdout
    assert out.strip() == ""
