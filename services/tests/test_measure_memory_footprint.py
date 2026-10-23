from __future__ import annotations

import importlib.util
import os

_p = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "measure_memory_footprint.py")
_spec = importlib.util.spec_from_file_location("measure_memory_footprint", _p)
m = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(m)


def test_parse_swapusage_mb():
    assert m.parse_swapusage("total = 1024.00M  used = 512.25M  free = 511.75M  (encrypted)") == 512.25


def test_parse_swapusage_gb():
    assert m.parse_swapusage("total = 4.00G  used = 1.50G  free = 2.50G") == 1536.0


def test_summarize():
    s = [
        {"swap_mb": 100.0, "rss": {"chat": 500.0, "embedder": None}},
        {"swap_mb": 400.0, "rss": {"chat": 900.0, "embedder": 300.0}},
        {"swap_mb": 300.0, "rss": {"chat": 700.0, "embedder": 200.0}},
    ]
    r = m.summarize(s)
    assert r["peak_rss_mb"] == {"chat": 900.0, "embedder": 300.0}
    assert r["swap_start_mb"] == 100.0 and r["swap_end_mb"] == 300.0
    assert r["swap_growth_mb"] == 300.0


def test_count_fallbacks():
    log = (
        "[Reranker] warm: falling back to Stage-1 order (timeout) url=x\n"
        "[Reranker] Could not read /config/x.json: ENOENT\n"
        "unrelated\n"
        "[Reranker] cold: falling back to Stage-1 order (http 500) url=x\n"
    )
    assert m.count_fallbacks(log) == 2


def test_p95():
    assert m.p95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) == 10
    assert m.p95([]) is None


def test_gate_baseline_na():
    assert m.gate_verdict("baseline", None, 0, None, None) == ("N/A", [])


def test_gate_pass():
    v, r = m.gate_verdict("new", 0, 0, 1024.0, {"passed": True})
    assert v == "PASS" and r == []


def test_gate_growth_boundary_fail():
    v, r = m.gate_verdict("new", 0, 0, 1025.0, {"passed": True})
    assert v == "FAIL" and any("swap growth" in x for x in r)


def test_gate_node_log_missing():
    v, r = m.gate_verdict("new", None, 0, 10.0, {"passed": True})
    assert v == "FAIL" and "node log missing" in r


def test_gate_embedder_selftest_null():
    v, r = m.gate_verdict("new", 0, 0, 10.0, None)
    assert v == "FAIL" and "embedder selftest verdict null" in r


def test_gate_fallbacks_and_unknown_growth():
    v, r = m.gate_verdict("new", 0, 2, None, {"passed": True})
    assert v == "FAIL" and "fallbacks 2" in r and any("swap growth" in x for x in r)


def test_pick_candidate_count():
    assert m.pick_candidate_count({"candidate_count": 15}, {"wide_candidate_count": 30}) == 15
    assert m.pick_candidate_count({}, {"wide_candidate_count": 25}) == 25
    assert m.pick_candidate_count({"candidate_count": 0}, {}) == 30


def test_chat_model_id():
    assert m.chat_model_id({"data": [{"id": "abc"}, {"id": "d"}]}) == "abc"
    assert m.chat_model_id({"data": []}) is None
    assert m.chat_model_id({}) is None


def test_main_new_without_node_log_aborts(monkeypatch, capsys):
    import subprocess

    def boom(*a, **k):
        raise AssertionError("must not touch network/subprocess")

    for name in ("_get_json", "_post_json", "listener_pid", "wait_unload"):
        monkeypatch.setattr(m, name, boom)
    monkeypatch.setattr(subprocess, "run", boom)
    monkeypatch.setattr(subprocess, "Popen", boom)
    monkeypatch.setattr(m.urllib.request, "urlopen", boom)
    assert m.main(["--label", "new"]) == 2
    assert "--node-log required" in capsys.readouterr().err
