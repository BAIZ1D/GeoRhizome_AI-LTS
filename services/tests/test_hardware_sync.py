from __future__ import annotations

import importlib
import inspect
import json
import os
import threading

import pytest
import yaml

SENT = "Offloaded"


def _read(d):
    a = json.load(open(os.path.join(d, "active_models.json"), encoding="utf-8"))
    r = yaml.safe_load(open(os.path.join(d, "retrieval.yaml"), encoding="utf-8"))
    c = json.load(open(os.path.join(d, "app_config.json"), encoding="utf-8"))
    return a, r, c


def _raw(d):
    return "".join(open(os.path.join(d, n), encoding="utf-8").read() for n in ("active_models.json", "retrieval.yaml", "app_config.json"))


@pytest.fixture
def hs(tmp_config_dir, tmp_path, monkeypatch):
    import hardware_server

    mod = importlib.reload(hardware_server)
    monkeypatch.setattr(mod, "SERVER_ENV_PATH", str(tmp_path / "server.env"))
    monkeypatch.setattr(mod, "ANYTHINGLLM_DB_PATH", str(tmp_path / "none.db"))

    def no_ports(*a, **k):
        raise FileNotFoundError("no lsof in test")

    monkeypatch.setattr(mod.subprocess, "check_output", no_ports)
    return mod


class _FakeProc:
    pid = 424242


def test_update_retrieval_reranker_wrapper(hs, tmp_config_dir):
    hs.update_retrieval_reranker(True, "org/X")
    a, r, c = _read(tmp_config_dir)
    assert a["reranker"]["model_id"] == r["retrieval"]["reranker_model"] == c["reranker"]["model_name"] == "org/X"
    assert a["reranker"]["enabled"] and r["retrieval"]["reranker_enabled"] and c["reranker"]["enabled"]
    hs.update_retrieval_reranker(False, SENT)
    a, r, c = _read(tmp_config_dir)
    assert a["reranker"]["model_id"] == "org/X" and a["reranker"]["enabled"] is False
    assert SENT not in _raw(tmp_config_dir)


def test_serve_writes_before_popen_with_repo_id(hs, tmp_config_dir, monkeypatch):
    order = []
    real = hs.update_retrieval_reranker
    monkeypatch.setattr(hs, "update_retrieval_reranker", lambda e, m="": (order.append(("sync", m)), real(e, m))[1])
    seen_env = {}

    def fake_popen(cmd, env=None, **k):
        order.append(("popen", None))
        seen_env.update(env or {})
        return _FakeProc()

    monkeypatch.setattr(hs.subprocess, "Popen", fake_popen)
    res = hs.serve_model(hs.ServeRequest(category="reranker", repo_id="org/R"), None)
    assert res["status"] == "ok"
    assert order[0] == ("sync", "org/R") and order[1][0] == "popen"
    assert seen_env["RERANKER_MODEL_PREF"] == "org/R"
    a, r, c = _read(tmp_config_dir)
    assert a["reranker"]["model_id"] == "org/R" and a["reranker"]["pid"] == 424242
    assert r["retrieval"]["reranker_model"] == "org/R" and c["reranker"]["model_name"] == "org/R"
    assert "alive" not in json.dumps(a)


def test_serve_without_ids_uses_current(hs, tmp_config_dir, monkeypatch):
    monkeypatch.setattr(hs.subprocess, "Popen", lambda *a, **k: _FakeProc())
    hs.update_retrieval_reranker(True, "org/Cur")
    hs.serve_model(hs.ServeRequest(category="reranker"), None)
    a, _, _ = _read(tmp_config_dir)
    assert a["reranker"]["model_id"] == "org/Cur"


def test_serve_handler_has_single_yaml_path():
    import hardware_server

    src = inspect.getsource(hardware_server.serve_model)
    assert "yaml.dump" not in src and "safe_dump" not in src
    i_sync = src.index("update_retrieval_reranker(True")
    i_popen = src.index("Popen", src.index('if cat == "reranker"'))
    assert i_sync < i_popen


def test_offload_reranker(hs, tmp_config_dir, monkeypatch):
    monkeypatch.setattr(hs.subprocess, "Popen", lambda *a, **k: _FakeProc())
    hs.serve_model(hs.ServeRequest(category="reranker", model_id="org/X"), None)
    hs.offload_model(hs.OffloadRequest(category="reranker"))
    a, r, c = _read(tmp_config_dir)
    assert a["reranker"]["enabled"] is False and "pid" not in a["reranker"]
    assert a["reranker"]["model_id"] == "org/X"
    assert r["retrieval"]["reranker_enabled"] is False and c["reranker"]["enabled"] is False
    assert SENT not in _raw(tmp_config_dir)
    # serve again re-enables
    hs.serve_model(hs.ServeRequest(category="reranker", model_id="org/Y"), None)
    a, r, c = _read(tmp_config_dir)
    assert a["reranker"]["enabled"] and r["retrieval"]["reranker_enabled"] and c["reranker"]["enabled"]


