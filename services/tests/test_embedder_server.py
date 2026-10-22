from __future__ import annotations

import threading
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient


class FakeST:
    instances: list = []

    def __init__(self, name, device="cpu", **kw):
        self.name, self.device = name, device
        self.encode_calls = []
        FakeST.instances.append(self)

    def encode(self, texts, batch_size=32, normalize_embeddings=False, **kw):
        self.encode_calls.append({"n": len(texts), "batch_size": batch_size, "texts": list(texts),
                                  "normalize": normalize_embeddings})
        return np.array([[1.0, 0.0, 0.0] for _ in texts], dtype=np.float32)


@pytest.fixture
def srv(tmp_config_dir, monkeypatch):
    import local_bge_server as s

    FakeST.instances = []
    monkeypatch.setattr(s, "ST_FACTORY", FakeST)
    monkeypatch.setattr(s, "_resolve_device", lambda: "cpu")
    monkeypatch.setattr(s, "_free_memory", lambda: None)
    monkeypatch.delenv("EMBEDDING_MODEL_PREF", raising=False)
    s.engine = s.Engine()
    yield s
    s.engine = s.Engine()


def test_response_shape_lock(srv):
    with TestClient(srv.app) as c:
        r = c.post("/v1/embeddings", json={"input": ["a", "b"]})
    assert r.status_code == 200
    j = r.json()
    assert set(j) == {"object", "data", "model", "usage", "latency_sec"}
    assert j["object"] == "list"
    assert len(j["data"]) == 2
    assert set(j["data"][0]) == {"object", "index", "embedding"}
    assert j["data"][1]["index"] == 1
    assert set(j["usage"]) == {"prompt_tokens", "total_tokens"}


def test_health_before_load_does_not_load(srv):
    with TestClient(srv.app) as c:
        r = c.get("/health")
    assert r.status_code == 200
    assert FakeST.instances == []
    h = r.json()
    assert h["loaded"] is False and h["state"] == "unloaded"
    for k in ("model", "device", "precision", "loaded", "idle_unload_seconds", "rss_mb", "selftest"):
        assert k in h, k


def test_lazy_load_once_both_routes(srv):
    with TestClient(srv.app) as c:
        assert c.post("/v1/embeddings", json={"input": "x"}).status_code == 200
        assert c.post("/embeddings", json={"input": ["y"]}).status_code == 200
        h = c.get("/health").json()
    assert len(FakeST.instances) == 1
    assert h["loaded"] is True and h["state"] == "ready"


def test_concurrent_requests_load_once(srv):
    with TestClient(srv.app) as c:
        res = []
        ts = [threading.Thread(target=lambda: res.append(c.post("/v1/embeddings", json={"input": "x"}).status_code))
              for _ in range(4)]
        [t.start() for t in ts]
        [t.join() for t in ts]
    assert res == [200] * 4
    assert len(FakeST.instances) == 1


def test_reaper_unloads_and_reloads(srv, monkeypatch):
    freed = []
    monkeypatch.setattr(srv, "_free_memory", lambda: freed.append(1))
    with TestClient(srv.app) as c:
        c.post("/v1/embeddings", json={"input": "x"})
        e = srv.engine
        secs = e.cfg["idle_unload_seconds"]
        assert secs == 300
        assert e.reap_if_idle(now=e.last_used + secs - 1) is False
        assert e.model is not None
        assert e.reap_if_idle(now=e.last_used + secs + 1) is True
        assert e.model is None and freed
        assert c.get("/health").json()["state"] == "unloaded"
        assert c.post("/v1/embeddings", json={"input": "x"}).status_code == 200
    assert len(FakeST.instances) == 2


def test_reaper_disabled_when_zero(srv):
    with TestClient(srv.app) as c:
        c.post("/v1/embeddings", json={"input": "x"})
        srv.engine.cfg["idle_unload_seconds"] = 0
        assert srv.engine.reap_if_idle(now=time.time() + 10**6) is False


