#!/usr/bin/env python3
"""D-08 memory footprint measurement (RSS per listener, swap, rerank cold/warm).

Usage: python scripts/measure_memory_footprint.py --label baseline|new
         --queries 20 --node-log PATH [--out report.md] [--wait-unload-max 360]
Services must already be running. Appends a labeled section to the report.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import statistics
import subprocess
import sys
import threading
import time
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(REPO, "services"))

DEFAULT_PORTS = {"embedder": 8000, "reranker": 8001, "hardware": 8002, "chat": 8003}
DEFAULT_OUT = os.path.join(
    REPO, ".planning", "phases", "08.1-8-gb-memory-footprint-reduction", "08.1-MEASUREMENT.md"
)
FALLBACK_RE = re.compile(r"\[Reranker\].*falling back to Stage-1 order")
SWAP_RE = re.compile(r"used\s*=\s*([0-9.]+)\s*([MGK])", re.I)
POOL = [
    "本規程は従業員の権利と義務を定め、手続きは所定の様式に従い所属長の承認を得て行う。",
    "情報資産は機密性、完全性、可用性の観点から分類し、取扱責任者を定める。",
    "申請は原則として事前に行い、事後申請は特別な事情がある場合に限り認められる。",
    "契約書の締結には法務部の確認と決裁権限者の承認が必要である。",
]


def parse_swapusage(text: str) -> float:
    """Return swap 'used' in MB from `sysctl -n vm.swapusage` text."""
    m = SWAP_RE.search(text)
    if not m:
        raise ValueError(f"cannot parse swapusage: {text!r}")
    val, unit = float(m.group(1)), m.group(2).upper()
    return val * {"K": 1 / 1024, "M": 1.0, "G": 1024.0}[unit]


def read_swap_mb() -> Optional[float]:
    if sys.platform != "darwin":
        return None
    out = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True, timeout=5)
    return parse_swapusage(out.stdout)


def count_fallbacks(log_text: str) -> int:
    return sum(1 for line in log_text.splitlines() if FALLBACK_RE.search(line))


def listener_pid(port: int) -> Optional[int]:
    import psutil

    if os.name != "nt":
        try:
            out = subprocess.run(
                ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                capture_output=True, text=True, timeout=5,
            )
            for tok in out.stdout.split():
                if tok.isdigit():
                    return int(tok)
        except (OSError, subprocess.SubprocessError):
            pass
    try:
        for c in psutil.net_connections(kind="tcp"):
            if c.status == "LISTEN" and c.laddr and c.laddr.port == port and c.pid:
                return c.pid
    except (psutil.AccessDenied, OSError):
        pass
    return None


def summarize(samples: List[Dict[str, Any]]) -> Dict[str, Any]:
    """samples: [{'t':float,'swap_mb':float|None,'rss':{name: MB|None}}]."""
    peak: Dict[str, float] = {}
    for s in samples:
        for name, v in s.get("rss", {}).items():
            if v is not None and v > peak.get(name, 0.0):
                peak[name] = v
    swaps = [s["swap_mb"] for s in samples if s.get("swap_mb") is not None]
    start = swaps[0] if swaps else None
    end = swaps[-1] if swaps else None
    peak_swap = max(swaps) if swaps else None
    growth = (peak_swap - start) if swaps else None
    return {"peak_rss_mb": peak, "swap_start_mb": start, "swap_end_mb": end,
            "swap_peak_mb": peak_swap, "swap_growth_mb": growth}


def p95(values: List[float]) -> Optional[float]:
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, math.ceil(0.95 * len(s)) - 1)]


def _cfg_url(section: str, default_port: int) -> str:
    try:
        from core.config_io import get_config_dir

        with open(os.path.join(get_config_dir(), "app_config.json"), encoding="utf-8") as f:
            base = json.load(f)[section]["base_url"]
        m = re.match(r"https?://[^/:]+:(\d+)", base)
        if m:
            return f"http://127.0.0.1:{m.group(1)}"
    except Exception:
        pass
    return f"http://127.0.0.1:{default_port}"


def _get_json(url: str, timeout: float = 5.0) -> Dict[str, Any]:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _post_json(url: str, body: Dict[str, Any], timeout: float) -> Tuple[int, float]:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), headers={"Content-Type": "application/json"}
    )
    t0 = time.monotonic()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        r.read()
        return r.status, (time.monotonic() - t0) * 1000.0


def build_candidates(n: int, i: int) -> List[Dict[str, Any]]:
    out = []
    for k in range(n):
        text = (POOL[(i + k) % len(POOL)] * 20)[:1024]
        out.append({"id": f"c{k}", "text": text})
    return out


def wait_unload(emb: str, rer: str, max_s: float) -> bool:
    deadline = time.monotonic() + max_s
    while True:
        try:
            e = _get_json(emb + "/health")
            r = _get_json(rer + "/health")
            if not e.get("loaded") and r.get("state") == "unloaded":
                return True
        except Exception:
            pass
        if time.monotonic() >= deadline:
            return False
        time.sleep(5)


class Sampler(threading.Thread):
    def __init__(self, ports: Dict[str, int], interval: float = 2.0):
        super().__init__(daemon=True)
        self.ports, self.interval = ports, interval
        self.samples: List[Dict[str, Any]] = []
        self._stop_evt = threading.Event()

    def run(self) -> None:
        import psutil

        while not self._stop_evt.is_set():
            rss: Dict[str, Optional[float]] = {}
            for name, port in self.ports.items():
                pid = listener_pid(port)
                try:
                    rss[name] = psutil.Process(pid).memory_info().rss / 2**20 if pid else None
                except psutil.Error:
                    rss[name] = None
            try:
                swap = read_swap_mb()
            except Exception:
                swap = None
            self.samples.append({"t": time.time(), "swap_mb": swap, "rss": rss})
            self._stop_evt.wait(self.interval)

    def stop(self) -> None:
        self._stop_evt.set()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--label", required=True, choices=["baseline", "new"])
    ap.add_argument("--queries", type=int, default=20)
    ap.add_argument("--duration", type=float, default=0, help="min seconds to keep sampling")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--node-log", default=None)
    ap.add_argument("--wait-unload-max", type=float, default=360)
    args = ap.parse_args()

    with open(os.path.join(HERE, "measure_queries.json"), encoding="utf-8") as f:
        d = json.load(f)
    queries = (d if isinstance(d, list) else d["queries"])[: args.queries]

    emb = _cfg_url("embedding", DEFAULT_PORTS["embedder"])
    rer = _cfg_url("reranker", DEFAULT_PORTS["reranker"])
    ports = dict(DEFAULT_PORTS)
    ports["embedder"] = int(emb.rsplit(":", 1)[1])
    ports["reranker"] = int(rer.rsplit(":", 1)[1])
    try:
        with open(os.path.join(REPO, "config", "app_config.json"), encoding="utf-8") as f:
            cfgr = json.load(f)["reranker"]
    except Exception:
        cfgr = {}
    timeout_ms = float(cfgr.get("timeout_ms", 23000))
    cold_ms = float(cfgr.get("cold_timeout_ms", 60000))

    if not wait_unload(emb, rer, args.wait_unload_max):
        print("ABORT: embedder/reranker still loaded after wait; retry later.", file=sys.stderr)
        return 2

    node_offset = 0
    if args.node_log and os.path.exists(args.node_log):
        node_offset = os.path.getsize(args.node_log)

    sampler = Sampler(ports)
    sampler.start()
    t_start = time.monotonic()
    script_fail = 0
    cold: Optional[float] = None
    warm: List[float] = []
    url = rer + "/rerank"
    n_cand = int(cfgr.get("wide_candidate_count", 30))
    for i, q in enumerate(queries):
        body = {"query": q, "candidates": build_candidates(n_cand, i)}
        is_cold = i == 0
        limit = cold_ms if is_cold else timeout_ms
        try:
            status, ms = _post_json(url, body, limit / 1000.0 + 5)
            if status != 200 or ms > limit:
                script_fail += 1
        except Exception:
            script_fail += 1
            continue
        if is_cold:
            cold = ms
        elif i == 1:
            pass  # discarded warm-up
        else:
            warm.append(ms)
    while time.monotonic() - t_start < args.duration:
        time.sleep(1)
    time.sleep(2)
    sampler.stop()
    sampler.join(timeout=5)

    health: Dict[str, Any] = {}
    try:
        health = _get_json(rer + "/health")
    except Exception:
        pass
    emb_health: Dict[str, Any] = {}
    try:
        emb_health = _get_json(emb + "/health")
    except Exception:
        pass

    node_fb: Optional[int] = None
    if args.node_log and os.path.exists(args.node_log):
        with open(args.node_log, "rb") as f:
            f.seek(node_offset)
            node_fb = count_fallbacks(f.read().decode("utf-8", "replace"))

    summ = summarize(sampler.samples)
    try:
        import llama_cpp

        llama_ver = llama_cpp.__version__
    except Exception:
        llama_ver = "unknown"
    total_fb = script_fail + (node_fb or 0)
    selftest = health.get("selftest")
    lines = [
        f"\n## Run: {args.label}\n",
        f"- llama-cpp-python: {llama_ver}",
        f"- Queries: {len(queries)}; candidates per query: {n_cand}",
        f"- Reranker /health: tier={health.get('tier')} device={health.get('device')} "
        f"precision={health.get('precision')} candidate_count={health.get('candidate_count')}",
        f"- Reranker selftest verdict: {json.dumps(selftest, ensure_ascii=False)}",
        f"- Embedder selftest verdict: {json.dumps(emb_health.get('selftest'), ensure_ascii=False)}",
    ]
    if selftest and (
        (isinstance(selftest, dict) and (selftest.get("passed") is False or selftest.get("verdict") in ("FAIL", "fail")))
        or (isinstance(selftest, str) and "fail" in selftest.lower())
    ):
        lines.append("- NOTE: fp32 double-load: MPS fp16 self-test failed, model loaded twice, expect higher peak RSS")
    lines += ["", "| Service | Peak RSS MB |", "|---|---|"]
    for k, v in sorted(summ["peak_rss_mb"].items()):
        lines.append(f"| {k} | {v:.0f} |")
    lines += [
        "",
        f"- Swap start/end/peak MB: {summ['swap_start_mb']} / {summ['swap_end_mb']} / {summ['swap_peak_mb']}",
        f"- Swap growth MB: {summ['swap_growth_mb']}",
        f"- Cold rerank ms (first call, limit {cold_ms:.0f}): {cold}",
        f"- Warm rerank p95 ms (n={len(warm)}, limit {timeout_ms:.0f}): {p95(warm)}",
        f"- Script-side fallbacks (non-200/exception/over timeout): {script_fail}",
        f"- Node-log fallbacks: {node_fb if node_fb is not None else 'node-side fallbacks not measured'}",
        f"- Total fallbacks: {total_fb}",
    ]
    if args.label == "new":
        growth = summ["swap_growth_mb"]
        ok = node_fb is not None and total_fb == 0 and growth is not None and growth <= 1024
        lines.append(
            f"\nGate verdict: {'PASS' if ok else 'FAIL'} (swap growth {growth} MB, fallbacks {total_fb})"
            + ("" if node_fb is not None else " [node-side fallbacks not measured]")
        )
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
