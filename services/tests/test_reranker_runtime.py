from __future__ import annotations

import os

import numpy as np
import pytest
import torch

import reranker_runtime as rr
from conftest import REPO_CONFIG



def _tiers():
    return rr.load_tiers(REPO_CONFIG)


# ---- RRK-01 -------------------------------------------------------------
def test_tiers_yaml_all_ruri_and_values():
    doc = rr.load_tiers_doc(REPO_CONFIG)
    model = doc["model"]
    assert model.endswith("ruri-v3-reranker-310m")
    t = doc["tiers"]
    assert set(t) == {"low", "medium", "high"}
    for v in t.values():
        assert v["model"] == model
        assert "onnx" not in str(v) and "quantization" not in v
    assert (t["low"]["precision"], t["low"]["batch_size"], t["low"]["device"], t["low"]["min_ram_gb"]) == ("fp16", 4, "auto", 0)
    assert t["low"]["candidate_count"] == 15
    assert (t["medium"]["precision"], t["medium"]["batch_size"], t["medium"]["device"]) == ("fp16", 8, "auto")
    assert t["medium"]["min_ram_gb"] == 9.0  # injected from llm.low_ram_max_gb
    assert t["medium"]["candidate_count"] == 30
    assert (t["high"]["precision"], t["high"]["batch_size"], t["high"]["device"], t["high"]["min_ram_gb"]) == ("fp32", 16, "auto", 15)
    assert t["high"]["candidate_count"] == 30
    assert t["high"]["requires_accelerator"] is True


# ---- RRK-02 -------------------------------------------------------------
@pytest.mark.parametrize(
    "ram,accel,want",
    [(7.6, True, "low"), (7.6, False, "low"), (15.5, True, "high"), (15.5, False, "medium"), (4, False, "low"), (32, False, "medium"),
     (8.0, False, "low"), (8.6, False, "low"), (9.0, False, "medium")],
)
def test_resolve_tier(ram, accel, want):
    assert rr.resolve_tier(_tiers(), ram, accel) == want


def test_detect_ram_uses_ram_profile(monkeypatch):
    from core import ram_profile

    monkeypatch.setattr(ram_profile, "detect_ram_gb", lambda: 8.0)
    rr._DETECT_CACHE = None
    ram, has_cuda, has_mps = rr.detect_ram_and_accel()
    assert ram == 8.0
    assert has_cuda == torch.cuda.is_available()
    assert has_mps == torch.backends.mps.is_available()
    rr._DETECT_CACHE = None


def test_effective_candidate_count():
    assert rr.effective_candidate_count({"candidate_count": 15}, {"wide_candidate_count": 30}) == 15
    assert rr.effective_candidate_count({}, {"wide_candidate_count": 30}) == 30


# ---- RRK-03 -------------------------------------------------------------
def test_resolve_device():
    assert rr.resolve_device("auto", True, True) == "cuda"
    assert rr.resolve_device("cpu", False, True) == "mps"
    assert rr.resolve_device("cpu", True, False) == "cuda"
    assert rr.resolve_device("auto", False, False) == "cpu"
    with pytest.raises(ValueError):
        rr.resolve_device("tpu", False, False)


# ---- RRK-04 -------------------------------------------------------------
def test_resolve_precision():
    p, msg = rr.resolve_precision("fp16", "cpu")
    assert p == "fp32" and "cpu" in msg
    assert rr.resolve_precision("bf16", "mps")[0] == "fp32"
    assert rr.resolve_precision("bf16", "cuda")[0] != "bf16"
    assert rr.resolve_precision("fp16", "mps") == ("fp16", None)
    assert rr.resolve_precision("weird", "cuda")[0] == "fp32"


# ---- RRK-08 -------------------------------------------------------------
def test_resolve_model_precedence():
    assert rr.resolve_model({"RERANKER_MODEL_PREF": "E"}, {"reranker": {"model_id": "A"}}, "T") == ("E", "env")
    assert rr.resolve_model({}, {"reranker": {"model_id": "A"}}, "T") == ("A", "active")
    assert rr.resolve_model({}, {"reranker": {"model_id": "Offloaded"}}, "T") == ("T", "tier")
    assert rr.resolve_model({}, {}, None) == (rr.FALLBACK_MODEL, "tier")


# ---- config ------------------------------------------------------------
def test_load_reranker_config_tolerates_missing(tmp_path):
    cfg = rr.load_reranker_config(str(tmp_path))
    assert cfg["max_length"] == rr.FALLBACK_MAX_LENGTH
    assert cfg["selftest_min_spearman"] == 0.99


# ---- RRK-05 -------------------------------------------------------------
class _ScriptedModel:
    """Fake model whose fp16 scores/timings are scripted."""

    def __init__(self, s32, s16, t32, t16, dtype_after_half=torch.float16):
        from conftest import _Inner

        self.model = _Inner(torch.float32)
        self._s32, self._s16, self._t = s32, s16, {"32": t32, "16": t16}
        self.dtype_after_half = dtype_after_half

    def half(self):
        self.model._p.dtype = self.dtype_after_half
        return self

    def predict(self, pairs, batch_size=8, show_progress_bar=False):
        is16 = self.model._p.dtype != torch.float32
        if len(pairs) <= 2:
            return np.zeros(len(pairs))
        rr._fake_elapsed = self._t["16" if is16 else "32"]
        return np.asarray(self._s16 if is16 else self._s32)


PAIRS = [("q", "p%d" % i) for i in range(6)]
BASE = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]


@pytest.fixture
def fake_clock(monkeypatch):
    monkeypatch.setattr(rr, "_timed", rr._timed_impl)
    monkeypatch.setattr(rr, "_elapsed", lambda t0: rr._fake_elapsed)


