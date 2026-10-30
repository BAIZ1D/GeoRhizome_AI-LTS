from __future__ import annotations

import json
import os
import types

import pytest
import torch
from fastapi.testclient import TestClient

VOCAB = 50


class FakeTok:
    def __init__(self, ok=True):
        self.ok = ok

    def tokenize(self, s):
        if not self.ok:
            return ["x"]
        return ["202", "##5"]

    def __call__(self, texts, max_length, truncation, padding, return_tensors):
        n = len(texts)
        L = min(max(len(t) for t in texts) + 1, max_length)
        ids = torch.zeros(n, L, dtype=torch.long)
        mask = torch.zeros(n, L, dtype=torch.long)
        for i, t in enumerate(texts):
            k = min(len(t) + 1, L)
            ids[i, :k] = torch.tensor([(ord(c) % (VOCAB - 1)) + 1 for c in (t + "a")[:k]])
            mask[i, :k] = 1
        return {"input_ids": ids, "attention_mask": mask}


class FakeModel:
    def __init__(self, vocab=VOCAB, batches=None):
        torch.manual_seed(0)
        self.config = types.SimpleNamespace(vocab_size=vocab)
        emb = torch.nn.Embedding(vocab, 8)
        lin = torch.nn.Linear(8, vocab)
        self._emb, self.cls = emb, lin
        self.batches = batches if batches is not None else []
        outer = self

        class Trunk:
            def __call__(self, input_ids, attention_mask):
                outer.batches.append(input_ids.shape[0])
                return types.SimpleNamespace(last_hidden_state=emb(input_ids))

        self.bert = Trunk()

    def to(self, *_a, **_k):
        return self


class Factory:
    def __init__(self, tok_ok=True, vocab=VOCAB):
        self.calls = 0
        self.tok_ok, self.vocab = tok_ok, vocab
        self.batches = []

    def __call__(self, settings):
        self.calls += 1
        return FakeTok(self.tok_ok), FakeModel(self.vocab, self.batches)


@pytest.fixture
def srv(tmp_config_dir, monkeypatch):
    import local_sparse_server as s

    f = Factory()
    monkeypatch.setattr(s, "SPARSE_FACTORY", f)
    s.engine = s.Engine()
    s.test_factory = f
    yield s
    s.engine = s.Engine()


def _set(cfg_dir, **kw):
    p = os.path.join(cfg_dir, "app_config.json")
    d = json.load(open(p, encoding="utf-8"))
    d["sparse"].update(kw)
    json.dump(d, open(p, "w", encoding="utf-8"))


def _post(c, inp):
    return c.post("/v1/sparse/encode", json={"input": inp})


def test_health_unloaded_no_factory(srv):
    with TestClient(srv.app) as c:
        r = c.get("/health")
    h = r.json()
    assert r.status_code == 200 and h["state"] == "unloaded" and h["loaded"] is False
    assert srv.test_factory.calls == 0
    for k in ("device", "precision", "batch_size", "max_length", "tokenizer", "rss_mb", "vocab_size"):
        assert k in h


def test_encode_single_and_list(srv):
    with TestClient(srv.app) as c:
        r1 = _post(c, "こんにちは")
        r2 = _post(c, ["abc", "defgh"])
        h = c.get("/health").json()
    b1, b2 = r1.json(), r2.json()
    assert r1.status_code == 200 and len(b1["data"]) == 1 and b1["vocab_size"] == VOCAB
    assert b1["model_id"] and b1["truncated"] == 0
    assert [d["index"] for d in b2["data"]] == [0, 1]
    for d in b1["data"] + b2["data"]:
        assert d["indices"] == sorted(set(d["indices"])) and d["indices"]
        assert all(v > 0 for v in d["values"]) and len(d["indices"]) == len(d["values"])
    assert h["loaded"] is True and h["tokenizer"]["ok"] is True and h["vocab_size"] == VOCAB
    assert srv.test_factory.calls == 1


def test_413_too_many_inputs_before_load(srv, tmp_config_dir):
    _set(tmp_config_dir, max_inputs_per_request=3)
    srv.engine = srv.Engine()
    with TestClient(srv.app) as c:
        assert _post(c, ["a"] * 4).status_code == 413
        assert _post(c, ["a"] * 3).status_code == 200
    assert srv.test_factory.calls == 1


def test_413_char_cap_is_sparse_value(srv, tmp_config_dir):
    d = json.load(open(os.path.join(tmp_config_dir, "app_config.json"), encoding="utf-8"))
    chunk = d["text_splitter"]["chunk_size"]
    _set(tmp_config_dir, max_input_chars=chunk + 7)
    srv.engine = srv.Engine()
    with TestClient(srv.app) as c:
        assert _post(c, "x" * (chunk + 8)).status_code == 413
        assert srv.test_factory.calls == 0
        assert _post(c, "x" * (chunk + 7)).status_code == 200


def test_non_string_422(srv):
    with TestClient(srv.app) as c:
        assert c.post("/v1/sparse/encode", json={"input": [1, 2]}).status_code == 422
        assert c.post("/v1/sparse/encode", json={"input": {"a": 1}}).status_code == 422


def test_tokenizer_selftest_failure_degraded(srv, monkeypatch):
    monkeypatch.setattr(srv, "SPARSE_FACTORY", Factory(tok_ok=False))
    with TestClient(srv.app) as c:
        assert _post(c, "abc").status_code == 503
        h = c.get("/health").json()
    assert h["state"] == "degraded" and h["error"] and h["tokenizer"]["ok"] is False


def test_vocab_too_big_degraded(srv, monkeypatch):
    monkeypatch.setattr(srv, "SPARSE_FACTORY", Factory(vocab=65537))
    with TestClient(srv.app) as c:
        assert _post(c, "abc").status_code == 503
        h = c.get("/health").json()
    assert h["state"] == "degraded" and "uint16" in h["error"]


def test_busy_returns_503(srv, tmp_config_dir):
    _set(tmp_config_dir, timeout_ms=30, cold_timeout_ms=30)
    srv.engine = srv.Engine()
    assert srv.engine.infer_slot.acquire(blocking=False)
    try:
        with TestClient(srv.app) as c:
            assert _post(c, "abc").status_code == 503
    finally:
        srv.engine.infer_slot.release()


def test_idle_unload(srv, tmp_config_dir):
    _set(tmp_config_dir, idle_unload_minutes=0.01)
    srv.engine = srv.Engine()
    with TestClient(srv.app) as c:
        _post(c, "abc")
        assert c.get("/health").json()["loaded"] is True
        e = srv.engine
        assert e.reap_if_idle(now=e.last_used + 0.1) is False
        assert e.reap_if_idle(now=e.last_used + 0.01 * 60 + 1) is True
        h = c.get("/health").json()
    assert h["loaded"] is False and h["state"] == "unloaded"


def test_batch_size_respected(srv, tmp_config_dir):
    _set(tmp_config_dir, batch_size=2, max_inputs_per_request=16)
    srv.engine = srv.Engine()
    with TestClient(srv.app) as c:
        r = _post(c, ["a", "b", "c", "d", "e"])
    assert r.status_code == 200 and len(r.json()["data"]) == 5
    assert srv.test_factory.batches == [2, 2, 1]


def test_truncated_counted(srv, tmp_config_dir):
    _set(tmp_config_dir, max_length=4)
    srv.engine = srv.Engine()
    with TestClient(srv.app) as c:
        r = _post(c, ["abcdefgh", "a"])
    assert r.json()["truncated"] == 1