def test_load_active_state_sanitizes_legacy(tmp_config_dir, monkeypatch):
    from core.config_io import atomic_write_json

    atomic_write_json(os.path.join(tmp_config_dir, "active_models.json"), {
        "generative": {"model_id": "g.gguf", "pid": 1, "alive": True, "port": 8003},
        "reranker": {"model_id": SENT, "name": SENT, "pid": 2, "alive": True, "port": 8001},
    })
    import hardware_server

    hs = importlib.reload(hardware_server)
    st = hs.ACTIVE_PROCESSES
    assert "alive" not in json.dumps(st)
    assert st["reranker"]["model_id"] != SENT and st["reranker"]["enabled"] is False
    assert SENT not in open(os.path.join(tmp_config_dir, "active_models.json")).read()


def test_load_active_state_seeds_default(tmp_config_dir):
    os.remove(os.path.join(tmp_config_dir, "active_models.json")) if os.path.exists(os.path.join(tmp_config_dir, "active_models.json")) else None
    import hardware_server

    hs = importlib.reload(hardware_server)
    st = hs.ACTIVE_PROCESSES
    assert st["reranker"]["port"] == 8001 and "pid" not in json.dumps(st) and "alive" not in json.dumps(st)
    assert os.path.exists(os.path.join(tmp_config_dir, "active_models.json"))
    src = inspect.getsource(hs.load_active_state)
    assert "os.getpid" not in src


def test_status_liveness_and_display_sentinel(hs, tmp_config_dir, monkeypatch):
    monkeypatch.setattr(hs.subprocess, "Popen", lambda *a, **k: _FakeProc())
    monkeypatch.setattr(hs, "is_port_active", lambda p: False)
    monkeypatch.setattr(hs, "pid_alive", lambda pid: pid == 424242)
    hs.serve_model(hs.ServeRequest(category="reranker", model_id="org/X"), None)
    s = hs.hardware_status()["active_processes"]["reranker"]
    assert s["alive"] is True and s["model_id"] == "org/X"
    hs.offload_model(hs.OffloadRequest(category="reranker"))
    s = hs.hardware_status()["active_processes"]["reranker"]
    assert s["alive"] is False and s["model_id"] == SENT and s["last_model_id"] == "org/X"
    assert SENT not in _raw(tmp_config_dir)
    monkeypatch.setattr(hs, "pid_alive", lambda pid: False)
    hs.update_retrieval_reranker(True, "org/X")
    hs.ACTIVE_PROCESSES["reranker"]["pid"] = 999
    assert hs.hardware_status()["active_processes"]["reranker"]["alive"] is False


def test_no_pid0_probe():
    src = open(os.path.join(os.path.dirname(__file__), "..", "hardware_server.py"), encoding="utf-8").read()
    assert "os.kill(" not in src


# ---- Task 2: shared lock + atomic writes ---------------------------------
def test_writers_concurrent_no_lost_update(hs, tmp_config_dir):
    import reranker_state

    def emb():
        for i in range(50):
            hs.update_app_config_embedding("org/emb", 768)

    def llm():
        for i in range(50):
            hs.update_app_config_llm("m%d.gguf" % i, 4096)

    def rer():
        for i in range(50):
            reranker_state.sync_reranker_state(tmp_config_dir, bool(i % 2), "org/R")

    ts = [threading.Thread(target=f) for f in (emb, llm, rer)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    c = json.load(open(os.path.join(tmp_config_dir, "app_config.json")))
    assert c["embedding"]["model_name"] == "org/emb" and c["llm"]["model_name"] == "m49.gguf"
    for k in ("activation", "max_length", "timeout_ms", "min_reranker_score", "model_name"):
        assert k in c["reranker"]
    assert c["reranker"]["enabled"] is True  # i == 49 -> True
    assert [n for n in os.listdir(tmp_config_dir) if n.startswith(".tmp-")] == []


def test_writer_golden_output(hs, tmp_config_dir):
    p = os.path.join(tmp_config_dir, "app_config.json")
    before = json.load(open(p))
    hs.update_app_config_embedding(before["embedding"]["model_name"], before["embedding"]["dimension"])
    hs.update_app_config_llm("x.gguf", 8192)
    after = json.load(open(p))
    exp = dict(before)
    exp["llm"] = dict(before["llm"], model_name="x.gguf", token_limit=8192)
    assert after == exp


def test_save_active_state_locked_atomic(hs, tmp_config_dir, monkeypatch):
    from core import config_io

    seen = []
    orig = hs.atomic_write_json

    def spy(p, d):
        seen.append(config_io.CONFIG_LOCK._is_owned())
        orig(p, d)

    monkeypatch.setattr(hs, "atomic_write_json", spy)
    hs.ACTIVE_PROCESSES["generative"]["alive"] = True
    hs.save_active_state()
    assert seen == [True]
    raw = open(os.path.join(tmp_config_dir, "active_models.json")).read()
    assert '"alive"' not in raw
    json.loads(raw)


def test_embedder_swap_launches_an_existing_script():
    """/hardware/serve embedding must spawn services/local_bge_server.py (E2E-05 swap died: wrong path)."""
    import hardware_server

    assert os.path.isfile(hardware_server.BGE_SCRIPT)
    assert os.path.basename(os.path.dirname(hardware_server.BGE_SCRIPT)) == "services"