def test_selftest_pass(fake_clock):
    m = _ScriptedModel(BASE, [x + 0.01 for x in BASE], 1.0, 0.5)
    ok, met = rr.mps_fp16_self_test(m, PAIRS, 4, 0.99)
    assert ok and met["rho"] >= 0.99 and met["finite"]


def test_selftest_nan(fake_clock):
    m = _ScriptedModel(BASE, [float("nan")] + BASE[1:], 1.0, 0.5)
    assert rr.mps_fp16_self_test(m, PAIRS, 4, 0.99)[0] is False


def test_selftest_low_rho(fake_clock):
    m = _ScriptedModel(BASE, list(reversed(BASE)), 1.0, 0.5)
    assert rr.mps_fp16_self_test(m, PAIRS, 4, 0.99)[0] is False


def test_selftest_not_faster(fake_clock):
    m = _ScriptedModel(BASE, BASE, 1.0, 1.2)
    assert rr.mps_fp16_self_test(m, PAIRS, 4, 0.99)[0] is False


def test_selftest_pairs_fixture():
    pairs = rr.load_selftest_pairs()
    assert 8 <= len(pairs) <= 16
    assert all(len(p) >= 300 for _, p in pairs)


# ---- builder: RRK-04/05/06 ---------------------------------------------
def _cfg(**over):
    c = {"max_length": 777, "selftest_min_spearman": 0.99}
    c.update(over)
    return c


def test_build_cpu_fp32_identity_maxlen(fake_ce):
    tier = {"name": "medium", "model": "M", "precision": "fp16", "batch_size": 8, "device": "auto"}
    model, info = rr.build_reranker(_cfg(), tier, factory=fake_ce, accel=(False, False), env={}, active={})
    kw = fake_ce.instances[0].kwargs
    assert kw["device"] == "cpu" and kw["max_length"] == 777
    assert kw["model_kwargs"]["dtype"] == torch.float32
    assert isinstance(kw["activation_fn"], torch.nn.Identity)
    assert "trust_remote_code" not in kw
    assert info["precision"] == "fp32" and info["device"] == "cpu" and info["batch_size"] == 8
    assert info["source"] == "tier" and info["model"] == "M"


def test_build_default_maxlen(fake_ce):
    tier = {"name": "low", "model": "M", "precision": "fp16", "batch_size": 4, "device": "cpu"}
    rr.build_reranker({}, tier, factory=fake_ce, accel=(False, False), env={}, active={})
    assert fake_ce.instances[0].kwargs["max_length"] == rr.FALLBACK_MAX_LENGTH


def test_build_mps_selftest_pass_keeps_fp16(fake_ce, monkeypatch):
    monkeypatch.setattr(rr, "mps_fp16_self_test", lambda m, p, b, r: (m.half() is not None, {"rho": 1.0}))
    tier = {"name": "medium", "model": "M", "precision": "fp16", "batch_size": 8, "device": "auto"}
    model, info = rr.build_reranker(_cfg(), tier, factory=fake_ce, accel=(False, True), env={}, active={})
    assert info["device"] == "mps" and info["precision"] == "fp16"
    assert next(model.model.parameters()).dtype == torch.float16
    assert len(fake_ce.instances) == 1


def test_build_mps_selftest_fail_reloads_fp32(fake_ce, monkeypatch):
    monkeypatch.setattr(rr, "mps_fp16_self_test", lambda m, p, b, r: (False, {"rho": 0.5}))
    tier = {"name": "medium", "model": "M", "precision": "fp16", "batch_size": 8, "device": "auto"}
    model, info = rr.build_reranker(_cfg(), tier, factory=fake_ce, accel=(False, True), env={}, active={})
    assert info["precision"] == "fp32"
    assert len(fake_ce.instances) == 2
    assert next(model.model.parameters()).dtype == torch.float32


def test_build_dtype_mismatch_raises(monkeypatch):
    from conftest import FakeCrossEncoder

    class Bad(FakeCrossEncoder):
        def __init__(self, name, **kw):
            super().__init__(name, **kw)
            self.model._p.dtype = torch.float16

    tier = {"name": "medium", "model": "M", "precision": "fp32", "batch_size": 8, "device": "auto"}
    with pytest.raises(RuntimeError):
        rr.build_reranker(_cfg(), tier, factory=Bad, accel=(False, False), env={}, active={})


def test_build_accel_failure_falls_back_cpu(fake_ce):
    calls = []

    def factory(name, **kw):
        calls.append(kw["device"])
        if kw["device"] != "cpu":
            raise RuntimeError("mps broke")
        return fake_ce(name, **kw)

    tier = {"name": "high", "model": "M", "precision": "fp32", "batch_size": 16, "device": "auto"}
    model, info = rr.build_reranker(_cfg(), tier, factory=factory, accel=(True, False), env={}, active={})
    assert calls == ["cuda", "cpu"]
    assert info["device"] == "cpu" and info["fallback"]


def test_build_env_model_wins(fake_ce):
    tier = {"name": "low", "model": "T", "precision": "fp16", "batch_size": 4, "device": "cpu"}
    _, info = rr.build_reranker(_cfg(), tier, factory=fake_ce, accel=(False, False),
                                env={"RERANKER_MODEL_PREF": "E"}, active={"reranker": {"model_id": "A"}})
    assert info["model"] == "E" and info["source"] == "env"
    assert fake_ce.instances[0].model_name == "E"


def test_predict_passes_batch(fake_ce):
    tier = {"name": "medium", "model": "M", "precision": "fp16", "batch_size": 8, "device": "auto"}
    model, info = rr.build_reranker(_cfg(), tier, factory=fake_ce, accel=(False, False), env={}, active={})
    rr.predict(model, info, [("q", "a"), ("q", "bb")])
    assert model.predict_calls[-1]["batch_size"] == 8
