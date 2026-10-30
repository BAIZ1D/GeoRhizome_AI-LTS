from __future__ import annotations

import importlib
import json
import os
import sys
import types

import pytest
from fastapi import BackgroundTasks, HTTPException

SENT = "Offloaded"


def _j(d, n):
    return json.load(open(os.path.join(d, n), encoding="utf-8"))


@pytest.fixture
def hs(tmp_config_dir, tmp_path, monkeypatch):
    import hardware_server

    mod = importlib.reload(hardware_server)
    monkeypatch.setattr(mod, "SERVER_ENV_PATH", str(tmp_path / "server.env"))
    return mod


def _cfg(d):
    return _j(d, "app_config.json")["sparse"]


class _Proc:
    pid = 515151


def test_seed_has_sparse_without_liveness(hs, tmp_config_dir):
    assert "sparse" in hs.ACTIVE_PROCESSES
    for k in ("pid", "alive"):
        assert k not in _j(tmp_config_dir, "active_models.json")["sparse"]


def test_catalog_sparse_entry(hs, tmp_config_dir, monkeypatch):
    monkeypatch.setattr(hs, "detect_system", lambda: {})
    out = hs.get_catalog(category="sparse")
    items = out["catalog"]["sparse"]
    cat = _j(tmp_config_dir, "model_catalog.json")["sparse"][0]
    assert len(items) == 1
    assert items[0]["repo_id"] == cat["repo_id"] and items[0]["revision"] == cat["revision"]
    assert items[0]["size_bytes"] == cat["size_bytes"]


def test_download_uses_snapshot_download_with_pinned_revision(hs, tmp_config_dir, monkeypatch):
    calls = {}
    fake = types.ModuleType("huggingface_hub")
    fake.snapshot_download = lambda **kw: calls.update(kw)
    fake.hf_hub_download = lambda **kw: calls.setdefault("BAD", True)
    monkeypatch.setitem(sys.modules, "huggingface_hub", fake)
    cfg = _cfg(tmp_config_dir)
    hs.DOWNLOAD_JOBS.clear()
    bt = BackgroundTasks()
    r = hs.download_model(hs.DownloadRequest(repo_id=cfg["model_name"], category="sparse"), bt)
    assert r["status"] == "started"
    for t in bt.tasks:
        t.func(*t.args, **t.kwargs)
    assert calls == {"repo_id": cfg["model_name"], "revision": cfg["revision"]}
    assert hs.DOWNLOAD_JOBS[r["job_id"]]["status"] == "complete"


def test_download_and_serve_reject_other_ids(hs):
    with pytest.raises(HTTPException) as e:
        hs.download_model(hs.DownloadRequest(repo_id="evil/model", category="sparse"), BackgroundTasks())
    assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:
        hs.serve_model(hs.ServeRequest(category="sparse", model_id="evil/model"), BackgroundTasks())
    assert e.value.status_code == 400


def test_serve_orders_kill_sync_popen(hs, tmp_config_dir, monkeypatch):
    order = []
    port = _cfg(tmp_config_dir)["port"]
    monkeypatch.setattr(hs, "kill_port_listeners", lambda p: order.append(("kill", p)) or [])
    real = hs.sparse_state.sync_sparse_state

    def spy(d, e, m=""):
        order.append(("sync", e))
        return real(d, e, m)

    monkeypatch.setattr(hs.sparse_state, "sync_sparse_state", spy)
    seen = {}

    def popen(argv, **kw):
        order.append(("popen",))
        seen["argv"], seen["kw"] = argv, kw
        assert _j(tmp_config_dir, "app_config.json")["sparse"]["enabled"] is True
        return _Proc()

    monkeypatch.setattr(hs.subprocess, "Popen", popen)
    r = hs.serve_model(hs.ServeRequest(category="sparse"), BackgroundTasks())
    assert order == [("kill", port), ("sync", True), ("popen",)]
    assert seen["argv"][0] == sys.executable and seen["argv"][1].endswith("local_sparse_server.py")
    assert "env" not in seen["kw"]
    assert r["pid"] == _Proc.pid and hs.ACTIVE_PROCESSES["sparse"]["pid"] == _Proc.pid
    assert "pid" not in _j(tmp_config_dir, "active_models.default.json")["sparse"]


def test_popen_failure_restores_disabled(hs, tmp_config_dir, monkeypatch):
    monkeypatch.setattr(hs, "kill_port_listeners", lambda p: [])

    def boom(*a, **k):
        raise OSError("nope")

    monkeypatch.setattr(hs.subprocess, "Popen", boom)
    with pytest.raises(HTTPException):
        hs.serve_model(hs.ServeRequest(category="sparse"), BackgroundTasks())
    assert _cfg(tmp_config_dir)["enabled"] is False
    assert _j(tmp_config_dir, "active_models.json")["sparse"]["enabled"] is False


def test_offload_sets_disabled_no_sentinel(hs, tmp_config_dir, monkeypatch):
    killed = []
    monkeypatch.setattr(hs, "kill_port_listeners", lambda p: killed.append(p) or [])
    monkeypatch.setattr(hs.subprocess, "Popen", lambda *a, **k: _Proc())
    hs.serve_model(hs.ServeRequest(category="sparse"), BackgroundTasks())
    name = _cfg(tmp_config_dir)["model_name"]
    hs.offload_model(hs.OffloadRequest(category="sparse"))
    assert killed[-1] == _cfg(tmp_config_dir)["port"]
    c = _cfg(tmp_config_dir)
    assert c["enabled"] is False and c["model_name"] == name
    a = _j(tmp_config_dir, "active_models.json")["sparse"]
    assert a["enabled"] is False and a["model_id"] == name and "pid" not in a
    assert "pid" not in hs.ACTIVE_PROCESSES["sparse"]
    raw = open(os.path.join(tmp_config_dir, "active_models.json")).read() + open(os.path.join(tmp_config_dir, "app_config.json")).read()
    assert SENT not in raw


def test_status_includes_sparse_not_alive_from_disk(hs, tmp_config_dir, monkeypatch):
    monkeypatch.setattr(hs, "is_port_active", lambda p: False)
    s = hs.hardware_status()["active_processes"]["sparse"]
    port = _cfg(tmp_config_dir)["port"]
    assert s["port"] == port and s["alive"] is False and s["enabled"] is False
    assert s["model_id"] == _cfg(tmp_config_dir)["model_name"]
