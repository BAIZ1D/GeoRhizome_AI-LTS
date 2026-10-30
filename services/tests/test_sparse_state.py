from __future__ import annotations

import json
import os
import threading

import pytest

import sparse_state as ss
from conftest import REPO_CONFIG


def _j(d, n):
    return json.load(open(os.path.join(d, n), encoding="utf-8"))


def _name(d):
    return _j(d, "app_config.json")["sparse"]["model_name"]


def test_enable_writes_both(tmp_config_dir):
    ss.seed_sparse_entry(tmp_config_dir)
    n = _name(tmp_config_dir)
    assert ss.sync_sparse_state(tmp_config_dir, True, n) == n
    a, c = _j(tmp_config_dir, "active_models.json"), _j(tmp_config_dir, "app_config.json")
    assert a["sparse"]["model_id"] == n and a["sparse"]["enabled"] is True
    assert "pid" not in a["sparse"] and "alive" not in a["sparse"]
    assert c["sparse"]["enabled"] is True and c["sparse"]["model_name"] == n


def test_disable_keeps_name_and_ignores_sentinel(tmp_config_dir):
    n = _name(tmp_config_dir)
    ss.sync_sparse_state(tmp_config_dir, True, n)
    ss.sync_sparse_state(tmp_config_dir, False, "Offloaded")
    ss.sync_sparse_state(tmp_config_dir, False, "")
    a, c = _j(tmp_config_dir, "active_models.json"), _j(tmp_config_dir, "app_config.json")
    assert a["sparse"]["enabled"] is False and a["sparse"]["model_id"] == n
    assert c["sparse"]["enabled"] is False and c["sparse"]["model_name"] == n
    assert "Offloaded" not in open(os.path.join(tmp_config_dir, "active_models.json")).read()


def test_arbitrary_model_rejected(tmp_config_dir):
    before = open(os.path.join(tmp_config_dir, "app_config.json")).read()
    with pytest.raises(ValueError):
        ss.sync_sparse_state(tmp_config_dir, True, "evil/model")
    assert open(os.path.join(tmp_config_dir, "app_config.json")).read() == before


def test_seed_creates_entry_without_pid_alive(tmp_config_dir):
    p = os.path.join(tmp_config_dir, "active_models.json")
    json.dump({"embedding": {"model_id": "x"}, "sparse": {"model_id": "m", "pid": 5, "alive": True}}, open(p, "w"))
    e = ss.seed_sparse_entry(tmp_config_dir)
    assert "pid" not in e and "alive" not in e
    json.dump({"embedding": {"model_id": "x"}}, open(p, "w"))
    e = ss.seed_sparse_entry(tmp_config_dir)
    assert e["port"] == _j(tmp_config_dir, "app_config.json")["sparse"]["port"]
    assert "pid" not in e and "alive" not in e
    assert _j(tmp_config_dir, "active_models.json")["embedding"] == {"model_id": "x"}


def test_retrieval_yaml_untouched(tmp_config_dir):
    p = os.path.join(tmp_config_dir, "retrieval.yaml")
    before = open(p, "rb").read()
    ss.sync_sparse_state(tmp_config_dir, True, "")
    ss.sync_sparse_state(tmp_config_dir, False, "")
    assert open(p, "rb").read() == before


def test_concurrent_calls_leave_valid_json(tmp_config_dir):
    ss.seed_sparse_entry(tmp_config_dir)
    errs = []

    def w(i):
        try:
            for _ in range(10):
                ss.sync_sparse_state(tmp_config_dir, i % 2 == 0, "")
        except Exception as e:  # pragma: no cover
            errs.append(e)

    ts = [threading.Thread(target=w, args=(i,)) for i in range(6)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not errs
    _j(tmp_config_dir, "active_models.json")
    _j(tmp_config_dir, "app_config.json")


def test_seed_time_max_input_chars_equals_chunk_size(tmp_config_dir):
    for d in (REPO_CONFIG, tmp_config_dir):
        c = _j(d, "app_config.json")
        assert c["sparse"]["max_input_chars"] == c["text_splitter"]["chunk_size"]


def test_sync_does_not_resync_max_input_chars(tmp_config_dir):
    p = os.path.join(tmp_config_dir, "app_config.json")
    c = json.load(open(p))
    c["text_splitter"]["chunk_size"] = 2048
    json.dump(c, open(p, "w"))
    ss.sync_sparse_state(tmp_config_dir, True, "")
    assert ss.get_sparse_settings(tmp_config_dir)["max_input_chars"] == 1024


def test_get_settings_names_missing_key(tmp_config_dir):
    p = os.path.join(tmp_config_dir, "app_config.json")
    c = json.load(open(p))
    del c["sparse"]["max_length"]
    json.dump(c, open(p, "w"))
    with pytest.raises(KeyError, match="max_length"):
        ss.get_sparse_settings(tmp_config_dir)
