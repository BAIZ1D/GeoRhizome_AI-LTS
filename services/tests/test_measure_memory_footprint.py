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