def test_reaper_skips_when_inference_in_progress(srv):
    with TestClient(srv.app) as c:
        c.post("/v1/embeddings", json={"input": "x"})
        e = srv.engine
        e.infer_slot.acquire()
        try:
            assert e.reap_if_idle(now=e.last_used + 10**6) is False
        finally:
            e.infer_slot.release()


def test_chunk_cap_batch_and_normalize(srv):
    with TestClient(srv.app) as c:
        c.post("/v1/embeddings", json={"input": ["あ" * 5000, "b"]})
    call = FakeST.instances[0].encode_calls[0]
    assert call["batch_size"] == 2
    assert call["normalize"] is True
    assert len(call["texts"][0]) == 1024


def test_malformed_body_422(srv):
    with TestClient(srv.app) as c:
        assert c.post("/v1/embeddings", json={"nope": 1}).status_code == 422
        assert c.post("/v1/embeddings", json={"input": 5}).status_code == 422
    assert FakeST.instances == []


def test_handlers_are_sync(srv):
    import inspect

    assert not inspect.iscoroutinefunction(srv.create_embedding)
    assert not inspect.iscoroutinefunction(srv.health)


# ---- fp16 parity self-test (task 2)
class HalfST(FakeST):
    """half() switches encode output; mode: 'same' | 'drift' | 'nan'."""

    mode = "same"

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.halved = False

    def half(self):
        self.halved = True
        return self

    def encode(self, texts, batch_size=32, normalize_embeddings=False, **kw):
        base = super().encode(texts, batch_size=batch_size, normalize_embeddings=normalize_embeddings)
        if not self.halved or HalfST.mode == "same":
            return base
        if HalfST.mode == "nan":
            return base * np.nan
        return np.array([[0.9, 0.436, 0.0] for _ in texts], dtype=np.float32)  # cos ~0.9


@pytest.fixture
def mps_srv(srv, monkeypatch):
    HalfST.mode = "same"
    monkeypatch.setattr(srv, "ST_FACTORY", HalfST)
    monkeypatch.setattr(srv, "_resolve_device", lambda: "mps")
    srv.engine = srv.Engine()
    return srv


def test_fp16_accepted_on_parity(mps_srv):
    with TestClient(mps_srv.app) as c:
        c.post("/v1/embeddings", json={"input": "x"})
        h = c.get("/health").json()
    assert h["precision"] == "fp16" and h["selftest"]["verdict"] == "fp16"
    assert len(FakeST.instances) == 1 and FakeST.instances[0].halved


def test_fp16_rejected_on_low_cosine_reloads_fresh(mps_srv):
    HalfST.mode = "drift"
    with TestClient(mps_srv.app) as c:
        c.post("/v1/embeddings", json={"input": "x"})
        h = c.get("/health").json()
    assert h["precision"] == "fp32" and h["selftest"]["verdict"] == "fp32-fallback"
    assert len(FakeST.instances) == 2
    assert mps_srv.engine.model is FakeST.instances[1] and not FakeST.instances[1].halved


def test_fp16_rejected_on_nonfinite(mps_srv):
    HalfST.mode = "nan"
    with TestClient(mps_srv.app) as c:
        c.post("/v1/embeddings", json={"input": "x"})
        h = c.get("/health").json()
    assert h["precision"] == "fp32" and h["selftest"]["finite"] is False
    assert len(FakeST.instances) == 2


def test_fp16_disabled_by_config(mps_srv):
    mps_srv.engine.cfg["mps_fp16"] = False
    mps_srv.load_settings = lambda d: {**mps_srv.engine.cfg}
    with TestClient(mps_srv.app) as c:
        c.post("/v1/embeddings", json={"input": "x"})
        h = c.get("/health").json()
    assert h["precision"] == "fp32" and h["selftest"] is None
    assert not FakeST.instances[0].halved


def test_cpu_always_fp32_no_selftest(srv, monkeypatch):
    monkeypatch.setattr(srv, "ST_FACTORY", HalfST)
    srv.engine = srv.Engine()
    with TestClient(srv.app) as c:
        c.post("/v1/embeddings", json={"input": "x"})
        h = c.get("/health").json()
    assert h["precision"] == "fp32" and h["selftest"] is None
    assert not FakeST.instances[0].halved
