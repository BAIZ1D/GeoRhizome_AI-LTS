from __future__ import annotations

import copy
import json
import os

import pytest

from conftest import REPO_CONFIG
from core import ram_profile as rp
import reranker_runtime as rr


@pytest.fixture
def cfg():
    with open(os.path.join(REPO_CONFIG, "app_config.json"), encoding="utf-8") as f:
        return json.load(f)


def test_low_8_0(cfg):
    p = rp.resolve_profile(8.0, False, cfg, REPO_CONFIG)
    assert p["tier"] == p["reranker_tier"] == "low"
    assert (p["n_ctx"], p["kv_cache_type"], p["flash_attn"], p["max_tokens"], p["prompt_limit"], p["candidate_count"]) == (
        8192, "q8_0", True, 2048, 5600, 15)


def test_low_8_6_tolerance(cfg):
    assert rp.resolve_profile(8.6, False, cfg, REPO_CONFIG)["tier"] == "low"


def test_medium_9_0(cfg):
    p = rp.resolve_profile(9.0, False, cfg, REPO_CONFIG)
    assert p["tier"] == "medium" and p["n_ctx"] == 16384 and p["kv_cache_type"] is None
    assert p["flash_attn"] is False and p["candidate_count"] == 30


def test_high_16_accel(cfg):
    p = rp.resolve_profile(16.0, True, cfg, REPO_CONFIG)
    assert p["tier"] == "high" and p["candidate_count"] == 30


def test_wide_candidate_fixed_point(cfg):
    c = copy.deepcopy(cfg)
    c["reranker"]["wide_candidate_count"] = 15
    assert rp.resolve_profile(16.0, True, c, REPO_CONFIG)["candidate_count"] == 30


def test_cli_args_q8(cfg):
    p = rp.resolve_profile(8.0, False, cfg, REPO_CONFIG)
    assert rp.llm_cli_args(p) == ["--n_ctx", "8192", "--type_k", "8", "--type_v", "8", "--flash_attn", "True"]


def test_cli_args_default(cfg):
    p = rp.resolve_profile(16.0, False, cfg, REPO_CONFIG)
    assert rp.llm_cli_args(p) == ["--n_ctx", "16384"]


def test_type_v_never_without_flash():
    args = rp.llm_cli_args({"n_ctx": 8192, "kv_cache_type": "q8_0", "flash_attn": False})
    assert "--type_v" not in args and "--flash_attn" not in args


def test_degrade_keeps_n_ctx(cfg):
    p = rp.resolve_profile(8.0, False, cfg, REPO_CONFIG)
    assert rp.llm_cli_args(p, degrade=True) == ["--n_ctx", "8192"]


@pytest.mark.parametrize("kv,n", [("q4_0", 8192), ("q8_0; rm", 8192), (None, 512), (None, 999999), (None, "8192")])
def test_validation(kv, n):
    with pytest.raises(ValueError):
        rp.llm_cli_args({"n_ctx": n, "kv_cache_type": kv, "flash_attn": True})


def test_medium_min_ram_injected_from_single_key(cfg):
    doc = rr.load_tiers_doc(REPO_CONFIG)
    assert doc["tiers"]["medium"]["min_ram_gb"] == rp.low_ram_max_gb(cfg) == 9.0
    with open(os.path.join(REPO_CONFIG, "reranker_tiers.yaml"), encoding="utf-8") as f:
        text = f.read()
    medium_block = text.split("  medium:")[1].split("  high:")[0]
    assert "min_ram_gb" not in medium_block


def test_config_keys(cfg):
    assert cfg["llm"]["sampling"]["top_k"] == 20
    assert cfg["embedding"]["idle_unload_seconds"] == 300
