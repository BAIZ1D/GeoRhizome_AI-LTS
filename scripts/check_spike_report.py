#!/usr/bin/env python3
"""Gate check for the Phase 10 spike report (exit 1 on any failure).

Usage: python scripts/check_spike_report.py [report.md] [--stage spikes|smoke|final]
Prints derived config values as JSON on success.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Dict, List, Optional

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PHASE_DIR = os.path.join(REPO, ".planning", "phases", "10-spike-gate-sparse-server")
DEFAULT_REPORT = os.path.join(PHASE_DIR, "10-SPIKE-REPORT.md")
BAD_WORDS = ("not run", "skipped", "deferred")
DERIVED_KEYS = [
    "max_length",
    "timeout_ms",
    "cold_timeout_ms",
    "storage_method",
    "scan_budget_p95_ms",
    "device",
    "precision",
]


def _read(path: str, errs: List[str]) -> str:
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError as exc:
        errs.append(f"cannot read {path}: {exc}")
        return ""


def _bad_word_scan(name: str, text: str, errs: List[str]) -> None:
    for i, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith("WAIVER:"):
            continue
        low = line.lower()
        for w in BAD_WORDS:
            if w in low:
                errs.append(f"{name}:{i}: forbidden '{w}' (counts as FAIL)")


def _derived(report: str, errs: List[str]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    m = re.search(r"Derived config values(.*?)(?:\n## |\Z)", report, re.S)
    if not m:
        errs.append("report: 'Derived config values' section missing")
        return out
    for row in m.group(1).splitlines():
        cells = [c.strip() for c in row.strip().strip("|").split("|")]
        if len(cells) >= 2 and cells[0] in DERIVED_KEYS:
            out[cells[0]] = cells[1]
    for k in DERIVED_KEYS:
        v = out.get(k, "")
        if v == "" or v.lower() in ("null", "tbd", "none"):
            errs.append(f"derived value '{k}' missing/null/TBD")
    return out


def check_spikes(report_path: str, errs: List[str]) -> Dict[str, str]:
    report = _read(report_path, errs)
    s25 = _read(os.path.join(PHASE_DIR, "10-SPIKE-S2S5.md"), errs)
    s34 = _read(os.path.join(PHASE_DIR, "10-SPIKE-S3S4.md"), errs)
    s1 = _read(os.path.join(PHASE_DIR, "10-SPIKE-S1.md"), errs)

    for n in range(1, 6):
        m = re.search(rf"^SPK-0{n}:\s*(\S+)", report, re.M)
        if not m:
            errs.append(f"SPK-0{n} line missing")
        elif m.group(1) != "PASS":
            errs.append(f"SPK-0{n} is {m.group(1)}, not PASS")
    w = re.search(r"^SPK-05-WINDOWS:(.*)$", report, re.M)
    if not w:
        errs.append("SPK-05-WINDOWS line missing")
    else:
        body = w.group(1)
        if body.strip().upper().startswith("PASS"):
            errs.append("SPK-05-WINDOWS must not say PASS")
        if "UNVERIFIED" not in body or "evidence" not in body.lower():
            errs.append("SPK-05-WINDOWS must contain UNVERIFIED and evidence")

    _bad_word_scan("report", report, errs)
    for nm, tx in (("S2S5", s25), ("S3S4", s34), ("S1", s1)):
        _bad_word_scan(nm, tx, errs)

    sm = re.search(r"^storage_method:\s*(\S+)", report, re.M)
    if not sm or sm.group(1) != "column_scan":
        errs.append("storage_method is not column_scan")

    derived = _derived(report, errs)
    ml = derived.get("max_length", "")
    if not (ml.isdigit() and int(ml) > 0 and int(ml) % 64 == 0):
        errs.append(f"max_length '{ml}' not a positive multiple of 64")

    for nm, tx in (("S2S5", s25), ("S1", s1)):
        pm = re.search(r"^[-\s]*corpus_provenance:(.*)$", tx, re.M)
        if not pm:
            errs.append(f"{nm}: corpus_provenance missing")
        else:
            # fixture names are allowed only inside ';'-separated clauses stating exclusion
            for seg in re.split(r";", pm.group(1)):
                if re.search(r"ks-|e2e", seg, re.I) and "exclud" not in seg.lower():
                    errs.append(f"{nm}: corpus_provenance contains ks-/e2e source")
                    break
    # last row-count line wins (final re-run)
    rows = re.findall(r"chunks\.jsonl rows:\s*(\d+)", s25)
    accepted = re.search(r"^CORPUS-LIMIT-ACCEPTED:", s25, re.M)
    if not rows:
        errs.append("S2S5: 'chunks.jsonl rows: N' missing")
    elif int(rows[-1]) < 200 and not accepted:
        errs.append(f"S2S5: N={rows[-1]} < 200 without CORPUS-LIMIT-ACCEPTED")

    d = re.search(r"pooling_max_abs_diff:\s*([0-9.eE+-]+)", s1)
    if not d:
        errs.append("S1: pooling_max_abs_diff missing/non-numeric")
    else:
        try:
            if float(d.group(1)) > 1e-5:
                errs.append(f"S1: pooling_max_abs_diff {d.group(1)} > 1e-5")
        except ValueError:
            errs.append("S1: pooling_max_abs_diff non-numeric")
    if not re.search(r"top20_overlap:\s*20/20", s1):
        errs.append("S1: top20_overlap not 20/20")
    if not re.search(r"top_term_order_identical:\s*true", s1):
        errs.append("S1: top_term_order_identical not true")
    return derived


def _section(text: str, title: str) -> Optional[str]:
    m = re.search(rf"^## {re.escape(title)}\s*\n(.*?)(?=^## |\Z)", text, re.M | re.S)
    return m.group(1) if m else None


def check_smoke(errs: List[str]) -> None:
    s1 = _read(os.path.join(PHASE_DIR, "10-SPIKE-S1.md"), errs)
    sec = _section(s1, "Server smoke")
    if sec is None:
        errs.append("S1: '## Server smoke' section missing")
        return
    for field in ("health_initial_loaded: false", "status_413_long: 413", "status_413_many: 413", "port_freed: true"):
        if not re.search(rf"^[-\s]*{re.escape(field)}", sec, re.M):
            errs.append(f"Server smoke: '{field}' missing")
    a = re.search(r"rss_loaded_mb:\s*([0-9.]+)", sec)
    b = re.search(r"rss_after_unload_mb:\s*([0-9.]+)", sec)
    if not a or not b:
        errs.append("Server smoke: rss_loaded_mb / rss_after_unload_mb missing")
    elif not float(b.group(1)) < float(a.group(1)):
        errs.append("Server smoke: rss_after_unload_mb must be < rss_loaded_mb")


def check_final(errs: List[str]) -> None:
    check_smoke(errs)
    s1 = _read(os.path.join(PHASE_DIR, "10-SPIKE-S1.md"), errs)
    sec = _section(s1, "Container reachability")
    if sec is None:
        errs.append("S1: '## Container reachability' section missing")
        return
    if re.search(r"^WAIVER:", sec, re.M):
        return
    for field in ("HTTP=200", "host.docker.internal:8004/health"):
        if field not in sec:
            errs.append(f"Container reachability: '{field}' missing")
    for field in ("container_loaded_before: false", "container_loaded_after: false", "port_freed: true"):
        if not re.search(rf"^[-\s]*{re.escape(field)}", sec, re.M):
            errs.append(f"Container reachability: '{field}' missing")


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("report", nargs="?", default=DEFAULT_REPORT)
    ap.add_argument("--stage", choices=["spikes", "smoke", "final"], default="spikes")
    args = ap.parse_args(argv)
    errs: List[str] = []
    derived = check_spikes(args.report, errs)
    if args.stage == "smoke":
        check_smoke(errs)
    elif args.stage == "final":
        check_final(errs)
    if errs:
        for e in errs:
            print(f"FAIL: {e}", file=sys.stderr)
        return 1
    print(json.dumps(derived))
    return 0


if __name__ == "__main__":
    sys.exit(main())
