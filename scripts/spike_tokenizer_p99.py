"""Spike S2: tokenizer-only token-length percentiles (no model weights)."""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = "大阪万博は2025年に開催されます。"


def die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(2)


def pct(vals: List[int], q: float) -> int:
    s = sorted(vals)
    return s[min(len(s) - 1, int(math.ceil(q * len(s))) - 1)]


def classify(t: str) -> str:
    n = max(len(t), 1)
    kata = sum(1 for c in t if "゠" <= c <= "ヿ")
    kanji = sum(1 for c in t if "一" <= c <= "鿿")
    asc = sum(1 for c in t if c.isascii() and not c.isspace())
    if asc / n > 0.3:
        return "ascii-mixed"
    if kata / n > 0.25:
        return "katakana-heavy"
    if kanji / n >= 0.0:
        return "kanji-heavy"
    return "kanji-heavy"


def stats(vals: List[int]) -> Dict[str, int]:
    return {
        "p50": pct(vals, 0.50),
        "p95": pct(vals, 0.95),
        "p99": pct(vals, 0.99),
        "max": max(vals),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--config", default=str(ROOT / "config/model_catalog.json"))
    ap.add_argument("--splade-model")
    ap.add_argument("--revision")
    ap.add_argument("--reranker-model")
    ap.add_argument("--cap-chars", type=int)
    a = ap.parse_args()

    corpus = Path(a.corpus)
    if not corpus.is_file():
        die(f"corpus missing: {corpus}")
    prov = corpus.with_name("chunks.provenance.json")
    if prov.is_file():
        p = json.loads(prov.read_text(encoding="utf-8"))
        for s in p.get("sources", []):
            if re.search(r"^ks-|e2e", str(s.get("name", "")), re.I):
                die(f"corpus provenance lists fixture source: {s.get('name')}")
    rows: List[str] = []
    for ln, line in enumerate(corpus.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        r = json.loads(line)
        if not isinstance(r.get("text"), str):
            die(f"row {ln} missing string key 'text'")
        rows.append(r["text"])
    if not rows:
        die("corpus has zero rows")

    cfg = json.loads(Path(a.config).read_text(encoding="utf-8"))
    sp = cfg["sparse"][0]
    splade = a.splade_model or sp["repo_id"]
    rev = a.revision or sp["revision"]
    app = json.loads((ROOT / "config/app_config.json").read_text(encoding="utf-8"))
    rr = a.reranker_model or app["reranker"]["model_name"]
    cap = a.cap_chars or app["text_splitter"]["chunk_size"]

    from transformers import AutoTokenizer

    tok_s = AutoTokenizer.from_pretrained(splade, revision=rev)
    if type(tok_s).__name__ != "BertJapaneseTokenizer":
        die(f"unexpected SPLADE tokenizer type {type(tok_s).__name__}")
    tok_r = AutoTokenizer.from_pretrained(rr)

    texts = [unicodedata.normalize("NFKC", t)[:cap] for t in rows]
    strata = [classify(t) for t in texts]
    print(f"## S2 tokenizer results\n\ncorpus N={len(texts)} cap_chars={cap}")
    counts = {k: strata.count(k) for k in ("kanji-heavy", "katakana-heavy", "ascii-mixed")}
    print("strata counts: " + ", ".join(
        f"{k}={v}" + (" THIN-STRATUM" if v < 20 else "") for k, v in counts.items()))

    results: Dict[str, Any] = {}
    for label, tok in (("SPLADE", tok_s), ("Ruri-reranker", tok_r)):
        lens = [len(tok(t, add_special_tokens=True)["input_ids"]) for t in texts]
        results[label] = lens
        print(f"\n### {label}\n| scope | p50 | p95 | p99 | max |\n|---|---|---|---|---|")
        s = stats(lens)
        print(f"| overall | {s['p50']} | {s['p95']} | {s['p99']} | {s['max']} |")
        for k in counts:
            v = [l for l, st in zip(lens, strata) if st == k]
            if v:
                s = stats(v)
                print(f"| {k} (n={len(v)}) | {s['p50']} | {s['p95']} | {s['p99']} | {s['max']} |")

    lens = results["SPLADE"]
    p99 = pct(lens, 0.99)
    ml = int(math.ceil(p99 / 64) * 64)
    while True:
        trunc = sum(1 for l in lens if l > ml) / len(lens)
        if trunc < 0.01:
            break
        ml += 64
    print(f"\nSPLADE p99={p99} proposed max_length={ml} truncation_rate={trunc:.4%}")
    ids = tok_s(unicodedata.normalize("NFKC", FIXTURE), add_special_tokens=True)["input_ids"]
    toks = tok_s.convert_ids_to_tokens(ids)
    print(f"fixture tokens: {toks}")
    print(f"2025 check: '202' in tokens={'202' in toks}, '##5' in tokens={'##5' in toks}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
