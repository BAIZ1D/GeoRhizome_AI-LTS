from __future__ import annotations

import json
import os
import threading
import time

import pytest
import torch
from fastapi.testclient import TestClient

import reranker_runtime as rr


@pytest.fixture
def srv(tmp_config_dir, fake_ce, monkeypatch):
    import local_reranker_server as s
    import reranker_state

    reranker_state.seed_active_models(tmp_config_dir)

    monkeypatch.setattr(rr, "_DETECT_CACHE", (7.6, False, False))
    monkeypatch.setattr(s, "CE_FACTORY", fake_ce)
    monkeypatch.delenv("RERANKER_MODEL_PREF", raising=False)
    s.engine = s.Engine()
    yield s
    s.engine = s.Engine()


def _req(n=3):
    return {"query": "質問", "candidates": [{"id": str(i), "text": "x" * (i + 1), "metadata": {"k": i}} for i in range(n)]}


def test_health_unloaded_before_first_rerank(srv, fake_ce):
    with TestClient(srv.app) as c:
        h = c.get("/health").json()
    assert h["state"] == "unloaded"
    assert fake_ce.instances == []


def test_lazy_load_once(srv, fake_ce):
    with TestClient(srv.app) as c:
        assert c.post("/rerank", json=_req()).status_code == 200
        assert c.post("/rerank", json=_req()).status_code == 200
        h = c.get("/health").json()
    assert len(fake_ce.instances) == 1
    assert h["state"] == "ready"


def test_health_fields(srv):
    with TestClient(srv.app) as c:
        c.post("/rerank", json=_req())
        h = c.get("/health").json()
    for k in ("model", "source", "tier", "device", "precision", "batch_size", "state", "rss_mb",
              "mps_driver_allocated_mb", "cuda_allocated_mb"):
        assert k in h, k
    assert h["tier"] == "medium" and h["device"] == "cpu" and h["precision"] == "fp32"
    assert h["batch_size"] == 8 and h["source"] == "active" and h["rss_mb"] > 0


def test_response_shape_unchanged(srv):
    with TestClient(srv.app) as c:
        body = c.post("/rerank", json=_req()).json()
    assert set(body) == {"query", "results", "count"}
    assert body["count"] == 3
    item = body["results"][0]
    assert set(item) == {"id", "text", "score", "metadata", "rank"}
    scores = [r["score"] for r in body["results"]]
    assert scores == sorted(scores, reverse=True)
    assert [r["rank"] for r in body["results"]] == [1, 2, 3]


def test_empty_returns_empty(srv, fake_ce):
    with TestClient(srv.app) as c:
        assert c.post("/rerank", json={"query": "", "candidates": []}).json() == {"results": []}
        assert c.post("/rerank", json={"query": "q", "candidates": []}).json() == {"results": []}
    assert fake_ce.instances == []


def test_identity_batch_maxlen(srv, fake_ce):
    with TestClient(srv.app) as c:
        c.post("/rerank", json=_req())
    inst = fake_ce.instances[0]
    assert isinstance(inst.kwargs["activation_fn"], torch.nn.Identity)
    assert inst.kwargs["max_length"] == 1024
    assert inst.predict_calls[-1]["batch_size"] == 8


def test_reaper_unloads_idle(srv, monkeypatch):
    freed = []
    monkeypatch.setattr(rr, "_free_accel", lambda: freed.append(1))
    with TestClient(srv.app) as c:
        c.post("/rerank", json=_req())
    e = srv.engine
    e.cfg["idle_unload_minutes"] = 1
    e.last_used = time.time() - 120
    assert e.reap_if_idle() is True
    assert e.state == "unloaded" and e.model is None and freed


def test_reaper_never_when_disabled(srv):
    with TestClient(srv.app) as c:
        c.post("/rerank", json=_req())
    e = srv.engine
    e.cfg["idle_unload_minutes"] = 0
    e.last_used = time.time() - 10_000
    assert e.reap_if_idle() is False and e.state == "ready"


def test_reaper_skips_during_inference(srv):
    with TestClient(srv.app) as c:
        c.post("/rerank", json=_req())
    e = srv.engine
    e.cfg["idle_unload_minutes"] = 1
    e.last_used = time.time() - 120
    e.infer_slot.acquire()
    try:
        assert e.reap_if_idle() is False and e.state == "ready"
    finally:
        e.infer_slot.release()


def test_busy_returns_503(srv):
    with TestClient(srv.app) as c:
        c.post("/rerank", json=_req())
        srv.engine.cfg["timeout_ms"] = 100
        srv.engine.infer_slot.acquire()
        try:
            t0 = time.time()
            r = c.post("/rerank", json=_req())
            dt = time.time() - t0
        finally:
            srv.engine.infer_slot.release()
    assert r.status_code == 503 and dt < 2


def test_load_failure_degraded_then_retry(srv, fake_ce, monkeypatch):
    calls = {"n": 0}

    def flaky(name, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError("weights missing")
        return fake_ce(name, **kw)

    monkeypatch.setattr(srv, "CE_FACTORY", flaky)
    with TestClient(srv.app) as c:
        r = c.post("/rerank", json=_req())
        assert r.status_code == 503 and "weights missing" in r.json()["detail"]
        h = c.get("/health").json()
        assert h["state"] == "degraded" and "weights missing" in h["error"]
        assert c.post("/rerank", json=_req()).status_code == 200
        assert c.get("/health").json()["state"] == "ready"


def test_fallback_marks_degraded(srv, fake_ce, monkeypatch):
    monkeypatch.setattr(rr, "_DETECT_CACHE", (7.6, True, False))

    def factory(name, **kw):
        if kw["device"] != "cpu":
            raise RuntimeError("cuda oom")
        return fake_ce(name, **kw)

    monkeypatch.setattr(srv, "CE_FACTORY", factory)
    with TestClient(srv.app) as c:
        assert c.post("/rerank", json=_req()).status_code == 200
        h = c.get("/health").json()
    assert h["state"] == "degraded" and h["device"] == "cpu" and h["error"]


def test_env_model_pref(srv, fake_ce, monkeypatch):
    monkeypatch.setenv("RERANKER_MODEL_PREF", "org/env-model")
    with TestClient(srv.app) as c:
        c.post("/rerank", json=_req())
        h = c.get("/health").json()
    assert h["model"] == "org/env-model" and h["source"] == "env"


def test_no_hardcoded_loopback_except_bind():
    src = open(os.path.join(os.path.dirname(__file__), "..", "local_reranker_server.py"), encoding="utf-8").read()
    assert "on_event" not in src
    lines = [l for l in src.splitlines() if "127.0.0.1" in l]
    assert all("uvicorn.run" in l or "print" in l for l in lines)
